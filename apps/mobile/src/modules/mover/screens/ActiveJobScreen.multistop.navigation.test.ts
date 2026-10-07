/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { RIDE_STOPS_PENDING, WAITING_LIVE, driverRideWithStops, riderRideWithoutStops } from '../../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 7 · waiting charge] The REAL driver ActiveJobScreen,
// drawn by a real React renderer, fed the driver's active ride exactly as
// CONTRACT.md Rev 2 §6.3/§8.3 prints it. The hooks are fakes that hand over
// that payload and record the actions; native drawing and the OS openers are
// stand-ins. Asserted: the stops in order with the current one highlighted,
// Navigate per stop to the platform's own maps, the part-4 stop actions only
// when the server shows it has them, the part-3 fare guard, and the live wait.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  job: null as any,
  platform: { OS: 'ios' as string },
  openURL: vi.fn(async (_url: string) => true),
  openExternal: vi.fn(async () => true),
  stopAction: { mutate: vi.fn(), isPending: false },
  driverAct: { mutate: vi.fn(), isPending: false, isError: false },
  navigate: vi.fn(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({
    'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole,
    'aria-selected': p.accessibilityState?.selected,
  });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
    Platform: fx.platform,
    Linking: { openURL: (url: string) => fx.openURL(url) },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    __esModule: true,
    default: (p: any) => h('div', { 'data-map': '' }, p.children),
    Marker: (p: any) => h('div', { 'data-marker': p.title ?? '' }),
    Polyline: (p: any) => h('div', { 'data-polyline': JSON.stringify(p.coordinates) }),
    PROVIDER_DEFAULT: 'default',
  };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('section', null, p.children), BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn() }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', a11y(p), p.children);
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Eyebrow: T, PopupTitle: T, Screen: Box, DecorativeIcon: Box,
    PillButton: (p: any) => h('button', { type: 'button', 'data-testid': p.testID, 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    EmptyState: (p: any) => h('div', null, p.title),
    StatusRail: () => null, LockIn: (p: any) => h('div', null, p.label), CodeInput: () => null, TonePill: (p: any) => h('span', null, p.label),
    cardShadow: {}, lockInButtonStyle: () => ({}),
  };
});
vi.mock('../../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks', () => ({
  useMoverKind: () => ({ kind: 'DRIVER' }),
  useActiveJob: () => ({ data: fx.job, refetch: vi.fn(), isFetching: false }),
  useActiveJobs: () => ({ legs: fx.job ? [fx.job] : [], run: null }),
  useDriverAction: () => fx.driverAct,
  useRiderAction: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRateCustomer: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierProof: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierCollect: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierPickupProof: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierReturn: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierReturnProof: () => ({ mutate: vi.fn(), isPending: false }),
  useRideSos: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../hooks/mover', () => ({ uploadHandoverPhoto: vi.fn(), useTaxiStopAction: () => fx.stopAction }));
vi.mock('../../safety/SosCeremony', () => ({ SosCeremony: () => null }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }) }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: fx.openExternal }));
vi.mock('../../../services/emergencyPolicy', () => ({ currentMarketDial: () => ({ kind: 'manual' }), emergencyDialCopy: () => '', previewEmergencyDial: () => null }));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (select: (s: { countryCode: string }) => unknown) => select({ countryCode: 'GY' }),
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionForPrincipal: vi.fn(),
  requireAuthSessionSnapshot: vi.fn(),
}));

import { ActiveJobScreen } from './ActiveJobScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigation = { navigate: fx.navigate, goBack: vi.fn() };
const snap = (name: string) => (globalThis as { __msCapture?: (n: string, html: string) => void }).__msCapture?.(name, host.innerHTML);

async function render(job: unknown) {
  fx.job = job;
  await act(async () => root.render(React.createElement(ActiveJobScreen, { navigation })));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const text = () => host.textContent ?? '';
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;
async function click(el: Element | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.platform.OS = 'ios';
  fx.openURL.mockImplementation(async () => true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('flag off — a ride without stops is exactly today’s trip', () => {
  it('no stops list, no stop actions, no per-stop Navigate; the fare step is today’s', async () => {
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' }, paymentMethod: 'CASH' }));
    snap('driver-active-trip-flag-off');
    expect(byTestId('driver-itinerary')).toBeNull();
    expect(byTestId('driver-stop-actions')).toBeNull();
    expect(byTestId('driver-stops-readonly')).toBeNull();
    expect(host.querySelector('[data-testid^="driver-navigate-"]')).toBeNull();
    expect(host.querySelector('[data-marker^="Stop "]')).toBeNull();
    expect(buttonNamed('Fare collected — complete trip')).toBeTruthy();
    expect(text()).toContain('Navigate to drop-off');
  });
});

describe('a trip with stops (part 3 server: the stops are read-only)', () => {
  it('lists pickup, every stop and the drop-off in order, the next stop highlighted', async () => {
    await render(driverRideWithStops());
    snap('driver-active-trip-two-stops-readonly');
    const rows = Array.from(host.querySelectorAll('[data-testid^="driver-itinerary-"]')).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['driver-itinerary-pickup', 'driver-itinerary-stop-1', 'driver-itinerary-stop-2', 'driver-itinerary-dropoff']);
    expect(byTestId('driver-itinerary-stop-1')?.getAttribute('aria-selected')).toBe('true');
    expect(byTestId('driver-itinerary-stop-2')?.getAttribute('aria-selected')).toBe('false');
    expect(byTestId('driver-itinerary-stop-1')?.textContent).toContain('Camp Street');
    expect(text()).toContain('2 STOPS · ONE FARE FOR THE WHOLE TRIP');
    // The trip heads for the next stop, one leg at a time.
    expect(text()).toContain('Navigate to stop 1');
    expect(host.querySelectorAll('[data-marker^="Stop "]')).toHaveLength(2);
  });

  it('without the part-4 signal there are no stop buttons, and no fare button while a stop is open', async () => {
    await render(driverRideWithStops());
    expect(byTestId('driver-stop-actions')).toBeNull();
    expect(byTestId('driver-stops-readonly')).toBeTruthy();
    expect(buttonNamed('Fare collected — complete trip')).toBeNull();
    await click(buttonNamed('Contact support'));
    expect(fx.navigate).toHaveBeenCalledWith('GetHelp');
  });

  it('once every stop is done the fare step is back and the drop-off is the place highlighted', async () => {
    await render(driverRideWithStops({
      nextStopSequence: null,
      stops: RIDE_STOPS_PENDING.map((s) => ({ ...s, status: 'DEPARTED' })),
    }));
    expect(buttonNamed('Fare collected — complete trip')).toBeTruthy();
    expect(byTestId('driver-itinerary-dropoff')?.getAttribute('aria-selected')).toBe('true');
    expect(text()).toContain('Navigate to drop-off');
  });
});

describe('Navigate opens the phone’s own maps at that stop', () => {
  it('Apple Maps on iOS', async () => {
    fx.platform.OS = 'ios';
    await render(driverRideWithStops());
    await click(byTestId('driver-navigate-stop-2'));
    expect(fx.openURL).toHaveBeenCalledWith('maps://?daddr=6.825,-58.15');
  });

  it('Google Maps on Android', async () => {
    fx.platform.OS = 'android';
    await render(driverRideWithStops());
    await click(byTestId('driver-navigate-stop-1'));
    expect(fx.openURL).toHaveBeenCalledWith('google.navigation:q=6.8143,-58.1443');
  });

  it('falls back to the web map when the maps app will not open', async () => {
    fx.platform.OS = 'android';
    fx.openURL.mockImplementation(async () => { throw new Error('no app'); });
    await render(driverRideWithStops());
    await click(byTestId('driver-navigate-stop-1'));
    expect(fx.openExternal).toHaveBeenCalledWith('https://www.google.com/maps/dir/?api=1&destination=6.8143,-58.1443', expect.any(String));
  });
});

describe('[review 6] the primary Navigate controls open the platform’s own maps', () => {
  const pill = () => Array.from(host.querySelectorAll('[role="button"]')).find((e) => /km · ~\d+ min/.test(e.textContent ?? '')) ?? null;
  const link = (label: string) => host.querySelector(`[aria-label="${label}"]`);

  it('Android, a ride without stops: the Navigate link and the nav pill open Google Maps at the drop-off', async () => {
    fx.platform.OS = 'android';
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' }, paymentMethod: 'CASH' }));
    await click(link('Navigate to drop-off'));
    expect(fx.openURL).toHaveBeenLastCalledWith('google.navigation:q=6.82,-58.16');
    await click(pill());
    expect(fx.openURL).toHaveBeenLastCalledWith('google.navigation:q=6.82,-58.16');
    expect(fx.openURL).not.toHaveBeenCalledWith(expect.stringMatching(/^maps:/));
  });

  it('Android, a ride with stops: they head for the next stop', async () => {
    fx.platform.OS = 'android';
    await render(driverRideWithStops());
    await click(link('Navigate to stop 1'));
    expect(fx.openURL).toHaveBeenLastCalledWith('google.navigation:q=6.8143,-58.1443');
  });

  it('iOS: Apple Maps', async () => {
    fx.platform.OS = 'ios';
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' }, paymentMethod: 'CASH' }));
    await click(link('Navigate to drop-off'));
    expect(fx.openURL).toHaveBeenLastCalledWith('maps://?daddr=6.82,-58.16');
  });
});

describe('[review 7] with a stop open, ending for a missing passenger waits for the server’s grace', () => {
  const graceAt = Date.parse('2026-10-01T21:10:00.000Z');
  const atStop1 = () => driverRideWithStops({
    stopWait: { sequence: 1, arrivedAt: '2026-10-01T21:00:00.000Z', noShowAvailableAt: '2026-10-01T21:10:00.000Z' },
    stops: [{ ...RIDE_STOPS_PENDING[0], status: 'ARRIVED' }, { ...RIDE_STOPS_PENDING[1] }],
  });

  it('before noShowAvailableAt: no unpaid or no-show control at all', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(graceAt - 60_000);
    await render(atStop1());
    expect(buttonNamed("Passenger didn't come back")).toBeNull();
    expect(buttonNamed("Passenger didn't pay")).toBeNull();
  });

  it('after it: "Passenger didn\'t come back" offers only the no-show outcome', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(graceAt + 1_000);
    await render(atStop1());
    await click(buttonNamed("Passenger didn't come back"));
    expect(buttonNamed('Refused to pay')).toBeNull();
    await click(buttonNamed('Left without paying'));
    expect(fx.driverAct.mutate).toHaveBeenCalledWith(expect.objectContaining({ id: 'cm-ride-4', action: 'handover', outcome: 'no_show' }), expect.anything());
  });

  it('the control appears on its own when the grace time passes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(graceAt - 2_000);
    fx.job = atStop1();
    await act(async () => root.render(React.createElement(ActiveJobScreen, { navigation })));
    expect(buttonNamed("Passenger didn't come back")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(buttonNamed("Passenger didn't come back")).toBeTruthy();
  });

  it('a part-3 server (no stopWait) never offers it while a stop is open', async () => {
    await render(driverRideWithStops());
    expect(buttonNamed("Passenger didn't come back")).toBeNull();
    expect(buttonNamed("Passenger didn't pay")).toBeNull();
  });

  it('a ride without stops keeps today’s "Passenger didn\'t pay" with both outcomes', async () => {
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' }, paymentMethod: 'CASH' }));
    await click(buttonNamed("Passenger didn't pay"));
    expect(buttonNamed('Refused to pay')).toBeTruthy();
    expect(buttonNamed('Left without paying')).toBeTruthy();
  });
});

describe('[review 2] without the waiting fields, the driver’s flag-off trip is main’s, byte for byte', () => {
  it.each([
    ['at the pickup', 'driver-active-arrived', { status: 'DRIVER_ARRIVED', ridePinVerified: false }],
    ['on the trip', 'driver-active-riding', {}],
  ])('%s', async (_label, file, overrides) => {
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' }, paymentMethod: 'CASH', ...overrides }));
    await expect(host.innerHTML).toMatchFileSnapshot(`./__flagoff__/${file}.html`);
  });
});

describe('the part-4 stop actions, only with the capability', () => {
  it('"Arrived at stop 1" sends the contract’s action', async () => {
    await render(driverRideWithStops({ stopWait: null }));
    snap('driver-active-trip-stop-actions');
    expect(buttonNamed('Fare collected — complete trip')).toBeNull();
    await click(byTestId('driver-stop-arrived-1'));
    expect(fx.stopAction.mutate).toHaveBeenCalledWith({ id: 'cm-ride-4', sequence: 1, action: 'arrived' }, expect.anything());
  });

  it('at the stop: "Done at stop 1", and a skip carries the driver’s reason', async () => {
    await render(driverRideWithStops({
      stopWait: { sequence: 1, arrivedAt: '2026-10-01T21:00:00.000Z', noShowAvailableAt: '2026-10-01T21:10:00.000Z' },
      stops: [{ ...RIDE_STOPS_PENDING[0], status: 'ARRIVED' }, { ...RIDE_STOPS_PENDING[1] }],
    }));
    expect(text()).toContain('Waiting at stop 1.');
    await click(byTestId('driver-stop-depart-1'));
    expect(fx.stopAction.mutate).toHaveBeenLastCalledWith({ id: 'cm-ride-4', sequence: 1, action: 'depart' }, expect.anything());
    await click(byTestId('driver-stop-skip-1'));
    await click(buttonNamed('Road or access blocked'));
    expect(fx.stopAction.mutate).toHaveBeenLastCalledWith({ id: 'cm-ride-4', sequence: 1, action: 'skip', reason: 'Road or access blocked' }, expect.anything());
  });
});

describe('the live wait on the driver’s trip (Rev 2 §8.3)', () => {
  it('shows the minutes, the server’s charge and the countdown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(WAITING_LIVE.nextChargeAt) - 390_000);
    await render(riderRideWithoutStops({ status: 'DRIVER_ARRIVED', ridePinVerified: false, customer: { firstName: 'Asha' }, waiting: WAITING_LIVE }));
    snap('driver-active-trip-waiting');
    const card = byTestId('driver-waiting');
    expect(card?.textContent).toContain('13 min waited');
    expect(card?.textContent).toMatch(/\$500 so far/);
    expect(card?.textContent).toMatch(/Next \$500 in 6:30/);
  });

  it('at the end, the trip fare and the waiting are itemised — never added on the phone', async () => {
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' }, waiting: { ...WAITING_LIVE, running: false, nextChargeAt: null } }));
    expect(byTestId('driver-waiting')?.textContent).toMatch(/Collect in cash: trip fare \$2.?400 and waiting \$500\./);
    expect(text()).not.toMatch(/\$2.?900/);
  });

  it('nothing without the server’s waiting object', async () => {
    await render(riderRideWithoutStops({ customer: { firstName: 'Asha' } }));
    expect(byTestId('driver-waiting')).toBeNull();
  });
});
