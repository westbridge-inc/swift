import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [PUSH-ROUTING · board row 331] The REAL router, store selection and query
// cache, driven by a real tap through the notification listener. Only the
// native notification/navigation transports, the socket and the authoritative
// vendor reads are fake. notification-router.test.ts grades the pure table;
// this suite grades what a tap on the new routes actually dispatches.
const fx = vi.hoisted(() => ({
  owner: { userId: 'synthetic-owner', generation: 1 } as { userId: string; generation: number } | null,
  intent: 'mover' as string | null,
  profile: vi.fn(), order: vi.fn(), subscription: vi.fn(), navigate: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
  listener: undefined as undefined | ((response: unknown) => void),
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => true }, safeNavigate: fx.navigate }));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => (fx.owner ? { ...fx.owner } : null),
  useAuthStore: { getState: () => ({ intent: fx.intent }) },
}));
vi.mock('../services/socket', () => ({ disconnectSocket: fx.disconnect, reconnectSocketForStoreHandoff: fx.reconnect }));
vi.mock('../services/api', () => ({ vendorApi: { profile: fx.profile, order: fx.order, subscription: fx.subscription } }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { queryClient } from '../lib/queryClient';
import { installNotificationTapRouter } from './notification-router';

let uninstall: () => void;
const profile = { data: { data: { myRole: 'OWNER', vendors: [{ id: 'store-A', vendorType: 'RESTAURANT' }, { id: 'store-B', vendorType: 'RETAIL' }] } } };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 20));
function tap(data: Record<string, unknown>) {
  fx.listener!({ notification: { request: { identifier: String(data['kind']), content: { data } } }, actionIdentifier: 'default' });
}
beforeEach(() => {
  vi.clearAllMocks();
  fx.owner = { userId: 'synthetic-owner', generation: 1 };
  fx.intent = 'mover';
  fx.navigate.mockReturnValue(true);
  fx.profile.mockResolvedValue(profile);
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  queryClient.clear();
  uninstall = installNotificationTapRouter();
});
afterEach(() => { uninstall(); queryClient.clear(); });

describe('a weekly-fee notice keeps the family it names [PUSH-ROUTING]', () => {
  it('a store fee suspension opens the STORE fee, even with the Earner app open', async () => {
    // The router used to stamp every WeeklyFee without a store on it as a
    // mover's fee. A store owner suspended for the fee must not be shown a
    // driver's subscription.
    tap({ kind: 'billing_suspended', subscriptionId: 'subscription-A', audience: 'business' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { feeFamily: 'vendor' }));
    // No store or checkout is named, so none is looked up or switched.
    expect(fx.subscription).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
  });

  it('a mover fee warning opens the mover fee', async () => {
    fx.intent = 'vendor';
    tap({ kind: 'billing_final_warning', subscriptionId: 'subscription-M', suspendsAt: '2026-10-20T04:00:00.000Z', audience: 'earner' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { feeFamily: 'mover' }));
  });

  it('an untagged rate notice follows the app that is open', async () => {
    fx.intent = 'vendor';
    tap({ kind: 'fx_change_notice', subscriptionId: 'subscription-A', fxRateId: 'f1' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { feeFamily: 'vendor' }));
  });

  it('[ENTERPRISE E1b] a pay-all payment notice opens "Pay all my branches" on its ref, never a mover\'s fee, even with the Earner app open', async () => {
    tap({ kind: 'billing_mmg_checkout', ref: 'chain-1', status: 'CONFIRMED', chainCheckout: true, audience: 'business' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { feeFamily: 'vendor', payAll: true, ref: 'chain-1' }));
    expect(fx.subscription).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
  });

  it('a mover checkout without a store is still a mover’s fee (the build 9 to 11 contract)', async () => {
    tap({ kind: 'billing_mmg_checkout', subscriptionId: 'subscription-M', ref: 'checkout-M', status: 'CONFIRMED', audience: 'earner' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { ref: 'checkout-M', subscriptionId: 'subscription-M', vendorId: undefined, feeFamily: 'mover' }));
  });
});

describe('a store notice opens the store it is about, on the tab it is about [PUSH-ROUTING]', () => {
  it('someone joined the team: the named store is selected and its Account tab (the team panel) opens', async () => {
    tap({ kind: 'staff_joined', vendorId: 'store-B', audience: 'business' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorRoot', { screen: 'Account' }));
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
  });

  it('added to a team: the store they joined opens', async () => {
    tap({ kind: 'staff_added', vendorId: 'store-B' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorRoot', undefined));
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
  });

  it('a store this account does not belong to opens nothing and selects nothing', async () => {
    tap({ kind: 'staff_added', vendorId: 'store-Z' });
    await vi.waitFor(() => expect(fx.profile).toHaveBeenCalled());
    await pause();
    expect(fx.navigate).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
  });

  it('low stock names no store: the catalogue tab of the selected store opens', async () => {
    tap({ kind: 'low_stock', itemId: 'item-1', remaining: 2 });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorRoot', { screen: 'Menu' }));
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
  });

  it('a store document notice opens the store’s documents (its Account tab), after the store is checked', async () => {
    tap({ kind: 'verification_expired', docId: 'd1', audience: 'business' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorRoot', { screen: 'Account' }));
    expect(fx.profile).toHaveBeenCalled();
  });

  it('a signed-out tap opens no store route', async () => {
    fx.owner = null;
    tap({ kind: 'staff_joined', vendorId: 'store-B', audience: 'business' });
    await pause();
    expect(fx.profile).not.toHaveBeenCalled();
    expect(fx.navigate).not.toHaveBeenCalled();
  });
});

describe('an untagged document notice opens the documents of the app that is open [PUSH-ROUTING]', () => {
  it.each([
    ['mover', 'MoverDocuments', undefined],
    ['customer', 'IdentityVerification', undefined],
  ] as const)('with the %s app open', async (intent, screen, params) => {
    fx.intent = intent;
    tap({ kind: 'verification_rejected' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith(screen, params));
  });

  it('with the Business app open: the selected store’s Account tab', async () => {
    fx.intent = 'vendor';
    tap({ kind: 'verification_rejected' });
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorRoot', { screen: 'Account' }));
  });
});
