import { describe, expect, it, vi } from 'vitest';
import type { MmgDirectPaymentAction } from '@swift/types';

vi.mock('react-native', () => ({ Linking: { openURL: vi.fn(async () => undefined) } }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));

import { openMmgPaymentAction, safeMmgPaymentActionUrl, safePayUrl } from './payLink';

const action: MmgDirectPaymentAction = {
  kind: 'OPEN_EXTERNAL_URL',
  method: 'MOBILE_MONEY',
  provider: 'MMG',
  fundsFlow: 'DIRECT_TO_VENDOR',
  orderId: 'order-1',
  recipientName: 'Green Bowl',
  amount: 2500,
  url: 'https://pay.example.com/pay/green-bowl?ref=order-1',
};

describe('explicit MMG payment action opener', () => {
  it('opens the validated post-checkout action and nothing else', async () => {
    const opener = vi.fn(async () => undefined);
    expect(await openMmgPaymentAction(action, opener)).toBe(true);
    expect(opener).toHaveBeenCalledWith(action.url);

    opener.mockClear();
    expect(await openMmgPaymentAction(null, opener)).toBe(false);
    expect(await openMmgPaymentAction({ ...action, fundsFlow: 'SWIFT_WALLET' } as never, opener)).toBe(false);
    expect(opener).not.toHaveBeenCalled();

    const failedOpener = vi.fn(async () => false);
    expect(await openMmgPaymentAction(action, failedOpener)).toBe(false);
  });

  it.each([
    'http://pay.example.com/pay/x',
    'https://user:secret@pay.example.com/pay/x',
    'https://pay.example.com/pay/x#paid',
    'https://localhost/pay/x',
    'https://127.0.0.1/pay/x',
    'not a URL',
  ])('refuses an unsafe client-side destination: %s', (url) => {
    expect(safeMmgPaymentActionUrl({ ...action, url })).toBeNull();
  });
});

// The driver's post-trip "pay me with MMG" link is a RAW string on the ride
// payload, not a server-issued action object — so safeMmgPaymentActionUrl could
// never see it, and RidePostTripSheet opened it unvalidated. That was the one
// money destination in the app nothing checked. safePayUrl is the shared shape
// check both paths now run through.
describe('safePayUrl — the raw-string money link (driver pay-me)', () => {
  it('passes a legitimate https pay link through unchanged', () => {
    expect(safePayUrl('https://pay.example.com/d/abc')).toBe('https://pay.example.com/d/abc');
  });

  it.each([
    ['http, not https', 'http://pay.example.com/d/abc'],
    ['embedded credentials', 'https://user:pass@pay.example.com/d/abc'],
    ['a fragment', 'https://pay.example.com/d/abc#frag'],
    ['a non-443 port', 'https://pay.example.com:8443/d/abc'],
    ['an IPv4 literal', 'https://203.0.113.9/d/abc'],
    ['loopback', 'https://localhost/d/abc'],
    ['a .local host', 'https://till.local/d/abc'],
    ['an internal host', 'https://box.internal/d/abc'],
    ['a bare hostname with no dot', 'https://intranet/d/abc'],
    ['not a URL at all', 'pay me please'],
  ])('refuses %s', (_why, url) => {
    expect(safePayUrl(url)).toBeNull();
  });

  it.each([null, undefined, ''])('refuses an absent link (%s) rather than throwing', (v) => {
    expect(safePayUrl(v as string | null | undefined)).toBeNull();
  });

  it('is the same check the server-issued action runs — one rule, two callers', () => {
    const bad = 'https://203.0.113.9/pay';
    expect(safePayUrl(bad)).toBeNull();
    expect(safeMmgPaymentActionUrl({ ...action, url: bad })).toBeNull();
  });
});
