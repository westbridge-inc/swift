import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  feed: {} as Record<string, any>,
  refetch: vi.fn(),
  focus: undefined as (() => void) | undefined,
}));
vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = {
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useState: (initial: unknown) => [initial, vi.fn()],
  };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 390 }) }, FlatList: 'FlatList', Pressable: 'Pressable',
  RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View',
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: (callback: () => void) => { mocks.focus = callback; },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({
  color: { surface: { subtle: 'surface-subtle' }, brand: { 500: 'brand-500' }, text: {}, border: {} },
  elevation: {}, radius: {}, space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, '3xl': 32 },
}));
vi.mock('../../../hooks/customer', () => ({
  useDiscoveryCategories: () => ({ data: { categories: [] } }),
  useMarketItems: () => ({ ...mocks.feed, refetch: mocks.refetch }),
  useAddToCart: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ status: 'unknown' }) }));
vi.mock('../../../lib/deviceLocation', () => ({ grantedLocationFix: () => null }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null }));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../kit/vertical-tint', () => ({ VERTICAL_TINT: { shops: {} } }));
vi.mock('../../../kit', () => Object.fromEntries([
  'Chip', 'EmptyState', 'ErrorState', 'LoadingBlock', 'Money', 'Photo', 'SectionHeader', 'T', 'TonePill', 'PillButton',
].map((name) => [name, name])));

import { MarketScreen } from './MarketScreen';

function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children), ...nodes(value.props?.ListHeaderComponent)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value?.props ? text(value.props.children) : '';
}
const updatedAt = Date.UTC(2026, 8, 30, 12, 15);
const items = [{ id: 'fixture-item', name: 'Fixture', vendorId: 'fixture-store', vendorName: 'Fixture store', basePrice: 100, isNew: false }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.focus = undefined;
  mocks.feed = {
    data: { pages: [{ items }] }, dataUpdatedAt: updatedAt, isFetchedAfterMount: true,
    isLoading: false, isFetching: false, isError: false, fetchStatus: 'idle',
  };
});

describe('SX375: Market cached prices stay visibly marked until refreshed', () => {
  it.each(['fetching', 'failed', 'paused', 'before-first-refresh'] as const)('%s marks retained prices and a successful refresh clears the notice', (state) => {
    Object.assign(mocks.feed, {
      isFetching: state === 'fetching', isError: state === 'failed',
      fetchStatus: state === 'paused' ? 'paused' : state === 'fetching' ? 'fetching' : 'idle',
      isFetchedAfterMount: state !== 'before-first-refresh',
    });
    const rendered = nodes(MarketScreen());
    const list = rendered.find((node) => node.type === 'FlatList');
    expect(list.props.data).toEqual(items);
    expect(rendered.some((node) => node.type === 'LoadingBlock' || node.type === 'ErrorState')).toBe(false);
    const notice = rendered.find((node) => node.props?.accessibilityLiveRegion === 'polite');
    expect(notice, 'cached prices need a visible freshness notice').toBeDefined();
    expect(text(notice)).toContain('Last updated');
    expect(text(notice)).toContain(new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    if (state === 'failed') {
      expect(text(notice)).toContain('Couldn’t refresh prices');
      const retry = nodes(notice).find((node) => node.type === 'PillButton' && node.props.label === 'Try again');
      retry.props.onPress();
      expect(mocks.refetch).toHaveBeenCalledOnce();
    }

    Object.assign(mocks.feed, { isFetching: false, isError: false, fetchStatus: 'idle', isFetchedAfterMount: true });
    expect(nodes(MarketScreen()).some((node) => node.props?.accessibilityLiveRegion === 'polite')).toBe(false);
    mocks.feed['data'] = undefined;
    mocks.feed['isError'] = true;
    const empty = nodes(MarketScreen());
    expect(empty.some((node) => node.props?.accessibilityLiveRegion === 'polite')).toBe(false);
    expect(empty.some((node) => node.type === 'ErrorState')).toBe(true);
  });

  it('refreshes on each tab focus without cancelling the existing mount request', () => {
    MarketScreen();
    expect(mocks.focus).toBeTypeOf('function');
    mocks.focus!();
    mocks.focus!();
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
    expect(mocks.refetch).toHaveBeenLastCalledWith({ cancelRefetch: false });
  });
});
