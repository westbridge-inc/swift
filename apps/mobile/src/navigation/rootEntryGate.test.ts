import { describe, expect, it } from 'vitest';
import { rootEntryGate, type RootEntryState } from './rootEntryGate';

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
