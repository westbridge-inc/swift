import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [73 · MOBILE-SAFETY] A taxi safety notification opens the taxi screen, never
// a delivery. The stranded-taxi watchdog (dispatch.service recoverStrandedTaxiRides)
// sends these exact payloads; the API suite asserts it does (taxi.test.ts).
// Routed through the real tap router: the pure table, a warm tap, and a cold
// start that arrives before navigation is ready.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  ready: true,
  navigate: vi.fn(),
  listener: undefined as undefined | ((response: unknown) => void),
  last: vi.fn(),
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: () => fx.last(),
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => fx.ready }, safeNavigate: (...args: unknown[]) => (fx.ready ? (fx.navigate(...args), true) : false) }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({ userId: 'synthetic-owner', generation: 1 }) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null, storeGeneration: 0 }) } }));

import { destinationFor, flushPendingNavigation, installNotificationTapRouter } from './notification-router';

const RIDE = 'synthetic-ride';
const release = { orderType: 'TAXI', rideId: RIDE, orderId: RIDE, audience: 'customer', status: 'PENDING' };
const custody = { orderType: 'TAXI', rideId: RIDE, orderId: RIDE, audience: 'customer', status: 'RIDE_IN_PROGRESS' };
const tapWith = (data: Record<string, unknown>) => ({ notification: { request: { identifier: 'n1', content: { data } } }, actionIdentifier: 'default' });

describe('[73] the taxi watchdog payloads route to Taxi', () => {
  it('in the tap table, both watchdog branches open Taxi', () => {
    expect(destinationFor(release)).toEqual({ screen: 'Taxi' });
    expect(destinationFor(custody)).toEqual({ screen: 'Taxi' });
  });

  it('a cancelled ride tapped by the driver opens their available home, never an unregistered Taxi route', () => {
    expect(destinationFor({ orderType: 'TAXI', rideId: RIDE, orderId: RIDE, audience: 'earner', status: 'CANCELLED' })).toEqual({ screen: 'Main' });
  });

  it('an untagged order update keeps its delivery route; a mismatched marker is not a taxi', () => {
    expect(destinationFor({ orderId: 'o1', status: 'PENDING' })).toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
    expect(destinationFor({ orderType: 'TAXI', rideId: 'other', orderId: 'o1', audience: 'customer' })).toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
  });
});

describe('[73] warm and cold taps of a watchdog payload', () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => { vi.clearAllMocks(); fx.ready = true; fx.last.mockResolvedValue(null); });
  afterEach(() => uninstall());

  it('a warm tap navigates to Taxi', async () => {
    uninstall = installNotificationTapRouter();
    fx.listener!(tapWith(release));
    await vi.waitFor(() => expect(fx.navigate).toHaveBeenCalledWith('Taxi', undefined));
    expect(fx.navigate).not.toHaveBeenCalledWith('Delivery', expect.anything());
  });

  it('a cold start before navigation is ready is held, then delivered to Taxi', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      fx.ready = false;
      fx.last.mockResolvedValue(tapWith(custody));
      uninstall = installNotificationTapRouter();
      await vi.waitFor(() => expect(fx.last).toHaveBeenCalled());
      await Promise.resolve(); await Promise.resolve();
      expect(fx.navigate).not.toHaveBeenCalled();
      fx.ready = true;
      flushPendingNavigation();
      await vi.advanceTimersByTimeAsync(300);
      expect(fx.navigate).toHaveBeenCalledWith('Taxi', undefined);
      expect(fx.navigate).not.toHaveBeenCalledWith('Delivery', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});
