/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { riderRideWithoutStops } from '../../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [AUD-L5b-009 · S1] A mover's SOS is the SOS ceremony — taxi drivers AND
// delivery riders — never a popup that closes the moment it is pressed.
//
// The REAL ActiveJobScreen and the REAL SosCeremony, drawn by a real React
// renderer; the REAL ride and safety hooks, through the REAL API client and
// its Axios instance, answered by a capturing adapter. Only native drawing,
// the OS openers and storage are stand-ins. The kit's popup stand-in draws its
// dim backdrop as a control that calls the popup's onClose — exactly what the
// real PopupCard does with a tap outside the card or Android's back button
// (pinned against the real source at the bottom of this file).
//
// Asserted: the press reaches the server with the job's own id (the ride's
// immediate route for a driver, /safety/sos with the order for a rider); the
// popup stays up through the request and shows the server's answer; a stray
// tap outside never hides an SOS once it is pressed; a failure says Swift was
// NOT alerted and offers both a retry and the emergency call.
// ---------------------------------------------------------------------------

type Reply = { status: number; data?: unknown; network?: boolean; timeout?: boolean };
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;

const fx = vi.hoisted(() => {
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return {
    kind: 'DRIVER' as 'DRIVER' | 'RIDER',
    job: null as any,
    preview: false,
    routes: {} as Record<string, (config: any) => any>,
    seen: [] as any[],
    storage: new Map<string, string>(),
    openExternal: vi.fn(async (_url: string, _fallback?: string) => true),
    dial: { kind: 'auto', number: '911' } as { kind: 'auto' | 'confirm'; number: string } | { kind: 'manual' },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View, Image: View, ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    TurboModuleRegistry: { get: () => null },
    Linking: { openURL: vi.fn(async () => true) },
    AppState: { addEventListener: () => ({ remove() {} }), currentState: 'active' },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('div', { 'data-map': '' }, p.children), Marker: () => null, Polyline: () => null, PROVIDER_DEFAULT: 'default' };
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
    // The real PopupCard: a tap on the dim backdrop (or Android back) calls onClose.
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, h('div', { 'data-testid': 'popup-backdrop', onClick: p.onClose }), p.children) : null),
    EmptyState: (p: any) => h('div', null, p.title),
    StatusRail: () => null, LockIn: (p: any) => h('div', null, p.label), CodeInput: () => null, TonePill: (p: any) => h('span', null, p.label),
    cardShadow: {}, lockInButtonStyle: () => ({}),
  };
});
vi.mock('../../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
// The screen's job and step hooks are stand-ins; the SOS hooks are the REAL ones.
vi.mock('../../../hooks', async () => {
  const rides = await vi.importActual<typeof import('../../../hooks/rides')>('../../../hooks/rides');
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false });
  return {
    useMoverKind: () => ({ kind: fx.kind }),
    useActiveJob: () => ({ data: fx.job, refetch: vi.fn(), isFetching: false }),
    useActiveJobs: () => ({ legs: fx.job ? [fx.job] : [], run: null }),
    useDriverAction: idle, useRiderAction: idle, useRateCustomer: idle,
    useCourierProof: idle, useCourierCollect: idle, useCourierPickupProof: idle, useCourierReturn: idle, useCourierReturnProof: idle,
    useRideSos: rides.useRideSos,
  };
});
vi.mock('../../../hooks/customer', () => ({ customerKeys: { homeAll: ['customer', 'home'] } }));
vi.mock('../../../hooks/mover', () => ({ uploadHandoverPhoto: vi.fn(), useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../CustodyRecoverySection', () => ({ CustodyRecoverySection: () => null }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: fx.preview }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: fx.openExternal }));
vi.mock('../../../lib/storage', () => ({
  zustandStorage: {
    getItem: (k: string) => fx.storage.get(k) ?? null,
    setItem: (k: string, v: string) => { fx.storage.set(k, v); },
    removeItem: (k: string) => { fx.storage.delete(k); },
  },
}));
// Guyana's verified number (the bundled market policy's answer), served without a fetch.
vi.mock('../../../services/emergencyPolicy', () => ({
  useEmergencyPolicy: () => ({ country: 'GY', dial: fx.dial }),
  emergencyDialFor: () => fx.dial,
  currentMarketDial: () => fx.dial,
  previewEmergencyDial: () => fx.dial,
  emergencyDialCopy: (dial: { kind: string; number?: string }) => (dial.kind === 'manual' ? 'Dial your local emergency services first.' : `This dials ${dial.number}.`),
}));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, countryCode: 'GY', user: { id: 'mover-1', firstName: 'Devon' }, sessionGeneration: 1 };
  const useAuthStore = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ ...state, rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }),
  });
  const session = () => ({ userId: 'mover-1', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' });
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
import { emergencyCounters, resetEmergencyCountersForTests } from '../../../lib/emergencyPolicy';
import { SosCeremony } from '../../safety/SosCeremony';
import { ActiveJobScreen } from './ActiveJobScreen';

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

const RIDE = riderRideWithoutStops({ customer: { firstName: 'Asha' }, paymentMethod: 'CASH' });
const RIDE_SOS = `post /rides/${RIDE.id}/sos`;
const ORDER = {
  id: 'cm-order-7', orderNumber: 'SW-1007', status: 'RIDER_ASSIGNED', orderType: 'DELIVERY',
  vendor: { name: 'Regent Street Grocery', latitude: 6.808, longitude: -58.156, address: 'Regent Street' },
  deliveryAddress: 'Lamaha Street', deliveryLat: 6.82, deliveryLng: -58.16,
  totalAmount: 2000, paymentMethod: 'CASH', customer: { firstName: 'Asha' },
};
const PAGED = { id: 'sos-alert-1', status: 'ACTIVE', graceEndsAt: null };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigation = { navigate: vi.fn(), goBack: vi.fn() };

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
async function render(kind: 'DRIVER' | 'RIDER', job: unknown) {
  fx.kind = kind;
  fx.job = job;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ActiveJobScreen, { navigation }))));
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
  fx.preview = false;
  fx.dial = { kind: 'auto', number: '911' };
  fx.routes = {
    [RIDE_SOS]: () => ok({ acknowledged: true, orderId: RIDE.id, sosAlertId: PAGED.id, status: 'ACTIVE' }),
    'post /safety/sos': () => ok(PAGED),
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

describe('a taxi driver’s SOS is the ceremony, on the ride’s own immediate route', () => {
  it('the press reaches the server with the ride id and the driver’s position; the popup stays up and shows the server’s answer', async () => {
    await render('DRIVER', RIDE);
    await openSos();
    expect(dialogText()).toContain('Get emergency help?');
    await click(buttonNamed('Yes — get help now'));
    // The market's verified number is dialed first, then Swift is told.
    expect(dialed('911')).toBe(1);
    expect(sent(RIDE_SOS)).toHaveLength(1);
    expect(bodyOf(sent(RIDE_SOS)[0])).toEqual({ lat: 6.81, lng: -58.15 });
    expect(sent('post /safety/sos')).toHaveLength(0);
    // Still up, and it says what the SERVER said.
    expect(dialog()).not.toBeNull();
    expect(dialogText()).toContain("Swift's safety team has been paged");
  });

  it('a stray tap outside never hides an SOS once it is pressed — only its own Close does', async () => {
    const answer = deferred();
    fx.routes[RIDE_SOS] = answer.handler;
    await render('DRIVER', RIDE);
    // Before anything is pressed, a tap outside is just "never mind".
    await openSos();
    await tapOutside();
    expect(dialog()).toBeNull();
    expect(sent(RIDE_SOS)).toHaveLength(0);
    // Pressed: the request is in flight.
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(sent(RIDE_SOS)).toHaveLength(1);
    expect(buttonNamed('Alerting Swift…')).not.toBeNull();
    await tapOutside();
    expect(dialog(), 'a tap outside hid an SOS in flight').not.toBeNull();
    expect(buttonNamed('Alerting Swift…')).not.toBeNull();
    // The server answers: paged. A tap outside still does not hide it.
    await act(async () => { answer.release(ok({ acknowledged: true, orderId: RIDE.id, sosAlertId: PAGED.id, status: 'ACTIVE' })); });
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
  ] as const)('%s: says Swift was NOT alerted, offers a retry AND the emergency call, and the retry reaches the server', async (_label, failure) => {
    fx.routes[RIDE_SOS] = () => failure;
    await render('DRIVER', RIDE);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialog()).not.toBeNull();
    expect(dialogText()).toContain('You appear to be offline — Swift was NOT alerted.');
    // A tap outside does not hide the failure either.
    await tapOutside();
    expect(dialog()).not.toBeNull();
    // The emergency call is one tap away, separate from Swift.
    const before = dialed('911');
    await click(buttonNamed('Call 911'));
    expect(dialed('911')).toBe(before + 1);
    // The retry goes to the same ride, and this time the server answers.
    fx.routes[RIDE_SOS] = () => ok({ acknowledged: true, orderId: RIDE.id, sosAlertId: PAGED.id, status: 'ACTIVE' });
    await click(buttonNamed('Try alerting Swift again'));
    expect(sent(RIDE_SOS)).toHaveLength(2);
    expect(sent(RIDE_SOS).every((c) => String(c.url).includes(RIDE.id))).toBe(true);
    expect(dialogText()).toContain("Swift's safety team has been paged");
  });

  it('a refused raise is loud too: Swift was NOT alerted, with the retry and the call', async () => {
    fx.routes[RIDE_SOS] = () => refuse(500, 'INTERNAL');
    await render('DRIVER', RIDE);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialogText()).toContain('Swift was NOT alerted — the request failed.');
    expect(buttonNamed('Try alerting Swift again')).not.toBeNull();
    expect(buttonNamed('Call 911')).not.toBeNull();
  });

  it('an accepted press whose answer is not one is UNKNOWN — never shown as paged — and offers the retry and the call', async () => {
    fx.routes[RIDE_SOS] = () => ok({ acknowledged: true });
    await render('DRIVER', RIDE);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialogText()).toContain('We could not confirm Swift’s safety team was alerted.');
    expect(dialogText()).not.toContain("Swift's safety team has been paged");
    expect(buttonNamed('Try alerting Swift again')).not.toBeNull();
    expect(buttonNamed('Call 911')).not.toBeNull();
    await tapOutside();
    expect(dialog()).not.toBeNull();
  });

  it('the App Review demo is told plainly that nobody was alerted', async () => {
    fx.routes[RIDE_SOS] = () => refuse(403, 'REVIEW_DEMO_NO_SOS', 'This is the App Review demo. No one was alerted.');
    await render('DRIVER', RIDE);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialog()).not.toBeNull();
    expect(dialogText()).toContain('App Review demo — nobody was alerted.');
    expect(dialogText()).toContain('This is the App Review demo. No one was alerted.');
  });
});

describe('a delivery rider’s SOS: the same ceremony, /safety/sos with the order', () => {
  it('reaches the server with the order id; a stray tap outside does not hide it in flight', async () => {
    const answer = deferred();
    fx.routes['post /safety/sos'] = answer.handler;
    await render('RIDER', ORDER);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(sent('post /safety/sos')).toHaveLength(1);
    expect(bodyOf(sent('post /safety/sos')[0])).toMatchObject({ orderId: ORDER.id, lat: 6.81, lng: -58.15 });
    expect(sent(RIDE_SOS)).toHaveLength(0);
    await tapOutside();
    expect(dialog(), 'a tap outside hid an SOS in flight').not.toBeNull();
    await act(async () => { answer.release(ok(PAGED)); });
    await settle();
    expect(dialogText()).toContain("Swift's safety team has been paged");
    await tapOutside();
    expect(dialog()).not.toBeNull();
  });

  it('offline: Swift was NOT alerted, with a retry and the emergency call', async () => {
    fx.routes['post /safety/sos'] = () => ({ status: 0, network: true });
    await render('RIDER', ORDER);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(dialogText()).toContain('You appear to be offline — Swift was NOT alerted.');
    expect(buttonNamed('Try alerting Swift again')).not.toBeNull();
    await click(buttonNamed('Call 911'));
    expect(dialed('911')).toBe(2); // the press itself, then the explicit call
  });
});

describe('a context that names no record never raises with an undefined id, and is never silent', () => {
  it.each([
    ['no id at all', {}],
    ['an empty ride id', { rideId: '' }],
    ['an order id that is not a string', { orderId: undefined }],
  ])('%s: nothing is sent; Swift was NOT alerted is said; the emergency call is offered; the failure is counted', async (_label, context) => {
    resetEmergencyCountersForTests();
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(SosCeremony, {
      visible: true, onClose: vi.fn(), context: context as never, recordNoun: 'job', getCoords: () => ({ lat: 6.81, lng: -58.15 }),
    }))));
    await settle();
    await click(buttonNamed('Yes — get help now'));
    expect(fx.seen.filter((c) => /sos/.test(String(c.url))), 'an SOS went out with no record').toHaveLength(0);
    expect(dialogText()).toContain('Swift was NOT alerted');
    expect(dialed('911')).toBe(1); // the market's number is still dialed first
    await click(buttonNamed('Call 911'));
    expect(dialed('911')).toBe(2);
    expect(emergencyCounters().transition['ACTIVE->NO_CONTEXT']).toBe(1);
    // A retry could never succeed with no record: none is offered.
    expect(buttonNamed('Try alerting Swift again')).toBeNull();
    await tapOutside();
    expect(dialog()).not.toBeNull();
  });
});

describe('the preview stays read-only', () => {
  it('a previewed trip never dials and never records', async () => {
    fx.preview = true;
    await render('DRIVER', RIDE);
    await openSos();
    await click(buttonNamed('Yes — get help now'));
    expect(fx.openExternal).not.toHaveBeenCalled();
    expect(fx.seen.filter((c) => /sos/.test(String(c.url)))).toHaveLength(0);
  });
});

describe('the backdrop stand-in is the real popup’s behaviour', () => {
  it('the kit PopupCard closes on a tap outside the card and on Android back', () => {
    const src = readFileSync(new URL('../../../kit/card.tsx', import.meta.url), 'utf8');
    const popup = src.slice(src.indexOf('export function PopupCard('));
    expect(popup).toContain('onRequestClose={onClose}');
    expect(popup).toMatch(/<Pressable\s+onPress=\{onClose\}/);
  });
});
