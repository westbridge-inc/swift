/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [SPEED 6 Nov · owner: "the business tabs take a moment to open"] The REAL
// VendorStack (VendorRoot, VendorTabs, MenuStackNav) in the real bottom-tab
// navigator, with a real QueryClient. Each tab screen is a probe that records
// when it mounts and when it is SHOWN (focus). Only native drawing, the screens'
// bodies and the profile read are stand-ins.
//
//   - First paint draws Orders only; once Swift is quiet the other tabs this role
//     sees mount hidden, one at a time, and nothing is shown or focused for them.
//   - Staff never get Insights or Schedule, preloaded or not.
//   - A preload fires no focus effect and no analytics; the tab screens' own trees
//     hold no mount-time side effect (census below).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  role: 'OWNER' as 'OWNER' | 'MANAGER' | 'STAFF',
  vendorType: 'RESTAURANT',
  mounted: [] as string[],
  shown: [] as string[],
  track: vi.fn(),
  // A tab screen: records its mount, and every time it is SHOWN (focus), as a real "viewed" effect would.
  probe: (R: typeof import('react'), nav: typeof import('@react-navigation/native'), name: string) => function Probe() {
    R.useEffect(() => { fx.mounted.push(name); }, []);
    nav.useFocusEffect(R.useCallback(() => { fx.shown.push(name); }, []));
    return R.createElement('section', { 'data-tab': name, 'data-focused': String(nav.useIsFocused()) }, name);
  },
  probeModule: async (exportName: string, name: string) =>
    ({ [exportName]: fx.probe(await import('react'), await import('@react-navigation/native'), name) }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable: View,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
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
vi.mock('../../kit', () => ({ Screen: () => null, LoadingBlock: () => null, ErrorState: () => null }));
vi.mock('./shared', () => ({ catalogueMeta: () => ({ label: 'Menu', icon: 'list' }), safeVendorRole: (role: string) => role, TabHeader: () => null }));
vi.mock('../../lib/analytics', () => ({ track: fx.track }));
vi.mock('../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../services/socket', () => ({ disconnectSocket: vi.fn(), reconnectSocketForStoreHandoff: vi.fn() }));
vi.mock('../../services/notification-priming', () => ({ maybePrimeEarnerNotifications: vi.fn() }));
vi.mock('../../services/push', () => ({ pushPermission: vi.fn() }));
vi.mock('../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../components/onboarding/WentLive', () => ({ useWentLive: () => ({}), WentLivePopup: () => null }));
vi.mock('../../hooks/vendorTabPrefetch', () => ({ useVendorTabPrefetch: () => undefined }));
vi.mock('../../hooks/vendorops', () => ({
  useVendorProfile: () => {
    const store = { id: 'store-A', name: 'A', status: 'ACTIVE', vendorType: fx.vendorType };
    return { owner: { myRole: fx.role }, store, stores: [store], state: 'ready', isLoading: false };
  },
  useVendorOrdersLive: () => ({ takeover: [], dismissTakeover: () => undefined }),
}));
vi.mock('./screens/VendorOps', () => fx.probeModule('VendorOps', 'Orders'));
vi.mock('./screens/VendorScheduleScreen', () => fx.probeModule('VendorScheduleScreen', 'Schedule'));
vi.mock('./screens/VendorMenuScreen', () => fx.probeModule('VendorMenuScreen', 'Menu'));
vi.mock('./screens/VendorInsightsScreen', () => fx.probeModule('VendorInsightsScreen', 'Insights'));
vi.mock('./screens/VendorAccountScreen', () => fx.probeModule('VendorAccountScreen', 'Account'));
vi.mock('../profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: () => null }));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('./NewOrderTakeover', () => ({ NewOrderTakeover: () => null }));
vi.mock('./screens/BusinessSetup', () => ({ BusinessSetup: () => null, VendorOnboarding: () => null }));
vi.mock('./screens/VendorBillingSuspended', () => ({ VendorBillingSuspended: () => null }));
vi.mock('./screens/VendorStoreBlocked', () => ({ VendorStoreBlocked: () => null }));
vi.mock('./screens/VendorBulkImportScreen', () => ({ VendorBulkImportScreen: () => null }));
vi.mock('./screens/VendorCategoryReviewScreen', () => ({ VendorCategoryReviewScreen: () => null }));
vi.mock('./screens/VendorItemEditorScreen', () => ({ VendorItemEditorScreen: () => null }));
vi.mock('./screens/VendorOrderDetailScreen', () => ({ VendorOrderDetailScreen: () => null }));
vi.mock('./screens/VendorOrderHistoryScreen', () => ({ VendorOrderHistoryScreen: () => null }));
vi.mock('./screens/VendorMyQrScreen', () => ({ VendorMyQrScreen: () => null }));
vi.mock('./screens/VendorTierScreen', () => ({ VendorTierScreen: () => null }));
vi.mock('./screens/VendorBranchesScreen', () => ({ VendorBranchesScreen: () => null }));
vi.mock('./screens/VendorAddBranchScreen', () => ({ VendorAddBranchScreen: () => null }));

import { navigationRef as navigation } from '../../navigation/navigationRef';
import { WARM_TAB_QUIET_MS } from '../../navigation/warmTabs';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { VendorStack } from './VendorStack';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fx.role = 'OWNER'; fx.vendorType = 'RESTAURANT'; fx.mounted.length = 0; fx.shown.length = 0; fx.track.mockClear();
  useStoreSwitcher.setState({ selectedStoreId: 'store-A', storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); vi.useRealTimers(); });

async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(VendorStack),
    }))));
  expect(navigation.isReady()).toBe(true);
}
async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
/** Quiet moments, each its own act (each one commits the tab it mounts and arms the next wait). */
async function quiet(times: number) { for (let i = 0; i < times; i++) await wait(WARM_TAB_QUIET_MS + 10); }
const tabRoutes = () => {
  const vendorRoot = navigation.getRootState().routes.find((r) => r.name === 'VendorRoot');
  return (vendorRoot?.state?.routes ?? []).map((r) => r.name);
};

describe('[SPEED 6 Nov] the other business tabs are drawn before the first tap', () => {
  it('first paint draws Orders only; once Swift is quiet, Menu, Insights and Account mount hidden, one at a time', async () => {
    await mount();
    expect(fx.mounted, 'the first paint is the Orders board alone').toEqual(['Orders']);
    await wait(WARM_TAB_QUIET_MS - 50);
    expect(fx.mounted, 'nothing before Swift has been quiet a moment').toEqual(['Orders']);
    await wait(60);
    expect(fx.mounted).toEqual(['Orders', 'Menu']);
    await quiet(2);
    expect(fx.mounted).toEqual(['Orders', 'Menu', 'Insights', 'Account']);
    expect(navigation.getCurrentRoute()?.name, 'the owner is still on Orders').toBe('Orders');
    // The tap only shows the drawn tab: no second mount.
    await act(async () => navigation.navigate('VendorRoot', { screen: 'Insights' }));
    expect(fx.mounted.filter((n) => n === 'Insights')).toHaveLength(1);
    expect(host.querySelector('[data-tab="Insights"]')?.getAttribute('data-focused')).toBe('true');
  });

  it('waits while a read is on its way (the board first, then #2243\'s read-ahead)', async () => {
    let land!: () => void;
    void client.fetchQuery({ queryKey: ['vendor', 'orders'], queryFn: () => new Promise((resolve) => { land = () => resolve([]); }) });
    await mount();
    await quiet(4);
    expect(fx.mounted, 'nothing mounts behind a read still loading').toEqual(['Orders']);
    await act(async () => land());
    await wait(WARM_TAB_QUIET_MS + 10);
    expect(fx.mounted).toEqual(['Orders', 'Menu']);
  });

  it('a Services store: Schedule is not drawn ahead (it polls its bookings every minute while mounted)', async () => {
    fx.vendorType = 'SERVICE';
    await mount();
    expect(tabRoutes()).toEqual(['Orders', 'Schedule', 'Menu', 'Insights', 'Account']);
    await quiet(5);
    expect(fx.mounted).toEqual(['Orders', 'Menu', 'Insights', 'Account']);
  });

  it.each(['STAFF'] as const)('%s: Insights and Schedule are never registered, so never drawn ahead; Availability and Account are', async (role) => {
    fx.role = role; fx.vendorType = 'SERVICE';
    await mount();
    expect(tabRoutes()).toEqual(['Orders', 'Menu', 'Account']);
    await quiet(5);
    expect(fx.mounted).toEqual(['Orders', 'Menu', 'Account']);
    expect(host.querySelector('[data-tab="Insights"]')).toBeNull();
    expect(host.querySelector('[data-tab="Schedule"]')).toBeNull();
  });

  it('a manager sees the same tabs drawn ahead as the owner', async () => {
    fx.role = 'MANAGER';
    await mount();
    await quiet(4);
    expect(fx.mounted).toEqual(['Orders', 'Menu', 'Insights', 'Account']);
  });

  it('a tab drawn ahead is not SHOWN: no focus effect and no analytics fire until the owner taps it', async () => {
    await mount();
    const tracked = fx.track.mock.calls.length;
    expect(fx.shown).toEqual(['Orders']);
    await quiet(4);
    expect(fx.mounted).toEqual(['Orders', 'Menu', 'Insights', 'Account']);
    expect(fx.shown, 'mounted hidden, never focused').toEqual(['Orders']);
    for (const name of ['Menu', 'Insights', 'Account']) {
      expect(host.querySelector(`[data-tab="${name}"]`)?.getAttribute('data-focused'), name).toBe('false');
    }
    expect(fx.track.mock.calls.length, 'no analytics from a preload').toBe(tracked);
    await act(async () => navigation.navigate('VendorRoot', { screen: 'Account' }));
    expect(fx.shown).toEqual(['Orders', 'Account']);
  });
});

// The real tab screens' trees, read: nothing in them acts on its own when it mounts. Their effects
// only seed editors from the data (hours, VAT, payment links), subscribe to in-store taps, or time a
// booking's start; everything that writes, rings, locates or reports is behind a tap.
describe('[SPEED 6 Nov] census: a tab drawn ahead has no mount-time side effect', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const screens = ['./screens/VendorMenuScreen.tsx', './screens/VendorInsightsScreen.tsx', './screens/VendorAccountScreen.tsx'];
  const localImports = (path: string) => [...read(path).matchAll(/from '(\.{1,2}\/[^']+)'/g)]
    .map((m) => new URL(m[1]!, new URL(path, import.meta.url)))
    .flatMap((url) => ['.tsx', '.ts'].map((ext) => new URL(`${url.href}${ext}`)))
    .filter((url) => { try { readFileSync(url); return true; } catch { return false; } })
    // What draws (screens, cards, sheets) and the hooks they call; not the stores, libraries or the API client.
    .filter((url) => !/\/(hooks\/vendorops|services\/[a-zA-Z]+|stores\/[a-zA-Z]+|kit|lib\/[a-zA-Z]+)\.tsx?$/.test(url.pathname))
    // Its phone geocoder runs inside PickerBody, which mounts only while the picker is open (checked below).
    .filter((url) => !url.pathname.endsWith('/components/StoreLocationPicker.tsx'));
  const files = [...new Set(screens.flatMap((s) => [new URL(s, import.meta.url).href, ...localImports(s).map((u) => u.href)]))];
  const SIDE_EFFECT = /\btrack\(|markRead|markAllRead|markSeen|expo-location|useDeviceLocation|expo-av|expo-audio|\bVibration\b|expo-haptics|expo-notifications|useFocusEffect/;

  it('covers each tab screen and the cards it draws', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((f) => [f.replace(/^.*\/src\//, 'src/'), f]))('%s', (_label, href) => {
    expect(readFileSync(new URL(href), 'utf8')).not.toMatch(SIDE_EFFECT);
  });

  it('the store-pin picker on Account looks nothing up until the owner opens it', () => {
    const picker = read('../../components/StoreLocationPicker.tsx');
    expect(picker).toContain('{visible ? (\n        <PickerBody');
    expect(picker.slice(picker.indexOf('export function StoreLocationPicker'), picker.indexOf('function PickerBody'))).not.toMatch(/useEffect|Location\./);
    const account = read('./screens/VendorAccountScreen.tsx');
    expect(account).toMatch(/const \[open, setOpen\] = useState\(false\);[\s\S]*<StoreLocationPicker\n\s+visible=\{open\}[\s\S]*device=\{null\}/);
  });

  it('the tab bar draws Menu, Insights and Account ahead, never Schedule', () => {
    const stack = read('./VendorStack.tsx');
    expect(stack).toContain("const warm = useWarmTabs(manager ? ['Menu', 'Insights', 'Account'] : ['Menu', 'Account']);");
    expect(stack).not.toMatch(/warm\.has\('Schedule'\)/);
  });
});
