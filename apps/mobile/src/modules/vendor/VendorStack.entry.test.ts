import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@swift/types';

// ---------------------------------------------------------------------------
// The three owner-reported business-entry defects, driven through the real
// screens rather than their source text:
//
//   1. "Preview your dashboard" crashed the dashboard inside vendorPreviewData.
//   2. The List-your-business form lost what was typed.
//   3. Business-unavailable, pending and paused screens had no way back to
//      Swift, and a guest's sample dashboard followed them into their account.
//
// Mobile tests run in node with no React renderer (vitest.config.ts). As in
// PersonalDataScreen.test.ts, a component is called as a function and the
// element tree it returns is inspected. Here the hooks it calls are backed by a
// small per-instance runtime, so a press changes state and a re-render shows
// the result; a new instance is a remount. VendorRoot, the business screens,
// the vendor header, the role switcher, useVendorProfile, the sample dataset
// and the auth, preview and store-selection stores are the real modules. Only
// the network, native modules and leaf visuals are stand-ins.
//
// Tests named "control:" pass on the pre-fix code as well: they pin what the
// correction must not break or leak (the sample dashboard, sign-out, another
// account).
// ---------------------------------------------------------------------------

type Cleanup = void | (() => void);

interface HookSlot {
  ready?: boolean;
  value?: unknown;
  deps?: readonly unknown[] | undefined;
  cleanup?: Cleanup;
  setter?: (update: unknown) => void;
  unsubscribe?: () => void;
}

interface Instance {
  slots: HookSlot[];
  cursor: number;
  effects: Array<() => void>;
  dirty: boolean;
}

interface View {
  readonly output: unknown;
  render: () => unknown;
  unmount: () => void;
}

const fx = vi.hoisted(() => {
  let active: Instance | null = null;
  const views = new Set<View>();

  const slot = (): [HookSlot, Instance] => {
    if (!active) throw new Error('A hook ran outside a harness render.');
    const index = active.cursor;
    active.cursor += 1;
    const existing = active.slots[index];
    if (existing) return [existing, active];
    const created: HookSlot = {};
    active.slots[index] = created;
    return [created, active];
  };
  const changed = (previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) =>
    !previous || !next || previous.length !== next.length || previous.some((value, i) => !Object.is(value, next[i]));

  const hooks = {
    useState(initial: unknown) {
      const [s, instance] = slot();
      if (!s.ready) {
        s.value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        s.setter = (update) => {
          const next = typeof update === 'function' ? (update as (previous: unknown) => unknown)(s.value) : update;
          if (Object.is(next, s.value)) return;
          s.value = next;
          instance.dirty = true;
        };
        s.ready = true;
      }
      return [s.value, s.setter];
    },
    useMemo(factory: () => unknown, deps?: readonly unknown[]) {
      const [s] = slot();
      if (!s.ready || deps === undefined || changed(s.deps, deps)) {
        // A throwing factory leaves the slot as it was: React discards that render.
        s.value = factory();
        s.deps = deps;
        s.ready = true;
      }
      return s.value;
    },
    useCallback(callback: unknown, deps?: readonly unknown[]) {
      return hooks.useMemo(() => callback, deps);
    },
    useRef(initial: unknown) {
      const [s] = slot();
      if (!s.ready) {
        s.value = { current: initial };
        s.ready = true;
      }
      return s.value;
    },
    useEffect(effect: () => Cleanup, deps?: readonly unknown[]) {
      const [s, instance] = slot();
      if (s.ready && deps !== undefined && !changed(s.deps, deps)) return;
      s.ready = true;
      s.deps = deps;
      instance.effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) {
      const [s, instance] = slot();
      if (!s.unsubscribe) {
        s.unsubscribe = subscribe(() => {
          instance.dirty = true;
        });
      }
      return getSnapshot();
    },
    useDebugValue() {},
  };

  /** Mount a component: render, run its effects, and re-render until state settles. */
  function mount<P>(component: (props: P) => unknown, props: P): View {
    const instance: Instance = { slots: [], cursor: 0, effects: [], dirty: false };
    let output: unknown = null;
    let mounted = true;
    const render = () => {
      if (!mounted) throw new Error('A view was rendered after it unmounted.');
      for (let pass = 0; pass < 20; pass += 1) {
        instance.cursor = 0;
        instance.effects = [];
        instance.dirty = false;
        const outer = active;
        active = instance;
        try {
          output = component(props);
        } finally {
          active = outer;
        }
        for (const run of instance.effects) run();
        if (!instance.dirty) return output;
      }
      throw new Error('A view never settled.');
    };
    const view: View = {
      get output() {
        return output;
      },
      render,
      unmount() {
        if (!mounted) return;
        mounted = false;
        views.delete(view);
        for (const s of instance.slots) {
          if (typeof s.cleanup === 'function') s.cleanup();
          s.unsubscribe?.();
        }
      },
    };
    views.add(view);
    render();
    return view;
  }

  // @swift/ui tokens: any path is a value, and arithmetic on one is harmless.
  const token: unknown = new Proxy({}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? (hint: string) => (hint === 'number' ? 0 : '') : token),
  });

  return {
    hooks,
    mount,
    unmountAll: () => {
      for (const view of [...views]) view.unmount();
    },
    token,
    server: {
      profile: { data: null as unknown, error: null as unknown },
      /** The `enabled` flag of every vendor-profile read, in order. */
      profileReads: [] as boolean[],
      refetch: vi.fn(),
      /** The public Guyana price list: the form commits only to a fetched, current quote [PR1270-S2-04]. */
      pricing: {
        countryCode: 'GY',
        currencyCode: 'GYD',
        currencySymbol: '$',
        isActive: true,
        trialDays: 14,
        movers: [],
        vendors: {
          service: 8000,
          catalogue: [
            { minItems: 0, tier: 'small', rate: 15000 },
            { minItems: 1000, tier: 'large', rate: 20000 },
            { minItems: 10000, tier: 'department', rate: 60000 },
          ],
        },
        franchise: { minLocations: 5, discountPct: 50 },
      },
    },
    queryClient: {
      clear: vi.fn(),
      invalidateQueries: vi.fn(async () => undefined),
      removeQueries: vi.fn(),
      resetQueries: vi.fn(async () => undefined),
    },
    switchRole: vi.fn(),
    toastError: vi.fn(),
    submitStore: vi.fn(),
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { default?: Record<string, unknown> }>();
  const hooks = { ...fx.hooks, useLayoutEffect: fx.hooks.useEffect };
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } };
});
// zustand's own React binding is an external module the react mock cannot
// reach; bind the real vanilla store to the harness instead.
vi.mock('zustand', async () => {
  const { createStore } = await vi.importActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  const bind = (initializer: any) => {
    const api = createStore(initializer);
    const useBoundStore = (selector: (state: unknown) => unknown = (state) => state) =>
      fx.hooks.useSyncExternalStore(api.subscribe, () => selector(api.getState()));
    return Object.assign(useBoundStore, api);
  };
  return { create: (initializer?: any) => (initializer ? bind(initializer) : bind) };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => fx.queryClient,
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false }),
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const enabled = options.enabled !== false;
    if (options.queryKey[0] === 'vendor' && options.queryKey[1] === 'profile') {
      fx.server.profileReads.push(enabled);
      if (enabled) {
        const { data, error } = fx.server.profile;
        return { data, error, isLoading: false, isFetched: true, refetch: fx.server.refetch };
      }
    }
    if (options.queryKey[0] === 'pricing' && enabled) {
      return { data: fx.server.pricing, error: null, isLoading: false, isPending: false, isFetched: true, isError: false, isRefetching: false, dataUpdatedAt: Date.now(), refetch: vi.fn() };
    }
    return { data: undefined, error: null, isLoading: false, isFetched: false, isError: false, isRefetching: false, refetch: vi.fn() };
  },
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  Vibration: { vibrate: vi.fn(), cancel: vi.fn() },
  View: 'View',
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn() }) }));
vi.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: 'Stack.Navigator', Screen: 'Stack.Screen' }),
}));
vi.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: () => ({ Navigator: 'Tab.Navigator', Screen: 'Tab.Screen' }),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('@swift/ui', () => ({ color: fx.token, font: fx.token, fontSize: fx.token, radius: fx.token, space: fx.token }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `scope-${Math.random().toString(36).slice(2)}` }));
vi.mock('../../kit', async () => ({
  ...Object.fromEntries(
    ['Card', 'Chip', 'DecorativeIcon', 'ErrorState', 'LabeledInput', 'LoadingBlock', 'Pictogram', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'T', 'TonePill']
      .map((name) => [name, name]),
  ),
  // The header's Log out asks through the real shared confirm; only its
  // visuals (below) are stand-ins.
  useLogoutConfirm: (await vi.importActual<typeof import('../../kit/logout-confirm')>('../../kit/logout-confirm')).useLogoutConfirm,
}));
vi.mock('../../kit/card', () => ({ PopupCard: 'PopupCard', PopupTitle: 'PopupTitle' }));
vi.mock('../../kit/button', () => ({ PillButton: 'PillButton' }));
vi.mock('../../kit/rows', () => ({ IconChip: 'IconChip' }));
vi.mock('../../kit/text', () => ({ T: 'T' }));
vi.mock('../../kit/toast', () => ({ toast: { error: fx.toastError, info: vi.fn(), success: vi.fn() } }));
vi.mock('../../services/api', () => ({
  API_URL: 'https://api.example.test',
  customerApi: { switchRole: fx.switchRole },
  revokeAuthSession: vi.fn(async () => undefined),
  riderApi: {},
  vendorApi: {},
  vendorDiscoveryApi: {},
}));
vi.mock('../../services/socket', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), getSocket: vi.fn(() => null) }));
vi.mock('../../services/push', () => ({ preparePushTokenForLogout: vi.fn(async () => null) }));
vi.mock('../../services/backgroundLocation', () => ({ stopMoverLocation: vi.fn(async () => undefined) }));
vi.mock('../../lib/storage', () => {
  const data = new Map<string, string>();
  return {
    zustandStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    },
  };
});
vi.mock('../../lib/queryClient', () => ({ queryClient: fx.queryClient }));
vi.mock('../../lib/adsQueue', () => ({ retireAdEventScope: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../hooks/verification', () => ({
  useBecomePartner: () => ({ mutate: fx.submitStore, isPending: false, isError: false }),
  useVerificationStatus: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../stores/locationStore', () => ({
  useLocationStore: () => ({ latitude: 6.8046, longitude: -58.1553, status: 'granted' }),
}));
vi.mock('../../components/onboarding/DocumentChecklist', () => ({ DocumentChecklist: 'DocumentChecklist' }));
vi.mock('../../components/onboarding/PricingCard', () => ({ PricingCard: 'PricingCard' }));
// [Q8] The store map: react-native-maps and expo-location are native. Its props are the contract.
vi.mock('../../components/StoreLocationPicker', () => ({ StoreLocationPicker: 'StoreLocationPicker' }));
vi.mock('../../components/onboarding/WentLive', () => ({
  useWentLive: () => ({ celebrate: false, dismiss: vi.fn() }),
  WentLivePopup: 'WentLivePopup',
}));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: 'GetHelpScreen' }));
vi.mock('./NewOrderTakeover', () => ({ NewOrderTakeover: 'NewOrderTakeover' }));
vi.mock('./screens/VendorAccountScreen', () => ({ VendorAccountScreen: 'VendorAccountScreen' }));
vi.mock('./screens/VendorBulkImportScreen', () => ({ VendorBulkImportScreen: 'VendorBulkImportScreen' }));
vi.mock('./screens/VendorCategoryReviewScreen', () => ({ VendorCategoryReviewScreen: 'VendorCategoryReviewScreen' }));
vi.mock('./screens/VendorInsightsScreen', () => ({ VendorInsightsScreen: 'VendorInsightsScreen' }));
vi.mock('./screens/VendorItemEditorScreen', () => ({ VendorItemEditorScreen: 'VendorItemEditorScreen' }));
vi.mock('./screens/VendorMenuScreen', () => ({ VendorMenuScreen: 'VendorMenuScreen' }));
vi.mock('./screens/VendorMyQrScreen', () => ({ VendorMyQrScreen: 'VendorMyQrScreen' }));
vi.mock('./screens/VendorOps', () => ({ VendorOps: 'VendorOps' }));
vi.mock('./screens/VendorOrderDetailScreen', () => ({ VendorOrderDetailScreen: 'VendorOrderDetailScreen' }));
vi.mock('./screens/VendorOrderHistoryScreen', () => ({ VendorOrderHistoryScreen: 'VendorOrderHistoryScreen' }));
vi.mock('./screens/VendorScheduleScreen', () => ({ VendorScheduleScreen: 'VendorScheduleScreen' }));
vi.mock('./screens/VendorSwiftNumberScreen', () => ({ VendorSwiftNumberScreen: 'VendorSwiftNumberScreen' }));
vi.mock('./screens/VendorTierScreen', () => ({ VendorTierScreen: 'VendorTierScreen' }));

import { VendorStack } from './VendorStack';
import { BusinessSetup, VendorOnboarding } from './screens/BusinessSetup';
import { VendorBillingSuspended } from './screens/VendorBillingSuspended';
import { HeaderAction, TabHeader } from './shared';
import { RoleSwitcherSheet } from '../../components/RoleSwitcherSheet';
import { getAuthSessionSnapshot, useAuthStore } from '../../stores/authStore';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { useVendorPreview } from '../../stores/vendorPreview';
import { rootEntryGate } from '../../navigation/rootEntryGate';

interface Element {
  type: unknown;
  key: string | null;
  props: any;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Every element in a returned tree — children and element-valued props. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (isElement(node)) {
    found.push(node);
    for (const value of Object.values(node.props ?? {})) elements(value, found);
  }
  return found;
}

const ofType = (node: unknown, type: unknown) => elements(node).filter((el) => el.type === type);
const named = (node: unknown, name: string) =>
  elements(node).filter((el) => typeof el.type === 'function' && el.type.name === name);

function only(node: unknown, type: unknown): Element {
  const found = ofType(node, type);
  expect(found, `exactly one ${typeof type === 'function' ? type.name : String(type)}`).toHaveLength(1);
  return found[0]!;
}

function vendorRoot(): () => unknown {
  const screen = ofType(VendorStack(), 'Stack.Screen').find((el) => el.props.name === 'VendorRoot');
  if (!screen) throw new Error('VendorStack no longer registers VendorRoot');
  return screen.props.component;
}

/** Which store the vendor shell is showing: its went-live layer is keyed by store id. */
function shownStoreId(view: View): string | undefined {
  return named(view.output, 'VendorWentLiveLayer')[0]?.key?.replace(/^went-live-/, '');
}

// authStore tears a session down with fire-and-forget dynamic imports (GPS,
// socket, push). Two teardowns in flight at once can resolve one of those
// imports past its vi.mock, so every account change settles them first.
async function signIn(id: string, roles: string[]) {
  await vi.dynamicImportSettled();
  useAuthStore.getState().setAuth(
    {
      id,
      firstName: 'Test',
      lastName: id,
      roles,
      activeRole: roles.includes('VENDOR_OWNER') ? 'VENDOR_OWNER' : 'CUSTOMER',
      selfieCapturedAt: '2026-09-01T00:00:00.000Z',
    } as unknown as User,
    `access-${id}`,
    `refresh-${id}`,
  );
  useAuthStore.getState().setIntent('vendor');
  await vi.dynamicImportSettled();
  return getAuthSessionSnapshot()!;
}

async function signOut() {
  await vi.dynamicImportSettled();
  useAuthStore.getState().logout();
  await vi.dynamicImportSettled();
}

const pendingStore = { id: 'store-a', name: 'Kitty Bakes', vendorType: 'RESTAURANT', status: 'PENDING_APPROVAL', subscription: { status: 'TRIALING' } };
const liveStore = { ...pendingStore, status: 'ACTIVE', subscription: { status: 'ACTIVE' } };
const pausedStore = { ...liveStore, status: 'SUSPENDED', suspensionSource: 'BILLING', subscription: { status: 'SUSPENDED' } };
const ownerOf = (...vendors: unknown[]) => ({ myRole: 'OWNER', vendors });
const offline = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

function serveProfile(data: unknown, error: unknown = null) {
  fx.server.profile = { data, error };
}

// What React Native's Pressable passes to an onPress handler.
const pressEvent = {
  type: 'press',
  nativeEvent: { locationX: 12, locationY: 8, pageX: 40, pageY: 600, timestamp: 1 },
  currentTarget: 71,
  target: 71,
};

beforeEach(async () => {
  fx.unmountAll();
  await signOut();
  useVendorPreview.getState().exitPreview();
  useStoreSwitcher.getState().setSelectedStore(null);
  serveProfile(null);
  fx.server.profileReads.length = 0;
  vi.clearAllMocks();
});

// A header "Log out" pressed inside a test starts the same teardown.
afterEach(async () => {
  await vi.dynamicImportSettled();
});

describe('"Preview your dashboard" on a store waiting for approval', () => {
  it('opens the owner’s own dashboard instead of crashing it', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf(pendingStore));
    const root = fx.mount(vendorRoot(), {});

    // PillButton hands its handler to Pressable, which calls it with the event.
    only(root.output, VendorOnboarding).props.onPreview(pressEvent);

    expect(() => root.render()).not.toThrow();
    expect(named(root.output, 'VendorTabs')).toHaveLength(1);
    expect(shownStoreId(root)).toBe('store-a');
    expect(fx.server.profileReads.at(-1), 'the real profile read stays on').toBe(true);
    expect(useVendorPreview.getState()).toMatchObject({ preview: true, previewType: null });
  });

  it.each<[string, unknown]>([
    ['a missing type', undefined],
    ['an unknown type', 'BARBERSHOP'],
    ['a number', 42],
    ['an object', { type: 'RESTAURANT' }],
  ])('%s never reaches the sample data', async (_label, value) => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf(pendingStore));
    useVendorPreview.getState().enterPreview(value as never);

    let root: View | undefined;
    expect(() => {
      root = fx.mount(vendorRoot(), {});
    }).not.toThrow();
    expect(only(root!.output, VendorOnboarding).props.store.id).toBe('store-a');
    expect(fx.server.profileReads.every(Boolean)).toBe(true);
  });

  it('control: a known type still opens its read-only sample dashboard for a guest', () => {
    // "Preview a business dashboard" on the welcome, signed out.
    useVendorPreview.getState().enterPreview('SUPERMARKET');
    useAuthStore.getState().setIntent('vendor');
    const root = fx.mount(vendorRoot(), {});

    expect(named(root.output, 'VendorTabs')).toHaveLength(1);
    expect(shownStoreId(root)).toBe('pv-store');
    expect(fx.server.profileReads.some(Boolean), 'no real profile read for a guest').toBe(false);
    for (const type of ['RESTAURANT', 'STORE', 'SERVICE'] as const) {
      useVendorPreview.getState().setPreviewType(type);
      expect(() => root.render()).not.toThrow();
      expect(shownStoreId(root)).toBe('pv-store');
    }
  });
});

describe('the List-your-business form keeps what was typed', () => {
  const blank = { name: '', type: 'RESTAURANT', phone: '', addr: '', city: 'Georgetown', agree: false, pin: null };
  // [Q8] The pin the owner confirmed on the map, at the shop in Linden — not
  // where the phone is (the mocked live fix, 6.8046 / -58.1553, in Georgetown).
  const typed = {
    name: 'Kitty Bakes',
    type: 'SERVICE',
    phone: '6001234',
    addr: '12 Regent Street',
    city: 'Linden',
    agree: true,
    pin: { latitude: 6.0123, longitude: -58.3045, address: '12 Regent Street, Linden' },
  };

  function field(view: View, placeholder: string): Element {
    const input = ofType(view.output, 'LabeledInput').find((el) => el.props.placeholder === placeholder);
    if (!input) throw new Error(`no "${placeholder}" field`);
    return input;
  }

  function agreement(view: View): Element {
    const box = ofType(view.output, 'Pressable').find((el) => el.props.accessibilityRole === 'checkbox');
    if (!box) throw new Error('no Business Agreement checkbox');
    return box;
  }

  /** The store-pin row: "Place your store on the map", or "Move the store pin" once placed. */
  function pinRow(view: View): Element {
    const row = ofType(view.output, 'Pressable').find((el) => /store on the map|store pin/.test(el.props.accessibilityLabel ?? ''));
    if (!row) throw new Error('no store-pin row');
    return row;
  }

  const picker = (view: View) => only(view.output, 'StoreLocationPicker');

  function formOf(view: View) {
    const selected = named(view.output, 'BizTypeTile').filter((el) => el.props.active).map((el) => el.props.t.key);
    return {
      name: field(view, 'Business name').props.value,
      type: selected.length === 1 ? selected[0] : selected,
      phone: field(view, 'Business phone').props.value,
      addr: field(view, 'Street address').props.value,
      city: field(view, 'City').props.value,
      agree: agreement(view).props.accessibilityState.checked,
      // The map opens on the draft's pin: the picker's `current` is the pin the form holds.
      pin: picker(view).props.current,
    };
  }

  /** Type into the form the way a person does: one field, one render at a time. */
  function fill(view: View, form: Omit<typeof typed, 'pin'> & { pin: typeof typed.pin | null }) {
    const inputs: Array<[string, string]> = [
      ['Business name', form.name],
      ['Business phone', form.phone],
      ['Street address', form.addr],
      ['City', form.city],
    ];
    for (const [placeholder, value] of inputs) {
      field(view, placeholder).props.onChangeText(value);
      view.render();
    }
    named(view.output, 'BizTypeTile').find((el) => el.props.t.key === form.type)!.props.onPress();
    view.render();
    if (form.agree) {
      agreement(view).props.onPress();
      view.render();
    }
    if (form.pin) {
      // Open the store map from the form, then confirm the spot on it.
      pinRow(view).props.onPress();
      view.render();
      picker(view).props.onConfirm(form.pin);
      view.render();
    }
  }

  it('a failed background profile read and its recovery hand the owner back the same form', async () => {
    await signIn('owner-a', ['CUSTOMER']);
    serveProfile(null); // a verified 404: no business yet
    const root = fx.mount(vendorRoot(), {});
    let form = fx.mount(BusinessSetup, only(root.output, BusinessSetup).props);
    fill(form, typed);
    expect(formOf(form)).toEqual(typed);

    // One 20-second profile poll fails: VendorRoot swaps the form for its error screen.
    serveProfile(null, offline);
    root.render();
    expect(ofType(root.output, BusinessSetup)).toHaveLength(0);
    form.unmount();

    // The next poll succeeds and the form mounts again.
    serveProfile(null);
    root.render();
    form = fx.mount(BusinessSetup, only(root.output, BusinessSetup).props);

    expect(formOf(form)).toEqual(typed);
    const create = only(form.output, 'PillButton');
    expect(create.props.label).toBe('Create store');
    create.props.onPress();
    expect(fx.submitStore).toHaveBeenCalledExactlyOnceWith({
      role: 'VENDOR',
      business: {
        name: 'Kitty Bakes',
        vendorType: 'SERVICE',
        phone: '6001234',
        addressLine1: '12 Regent Street',
        city: 'Linden',
        // [Q8] The pin confirmed on the map. This used to be the phone's live
        // fix (6.8046 / -58.1553) with no pin step at all: the defect.
        latitude: 6.0123,
        longitude: -58.3045,
      },
      acceptAgreement: true,
    });
  });

  it('control: sign-out, another account and a later session each start from a blank form', async () => {
    await signIn('owner-a', ['CUSTOMER']);
    const first = fx.mount(BusinessSetup, {});
    fill(first, typed);
    first.unmount();

    await signIn('owner-b', ['CUSTOMER']); // B replaces A directly
    expect(formOf(fx.mount(BusinessSetup, {}))).toEqual(blank);

    await signOut();
    await signIn('owner-a', ['CUSTOMER']); // A again, in a new session
    expect(formOf(fx.mount(BusinessSetup, {}))).toEqual(blank);
  });

  it('control: a keystroke from a form that outlived its account writes nothing', async () => {
    await signIn('owner-a', ['CUSTOMER']);
    const stale = fx.mount(BusinessSetup, {});
    await signOut();
    await signIn('owner-b', ['CUSTOMER']);

    field(stale, 'Business name').props.onChangeText('A leftover');

    expect(formOf(fx.mount(BusinessSetup, {}))).toEqual(blank);
  });

  // [Q8] Owner report: "they can't just use the location they're registering
  // from for the store, come on now." The form sent the phone's live fix as the
  // store's coordinates, captioned "We'll use your current location as the
  // store pin" — and people sign up from home, an office or a car. The phone in
  // these tests has a granted live fix (6.8046 / -58.1553, Georgetown); the
  // store is in Linden.
  describe('[Q8] the store pin is placed on the map, never taken from the phone', () => {
    const noPin = { ...typed, pin: null };

    it('with every other field filled and agreed, Create stays off until a pin is confirmed, and a press sends nothing', async () => {
      await signIn('owner-a', ['CUSTOMER']);
      const form = fx.mount(BusinessSetup, {});
      fill(form, noPin);

      const create = only(form.output, 'PillButton');
      expect(create.props.label).toBe('Place your store on the map');
      expect(create.props.disabled).toBe(true);
      // The handler restates the gate, so a press that reaches it sends nothing.
      create.props.onPress();
      expect(fx.submitStore).not.toHaveBeenCalled();
    });

    it('the phone’s position reaches the map only as a place to start', async () => {
      await signIn('owner-a', ['CUSTOMER']);
      const form = fx.mount(BusinessSetup, {});
      fill(form, noPin);
      expect(picker(form).props.visible).toBe(false);

      pinRow(form).props.onPress();
      form.render();

      expect(picker(form).props).toMatchObject({
        visible: true,
        current: null,
        address: { line: '12 Regent Street', city: 'Linden' },
        device: { latitude: 6.8046, longitude: -58.1553 },
      });
      // Opening the map places nothing.
      expect(formOf(form).pin).toBeNull();
      expect(only(form.output, 'PillButton').props.disabled).toBe(true);
    });

    it('closing the map without confirming leaves the store unpinned', async () => {
      await signIn('owner-a', ['CUSTOMER']);
      const form = fx.mount(BusinessSetup, {});
      fill(form, noPin);
      pinRow(form).props.onPress();
      form.render();

      picker(form).props.onClose();
      form.render();

      expect(picker(form).props.visible).toBe(false);
      expect(formOf(form).pin).toBeNull();
      expect(only(form.output, 'PillButton').props).toMatchObject({ label: 'Place your store on the map', disabled: true });
    });

    it('a confirmed pin enables Create, and the store is sent at exactly that pin', async () => {
      await signIn('owner-a', ['CUSTOMER']);
      const form = fx.mount(BusinessSetup, {});
      fill(form, typed);

      expect(picker(form).props.visible, 'confirming closes the map').toBe(false);
      expect(pinRow(form).props.accessibilityLabel).toBe('Move the store pin');
      const create = only(form.output, 'PillButton');
      expect(create.props).toMatchObject({ label: 'Create store', disabled: false });

      create.props.onPress();

      expect(fx.submitStore).toHaveBeenCalledOnce();
      const sent = fx.submitStore.mock.calls[0]![0].business;
      expect({ latitude: sent.latitude, longitude: sent.longitude }).toEqual({ latitude: 6.0123, longitude: -58.3045 });
    });

    it('"Move the store pin" reopens the map on the placed pin, and the moved pin is what is sent', async () => {
      await signIn('owner-a', ['CUSTOMER']);
      const form = fx.mount(BusinessSetup, {});
      fill(form, typed);

      pinRow(form).props.onPress();
      form.render();
      expect(picker(form).props).toMatchObject({ visible: true, current: typed.pin });

      const moved = { latitude: 6.0131, longitude: -58.3052, address: '14 Regent Street, Linden' };
      picker(form).props.onConfirm(moved);
      form.render();
      only(form.output, 'PillButton').props.onPress();

      expect(fx.submitStore.mock.calls[0]![0].business).toMatchObject({ latitude: moved.latitude, longitude: moved.longitude });
    });
  });
});

describe('no business screen is a one-way door', () => {
  function expectSwiftAndSignOutExits(view: View) {
    const header = only(view.output, TabHeader);
    expect(header.props.onSwitch, 'the header offers Switch app').toBeTypeOf('function');
    expect(only(view.output, RoleSwitcherSheet).props).toMatchObject({ visible: false, current: 'vendor' });

    header.props.onSwitch();
    view.render();
    const sheet = only(view.output, RoleSwitcherSheet);
    expect(sheet.props.visible, 'Switch app opens the role switcher').toBe(true);
    sheet.props.onClose();
    view.render();
    expect(only(view.output, RoleSwitcherSheet).props.visible, 'and it closes again').toBe(false);

    // What the header itself renders: Switch app, and Log out on every screen.
    const headerView = fx.mount(TabHeader, only(view.output, TabHeader).props);
    const actions = ofType(headerView.output, HeaderAction);
    expect(actions.map((el) => el.props.label)).toEqual(['Switch app', 'Log out']);

    // Log out asks first: the session survives the press, and the ask is open.
    actions[1]!.props.onPress();
    headerView.render();
    expect(useAuthStore.getState().isAuthenticated, 'Log out only asks').toBe(true);
    expect(only(headerView.output, 'PopupCard').props.visible).toBe(true);
  }

  it.each<[string, unknown, unknown]>([
    ['an outage', null, offline],
    ['an expired session', null, http(401)],
    ['a membership the owner removed', null, http(403)],
    ['an unreadable profile', 'not-a-profile', null],
  ])('the business-unavailable screen after %s offers Switch app and Log out beside Retry', async (_label, data, error) => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(data, error);
    const root = fx.mount(vendorRoot(), {});

    expect(only(root.output, 'ErrorState').props.onRetry).toBeTypeOf('function');
    expectSwiftAndSignOutExits(root);
  });

  it('Log out there returns to the welcome with nothing of the business left behind', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(null, offline);
    const root = fx.mount(vendorRoot(), {});
    const header = fx.mount(TabHeader, only(root.output, TabHeader).props);

    ofType(header.output, HeaderAction).find((el) => el.props.label === 'Log out')!.props.onPress();
    header.render();
    expect(useAuthStore.getState().isAuthenticated, 'the header only asks').toBe(true);
    ofType(only(header.output, 'PopupCard'), 'PillButton').find((el) => el.props.label === 'Log out')!.props.onPress();
    header.render();
    const closing = only(header.output, 'PopupCard');
    expect(closing.props.visible, 'the ask closes before the session ends').toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    closing.props.onDismissed(); // iOS: the modal is provably gone

    const auth = useAuthStore.getState();
    expect(auth).toMatchObject({ isAuthenticated: false, intent: null });
    expect(rootEntryGate({ ...auth, anyPreview: false, needsSelfie: false, hasUser: !!auth.user })).toBe('role-picker');
    expect(useStoreSwitcher.getState().selectedStoreId).toBeNull();
  });

  it('Switch app → Swift takes the owner back to the customer app through the server’s role switch', async () => {
    const owner = await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(null, http(403));
    const root = fx.mount(vendorRoot(), {});
    only(root.output, TabHeader).props.onSwitch();
    root.render();
    const sheet = fx.mount(RoleSwitcherSheet, only(root.output, RoleSwitcherSheet).props);
    fx.switchRole.mockResolvedValueOnce({ data: { data: { activeRole: 'CUSTOMER' } } });

    ofType(sheet.output, 'Pressable').find((el) => el.key === 'customer')!.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fx.switchRole).toHaveBeenCalledExactlyOnceWith('CUSTOMER', owner);
    expect(useAuthStore.getState().intent).toBe('customer');
    root.render();
    expect(only(root.output, RoleSwitcherSheet).props.visible).toBe(false);
  });

  it('a switch the server refuses keeps the owner where they are and says why', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(null, offline);
    const root = fx.mount(vendorRoot(), {});
    only(root.output, TabHeader).props.onSwitch();
    root.render();
    const sheet = fx.mount(RoleSwitcherSheet, only(root.output, RoleSwitcherSheet).props);
    fx.switchRole.mockRejectedValueOnce({ response: { data: { error: { message: 'Finish the active order first.' } } } });

    ofType(sheet.output, 'Pressable').find((el) => el.key === 'customer')!.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fx.toastError).toHaveBeenCalledExactlyOnceWith('Finish the active order first.');
    expect(useAuthStore.getState().intent).toBe('vendor');
    root.render();
    expect(only(root.output, RoleSwitcherSheet).props.visible).toBe(true);
  });

  it('the store waiting for approval offers Switch app beside Log out', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf(pendingStore));
    const root = fx.mount(vendorRoot(), {});

    expectSwiftAndSignOutExits(fx.mount(VendorOnboarding, only(root.output, VendorOnboarding).props));
  });

  it('the store paused for billing offers Switch app beside Log out', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf(pausedStore));
    const root = fx.mount(vendorRoot(), {});

    expectSwiftAndSignOutExits(fx.mount(VendorBillingSuspended, only(root.output, VendorBillingSuspended).props));
  });
});

describe('the sample dashboard and account changes', () => {
  it('a guest who walked the sample dashboard and then signs in sees their own store', async () => {
    useVendorPreview.getState().enterPreview('RESTAURANT');
    useAuthStore.getState().setIntent('vendor');
    const sample = fx.mount(vendorRoot(), {});
    expect(shownStoreId(sample)).toBe('pv-store');
    sample.unmount();

    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf(liveStore));
    const root = fx.mount(vendorRoot(), {});

    expect(shownStoreId(root)).toBe('store-a');
    expect(fx.server.profileReads.at(-1), 'the real profile read is on').toBe(true);
  });

  it('control: replacing account A with B shows B’s own store, not A’s dashboard peek', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf(pendingStore));
    const first = fx.mount(vendorRoot(), {});
    only(first.output, VendorOnboarding).props.onPreview();
    first.render();
    first.unmount();

    await signIn('owner-b', ['CUSTOMER', 'VENDOR_OWNER']);
    serveProfile(ownerOf({ ...pendingStore, id: 'store-b', name: 'B Barbers' }));
    const root = fx.mount(vendorRoot(), {});

    expect(only(root.output, VendorOnboarding).props.store.id).toBe('store-b');
    expect(useStoreSwitcher.getState().selectedStoreId).toBe('store-b');
  });
});
