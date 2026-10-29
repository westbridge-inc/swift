import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct] The store board's switches show the tapped state while their request is out (as Store open does,
// PERF row 562): Pause / Resume new orders, "Deliver my own orders" and "Ask for the pickup code" used to stay where
// they were until the write AND a re-read of the store came back (~1.3 s on a mobile link). The board is rendered by
// calling VendorOps with its hooks stubbed (the harness of VendorOps.boardWait.test.ts).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  const idle = { mutate: () => undefined, isPending: false, variables: undefined as unknown };
  return { token, sub: {} as Record<string, unknown>, orders: [] as unknown[], pending: new Set<string>(), mutate: vi.fn(), sharedPending: false, steps: [] as Array<{ label: string; action: string }>,
    toggleOrders: { ...idle }, selfDelivery: { ...idle }, pickupCode: { ...idle } };
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
  ...Object.fromEntries(['useVendorOrderHistory', 'useToggleOpen', 'useVendorMenu', 'useVendorQr', 'useVendorAnalytics', 'useVendorRevenue', 'useVendorOps', 'useVendorHours', 'useDeliveryStatus'].map((name) => [name, () => ({})])),
  useToggleOrders: () => fx.toggleOrders,
  useSetSelfDelivery: () => fx.selfDelivery,
  useSetRequirePickupCode: () => fx.pickupCode,
  useVendorOrders: () => ({ data: fx.orders, isLoading: false, isError: false }),
  useOrderAction: () => ({ mutate: fx.mutate, isPending: false, variables: undefined }),
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

type El = { type: unknown; props: { children?: unknown; order?: any; busy?: boolean; onAction?: (..._a: any[]) => void } };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as El;
  const kids = typeof element.props.children === 'function' ? element.props.children({ pressed: false }) : element.props.children;
  return [element, ...elements(kids)];
}
const store = { id: 'store-A', name: 'Test store', status: 'ACTIVE', isCurrentlyOpen: true, acceptingOrders: true, selfDeliveryEnabled: false, requirePickupCode: false };
const board = () => VendorOps({ store, navigation: { navigate: vi.fn() } });
const switchNamed = (tree: unknown, label: string) => elements(tree).find((e) => (e.props as { accessibilityLabel?: string }).accessibilityLabel === label) as unknown as { props: { accessibilityState: { checked: boolean; busy: boolean } } } | undefined;
const buttonLabels = (tree: unknown) => elements(tree).map((e) => (e.props as { label?: unknown }).label).filter((l): l is string => typeof l === 'string');

describe('[TAP-AUDIT] the board\'s switches move at the tap', () => {
  it('nothing out: each switch shows the store as the server holds it', () => {
    fx.toggleOrders = { mutate: vi.fn(), isPending: false, variables: undefined };
    fx.selfDelivery = { mutate: vi.fn(), isPending: false, variables: undefined };
    fx.pickupCode = { mutate: vi.fn(), isPending: false, variables: undefined };
    const tree = board();
    expect(switchNamed(tree, 'Deliver my own orders')?.props.accessibilityState.checked).toBe(false);
    expect(buttonLabels(tree)).toContain('Pause new orders');
  });

  it('a tap out: Deliver my own orders shows ON at once (busy), the pickup-code switch shows ON, Pause shows Resume', () => {
    fx.toggleOrders = { mutate: vi.fn(), isPending: true, variables: false };
    fx.selfDelivery = { mutate: vi.fn(), isPending: true, variables: true };
    fx.pickupCode = { mutate: vi.fn(), isPending: true, variables: true };
    const tree = board();
    expect(switchNamed(tree, 'Deliver my own orders')?.props.accessibilityState).toMatchObject({ checked: true, busy: true });
    expect(switchNamed(tree, 'Ask for the pickup code')?.props.accessibilityState).toMatchObject({ checked: true, busy: true });
    expect(buttonLabels(tree)).toContain('Resume orders');
    expect(buttonLabels(tree)).not.toContain('Pause new orders');
  });
});
