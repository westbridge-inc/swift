/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { BOARD_STOPS } from '../../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 7] The REAL live-offer card and the REAL open board
// (MoverHomeScreen), drawn by a real React renderer and fed CONTRACT.md Rev 2
// §6.1/§6.2's shapes: a ride WITH stops says "N stops" and lists them in
// order; a ride without them is exactly today's card.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ jobs: [] as any[], offer: null as any }));

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
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Screen: (p: any) => h('div', null, p.children), ErrorState: () => null, LoadingBlock: () => null, Pictogram: () => null,
    TonePill: (p: any) => h('span', null, p.label), FareSlider: () => null, canAdjustFare: () => true, cardShadow: {},
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useMoverKind: () => ({ kind: 'DRIVER', profile: { isOnline: true }, loading: false, error: null, ambiguous: false, refetch: vi.fn() }),
    useMoverStats: () => ({ data: null }),
    useEarningsToday: () => ({ data: { total: 0 } }),
    useDailyEarnings: () => ({ data: [] }),
    useDemand: () => ({ data: {} }),
    useAvailableJobs: () => ({ data: fx.jobs }),
    useDispatchOffers: () => ({ offer: fx.offer, queuedBehind: 0, dismiss: vi.fn() }),
    useActiveJob: () => ({ data: null }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useGoOnline: mutation, useGoOffline: mutation, useAcceptJob: mutation, useAcceptOffer: mutation, useDeclineOffer: mutation, useSelectMoverKind: mutation,
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

import { DispatchOfferCard, MoverHomeScreen } from './MoverHomeScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const snap = (name: string) => (globalThis as { __msCapture?: (n: string, html: string) => void }).__msCapture?.(name, host.innerHTML);
const text = () => host.textContent ?? '';
const stopLabels = (scope: Element = host) => Array.from(scope.querySelectorAll('[aria-label^="Stop "]')).map((e) => e.getAttribute('aria-label'));

const baseOffer = {
  orderId: 'cm-ride-9', offerAttemptId: 'attempt-1', expiresInSeconds: 30, etaMinutes: 4, paymentMethod: 'CASH',
  taxiFareTotal: 3400, pickupAddress: 'Stabroek Market', deliveryAddress: 'Lamaha Street',
};

async function draw(element: React.ReactElement) {
  await act(async () => root.render(element));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const offerCard = (offer: unknown, job: unknown = null) =>
  React.createElement(DispatchOfferCard, { offer: offer as never, job: job as never, kind: 'DRIVER', accepting: false, onAccept: vi.fn(), onDecline: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  fx.jobs = [];
  fx.offer = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the live offer card (§6.2)', () => {
  it('a ride WITH stops says "2 stops" and lists them in order between pickup and drop-off', async () => {
    await draw(offerCard({ ...baseOffer, ...BOARD_STOPS }));
    snap('driver-offer-two-stops');
    expect(host.querySelector('[data-testid="driver-offer-stops"]')?.textContent).toBe('2 stops · one fare for the whole trip');
    expect(stopLabels()).toEqual(['Stop 1: Camp Street', 'Stop 2: Sheriff Street']);
    const all = text();
    expect(all.indexOf('Stabroek Market')).toBeLessThan(all.indexOf('Camp Street'));
    expect(all.indexOf('Sheriff Street')).toBeLessThan(all.indexOf('Lamaha Street'));
  });

  it('a ride without stops is today’s card', async () => {
    await draw(offerCard(baseOffer));
    snap('driver-offer-flag-off');
    expect(host.querySelector('[data-testid="driver-offer-stops"]')).toBeNull();
    expect(stopLabels()).toEqual([]);
    expect(text()).not.toMatch(/stops?\b/i);
  });

  it('a card recovered without its stops still shows them from the board row', async () => {
    await draw(offerCard(baseOffer, { id: 'cm-ride-9', ...BOARD_STOPS }));
    expect(stopLabels()).toEqual(['Stop 1: Camp Street', 'Stop 2: Sheriff Street']);
  });
});

describe('the open board (§6.1)', () => {
  it('only the ride with stops says "N stops" and lists them', async () => {
    fx.jobs = [
      { id: 'plain-1', pickupAddress: 'Bourda Market', dropoffAddress: 'Kitty', fareTotal: 1800, paymentMethod: 'CASH' },
      { id: 'multi-1', pickupAddress: 'Stabroek Market', dropoffAddress: 'Lamaha Street', fareTotal: 3400, paymentMethod: 'CASH', ...BOARD_STOPS },
    ];
    await draw(React.createElement(MoverHomeScreen, { navigation: { navigate: vi.fn() } }));
    snap('driver-board-one-plain-one-with-stops');
    expect(host.querySelector('[data-testid="driver-board-stops-plain-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="driver-board-stops-multi-1"]')?.textContent).toBe('2 stops · one fare for the whole trip');
    expect(stopLabels()).toEqual(['Stop 1: Camp Street', 'Stop 2: Sheriff Street']);
  });
});

describe('[review 2] flag off: the offer card and the board are main’s, byte for byte', () => {
  it('the live offer without stops', async () => {
    await draw(offerCard(baseOffer));
    await expect(host.innerHTML).toMatchFileSnapshot('./__flagoff__/driver-offer.html');
  });

  it('the board without stops', async () => {
    fx.jobs = [{ id: 'plain-1', pickupAddress: 'Bourda Market', dropoffAddress: 'Kitty', fareTotal: 1800, paymentMethod: 'CASH' }];
    await draw(React.createElement(MoverHomeScreen, { navigation: { navigate: vi.fn() } }));
    await expect(host.innerHTML).toMatchFileSnapshot('./__flagoff__/driver-board.html');
  });
});
