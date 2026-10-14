/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [GO-RELIABILITY] The REAL driver home screen next to the REAL app-root
// location hook (App.tsx's useDeviceLocation()), store, coordinator, resolver
// and GPS fallback. Only the device and the server are faked, the way Android
// behaves:
//  - expo-location's permission request always opens the system permission
//    screen, even when access is already granted (the "flash");
//  - leaving the app pauses it, which React Native reports as 'background';
//  - on return, React Native reports 'active' BEFORE it delivers the
//    permission result (ReactActivityDelegate.onResume);
//  - asking for "Allow all the time" opens Android Settings;
//  - every native call answers one hop later.
// ---------------------------------------------------------------------------

type Answer = { resolve: (fix: unknown) => void; reject: (error: unknown) => void };

const nat = vi.hoisted(() => ({
  appState: 'active',
  listeners: new Set<(next: string) => void>(),
  foreground: 'granted',
  background: 'granted',
  /** What the person picks on the Settings page. */
  settingsChoice: { foreground: 'granted', background: 'granted' },
  /** 'fix': answers after a hop; 'none': no fused fix (null → rejected); 'manual': the test answers. */
  balancedMode: 'fix' as 'fix' | 'none' | 'manual',
  gpsMode: 'none' as 'fix' | 'none' | 'manual',
  balanced: [] as Answer[],
  gps: [] as Answer[],
  lastKnown: null as unknown,
  log: [] as string[],
}));

const fx = vi.hoisted(() => ({
  goOnline: vi.fn(),
  disclose: vi.fn(),
}));

const hop = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
const NETWORK_FIX = { latitude: 6.8105, longitude: -58.1505 };
const GPS_FIX = { latitude: 6.8121, longitude: -58.1517 };
const fixOf = (at: { latitude: number; longitude: number }) => ({
  coords: { ...at, accuracy: 5 },
  timestamp: Date.now(),
});

function emitAppState(next: string) {
  nat.appState = next;
  nat.log.push(`appState:${next}`);
  for (const listener of [...nat.listeners]) listener(next);
}

function positionRequest(queue: Answer[], mode: 'fix' | 'none' | 'manual', at: { latitude: number; longitude: number }) {
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject });
    if (mode === 'fix') void hop().then(() => resolve(fixOf(at)));
    if (mode === 'none') void hop().then(() => reject(new Error('Current location is unavailable')));
  });
}

vi.mock('expo-location', () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  getForegroundPermissionsAsync: vi.fn(async () => {
    nat.log.push('check:foreground');
    await hop();
    return { status: nat.foreground };
  }),
  requestForegroundPermissionsAsync: vi.fn(async () => {
    nat.log.push('request:foreground');
    await hop();
    emitAppState('background');
    await hop();
    emitAppState('active');
    return { status: nat.foreground };
  }),
  getBackgroundPermissionsAsync: vi.fn(async () => {
    await hop();
    return { status: nat.background };
  }),
  requestBackgroundPermissionsAsync: vi.fn(async () => {
    nat.log.push('request:background');
    await hop();
    emitAppState('background');
    nat.foreground = nat.settingsChoice.foreground;
    nat.background = nat.settingsChoice.background;
    await hop();
    emitAppState('active');
    return { status: nat.background };
  }),
  getCurrentPositionAsync: vi.fn((options: { accuracy?: number }) => (options?.accuracy === 4
    ? positionRequest(nat.gps, nat.gpsMode, GPS_FIX)
    : positionRequest(nat.balanced, nat.balancedMode, NETWORK_FIX))),
  getLastKnownPositionAsync: vi.fn(async () => {
    await hop();
    return nat.lastKnown;
  }),
  reverseGeocodeAsync: vi.fn(async () => {
    await hop();
    return [{ name: 'Regent Street', city: 'Georgetown' }];
  }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const AppState = {
    get currentState() {
      return nat.appState;
    },
    addEventListener: (_type: string, listener: (next: string) => void) => {
      nat.listeners.add(listener);
      return { remove: () => nat.listeners.delete(listener) };
    },
  };
  return { View, Pressable, Text: View, AppState, StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 }, Platform: { OS: 'android' } };
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
  const T = (p: any) => h('span', null, p.children);
  return {
    T, Screen: (p: any) => h('div', null, p.children), ErrorState: () => null, LoadingBlock: () => null, Pictogram: () => null,
    TonePill: (p: any) => h('span', null, p.label), cardShadow: {},
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
// The server: GO's mutation is a spy; everything else is a quiet, offline driver.
vi.mock('../../../hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useMoverKind: () => ({ kind: 'DRIVER', profile: { isOnline: false }, loading: false, error: null, ambiguous: false, refetch: vi.fn() }),
    useMoverStats: () => ({ data: null }),
    useEarningsToday: () => ({ data: { total: 0 } }),
    useDailyEarnings: () => ({ data: [] }),
    useDemand: () => ({ data: {} }),
    useAvailableJobs: () => ({ data: [] }),
    useDispatchOffers: () => ({ offer: null, queuedBehind: 0, dismiss: vi.fn() }),
    useActiveJob: () => ({ data: null }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useGoOnline: () => ({ mutate: vi.fn(), mutateAsync: fx.goOnline, isPending: false, error: null }),
    useGoOffline: mutation, useAcceptJob: mutation, useAcceptOffer: mutation, useDeclineOffer: mutation, useSelectMoverKind: mutation,
    useVerificationStatus: () => ({ data: null }),
  };
});
// The persisted store's disk; the store itself is real.
vi.mock('../../../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
vi.mock('../../../stores/authStore', () => ({ requireAuthSessionSnapshot: vi.fn() }));
// The service's own body, minus the native task module it loads first.
vi.mock('../../../services/backgroundLocation', async () => {
  const { requestUsableMoverBackgroundPermission } = await import('../../../lib/moverLocation');
  const Location = await import('expo-location');
  return {
    requestMoverBackgroundPermission: (disclose: () => Promise<boolean>) => requestUsableMoverBackgroundPermission({
      taskManagerAvailable: true,
      getForegroundPermission: Location.getForegroundPermissionsAsync,
      getBackgroundPermission: Location.getBackgroundPermissionsAsync,
      requestBackgroundPermission: Location.requestBackgroundPermissionsAsync,
      disclose,
    }),
  };
});
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('./MoverHomeAccountButton', () => ({ MoverHomeAccountButton: () => null }));
vi.mock('./BackgroundLocationDisclosure', () => ({ useBackgroundLocationDisclosure: () => ({ disclosure: null, disclose: fx.disclose }) }));
vi.mock('../../../hooks/mover', () => ({ useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));

import { useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { useLocationStore } from '../../../stores/locationStore';
import { toast } from '../../../kit/toast';
import { MoverHomeScreen } from './MoverHomeScreen';

const LOCATION_ERROR = 'Couldn’t get your location. Try again.';

/** App.tsx: the root silent location refresh, with the driver home under it. */
function App() {
  useDeviceLocation();
  return React.createElement(MoverHomeScreen, { navigation: { navigate: vi.fn() } });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const text = () => host.textContent ?? '';

async function launch() {
  await act(async () => root.render(React.createElement(App)));
  await vi.waitFor(() => expect(useLocationStore.getState().status).toBe('granted'));
  // Only what the GO tap does is counted from here.
  nat.log.length = 0;
  nat.balanced.length = 0;
  nat.gps.length = 0;
}

async function tapGo() {
  const go = Array.from(host.querySelectorAll('[role="button"]')).find((element) => element.textContent === 'GO');
  expect(go, 'the GO ring is on screen').toBeTruthy();
  await act(async () => {
    (go as HTMLElement).click();
  });
}

/** GO's outcome: online, or a toast. */
async function goSettles() {
  await act(async () => {
    await vi.waitFor(() => {
      expect(fx.goOnline.mock.calls.length + vi.mocked(toast.error).mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 2_000 });
  });
}

/** The i-th pending native request (the test has already waited for it). */
function nth<T>(list: T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no request #${index}`);
  return item;
}

const until = (predicate: () => boolean) => act(async () => {
  await vi.waitFor(() => expect(predicate()).toBe(true));
});
const flush = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await hop();
});

beforeEach(() => {
  vi.clearAllMocks();
  fx.goOnline.mockResolvedValue({});
  fx.disclose.mockResolvedValue(true);
  Object.assign(nat, {
    appState: 'active',
    foreground: 'granted',
    background: 'granted',
    settingsChoice: { foreground: 'granted', background: 'granted' },
    balancedMode: 'fix',
    gpsMode: 'none',
    balanced: [],
    gps: [],
    lastKnown: null,
    log: [],
  });
  nat.listeners.clear();
  useLocationStore.setState({ latitude: null, longitude: null, address: null, status: 'unknown' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[GO-RELIABILITY] GO with location granted goes online; it never fails fast', () => {
  it('every permission already granted: the permission screen flash resumes the app, and GO waits for that re-check and goes online', async () => {
    await launch();
    await tapGo();
    await goSettles();

    // The race really ran: the resume re-check started while GO's own check was in flight.
    expect(nat.log.slice(0, 4)).toEqual(['request:foreground', 'appState:background', 'appState:active', 'check:foreground']);
    expect(toast.error).not.toHaveBeenCalled();
    expect(fx.goOnline).toHaveBeenCalledOnce();
    expect(fx.goOnline).toHaveBeenCalledWith(expect.objectContaining(NETWORK_FIX));
  });

  it('no fresh fused fix after the permission request: GO shows "Finding your location…" and goes online on the GPS fix', async () => {
    await launch();
    nat.balancedMode = 'none';
    nat.gpsMode = 'manual';

    await tapGo();
    await until(() => nat.gps.length === 2);
    // GO's own check (one hop ahead) gets its GPS fix first, and is superseded.
    nth(nat.gps, 0).resolve(fixOf(GPS_FIX));
    await flush();

    expect(toast.error).not.toHaveBeenCalled();
    expect(fx.goOnline).not.toHaveBeenCalled();
    expect(text()).toContain('Finding your location…');

    // The newer re-check's GPS fix arrives: online.
    nth(nat.gps, 1).resolve(fixOf(GPS_FIX));
    await goSettles();
    expect(toast.error).not.toHaveBeenCalled();
    expect(fx.goOnline).toHaveBeenCalledWith(expect.objectContaining(GPS_FIX));
  });

  it('the Settings round trip: "Allow all the time" in Android Settings, back to Swift, and GO re-reads the permission and goes online', async () => {
    nat.background = 'denied';
    await launch();
    nat.balancedMode = 'manual';

    await tapGo();
    await until(() => nat.balanced.length === 2);
    // This tap's first check wins the race (the newer re-check answers first),
    // so GO reaches the disclosure and Settings, as on the emulator.
    nat.balancedMode = 'fix';
    nth(nat.balanced, 1).resolve(fixOf(NETWORK_FIX));
    nth(nat.balanced, 0).resolve(fixOf(NETWORK_FIX));
    await goSettles();

    expect(fx.disclose).toHaveBeenCalledOnce();
    const trip = nat.log.indexOf('request:background');
    expect(trip).toBeGreaterThan(-1);
    // Coming back re-read the permission...
    expect(nat.log.slice(trip)).toContain('check:foreground');
    // ...and GO continued on it.
    expect(toast.error).not.toHaveBeenCalled();
    expect(fx.goOnline).toHaveBeenCalledOnce();
    expect(fx.goOnline).toHaveBeenCalledWith(expect.objectContaining(NETWORK_FIX));
  });
});

describe('[GO-RELIABILITY] waiting never weakens a refusal', () => {
  it('location switched off for Swift in Settings: the re-check refuses, and GO never goes online', async () => {
    nat.background = 'denied';
    nat.settingsChoice = { foreground: 'denied', background: 'denied' };
    await launch();
    nat.balancedMode = 'manual';

    await tapGo();
    await until(() => nat.balanced.length === 2);
    nat.balancedMode = 'fix';
    nth(nat.balanced, 1).resolve(fixOf(NETWORK_FIX));
    nth(nat.balanced, 0).resolve(fixOf(NETWORK_FIX));
    await goSettles();

    expect(fx.goOnline).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(LOCATION_ERROR);
    expect(useLocationStore.getState().status).toBe('denied');
  });

  it('the re-check finds no fix in the GPS budget: GO refuses; the old map centre and a stale cached fix are never sent', async () => {
    await launch();
    const mapCentre = { latitude: useLocationStore.getState().latitude, longitude: useLocationStore.getState().longitude };
    nat.balancedMode = 'none';
    nat.gpsMode = 'manual';
    nat.lastKnown = { coords: { latitude: 6.79, longitude: -58.16, accuracy: 5 }, timestamp: Date.now() - 3 * 60_000 };

    await tapGo();
    await until(() => nat.gps.length === 2);
    nth(nat.gps, 0).resolve(fixOf(GPS_FIX));
    nth(nat.gps, 1).reject(new Error('No high-accuracy fix within the budget'));
    await goSettles();

    expect(fx.goOnline).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(LOCATION_ERROR);
    expect(useLocationStore.getState().status).toBe('unavailable');
    // The persisted map centre is still there, as context only.
    expect(useLocationStore.getState()).toMatchObject(mapCentre);
  });
});
