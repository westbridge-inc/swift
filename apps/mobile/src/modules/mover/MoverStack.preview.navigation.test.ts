/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@swift/types';

// [Owner, 1 Oct] "at the document area for riders I do not see a preview
// dashboard for riders and taxi guys there".
//
// REAL: the MoverStack and its navigator, MoverRoot, the documents screen
// (MoverOnboardingScreen + DocumentChecklist + PricingCard), Home, Active job,
// Account, Earnings, Job history, Documents and Vehicle screens, every mover and
// verification hook, the auth and preview stores, React Query and the app's
// `api` client with its interceptors. FAKE: native drawing (views, map, sheet,
// icons, the design kit's paint), device APIs, and the HTTP transport, which
// records every request that would have left the phone.
const fx = vi.hoisted(() => ({
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
  requestLogout: vi.fn(),
  storage: new Map<string, string>(),
  openURL: vi.fn(async (_url: string) => undefined),
  sosMutate: vi.fn(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const kids = (children: unknown) => (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  const View = ({ children, testID }: any) => R.createElement('div', testID ? { 'data-testid': testID } : null, kids(children));
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, testID }: any) => R.createElement('button', {
    type: 'button', disabled: !!disabled, 'aria-label': accessibilityLabel, 'data-testid': testID,
    onClick: disabled ? undefined : () => onPress?.(),
  }, kids(children));
  const TextInput = ({ value, onChangeText, placeholder }: any) => R.createElement('input', {
    value: value ?? '', placeholder, onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value),
  });
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Pressable, TouchableOpacity: Pressable, TextInput,
    Image: () => null, RefreshControl: () => null, ActivityIndicator: () => null,
    Modal: ({ visible, children }: any) => (visible ? R.createElement('div', null, children) : null),
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, sequence: animation, loop: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0, cubic: () => 0, bezier: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} }, Vibration: { vibrate: () => undefined },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Linking: { openURL: fx.openURL, canOpenURL: async () => true, getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
    Share: { share: async () => undefined }, Alert: { alert: () => undefined },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove() {} }), announceForAccessibility() {} },
    TurboModuleRegistry: { get: () => null },
    PixelRatio: { get: () => 3, roundToNearestPixel: (n: number) => n },
  };
});
vi.mock('@react-navigation/elements', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const SafeAreaProviderCompat = Object.assign(Box, { initialMetrics: { frame: { width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } });
  return {
    SafeAreaProviderCompat, Screen: Box, Header: () => null, HeaderBackButton: () => null,
    HeaderBackContext: R.createContext(undefined), HeaderShownContext: R.createContext(false),
    HeaderHeightContext: R.createContext(0), useHeaderHeight: () => 0,
    getHeaderTitle: (_options: unknown, name: string) => name, getLabel: (options: any, fallback: string) => options.label ?? fallback,
    PlatformPressable: Box, Label: Box, Background: Box, Badge: () => null, MissingIcon: () => null,
    useFrameSize: () => ({ width: 390, height: 844 }), useLocale: () => ({ direction: 'ltr' }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const R = await import('react');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return { SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const MapView = ({ children }: any) => R.createElement('div', { 'data-map': '' }, children);
  return { default: MapView, Marker: () => null, Polyline: () => null, PROVIDER_DEFAULT: 'default' };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { default: Box, BottomSheetScrollView: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `mover-preview-fixture-${++next}` }; });
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getLastKnownPositionAsync: async () => null,
  getCurrentPositionAsync: async () => ({ coords: { latitude: 6.8, longitude: -58.15 } }),
  watchPositionAsync: async () => ({ remove() {} }),
}));
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///sample.jpg', fileName: 'sample.jpg', mimeType: 'image/jpeg' }] }),
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  launchCameraAsync: async () => ({ canceled: true, assets: [] }),
}));
vi.mock('../../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => fx.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fx.storage.set(key, value); },
    removeItem: (key: string) => { fx.storage.delete(key); },
  },
}));
vi.mock('../../lib/adsQueue', () => ({ retireAdEventScope: () => undefined }));
vi.mock('../../lib/analytics', () => ({ track: () => undefined }));
vi.mock('../../lib/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('../../lib/payLink', () => ({ openPayLink: async () => true }));
vi.mock('../../lib/images', () => ({ mediaUrl: () => null }));
vi.mock('../../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../../services/notification-priming', () => ({ maybePrimeNotifications: () => undefined }));
vi.mock('../../services/socket', () => ({ connectSocket: () => undefined, getSocket: () => null, disconnectSocket: () => undefined }));
vi.mock('../../services/backgroundLocation', () => ({
  publishMoverLocation: async () => ({ accepted: true }),
  startMoverLocation: async () => undefined,
  stopMoverLocation: async () => undefined,
  requestMoverBackgroundPermission: async () => 'denied',
}));
vi.mock('../../kit/toast', () => ({ toast: fx.toast }));
vi.mock('../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const kids = (children: unknown) => (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  const Box = ({ children, testID }: any) => R.createElement('div', testID ? { 'data-testid': testID } : null, kids(children));
  const Text = ({ children }: any) => R.createElement('span', null, children);
  const Button = ({ label, onPress, disabled, loading, testID }: any) => R.createElement('button', {
    type: 'button', 'aria-label': label, 'data-testid': testID, disabled: !!(disabled || loading),
    onClick: disabled || loading ? undefined : () => onPress?.(),
  }, label);
  return {
    T: Text, Eyebrow: Text, PopupTitle: Text,
    Screen: ({ children }: any) => R.createElement('section', { 'data-screen': '' }, kids(children)),
    Card: ({ children }: any) => R.createElement('div', { 'data-card': '' }, kids(children)),
    DecorativeIcon: Box,
    Header: ({ title }: any) => R.createElement('header', null, title ?? ''),
    PillButton: Button, LinkText: Button, Chip: Button,
    SettingsRow: ({ label, sub, onPress, right }: any) => R.createElement('button', {
      type: 'button', 'aria-label': label, disabled: !onPress, onClick: onPress ? () => onPress() : undefined,
    }, label, sub ? ` · ${sub}` : '', right ?? null),
    TonePill: ({ label }: any) => R.createElement('span', { 'data-pill': label }, label),
    Badge: ({ label }: any) => R.createElement('span', null, label),
    LoadingBlock: () => R.createElement('span', null, 'Loading…'),
    Spinner: () => null,
    ErrorState: ({ message, onRetry }: any) => R.createElement('div', { role: 'alert' }, message ?? 'Something went wrong',
      onRetry ? R.createElement('button', { type: 'button', onClick: () => onRetry() }, 'Retry') : null),
    EmptyState: ({ title, body, actionLabel, onAction }: any) => R.createElement('div', null, title, body ? ` ${body}` : '',
      actionLabel ? R.createElement('button', { type: 'button', onClick: () => onAction?.() }, actionLabel) : null),
    LabeledInput: ({ value, onChangeText, placeholder }: any) => R.createElement('input', {
      value: value ?? '', placeholder, 'aria-label': placeholder, onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value),
    }),
    StatTile: ({ label, value, sub }: any) => R.createElement('div', null, `${label} ${value}${sub ? ` ${sub}` : ''}`),
    Pictogram: () => null, IconChip: () => null,
    PopupCard: ({ visible, children }: any) => (visible ? R.createElement('div', { role: 'dialog' }, children) : null),
    useLogoutConfirm: () => ({ requestLogout: fx.requestLogout, logoutDialog: null }),
    cardShadow: {}, FareSlider: () => null, canAdjustFare: () => false,
    CodeInput: () => null, LockIn: () => null, lockInButtonStyle: () => ({}), StatusRail: () => null,
  };
});
vi.mock('../../components/SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../../components/StandingCard', () => ({ StandingCard: () => null }));
vi.mock('../../components/RoleSwitcherSheet', async () => {
  const R = await import('react');
  return { RoleSwitcherSheet: ({ visible }: any) => (visible ? R.createElement('div', { role: 'dialog' }, 'Switch app sheet') : null) };
});
vi.mock('../../components/onboarding/DocumentUploadCard', async () => {
  const R = await import('react');
  return { DocumentUploadCard: ({ docType, status }: any) => R.createElement('div', null, `${docType} · ${status ?? 'MISSING'}`) };
});
// The MMG link card's own form is not under test; its Save hands the screen a
// link exactly as the card does, so the SCREEN's save handler is the real one.
vi.mock('../../components/MmgPayLinkCard', async () => {
  const R = await import('react');
  return {
    MmgPayLinkCard: ({ onSave, onCancelPending }: any) => R.createElement('div', null,
      R.createElement('button', { type: 'button', onClick: () => onSave('https://pay.example.test/rides') }, 'Save MMG link'),
      onCancelPending ? R.createElement('button', { type: 'button', onClick: () => onCancelPending() }, 'Cancel staged MMG link') : null),
  };
});
vi.mock('../../components/billing/BillingSurfaces', async () => {
  const R = await import('react');
  return {
    BillingStatusBlock: () => null,
    BillingStopControl: ({ onStop }: any) => R.createElement('button', { type: 'button', onClick: () => onStop() }, 'Stop weekly fee'),
  };
});
vi.mock('../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null }) }));
vi.mock('../../hooks/useDeviceLocation', () => ({
  GEORGETOWN: { latitude: 6.8013, longitude: -58.1551 },
  useDeviceLocation: () => ({ resolve: async () => ({ status: 'denied' }) }),
}));
// The hooks barrel, narrowed to the REAL mover, verification and courier hooks
// the mover stack uses (the rest of the app's hooks are not on these screens).
vi.mock('../../hooks', async () => {
  const mover = await vi.importActual<Record<string, unknown>>('../../hooks/mover');
  const verification = await vi.importActual<Record<string, unknown>>('../../hooks/verification');
  const courier = await vi.importActual<Record<string, unknown>>('../../hooks/courier');
  return { ...mover, ...verification, ...courier, useRideSos: () => ({ mutate: fx.sosMutate, isPending: false }) };
});
vi.mock('../chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: () => null }));
vi.mock('../safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: () => null }));
vi.mock('../safety/SosCeremony', () => ({ SosCeremony: () => null }));

import { useAuthStore } from '../../stores/authStore';
import { useMoverPreview } from '../../stores/moverPreview';
import { api, driverApi, partnerApi, riderApi } from '../../services/api';
import { MoverStack } from './MoverStack';

// ---------------------------------------------------------------------------
// Fixtures: a rider and a taxi driver whose documents are still being checked.
// ---------------------------------------------------------------------------
type Wire = { method: string; url: string };
const wire: Wire[] = [];
const writes = () => wire.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`);

const quote = (vehicleType: string, role: string, tier: string, rate: number) => ({ vehicleType, label: vehicleType, role, band: 'STANDARD', tier, rate, offered: true });
let pricing = guyanaList({ rider: 6000, taxi: 9000 });
function guyanaList({ rider, taxi }: { rider: number; taxi: number }) {
  return {
    countryCode: 'GY', currencyCode: 'GYD', currencySymbol: '$', isActive: true, trialDays: 14,
    movers: [
      quote('BICYCLE', 'RIDER', 'courier', rider), quote('MOTORCYCLE', 'RIDER', 'courier', rider),
      quote('CAR', 'DRIVER', 'taxi', taxi), quote('WAGON_CAR', 'DRIVER', 'taxi', taxi),
      quote('BUS_9', 'DRIVER', 'taxi', taxi), quote('BUS_15', 'DRIVER', 'taxi', taxi),
    ],
    vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }] },
    franchise: null,
  };
}

let applicant: { vehicleType: 'MOTORCYCLE' | 'CAR'; kind: 'RIDER' | 'DRIVER' } = { vehicleType: 'MOTORCYCLE', kind: 'RIDER' };
const verificationStatus = () => ({
  roleVerified: false, canGoOnline: false, vehicleType: applicant.vehicleType,
  checklist: ['NATIONAL_ID', 'DRIVERS_LICENSE', 'POLICE_RECORD'],
  // Under review, missing, and rejected — the document area's three states.
  documents: [
    { docType: 'NATIONAL_ID', status: 'PENDING', createdAt: '2026-09-30T10:00:00Z' },
    { docType: 'POLICE_RECORD', status: 'REJECTED', createdAt: '2026-09-29T10:00:00Z', reviewNote: 'Blurry' },
  ],
});
const moverProfile = () => ({ id: `${applicant.kind.toLowerCase()}-1`, isOnline: false, isAvailable: false, vehicleType: applicant.vehicleType, user: { id: 'mover-1', activeRole: applicant.kind, lastMoverRole: applicant.kind } });

function respond(config: InternalAxiosRequestConfig, status: number, data: unknown) {
  const response = { config, status, statusText: String(status), headers: {}, data };
  if (status >= 200 && status < 300) return response;
  throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response as never);
}

async function transport(config: InternalAxiosRequestConfig) {
  const method = String(config.method ?? 'get').toUpperCase();
  const url = String(config.url ?? '');
  wire.push({ method, url });
  if (method !== 'GET') return respond(config, 200, { success: true, data: {} });
  if (url === '/verification/status') return respond(config, 200, { success: true, data: verificationStatus() });
  if (url === '/auth/pricing') return respond(config, 200, { success: true, data: pricing });
  if (url === `/${applicant.kind.toLowerCase()}/profile`) return respond(config, 200, { success: true, data: moverProfile() });
  if (url === '/rider/orders/active' || url === '/driver/rides/active') return respond(config, 200, { success: true, data: null });
  return respond(config, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

function signIn(kind: 'RIDER' | 'DRIVER') {
  applicant = kind === 'RIDER' ? { vehicleType: 'MOTORCYCLE', kind } : { vehicleType: 'CAR', kind };
  useAuthStore.getState().setAuth({
    id: 'mover-1', firstName: 'Rae', lastName: 'Persaud', phone: '+5926000001', countryCode: 'GY',
    roles: ['CUSTOMER', 'MOVER', kind], activeRole: kind, lastMoverRole: kind,
    selfieCapturedAt: '2026-09-28T10:00:00Z',
  } as unknown as User, 'synthetic-access', 'synthetic-refresh');
  useAuthStore.setState({ intent: 'mover', countryCode: 'GY' });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const navigation = createNavigationContainerRef<Record<string, object | undefined>>();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;
const originalAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
// Raw axios (session revoke on an account switch) must never reach a network either.
const rawAxios: string[] = [];

const text = () => host.textContent ?? '';
/** The top-most pushed screen (native-stack renders the whole stack). */
const topScreen = () => { const all = host.querySelectorAll('[data-screen]'); return (all[all.length - 1]?.textContent ?? ''); };
/** The kit Card that holds a piece of text. */
function cardWith(anchor: string): string {
  const span = Array.from(host.querySelectorAll('span')).find((el) => el.textContent === anchor);
  if (!span) throw new Error(`no "${anchor}" on screen`);
  return span.closest('[data-card]')?.textContent ?? '';
}
const pill = (label: string) => host.querySelector(`[data-pill="${label}"]`) !== null;
const routes = () => navigation.getRootState()?.routes.map((r) => r.name) ?? [];
async function settle(ms = 120) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
function buttons(scope: Element = host): HTMLButtonElement[] { return Array.from(scope.querySelectorAll('button')); }
function button(label: string, scope: Element = host): HTMLButtonElement {
  const all = buttons(scope);
  const hit = all.find((b) => b.getAttribute('aria-label') === label) ?? all.find((b) => b.textContent?.trim() === label);
  if (!hit) throw new Error(`no button "${label}" — buttons: ${all.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()).join(' | ')}`);
  return hit;
}
const hasButton = (label: string) => buttons().some((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
/** Press a control — never a disabled one: a press that did nothing must not pass as "wrote nothing". */
async function press(label: string, scope: Element = host) {
  const target = button(label, scope);
  expect(target.disabled, `"${label}" is enabled`).toBe(false);
  await act(async () => { target.click(); });
  await settle();
}
const topScreenNode = (): Element => { const all = host.querySelectorAll('[data-screen]'); return all[all.length - 1] ?? host; };
/** Press the one control whose text contains `fragment` (an unlabelled card). */
async function pressContaining(fragment: string) {
  const hits = buttons().filter((b) => b.textContent?.includes(fragment));
  expect(hits, `exactly one control containing "${fragment}"`).toHaveLength(1);
  expect(hits[0]!.disabled).toBe(false);
  await act(async () => { hits[0]!.click(); });
  await settle();
}
async function pressTestId(id: string) {
  const el = host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`no element with testID ${id}`);
  expect(el.disabled, `${id} is enabled`).toBe(false);
  await act(async () => { el.click(); });
  await settle();
}

async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(MoverStack),
    }))));
  await settle(250);
}

beforeEach(() => {
  vi.clearAllMocks();
  wire.length = 0;
  pricing = guyanaList({ rider: 6000, taxi: 9000 });
  api.defaults.adapter = transport;
  rawAxios.length = 0;
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    rawAxios.push(`${String(config.method).toUpperCase()} ${config.url}`);
    return { config, status: 200, statusText: 'OK', headers: {}, data: {} };
  };
  useMoverPreview.getState().exitPreview();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  // Session teardown (an account switch in a test) settles on the fake transport first.
  await vi.dynamicImportSettled();
  api.defaults.adapter = originalAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  vi.restoreAllMocks();
  useMoverPreview.getState().exitPreview();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null });
});

// ---------------------------------------------------------------------------
// The entry in the document area, for each role.
// ---------------------------------------------------------------------------
describe('a mover whose documents are still being checked can preview their own dashboard', () => {
  it('a delivery rider sees "Preview your dashboard" at their documents and it opens the RIDER dashboard', async () => {
    signIn('RIDER');
    await mount();
    // The document area: vehicle saved, documents missing / in review / rejected.
    expect(text()).toContain('Start earning with Swift');
    expect(text()).toContain('Required steps');
    expect(text()).toContain('$6,000/week');

    await press('Preview your dashboard');

    expect(useMoverPreview.getState()).toMatchObject({ preview: true, kind: 'RIDER', origin: 'documents' });
    expect(routes()).toEqual(['MoverRoot']);
    // The REAL Home, rider face, fed the rider sample.
    expect(text()).toContain('Swift Rider');
    expect(text()).not.toContain('Swift Driver');
    expect(text()).toContain('This is a preview with sample numbers. Finish your documents to start earning.');
    expect(text()).toContain('8Jobs today');
    expect(text()).toContain('3 orders ready to collect — Sample Kitchen has 2');
    // Earned today, from the rider sample.
    expect(text()).toContain('$5,200');
  });

  it('a taxi driver sees "Preview your dashboard" at their documents and it opens the DRIVER dashboard', async () => {
    signIn('DRIVER');
    await mount();
    expect(text()).toContain('Start earning with Swift');
    expect(text()).toContain('$9,000/week');

    await press('Preview your dashboard');

    expect(useMoverPreview.getState()).toMatchObject({ preview: true, kind: 'DRIVER', origin: 'documents' });
    expect(text()).toContain('Swift Driver');
    expect(text()).not.toContain('Swift Rider');
    expect(text()).toContain('This is a preview with sample numbers. Finish your documents to start earning.');
    expect(text()).toContain('6Trips today');
    expect(text()).toContain('5 people waiting for a ride nearby');
  });

  it('the entry names the role the vehicle registers: a car is a taxi driver, a motorbike a delivery rider', async () => {
    signIn('DRIVER');
    await mount();
    expect(text()).toContain('See the taxi driver dashboard with sample numbers.');
    await act(async () => root.unmount());
    root = createRoot(host);
    queryClient.clear();
    signIn('RIDER');
    await mount();
    expect(text()).toContain('See the delivery rider dashboard with sample numbers.');
  });
});

// ---------------------------------------------------------------------------
// The rider preview through the real rider screens, with the live fee.
// ---------------------------------------------------------------------------
describe('the rider preview renders through the real rider screens', () => {
  it('Home, Account and Earnings show the rider sample and the rider fee read live from the price list', async () => {
    signIn('RIDER');
    pricing = guyanaList({ rider: 6000, taxi: 9000 });
    await mount();
    await press('Preview your dashboard');
    wire.length = 0;

    await press('Account');
    expect(routes()).toEqual(['MoverRoot', 'Account']);
    expect(pill('Rider')).toBe(true);
    expect(pill('Driver')).toBe(false);
    expect(topScreen()).toContain('Red Honda CG125');
    expect(topScreen()).toContain('Weekly fee · $6,000/week');
    // In the preview the account's real-world exits are replaced by the way back.
    expect(hasButton('Back to my documents')).toBe(true);
    expect(hasButton('Log out')).toBe(false);
    expect(hasButton('Switch app')).toBe(false);
    expect(hasButton('Get help')).toBe(false);

    await press('Earnings');
    expect(topScreen()).toContain('60 delivered this week');
    expect(cardWith('Your weekly fee')).toContain('$6,000/week');

    await press('All jobs');
    expect(topScreen()).toContain('Your jobs');
    expect(topScreen()).toContain('Sample Kitchen');

    // The real Documents screen shows the SAMPLE's finished checklist, never
    // the mover's own documents and never "steps unavailable".
    await act(async () => { navigation.navigate('MoverDocuments'); });
    await settle();
    expect(topScreen()).toContain('3 of 3 approved');
    expect(topScreen()).not.toContain('Verification steps unavailable');
    expect(topScreen()).not.toContain('NATIONAL_ID · PENDING');

    // The only thing the preview fetched is the public price list.
    expect(wire.map((r) => `${r.method} ${r.url}`).every((r) => r === 'GET /auth/pricing')).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('the delivery in progress opens the real active-job screen, and its next step writes nothing', async () => {
    const attempted = [vi.spyOn(riderApi, 'enRouteDelivery'), vi.spyOn(riderApi, 'handover'), vi.spyOn(riderApi, 'delivered'), vi.spyOn(riderApi, 'handback')];
    signIn('RIDER');
    await mount();
    await press('Preview your dashboard');
    wire.length = 0;

    await pressContaining('tap to manage');
    expect(routes()).toEqual(['MoverRoot', 'ActiveJob']);
    expect(text()).toContain('ORDER #SW-8872');
    expect(text()).toContain('Lamaha Gardens');
    await press("I'm on the way to the customer");

    for (const spy of attempted) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(useMoverPreview.getState().preview).toBe(true);
  });

  it('[DS624 S3] the emergency button in the preview says it calls no one, and it dials and records nothing', async () => {
    signIn('RIDER');
    await mount();
    await press('Preview your dashboard');
    await pressContaining('tap to manage');
    wire.length = 0;

    await press('Emergency — get help now');
    expect(text()).toContain('This is a preview: this button calls no one and Swift records nothing.');
    expect(text()).not.toContain('Swift also saves the alert');
    expect(hasButton('Yes — get help now')).toBe(false);
    await press('OK');

    expect(fx.openURL.mock.calls.filter(([url]) => String(url).startsWith('tel:'))).toEqual([]);
    expect(fx.sosMutate).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('the fee follows the price list: a re-price reaches the preview untouched', async () => {
    signIn('RIDER');
    pricing = guyanaList({ rider: 6500, taxi: 9000 });
    await mount();
    await press('Preview your dashboard');
    await press('Account');
    expect(topScreen()).toContain('Weekly fee · $6,500/week');
    expect(topScreen()).not.toContain('$6,000/week');
  });

  it('the taxi fee is the list’s taxi rate (8,000 once #1393 lands)', async () => {
    signIn('DRIVER');
    pricing = guyanaList({ rider: 6000, taxi: 8000 });
    await mount();
    await press('Preview your dashboard');
    await press('Account');
    expect(pill('Driver')).toBe(true);
    expect(topScreen()).toContain('Weekly fee · $8,000/week');
  });
});

// ---------------------------------------------------------------------------
// Leaving the preview.
// ---------------------------------------------------------------------------
describe('leaving the preview returns to the documents', () => {
  it('from deep inside the preview, the top pill lands on the documents with nothing of the preview left', async () => {
    signIn('RIDER');
    await mount();
    await press('Preview your dashboard');
    await press('Account');
    await press('Earnings');
    expect(routes()).toEqual(['MoverRoot', 'Account', 'Earnings']);

    await pressTestId('mover-preview-exit');

    expect(useMoverPreview.getState().preview).toBe(false);
    expect(useAuthStore.getState().intent).toBe('mover');
    expect(routes()).toEqual(['MoverRoot']);
    expect(text()).toContain('Start earning with Swift');
    expect(text()).toContain('Required steps');
    expect(text()).not.toContain('Swift Rider');
  });

  it('Home’s "Back to my documents" and the account row go back the same way', async () => {
    signIn('DRIVER');
    await mount();
    await press('Preview your dashboard');
    await pressTestId('mover-preview-back-to-documents');
    expect(useMoverPreview.getState().preview).toBe(false);
    expect(text()).toContain('Start earning with Swift');

    await press('Preview your dashboard');
    await press('Account');
    // The Account screen's own row (Home stays mounted under it).
    await press('Back to my documents', topScreenNode());
    expect(useMoverPreview.getState().preview).toBe(false);
    expect(routes()).toEqual(['MoverRoot']);
    expect(text()).toContain('Start earning with Swift');
  });

  it('the welcome screen’s "Preview the driver app" still exits to the welcome screen', async () => {
    useAuthStore.setState({ intent: 'mover', countryCode: 'GY' });
    useMoverPreview.getState().enterPreview('DRIVER');
    await mount();
    expect(text()).toContain('Swift Driver');
    await pressTestId('mover-preview-exit');
    expect(useMoverPreview.getState().preview).toBe(false);
    expect(useAuthStore.getState().intent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The preview cannot write, go online or take a job.
// ---------------------------------------------------------------------------
describe('nothing in the preview can be written', () => {
  // Two layers, each pinned: the screen never even calls the write (the
  // preview's no-op), and nothing reaches the wire (the transport backstop is
  // proven on its own in services/api.previewWriteGuard.test.ts).
  it('a signed-in driver in the preview: stop, the MMG link, the fee stop and the statement write nothing', async () => {
    const attempted = [
      vi.spyOn(driverApi, 'goOffline'), vi.spyOn(driverApi, 'updateProfile'), vi.spyOn(driverApi, 'cancelPendingMmgLink'),
      vi.spyOn(driverApi, 'setBillingMethod'), vi.spyOn(driverApi, 'earningsStatement'),
    ];
    signIn('DRIVER');
    useMoverPreview.getState().enterPreview('DRIVER');
    await mount();
    wire.length = 0;

    await press('Stop');
    await press('Account');
    await press('Save MMG link');
    await press('Stop weekly fee');
    await press('Earnings');
    await press('Get earnings statement');

    for (const spy of attempted) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(wire.map((r) => r.url)).not.toContain('/driver/earnings/statement');
    // Still the same signed-in account, still looking at the sample.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useMoverPreview.getState().preview).toBe(true);
  });

  it('a signed-in rider in the preview cannot change their real vehicle or go offline', async () => {
    const attempted = [vi.spyOn(partnerApi, 'changeVehicle'), vi.spyOn(riderApi, 'goOffline')];
    signIn('RIDER');
    useMoverPreview.getState().enterPreview('RIDER');
    await mount();
    wire.length = 0;
    await press('Stop');
    await press('Account');
    await press('Change vehicle');
    // The vehicle picker's row reads "<vehicle><hint>".
    await press('BicycleSmall deliveries');
    await press('Save new vehicle');
    for (const spy of attempted) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(rawAxios).toEqual([]);
  });
});
