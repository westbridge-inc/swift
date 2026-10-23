import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { token, sub: {} as Record<string, unknown>, orders: [] as unknown[], pending: new Set<string>(), mutate: vi.fn(), sharedPending: true };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const hooks = { useState: (initial: unknown) => [initial, vi.fn()], useEffect: () => {} };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@swift/ui', () => ({ color: fx.token, elevation: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'Chip', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'T', 'TonePill'].map((name) => [name, name])));
vi.mock('../../../kit/switch', () => ({ Switch: 'Switch' }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: vi.fn() }));
vi.mock('../../../services/socket', () => ({ disconnectSocket: vi.fn() }));
vi.mock('../../../components/onboarding/DocumentUploadCard', () => ({ docLabel: () => '' }));
vi.mock('../../../hooks/verification', () => ({ useVerificationStatus: () => ({}) }));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false }) }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../../../hooks/vendorops', () => ({
  useVendorProfile: () => ({ stores: [], owner: { myRole: 'OWNER' } }),
  useVendorSubscription: () => ({ data: fx.sub }),
  ...Object.fromEntries(['useVendorOrderHistory', 'useToggleOpen', 'useToggleOrders', 'useSetSelfDelivery', 'useVendorMenu', 'useVendorQr', 'useVendorAnalytics', 'useVendorRevenue', 'useVendorOps', 'useVendorHours'].map((name) => [name, () => ({})])),
  useVendorOrders: () => ({ data: fx.orders, isLoading: false, isError: false }),
  // The ONE shared mutation is busy (a tap on order A is out): a board wired to its isPending would freeze every card.
  useOrderAction: () => ({ mutate: fx.mutate, isPending: fx.sharedPending, variables: { id: 'order-a', action: 'accept' } }),
  usePendingOrderIds: () => fx.pending,
}));
vi.mock('../../../modules/vendor/shared', () => ({
  safeVendorRole: (role: string) => role,
  fmtDate: (date: string) => date.slice(0, 10),
  reconciledRevenueDays: () => [], windowTotals: () => ({}), numericFact: () => null,
  TYPES: {}, GUTTER: 0, TabHeader: 'TabHeader', DAY_LABELS: [], catalogueMeta: () => ({}),
  BoardFirstRun: 'BoardFirstRun', BoardFirstRunRow: 'BoardFirstRunRow',
}));
import { VendorOps } from './VendorOps';

// ---------------------------------------------------------------------------
// [STORE-DASH · REVIEW-F M-F217 on #2033] The owner's core ask at BOARD level:
// while order A's tap is out, order B's card is not busy and B's tap goes
// out at once. The board is rendered by calling VendorOps with its hooks
// stubbed (the harness of weekly-fee-billing-census.test.ts); the cards are
// read from the element tree it returns.
// ---------------------------------------------------------------------------

type El = { type: unknown; props: Record<string, any> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as El;
  const kids = typeof element.props.children === 'function' ? element.props.children({ pressed: false }) : element.props.children;
  return [element, ...elements(kids)];
}
const cards = (tree: unknown) => elements(tree).filter((e) => e.props && typeof e.props.order === 'object' && e.props.order && 'busy' in e.props);

const order = (id: string, status: string) => ({ id, orderNumber: id.toUpperCase(), status, items: [], fulfillment: 'DELIVERY', paymentMethod: 'CASH' });
function board() {
  return VendorOps({ store: { id: 'store-A', name: 'Test store', status: 'ACTIVE', isCurrentlyOpen: true, acceptingOrders: true }, navigation: { navigate: vi.fn() } });
}

describe('[STORE-DASH] the board: only the tapped order waits', () => {
  it('order A has a tap out: A\'s card is busy, B\'s and C\'s are not', () => {
    fx.orders = [order('order-a', 'PENDING'), order('order-b', 'PREPARING'), order('order-c', 'PENDING')];
    fx.pending = new Set(['order-a']);
    const shown = cards(board());
    expect(shown.map((c) => c.props.order.id).sort()).toEqual(['order-a', 'order-b', 'order-c']);
    expect(Object.fromEntries(shown.map((c) => [c.props.order.id, c.props.busy]))).toEqual({ 'order-a': true, 'order-b': false, 'order-c': false });
  });

  it('B\'s tap goes out at once while A\'s is still out', () => {
    fx.orders = [order('order-a', 'PENDING'), order('order-b', 'PREPARING')];
    fx.pending = new Set(['order-a']);
    fx.mutate.mockClear();
    const b = cards(board()).find((c) => c.props.order.id === 'order-b')!;
    b.props.onAction('ready');
    expect(fx.mutate).toHaveBeenCalledWith({ id: 'order-b', action: 'ready', code: undefined });
  });

  it('nothing out: no card waits', () => {
    fx.orders = [order('order-a', 'PENDING'), order('order-b', 'PREPARING')];
    fx.pending = new Set();
    expect(cards(board()).every((c) => c.props.busy === false)).toBe(true);
  });
});
