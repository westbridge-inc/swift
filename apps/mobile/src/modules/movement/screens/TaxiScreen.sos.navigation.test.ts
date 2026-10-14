/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { riderRideWithoutStops } from '../../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [AUD-L5b-009 · passenger] The taxi PASSENGER's SOS is the SOS ceremony, like
// every other SOS in the app.
//
// It was the old popup: the press closed it at once, so the person never saw
// whether Swift was alerted, a failure was only a passing toast, and nothing
// stood between a stray tap and an emergency in progress. Now the popup stays
// up through the raise and shows the SERVER's answer; once pressed, a tap on
// the dim backdrop (or Android back) never hides it; offline, refused or
// unreadable answers say Swift was NOT alerted, with a retry and the
// emergency call. The ride keeps its own immediate route, /rides/:id/sos.
//
// The REAL TaxiScreen and the REAL SosCeremony, drawn by a real React renderer,
// with the real ride and safety hooks through the real API client (answered by
// a capturing adapter). Only native drawing, the socket, storage, the OS
// openers and the market policy are stand-ins. The kit's PopupCard stand-in
// draws its dim backdrop as a control that calls onClose — exactly what the
// real one does with a tap outside the card or Android's back button.
// ---------------------------------------------------------------------------

type Reply = { status: number; data?: unknown; network?: boolean; timeout?: boolean };
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;

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
    routes: {} as Record<string, (config: any) => Reply | Promise<Reply>>,
    openExternal: vi.fn(async (_url: string, _fallback?: string) => true),
    dial: { kind: 'auto', number: '911' } as { kind: 'auto' | 'confirm' | 'manual'; number?: string },
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
    // The real PopupCard: a tap on the dim backdrop (or Android back) calls onClose.
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, h('div', { 'data-testid': 'popup-backdrop', onClick: p.onClose }), p.children) : null),
    DecorativeIcon: (p: any) => h('div', null, p.children),
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
vi.mock('../../../lib/openExternal', () => ({ openExternal: fx.openExternal }));
// Guyana's verified number (the bundled market policy's answer), served without a fetch.
vi.mock('../../../services/emergencyPolicy', () => ({
  useEmergencyPolicy: () => ({ country: 'GY', dial: fx.dial }),
  emergencyDialFor: () => fx.dial,
  currentMarketDial: () => fx.dial,
  previewEmergencyDial: () => fx.dial,
  emergencyDialCopy: (dial: { kind: string; number?: string }) => (dial.kind === 'manual' ? 'Dial your local emergency services first.' : `This dials ${dial.number}.`),
}));
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

const ok = (data: unknown, status = 200): Reply => ({ status, data: { success: true, data } });
const refuse = (status: number, code: string, message = `server words for ${code}`): Reply => ({ status, data: { success: false, error: { code, message } } });
const bodyOf = (config: any) => (config?.data ? JSON.parse(String(config.data)) : undefined);
const sent = (route: string) => fx.seen.filter((c) => `${c.method} ${String(c.url).split('?')[0]}` === route);

const adapter: AxiosAdapter = async (config) => {
  fx.seen.push(config);
  const key = `${config.method} ${String(config.url).split('?')[0]}`;
  const handler: Handler | undefined = fx.routes[key];
  const reply = handler ? await handler(config) : refuse(404, 'NOT_FOUND');
  if (reply.network) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
  if (reply.timeout) throw new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED', config);
  const response = { config, status: reply.status, statusText: String(reply.status), headers: {}, data: reply.data };
  if (reply.status >= 200 && reply.status < 300) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, reply.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, null, response as never);
};

/** A server answer the test releases by hand: the SOS is "in flight" until then. */
function deferred() {
  let release!: (r: Reply) => void;
  const answer = new Promise<Reply>((resolve) => { release = resolve; });
  return { handler: () => answer, release };
}

// An active ride with its driver engaged: the SOS control is on screen.
const RIDE = riderRideWithoutStops();
const RIDE_SOS = `post /rides/${RIDE.id}/sos`;
const PAGED = { acknowledged: true, orderId: RIDE.id, sosAlertId: 'sos-alert-9', status: 'ACTIVE' };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigation = { navigate: fx.navigate, goBack: vi.fn(), isFocused: () => true };

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(TaxiScreen, { navigation }))));
  await settle();
}
const dialog = () => host.querySelector('[role="dialog"]') as HTMLElement | null;
const dialogText = () => dialog()?.textContent ?? '';
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;
async function click(el: Element | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
}
const openSos = () => click(buttonNamed('Emergency — get help now'));
const tapOutside = () => click(host.querySelector('[data-testid="popup-backdrop"]'));
const dialed = (number: string) => fx.openExternal.mock.calls.filter(([url]) => url === `tel:${number}`).length;

beforeEach(() => {
  vi.clearAllMocks();
  fx.seen.length = 0;
  fx.storage.clear();
  fx.socketHandlers.clear();
  fx.dial = { kind: 'auto', number: '911' };
  fx.routes = {
    'get /rides/active': () => ok(RIDE),
    'get /rides/capabilities': () => refuse(404, 'NOT_FOUND'),
    'get /rides/availability': () => ok({ level: 'GOOD', nearestEtaMinutes: 3, gate: false }),
    'get /rides/supply': () => ok({ online: 3, busy: 0, level: 'GOOD', nearestEtaMinutes: 3 }),
    'get /rides/presence': () => ok({ cars: [] }),
    'get /rides/queue': () => ok(null),
    'get /safety/guardian/checkin': () => ok(null),
    [RIDE_SOS]: () => ok(PAGED),
  };
  api.defaults.adapter = adapter;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('the taxi passenger’s SOS is the ceremony, on the ride’s own immediate route', () => {
  it('the press dials the market’s number first, reaches the server with the ride id and the passenger’s position, and the popup stays up with the server’s answer', async () => {
    await mount();
    await openSos();
    expect(dialogText()).toContain('Get emergency help?');
    await click(buttonNamed('Yes — get help now'));
    expect(dialed('911')).toBe(1);
    expect(sent(RIDE_SOS)).toHaveLength(1);
    expect(bodyOf(sent(RIDE_SOS)[0])).toEqual({ lat: 6.8013, lng: -58.1553 });
    expect(sent('post /safety/sos')).toHaveLength(0);
    expect(dialog(), 'the popup closed on the press: the passenger never sees whether Swift was alerted').not.toBeNull();
    expect(dialogText()).toContain("Swift's safety team has been paged");
  });

  it('before the press a tap outside may close the question; once pressed, it never hides the SOS — only Close does', async () => {
    await mount();
    await openSos();
    await tapOutside();
    expect(dialog()).toBeNull();

    const answer = deferred();
    fx.routes[RIDE_SOS] = answer.handler;
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(buttonNamed('Alerting Swift…'), 'the SOS in flight is not on screen').not.toBeNull();
    await tapOutside();
    expect(dialog(), 'a tap outside hid an SOS in flight').not.toBeNull();
    await act(async () => { answer.release(ok(PAGED)); });
    await settle();
    expect(dialogText()).toContain("Swift's safety team has been paged");
    await tapOutside();
    expect(dialog()).not.toBeNull();
    await click(buttonNamed('Close'));
    expect(dialog()).toBeNull();
  });

  it.each([
    ['no signal at all', { status: 0, network: true }],
    ['a request that timed out', { status: 0, timeout: true }],
  ] as const)('%s: says Swift was NOT alerted, offers a retry AND the emergency call, and the retry reaches the same ride', async (_label, failure) => {
    fx.routes[RIDE_SOS] = () => failure;
    await mount();
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialog(), 'the failure was only a passing toast').not.toBeNull();
    expect(dialogText()).toContain('You appear to be offline — Swift was NOT alerted.');
    await tapOutside();
    expect(dialog()).not.toBeNull();
    const before = dialed('911');
    await click(buttonNamed('Call 911'));
    expect(dialed('911')).toBe(before + 1);
    fx.routes[RIDE_SOS] = () => ok(PAGED);
    await click(buttonNamed('Try alerting Swift again'));
    expect(sent(RIDE_SOS)).toHaveLength(2);
    expect(dialogText()).toContain("Swift's safety team has been paged");
  });

  it('a refused raise is loud too: Swift was NOT alerted, with the retry and the call', async () => {
    fx.routes[RIDE_SOS] = () => refuse(500, 'INTERNAL');
    await mount();
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialogText()).toContain('Swift was NOT alerted — the request failed.');
    expect(buttonNamed('Try alerting Swift again')).not.toBeNull();
    expect(buttonNamed('Call 911')).not.toBeNull();
  });

  it('the App Review demo is told plainly that nobody was alerted', async () => {
    fx.routes[RIDE_SOS] = () => refuse(403, 'REVIEW_DEMO_NO_SOS', 'This is the App Review demo. No one was alerted.');
    await mount();
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialog()).not.toBeNull();
    expect(dialogText()).toContain('App Review demo — nobody was alerted.');
    expect(dialogText()).toContain('This is the App Review demo. No one was alerted.');
  });
});
