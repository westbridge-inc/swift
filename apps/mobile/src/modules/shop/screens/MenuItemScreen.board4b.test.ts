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
  useRoute: () => ({ params: { vendorId: 'vendor-1', itemId: 'basket-1' } }),
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
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null, HERO_PHOTO_WIDTH: 1080 }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `$${amount}` }));
vi.mock('../../../kit', () => Object.fromEntries([
  'Photo', 'Chip', 'CircleChip', 'ErrorState', 'IconChip', 'LoadingBlock', 'Money',
  'PillButton', 'PopupCard', 'PopupTitle', 'QtyStepper', 'SectionHeader', 'T', 'Header', 'EmptyState', 'TonePill', 'LabeledInput',
].map((name) => [name, name])));
vi.mock('../components/ItemDescription', () => ({ ItemDescription: 'ItemDescription' }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));

import { MenuItemScreen, storeLine } from './MenuItemScreen';

// ---------------------------------------------------------------------------
// [P35 · board 4b "Market — product page"] Under the item's name: the store that sells it and its city
// ("Craft & Kind · Georgetown"), and "Verified seller" only when the store row says a person approved its
// papers. The description goes through ItemDescription (three lines + Read more; its own test).
// ---------------------------------------------------------------------------

function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const LONG = 'Tibisiri-palm warishi woven in the Rupununi, flat back, shoulder straps, holds a week of market shopping. Each one is a single maker’s work, so weave and tone vary.';
const ITEM = { id: 'basket-1', name: 'Warishi basket', basePrice: 3_500, optionGroups: [], isAvailable: true, description: LONG };
const store = (extra: Record<string, unknown>) => ({ name: 'Craft & Kind', city: 'Georgetown', categories: [{ items: [ITEM] }], ...extra });
const render = () => nodes(MenuItemScreen());
const ofType = (tree: any[], type: string) => tree.filter((n) => n.type === type);
const text = (n: any): string => (Array.isArray(n.props?.children) ? n.props.children.join('') : String(n.props?.children ?? ''));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.useStateCall = 0;
  mocks.selectedSlot = null;
  mocks.slots = { data: undefined, isPending: false, isLoading: false, isFetching: false, isError: false };
});

describe('[P35 · board 4b] the item page names its store and says when the seller is verified', () => {
  it('a verified store: "Craft & Kind · Georgetown" and a Verified seller pill', () => {
    mocks.vendor = { isLoading: false, isError: false, refetch: vi.fn(), data: store({ isVerified: true }) };
    const tree = render();
    expect(ofType(tree, 'T').map(text)).toContain('Craft & Kind · Georgetown');
    expect(ofType(tree, 'TonePill').map((p) => p.props.label)).toContain('Verified seller');
  });

  it('an unverified store, or an older server that sends nothing: no pill', () => {
    for (const extra of [{ isVerified: false }, {}]) {
      mocks.useStateCall = 0;
      mocks.vendor = { isLoading: false, isError: false, refetch: vi.fn(), data: store(extra) };
      expect(ofType(render(), 'TonePill').map((p) => p.props.label)).not.toContain('Verified seller');
    }
  });

  it('the description is shown through ItemDescription (clamped + Read more), not as a bare paragraph', () => {
    mocks.vendor = { isLoading: false, isError: false, refetch: vi.fn(), data: store({ isVerified: true }) };
    const tree = render();
    expect(ofType(tree, 'ItemDescription').map((n) => n.props.text)).toEqual([LONG]);
    expect(ofType(tree, 'T').map(text)).not.toContain(LONG);
  });

  it('storeLine: the city only when there is one', () => {
    expect(storeLine({ name: 'Craft & Kind', city: ' Georgetown ' })).toBe('Craft & Kind · Georgetown');
    expect(storeLine({ name: 'Craft & Kind', city: null })).toBe('Craft & Kind');
    expect(storeLine({ name: 'Craft & Kind', city: '  ' })).toBe('Craft & Kind');
  });
});
