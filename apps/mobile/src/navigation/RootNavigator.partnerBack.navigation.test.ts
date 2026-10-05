/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@swift/types';

// ---------------------------------------------------------------------------
// [Owner, 1 Oct, on his iPhone] "here you cant go back once you pick store" —
// and the same sign-up told him his ID was "Face-matched against your profile
// selfie" while the server's face-matching is switched off.
//
// Picking "Swift Business" (or "Swift Driver") puts that sign-up at the ROOT of
// the app: there is no screen behind it, so iOS has no swipe-back, Android's
// back button closes the app, and `intent` is persisted, so the next launch
// opens the same screen. Its header offered only "Switch app" and "Log out".
//
// REAL here: RootNavigator and its root stack, the business stack (VendorRoot,
// the List-your-business form and the waiting-for-approval checklist, the
// vendor header), the rider/driver stack (MoverRoot and the application), the
// profile-photo gate, the role switcher, the document checklist and its cards, the price card, the
// auth store with its persistence, the app's own `api` client and the hooks
// that read through it. Stand-ins: the customer app (a screen that opens the
// real role switcher, as Profile's "Earn with Swift" does), native drawing,
// native modules, and the HTTP transport — a synthetic server that records
// every request that reaches it.
//
// Android's back: React Navigation's native container answers the back button
// by popping a screen when one can be popped (useBackButton). Vitest loads its
// web build, which installs nothing, so `installContainerBack` registers that
// same handler; anything no handler takes is Android's default — the app goes
// to the background — and is counted. iOS's swipe-back: the system gesture
// only pops a screen that has one behind it; a swipe the app handles itself
// arrives through React Native's responder system as a PanResponder, so the
// stand-in records each mounted pan handler and `swipe` drives it the way the
// responder system does (ask on move, grant, release).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  backHandlers: [] as Array<() => boolean | null | undefined>,
  appBackgrounded: 0,
  pans: new Set<Record<string, any>>(),
  storage: new Map<string, string>(),
  toasts: [] as string[],
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const kids = (children: unknown) =>
    (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  /** A view carrying pan handlers is what the responder system asks while it is mounted. */
  function PanHost({ config, children }: { config: Record<string, any>; children: React.ReactNode }) {
    R.useEffect(() => {
      fx.pans.add(config);
      return () => { fx.pans.delete(config); };
    }, [config]);
    return R.createElement('div', { 'data-pan': 'true' }, children);
  }
  const View = ({ children, testID, accessibilityLabel, __pan }: any) => {
    const view = R.createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, kids(children));
    return __pan ? R.createElement(PanHost, { config: __pan, children: view }) : view;
  };
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, testID }: any) => R.createElement('div', {
    role: 'button', 'aria-label': accessibilityLabel, 'aria-disabled': disabled ? 'true' : undefined, 'data-testid': testID,
    onClick: disabled ? undefined : () => onPress?.(),
  }, kids(children));
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, KeyboardAvoidingView: View, Pressable, Image: () => null, RefreshControl: () => null, ActivityIndicator: () => null,
    TextInput: ({ value, placeholder }: any) => R.createElement('input', { value: value ?? '', placeholder, readOnly: true }),
    Modal: ({ visible, children }: any) => (visible ? R.createElement('div', null, children) : null),
    Platform: { get OS() { return fx.os; }, select: (options: any) => options[fx.os] ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, Vibration: { vibrate: () => undefined, cancel: () => undefined },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Linking: { openURL: async () => undefined, openSettings: async () => undefined, getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
    Share: { share: async () => undefined }, Alert: { alert: () => undefined }, TurboModuleRegistry: { get: () => null },
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean | null | undefined) => {
        fx.backHandlers.push(handler);
        return { remove: () => { const at = fx.backHandlers.lastIndexOf(handler); if (at >= 0) fx.backHandlers.splice(at, 1); } };
      },
    },
    PanResponder: { create: (config: Record<string, any>) => ({ panHandlers: { __pan: config } }) },
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
  const { View } = await import('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children,
    SafeAreaView: ({ children, edges: _edges, style: _style, ...rest }: any) => R.createElement(View as any, rest, children),
  };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: Object.assign(() => null, { glyphMap: {} }) }));
vi.mock('@swift/ui', () => {
  const token: unknown = new Proxy({}, { get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, radius: token, space: token, font: token, fontSize: token, withAlpha: () => '' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `partner-back-fixture-${++next}` }; });
vi.mock('expo-notifications', () => ({ addNotificationResponseReceivedListener: () => ({ remove() {} }), getLastNotificationResponseAsync: async () => null }));
vi.mock('expo-image-picker', () => ({ MediaTypeOptions: { Images: 'Images' } }));
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, async () => ({ granted: false })] }));
vi.mock('../kit/pressable-scale', async () => {
  const R = await import('react');
  return { PressableScale: ({ children, onPress }: any) => R.createElement('div', { role: 'button', onClick: onPress }, children) };
});
vi.mock('../modules/mover/surface', () => ({ withAlpha: () => '' }));
vi.mock('../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => fx.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fx.storage.set(key, value); },
    removeItem: (key: string) => { fx.storage.delete(key); },
  },
}));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope: () => undefined }));
vi.mock('../lib/analytics', () => ({ track: () => undefined }));
vi.mock('../lib/payLink', () => ({ openPayLink: async () => false }));
vi.mock('../services/push', () => ({ registerIfGranted: async () => undefined, preparePushTokenForLogout: async () => null }));
vi.mock('../services/attribution', () => ({ ensureFirstLaunchClaim: () => undefined, flushAttributedDestination: () => undefined }));
vi.mock('../services/socket', () => ({ connectSocket: () => undefined, getSocket: () => ({ connected: false }), disconnectSocket: () => undefined, reconnectSocketForStoreHandoff: () => undefined }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => undefined }));
vi.mock('../services/notification-priming', () => ({ maybePrimeNotifications: () => undefined }));
vi.mock('../hooks/useCustomerCountry', () => ({ useCustomerCountry: () => undefined }));
vi.mock('../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null }) }));
// The mover stack's GPS and job hooks are not under test; its verification
// hooks are the real ones, reading the synthetic server.
vi.mock('../hooks', async () => {
  const real = await import('../hooks/verification');
  return {
    useVerificationStatus: real.useVerificationStatus, useBecomePartner: real.useBecomePartner, useChangeVehicle: real.useChangeVehicle,
    useActiveJob: () => ({ data: null }), useBroadcastLocation: () => undefined, useMoverKind: () => ({ kind: 'RIDER', profile: null }),
  };
});
vi.mock('../kit/toast', () => ({ toast: { show: () => undefined, success: () => undefined, info: () => undefined, error: (message: string) => { fx.toasts.push(message); } } }));
vi.mock('../kit', async () => {
  const R = await import('react');
  // The stand-in View above: like the kit's Screen, it carries the props it is given (a pan handler).
  const { View } = await import('react-native');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const control = (label: string, onPress?: () => void, disabled?: boolean, testID?: string) => R.createElement('div', {
    role: 'button', 'aria-label': label, 'aria-disabled': disabled ? 'true' : undefined, 'data-testid': testID, onClick: disabled ? undefined : onPress,
  }, label);
  return {
    T: ({ children, onPress }: any) => R.createElement('span', onPress ? { role: 'button', onClick: onPress } : null, children),
    PopupTitle: ({ children }: any) => R.createElement('span', null, children),
    Screen: ({ children, style: _style, bleed: _bleed, ...rest }: any) => R.createElement(View as any, rest, children),
    Card: Box, DecorativeIcon: Box, Pictogram: () => null, IconChip: () => null, LoadingBlock: () => null, Spinner: () => null,
    Badge: ({ label }: any) => R.createElement('span', null, label),
    TonePill: ({ label }: any) => R.createElement('span', null, label),
    ErrorState: ({ message }: any) => R.createElement('div', null, message ?? 'Something went wrong'),
    EmptyState: ({ title, body }: any) => R.createElement('div', null, title, ' ', body),
    PillButton: ({ label, onPress, disabled, testID }: any) => control(label, onPress, disabled, testID),
    LinkText: ({ label, onPress }: any) => control(label, onPress),
    LabeledInput: ({ value, placeholder, onChangeText }: any) =>
      R.createElement('input', { placeholder, value: value ?? '', onInput: (event: any) => onChangeText?.(event.target.value), onChange: () => undefined }),
    PopupCard: ({ visible, children }: any) => (visible ? R.createElement('div', { role: 'dialog' }, children) : null),
    useLogoutConfirm: () => ({ requestLogout: () => undefined, logoutDialog: null }),
  };
});
vi.mock('../components/SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../components/StoreLocationPicker', () => ({ StoreLocationPicker: () => null }));
vi.mock('../components/onboarding/WentLive', () => ({ useWentLive: () => ({ celebrate: false, dismiss: () => undefined }), WentLivePopup: () => null }));

// --- The customer app: Profile's "Earn with Swift" opens the real role switcher.
vi.mock('./CustomerStack', async () => {
  const R = await import('react');
  const { RoleSwitcherSheet } = await import('../components/RoleSwitcherSheet');
  function SwiftApp() {
    const [open, setOpen] = R.useState(false);
    return R.createElement('section', { 'data-screen': 'customer' }, 'Swift home. ',
      R.createElement('div', { role: 'button', 'aria-label': 'Earn with Swift', onClick: () => setOpen(true) }, 'Earn with Swift'),
      R.createElement(RoleSwitcherSheet, { visible: open, current: 'customer', onClose: () => setOpen(false) }));
  }
  return { CustomerStack: SwiftApp };
});
vi.mock('./AuthStack', async () => { const R = await import('react'); return { AuthStack: () => R.createElement('div', null, 'Sign in') }; });
vi.mock('../screens/auth/RolePickerScreen', async () => { const R = await import('react'); return { RolePickerScreen: () => R.createElement('div', null, 'Welcome to Swift') }; });
vi.mock('../screens/QrOutcomeScreen', () => ({ QrOutcomeScreen: () => null }));
vi.mock('../modules/advertiser/AdvertiserStack', () => ({ AdvertiserStack: () => null }));
vi.mock('../modules/profile/screens/GetHelpScreen', async () => {
  const R = await import('react');
  return { GetHelpScreen: ({ route }: any) => R.createElement('section', { 'data-screen': 'help' }, `Get help: ${route?.params?.subject ?? ''}`) };
});
vi.mock('../modules/billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('../modules/vendor/NewOrderTakeover', () => ({ NewOrderTakeover: () => null }));
vi.mock('../modules/vendor/screens/VendorOps', () => ({ VendorOps: () => null }));
vi.mock('../modules/vendor/screens/VendorBillingSuspended', () => ({ VendorBillingSuspended: () => null }));
vi.mock('../modules/vendor/screens/VendorBulkImportScreen', () => ({ VendorBulkImportScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorCategoryReviewScreen', () => ({ VendorCategoryReviewScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorInsightsScreen', () => ({ VendorInsightsScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorItemEditorScreen', () => ({ VendorItemEditorScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorMenuScreen', () => ({ VendorMenuScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorOrderDetailScreen', () => ({ VendorOrderDetailScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorOrderHistoryScreen', () => ({ VendorOrderHistoryScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorScheduleScreen', () => ({ VendorScheduleScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorTierScreen', () => ({ VendorTierScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorMyQrScreen', () => ({ VendorMyQrScreen: () => null }));
vi.mock('../modules/vendor/screens/VendorAccountScreen', () => ({ VendorAccountScreen: () => null }));
vi.mock('../modules/mover/screens/MoverHomeScreen', () => ({ MoverHomeScreen: () => null }));
vi.mock('../modules/mover/screens/ActiveJobScreen', () => ({ ActiveJobScreen: () => null }));
vi.mock('../modules/mover/screens/EarningsScreen', () => ({ EarningsScreen: () => null }));
vi.mock('../modules/mover/screens/ClaimsScreen', () => ({ ClaimsScreen: () => null }));
vi.mock('../modules/mover/screens/JobHistoryScreen', () => ({ JobHistoryScreen: () => null }));
vi.mock('../modules/mover/screens/MoverAccountScreen', () => ({ MoverAccountScreen: () => null }));
vi.mock('../modules/mover/screens/MoverDocumentsScreen', () => ({ MoverDocumentsScreen: () => null }));
vi.mock('../modules/mover/screens/MoverVehicleScreen', () => ({ MoverVehicleScreen: () => null }));
vi.mock('../modules/chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../modules/safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: () => null }));
vi.mock('../modules/safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: () => null }));

import { BackHandler } from 'react-native';
import { useAuthStore } from '../stores/authStore';
import { useBusinessSetupDraft } from '../stores/businessSetupDraft';
import { useMoverPreview } from '../stores/moverPreview';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { useVendorPreview } from '../stores/vendorPreview';
import { api } from '../services/api';
import { queryClient } from '../lib/queryClient';
import { navigationRef } from './navigationRef';
import { RootNavigator } from './RootNavigator';

// ---------------------------------------------------------------------------
// The synthetic server
// ---------------------------------------------------------------------------
const PRICING = {
  countryCode: 'GY', currencyCode: 'GYD', currencySymbol: '$', isActive: true, trialDays: 14,
  movers: [
    { vehicleType: 'MOTORCYCLE', label: 'Motorbike', role: 'RIDER', band: 'STANDARD', tier: 'courier', rate: 5000, offered: true },
    { vehicleType: 'CAR', label: 'Car', role: 'DRIVER', band: 'STANDARD', tier: 'taxi', rate: 10000, offered: true },
  ],
  vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }, { minItems: 1000, tier: 'large', rate: 20000 }] },
  franchise: null,
};
const BUSINESS_DOCS = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
const MOVER_DOCS = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
const STORE_MAY = { id: 'store-may', name: 'May', status: 'PENDING_APPROVAL', vendorType: 'RESTAURANT' };
type Doc = { id: string; docType: string; status: string; createdAt: string; expiresAt: null; reviewNote: string | null };
const doc = (docType: string, status: string, reviewNote: string | null = null): Doc =>
  ({ id: `doc-${docType}`, docType, status, createdAt: '2026-10-01T18:40:00Z', expiresAt: null, reviewNote });

const server = {
  /** GET /vendor/profile: the owner and their stores, or the 403 an account with no business gets. */
  vendorProfile: { status: 200, data: { myRole: 'OWNER', vendors: [STORE_MAY] } as unknown },
  businessDocs: [] as Doc[],
  moverDocs: [] as Doc[],
  moverVehicle: null as string | null,
  /** Whatever else GET /verification/status carries (the face-match flag). */
  statusExtra: {} as Record<string, unknown>,
  /** A role switch the server refuses. */
  switchRefusal: null as null | { status: number; message: string },
};
type Request = { method: string; url: string; body?: unknown };
const wire: Request[] = [];
/** Every request that changed something on the server, in order. */
const writes = () => wire.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}${r.body === undefined ? '' : ` ${JSON.stringify(r.body)}`}`);

function respond(config: InternalAxiosRequestConfig, status: number, data: unknown) {
  const response = { config, status, statusText: String(status), headers: {}, data };
  if (status >= 200 && status < 300) return response;
  throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response as never);
}
async function transport(config: InternalAxiosRequestConfig) {
  const method = String(config.method ?? 'get').toUpperCase();
  const url = String(config.url ?? '');
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  wire.push({ method, url, ...(body === undefined ? {} : { body }) });
  if (method === 'GET' && url === '/vendor/profile') {
    return server.vendorProfile.status === 200
      ? respond(config, 200, { success: true, data: server.vendorProfile.data })
      : respond(config, server.vendorProfile.status, { success: false, error: { code: 'FORBIDDEN', message: 'This account cannot access this resource' } });
  }
  if (method === 'GET' && url === '/auth/pricing') return respond(config, 200, { success: true, data: PRICING });
  if (method === 'GET' && url === '/verification/status') {
    const role = (config.params as { role?: string } | undefined)?.role;
    const mover = role === 'MOVER';
    const checklist = mover ? MOVER_DOCS : BUSINESS_DOCS;
    const documents = mover ? server.moverDocs : server.businessDocs;
    return respond(config, 200, { success: true, data: {
      roleKey: role, trustLevel: 'L1', checklist, documents,
      missing: checklist.filter((t) => !documents.some((d) => d.docType === t && d.status === 'APPROVED')),
      vehicleType: mover ? server.moverVehicle : null, roleVerified: false, categoryUnavailable: false, trial: null,
      ...server.statusExtra,
    } });
  }
  if (method === 'POST' && url === '/customer/switch-role') {
    if (server.switchRefusal) {
      return respond(config, server.switchRefusal.status, { success: false, error: { code: 'ROLE_SWITCH_REFUSED', message: server.switchRefusal.message } });
    }
    const role = (body as { role: string }).role;
    const activeRole = role === 'VENDOR' ? 'VENDOR_OWNER' : role;
    return respond(config, 200, { success: true, data: { role, activeRole, lastMoverRole: role === 'RIDER' || role === 'DRIVER' ? role : useAuthStore.getState().user?.lastMoverRole ?? null } });
  }
  return respond(config, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

// ---------------------------------------------------------------------------
// The device
// ---------------------------------------------------------------------------
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let containerBack: { remove: () => void } | null = null;
const originalAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
const text = () => host.textContent ?? '';
async function settle(ms = 150) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }

/** What @react-navigation/native's native container installs: pop a screen when one can be popped. */
function installContainerBack() {
  containerBack ??= BackHandler.addEventListener('hardwareBackPress', () => {
    if (navigationRef.isReady() && navigationRef.canGoBack()) { navigationRef.goBack(); return true; }
    return false;
  });
}

async function launch() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(RootNavigator))));
  await settle(300);
  installContainerBack();
}

/** Close the app and open it again: a new process, the same phone storage. */
async function relaunch() {
  await act(async () => root.unmount());
  containerBack?.remove(); containerBack = null;
  queryClient.clear();
  useVendorPreview.getState().exitPreview();
  useMoverPreview.getState().exitPreview();
  useBusinessSetupDraft.getState().clear();
  // A new process starts from the store's initial state and reads the phone's
  // storage. (Resetting this test's store writes too — that write is not one
  // the closed app made, so the storage is put back first.)
  const disk = new Map(fx.storage);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  fx.storage.clear();
  for (const [key, value] of disk) fx.storage.set(key, value);
  await useAuthStore.persist.rehydrate();
  root = createRoot(host);
  await launch();
}

function controls(): HTMLElement[] { return Array.from(host.querySelectorAll<HTMLElement>('[role=button]')); }
function control(label: string): HTMLElement | undefined {
  return controls().find((b) => b.getAttribute('aria-label') === label) ?? controls().find((b) => b.textContent?.trim() === label);
}
async function press(label: string) {
  const target = control(label);
  if (!target) throw new Error(`no "${label}" on screen: ${text()}`);
  expect(target.getAttribute('aria-disabled'), `"${label}" can be pressed`).not.toBe('true');
  await act(async () => { target.click(); });
  await settle();
}
/** A card in the role switcher, by its title. */
async function pickApp(title: string) {
  const sheet = host.querySelector('[role=dialog]');
  if (!sheet) throw new Error(`the role switcher is not open: ${text()}`);
  const card = Array.from(sheet.querySelectorAll<HTMLElement>('[role=button]')).find((b) => b.querySelector('span')?.textContent === title);
  if (!card) throw new Error(`no "${title}" card in the switcher: ${sheet.textContent}`);
  await act(async () => { card.click(); });
  await settle(250);
}
async function type(placeholder: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!input) throw new Error(`no "${placeholder}" field: ${text()}`);
  await act(async () => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await settle();
}
/** Android's back (the button, or the edge gesture): newest handler first; nobody takes it → the app goes to the background. */
async function androidBack(): Promise<boolean> {
  let handled = false;
  await act(async () => {
    for (const handler of [...fx.backHandlers].reverse()) {
      if (handler()) { handled = true; break; }
    }
  });
  if (!handled) fx.appBackgrounded += 1;
  await settle(250);
  return handled;
}
/** A finger dragged across the screen, as React Native's responder system reports it to a pan handler. */
async function swipe({ fromX, dx, dy = 0, vx = 0.9 }: { fromX: number; dx: number; dy?: number; vx?: number }): Promise<number> {
  const at = { pageX: fromX + dx, pageY: 400 + dy, locationX: fromX + dx, locationY: 400 + dy, touches: [{}], changedTouches: [{}], timestamp: 1 };
  const event = { nativeEvent: at, touchHistory: { numberActiveTouches: 1 } };
  // Before the grant the responder system has reported the move only: x0 is not set yet (React Native's PanResponder).
  const moving = { stateID: 1, moveX: fromX + dx, moveY: 400 + dy, x0: 0, y0: 0, dx, dy, vx, vy: 0, numberActiveTouches: 1, _accountsForMovesUpTo: 1 };
  let claimed = 0;
  await act(async () => {
    for (const config of [...fx.pans]) {
      const ask = config['onMoveShouldSetPanResponderCapture'] ?? config['onMoveShouldSetPanResponder'];
      if (!ask?.(event, moving)) continue;
      claimed += 1;
      const granted = { ...moving, x0: fromX + dx, y0: 400 + dy };
      config['onPanResponderGrant']?.(event, granted);
      config['onPanResponderMove']?.(event, moving);
      config['onPanResponderRelease']?.(event, moving);
    }
  });
  await settle(250);
  return claimed;
}
const rootRoute = () => { const s = navigationRef.getRootState(); return s?.routes[s.index]?.name; };

function signIn(
  account: { id: string; roles: string[]; activeRole: string; lastMoverRole?: 'RIDER' | 'DRIVER' | null; selfie?: boolean },
  intent: 'customer' | 'vendor' | 'mover',
) {
  useAuthStore.getState().setAuth({
    id: account.id, firstName: 'May', lastName: 'Persaud', phone: '+5926001111', countryCode: 'GY',
    roles: account.roles, activeRole: account.activeRole, lastMoverRole: account.lastMoverRole ?? null,
    selfieCapturedAt: account.selfie === false ? null : '2026-09-28T10:00:00Z',
  } as unknown as User, 'synthetic-access', 'synthetic-refresh');
  useAuthStore.setState({ intent, countryCode: 'GY' });
}
/** The owner's account: a store, "May", waiting for approval, its owner ID uploaded and in review. */
async function ownerWaitingForApproval(documents: Doc[] = [doc('owner_national_id', 'PENDING')]) {
  server.vendorProfile = { status: 200, data: { myRole: 'OWNER', vendors: [STORE_MAY] } };
  server.businessDocs = documents;
  signIn({ id: 'owner-may', roles: ['CUSTOMER', 'VENDOR_OWNER'], activeRole: 'VENDOR_OWNER' }, 'vendor');
  await launch();
  expect(rootRoute()).toBe('Main');
  expect(text()).toContain('May');
  expect(text()).toContain('Required steps');
  expect(text()).toContain('Owner National ID');
  expect(text()).not.toContain('Swift home');
}
/** A rider with a saved motorbike and their national ID in review. */
async function riderApplying() {
  server.moverVehicle = 'MOTORCYCLE';
  server.moverDocs = [doc('national_id', 'PENDING')];
  signIn({ id: 'rider-rae', roles: ['CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' }, 'mover');
  await launch();
  expect(text()).toContain('Start earning with Swift');
  expect(text()).toContain('Vehicle saved');
  expect(text()).toContain('National ID');
  expect(text()).not.toContain('Swift home');
}
function expectOnSwift() {
  expect(useAuthStore.getState().intent).toBe('customer');
  expect(text()).toContain('Swift home');
  expect(text()).not.toContain('Required steps');
}

beforeEach(() => {
  wire.length = 0;
  fx.os = 'ios';
  fx.backHandlers.length = 0;
  fx.appBackgrounded = 0;
  fx.pans.clear();
  fx.storage.clear();
  fx.toasts.length = 0;
  Object.assign(server, {
    vendorProfile: { status: 200, data: { myRole: 'OWNER', vendors: [STORE_MAY] } },
    businessDocs: [], moverDocs: [], moverVehicle: null, statusExtra: {}, switchRefusal: null,
  });
  api.defaults.adapter = transport;
  // Session teardown uses raw axios: it must land here, never on a network.
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({ config, status: 200, statusText: 'OK', headers: {}, data: {} });
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useVendorPreview.getState().exitPreview();
  useMoverPreview.getState().exitPreview();
  useBusinessSetupDraft.getState().clear();
  useStoreSwitcher.getState().setSelectedStore(null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  containerBack?.remove(); containerBack = null;
  await vi.dynamicImportSettled();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  api.defaults.adapter = originalAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
});

// ---------------------------------------------------------------------------
describe('Swift Business: the sign-up has a way back to Swift', () => {
  it('"‹ Swift" in the header of a store waiting for approval goes back to ordering through the server’s own role switch, and the application stays', async () => {
    await ownerWaitingForApproval();
    const generation = useAuthStore.getState().sessionGeneration;

    await press('Back to Swift');

    expectOnSwift();
    // The one thing sent is the role switch the "Switch app" sheet sends.
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
    expect(useAuthStore.getState().user).toMatchObject({ activeRole: 'CUSTOMER' });
    // Never a log-out.
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, sessionGeneration: generation });

    // The store and its documents are where they were: back through Profile → Swift Business.
    await press('Earn with Swift');
    await pickApp('Swift Business');
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}', 'POST /customer/switch-role {"role":"VENDOR"}']);
    expect(useAuthStore.getState().intent).toBe('vendor');
    expect(text()).toContain('May');
    expect(text()).toContain('Owner National ID');
    expect(text()).toContain('In review');
  });

  it('Android’s back does the same — it no longer closes the app', async () => {
    fx.os = 'android';
    await ownerWaitingForApproval();

    expect(await androidBack(), 'the sign-up takes the back press').toBe(true);

    expect(fx.appBackgrounded).toBe(0);
    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
  });

  it('iPhone: a swipe from the left edge does the same', async () => {
    fx.os = 'ios';
    await ownerWaitingForApproval();

    expect(await swipe({ fromX: 8, dx: 160, dy: 6 }), 'the edge swipe is taken').toBe(1);

    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
  });

  it('control: scrolling, a short drag, or a swipe that starts mid-screen leaves the person where they are', async () => {
    fx.os = 'ios';
    await ownerWaitingForApproval();

    await swipe({ fromX: 8, dx: 4, dy: 220, vx: 0 }); // a scroll that starts at the edge
    await swipe({ fromX: 8, dx: 30, dy: 2, vx: 0.1 }); // a nudge, let go
    await swipe({ fromX: 180, dx: 160, dy: 4 }); // a swipe from the middle of the screen

    expect(useAuthStore.getState().intent).toBe('vendor');
    expect(text()).toContain('Required steps');
    expect(writes()).toEqual([]);
  });

  it('control: a screen opened on top keeps its own back — Android’s back closes it first', async () => {
    fx.os = 'android';
    await ownerWaitingForApproval([doc('owner_national_id', 'PENDING'), doc('business_registration', 'REJECTED', 'Blurry photo')]);

    await press('Think this is wrong? Appeal it');
    expect(text()).toContain('Get help: Appeal: Business Registration was rejected');

    expect(await androidBack()).toBe(true);

    expect(text()).toContain('Required steps');
    expect(useAuthStore.getState().intent).toBe('vendor');
    expect(writes()).toEqual([]);
  });

  it('the List-your-business form: "‹ Swift" goes back without losing what was typed', async () => {
    // A customer who opened "Swift Business" from Profile and has no store yet.
    server.vendorProfile = { status: 403, data: null };
    signIn({ id: 'customer-may', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' }, 'vendor');
    await launch();
    expect(text()).toContain('List your business');
    await type('Business name', 'May');

    await press('Back to Swift');

    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);

    await press('Earn with Swift');
    await pickApp('Swift Business');
    expect(text()).toContain('List your business');
    expect(host.querySelector<HTMLInputElement>('input[placeholder="Business name"]')?.value).toBe('May');
    // Joining a surface the account does not hold yet asks the server nothing.
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
  });

  it('a switch the server refuses keeps them on the application and says why', async () => {
    await ownerWaitingForApproval();
    server.switchRefusal = { status: 409, message: 'Finish the active order first.' };

    await press('Back to Swift');

    expect(fx.toasts).toEqual(['Finish the active order first.']);
    expect(useAuthStore.getState().intent).toBe('vendor');
    expect(text()).toContain('Required steps');
    expect(control('Back to Swift')?.getAttribute('aria-disabled'), 'and it can be tried again').not.toBe('true');
  });
});

describe('Swift Driver: the application has the same way back', () => {
  it('"‹ Swift" goes back to ordering; the saved vehicle and the documents stay', async () => {
    await riderApplying();
    const generation = useAuthStore.getState().sessionGeneration;

    await press('Back to Swift');

    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, sessionGeneration: generation });

    await press('Earn with Swift');
    await pickApp('Swift Driver');
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}', 'POST /customer/switch-role {"role":"RIDER"}']);
    expect(text()).toContain('Vehicle saved');
    expect(text()).toContain('National ID');
    expect(text()).toContain('In review');
  });

  it('Android’s back does the same', async () => {
    fx.os = 'android';
    await riderApplying();

    expect(await androidBack()).toBe(true);

    expect(fx.appBackgrounded).toBe(0);
    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
  });

  it('iPhone: a swipe from the left edge does the same', async () => {
    fx.os = 'ios';
    await riderApplying();

    expect(await swipe({ fromX: 10, dx: 150, dy: -4 })).toBe(1);

    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
  });
});

describe('a partner role picked by mistake: back to ordering and on to another one, never signing out', () => {
  it('business → Swift → Swift Driver → Swift, signed in throughout, the store untouched', async () => {
    await ownerWaitingForApproval();
    const generation = useAuthStore.getState().sessionGeneration;

    await press('Back to Swift');
    expectOnSwift();

    await press('Earn with Swift');
    await pickApp('Swift Driver'); // not held yet: the rider/driver application opens
    expect(useAuthStore.getState().intent).toBe('mover');
    expect(text()).toContain('Start earning with Swift');

    await press('Back to Swift');
    expectOnSwift();

    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, sessionGeneration: generation });
    // Nothing about the store or its documents was sent anywhere: only role switches.
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}', 'POST /customer/switch-role {"role":"CUSTOMER"}']);
  });
});

describe('the profile photo a partner sign-up asks for first is not a one-way door either', () => {
  /** A signed-in customer with no profile photo opens "Swift Business" from Profile: the photo comes first. */
  async function customerAtThePhotoStep() {
    server.vendorProfile = { status: 403, data: null };
    signIn({ id: 'customer-new', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', selfie: false }, 'customer');
    await launch();
    expect(text()).toContain('Swift home');
    await press('Earn with Swift');
    await pickApp('Swift Business');
    expect(rootRoute()).toBe('Selfie');
    expect(text()).toContain('Add your photo');
    expect(control('Sign out'), 'signing out is still offered').toBeDefined();
  }

  it('"‹ Swift" goes back to ordering without signing out', async () => {
    await customerAtThePhotoStep();
    const generation = useAuthStore.getState().sessionGeneration;

    await press('Back to Swift');

    expectOnSwift();
    expect(writes()).toEqual(['POST /customer/switch-role {"role":"CUSTOMER"}']);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, sessionGeneration: generation });
  });

  it('Android’s back does the same', async () => {
    fx.os = 'android';
    await customerAtThePhotoStep();

    expect(await androidBack()).toBe(true);

    expect(fx.appBackgrounded).toBe(0);
    expectOnSwift();
  });

  it('iPhone: a swipe from the left edge does the same', async () => {
    fx.os = 'ios';
    await customerAtThePhotoStep();

    expect(await swipe({ fromX: 6, dx: 140 })).toBe(1);

    expectOnSwift();
  });
});

describe('the next launch', () => {
  it('a store still waiting for approval reopens its checklist — with "‹ Swift" on screen', async () => {
    await ownerWaitingForApproval();

    await relaunch();

    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, intent: 'vendor' });
    expect(text()).toContain('Required steps');
    expect(control('Back to Swift'), 'the way back is on screen after a restart').toBeDefined();
  });

  it('after going back to Swift, the next launch opens Swift — and the store is one switch away, intact', async () => {
    await ownerWaitingForApproval();
    await press('Back to Swift');

    await relaunch();

    expectOnSwift();
    await press('Earn with Swift');
    await pickApp('Swift Business');
    expect(text()).toContain('May');
    expect(text()).toContain('Owner National ID');
    expect(text()).toContain('In review');
  });
});

// ---------------------------------------------------------------------------
// The face-match line. The server compares an identity document with the
// profile selfie only while its biometric switch is on (FD-D5), and it is off.
// The line may appear only where the server's own checklist says so.
// ---------------------------------------------------------------------------
const FACE_LINE = 'Face-matched against your profile selfie';
/** The document card for one document, by its title. */
function card(title: string): HTMLElement {
  const found = controls().find((b) => Array.from(b.querySelectorAll('span')).some((s) => s.textContent === title));
  if (!found) throw new Error(`no "${title}" card: ${text()}`);
  return found;
}

describe('the face-match line tells the truth', () => {
  it('with face-matching off — the server names no document — the business sign-up claims no face-match', async () => {
    await ownerWaitingForApproval();
    expect(text()).not.toContain(FACE_LINE);
  });

  it('with face-matching off, the rider/driver application claims none either', async () => {
    await riderApplying();
    expect(text()).not.toContain(FACE_LINE);
  });

  it('only a document the server names carries the line', async () => {
    server.statusExtra = { faceMatchDocTypes: ['owner_national_id'] };
    await ownerWaitingForApproval();

    expect(card('Owner National ID').textContent).toContain(FACE_LINE);
    for (const other of ['Business Registration', 'TIN Certificate', 'Storefront Photo']) {
      expect(card(other).textContent, other).not.toContain(FACE_LINE);
    }
    expect(text().split(FACE_LINE)).toHaveLength(2);
  });

  it.each<[string, unknown]>([
    ['true', true],
    ['a bare string', 'owner_national_id'],
    ['a list of the wrong things', [1, null, { docType: 'owner_national_id' }]],
    ['an object', { owner_national_id: true }],
  ])('a flag that is %s claims nothing', async (_label, flag) => {
    server.statusExtra = { faceMatchDocTypes: flag };
    await ownerWaitingForApproval();
    expect(text()).not.toContain(FACE_LINE);
  });
});
