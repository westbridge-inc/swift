/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClientProvider } from '@tanstack/react-query';

// Real NavigationContainer, native-stack's JS view, bottom-tabs, Account/QR
// screens, selection store and live-order/socket lifecycle. Only native
// drawing, unrelated screens, data reads and the socket transport are stubs.
// Tests never unmount an editor themselves; only afterEach tears down the root.
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  hours: [{ dayOfWeek: 0, openTime: '08:00', closeTime: '22:00', isClosed: false }],
  get: vi.fn(), post: vi.fn(), profile: vi.fn(), order: vi.fn(), subscription: vi.fn(),
  realProfile: false, owner: { userId: 'owner', generation: 1 },
  listener: undefined as undefined | ((response: any) => void), cold: null as any, lastResponse: vi.fn(),
  sockets: [] as Array<{
    connected: boolean; active: boolean; connections: number; rooms: Set<string>;
    sendBuffer: Array<[string, any]>; receiveBuffer: unknown[];
    listeners: Map<string, Set<(payload?: unknown) => void>>; fire: (event: string, payload?: unknown) => void;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('../profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: 'PersonalDataScreen' }));
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
  getAuthSessionSnapshot: () => ({ ...fx.owner }),
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ isAuthenticated: true, user: { id: 'owner' } }),
}));
vi.mock('../../services/api', () => ({ API_URL: 'https://example.test', api: { get: fx.get, post: fx.post }, vendorApi: { profile: fx.profile, order: fx.order, subscription: fx.subscription }, vendorDiscoveryApi: {} }));
vi.mock('@tanstack/react-query', async (original) => {
  const actual = await original<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: (options: any) => fx.realProfile && options.queryKey[1] === 'profile'
    ? actual.useQuery(options) : ({ data: undefined, isSuccess: false }) };
});
vi.mock('../../hooks/vendorops', async (original) => {
  const actual = await original<typeof import('../../hooks/vendorops')>();
  const { useStoreSwitcher } = await import('../../stores/storeSwitcher');
  const stores = ['store-A', 'store-B'].map(id => ({ id, name: id, status: 'ACTIVE', vendorType: 'RESTAURANT' }));
  return {
    ...actual,
    useVendorProfile: () => {
      const actualProfile = actual.useVendorProfile();
      const id = useStoreSwitcher(s => s.selectedStoreId);
      if (fx.realProfile) return actualProfile;
      return { owner: { myRole: 'OWNER' }, myRole: 'OWNER', stores, store: stores.find(s => s.id === id), state: 'ready', isLoading: false };
    },
    useVendorHours: () => ({ data: fx.hours, isSuccess: true }),
  };
});
// socket.io-client 4.8 semantics: listeners live on the Socket instance across
// disconnect()/connect(); server rooms belong to ONE connection; emits made
// while disconnected wait in sendBuffer for the next connect. Real sockets
// connect asynchronously; firing 'connect' synchronously here is the worst
// case, a reconnect that lands before React has retired the old layers.
vi.mock('socket.io-client', () => ({ io: () => {
  const socket = {
    connected: false, active: false, connections: 0, rooms: new Set<string>(),
    sendBuffer: [] as Array<[string, any]>, receiveBuffer: [] as unknown[],
    listeners: new Map<string, Set<(payload?: unknown) => void>>(),
    fire: (event: string, payload?: unknown) => { for (const listener of [...(socket.listeners.get(event) ?? [])]) listener(payload); },
    connect: vi.fn(() => {
      if (socket.connected) return;
      socket.active = true; socket.connected = true; socket.connections++;
      for (const [, payload] of socket.sendBuffer.splice(0)) socket.rooms.add(payload.vendorId);
      socket.fire('connect');
    }),
    disconnect: vi.fn(() => {
      const was = socket.connected;
      socket.active = false; socket.connected = false; socket.rooms = new Set();
      if (was) socket.fire('disconnect');
    }),
    emit: vi.fn((event: string, payload: { vendorId: string }) => {
      if (socket.connected) socket.rooms.add(payload.vendorId); else socket.sendBuffer.push([event, payload]);
    }),
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

vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: () => fx.lastResponse(),
}));

import { navigationRef as navigation } from '../../navigation/navigationRef';
import { installNotificationTapRouter, flushPendingNavigation } from '../../services/notification-router';
import { VendorStack } from './VendorStack';
import { queryClient } from '../../lib/queryClient';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { disconnectSocket } from '../../services/socket';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;


const qr = { shortCode: 'qr-A', shortUrl: 'https://example.test/q/qr-A', svg: '<svg/>', vendorName: 'A', version: 1, graceDays: 7 };
beforeEach(() => {
  vi.clearAllMocks();
  fx.lastResponse.mockImplementation(async () => fx.cold);
  fx.realProfile = false; fx.profile.mockReset(); fx.order.mockReset(); fx.subscription.mockReset(); fx.owner = { userId: 'owner', generation: 1 }; fx.cold = null;
  fx.order.mockResolvedValue({ data: { data: { id: 'order-B', vendorId: 'store-B' } } });
  disconnectSocket(); fx.sockets.length = 0;
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  fx.get.mockImplementation(async (url: string) => ({ data: { data: url.startsWith('/public/') ? { verdict: 'WEB_RENDER', vendorId: 'store-A' } : url.includes('analytics') ? { totals: { scans: 0, approxUniqueScanners: 0, installsAttributed: 0 } } : qr } }));
  fx.post.mockResolvedValue({ data: {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); queryClient.clear(); disconnectSocket(); });
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
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
    const socket = fx.sockets.at(-1)!;
    expect(socket.connected).toBe(true);
    expect([...socket.rooms]).toEqual(['store-A']);
    const connections = socket.connections;
    await act(async () => {
      useStoreSwitcher.getState().setSelectedStore('store-B');
      useStoreSwitcher.getState().setSelectedStore('store-A');
    });
    // [AX449 #4] ONE shared socket: the connection that held the old room was
    // closed and replaced in place, so no other mounted layer loses its socket.
    expect(fx.sockets).toHaveLength(1);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.connections).toBeGreaterThan(connections);
    expect(socket.connected).toBe(true);
    expect([...socket.rooms]).toEqual(['store-A']);
    expect(socket.listeners.get('order:new')?.size, 'only the live A layer listens').toBe(1);
    await act(async () => { if (socket.connected) socket.fire('order:new', { orderId: 'new-A-order' }); });
    expect(host.querySelector('output')?.textContent).toBe('new-A-order');
  });

  it('a retired store layer never re-joins its room when the shared socket reconnects', async () => {
    await mount();
    const socket = fx.sockets.at(-1)!;
    expect([...socket.rooms]).toEqual(['store-A']);
    await act(async () => useStoreSwitcher.getState().setSelectedStore('store-B'));
    expect(fx.sockets).toHaveLength(1);
    expect(socket.connected).toBe(true);
    expect([...socket.rooms], 'A’s reconnect handler ran before its layer retired, and stayed out').toEqual(['store-B']);
    expect(socket.listeners.get('order:new')?.size).toBe(1);
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

  it('[DELETION-INTEGRITY] the Account row opens personal data and closure in the real navigator', async () => {
    await mount(); await openAccount();
    expect(host.querySelector('personaldatascreen')).toBeNull();
    await act(async () => button('Personal data & account closure').click());
    const route = navigation.getCurrentRoute()!;
    expect(route.name).toBe('PersonalData');
    expect(route.params).toEqual({ closureRequest: true });
    expect(host.querySelector('personaldatascreen')).not.toBeNull();
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

const profile = { myRole: 'OWNER', vendors: ['store-A', 'store-B'].map(id => ({ id, name: id, status: 'ACTIVE', vendorType: 'RESTAURANT' })) };
const response = (data: Record<string, unknown>) => ({ notification: { request: { content: { data } } } });
async function settleRouter() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); }); }

describe('DS390 real cold notification router and delayed profile', () => {
  it('retains the authorized order destination after the first profile selects a store', async () => {
    fx.realProfile = true;
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let finish!: (value: unknown) => void;
    fx.profile.mockResolvedValue({ data: { data: profile } }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fx.order.mockResolvedValue({ data: { data: { id: 'order-B', vendorId: 'store-B' } } });
    fx.cold = response({ kind: 'vendor_order_alert', orderId: 'order-B' });
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation(); await settleRouter();
      await act(async () => finish({ data: { data: profile } }));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe('VendorOrderDetail');
      expect(navigation.getCurrentRoute()?.params).toEqual({ orderId: 'order-B' });
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
      expect(fx.order).toHaveBeenCalledWith('order-B', expect.objectContaining({ userId: 'owner' }), expect.any(String));
    } finally { uninstall(); }
  });
});


describe('DS390 vendor routing authority boundaries', () => {
  it.each([
    [{ kind: 'category_backfill_review' }, 'VendorCategoryReview', 'store-A'],
    [{ kind: 'vendor_tier_promoted', vendorId: 'store-B' }, 'VendorTier', 'store-B'],
    [{ kind: 'vendor_tier_nudge', vendorId: 'store-B' }, 'VendorTier', 'store-B'],
    [{ kind: 'store_pin_moved', vendorId: 'store-B' }, 'Account', 'store-B'],
    [{ kind: 'mmg_link_change_staged', actor: 'VENDOR' }, 'Account', 'store-A'],
    [{ kind: 'mmg_link_change_applied', actor: 'VENDOR' }, 'Account', 'store-A'],
    [{ kind: 'mmg_link_change_cancelled', actor: 'VENDOR' }, 'Account', 'store-A'],
    [{ kind: 'booking_rescheduled', audience: 'business', bookingId: 'booking-A' }, 'Schedule', 'store-A'],
  ] as const)('delivers cold %j after delayed initial selection', async (data, screen, store) => {
    fx.realProfile = true;
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let finish!: (value: unknown) => void;
    fx.profile.mockResolvedValue({ data: { data: { ...profile, vendors: profile.vendors.map(v => ({ ...v, vendorType: 'SERVICE' })) } } })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fx.cold = response(data);
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation(); await settleRouter();
      await act(async () => finish({ data: { data: { ...profile, vendors: profile.vendors.map(v => ({ ...v, vendorType: 'SERVICE' })) } } }));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe(screen);
      expect(useStoreSwitcher.getState().selectedStoreId).toBe(store);
    } finally { uninstall(); }
  });
  it.each(['profile-store', 'profile-roundtrip', 'profile-account', 'profile-account-roundtrip', 'order-store', 'order-roundtrip', 'order-account'])(
    'does not let old notification hijack a newer choice at %s', async boundary => {
      await mount();
      let finishProfile!: (value: unknown) => void;
      let finishOrder!: (value: unknown) => void;
      fx.profile.mockImplementation(() => new Promise(resolve => { finishProfile = resolve; }));
      fx.order.mockImplementation(() => new Promise(resolve => { finishOrder = resolve; }));
      const uninstall = installNotificationTapRouter();
      try {
        await act(async () => fx.listener!(response({ kind: 'vendor_order_alert', orderId: 'order-B', vendorId: 'store-B' })));
        await act(async () => { await vi.waitFor(() => expect(finishProfile).toBeTypeOf('function')); });
        if (boundary.startsWith('order')) {
          await act(async () => finishProfile({ data: { data: profile } }));
          await act(async () => { await vi.waitFor(() => expect(finishOrder).toBeTypeOf('function')); });
        }
        await act(async () => {
          if (boundary.includes('account')) { fx.owner.generation++; if (boundary.includes('roundtrip')) fx.owner.generation++; }
          else { useStoreSwitcher.getState().setSelectedStore('store-B'); if (boundary.includes('roundtrip')) useStoreSwitcher.getState().setSelectedStore('store-A'); }
        });
        await act(async () => navigation.navigate('VendorMyQr'));
        const chosenKey = navigation.getCurrentRoute()?.key;
        await act(async () => {
          if (boundary.startsWith('profile')) finishProfile({ data: { data: profile } });
          else finishOrder({ data: { data: { id: 'order-B', vendorId: 'store-B' } } });
        });
        await settleRouter();
        expect(navigation.getCurrentRoute()?.name).toBe('VendorMyQr');
        expect(navigation.getCurrentRoute()?.key).toBe(chosenKey);
      } finally { uninstall(); }
    });
  it.each(['denied', 'missing', 'transport', 'malformed-profile', 'malformed-order', 'inaccessible', 'target-mismatch'])(
    'does not navigate an unverified target (%s)', async fault => {
      await mount();
      fx.profile.mockResolvedValue({ data: { data: fault === 'malformed-profile' ? {} : profile } });
      if (['denied', 'missing', 'transport'].includes(fault)) fx.order.mockRejectedValue({ response: { status: fault === 'denied' ? 403 : fault === 'missing' ? 404 : 503 } });
      else fx.order.mockResolvedValue({ data: { data: fault === 'malformed-order' ? {} : { id: 'order-B', vendorId: fault === 'inaccessible' ? 'store-unknown' : 'store-B' } } });
      const uninstall = installNotificationTapRouter();
      try {
        await act(async () => fx.listener!(response({ kind: 'vendor_order_alert', orderId: 'order-B', ...(fault === 'target-mismatch' ? { vendorId: 'store-A' } : {}) })));
        await act(async () => {
          await vi.waitFor(() => expect(fx.profile).toHaveBeenCalledOnce());
          if (fault !== 'malformed-profile') await vi.waitFor(() => expect(fx.order).toHaveBeenCalledOnce());
        });
        await settleRouter();
        expect(navigation.getCurrentRoute()?.name).toBe('Orders');
        expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
      } finally { uninstall(); }
    });
  it('a newer tap retires a cold destination already held by the ready timer', async () => {
    fx.cold = response({ kind: 'vendor_order_alert', orderId: 'order-B' });
    fx.profile.mockResolvedValue({ data: { data: profile } });
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation();
      await act(async () => fx.listener!(response({ kind: 'vendor_tier_nudge', vendorId: 'store-A' })));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe('VendorTier');
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    } finally { uninstall(); }
  });
});


describe('DS390 queued and final handoff boundaries', () => {
  it.each(['store', 'roundtrip', 'account'] as const)('a cold tap cannot treat an explicit initial %s choice as automatic selection', async change => {
    fx.realProfile = true;
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let finish!: (value: unknown) => void;
    fx.profile.mockResolvedValue({ data: { data: profile } }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fx.cold = response({ kind: 'vendor_order_alert', orderId: 'order-B' });
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation(); await settleRouter();
      await act(async () => {
        if (change === 'account') fx.owner.generation++;
        else { useStoreSwitcher.getState().setSelectedStore('store-B'); if (change === 'roundtrip') { useStoreSwitcher.getState().setSelectedStore(null); useStoreSwitcher.getState().setSelectedStore('store-A'); } }
        finish({ data: { data: profile } });
      });
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).not.toBe('VendorOrderDetail');
      expect(fx.order).not.toHaveBeenCalled();
    } finally { uninstall(); }
  });
  it.each(['store', 'roundtrip', 'account', 'newer-tap'] as const)('rechecks %s after selecting the validated target, before dispatch', async change => {
    await mount();
    fx.profile.mockResolvedValue({ data: { data: profile } });
    const uninstall = installNotificationTapRouter();
    let traversed = false;
    const unsubscribe = useStoreSwitcher.subscribe(state => {
      if (state.selectedStoreId !== 'store-B' || traversed) return;
      traversed = true;
      queueMicrotask(() => {
        if (change === 'account') fx.owner.generation++;
        else if (change === 'newer-tap') fx.listener!(response({ kind: 'vendor_tier_nudge', vendorId: 'store-B' }));
        else { useStoreSwitcher.getState().setSelectedStore('store-A'); if (change === 'roundtrip') useStoreSwitcher.getState().setSelectedStore('store-B'); }
      });
    });
    try {
      await act(async () => fx.listener!(response({ kind: 'vendor_order_alert', orderId: 'order-B' })));
      await settleRouter();
      expect(traversed).toBe(true);
      expect(navigation.getCurrentRoute()?.name).not.toBe('VendorOrderDetail');
      if (change === 'newer-tap') expect(navigation.getCurrentRoute()?.name).toBe('VendorTier');
    } finally { unsubscribe(); uninstall(); }
  });
  it('a delayed cold lookup cannot supersede a newer warm tap', async () => {
    await mount();
    fx.profile.mockResolvedValue({ data: { data: profile } });
    let finish!: (value: unknown) => void;
    fx.lastResponse.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => fx.listener!(response({ kind: 'vendor_tier_nudge', vendorId: 'store-A' })));
      await settleRouter();
      await act(async () => finish(response({ kind: 'vendor_order_alert', orderId: 'order-B' })));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe('VendorTier');
      expect(fx.order).not.toHaveBeenCalled();
    } finally { uninstall(); }
  });
});


describe('DS390 nested destinations while the handoff profile reloads', () => {
  it.each([['store_pin_moved', 'Account'], ['booking_rescheduled', 'Schedule']] as const)('retains %s until the selected store tabs mount', async (kind, screen) => {
    fx.realProfile = true;
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    const serviceProfile = { ...profile, vendors: profile.vendors.map(v => ({ ...v, vendorType: 'SERVICE' })) };
    let first!: (value: unknown) => void; let next!: (value: unknown) => void;
    fx.profile.mockResolvedValue({ data: { data: serviceProfile } })
      .mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { next = resolve; }));
    fx.cold = response({ kind, audience: 'business', vendorId: 'store-A', bookingId: 'booking-A' });
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation(); await settleRouter();
      await act(async () => first({ data: { data: serviceProfile } }));
      await settleRouter();
      expect(next).toBeTypeOf('function');
      expect(navigation.getCurrentRoute()?.name).toBe('VendorRoot');
      await act(async () => next({ data: { data: serviceProfile } }));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe(screen);
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    } finally { uninstall(); }
  });
});


it('DS390 accepts only the automatic first selection while an authorized order read is pending', async () => {
  fx.realProfile = true;
  useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
  let profileReady!: (value: unknown) => void; let orderReady!: (value: unknown) => void;
  fx.profile.mockResolvedValue({ data: { data: profile } }).mockImplementationOnce(() => new Promise(resolve => { profileReady = resolve; }));
  fx.order.mockImplementationOnce(() => new Promise(resolve => { orderReady = resolve; }));
  fx.cold = response({ kind: 'vendor_order_alert', orderId: 'order-B' });
  const uninstall = installNotificationTapRouter();
  try {
    await act(async () => { await Promise.resolve(); });
    await mount(); flushPendingNavigation(); await settleRouter();
    await act(async () => profileReady({ data: { data: profile } }));
    await settleRouter();
    expect(orderReady).toBeTypeOf('function');
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
    expect(useStoreSwitcher.getState().storeGeneration).toBe(1);
    expect(useStoreSwitcher.getState().initialSelectionGeneration).toBe(1);
    await act(async () => orderReady({ data: { data: { id: 'order-B', vendorId: 'store-B' } } }));
    await settleRouter();
    expect(navigation.getCurrentRoute()?.name).toBe('VendorOrderDetail');
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-B');
  } finally { uninstall(); }
});


it('DS390 rejects an explicitly notified store outside the current membership', async () => {
  await mount();
  fx.profile.mockResolvedValue({ data: { data: profile } });
  const selections: Array<string | null> = [];
  const unsubscribe = useStoreSwitcher.subscribe(state => selections.push(state.selectedStoreId));
  const uninstall = installNotificationTapRouter();
  try {
    await act(async () => fx.listener!(response({ kind: 'vendor_tier_nudge', vendorId: 'store-unknown' })));
    await act(async () => { await vi.waitFor(() => expect(fx.profile).toHaveBeenCalledOnce()); });
    await settleRouter();
    expect(selections).not.toContain('store-unknown');
    expect(navigation.getCurrentRoute()?.name).toBe('Orders');
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
  } finally { unsubscribe(); uninstall(); }
});


const feeNotice = (target: string) => ({ kind: 'billing_mmg_checkout', vendorId: target, subscriptionId: `subscription-${target}`, ref: `ref-${target}` });

describe('R3 cold fee notification and the automatic first store (AX449 #2)', () => {
  it.each([
    ['store-A', 'profile-first'], ['store-B', 'profile-first'], ['store-A', 'subscription-first'], ['store-B', 'subscription-first'],
  ] as const)('opens the notified fee for %s whichever of profile or subscription lands first (%s)', async (target, order) => {
    fx.realProfile = true;
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let profileReady!: (value: unknown) => void; let subscriptionReady!: (value: unknown) => void;
    fx.profile.mockResolvedValue({ data: { data: profile } }).mockImplementationOnce(() => new Promise(resolve => { profileReady = resolve; }));
    fx.subscription.mockImplementationOnce(() => new Promise(resolve => { subscriptionReady = resolve; }));
    fx.cold = response(feeNotice(target));
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation(); await settleRouter();
      expect(subscriptionReady, 'the fee lookup is in flight').toBeTypeOf('function');
      expect(profileReady, 'the shell profile is in flight').toBeTypeOf('function');
      expect(useStoreSwitcher.getState().feeContextPending).toBe(true);
      const profileLands = () => profileReady({ data: { data: profile } });
      const subscriptionLands = () => subscriptionReady({ data: { data: { id: `subscription-${target}` } } });
      await act(async () => (order === 'profile-first' ? profileLands : subscriptionLands)());
      await settleRouter();
      if (order === 'profile-first') {
        // The shell's automatic first choice landed under the lookup; Pay stays held.
        expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: 'store-A', initialSelectionGeneration: 1, feeContextPending: true });
      }
      await act(async () => (order === 'profile-first' ? subscriptionLands : profileLands)());
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe('WeeklyFee');
      expect(navigation.getCurrentRoute()?.params).toEqual({ vendorId: target, subscriptionId: `subscription-${target}`, ref: `ref-${target}`, feeFamily: 'vendor' });
      expect(useStoreSwitcher.getState().selectedStoreId).toBe(target);
      expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    } finally { uninstall(); }
  });

  it.each(['explicit', 'roundtrip'] as const)('an %s first choice while the fee lookup waits retires the cold notice', async change => {
    fx.realProfile = true;
    useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null });
    let profileReady!: (value: unknown) => void; let subscriptionReady!: (value: unknown) => void;
    fx.profile.mockResolvedValue({ data: { data: profile } }).mockImplementationOnce(() => new Promise(resolve => { profileReady = resolve; }));
    fx.subscription.mockImplementationOnce(() => new Promise(resolve => { subscriptionReady = resolve; }));
    fx.cold = response(feeNotice('store-B'));
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => { await Promise.resolve(); });
      await mount(); flushPendingNavigation(); await settleRouter();
      expect(subscriptionReady).toBeTypeOf('function');
      if (change === 'explicit') await act(async () => useStoreSwitcher.getState().setSelectedStore('store-A'));
      else {
        await act(async () => profileReady({ data: { data: profile } }));
        await settleRouter();
        expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: 'store-A', initialSelectionGeneration: 1 });
        await act(async () => { useStoreSwitcher.getState().setSelectedStore('store-B'); useStoreSwitcher.getState().setSelectedStore('store-A'); });
      }
      await settleRouter();
      await act(async () => subscriptionReady({ data: { data: { id: 'subscription-store-B' } } }));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).not.toBe('WeeklyFee');
      expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-A');
      expect(useStoreSwitcher.getState().feeContextPending).toBe(false);
    } finally { uninstall(); }
  });
});

describe('R3 an older fee lookup in the real shell (AX449 #3)', () => {
  const orderA = { kind: 'vendor_order_alert', orderId: 'order-A', vendorId: 'store-A' };
  it('cannot publish its store, retire the newer route, cycle the socket or navigate after a newer order tap', async () => {
    await mount();
    fx.profile.mockResolvedValue({ data: { data: profile } });
    fx.order.mockResolvedValue({ data: { data: { id: 'order-A', vendorId: 'store-A' } } });
    let feeReady!: (value: unknown) => void;
    fx.subscription.mockImplementationOnce(() => new Promise(resolve => { feeReady = resolve; }));
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => fx.listener!(response(feeNotice('store-B'))));
      await act(async () => { await vi.waitFor(() => expect(feeReady).toBeTypeOf('function')); });
      await act(async () => fx.listener!(response(orderA)));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe('VendorOrderDetail');
      const route = navigation.getCurrentRoute()!.key;
      const { storeGeneration } = useStoreSwitcher.getState();
      const socket = fx.sockets.at(-1)!;
      const connections = socket.connections;
      await act(async () => feeReady({ data: { data: { id: 'subscription-store-B' } } }));
      await settleRouter();
      expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: 'store-A', storeGeneration, feeContextPending: false });
      expect(navigation.getCurrentRoute()?.key, 'the newer route is not retired').toBe(route);
      expect(fx.sockets).toHaveLength(1);
      expect(socket.connections).toBe(connections);
      expect(socket.connected).toBe(true);
    } finally { uninstall(); }
  });

  it.each(['retry', 'cancel'] as const)('a retained fee %s cannot select, retire the newer route or navigate', async action => {
    await mount();
    fx.profile.mockResolvedValue({ data: { data: profile } });
    fx.order.mockResolvedValue({ data: { data: { id: 'order-A', vendorId: 'store-A' } } });
    fx.subscription.mockRejectedValueOnce({ response: { status: 503 } });
    const uninstall = installNotificationTapRouter();
    try {
      await act(async () => fx.listener!(response(feeNotice('store-B'))));
      await settleRouter();
      const recovery = useStoreSwitcher.getState().feeContextError;
      expect(recovery).not.toBeNull();
      expect(navigation.getCurrentRoute()?.name).toBe('WeeklyFee');
      await act(async () => fx.listener!(response(orderA)));
      await settleRouter();
      expect(navigation.getCurrentRoute()?.name).toBe('VendorOrderDetail');
      const route = navigation.getCurrentRoute()!.key;
      fx.subscription.mockResolvedValue({ data: { data: { id: 'subscription-store-B' } } });
      await act(async () => { await recovery![action](); });
      await settleRouter();
      expect(navigation.getCurrentRoute()?.key).toBe(route);
      expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: 'store-A', feeContextPending: false, feeContextError: null });
      expect(fx.subscription).toHaveBeenCalledOnce();
    } finally { uninstall(); }
  });
});
