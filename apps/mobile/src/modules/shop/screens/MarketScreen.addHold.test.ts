import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct] The Market's + on a card: only THAT card waits for its add (one shared "adding" used to hold every
// card's + until the answer); a second tap on the same card while it adds sends nothing; another card's add goes at once.
// MarketScreen is called as a function with its hooks stubbed (the harness of MarketScreen.auth.test.ts).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({ authenticated: false, promptLogin: vi.fn(), mutate: vi.fn(), mutateAsync: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = { useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, vi.fn()], useRef: (value: unknown) => ({ current: value }) };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({ Dimensions: { get: () => ({ width: 390 }) }, FlatList: 'FlatList', Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: '', base: '' }, brand: { 500: '' }, text: {}, border: {} }, elevation: {}, radius: {}, space: { '2xl': 24, lg: 12 } }));
vi.mock('../../../hooks/customer', () => ({
  useDiscoveryCategories: () => ({ data: { categories: [] } }),
  useMarketItems: () => ({ data: { pages: [{ items: [{ id: 'item-a', vendorId: 'vendor-a', name: 'Synthetic item' }, { id: 'item-b', vendorId: 'vendor-a', name: 'Second item' }] }] }, refetch: vi.fn() }),
  useAddToCart: () => ({ mutate: mocks.mutate, mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: mocks.authenticated, promptLogin: mocks.promptLogin }) }));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ status: 'denied' }) }));
vi.mock('../../../lib/deviceLocation', () => ({ grantedLocationFix: () => null }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null }));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));
vi.mock('../../../kit/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../../../kit/vertical-tint', () => ({ VERTICAL_TINT: { shops: {} } }));
vi.mock('../../../kit', () => Object.fromEntries(['Chip', 'EmptyState', 'ErrorState', 'LoadingBlock', 'Money', 'Photo', 'SectionHeader', 'T', 'TonePill'].map((n) => [n, n])));

import { MarketScreen } from './MarketScreen';
function find(node: any): any {
  if (node?.type === 'FlatList') return node;
  for (const child of [node?.props?.children].flat(Infinity)) { const found = child && find(child); if (found) return found; }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticated = true;
  mocks.mutateAsync.mockImplementation(() => new Promise(() => {})); // still on its way
});
describe('[TAP-AUDIT] the Market\'s + holds only its own card', () => {
  it('a second tap on the card being added sends nothing; another card goes at once; neither card is told it is busy by the other', () => {
    const list = find(MarketScreen());
    const [a, b] = list.props.data;
    const onAdd = list.props.renderItem({ item: a }).props.onAdd;
    onAdd(a);
    onAdd(a);
    expect(list.props.renderItem({ item: a }).props.adding, 'the tapped card waits').toBe(true);
    expect(list.props.renderItem({ item: b }).props.adding, 'the other card is not held by this one').toBe(false);
    onAdd(b);
    expect(mocks.mutateAsync.mock.calls.map((c: unknown[]) => (c[0] as { itemId: string }).itemId)).toEqual(['item-a', 'item-b']);
  });
});
