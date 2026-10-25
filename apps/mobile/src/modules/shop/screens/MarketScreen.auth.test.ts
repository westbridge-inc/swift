import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticated: false, promptLogin: vi.fn(), mutate: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = { useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, vi.fn()] };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({ Dimensions: { get: () => ({ width: 390 }) }, FlatList: 'FlatList', Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: '', base: '' }, brand: { 500: '' }, text: {}, border: {} }, elevation: {}, radius: {}, space: { '2xl': 24, lg: 12 } }));
vi.mock('../../../hooks/customer', () => ({
  useDiscoveryCategories: () => ({ data: { categories: [] } }),
  useMarketItems: () => ({ data: { pages: [{ items: [{ id: 'item-a', vendorId: 'vendor-a', name: 'Synthetic item' }] }] }, refetch: vi.fn() }),
  useAddToCart: () => ({ mutate: mocks.mutate, isPending: false }),
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
function pressAdd() {
  const list = find(MarketScreen()); expect(list).toBeDefined();
  const item = list.props.data[0];
  list.props.renderItem({ item }).props.onAdd(item);
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticated = false;
  mocks.mutate.mockImplementation(() => { if (!mocks.authenticated) throw new Error('Guest capture refusal'); });
});
describe('Market Add account guard', () => {
  it('guest Add opens sign-in without invoking the mutation or throwing', () => {
    expect(pressAdd).not.toThrow(); expect(mocks.promptLogin).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
  });
  it('signed-in Add keeps the existing cart payload and success feedback', () => {
    mocks.authenticated = true; pressAdd(); expect(mocks.promptLogin).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledWith({ vendorId: 'vendor-a', itemId: 'item-a', quantity: 1 }, expect.any(Object));
    mocks.mutate.mock.calls[0]![1].onSuccess(); expect(mocks.success).toHaveBeenCalledWith('Synthetic item added');
  });
});
