import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  previewBypassForIntent,
  rootEntryGate,
  rootNavigatorBoundaryKey,
  type RootEntryState,
} from './rootEntryGate';

const fresh: RootEntryState = {
  isAuthenticated: false,
  wantsAuth: false,
  intent: null,
  countryCode: null,
  anyPreview: false,
  needsSelfie: false,
};

function postCarouselGateBeforeFix(state: RootEntryState) {
  const { isAuthenticated, wantsAuth, intent, countryCode, anyPreview, needsSelfie } = state;
  const earner = intent === 'mover' || intent === 'vendor' || intent === 'advertiser';
  const needsAuth = earner ? !isAuthenticated && !anyPreview : wantsAuth && !isAuthenticated;

  if (wantsAuth && !isAuthenticated) return 'auth';
  if (!intent) return 'role-picker';
  if (earner && !countryCode && !anyPreview) return 'country';
  if (needsAuth) return 'auth';
  if (needsSelfie) return 'selfie';
  return 'main';
}

describe('rootEntryGate', () => {
  it('FO-01: makes the trio the complete fresh-install welcome', () => {
    expect(rootEntryGate(fresh)).toBe('role-picker');
  });

  it('sends sign-in-first straight to phone auth without asking for intent', () => {
    expect(rootEntryGate({ ...fresh, wantsAuth: true })).toBe('auth');
  });

  it('keeps customer guest browsing unchanged', () => {
    expect(rootEntryGate({ ...fresh, intent: 'customer' })).toBe('main');
  });

  it.each(['mover', 'vendor', 'advertiser'] as const)(
    'keeps the %s country-before-auth path unchanged',
    (intent) => {
      expect(rootEntryGate({ ...fresh, intent })).toBe('country');
      expect(rootEntryGate({ ...fresh, intent, countryCode: 'GY' })).toBe('auth');
    },
  );

  it('keeps read-only earner previews independent of country and auth', () => {
    expect(rootEntryGate({ ...fresh, intent: 'mover', anyPreview: true })).toBe('main');
    expect(rootEntryGate({ ...fresh, intent: 'vendor', anyPreview: true })).toBe('main');
  });

  it('preserves the mandatory selfie gate for an authenticated account', () => {
    expect(
      rootEntryGate({
        ...fresh,
        isAuthenticated: true,
        intent: 'vendor',
        countryCode: 'GY',
        needsSelfie: true,
      }),
    ).toBe('selfie');
  });

  it.each(['customer', 'mover', 'vendor', 'advertiser'] as const)(
    'FO-08: preserves the authenticated %s landing',
    (intent) => {
      expect(
        rootEntryGate({
          ...fresh,
          isAuthenticated: true,
          intent,
          countryCode: 'GY',
        }),
      ).toBe('main');
    },
  );

  it('FO-08: changes no post-carousel route across the complete state matrix', () => {
    const booleans = [false, true];
    const intents: RootEntryState['intent'][] = [null, 'customer', 'mover', 'vendor', 'advertiser'];
    const countries: RootEntryState['countryCode'][] = [null, 'GY'];

    for (const isAuthenticated of booleans) {
      for (const wantsAuth of booleans) {
        for (const intent of intents) {
          for (const countryCode of countries) {
            for (const anyPreview of booleans) {
              for (const needsSelfie of booleans) {
                const state = { isAuthenticated, wantsAuth, intent, countryCode, anyPreview, needsSelfie };
                expect(rootEntryGate(state)).toBe(postCarouselGateBeforeFix(state));
              }
            }
          }
        }
      }
    }
  });
});

describe('rootNavigatorBoundaryKey', () => {
  it('resets same-route local state across A logout and B login boundaries', () => {
    const accountA = rootNavigatorBoundaryKey(1);
    const loggedOut = rootNavigatorBoundaryKey(2);
    const accountB = rootNavigatorBoundaryKey(3);

    expect(new Set([accountA, loggedOut, accountB]).size).toBe(3);
  });

  it('does not reset while a principal moves between ordinary entry gates', () => {
    expect(rootNavigatorBoundaryKey(7)).toBe(rootNavigatorBoundaryKey(7));
    expect(rootEntryGate(fresh)).toBe('role-picker');
    expect(rootEntryGate({ ...fresh, wantsAuth: true })).toBe('auth');
  });
});

// ---------------------------------------------------------------------------
// A read-only preview may skip country and sign-in ONLY for the stack it
// previews. The root navigator OR-ed both flags into one `anyPreview`, and a
// flag can outlive its own stack: the driver preview's "Log out" returns a
// guest to the welcome with that preview still on, and "Swift Business" then
// opened the vendor stack signed out. Its profile read is a 401
// that a guest cannot refresh, so the guest was stranded on "Your session
// ended" with nothing to press but Retry.
// ---------------------------------------------------------------------------
describe('previewBypassForIntent', () => {
  const both = { moverPreview: true, vendorSamplePreview: true };

  it('a leftover driver preview does not open the business stack for a guest', () => {
    const anyPreview = previewBypassForIntent('vendor', { moverPreview: true, vendorSamplePreview: false });

    expect(anyPreview).toBe(false);
    expect(rootEntryGate({ ...fresh, intent: 'vendor', anyPreview })).toBe('country');
    expect(rootEntryGate({ ...fresh, intent: 'vendor', countryCode: 'GY', anyPreview })).toBe('auth');
  });

  it('a leftover business sample opens neither the driver nor the advertiser stack', () => {
    const flags = { moverPreview: false, vendorSamplePreview: true };

    for (const intent of ['mover', 'advertiser'] as const) {
      const anyPreview = previewBypassForIntent(intent, flags);
      expect(anyPreview).toBe(false);
      expect(rootEntryGate({ ...fresh, intent, countryCode: 'GY', anyPreview })).toBe('auth');
    }
  });

  it('each preview still opens its own stack without a country or sign-in', () => {
    expect(rootEntryGate({
      ...fresh,
      intent: 'mover',
      anyPreview: previewBypassForIntent('mover', { moverPreview: true, vendorSamplePreview: false }),
    })).toBe('main');
    expect(rootEntryGate({
      ...fresh,
      intent: 'vendor',
      anyPreview: previewBypassForIntent('vendor', { moverPreview: false, vendorSamplePreview: true }),
    })).toBe('main');
  });

  it('customers, advertisers and the welcome never take a preview bypass', () => {
    for (const intent of [null, 'customer', 'advertiser'] as const) {
      expect(previewBypassForIntent(intent, both)).toBe(false);
    }
  });

  it('is what the root navigator hands the entry gate, instead of both previews OR-ed', () => {
    const src = readFileSync(new URL('./RootNavigator.tsx', import.meta.url), 'utf8');

    expect(src).toContain('const anyPreview = previewBypassForIntent(intent, { moverPreview, vendorSamplePreview });');
    expect(src).not.toMatch(/moverPreview \|\| vendorSamplePreview/);
    expect(src).toMatch(/rootEntryGate\(\{ isAuthenticated, wantsAuth, intent, countryCode, anyPreview, needsSelfie \}\)/);
  });

  it('is exactly the preview of the intent being opened, across every combination', () => {
    const intents: RootEntryState['intent'][] = [null, 'customer', 'mover', 'vendor', 'advertiser'];
    for (const intent of intents) {
      for (const moverPreview of [false, true]) {
        for (const vendorSamplePreview of [false, true]) {
          expect(previewBypassForIntent(intent, { moverPreview, vendorSamplePreview })).toBe(
            (intent === 'mover' && moverPreview) || (intent === 'vendor' && vendorSamplePreview),
          );
        }
      }
    }
  });
});
