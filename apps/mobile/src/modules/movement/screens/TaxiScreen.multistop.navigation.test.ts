/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CAMP_STREET,
  ESTIMATE_WITHOUT_STOPS,
  ESTIMATE_WITH_ONE_STOP,
  FARE_BREAKDOWN,
  REQUEST_ANSWER_WITH_ONE_STOP,
  REQUEST_BODY_WITH_ONE_STOP,
  SHERIFF_STREET,
  WAITING_LIVE,
  WAITING_TERMS,
  riderRideWithStops,
  riderRideWithoutStops,
} from '../../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6 · waiting charge] The REAL TaxiScreen, drawn by a
// real React renderer: the real ride hooks, the real API client and its real
// Axios instance (answered by a capturing adapter that speaks CONTRACT.md Rev 2),
// the real idempotency attempt over a stand-in storage. Only native drawing
// (views, maps, the sheet), the socket transport, the device location and
// storage are stand-ins. Every assertion reads what the passenger sees or what
// went on the wire.
// ---------------------------------------------------------------------------

type Reply = { status: number; data?: unknown; network?: boolean };
type Handler = (config: InternalAxiosRequestConfig) => Reply;

const fx = vi.hoisted(() => {
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  const socketHandlers = new Map<string, Set<(payload: unknown) => void>>();
  /** React Native style → DOM style, enough to read a render capture. */
  const css = (style: unknown): Record<string, unknown> | undefined => {
    const flat: Record<string, unknown> = {};
    const walk = (s: unknown) => { if (Array.isArray(s)) s.forEach(walk); else if (s && typeof s === 'object') Object.assign(flat, s); };
    walk(style);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(flat)) {
      if (v == null || typeof v === 'object') continue;
      if (k === 'paddingHorizontal') { out['paddingLeft'] = v; out['paddingRight'] = v; continue; }
      if (k === 'paddingVertical') { out['paddingTop'] = v; out['paddingBottom'] = v; continue; }
      if (k === 'marginHorizontal') { out['marginLeft'] = v; out['marginRight'] = v; continue; }
      if (k === 'marginVertical') { out['marginTop'] = v; out['marginBottom'] = v; continue; }
      if (/^(shadow|elevation)/.test(k)) continue;
      out[k] = v;
      if (k === 'borderWidth' || k === 'borderTopWidth') out['borderStyle'] = 'solid';
    }
    return Object.keys(out).length ? out : undefined;
  };
  return {
    css,
    routes: {} as Record<string, (config: any) => { status: number; data?: unknown; network?: boolean }>,
    seen: [] as any[],
    storage: new Map<string, string>(),
    navigate: vi.fn(),
    socketHandlers,
    socket: {
      on: (event: string, fn: (payload: unknown) => void) => { if (!socketHandlers.has(event)) socketHandlers.set(event, new Set()); socketHandlers.get(event)!.add(fn); },
      off: (event: string, fn: (payload: unknown) => void) => { socketHandlers.get(event)?.delete(fn); },
      emit: () => undefined,
      connected: true,
    },
    fire: (event: string, payload: unknown) => { for (const fn of [...(socketHandlers.get(event) ?? [])]) fn(payload); },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({
    'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole,
    'aria-selected': p.accessibilityState?.selected, 'aria-disabled': p.accessibilityState?.disabled ?? p.disabled,
  });
  const View = (p: any) => h('div', { ...a11y(p), style: fx.css(p.style) }, p.children);
  const Text = (p: any) => h('span', { ...a11y(p), style: fx.css(p.style) }, p.children);
  const Pressable = (p: any) => h('div', {
    ...a11y(p), role: p.accessibilityRole ?? 'button', style: fx.css(typeof p.style === 'function' ? p.style({ pressed: false }) : p.style),
    onClick: p.disabled ? undefined : p.onPress,
  }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Text, Pressable, ScrollView: View, Image: View, ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    TurboModuleRegistry: { get: () => null },
    Share: { share: vi.fn(async () => ({})) },
    Linking: { openURL: vi.fn(async () => true) },
    useColorScheme: () => 'light',
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    AppState: { addEventListener: () => ({ remove() {} }), currentState: 'active' },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const h = R.createElement;
  const MapView = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ animateToRegion() {}, fitToCoordinates() {} }));
    return h('div', { 'data-map': '' }, p.children);
  });
  const Marker = (p: any) => h('div', { 'data-marker': p.title ?? '' }, p.children);
  return { __esModule: true, default: MapView, Marker, MarkerAnimated: Marker, PROVIDER_DEFAULT: 'default', Polyline: () => null };
});
vi.mock('react-native-reanimated', () => ({ __esModule: true, default: { createAnimatedComponent: (c: unknown) => c } }));
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  const Sheet = R.forwardRef((p: any, _ref: any) => R.createElement('section', null, p.children));
  return { __esModule: true, default: Sheet, BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const { money } = await import('../../../lib/money');
  const { color } = await import('@swift/ui');
  const SIZE: Record<string, number> = { displayXl: 30, display: 26, title: 20, heading: 17, body: 15, bodyStrong: 15, label: 14, caption: 13, micro: 11 };
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', { ...a11y(p), style: fx.css([{ display: 'flex', flexDirection: 'column', background: color.surface.base, borderRadius: 16, padding: 16 }, p.style]) }, p.children);
  const T = (p: any) => h('span', { ...a11y(p), style: fx.css([{ display: 'block', fontSize: SIZE[p.variant ?? 'body'], fontWeight: p.weight === 'bold' || p.weight === 'semibold' ? 600 : 400 }, p.style]) }, p.children);
  const PillButton = (p: any) => h('button', {
    type: 'button', 'data-testid': p.testID, 'aria-label': p.label, disabled: !!(p.disabled || p.loading),
    onClick: p.disabled || p.loading ? undefined : p.onPress,
    style: { display: 'block', width: '100%', minHeight: 48, borderRadius: 999, marginTop: 8, borderWidth: 1, borderStyle: 'solid', borderColor: color.border.subtle, background: p.variant === 'primary' || !p.variant ? color.brand[500] : color.surface.base, color: p.variant === 'primary' || !p.variant ? color.text.onBrand : color.text.primary },
  }, p.label);
  return {
    T, Eyebrow: T, PopupTitle: T, Card: Box,
    PillButton,
    LabeledInput: (p: any) => h('input', { value: p.value ?? '', readOnly: true }),
    TonePill: (p: any) => h('span', null, p.label),
    Money: (p: any) => h('span', null, money(p.amount)),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, ''),
    StatePill: (p: any) => h('span', { 'data-pill': '', style: { borderWidth: 1, borderStyle: 'solid', borderColor: color.border.subtle, borderRadius: 99, padding: '2px 8px', fontSize: 11 } }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    CalmRadar: (p: any) => h('div', null, p.title),
    EmptyState: (p: any) => h('div', null, p.title),
    LoadingBlock: () => h('div', null, 'Loading'),
    IconChip: () => null, Pictogram: () => null, PinGlyph: () => null, Stars: () => null, VehicleRender: () => null,
    cardShadow: {},
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../kit/map-style', () => ({ rideMapProps: () => ({}) }));
vi.mock('../map/useInterpolatedDriver', () => ({ useInterpolatedDriver: () => ({ hasFix: false, stale: false, animatedProps: {} }) }));
// The real ride hooks, through the real API client; nothing else from the hooks barrel.
vi.mock('../../../hooks', async () => ({
  ...(await vi.importActual<typeof import('../../../hooks/rides')>('../../../hooks/rides')),
  ...(await vi.importActual<typeof import('../../../hooks/courier')>('../../../hooks/courier')),
}));
vi.mock('../../../kit/journey-rail', async () => {
  const R = await import('react');
  return { JourneyRail: (p: any) => R.createElement('div', null, p.start, p.end) };
});
vi.mock('../../../hooks/mover', () => ({ evidenceFix: () => { throw new Error('No mover evidence in a customer quote test'); } }));
vi.mock('../../../hooks/customer', () => ({ customerKeys: { homeAll: ['customer', 'home'] } }));
vi.mock('../../../hooks/useDeviceLocation', () => ({ useDeviceLocation: () => ({ resolve: vi.fn() }) }));
vi.mock('../../../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => fx.socket, subscribeToOrder: vi.fn() }));
// The post-trip sheet has its own render test; here it shows only what it was handed.
vi.mock('../RidePostTripSheet', async () => {
  const R = await import('react');
  return { RidePostTripSheet: (p: any) => (p.ride ? R.createElement('output', { 'data-testid': 'post-trip' }, String(p.ride.fareBreakdown?.total ?? 'no breakdown')) : null) };
});
vi.mock('../../../stores/locationStore', () => ({
  useLocationStore: () => ({ latitude: 6.8013, longitude: -58.1553, address: 'Stabroek Market', status: 'granted' }),
}));
vi.mock('../../../components/LocationPrimerCard', () => ({ LocationPrimerCard: () => null }));
vi.mock('../../../lib/images', () => ({ mediaUrl: (x: unknown) => x }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), commit: vi.fn(), warn: vi.fn(), failure: vi.fn(), select: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../../services/emergencyPolicy', () => ({ currentMarketDial: () => ({ kind: 'manual' }), emergencyDialCopy: () => '', previewEmergencyDial: () => null }));
vi.mock('../taxiEntry', () => ({ signInForTaxi: vi.fn() }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('../../../lib/storage', () => ({
  zustandStorage: {
    getItem: (k: string) => fx.storage.get(k) ?? null,
    setItem: (k: string, v: string) => { fx.storage.set(k, v); },
    removeItem: (k: string) => { fx.storage.delete(k); },
  },
}));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, promptLogin: vi.fn(), countryCode: 'GY', user: { id: 'rider-1', firstName: 'Asha' } };
  const useAuthStore = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ ...state, rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }),
  });
  const session = () => ({ userId: 'rider-1', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' });
  return {
    useAuthStore,
    AuthSessionBoundaryError: class extends Error {},
    getAuthSessionSnapshot: session,
    requireAuthSessionSnapshot: session,
    requireAuthSessionForPrincipal: session,
    isAuthSessionSnapshotCurrent: () => true,
  };
});

import { api } from '../../../services/api';
import { TaxiScreen } from './TaxiScreen';
import { CourierScreen } from './CourierScreen';

const LAMAHA = { lat: 6.82, lng: -58.16, label: 'Lamaha Street' };
const CAMP = { lat: CAMP_STREET.lat, lng: CAMP_STREET.lng, label: CAMP_STREET.address };
const SHERIFF = { lat: SHERIFF_STREET.lat, lng: SHERIFF_STREET.lng, label: SHERIFF_STREET.address };

const ok = (data: unknown, status = 200): Reply => ({ status, data: { success: true, data } });
const refuse = (status: number, code: string, details?: unknown): Reply => ({ status, data: { success: false, error: { code, message: `server words for ${code}`, details } } });
const bodyOf = (config: any) => (config?.data ? JSON.parse(String(config.data)) : undefined);
const sent = (route: string) => fx.seen.filter((c) => `${c.method} ${String(c.url).split('?')[0]}` === route);

/** Quotes like the part-2 engine: one stop → the contract's answer; more → a bigger whole-route fare. */
function quote(config: any): Reply {
  const stops = bodyOf(config)?.stops as unknown[] | undefined;
  if (!stops?.length) return { status: 200, data: ESTIMATE_WITHOUT_STOPS };
  if (stops.length === 1) return { status: 200, data: ESTIMATE_WITH_ONE_STOP };
  const fare = 2800 + 600 * (stops.length - 1);
  return ok({ ...ESTIMATE_WITH_ONE_STOP.data, tiers: [{ rideClass: 'ECONOMY', multiplier: 1, fare, capacity: 4, source: 'formula' }], stopCount: stops.length });
}

const adapter: AxiosAdapter = async (config) => {
  fx.seen.push(config);
  const key = `${config.method} ${String(config.url).split('?')[0]}`;
  const handler: Handler | undefined = fx.routes[key];
  const reply = handler ? handler(config) : refuse(404, 'NOT_FOUND');
  if (reply.network) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
  const response = { config, status: reply.status, statusText: String(reply.status), headers: {}, data: reply.data };
  if (reply.status >= 200 && reply.status < 300) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, reply.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, null, response as never);
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigation = { navigate: fx.navigate, goBack: vi.fn(), isFocused: () => true };

const snap = (name: string) => (globalThis as { __msCapture?: (n: string, html: string) => void }).__msCapture?.(name, host.innerHTML);
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(TaxiScreen, { navigation }))));
  await settle();
}
const text = () => host.textContent ?? '';
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
async function click(el: HTMLElement | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { el!.click(); });
  await settle();
}
/** The search screen hands a picked place back through the route param. */
async function pickFromSearch(open: HTMLElement | null, place: { lat: number; lng: number; label: string }) {
  await click(open);
  const call = fx.navigate.mock.calls.at(-1)!;
  expect(call[0]).toBe('DestinationSearch');
  await act(async () => { (call[1] as { onSelect: (p: unknown) => void }).onSelect(place); });
  await settle();
}
const requestButton = () => Array.from(host.querySelectorAll('button')).find((b) => /^Request /.test(b.textContent ?? '')) as HTMLElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fx.seen.length = 0;
  fx.storage.clear();
  fx.socketHandlers.clear();
  fx.routes = {
    'get /rides/active': () => ok(null),
    'get /rides/capabilities': () => refuse(404, 'NOT_FOUND'),
    'post /rides/estimate': quote,
    'get /rides/availability': () => ok({ level: 'GOOD', nearestEtaMinutes: 3, gate: false }),
    'get /rides/supply': () => ok({ online: 3, busy: 0, level: 'GOOD', nearestEtaMinutes: 3 }),
    'get /rides/presence': () => ok({ cars: [] }),
    'get /rides/queue': () => ok(null),
    'post /rides/request': () => ({ status: 201, data: REQUEST_ANSWER_WITH_ONE_STOP }),
    'get /safety/guardian/checkin': () => ok(null),
  };
  api.defaults.adapter = adapter;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
});

describe('flag off — the booking screen is exactly today’s', () => {
  it.each([
    ['an older server without the capability read (404)', () => refuse(404, 'NOT_FOUND')],
    ['a server with stops switched off (maxStops 0)', () => ok({ maxStops: 0 })],
  ])('%s: no stop control anywhere; today’s bodies; still a key', async (_label, capabilities) => {
    fx.routes['get /rides/capabilities'] = capabilities;
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    snap(`rider-booking-flag-off-${_label.startsWith('an older') ? '404' : 'zero'}`);

    expect(byTestId('taxi-add-stop')).toBeNull();
    expect(host.querySelector('[data-testid^="taxi-stop"]')).toBeNull();
    expect(text()).not.toMatch(/Add a stop|One fare for the whole trip|Your route|stops/);
    expect(text()).toContain('Fare estimate · cash to the driver');

    for (const config of sent('post /rides/estimate')) expect(Object.keys(bodyOf(config))).toEqual(['pickup', 'dropoff']);

    await click(requestButton() ?? null);
    const [request] = sent('post /rides/request');
    expect(Object.keys(bodyOf(request))).toEqual(['pickup', 'dropoff', 'pickupAddress', 'dropoffAddress', 'passengerCount', 'rideClass']);
    expect(request.headers.get('Idempotency-Key')).toMatch(/^ride_[0-9a-z]+_[0-9a-z]{10}$/);
  });
});

describe('flag on — the passenger adds, removes and reorders stops up to the max', () => {
  it('adds up to the max, refuses one more, re-quotes every change, and books one total with the contract’s body', async () => {
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: 2 });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);

    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    await pickFromSearch(byTestId('taxi-add-stop'), SHERIFF);
    snap('rider-booking-two-stops-at-max');
    // At the max the control is gone and the limit is said instead.
    expect(byTestId('taxi-add-stop')).toBeNull();
    expect(text()).toContain('You can add up to 2 stops.');
    expect(bodyOf(sent('post /rides/estimate').at(-1)).stops.map((s: any) => s.address)).toEqual(['Camp Street', 'Sheriff Street']);

    // Reorder: stop 2 moves up — a new quote in the new order.
    await click(byTestId('taxi-stop-up-2'));
    expect(bodyOf(sent('post /rides/estimate').at(-1)).stops.map((s: any) => s.address)).toEqual(['Sheriff Street', 'Camp Street']);
    // Remove the first: one stop left — re-quoted again, and the control is back.
    await click(byTestId('taxi-stop-remove-1'));
    expect(bodyOf(sent('post /rides/estimate').at(-1)).stops).toEqual(REQUEST_BODY_WITH_ONE_STOP.stops);
    expect(byTestId('taxi-add-stop')).toBeTruthy();

    // One fare for the whole trip, said before booking; no per-stop fee.
    expect(text()).toContain('One fare for the whole trip with 1 stop · cash to the driver. No extra fee for stops.');
    expect(text()).toContain('Pickup to stop 1 · 2.5 km');
    expect(requestButton()?.textContent).toMatch(/^Request Car · \$2.?800$/);
    snap('rider-booking-one-stop-quote');

    await click(requestButton() ?? null);
    const [request] = sent('post /rides/request');
    expect(bodyOf(request)).toEqual(REQUEST_BODY_WITH_ONE_STOP);
    expect(request.headers.get('Idempotency-Key')).toMatch(/^ride_/);
  });

  it('holds the request until the quote for the new itinerary lands', async () => {
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: 3 });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    expect(requestButton()?.hasAttribute('disabled')).toBe(false);
    // The quote WITH the stop is slow: until it lands nothing can be booked.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.defaults.adapter = async (config) => {
      if (String(config.url) === '/rides/estimate' && bodyOf(config)?.stops) await gate;
      return adapter(config);
    };
    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    expect(text()).toContain('Calculating fares…');
    expect(requestButton()?.hasAttribute('disabled')).toBe(true);
    release();
    await settle();
    expect(requestButton()?.hasAttribute('disabled')).toBe(false);
    expect(requestButton()?.textContent).toMatch(/\$2.?800$/);
  });

  it('a trip with stops is never queued without them', async () => {
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: 2 });
    fx.routes['get /rides/supply'] = () => ok({ online: 0, busy: 0, level: 'NONE', nearestEtaMinutes: null });
    fx.routes['get /rides/availability'] = () => ok({ level: 'NONE', nearestEtaMinutes: null, gate: true });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    const join = byLabel('Join the queue');
    expect(join?.hasAttribute('disabled')).toBe(true);
    expect(text()).toContain('The queue can’t hold stops. Remove your stops to join it.');
    expect(sent('post /rides/queue/join')).toHaveLength(0);
  });
});

describe('[review 1] the server takes stops away after the rider chose some', () => {
  it('maxStops drops to 0: the stops leave the screen, the quote and the booking, and the rider is told', async () => {
    let max = 2;
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: max });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    expect(byTestId('taxi-stop-1')).toBeTruthy();

    max = 0;
    const quotedBefore = sent('post /rides/estimate').length;
    await act(async () => { await client.invalidateQueries({ queryKey: ['rides', 'capabilities'] }); });
    await settle();
    snap('rider-booking-stops-switched-off');
    // Not one quote after the switch went off may carry a stop — not even in
    // the render before the trip is tidied up.
    expect(sent('post /rides/estimate').length).toBeGreaterThan(quotedBefore);
    for (const config of sent('post /rides/estimate').slice(quotedBefore)) expect(bodyOf(config).stops).toBeUndefined();
    expect(host.querySelector('[data-testid^="taxi-stop-"]')).toBeNull();
    expect(byTestId('taxi-add-stop')).toBeNull();
    expect(byTestId('taxi-stops-dropped')?.textContent).toBe('Stops aren’t available right now, so we removed them from this trip. Check your trip before you book.');
    expect(Object.keys(bodyOf(sent('post /rides/estimate').at(-1)))).toEqual(['pickup', 'dropoff']);

    await click(requestButton() ?? null);
    const [request] = sent('post /rides/request');
    expect(Object.keys(bodyOf(request))).toEqual(['pickup', 'dropoff', 'pickupAddress', 'dropoffAddress', 'passengerCount', 'rideClass']);
  });

  it('maxStops lowered below the count: the extra stops go, the rest are booked', async () => {
    let max = 2;
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: max });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    await pickFromSearch(byTestId('taxi-add-stop'), SHERIFF);
    max = 1;
    const quotedBefore = sent('post /rides/estimate').length;
    await act(async () => { await client.invalidateQueries({ queryKey: ['rides', 'capabilities'] }); });
    await settle();
    for (const config of sent('post /rides/estimate').slice(quotedBefore)) expect(bodyOf(config).stops ?? []).toHaveLength(1);
    expect(byTestId('taxi-stop-2')).toBeNull();
    expect(byTestId('taxi-stop-1')?.textContent).toContain('Camp Street');
    expect(byTestId('taxi-stops-dropped')?.textContent).toMatch(/up to 1 stop now, so we removed the last one/);
    await click(requestButton() ?? null);
    expect(bodyOf(sent('post /rides/request')[0]).stops).toEqual(REQUEST_BODY_WITH_ONE_STOP.stops);
  });
});

describe('[review 2] without the waiting fields, every flag-off screen is main’s, byte for byte', () => {
  // The snapshots under __flagoff__ were written by THIS harness rendering
  // main’s own TaxiScreen (d1b84e13); this code must draw the same DOM.
  it.each([
    ['an older server (404)', () => refuse(404, 'NOT_FOUND')],
    ['stops switched off (0)', () => ok({ maxStops: 0 })],
  ])('booking with a destination — %s', async (_label, capabilities) => {
    fx.routes['get /rides/capabilities'] = capabilities;
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await expect(host.innerHTML).toMatchFileSnapshot('./__flagoff__/rider-booking.html');
  });

  it.each([
    ['driver arrived', 'rider-active-arrived', { status: 'DRIVER_ARRIVED', ridePinVerified: false }],
    ['on the trip', 'rider-active-riding', {}],
  ])('the live ride — %s', async (_label, file, overrides) => {
    fx.routes['get /rides/active'] = () => ok(riderRideWithoutStops(overrides));
    await mount();
    await expect(host.innerHTML).toMatchFileSnapshot(`./__flagoff__/${file}.html`);
  });
});

describe('the booking survives the server’s answers', () => {
  it('a changed fare is shown, re-quoted, and booked at the new fare', async () => {
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: 2 });
    let fare = 2800;
    fx.routes['post /rides/estimate'] = (config) => {
      const reply = quote(config);
      return bodyOf(config)?.stops ? ok({ ...ESTIMATE_WITH_ONE_STOP.data, tiers: [{ rideClass: 'ECONOMY', multiplier: 1, fare, capacity: 4, source: 'formula' }] }) : reply;
    };
    let calls = 0;
    fx.routes['post /rides/request'] = () => (++calls === 1
      ? refuse(409, 'FARE_CHANGED', { expectedFare: 2800, fare: 3000, rideClass: 'ECONOMY', currencyCode: 'GYD' })
      : { status: 201, data: REQUEST_ANSWER_WITH_ONE_STOP });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    fare = 3000;
    await click(requestButton() ?? null);
    expect(text()).toMatch(/The fare for this trip is now \$3.?000\. Check it, then tap Request again\./);
    expect(requestButton()?.textContent).toMatch(/\$3.?000$/);
    await click(requestButton() ?? null);
    expect(sent('post /rides/request').map((c) => bodyOf(c).expectedFare)).toEqual([2800, 3000]);
  });

  it('a retry after a lost answer carries the SAME Idempotency-Key', async () => {
    let calls = 0;
    fx.routes['post /rides/request'] = () => (++calls === 1 ? { status: 0, network: true } : { status: 201, data: REQUEST_ANSWER_WITH_ONE_STOP });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await click(requestButton() ?? null);
    await click(requestButton() ?? null);
    const keys = sent('post /rides/request').map((c) => c.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('a stop the server refuses is said in plain words', async () => {
    fx.routes['get /rides/capabilities'] = () => ok({ maxStops: 2 });
    fx.routes['post /rides/estimate'] = (config) => (bodyOf(config)?.stops
      ? refuse(400, 'STOP_TOO_CLOSE', { stopSequence: 1, from: 'PICKUP', to: 'STOP_1', distanceMeters: 20, minMeters: 50 })
      : quote(config));
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    await pickFromSearch(byTestId('taxi-add-stop'), CAMP);
    expect(byTestId('taxi-estimate-refused')?.textContent).toBe('Your pickup and stop 1 are too close together. Move or remove that stop.');
    expect(requestButton()?.hasAttribute('disabled') ?? true).toBe(true);
  });
});

describe('the waiting charge at booking (Rev 2 §8.2)', () => {
  it('says the server’s terms beside the fare', async () => {
    fx.routes['post /rides/estimate'] = () => ok({ ...ESTIMATE_WITHOUT_STOPS.data, waiting: WAITING_TERMS });
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    expect(byTestId('taxi-waiting-terms')?.textContent).toBe('Waiting: 500 per 10 minutes after your driver arrives');
    snap('rider-booking-waiting-terms');
  });

  it('says nothing when the server sends no terms', async () => {
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    expect(byTestId('taxi-waiting-terms')).toBeNull();
    expect(text()).not.toMatch(/Waiting/);
  });
});

describe('the live ride', () => {
  it('shows every stop in order with its status, the driver, and the share; refetches on a stop change', async () => {
    fx.routes['get /rides/active'] = () => ok(riderRideWithStops());
    await mount();
    snap('rider-active-ride-two-stops');
    const rows = Array.from(host.querySelectorAll('[data-testid^="taxi-itinerary-stop-"]'));
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['taxi-itinerary-stop-1', 'taxi-itinerary-stop-2']);
    expect(rows[0]!.textContent).toContain('Camp Street');
    expect(rows[0]!.textContent).toContain('Done');
    expect(rows[1]!.textContent).toContain('Sheriff Street');
    expect(rows[1]!.textContent).toContain('Driver is at this stop');
    expect(text()).toContain('Next: stop 2, Sheriff Street');
    expect(text()).toContain('Devon');
    expect(byLabel('Share trip')).toBeTruthy();
    expect(host.querySelectorAll('[data-marker^="Stop "]')).toHaveLength(2);

    const before = sent('get /rides/active').length;
    await act(async () => fx.fire('ride:stop_changed', { orderId: 'cm-ride-2', sequence: 2, status: 'DEPARTED', nextStopSequence: null }));
    await settle();
    expect(sent('get /rides/active').length).toBeGreaterThan(before);
  });

  it('a ride without stops shows no stop UI at all', async () => {
    fx.routes['get /rides/active'] = () => ok(riderRideWithoutStops());
    await mount();
    expect(byTestId('taxi-itinerary')).toBeNull();
    expect(host.querySelector('[data-marker^="Stop "]')).toBeNull();
    expect(text()).not.toMatch(/Your stops|Next stop|Next: /);
  });

  it('the live wait once the driver has arrived: minutes, the server’s charge, the countdown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(WAITING_LIVE.nextChargeAt) - 390_000);
    fx.routes['get /rides/active'] = () => ok(riderRideWithoutStops({ status: 'DRIVER_ARRIVED', ridePinVerified: false, waiting: WAITING_LIVE }));
    await mount();
    snap('rider-active-ride-waiting');
    const card = byTestId('taxi-waiting');
    expect(card?.textContent).toContain('13 min waited');
    expect(card?.textContent).toMatch(/\$500 so far/);
    expect(card?.textContent).toMatch(/Next \$500 in 6:30/);
  });

  it('no waiting card before the server sends one', async () => {
    fx.routes['get /rides/active'] = () => ok(riderRideWithoutStops({ status: 'DRIVER_EN_ROUTE', ridePinVerified: false }));
    await mount();
    expect(byTestId('taxi-waiting')).toBeNull();
  });

  it('the finished fare’s breakdown reaches the receipt', async () => {
    fx.routes['get /rides/active'] = () => ok(riderRideWithoutStops());
    await mount();
    // Delivered: the live-ride read is empty from now on, and the event carries the fare.
    fx.routes['get /rides/active'] = () => ok(null);
    await act(async () => fx.fire('order:status_changed', { orderId: 'cm-ride-3', status: 'DELIVERED', fare: { total: 2800, fareBreakdown: FARE_BREAKDOWN } }));
    await settle();
    expect(byTestId('post-trip')?.textContent).toBe('3300');
  });

  it('a DELIVERED event without a breakdown hands the receipt today’s ride', async () => {
    fx.routes['get /rides/active'] = () => ok(riderRideWithoutStops());
    await mount();
    fx.routes['get /rides/active'] = () => ok(null);
    await act(async () => fx.fire('order:status_changed', { orderId: 'cm-ride-3', status: 'DELIVERED', fare: { total: 2400 } }));
    await settle();
    expect(byTestId('post-trip')?.textContent).toBe('no breakdown');
  });
});


describe('a road-routing outage is explained on single-stop quote screens', () => {
  it('taxi says routing is unavailable instead of blaming the destination', async () => {
    fx.routes['post /rides/estimate'] = () => refuse(503, 'ROUTE_UNAVAILABLE');
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    expect(text()).toContain('Road routing is unavailable. Try again in a moment.');
    expect(text()).not.toContain('Try another destination');
    expect(requestButton()?.hasAttribute('disabled') ?? true).toBe(true);
  });
  it('courier explains the outage and leaves a working retry control', async () => {
    fx.routes['get /courier/orders'] = () => ok([]);
    fx.routes['post /courier/estimate'] = () => refuse(503, 'ROUTE_UNAVAILABLE');
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(CourierScreen, { navigation }))));
    await settle();
    await pickFromSearch(byLabel('Set drop-off location'), LAMAHA);
    expect(text()).toContain('Road routing is unavailable. Try again in a moment.');
    const before = sent('post /courier/estimate').length;
    await click(byLabel('Retry'));
    expect(sent('post /courier/estimate').length).toBeGreaterThan(before);
    expect(byLabel('Send parcel')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('a cached road quote does not hide a later routing refusal', () => {
  it('taxi removes the old fare and disables booking after a failed refresh', async () => {
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    expect(requestButton()?.hasAttribute('disabled')).toBe(false);
    fx.routes['post /rides/estimate'] = () => refuse(503, 'ROUTE_UNAVAILABLE');
    await act(async () => { await client.invalidateQueries({ queryKey: ['rides', 'estimate'] }); });
    await settle();
    expect(text()).toContain('Road routing is unavailable. Try again in a moment.');
    expect(requestButton()?.hasAttribute('disabled')).toBe(true);
    expect(requestButton()?.textContent).toBe('Request ride');
  });
  it('courier hides a stale price and its retry can recover a real quote', async () => {
    const price = { totalFee: 1100, distanceKm: 3, estimatedMinutes: 12 };
    fx.routes['get /courier/orders'] = () => ok([]);
    fx.routes['post /courier/estimate'] = () => ok(price);
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(CourierScreen, { navigation }))));
    await settle();
    await pickFromSearch(byLabel('Set drop-off location'), LAMAHA);
    expect(byLabel('Send parcel · $1,100')).toBeTruthy();
    fx.routes['post /courier/estimate'] = () => refuse(503, 'ROUTE_UNAVAILABLE');
    await act(async () => { await client.invalidateQueries({ queryKey: ['courier', 'estimate'] }); });
    await settle();
    expect(text()).toContain('Road routing is unavailable. Try again in a moment.');
    expect(byLabel('Send parcel · $1,100')).toBeNull();
    fx.routes['post /courier/estimate'] = () => ok(price);
    await click(byLabel('Retry'));
    expect(byLabel('Send parcel · $1,100')).toBeTruthy();
    expect(text()).not.toContain('Road routing is unavailable.');
  });
});
