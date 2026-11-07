import { describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { token, sub: {} as Record<string, unknown>, orders: [] as unknown[], pending: new Set<string>(), mutate: vi.fn(), sharedPending: true, steps: [] as Array<{ label: string; action: string }> };
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
  ...Object.fromEntries(['useVendorOrderHistory', 'useToggleOpen', 'useToggleOrders', 'useSetSelfDelivery', 'useSetRequirePickupCode', 'useVendorMenu', 'useVendorQr', 'useVendorAnalytics', 'useVendorRevenue', 'useVendorOps', 'useVendorHours', 'useDeliveryStatus'].map((name) => [name, () => ({})])),
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
  // The shared step list (pinned by its own tests); the card adds the hand-overs on top.
  orderActions: () => fx.steps,
  OrderStatusPill: 'OrderStatusPill', FulfillmentTag: 'FulfillmentTag', MmgDisputeNotice: 'MmgDisputeNotice', DeltaBadge: 'DeltaBadge',
  fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '',
}));
import { VendorOps } from './VendorOps';

// ---------------------------------------------------------------------------
// [STORE-DASH · REVIEW-F M-F217 on #2033] The owner's core ask at BOARD level:
// while order A's tap is out, order B's card is not busy and B's tap goes
// out at once. The board is rendered by calling VendorOps with its hooks
// stubbed (the harness of weekly-fee-billing-census.test.ts); the cards are
// read from the element tree it returns.
// ---------------------------------------------------------------------------

type El = { type: unknown; props: { children?: unknown; order?: any; busy?: boolean; onAction?: (..._a: any[]) => void } };
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
    b.props.onAction!('ready');
    expect(fx.mutate).toHaveBeenCalledWith({ id: 'order-b', action: 'ready', code: undefined });
  });

  it('[#2033 F S4-2 · O-2] the card\'s hand-overs go out in one tap: "Handed to customer" with no code, "Handed to rider"; the order is not opened', () => {
    fx.orders = [{ ...order('order-t', 'READY_FOR_PICKUP'), fulfillment: 'PICKUP', pickupCodeRequired: false }, { ...order('order-r', 'RIDER_ARRIVED_PICKUP'), riderId: 'r-1', handedToRiderAt: null }];
    fx.pending = new Set();
    fx.mutate.mockClear();
    const navigation = { navigate: vi.fn() };
    const tree = VendorOps({ store: { id: 'store-A', name: 'Test store', status: 'ACTIVE', isCurrentlyOpen: true, acceptingOrders: true }, navigation });
    const shown = cards(tree);
    shown.find((c) => c.props.order.id === 'order-t')!.props.onAction!('handed-to-customer');
    shown.find((c) => c.props.order.id === 'order-r')!.props.onAction!('handed-to-rider');
    expect(fx.mutate.mock.calls).toEqual([
      [{ id: 'order-t', action: 'handed-to-customer', code: undefined }],
      [{ id: 'order-r', action: 'handed-to-rider', code: undefined }],
    ]);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('nothing out: no card waits', () => {
    fx.orders = [order('order-a', 'PENDING'), order('order-b', 'PREPARING')];
    fx.pending = new Set();
    expect(cards(board()).every((c) => c.props.busy === false)).toBe(true);
  });
});

// [REVIEW-F S3-1 on #2054] The board CARD itself (its function called with the
// board's own props): on an order paused for an MMG payment review there is no
// hand-over prompt — no "Handed to rider", no rider check, no name check —
// right under "Don't hand anything over until then". Controls: the same orders
// unpaused show them.
describe('[REVIEW-F S3-1 on #2054] the board card: no hand-over prompt on a paused order', () => {
  const pause = { paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: '2026-10-23T09:05:00.000Z' };
  const riderOrder = (extra: Record<string, unknown> = {}) => ({ ...order('order-r', 'RIDER_ARRIVED_PICKUP'), riderId: 'r-1', rider: { user: { firstName: 'Devon' } }, handedToRiderAt: null, ...extra });
  const takeaway = (extra: Record<string, unknown> = {}) => ({ ...order('order-t', 'READY_FOR_PICKUP'), fulfillment: 'PICKUP', customer: { firstName: 'Asha' }, pickupCodeRequired: false, ...extra });
  function cardTree(o: { id: string } & Record<string, unknown>) {
    fx.orders = [o];
    fx.pending = new Set();
    fx.steps = [];
    const card = cards(board()).find((c) => c.props.order.id === o.id)! as El & { type: { type: (_p: unknown) => unknown } };
    return elements(card.type.type(card.props));
  }
  const labels = (tree: El[]) => tree.map((e) => (e.props as { label?: unknown }).label).filter(Boolean);
  const texts = (tree: El[]) => tree.flatMap((e) => (typeof e.props.children === 'string' ? [e.props.children] : Array.isArray(e.props.children) ? e.props.children.filter((c: unknown) => typeof c === 'string') : []));
  const riderCheck = (tree: El[]) => tree.some((e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'RiderHandoverLine');

  it('control: an unpaused rider delivery offers "Handed to rider" with the rider check', () => {
    const tree = cardTree(riderOrder());
    expect(labels(tree)).toContain('Handed to rider');
    expect(riderCheck(tree)).toBe(true);
  });
  it('paused rider delivery: no "Handed to rider", no rider check', () => {
    const tree = cardTree(riderOrder(pause));
    expect(labels(tree)).not.toContain('Handed to rider');
    expect(riderCheck(tree)).toBe(false);
  });
  it('control: an unpaused takeaway with the code off says to check the name', () => {
    expect(texts(cardTree(takeaway()))).toContain('Check the name before you hand it over: Asha · order #ORDER-T');
  });
  it('paused takeaway with the code off: no name check, only that the customer collects', () => {
    const shown = texts(cardTree(takeaway(pause)));
    expect(shown).toContain('The customer collects this order.');
    expect(shown.some((t) => t.startsWith('Check the name'))).toBe(false);
  });
});
