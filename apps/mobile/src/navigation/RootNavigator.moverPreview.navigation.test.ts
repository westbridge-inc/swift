/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { User } from '@swift/types';

// [DS624 S2] A rider previewing their dashboard from their documents is signed
// in for real, and while the preview is on screen the app client refuses every
// write. A store link (or a notification, or a payment return) takes them OUT
// of the preview to real things — a storefront with a real cart — so the
// preview must end on the way out, or their real order is refused as "a
// preview".
//
// REAL: RootNavigator and its root stack, the MoverStack (its preview banner
// and keyed group), the deep-link router, the notification tap-router,
// navigationRef, the auth and preview stores and the app's `api` client with
// its write guard. Stand-ins: the screens at the ends of each route (they make
// their writes through the real `api` client), native modules, and the HTTP
// transport, which records what reached the server.
const fx = vi.hoisted(() => ({
  linkListeners: [] as Array<(event: { url: string }) => void>,
  tapListener: undefined as undefined | ((response: unknown) => void),
  openURL: vi.fn(async () => undefined),
  storage: new Map<string, string>(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const kids = (children: unknown) => (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  const View = ({ children, testID }: any) => R.createElement('div', testID ? { 'data-testid': testID } : null, kids(children));
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, testID }: any) => R.createElement('button', {
    type: 'button', disabled: !!disabled, 'aria-label': accessibilityLabel, 'data-testid': testID,
    onClick: disabled ? undefined : () => onPress?.(),
  }, kids(children));
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Pressable, Image: () => null, RefreshControl: () => null, ActivityIndicator: () => null,
    Modal: ({ visible, children }: any) => (visible ? R.createElement('div', null, children) : null),
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, Vibration: { vibrate: () => undefined },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Linking: {
      openURL: fx.openURL,
      getInitialURL: async () => null,
      addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
        fx.linkListeners.push(listener);
        return { remove: () => { fx.linkListeners = fx.linkListeners.filter((l) => l !== listener); } };
      },
    },
    Share: { share: async () => undefined }, Alert: { alert: () => undefined },
    TurboModuleRegistry: { get: () => null },
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
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `root-preview-fixture-${++next}` }; });
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => { fx.tapListener = listener; return { remove: () => { fx.tapListener = undefined; } }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => fx.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fx.storage.set(key, value); },
    removeItem: (key: string) => { fx.storage.delete(key); },
  },
}));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope: () => undefined }));
vi.mock('../lib/analytics', () => ({ track: () => undefined }));
vi.mock('../services/push', () => ({ registerIfGranted: async () => undefined, preparePushTokenForLogout: async () => null }));
vi.mock('../services/attribution', () => ({ ensureFirstLaunchClaim: () => undefined, flushAttributedDestination: () => undefined }));
vi.mock('../services/socket', () => ({ connectSocket: () => undefined, getSocket: () => null, disconnectSocket: () => undefined }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => undefined }));
vi.mock('../hooks/useCustomerCountry', () => ({ useCustomerCountry: () => undefined }));
vi.mock('../kit/toast', () => ({ toast: { show: () => undefined, error: () => undefined, success: () => undefined } }));
vi.mock('../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { T: ({ children }: any) => R.createElement('span', null, children), Screen: Box, LoadingBlock: () => null };
});
vi.mock('../components/onboarding/WentLive', () => ({ useWentLive: () => ({ celebrate: false, dismiss: () => undefined }), WentLivePopup: () => null }));
// The mover hooks are not under test here: an unverified rider, read from the server.
vi.mock('../hooks', () => ({
  useActiveJob: () => ({ data: null }),
  useBroadcastLocation: () => undefined,
  useMoverKind: () => ({ kind: 'RIDER', profile: null }),
  useVerificationStatus: () => ({ data: { roleVerified: false }, isLoading: false }),
}));

// --- The screens at the end of each route. Their writes go through the REAL client.
vi.mock('./CustomerStack', async () => {
  const R = await import('react');
  const { customerApi } = await import('../services/api');
  function Storefront({ route }: any) {
    const vendorId = route?.params?.params?.vendorId ?? 'none';
    const [said, setSaid] = R.useState('');
    const attempt = (label: string, write: () => Promise<unknown>) => () => {
      write().then(() => setSaid((s) => `${s}${label}: saved. `), (e: { message?: string }) => setSaid((s) => `${s}${label}: ${e?.message ?? 'failed'}. `));
    };
    return R.createElement('section', { 'data-screen': 'storefront' },
      `Storefront ${vendorId}. `,
      R.createElement('button', { type: 'button', onClick: attempt('cart', () => customerApi.addToCart({ vendorId, menuItemId: 'item-1', quantity: 1 } as never)) }, 'Add to cart'),
      R.createElement('button', { type: 'button', onClick: attempt('tip', () => customerApi.setCartTip(500)) }, 'Tip the rider'),
      said);
  }
  return { CustomerStack: Storefront };
});
vi.mock('./AuthStack', async () => { const R = await import('react'); return { AuthStack: () => R.createElement('div', null, 'Sign in') }; });
vi.mock('../screens/auth/RolePickerScreen', async () => { const R = await import('react'); return { RolePickerScreen: () => R.createElement('div', null, 'Welcome to Swift') }; });
vi.mock('../screens/auth/SelfieCaptureScreen', async () => { const R = await import('react'); return { SelfieCaptureScreen: () => R.createElement('div', null, 'Selfie') }; });
vi.mock('../screens/QrOutcomeScreen', async () => {
  const R = await import('react');
  return { QrOutcomeScreen: ({ route }: any) => R.createElement('section', { 'data-screen': 'qr' }, `QR outcome: ${route?.params?.reason}`) };
});
vi.mock('../modules/vendor/VendorStack', async () => { const R = await import('react'); return { VendorStack: () => R.createElement('div', null, 'Business') }; });
vi.mock('../modules/advertiser/AdvertiserStack', async () => { const R = await import('react'); return { AdvertiserStack: () => R.createElement('div', null, 'Ads') }; });
vi.mock('../modules/mover/screens/MoverHomeScreen', async () => { const R = await import('react'); return { MoverHomeScreen: () => R.createElement('div', null, 'Sample dashboard') }; });
vi.mock('../modules/mover/screens/MoverOnboardingScreen', async () => { const R = await import('react'); return { MoverOnboardingScreen: () => R.createElement('div', null, 'My documents') }; });
vi.mock('../modules/mover/screens/MoverAccountScreen', async () => { const R = await import('react'); return { MoverAccountScreen: () => R.createElement('div', null, 'Account') }; });
vi.mock('../modules/billing/screens/WeeklyFeeRouteScreen', async () => { const R = await import('react'); return { WeeklyFeeRouteScreen: () => R.createElement('div', null, 'Weekly fee page') }; });
vi.mock('../modules/profile/screens/GetHelpScreen', async () => {
  const R = await import('react');
  const { customerApi } = await import('../services/api');
  function GetHelp({ route }: any) {
    const [said, setSaid] = R.useState('');
    const send = () => {
      customerApi.createTicket({ category: route?.params?.category ?? 'OTHER', subject: route?.params?.subject ?? 'Help', message: 'Please call me.' })
        .then(() => setSaid('Sent to support.'), (e: { message?: string }) => setSaid(e?.message ?? 'failed'));
    };
    return R.createElement('section', { 'data-screen': 'help' }, `Get help: ${route?.params?.subject ?? ''}. `,
      R.createElement('button', { type: 'button', onClick: send }, 'Send to support'), said);
  }
  return { GetHelpScreen: GetHelp };
});
vi.mock('../modules/mover/screens/ActiveJobScreen', () => ({ ActiveJobScreen: () => null }));
vi.mock('../modules/mover/screens/EarningsScreen', () => ({ EarningsScreen: () => null }));
vi.mock('../modules/mover/screens/ClaimsScreen', () => ({ ClaimsScreen: () => null }));
vi.mock('../modules/mover/screens/JobHistoryScreen', () => ({ JobHistoryScreen: () => null }));
vi.mock('../modules/mover/screens/MoverDocumentsScreen', () => ({ MoverDocumentsScreen: () => null }));
vi.mock('../modules/mover/screens/MoverVehicleScreen', () => ({ MoverVehicleScreen: () => null }));
vi.mock('../modules/chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../modules/safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: () => null }));
vi.mock('../modules/safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: () => null }));

import { useAuthStore } from '../stores/authStore';
import { useMoverPreview } from '../stores/moverPreview';
import { api } from '../services/api';
import { navigationRef } from './navigationRef';
import { RootNavigator } from './RootNavigator';

// ---------------------------------------------------------------------------
type Wire = { method: string; url: string };
const wire: Wire[] = [];
const writes = () => wire.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`);
const SHORT_CODE = 'bcdfghjk23';
/** The router sends a printed code upper-cased (lib/deepLinkParse). */
const SERVER_CODE = SHORT_CODE.toUpperCase();
let qrVerdict: { verdict: string; vendorId?: string | null } = { verdict: 'WEB_RENDER', vendorId: 'vendor-sk' };

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
  if (url === '/public/storefronts/sample-kitchen') return respond(config, 200, { success: true, data: { id: 'vendor-sk' } });
  if (url === `/public/qr/${SERVER_CODE}`) return respond(config, 200, { success: true, data: qrVerdict });
  return respond(config, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
const text = () => host.textContent ?? '';
async function settle(ms = 120) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
/** The root route on screen, and the mover stack's own routes underneath it. */
const rootRoute = () => { const s = navigationRef.getRootState(); return s?.routes[s.index]?.name; };
const moverRoutes = () => {
  const main = navigationRef.getRootState()?.routes.find((r) => r.name === 'Main');
  return (main?.state?.routes ?? []).map((r) => r.name);
};
async function press(label: string) {
  const target = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  if (!target) throw new Error(`no button "${label}" in: ${text()}`);
  expect(target.disabled, `"${label}" is enabled`).toBe(false);
  await act(async () => { target.click(); });
  await settle();
}
/** The OS hands the app a link (the same listener a real tap reaches). */
async function openLink(url: string) {
  expect(fx.linkListeners.length, 'the deep-link router is installed').toBe(1);
  await act(async () => { for (const listener of fx.linkListeners) listener({ url }); });
  await settle(250);
}
/** The person taps a notification (the same listener a real tap reaches). */
async function tapNotification(data: Record<string, unknown>) {
  expect(fx.tapListener, 'the tap-router is installed').toBeDefined();
  await act(async () => { fx.tapListener!({ notification: { request: { content: { data } } } }); });
  await settle(250);
}

function signedInRider() {
  useAuthStore.getState().setAuth({
    id: 'rider-1', firstName: 'Rae', lastName: 'Persaud', phone: '+5926000001', countryCode: 'GY',
    roles: ['CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER',
    selfieCapturedAt: '2026-09-28T10:00:00Z',
  } as unknown as User, 'synthetic-access', 'synthetic-refresh');
  useAuthStore.setState({ intent: 'mover', countryCode: 'GY' });
}
/** A rider at their documents opened "Preview your dashboard". */
async function riderPreviewingFromDocuments() {
  signedInRider();
  useMoverPreview.getState().enterPreview('RIDER', 'documents');
  await act(async () => root.render(React.createElement(RootNavigator)));
  await settle(250);
  expect(rootRoute()).toBe('Main');
  expect(text()).toContain('Sample dashboard');
  expect(text()).toContain('Preview · Back to documents');
}

beforeEach(() => {
  wire.length = 0;
  qrVerdict = { verdict: 'WEB_RENDER', vendorId: 'vendor-sk' };
  api.defaults.adapter = transport;
  // Session teardown uses raw axios: it must land here, never on a network.
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({ config, status: 200, statusText: 'OK', headers: {}, data: {} });
  useMoverPreview.getState().exitPreview();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null, wantsAuth: false });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await vi.dynamicImportSettled();
  useMoverPreview.getState().exitPreview();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null, wantsAuth: false });
  api.defaults.adapter = originalAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
});

describe('a link out of the preview ends it, so real customer writes go through', () => {
  it('a store link opens the storefront, the preview ends, and the cart and the tip reach the server', async () => {
    await riderPreviewingFromDocuments();

    await openLink('https://swiftgy.com/store/sample-kitchen');
    expect(rootRoute()).toBe('Storefront');
    expect(text()).toContain('Storefront vendor-sk');

    await press('Add to cart');
    await press('Tip the rider');
    expect(text()).toContain('cart: saved.');
    expect(text()).toContain('tip: saved.');
    expect(writes()).toEqual(['POST /customer/cart/items', 'PUT /customer/cart/tip']);
    expect(useMoverPreview.getState().preview).toBe(false);

    // Closing the store lands on the rider's own documents, not the sample.
    await act(async () => { navigationRef.goBack(); });
    await settle();
    expect(rootRoute()).toBe('Main');
    expect(text()).toContain('My documents');
    expect(text()).not.toContain('Sample dashboard');
    expect(useAuthStore.getState().intent).toBe('mover');
  });

  it('a printed QR code reports its app-open and opens the store with the preview ended', async () => {
    await riderPreviewingFromDocuments();

    await openLink(`https://swiftgy.com/s/${SHORT_CODE}`);

    expect(rootRoute()).toBe('Storefront');
    expect(writes()).toEqual([`POST /public/qr/${SERVER_CODE}/app-open`]);
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('a code that opens no store lands on the QR outcome with the preview ended', async () => {
    qrVerdict = { verdict: 'UNAVAILABLE_PAGE', vendorId: null };
    await riderPreviewingFromDocuments();

    await openLink(`https://swiftgy.com/s/${SHORT_CODE}`);

    expect(rootRoute()).toBe('QrOutcome');
    expect(text()).toContain('QR outcome: unavailable');
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('a guest looking at the sample driver app who opens a store link leaves it for the welcome screen', async () => {
    useAuthStore.setState({ intent: 'mover', countryCode: 'GY' });
    useMoverPreview.getState().enterPreview('DRIVER');
    await act(async () => root.render(React.createElement(RootNavigator)));
    await settle(250);
    expect(text()).toContain('Sample dashboard');

    await openLink('https://swiftgy.com/store/sample-kitchen');

    expect(rootRoute()).toBe('Storefront');
    expect(useMoverPreview.getState().preview).toBe(false);
    expect(useAuthStore.getState().intent).toBeNull();
    await act(async () => { navigationRef.goBack(); });
    await settle();
    expect(text()).toContain('Welcome to Swift');
  });
});

describe('a notification or a payment return is about the real account, never the sample', () => {
  it('a tap that opens Get help ends the preview first, and the request reaches support', async () => {
    await riderPreviewingFromDocuments();

    await tapNotification({ kind: 'liveness_locked' });

    expect(useMoverPreview.getState().preview).toBe(false);
    expect(moverRoutes()).toEqual(['MoverRoot', 'GetHelp']);
    expect(text()).toContain('Get help: Identity check locked my account.');
    await press('Send to support');
    expect(text()).toContain('Sent to support.');
    expect(writes()).toEqual(['POST /customer/support']);
  });

  it('an MMG payment return ends the preview and opens the real weekly-fee page', async () => {
    await riderPreviewingFromDocuments();

    await openLink('swift://pay/mmg/return');

    expect(useMoverPreview.getState().preview).toBe(false);
    expect(moverRoutes()).toEqual(['MoverRoot', 'WeeklyFee']);
    expect(text()).toContain('Weekly fee page');
  });
});

// Backstops for paths that do not end the preview themselves (none exists
// today besides the routers above): the preview lives only in the mover app.
describe('backstop: the preview lives only inside the mover app', () => {
  it('any root screen but the mover app ends it', async () => {
    await riderPreviewingFromDocuments();
    await act(async () => { navigationRef.navigate('QrOutcome', { reason: 'offline' }); });
    await settle();
    expect(rootRoute()).toBe('QrOutcome');
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('another app taking over ends it', async () => {
    await riderPreviewingFromDocuments();
    await act(async () => { useAuthStore.getState().setIntent('customer'); });
    await settle();
    expect(rootRoute()).toBe('Main');
    expect(useMoverPreview.getState().preview).toBe(false);
  });
});

describe('control: moving around inside the preview keeps it', () => {
  it('opening the sample account keeps the preview on screen', async () => {
    await riderPreviewingFromDocuments();
    await act(async () => { navigationRef.navigate('Account' as never); });
    await settle();
    expect(moverRoutes()).toEqual(['MoverRoot', 'Account']);
    expect(useMoverPreview.getState().preview).toBe(true);
    expect(text()).toContain('Preview · Back to documents');
  });
});
