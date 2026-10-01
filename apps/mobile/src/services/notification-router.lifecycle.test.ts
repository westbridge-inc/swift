import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [AX449 #3] Run the real router, fee resolver, selection and query cache. Only
// native notification/navigation/socket transports and authoritative reads are
// fake. A newer tap owns routing: an older fee lookup must not publish a store,
// retire the store's routes and cache, cycle the socket or navigate after it.
const fx = vi.hoisted(() => ({
  owner: { userId: 'synthetic-owner', generation: 1 },
  ready: true,
  profile: vi.fn(), order: vi.fn(), subscription: vi.fn(), navigate: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
  listener: undefined as undefined | ((response: unknown) => void),
  last: vi.fn(),
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: () => fx.last(),
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => fx.ready }, safeNavigate: fx.navigate }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({ ...fx.owner }) }));
vi.mock('../services/socket', () => ({ disconnectSocket: fx.disconnect, reconnectSocketForStoreHandoff: fx.reconnect }));
vi.mock('../services/api', () => ({ vendorApi: { profile: fx.profile, order: fx.order, subscription: fx.subscription } }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { queryClient } from '../lib/queryClient';
import { installNotificationTapRouter } from './notification-router';

let uninstall: () => void;
const fee = { kind: 'billing_mmg_checkout', vendorId: 'store-B', subscriptionId: 'subscription-B', ref: 'checkout-B' };
const order = { kind: 'vendor_order_alert', vendorId: 'store-A', orderId: 'order-A' };
const profile = { data: { data: { myRole: 'OWNER', vendors: [
  { id: 'store-A', vendorType: 'RESTAURANT' }, { id: 'store-B', vendorType: 'SERVICE' },
] } } };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 20));
function tap(data: Record<string, unknown>, identifier: string) {
  fx.listener!({ notification: { request: { identifier, content: { data } } }, actionIdentifier: 'default' });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
/** Every newer tap the old fee lookup must yield to, with where it lands. */
const newer = {
  order: [order, 'VendorOrderDetail'],
  category: [{ kind: 'category_backfill_review', vendorId: 'store-A' }, 'VendorCategoryReview'],
  'pin-moved': [{ kind: 'store_pin_moved', vendorId: 'store-A' }, 'VendorRoot'],
  'mover-offer': [{ kind: 'dispatch_offer', orderId: 'offer-1' }, 'Main'],
  'newer-fee': [{ kind: 'billing_mmg_checkout', vendorId: 'store-A', subscriptionId: 'subscription-A', ref: 'checkout-A' }, 'WeeklyFee'],
} as const;
beforeEach(() => {
  vi.clearAllMocks();
  fx.owner = { userId: 'synthetic-owner', generation: 1 }; fx.ready = true;
  fx.last.mockResolvedValue(null); fx.navigate.mockReturnValue(true);
  fx.profile.mockResolvedValue(profile);
  fx.order.mockResolvedValue({ data: { data: { id: 'order-A', vendorId: 'store-A' } } });
  fx.subscription.mockImplementation(async (_owner: unknown, vendorId: string) => ({ data: { data: { id: vendorId === 'store-A' ? 'subscription-A' : 'subscription-B' } } }));
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  queryClient.clear();
  uninstall = installNotificationTapRouter();
});
afterEach(() => { uninstall(); queryClient.clear(); });

describe('R3 an older fee lookup yields to every newer tap', () => {
  it.each(Object.keys(newer) as Array<keyof typeof newer>)('an older fee response cannot switch store, cycle the socket, clear cache or navigate after a newer %s tap', async kind => {
    const [data, screen] = newer[kind];
    const held = deferred<unknown>();
    fx.subscription.mockImplementationOnce(() => held.promise);
    tap(fee, 'older-fee');
    await vi.waitFor(() => expect(fx.subscription).toHaveBeenCalledOnce());
    tap(data, `newer-${kind}`);
    await vi.waitFor(() => expect(fx.navigate.mock.calls.map(([name]) => name)).toContain(screen));
    const selection = useStoreSwitcher.getState();
    const remove = vi.spyOn(queryClient, 'removeQueries');
    fx.navigate.mockClear(); fx.disconnect.mockClear(); fx.reconnect.mockClear();
    try {
      held.resolve({ data: { data: { id: 'subscription-B' } } }); await pause();
      expect(useStoreSwitcher.getState().selectedStoreId).toBe(selection.selectedStoreId);
      expect(useStoreSwitcher.getState().storeGeneration).toBe(selection.storeGeneration);
      expect(fx.disconnect).not.toHaveBeenCalled(); expect(fx.reconnect).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(fx.navigate).not.toHaveBeenCalled();
    } finally { remove.mockRestore(); }
  });

  it.each(['retry', 'cancel'] as const)('a retained fee %s cannot act after a newer order tap, and retires itself', async action => {
    fx.subscription.mockRejectedValueOnce({ response: { status: 503 } });
    tap(fee, 'failed-fee');
    await vi.waitFor(() => expect(useStoreSwitcher.getState().feeContextError).not.toBeNull());
    const old = useStoreSwitcher.getState().feeContextError!;
    tap(order, 'newer-order-after-fee');
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledWith('VendorOrderDetail', { orderId: 'order-A' }));
    fx.navigate.mockClear(); fx.disconnect.mockClear(); fx.reconnect.mockClear();
    await old[action](); await pause();
    expect(fx.navigate).not.toHaveBeenCalled();
    expect(fx.disconnect).not.toHaveBeenCalled(); expect(fx.reconnect).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    expect(fx.subscription).toHaveBeenCalledOnce();
    // The superseded notice no longer holds Pay or its controls.
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    expect(useStoreSwitcher.getState().feeContextError).toBeNull();
  });

  it.each(['store', 'roundtrip', 'account', 'newer-tap'] as const)('rechecks %s after the fee handoff, before dispatch', async change => {
    let traversed = false;
    const unsubscribe = useStoreSwitcher.subscribe(state => {
      if (state.selectedStoreId !== 'store-B' || traversed) return;
      traversed = true;
      // Lands between the lookup's own store handoff and the router's dispatch.
      queueMicrotask(() => {
        if (change === 'account') fx.owner = { userId: 'synthetic-owner', generation: 2 };
        else if (change === 'newer-tap') tap({ kind: 'dispatch_offer', orderId: 'offer-2' }, 'newer-offer');
        else { useStoreSwitcher.getState().setSelectedStore('store-A'); if (change === 'roundtrip') useStoreSwitcher.getState().setSelectedStore('store-B'); }
      });
    });
    try {
      tap(fee, `fee-then-${change}`);
      await pause(); await pause();
      expect(traversed).toBe(true);
      expect(fx.navigate.mock.calls.map(([name]) => name)).not.toContain('WeeklyFee');
    } finally { unsubscribe(); }
  });

  it('a retained retry still recovers the notice while its tap is the newest', async () => {
    fx.subscription.mockRejectedValueOnce({ response: { status: 503 } });
    tap(fee, 'failed-fee-current');
    await vi.waitFor(() => expect(useStoreSwitcher.getState().feeContextError).not.toBeNull());
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledWith('WeeklyFee', { ref: undefined, subscriptionId: undefined, vendorId: 'store-A', feeFamily: 'vendor' }));
    fx.navigate.mockClear();
    await useStoreSwitcher.getState().feeContextError!.retry();
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
    expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { vendorId: 'store-B', subscriptionId: 'subscription-B', ref: 'checkout-B', feeFamily: 'vendor' });
    expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
  });
});
