import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [STORE-ALERT 18 Oct 2026] A "New Order!" push tapped while the customer (or
// mover) app is open: the store's order desk is not mounted there, so the
// route landed nowhere. The global StoreAlertElsewhere layer takes such a tap
// (it asks, switches apps through switch-role, then routes the data again).
// Same harness as notification-router.partner-routes.test.ts: the REAL router,
// store selection and query cache; fake native transports and vendor reads.
const fx = vi.hoisted(() => ({
  owner: { userId: 'synthetic-owner', generation: 1 } as { userId: string; generation: number } | null,
  intent: 'customer' as string | null,
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
import { installNotificationTapRouter, routeNotificationData, setBusinessTapElsewhereHandler } from './notification-router';

let uninstall: () => void;
const profile = { data: { data: { myRole: 'OWNER', vendors: [{ id: 'store-A', vendorType: 'RESTAURANT' }] } } };
const alert = { kind: 'vendor_order_alert', orderId: 'order-1', orderNumber: 'SW-261018-00293G', status: 'PENDING', audience: 'business' };
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function tap(data: Record<string, unknown>) {
  fx.listener!({ notification: { request: { identifier: String(data['kind']), content: { data } } }, actionIdentifier: 'default' });
}
beforeEach(() => {
  vi.clearAllMocks();
  fx.owner = { userId: 'synthetic-owner', generation: 1 };
  fx.intent = 'customer';
  fx.navigate.mockReturnValue(true);
  fx.profile.mockResolvedValue(profile);
  fx.order.mockResolvedValue({ data: { data: { id: 'order-1', vendorId: 'store-A' } } });
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  queryClient.clear();
  uninstall = installNotificationTapRouter();
});
afterEach(() => { uninstall(); queryClient.clear(); });

describe('[STORE-ALERT] a store push tapped in another app reaches the store', () => {
  it('in the customer app the tap goes to the open-my-store layer, not to a screen that is not mounted', async () => {
    const handler = vi.fn();
    const release = setBusinessTapElsewhereHandler(handler);
    try {
      tap(alert);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledExactlyOnceWith(alert));
      await pause();
      expect(fx.navigate).not.toHaveBeenCalled();
      expect(fx.profile).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('the same in the mover app: a driver who also owns a store is asked, never routed blind', async () => {
    fx.intent = 'mover';
    const handler = vi.fn();
    const release = setBusinessTapElsewhereHandler(handler);
    try {
      tap(alert);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(fx.navigate).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('once the store app is open, routing the same data opens the order desk', async () => {
    const handler = vi.fn();
    const release = setBusinessTapElsewhereHandler(handler);
    try {
      fx.intent = 'vendor';
      routeNotificationData(alert);
      await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorOrderDetail', { orderId: 'order-1', orderNumber: 'SW-261018-00293G' }));
      expect(handler).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('only the new-order alert is diverted; other store notices route as before', async () => {
    const handler = vi.fn();
    const release = setBusinessTapElsewhereHandler(handler);
    try {
      tap({ kind: 'staff_joined', vendorId: 'store-A', audience: 'business' });
      await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('VendorRoot', { screen: 'Account' }));
      expect(handler).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('a released handler no longer takes taps (the layer unmounted or the account owns no store)', async () => {
    const handler = vi.fn();
    setBusinessTapElsewhereHandler(handler)();
    tap(alert);
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledTimes(1));
    expect(handler).not.toHaveBeenCalled();
  });
});
