import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@swift/types';
import type { AuthSessionSnapshot } from '../../../lib/authSession';

// ---------------------------------------------------------------------------
// Independent review VP-R2-01. A signed-out guest taps "Preview a business
// dashboard" on the welcome screen and gets the sample dashboard. Its Account
// tab offered "Switch app", which opens the one role switcher. Picking Swift
// there asks the server to move the account's role, and that needs a signed-in
// session. For a guest the session check threw, the switcher swallowed the
// error, and nothing happened: no navigation, no message, the sheet still open.
//
// These tests drive the real Account screen, the real role switcher and the
// real welcome screen on the real auth and preview stores. They use the same
// render runtime as VendorStack.entry.test.ts: a component is called as a
// function, its hooks run on a small per-instance runtime, and a press is
// followed by a re-render. Only the network, native modules and leaf visuals
// are stand-ins. Tests named "control:" pass before the fix as well. They pin
// the signed-in, server-authorized switch that the fix must leave alone.
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

interface Mounted {
  readonly output: unknown;
  render: () => unknown;
  unmount: () => void;
}

const fx = vi.hoisted(() => {
  let active: Instance | null = null;
  const mounted = new Set<Mounted>();

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
  function mount<P>(component: (props: P) => unknown, props: P): Mounted {
    const instance: Instance = { slots: [], cursor: 0, effects: [], dirty: false };
    let output: unknown = null;
    let live = true;
    const render = () => {
      if (!live) throw new Error('A view was rendered after it unmounted.');
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
    const view: Mounted = {
      get output() {
        return output;
      },
      render,
      unmount() {
        if (!live) return;
        live = false;
        mounted.delete(view);
        for (const s of instance.slots) {
          if (typeof s.cleanup === 'function') s.cleanup();
          s.unsubscribe?.();
        }
      },
    };
    mounted.add(view);
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
      for (const view of [...mounted]) view.unmount();
    },
    token,
    profile: { data: null as unknown, error: null as unknown },
    queryClient: {
      clear: vi.fn(),
      invalidateQueries: vi.fn(async () => undefined),
      removeQueries: vi.fn(),
      resetQueries: vi.fn(async () => undefined),
    },
    switchRole: vi.fn(),
    toastError: vi.fn(),
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
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, isSuccess: false }),
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (options.enabled !== false && options.queryKey[0] === 'vendor' && options.queryKey[1] === 'profile') {
      const { data, error } = fx.profile;
      return { data, error, isLoading: false, isFetched: true, refetch: vi.fn() };
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
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `scope-${Math.random().toString(36).slice(2)}` }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('@swift/ui', () => ({ color: fx.token, font: fx.token, fontSize: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../kit', () =>
  Object.fromEntries(
    ['Card', 'Chip', 'DecorativeIcon', 'IconChip', 'LoadingBlock', 'Pictogram', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T', 'TonePill']
      .map((name) => [name, name]),
  ));
vi.mock('../../../kit/controls', () => ({ BrandSwitch: 'BrandSwitch' }));
vi.mock('../../../kit/pressable-scale', () => ({ PressableScale: 'PressableScale' }));
vi.mock('../../../kit/toast', () => ({ toast: { error: fx.toastError, info: vi.fn(), success: vi.fn() } }));
vi.mock('../../../components/SwiftLogo', () => ({ SwiftMark: 'SwiftMark' }));
vi.mock('../../../components/MmgPayLinkCard', () => ({ MmgPayLinkCard: 'MmgPayLinkCard' }));
vi.mock('../../../components/PublicCallNumberCard', () => ({ PublicCallNumberCard: 'PublicCallNumberCard' }));
vi.mock('../../../components/onboarding/DocumentChecklist', () => ({ DocumentChecklist: 'DocumentChecklist' }));
vi.mock('../../../hooks/useStepUp', () => ({
  useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null, active: false }),
}));
vi.mock('../../../hooks/verification', () => ({
  useVerificationStatus: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.example.test',
  customerApi: { switchRole: fx.switchRole },
  revokeAuthSession: vi.fn(async () => undefined),
  riderApi: {},
  vendorApi: {},
  vendorDiscoveryApi: {},
}));
vi.mock('../../../services/socket', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), getSocket: vi.fn(() => null) }));
vi.mock('../../../services/push', () => ({ preparePushTokenForLogout: vi.fn(async () => null) }));
vi.mock('../../../services/backgroundLocation', () => ({ stopMoverLocation: vi.fn(async () => undefined) }));
vi.mock('../../../lib/storage', () => {
  const data = new Map<string, string>();
  return {
    zustandStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    },
  };
});
vi.mock('../../../lib/queryClient', () => ({ queryClient: fx.queryClient }));
vi.mock('../../../lib/adsQueue', () => ({ retireAdEventScope: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { VendorAccountScreen } from './VendorAccountScreen';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { RolePickerScreen } from '../../../screens/auth/RolePickerScreen';
import { getAuthSessionSnapshot, useAuthStore } from '../../../stores/authStore';
import { useMoverPreview } from '../../../stores/moverPreview';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { previewBypassForIntent, rootEntryGate } from '../../../navigation/rootEntryGate';

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

/** The Account tab's settings rows (Seller status, Get help, and the app row). */
const rows = (view: Mounted) => ofType(view.output, 'SettingsRow');
const labels = (view: Mounted) => rows(view).map((row) => row.props.label as string);

/**
 * Where the root navigator sends this device now: the inputs and the gate
 * RootNavigator itself uses. `main:<intent>` is an app; anything else is an
 * entry screen, and 'role-picker' is the welcome screen.
 */
function landing(): string {
  const auth = useAuthStore.getState();
  const gate = rootEntryGate({
    isAuthenticated: auth.isAuthenticated,
    wantsAuth: auth.wantsAuth,
    intent: auth.intent,
    countryCode: auth.countryCode,
    anyPreview: previewBypassForIntent(auth.intent, {
      moverPreview: useMoverPreview.getState().preview,
      vendorSamplePreview: useVendorPreview.getState().previewType != null,
    }),
    needsSelfie: auth.isAuthenticated && !auth.user?.selfieCapturedAt,
  });
  return gate === 'main' ? `main:${auth.intent}` : gate;
}

/** A card in the Switch app sheet, pressed. */
function choose(switcher: Mounted, intent: 'customer' | 'mover' | 'vendor') {
  const card = ofType(switcher.output, 'Pressable').find((el) => el.key === intent);
  if (!card) throw new Error(`the switcher has no ${intent} card`);
  card.props.onPress();
}

/** Let the switcher's async pick, and any session teardown, finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vi.dynamicImportSettled();
}

/** "Preview a business dashboard" on the welcome screen, signed out. */
function openSampleDashboardAsGuest() {
  const welcome = fx.mount(RolePickerScreen, {});
  const row = named(welcome.output, 'QuietRow').find((el) => el.props.testID === 'role-picker-preview-business');
  if (!row) throw new Error('the welcome screen no longer offers the business preview');
  row.props.onPress();
  welcome.unmount();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(landing(), 'the guest is in the sample business dashboard').toBe('main:vendor');
}

/**
 * Where each Account-tab row that leads out of the business app promises to
 * take a guest. Before the fix the row was "Switch app", in which the guest
 * picks Swift. VP-R2-01 accepts either a Swift pick that works or the row
 * relabelled and routed as an exit. Both labels are followed, and each is held
 * to its own promise.
 */
const PROMISED = new Map<string, string>([
  ['Switch app', 'main:customer'], // then Swift in the switcher: the customer app
  ['Exit preview', 'role-picker'], // the welcome screen
]);

/** What a guest does on the Account tab to get back to Swift. Returns the promise. */
async function followRouteBackToSwift(account: Mounted): Promise<string> {
  const offered = rows(account).filter((row) => PROMISED.has(row.props.label));
  expect(offered.map((row) => row.props.label), 'the Account tab offers one way back to Swift').toHaveLength(1);
  const row = offered[0]!;
  row.props.onPress();
  account.render();
  const sheet = only(account.output, RoleSwitcherSheet);
  if (sheet.props.visible) {
    choose(fx.mount(RoleSwitcherSheet, sheet.props), 'customer');
    await settle();
    account.render();
  }
  return PROMISED.get(row.props.label)!;
}

async function signIn(id: string, roles: string[]): Promise<AuthSessionSnapshot> {
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
const ownerOf = (...vendors: unknown[]) => ({ myRole: 'OWNER', vendors });

beforeEach(async () => {
  fx.unmountAll();
  await signOut();
  useVendorPreview.getState().exitPreview();
  useMoverPreview.getState().exitPreview();
  useStoreSwitcher.getState().setSelectedStore(null);
  // A fresh device: no market chosen yet (sign-out keeps the device's market).
  useAuthStore.setState({ countryCode: null, dialCode: null, currencyCode: null, currencySymbol: null });
  fx.profile = { data: null, error: null };
  vi.clearAllMocks();
});

afterEach(async () => {
  await vi.dynamicImportSettled();
});

describe('a signed-out guest in the sample business dashboard', () => {
  it('can leave it from the Account tab, and lands where the row promised', async () => {
    openSampleDashboardAsGuest();
    const account = fx.mount(VendorAccountScreen, {});

    const promised = await followRouteBackToSwift(account);

    expect(landing(), 'the guest ends up where the row promised').toBe(promised);
    expect(useVendorPreview.getState(), 'nothing of the sample is left behind').toMatchObject({ preview: false, previewType: null });
    expect(only(account.output, RoleSwitcherSheet).props.visible, 'no sheet is left open').toBe(false);
    expect(fx.switchRole, 'no server role switch for an account that does not exist').not.toHaveBeenCalled();
    expect(fx.toastError).not.toHaveBeenCalled();
  });

  it('is told the truth — Exit preview, back to the welcome screen — and reaches Swift from there', () => {
    openSampleDashboardAsGuest();
    const account = fx.mount(VendorAccountScreen, {});

    expect(labels(account), 'no Switch app the guest cannot use').not.toContain('Switch app');
    const exit = rows(account).find((row) => row.props.label === 'Exit preview');
    expect(exit?.props.sub, 'the row says where it goes').toBe('Back to the welcome screen');

    exit!.props.onPress();

    // The Orders tab banner's own Exit: the sample is cleared, then intent
    // returns to the welcome screen.
    expect(useVendorPreview.getState()).toMatchObject({ preview: false, previewType: null });
    expect(useAuthStore.getState().intent).toBeNull();
    expect(landing()).toBe('role-picker');

    // On the welcome screen, Swift is one tap away and needs no account.
    const welcome = fx.mount(RolePickerScreen, {});
    const swift = ofType(welcome.output, 'PressableScale').find((el) => el.props.testID === 'role-picker-customer');
    swift!.props.onPress();
    expect(landing(), 'guest browsing in the customer app').toBe('main:customer');
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, wantsAuth: false });
  });
});

describe('a signed-in account keeps the server-authorized switch', () => {
  it.each<[string, () => Promise<AuthSessionSnapshot>]>([
    ['in its live store', async () => {
      const owner = await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
      fx.profile = { data: ownerOf(liveStore), error: null };
      return owner;
    }],
    ['peeking at its store while approval is pending', async () => {
      const owner = await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
      fx.profile = { data: ownerOf(pendingStore), error: null };
      useVendorPreview.getState().enterPreview();
      return owner;
    }],
    ['looking at the sample dashboard', async () => {
      const owner = await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
      useVendorPreview.getState().enterPreview('RESTAURANT');
      return owner;
    }],
  ])('control: %s, Switch app → Swift goes through the server’s role switch', async (_label, arrange) => {
    const owner = await arrange();
    const account = fx.mount(VendorAccountScreen, {});
    expect(labels(account)).toContain('Switch app');
    expect(labels(account)).not.toContain('Exit preview');

    rows(account).find((row) => row.props.label === 'Switch app')!.props.onPress();
    account.render();
    const sheet = only(account.output, RoleSwitcherSheet);
    expect(sheet.props).toMatchObject({ visible: true, current: 'vendor' });
    fx.switchRole.mockResolvedValueOnce({ data: { data: { activeRole: 'CUSTOMER' } } });

    choose(fx.mount(RoleSwitcherSheet, sheet.props), 'customer');
    await settle();

    expect(fx.switchRole).toHaveBeenCalledExactlyOnceWith('CUSTOMER', owner);
    expect(useAuthStore.getState().intent).toBe('customer');
    account.render();
    expect(only(account.output, RoleSwitcherSheet).props.visible).toBe(false);
  });

  it('control: a switch the server refuses keeps the owner on the Account tab and says why', async () => {
    await signIn('owner-a', ['CUSTOMER', 'VENDOR_OWNER']);
    fx.profile = { data: ownerOf(liveStore), error: null };
    const account = fx.mount(VendorAccountScreen, {});
    rows(account).find((row) => row.props.label === 'Switch app')!.props.onPress();
    account.render();
    fx.switchRole.mockRejectedValueOnce({ response: { data: { error: { message: 'Finish the active order first.' } } } });

    choose(fx.mount(RoleSwitcherSheet, only(account.output, RoleSwitcherSheet).props), 'customer');
    await settle();

    expect(fx.toastError).toHaveBeenCalledExactlyOnceWith('Finish the active order first.');
    expect(useAuthStore.getState().intent).toBe('vendor');
    account.render();
    expect(only(account.output, RoleSwitcherSheet).props.visible).toBe(true);
  });
});
