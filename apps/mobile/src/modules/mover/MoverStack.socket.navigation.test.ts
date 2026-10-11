/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClientProvider } from '@tanstack/react-query';

// [AX449 #4] The REAL MoverStack stays mounted while the REAL tap-router routes
// a vendor notification, and the REAL store switcher and shared socket module
// hand the account's vendor selection to another store. The mover's live-offer
// hook (MoverHomeScreen's own useDispatchOffers('DRIVER', true) call) must keep
// receiving dispatch offers and withdrawals WITHOUT its kind or online state
// changing. Only native drawing, unrelated screens, authoritative reads and the
// socket transport are fakes. The transport keeps socket.io-client 4.8's own
// semantics: listeners live on the Socket instance across disconnect()/connect(),
// rooms and delivery belong to one connection.
type Handler = (payload?: unknown) => void;
const fx = vi.hoisted(() => {
  const sockets: Array<{
    connected: boolean; active: boolean; connections: number; sendBuffer: unknown[]; receiveBuffer: unknown[];
    on: (event: string, fn: Handler) => void; off: (event: string, fn: Handler) => void;
    emit: (event: string, payload?: unknown) => void; connect: () => void; disconnect: () => void;
    fire: (event: string, payload?: unknown) => void;
  }> = [];
  return {
    token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
    owner: { userId: 'owner', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' },
    profile: vi.fn(), order: vi.fn(), currentOffer: vi.fn(), offerSeen: vi.fn(),
    listener: undefined as undefined | ((response: unknown) => void),
    sockets,
    io: () => {
      const listeners = new Map<string, Set<Handler>>();
      const socket = {
        connected: false, active: false, connections: 0, sendBuffer: [] as unknown[], receiveBuffer: [] as unknown[],
        fire: (event: string, payload?: unknown) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(payload); },
        on: (event: string, fn: Handler) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
        off: (event: string, fn: Handler) => { listeners.get(event)?.delete(fn); },
        emit: () => undefined,
        connect: () => { if (socket.connected) return; socket.active = true; socket.connected = true; socket.connections++; socket.fire('connect'); },
        disconnect: () => { const was = socket.connected; socket.active = false; socket.connected = false; if (was) socket.fire('disconnect'); },
      };
      sockets.push(socket);
      return socket;
    },
    /** The server emits to this account's user room: every live connection. */
    server: (event: string, payload?: unknown) => { for (const s of sockets) if (s.connected) s.fire(event, payload); },
  };
});
vi.mock('../profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: 'PersonalDataScreen' }));
vi.mock('socket.io-client', () => ({ io: fx.io }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable: View, RefreshControl: View,
    Modal: ({ visible, children }: any) => visible ? R.createElement(View, null, children) : null,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, Vibration: { vibrate: vi.fn() }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) }, Share: { share: vi.fn() },
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
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { LoadingBlock: () => null, Screen: Box, T: Box };
});
vi.mock('../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../hooks', () => ({
  useActiveJob: () => ({ data: null }),
  useBroadcastLocation: () => undefined,
  useMoverKind: () => ({ kind: 'DRIVER', profile: { isOnline: true } }),
  useVerificationStatus: () => ({ data: { roleVerified: true }, isLoading: false }),
}));
vi.mock('../../stores/authStore', () => ({
  getAuthSessionSnapshot: () => ({ ...fx.owner }),
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ setIntent: vi.fn() }),
}));
vi.mock('../../services/api', () => {
  const offers = { currentOffer: fx.currentOffer, offerSeen: fx.offerSeen };
  return { API_URL: 'https://example.test', driverApi: offers, riderApi: offers, vendorApi: { profile: fx.profile, order: fx.order } };
});
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../../components/onboarding/WentLive', () => ({ useWentLive: () => ({ celebrate: false, dismiss: () => undefined }), WentLivePopup: () => null }));
vi.mock('../chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: () => null }));
vi.mock('../safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: () => null }));
vi.mock('./screens/ActiveJobScreen', () => ({ ActiveJobScreen: () => null }));
vi.mock('./screens/EarningsScreen', () => ({ EarningsScreen: () => null }));
vi.mock('./screens/ClaimsScreen', () => ({ ClaimsScreen: () => null }));
vi.mock('./screens/JobHistoryScreen', () => ({ JobHistoryScreen: () => null }));
vi.mock('./screens/MoverAccountScreen', () => ({ MoverAccountScreen: () => null }));
vi.mock('./screens/MoverDocumentsScreen', () => ({ MoverDocumentsScreen: () => null }));
vi.mock('./screens/MoverVehicleScreen', () => ({ MoverVehicleScreen: () => null }));
vi.mock('./screens/MoverOnboardingScreen', () => ({ MoverOnboardingScreen: () => null }));
// The home screen's map and sheet are native drawing; its live-offer hook is
// the real one, called exactly as MoverHomeScreen.tsx calls it.
vi.mock('./screens/MoverHomeScreen', async () => {
  const R = await import('react');
  const { useDispatchOffers } = await import('../../hooks/dispatchOffers');
  return {
    MoverHomeScreen: () => {
      const { offer } = useDispatchOffers('DRIVER', true);
      return R.createElement('output', null, offer?.orderId ?? '');
    },
  };
});

import { navigationRef as navigation } from '../../navigation/navigationRef';
import { installNotificationTapRouter } from '../../services/notification-router';
import { disconnectSocket } from '../../services/socket';
import { queryClient } from '../../lib/queryClient';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { MoverStack } from './MoverStack';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const profile = { myRole: 'OWNER', vendors: ['store-A', 'store-B'].map(id => ({ id, name: id, status: 'ACTIVE', vendorType: 'RESTAURANT' })) };
const vendorAlert = { kind: 'vendor_order_alert', orderId: 'order-B', vendorId: 'store-B' };
const response = (data: Record<string, unknown>) => ({ notification: { request: { content: { data } } } });
const card = () => host.querySelector('output')?.textContent;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); }); }

beforeEach(() => {
  vi.clearAllMocks();
  disconnectSocket(); fx.sockets.length = 0;
  queryClient.clear();
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  fx.profile.mockResolvedValue({ data: { data: profile } });
  fx.order.mockResolvedValue({ data: { data: { id: 'order-B', vendorId: 'store-B' } } });
  fx.currentOffer.mockResolvedValue({ data: { data: { offer: null } } });
  fx.offerSeen.mockResolvedValue({});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); queryClient.clear(); disconnectSocket(); });
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(MoverStack),
    }))));
  await settle();
  expect(navigation.getCurrentRoute()?.name).toBe('MoverRoot');
}

describe('R3 a vendor notification never strands the mounted mover’s live offers', () => {
  it('keeps dispatch offers and withdrawals reaching the mounted hook after the authorized store handoff', async () => {
    await mount();
    expect(fx.sockets).toHaveLength(1);
    expect(fx.sockets[0]!.connected).toBe(true);
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => fx.listener!(response(vendorAlert)));
      await settle();
      // The router validated membership and the order, then handed the vendor
      // selection to B while MoverStack stayed mounted, kind and online unchanged.
      expect(fx.order).toHaveBeenCalledOnce();
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
      expect(navigation.getCurrentRoute()?.name).toBe('MoverRoot');

      await act(async () => fx.server('dispatch:offer', { orderId: 'offer-1', offerAttemptId: 'attempt-1', expiresInSeconds: 30 }));
      expect(card(), 'a dispatch offer reaches the mounted mover').toBe('offer-1');
      await act(async () => fx.server('dispatch:offer_withdrawn', { orderId: 'offer-1', offerAttemptId: 'attempt-1' }));
      expect(card(), 'its withdrawal reaches it too').toBe('');
    } finally { uninstall(); }
  });

  it('recovers the live offer for the new connection, as after any reconnect', async () => {
    await mount();
    expect(fx.currentOffer).toHaveBeenCalledOnce();
    fx.currentOffer.mockResolvedValue({ data: { data: { offer: { orderId: 'recovered-1', offerAttemptId: 'attempt-9', expiresInSeconds: 30 } } } });
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => fx.listener!(response(vendorAlert)));
      await settle();
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
      expect(fx.currentOffer).toHaveBeenCalledTimes(2);
      expect(card()).toBe('recovered-1');
    } finally { uninstall(); }
  });
});
