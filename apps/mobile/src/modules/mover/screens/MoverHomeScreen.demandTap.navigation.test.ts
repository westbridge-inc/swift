/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [row 54 · owner 9 Oct] "1 person waiting for a ride — tapping does nothing."
// The REAL earner home, drawn by a real React renderer, fed the server's
// demand payload (rounded points + "N waiting" clusters). A tap on that demand
// now does something TRUE: opens the open board when it has jobs, says how the
// work arrives when it does not, points at GO when offline — and never names a
// customer or a location. Native maps / bottom sheet are stand-ins that record
// the tap and the sheet's snap.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  kind: 'DRIVER' as 'DRIVER' | 'RIDER',
  online: true,
  demand: {} as any,
  jobs: [] as any[],
  active: null as any,
  snapToIndex: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
  goOnline: vi.fn(),
}));

// The push-off strip (main since this test was written) reads AppState; it is not what this test is about.
vi.mock('../../../components/PushOffStrip', () => ({ PushOffStrip: () => null }));
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
  const h = R.createElement;
  return {
    __esModule: true,
    default: (p: any) => h('div', { 'data-map': '' }, p.children),
    // A marker is "tappable" only if it carries a handler: exactly what the device does.
    Marker: (p: any) => h('div', { 'data-marker': p.title ?? 'demand', 'data-tappable': p.onPress ? 'true' : 'false', onClick: p.onPress }, p.children),
    PROVIDER_DEFAULT: 'default',
  };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  const Sheet = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ snapToIndex: fx.snapToIndex }));
    return R.createElement('section', null, p.children);
  });
  return { __esModule: true, default: Sheet, BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Screen: (p: any) => h('div', null, p.children), ErrorState: () => null, LoadingBlock: () => null, Pictogram: () => null,
    TonePill: (p: any) => h('span', null, p.label), cardShadow: {},
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: fx.toast }));
vi.mock('../../../hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useMoverKind: () => ({ kind: fx.kind, profile: { isOnline: fx.online }, loading: false, error: null, ambiguous: false, refetch: vi.fn() }),
    useMoverStats: () => ({ data: null }),
    useEarningsToday: () => ({ data: { total: 0 } }),
    useDailyEarnings: () => ({ data: [] }),
    useDemand: () => ({ data: fx.demand }),
    useAvailableJobs: () => ({ data: fx.jobs }),
    useDispatchOffers: () => ({ offer: null, queuedBehind: 0, dismiss: vi.fn() }),
    useActiveJob: () => ({ data: fx.active, refetch: vi.fn() }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useGoOnline: () => ({ ...mutation(), mutateAsync: fx.goOnline }),
    useGoOffline: mutation, useAcceptJob: mutation, useAcceptOffer: mutation, useDeclineOffer: mutation, useSelectMoverKind: mutation,
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
vi.mock('../RelayTasks', () => ({ RelayTasks: () => null }));
// [RINGER #1782] Once the offer card rings, its ring is unit-tested on its own; this file never draws an offer.
vi.mock('../../../hooks/useJobRing', () => ({ useJobRing: () => undefined }));
vi.mock('../../../hooks/mover', () => ({ useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));

import { MoverHomeScreen } from './MoverHomeScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const text = () => host.textContent ?? '';
const demandMarkers = () => Array.from(host.querySelectorAll('[data-marker="demand"]')) as HTMLElement[];

/** The driver demand payload as GET /driver/demand sends it: rounded points + clusters. */
const DRIVER_DEMAND = {
  waiting: 3,
  points: [{ lat: 6.812, lng: -58.151 }, { lat: 6.815, lng: -58.149 }, { lat: 6.815, lng: -58.149 }],
  clusters: [{ lat: 6.815, lng: -58.149, count: 2 }],
};

async function draw() {
  await act(async () => root.render(React.createElement(MoverHomeScreen, { navigation: { navigate: vi.fn() } })));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
async function tap(el: HTMLElement | undefined) {
  expect(el, 'the marker is on the map').toBeTruthy();
  await act(async () => { el!.click(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.kind = 'DRIVER';
  fx.online = true;
  fx.demand = DRIVER_DEMAND;
  fx.jobs = [];
  fx.active = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('online, nothing on the open board', () => {
  it('a waiting dot and an "N waiting" cluster both explain how the work arrives (no dead tap)', async () => {
    await draw();
    const markers = demandMarkers();
    expect(markers).toHaveLength(4); // 3 rounded points + the one cluster of 2
    expect(markers.every((m) => m.getAttribute('data-tappable') === 'true')).toBe(true);
    await tap(markers[0]);
    expect(fx.toast.show).toHaveBeenCalledWith(
      'Requests come to you as offers',
      'Swift offers each ride request near you to an available driver. Stay online: when one is offered to you, it shows on this screen.',
    );
    await tap(markers[3]);
    expect(fx.toast.show).toHaveBeenCalledTimes(2);
    expect(fx.snapToIndex).not.toHaveBeenCalled();
  });

  it('the empty board says the same in words, under the demand line', async () => {
    await draw();
    expect(text()).toContain('3 people waiting for a ride nearby');
    expect(text()).toContain('Requests reach you as offers on this screen. Stay online.');
  });
});

describe('online, with jobs on the open board', () => {
  it('a tap on demand opens the sheet onto the board — the real list of jobs with Accept', async () => {
    fx.jobs = [{ id: 'ride-1', pickupAddress: 'Bourda Market', dropoffAddress: 'Kitty', fareTotal: 1800, paymentMethod: 'CASH' }];
    await draw();
    expect(text()).toContain('Available jobs');
    await tap(demandMarkers()[3]);
    expect(fx.snapToIndex).toHaveBeenCalledWith(1);
    expect(fx.toast.show).not.toHaveBeenCalled();
  });
});

describe('offline', () => {
  it('points at GO, and a map tap never switches the mover online by itself', async () => {
    fx.online = false;
    await draw();
    await tap(demandMarkers()[0]);
    expect(fx.toast.show).toHaveBeenCalledWith('Go online to take requests', "Tap GO. Once you're online, Swift can offer you a ride request near you on this screen.");
    expect(fx.goOnline).not.toHaveBeenCalled();
  });
});

describe('on a job', () => {
  it('the demand stays on the map but is not offered as a tap', async () => {
    fx.active = { id: 'ride-9', status: 'DRIVER_EN_ROUTE', totalAmount: 1800 };
    await draw();
    const markers = demandMarkers();
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.every((m) => m.getAttribute('data-tappable') === 'false')).toBe(true);
  });
});

describe('what a tap says is never a customer or a place', () => {
  it('no address, coordinate or name appears in any answer', async () => {
    await draw();
    for (const m of demandMarkers()) await tap(m);
    fx.online = false;
    await draw();
    for (const m of demandMarkers()) await tap(m);
    for (const [title, body] of fx.toast.show.mock.calls) {
      expect(`${title} ${body}`).not.toMatch(/\d+\.\d+|street|market|road|avenue/i);
    }
  });
});
