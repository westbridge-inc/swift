import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refetchSlots: vi.fn(),
  slots: {} as Record<string, any>,
  effects: [] as Array<() => void>,
  useStateCall: 0,
  selectedSlot: null as string | null,
  setSelectedSlot: vi.fn(),
  vendor: {} as Record<string, any>,
  goBack: vi.fn(),
}));

vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = {
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => {
      const call = mocks.useStateCall++;
      const value = call === 3
        ? mocks.selectedSlot
        : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, call === 3 ? mocks.setSelectedSlot : vi.fn()];
    },
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: () => void) => mocks.effects.push(effect),
  };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 390 }) },
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mocks.goBack }),
  useRoute: () => ({ params: { vendorId: 'vendor-1', itemId: 'service-item-1' } }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@swift/ui', () => ({
  color: {
    surface: { subtle: 'surface-subtle', base: 'surface-base' }, brand: { 50: 'brand-50', 600: 'brand-600' },
    soft: { warning: 'warning-soft' }, warning: 'warning', star: 'star', error: 'error',
  },
  elevation: { dock: {} },
  radius: { md: 8, xl: 24 },
  space: { sm: 4, md: 8, lg: 12, '2xl': 24 },
}));
vi.mock('../../../hooks/customer', () => ({
  useVendor: () => mocks.vendor,
  useAddToCart: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useItemSlots: () => ({ ...mocks.slots, refetch: mocks.refetchSlots }),
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: true, promptLogin: vi.fn() }),
}));
vi.mock('../../../stores/bookingStore', () => ({
  useBookingStore: (select: (state: unknown) => unknown) => select({ setAppointment: vi.fn() }),
}));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `$${amount}` }));
vi.mock('../../../kit', () => Object.fromEntries([
  'Photo', 'Chip', 'CircleChip', 'ErrorState', 'IconChip', 'LoadingBlock', 'Money',
  'PillButton', 'PopupCard', 'PopupTitle', 'QtyStepper', 'SectionHeader', 'T', 'Header', 'EmptyState',
].map((name) => [name, name])));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));

import { MenuItemScreen } from './MenuItemScreen';

// ---------------------------------------------------------------------------
// [UI-SWEEP U32] The item page's loading and failure states had no visible way
// back (swipe or the hardware button only), and an item the store took off
// offered only "Try again", which can never bring it back.
// ---------------------------------------------------------------------------

function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const STORE = { name: 'Sharp Cuts', categories: [{ items: [{ id: 'other-item', name: 'Shave', basePrice: 1_000, optionGroups: [], isAvailable: true }] }] };
const render = () => nodes(MenuItemScreen());
const ofType = (tree: any[], type: string) => tree.filter((n) => n.type === type);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.useStateCall = 0;
  mocks.selectedSlot = null;
  mocks.slots = { data: undefined, isPending: false, isLoading: false, isFetching: false, isError: false };
});

describe('[UI-SWEEP U32] the item page never strands the customer', () => {
  it('while the store loads: the kit header with its Back chip', () => {
    mocks.vendor = { isLoading: true, isError: false, refetch: vi.fn(), data: undefined };
    const tree = render();
    expect(ofType(tree, 'Header')).toHaveLength(1);
    expect(ofType(tree, 'LoadingBlock')).toHaveLength(1);
  });

  it('a failed read: Back AND Try again', () => {
    const refetch = vi.fn();
    mocks.vendor = { isLoading: false, isError: true, refetch, data: undefined };
    const tree = render();
    expect(ofType(tree, 'Header')).toHaveLength(1);
    const [error] = ofType(tree, 'ErrorState');
    expect(error, 'the failure says so').toBeTruthy();
    error.props.onRetry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('an item the store took off: Back, and a neutral "Go back" instead of a Try again that cannot help', () => {
    mocks.vendor = { isLoading: false, isError: false, refetch: vi.fn(), data: STORE };
    const tree = render();
    expect(ofType(tree, 'Header')).toHaveLength(1);
    expect(ofType(tree, 'ErrorState')).toEqual([]);
    const [gone] = ofType(tree, 'EmptyState');
    expect(gone?.props).toMatchObject({ title: 'This item is no longer on the menu.', actionLabel: 'Go back' });
    gone.props.onAction();
    expect(mocks.goBack).toHaveBeenCalledTimes(1);
  });
});
