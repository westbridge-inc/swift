/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { QueryClientProvider } from '@tanstack/react-query';

// Real NavigationContainer, native-stack's JS view, bottom-tabs, Account/QR
// screens, selection store and live-order/socket lifecycle. Only native
// drawing, unrelated screens, data reads and the socket transport are stubs.
// Tests never unmount an editor themselves; only afterEach tears down the root.
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  hours: [{ dayOfWeek: 0, openTime: '08:00', closeTime: '22:00', isClosed: false }],
  get: vi.fn(), post: vi.fn(),
  sockets: [] as Array<{
    connected: boolean; rooms: string[]; listeners: Map<string, Set<(payload?: unknown) => void>>;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>;
  }>,
}));
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
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native-svg', () => ({ SvgXml: () => null }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const Button = ({ label, onPress, disabled }: any) => R.createElement('button', { onClick: onPress, disabled }, label);
  return {
    Card: Box, Screen: Box, T: Box, PopupTitle: Box, TonePill: () => null, IconChip: () => null,
    LoadingBlock: () => null, ErrorState: () => null, Segmented: () => null,
    Chip: Button, PillButton: Button, SettingsRow: Button,
    PopupCard: ({ visible, children }: any) => visible ? R.createElement(Box, null, children) : null,
  };
});
vi.mock('./shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 0, DAY_LABELS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    catalogueMeta: () => ({ label: 'Menu', icon: 'list' }), safeVendorRole: (role: string) => role,
    prettyVendorType: (value: string) => value, fmtDate: () => '',
    TabHeader: () => null, SubHeader: () => null, VendorBillingNotice: () => null,
    InlineInput: ({ value, onChangeText }: any) => R.createElement('input', { value, onInput: (event: any) => onChangeText(event.target.value) }),
  };
});
vi.mock('../../kit/controls', () => ({ BrandSwitch: () => null }));
vi.mock('../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/images', () => ({ mediaUrl: () => null }));
vi.mock('../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../components/onboarding/WentLive', () => ({ useWentLive: () => ({}), WentLivePopup: () => null }));
vi.mock('../../components/onboarding/DocumentChecklist', () => ({ DocumentChecklist: () => null }));
vi.mock('../../components/MmgPayLinkCard', () => ({ MmgPayLinkCard: () => null }));
vi.mock('../../components/PublicCallNumberCard', () => ({ PublicCallNumberCard: () => null }));
vi.mock('../../components/StoreLocationPicker', () => ({ StoreLocationPicker: () => null }));
vi.mock('../../components/billing/BillingSurfaces', () => ({ BillingStopControl: () => null }));
vi.mock('../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn }) }));
vi.mock('../../hooks/verification', () => ({ useVerificationStatus: () => ({}) }));
vi.mock('../../hooks/partnerPricing', () => ({ usePartnerPricing: () => ({}) }));
vi.mock('../../stores/authStore', () => ({
  getAuthSessionSnapshot: () => ({ userId: 'owner', generation: 1 }),
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ isAuthenticated: true, user: { id: 'owner' } }),
}));
vi.mock('../../services/api', () => ({ API_URL: 'https://example.test', api: { get: fx.get, post: fx.post }, vendorApi: {}, vendorDiscoveryApi: {} }));
vi.mock('@tanstack/react-query', async (original) => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQuery: () => ({ data: undefined, isSuccess: false }),
}));
vi.mock('../../hooks/vendorops', async (original) => {
  const actual = await original<typeof import('../../hooks/vendorops')>();
  const { useStoreSwitcher } = await import('../../stores/storeSwitcher');
  const stores = ['store-A', 'store-B'].map(id => ({ id, name: id, status: 'ACTIVE', vendorType: 'RESTAURANT' }));
  return {
    ...actual,
    useVendorProfile: () => {
      const id = useStoreSwitcher(s => s.selectedStoreId);
      return { owner: { myRole: 'OWNER' }, myRole: 'OWNER', stores, store: stores.find(s => s.id === id), state: 'ready', isLoading: false };
    },
    useVendorHours: () => ({ data: fx.hours, isSuccess: true }),
  };
});
vi.mock('socket.io-client', () => ({ io: () => {
  const socket = {
    connected: false, rooms: [] as string[], listeners: new Map<string, Set<(payload?: unknown) => void>>(),
    connect: vi.fn(() => { socket.connected = true; }),
    disconnect: vi.fn(() => { socket.connected = false; }),
    emit: vi.fn((_event: string, { vendorId }: { vendorId: string }) => { socket.rooms.push(vendorId); }),
    on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
      if (!socket.listeners.has(event)) socket.listeners.set(event, new Set());
      socket.listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: (payload?: unknown) => void) => { socket.listeners.get(event)?.delete(listener); }),
  };
  fx.sockets.push(socket);
  return socket;
} }));
vi.mock('./NewOrderTakeover', async () => {
  const R = await import('react');
  return { NewOrderTakeover: ({ queue }: any) => R.createElement('output', null, queue.map((order: any) => order.orderId).join(',')) };
});
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('./screens/BusinessSetup', () => ({ BusinessSetup: () => null, VendorOnboarding: () => null }));
vi.mock('./screens/VendorOps', () => ({ VendorOps: () => null }));
vi.mock('./screens/VendorBillingSuspended', () => ({ VendorBillingSuspended: () => null }));
vi.mock('./screens/VendorBulkImportScreen', () => ({ VendorBulkImportScreen: () => null }));
vi.mock('./screens/VendorCategoryReviewScreen', () => ({ VendorCategoryReviewScreen: () => null }));
vi.mock('./screens/VendorInsightsScreen', () => ({ VendorInsightsScreen: () => null }));
vi.mock('./screens/VendorItemEditorScreen', () => ({ VendorItemEditorScreen: () => null }));
vi.mock('./screens/VendorMenuScreen', () => ({ VendorMenuScreen: () => null }));
vi.mock('./screens/VendorOrderDetailScreen', () => ({ VendorOrderDetailScreen: () => null }));
vi.mock('./screens/VendorOrderHistoryScreen', () => ({ VendorOrderHistoryScreen: () => null }));
vi.mock('./screens/VendorScheduleScreen', () => ({ VendorScheduleScreen: () => null }));
vi.mock('./screens/VendorTierScreen', () => ({ VendorTierScreen: () => null }));

import { VendorStack } from './VendorStack';
import { queryClient } from '../../lib/queryClient';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { disconnectSocket } from '../../services/socket';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
type TestRoutes = { VendorRoot: { screen: 'Account' } | undefined; VendorMyQr: undefined };
const navigation = createNavigationContainerRef<TestRoutes>();
const qr = { shortCode: 'qr-A', shortUrl: 'https://example.test/q/qr-A', svg: '<svg/>', vendorName: 'A', version: 1, graceDays: 7 };
beforeEach(() => {
  vi.clearAllMocks();
  disconnectSocket(); fx.sockets.length = 0;
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0 });
  fx.get.mockImplementation(async (url: string) => ({ data: { data: url.startsWith('/public/') ? { verdict: 'WEB_RENDER', vendorId: 'store-A' } : url.includes('analytics') ? { totals: { scans: 0, approxUniqueScanners: 0, installsAttributed: 0 } } : qr } }));
  fx.post.mockResolvedValue({ data: {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); queryClient.clear(); disconnectSocket(); });
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(NavigationContainer<TestRoutes>, {
      ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(VendorStack),
    }))));
  expect(navigation.isReady()).toBe(true);
}
async function openAccount() { await act(async () => navigation.navigate('VendorRoot', { screen: 'Account' })); }
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(el => el.textContent === label);
  expect(found, label).toBeDefined(); return found!;
}

describe('SX383 real navigation container and vendor handoffs', () => {
  it('reconnects A after a batched A → B → A and receives a new order', async () => {
    await mount();
    const oldSocket = fx.sockets.at(-1)!;
    expect(oldSocket.connected).toBe(true);
    await act(async () => {
      useStoreSwitcher.getState().setSelectedStore('store-B');
      useStoreSwitcher.getState().setSelectedStore('store-A');
    });
    const liveSocket = fx.sockets.at(-1)!;
    expect(oldSocket.connected).toBe(false);
    expect(liveSocket.connected).toBe(true);
    expect(liveSocket).not.toBe(oldSocket);
    expect(liveSocket.rooms).toContain('store-A');
    expect(oldSocket.listeners.get('order:new')?.size).toBe(0);
    await act(async () => {
      if (liveSocket.connected) for (const listener of liveSocket.listeners.get('order:new') ?? []) listener({ orderId: 'new-A-order' });
    });
    expect(host.querySelector('output')?.textContent).toBe('new-A-order');
  });

  it('the real navigator retires the open Account editor and its dirty draft', async () => {
    await mount(); await openAccount();
    const oldRoute = navigation.getCurrentRoute()!;
    expect(oldRoute.name).toBe('Account');
    const oldInput = host.querySelector<HTMLInputElement>('input[value="08:00"]')!;
    expect(oldInput.value).toBe('08:00');
    await act(async () => {
      oldInput.value = '03:17'; oldInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(oldInput.value).toBe('03:17');
    expect(oldInput.getAttribute('value')).toBe('03:17');
    // Both stores deliberately return the same hours object: a data change
    // cannot reseed the draft and conceal a missing navigator retirement.
    await act(async () => useStoreSwitcher.getState().setSelectedStore('store-B'));
    expect(oldInput.isConnected).toBe(false);
    expect(navigation.getCurrentRoute()!.name).toBe('Orders');
    await openAccount();
    expect(navigation.getCurrentRoute()!.key).not.toBe(oldRoute.key);
    const newInput = host.querySelector<HTMLInputElement>('input[value="08:00"]')!;
    expect(newInput).not.toBe(oldInput);
    expect(newInput.value).toBe('08:00');
  });

  it.each([
    ['Replace code', '/vendor/qr/regenerate', false], ['Turn off', '/vendor/qr/deactivate', false],
    ['Replace code', '/vendor/qr/regenerate', true], ['Turn off', '/vendor/qr/deactivate', true],
  ] as const)('retires %s (%s) during preflight (round trip=%s)', async (label, _endpoint, roundTrip) => {
    await mount();
    await act(async () => navigation.navigate('VendorMyQr'));
    await act(async () => button(label === 'Replace code' ? 'Replace your QR code' : 'Turn off this QR code').click());
    let finish!: (value: unknown) => void;
    fx.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => button(label).click());
    expect(finish).toBeTypeOf('function');
    expect(fx.get).toHaveBeenLastCalledWith('/vendor/qr', { headers: { 'x-vendor-id': 'store-A' } });
    await act(async () => {
      useStoreSwitcher.getState().setSelectedStore('store-B');
      if (roundTrip) useStoreSwitcher.getState().setSelectedStore('store-A');
    });
    await act(async () => finish({ data: { data: qr } }));
    expect(fx.post).not.toHaveBeenCalled();
  });
});
