import { describe, expect, it, vi } from 'vitest';
import type { MmgDirectPaymentAction } from '@swift/types';

vi.mock('react-native', () => ({ Linking: { openURL: vi.fn(async () => undefined) } }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));

import { openMmgPaymentAction, safeMmgPaymentActionUrl } from './payLink';

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
