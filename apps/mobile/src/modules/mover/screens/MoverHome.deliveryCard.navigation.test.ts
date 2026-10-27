/// <reference lib="dom" />
// [CARS-DELIVER PR4 · REVIEW-F #2139 S2-1, S4-2] The REAL MoverHomeScreen in taxi mode for a driver on "taxi rides and
// deliveries", with a delivery card on screen. The live card (dispatch:offer, #2138) carries its pay, so the driver sees
// the price and the cash box before deciding; Accept and Decline go to the DELIVERY routes; a TAXI card, or a card with
// no orderType (an older server), goes to the taxi routes as before. Lifted from REVIEW-F's probe; only native drawing,
// the data hooks and unrelated components are stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

const fx = vi.hoisted(() => ({
  jobs: [] as any[], offer: null as any, kind: 'DRIVER' as 'DRIVER' | 'RIDER',
  accept: { DRIVER: vi.fn(), RIDER: vi.fn() }, decline: { DRIVER: vi.fn(), RIDER: vi.fn() }, offersArgs: [] as unknown[],
}));
vi.mock('../../../hooks/useJobRing', () => ({ useJobRing: vi.fn() }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, Pressable, Text: View, StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 }, Platform: { OS: 'ios' } };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../../components/PushOffStrip', () => ({ PushOffStrip: () => null }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('div', null, p.children), Marker: () => null, PROVIDER_DEFAULT: 'default' };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('section', null, p.children), BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const T = (p: any) => h('span', { 'data-testid': p.testID }, p.children);
  return {
    T, Screen: (p: any) => h('div', null, p.children), ErrorState: () => null, LoadingBlock: () => null, Pictogram: () => null,
    TonePill: (p: any) => h('span', null, p.label), cardShadow: {},
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useMoverKind: () => ({ kind: fx.kind, profile: { isOnline: true }, loading: false, error: null, ambiguous: false, dual: true, refetch: vi.fn() }),
    useMoverStats: () => ({ data: null }),
    useEarningsToday: () => ({ data: { total: 0 } }),
    useDailyEarnings: () => ({ data: [] }),
    useDemand: () => ({ data: {} }),
    useAvailableJobs: () => ({ data: fx.jobs, dataUpdatedAt: Date.now() }),
    useDispatchOffers: (...args: unknown[]) => { fx.offersArgs = args; return { offer: fx.offer, queuedBehind: 0, dismiss: vi.fn() }; },
    useActiveJob: () => ({ data: null }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useGoOnline: mutation, useGoOffline: mutation, useAcceptJob: mutation,
    useAcceptOffer: (k: 'DRIVER' | 'RIDER') => ({ mutate: fx.accept[k], isPending: false }),
    useDeclineOffer: (k: 'DRIVER' | 'RIDER') => ({ mutateAsync: (...a: unknown[]) => { fx.decline[k](...a); return Promise.resolve(null); }, isPending: false }),
    useSelectMoverKind: mutation,
    useVerificationStatus: () => ({ data: null }),
  };
});
vi.mock('../../../stores/locationStore', () => ({
  useLocationStore: Object.assign(() => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }), { getState: () => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }) }),
}));
vi.mock('../../../stores/authStore', () => ({ requireAuthSessionSnapshot: vi.fn() }));
vi.mock('../../../hooks/useDeviceLocation', () => ({ GEORGETOWN: { latitude: 6.8013, longitude: -58.1553 }, useDeviceLocation: () => ({ resolve: vi.fn() }) }));
vi.mock('../../../services/backgroundLocation', () => ({ requestMoverBackgroundPermission: vi.fn() }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('./MoverHomeAccountButton', () => ({ MoverHomeAccountButton: () => null }));
vi.mock('./BackgroundLocationDisclosure', () => ({ useBackgroundLocationDisclosure: () => ({ disclosure: null, disclose: vi.fn() }) }));
vi.mock('../../../hooks/mover', () => ({ useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));

import { MoverHomeScreen } from './MoverHomeScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const text = () => host.textContent ?? '';
async function draw() {
  await act(async () => root.render(React.createElement(MoverHomeScreen, { navigation: { navigate: vi.fn() } })));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const press = async (label: string) => {
  const b = Array.from(host.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === label);
  if (!b) throw new Error(`no button ${label}: ${Array.from(host.querySelectorAll('button')).map((x) => x.getAttribute('aria-label')).join('|')}`);
  await act(async () => { b.click(); });
};
// The LIVE socket card exactly as #2138's dispatch:offer emit shapes it: its pay, no addresses.
const liveDeliveryCard = {
  orderId: 'ord-food-1', offerAttemptId: 'att-1', orderType: 'FOOD_DELIVERY', orderNumber: 'SW-1', vendorName: 'Corner Shop',
  isExpress: false, expiresInSeconds: 25, etaMinutes: 4, rescueIncentiveGyd: null, paymentMethod: 'CASH',
  deliveryFee: 800, tipAmount: 0, customerTrust: null, itemCount: 3, estLoad: 'small',
  cashMath: { collectFromCustomer: 5600, payToVendor: 4800, youKeep: 800 },
};

beforeEach(() => {
  vi.clearAllMocks();
  // The taxi board: rides only (a delivery card in taxi mode never has a board row).
  fx.jobs = [{ id: 'ride-1', pickupAddress: 'Bourda', dropoffAddress: 'Kitty', fareTotal: 1800, paymentMethod: 'CASH' }];
  fx.offer = null; fx.kind = 'DRIVER';
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[CARS-DELIVER PR4] a delivery card in taxi mode', () => {
  it('the home asks the offer hook for delivery cards too, as a dual driver in taxi mode', async () => {
    await draw();
    expect(fx.offersArgs).toEqual(['DRIVER', true, true]);
  });

  it('the LIVE delivery card shows its price and the cash box (collect, pay the store, keep), not an order total', async () => {
    fx.offer = liveDeliveryCard;
    await draw();
    const t = text();
    expect(t).toContain('New delivery request');
    expect({ price: t.includes('YOUR PRICE'), cashBox: t.includes('Cash job'), orderTotal: t.includes('ORDER TOTAL') })
      .toEqual({ price: true, cashBox: true, orderTotal: false });
  });

  it('Accept and Decline on a delivery card go to the delivery routes, never the taxi routes', async () => {
    fx.offer = liveDeliveryCard;
    await draw();
    await press('Accept delivery');
    expect(fx.accept.RIDER).toHaveBeenCalledTimes(1);
    expect(fx.accept.RIDER.mock.calls[0]![0]).toEqual({ orderId: 'ord-food-1', offerAttemptId: 'att-1' });
    expect(fx.accept.DRIVER).not.toHaveBeenCalled();
    await press('Decline');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(fx.decline.RIDER).toHaveBeenCalledTimes(1);
    expect(fx.decline.DRIVER).not.toHaveBeenCalled();
  });

  it('a TAXI card, and a card with no orderType (an older server), are rides answered on the taxi routes as before', async () => {
    for (const offer of [
      { orderId: 'ride-1', offerAttemptId: 'a', orderType: 'TAXI', expiresInSeconds: 20 },
      { orderId: 'ride-1', offerAttemptId: 'b', expiresInSeconds: 20 },
    ]) {
      fx.offer = offer; vi.clearAllMocks();
      await draw();
      expect(text()).toContain('New ride request');
      await press('Accept ride');
      expect(fx.accept.DRIVER).toHaveBeenCalledTimes(1);
      expect(fx.accept.RIDER).not.toHaveBeenCalled();
      await press('Decline');
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      expect(fx.decline.DRIVER).toHaveBeenCalledTimes(1);
      expect(fx.decline.RIDER).not.toHaveBeenCalled();
    }
  });
});
