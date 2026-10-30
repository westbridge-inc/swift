import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ChainCheckout, ChainFees } from '../../../lib/chain-fee';

// ---------------------------------------------------------------------------
// [ENTERPRISE E1b · owner 29 Oct 2026] "Pay all my branches" on the phone (MMG-CHECKOUT-API.md section 12). A small
// hook host keeps state and runs effects without a simulator (as WeeklyFeeScreen.lifecycle.test.ts does); the screen,
// the shared checkout session and its words are real code. Synthetic branches only.
// ---------------------------------------------------------------------------

const host = vi.hoisted(() => ({
  index: 0, slots: [] as Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
  start: vi.fn(), read: vi.fn(), list: vi.fn(), open: vi.fn(), refetch: vi.fn(), keys: 0,
  query: { data: undefined as unknown, isLoading: false, isError: false },
  profile: { myRole: 'OWNER' as string | undefined, state: 'ready', stores: [{ id: 'store-A' }, { id: 'store-B' }], refetch: vi.fn() },
  stepUp: 'pass' as 'pass' | 'dismiss',
  previewType: null as string | null,
  push: vi.fn(), navigate: vi.fn(),
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const next = () => { const i = host.index++; return host.slots[i] ?? (host.slots[i] = {}); };
  const differs = (before?: unknown[], after?: unknown[]) => !before || !after || before.length !== after.length || after.some((v, i) => !Object.is(v, before[i]));
  const memo = (fn: () => unknown, deps?: unknown[]) => { const slot = next(); if (differs(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; } return slot.value; };
  const hooks = {
    useMemo: memo, useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
    useState: (initial: unknown) => { const slot = next(); if (!('value' in slot)) slot.value = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [slot.value, (value: unknown) => { slot.value = value; }]; },
    useRef: (current: unknown) => { const slot = next(); return slot.value ?? (slot.value = { current }); },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const slot = next(); if (differs(slot.deps, deps)) { slot.deps = deps; host.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; }); }
    },
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl', AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {}, useNavigation: () => ({ push: host.push, navigate: host.navigate }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ ...host.query, refetch: host.refetch }) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: host.open }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `tap-key-${++host.keys}` }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ErrorState', 'Header', 'LoadingBlock', 'PillButton', 'Screen', 'T'].map((name) => [name, name])));
vi.mock('../../../services/api', () => ({ chainFeeApi: () => ({ list: host.list, start: host.start, read: host.read }) }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (pick: (_s: unknown) => unknown) => pick({ user: { id: 'test-owner' }, sessionGeneration: 1, intent: 'vendor' }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({ selectedStoreId: 'store-B', feeContextPending: false }) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (_s: unknown) => unknown) => pick({ previewType: host.previewType }) }));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }) }));
vi.mock('../../../hooks/vendorops', () => ({ useVendorProfile: () => host.profile, useVendorSubscription: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }) }));
vi.mock('../../../hooks/useStepUp', async () => {
  const { StepUpDismissed } = await import('../../../lib/stepUp');
  return { useStepUp: () => ({ withStepUp: (fn: (..._a: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => { if (host.stepUp === 'dismiss') throw new StepUpDismissed(); return fn(...args); }, sheet: 'StepUpSheet', active: false }) };
});
vi.mock('../../billing/screens/WeeklyFeeScreen', () => ({ WeeklyFeeScreen: 'WeeklyFeeScreen' }));
vi.mock('../../mover/screens/MoverSwiftNumberScreen', () => ({ MoverSwiftNumberScreen: 'MoverSwiftNumberScreen' }));
import { VendorPayAll, VendorPayAllScreen } from './VendorPayAllScreen';
import { VendorSwiftNumberScreen } from './VendorSwiftNumberScreen';
import { WeeklyFeeRouteScreen } from '../../billing/screens/WeeklyFeeRouteScreen';

type El = ReactElement<{ children?: unknown; label?: string; onPress?: () => void; tone?: string; checkoutRef?: string; onPayAll?: () => void }>;
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  const props = (node as El).props;
  return props ? [props.label, text(props.children)].filter(Boolean).join(' ') : '';
}
function find(node: unknown, pick: (_e: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, pick));
  if (node == null || typeof node !== 'object') return [];
  const e = node as El;
  return [...(e.props && pick(e) ? [e] : []), ...(e.props ? find(e.props.children, pick) : [])];
}
const fees = (over: Partial<ChainFees> = {}): ChainFees => ({
  branches: [
    { vendorId: 'store-A', branchName: 'North', subscriptionId: 's1', subscriptionStatus: 'ACTIVE', state: 'DUE', amountGyd: 12000 },
    { vendorId: 'store-B', branchName: 'Camp', subscriptionId: 's2', subscriptionStatus: 'PAST_DUE', state: 'DUE', amountGyd: 9000 },
    { vendorId: 'store-C', branchName: 'East', subscriptionId: 's3', subscriptionStatus: 'TRIAL', state: 'TRIAL', amountGyd: null },
  ],
  totalGyd: 21000, currencyCode: 'GYD', payable: true, recentCheckouts: [], ...over,
});
const checkout = (status: ChainCheckout['status']): ChainCheckout => ({
  ref: 'chain-ref', status, amountGyd: 21000, currencyCode: 'GYD', createdAt: '2026-10-30T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  confirmedAt: status === 'CONFIRMED' ? '2026-10-30T12:05:00Z' : null, swiftReference: '123456789012345678', mmgTransactionId: status === 'CONFIRMED' ? 'MMG-9' : null,
  branches: [{ vendorId: 'store-A', branchName: 'North', subscriptionId: 's1', amountGyd: 12000 }, { vendorId: 'store-B', branchName: 'Camp', subscriptionId: 's2', amountGyd: 9000 }],
});
function render(checkoutRef?: string) {
  host.index = 0;
  const tree = VendorPayAll({ storeId: 'store-B', checkoutRef });
  for (const run of host.effects.splice(0)) run();
  return tree;
}
const payButton = (tree: unknown) => find(tree, (e) => e.type === 'PillButton' && /^Pay GY/.test(String(e.props.label)))[0];

beforeEach(() => {
  vi.useFakeTimers();
  host.slots = []; host.index = 0; host.effects = []; host.keys = 0; host.stepUp = 'pass'; host.previewType = null;
  host.query = { data: fees(), isLoading: false, isError: false };
  host.profile = { myRole: 'OWNER', state: 'ready', stores: [{ id: 'store-A' }, { id: 'store-B' }], refetch: vi.fn() };
  host.start.mockReset().mockResolvedValue({ ref: 'chain-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/page', amountGyd: 21000, currencyCode: 'GYD', expiresAt: '2099-01-01T00:00:00Z' });
  host.read.mockReset().mockResolvedValue(checkout('OPEN'));
  host.open.mockReset().mockResolvedValue({ type: 'dismiss' });
  host.refetch.mockReset(); host.push.mockReset(); host.navigate.mockReset();
});
afterEach(() => { for (const slot of host.slots) slot.cleanup?.(); vi.useRealTimers(); });

describe('[E1b] the phone\'s pay-all screen', () => {
  it('the owner sees each branch, the server\'s total and true words, and pays the list as shown in one MMG checkout', async () => {
    const tree = render();
    const words = text(tree);
    expect(words).toContain('North GY$12,000');
    expect(words).toContain('East Not charged: in its free trial');
    expect(words).toContain('Total due: GY$21,000 for 2 branches');
    expect(words).toContain('This is optional. Each branch can still pay its own fee on its own Weekly fee page.');
    expect(words).toContain('is not in this payment and is not charged.');
    expect(words).toContain('Nothing is marked paid until MMG confirms the payment.');
    payButton(tree)!.props.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.start).toHaveBeenCalledExactlyOnceWith('tap-key-1', { branches: [{ subscriptionId: 's1', amountGyd: 12000 }, { subscriptionId: 's2', amountGyd: 9000 }], totalGyd: 21000 });
    expect(host.open).toHaveBeenCalledWith('https://checkout.test/page', 'swift://pay/mmg/return');
    expect(host.read).toHaveBeenCalledWith('chain-ref');
    const after = render();
    expect(text(after)).toContain('Waiting for MMG…');
    expect(text(after)).not.toContain('Paid:');
    expect(payButton(after)).toBeUndefined();
  });

  it('closing "Confirm it\'s you" opens nothing and shows no error', async () => {
    host.stepUp = 'dismiss';
    payButton(render())!.props.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.start).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
    const after = render();
    expect(find(after, (e) => e.type === 'T' && e.props.tone === 'error')).toEqual([]);
    expect(payButton(after)).toBeTruthy();
  });

  it('changed fees: the list is read again and the owner is asked to check it', async () => {
    host.start.mockRejectedValue({ response: { status: 409, data: { error: { code: 'PAYMENT_QUOTE_CHANGED' } } } });
    payButton(render())!.props.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.refetch).toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
    expect(text(render())).toContain('The weekly fees changed. Check the list again, then pay.');
  });

  it.each(['OPEN', 'CONFIRMING', 'HELD', 'EXPIRED'] as const)('a pay-all that is %s keeps Pay away and says its branches are paused', async (status) => {
    host.query = { data: fees({ recentCheckouts: [checkout(status)] }), isLoading: false, isError: false };
    host.read.mockResolvedValue(checkout(status));
    render(); await vi.advanceTimersByTimeAsync(0);
    const tree = render();
    expect(payButton(tree)).toBeUndefined();
    expect(text(tree)).toContain("its branches can't be paid on their own, so no fee is paid twice.");
  });

  it('a confirmed pay-all shows each branch\'s share and both references; a notice\'s ref is followed', async () => {
    host.query = { data: fees({ recentCheckouts: [checkout('CONFIRMED')] }), isLoading: false, isError: false };
    host.read.mockResolvedValue(checkout('CONFIRMED'));
    render('notice-ref'); await vi.advanceTimersByTimeAsync(0);
    expect(host.read).toHaveBeenCalledWith('notice-ref');
    const words = text(render('notice-ref'));
    expect(words).toContain('Paid: GY$21,000 received on 30 Oct 2026 for 2 branches.');
    expect(words).toContain('North: GY$12,000');
    expect(words).toContain('Swift reference: 123456789012345678');
    expect(words).toContain('MMG transaction ID: MMG-9');
  });

  it('nothing due, or an account that may not open MMG: no Pay button at all', () => {
    host.query = { data: fees({ branches: [fees().branches[2]!], totalGyd: 0, payable: false }), isLoading: false, isError: false };
    let tree = render();
    expect(text(tree)).toContain('No branch has a weekly fee to pay with MMG right now.');
    expect(payButton(tree)).toBeUndefined();
    host.slots = [];
    host.query = { data: fees({ payable: false }), isLoading: false, isError: false };
    tree = render();
    expect(text(tree)).toContain("Paying all branches with MMG isn't available for this account right now.");
    expect(payButton(tree)).toBeUndefined();
  });
});

describe('[E1b] who is offered it', () => {
  it.each(['MANAGER', 'STAFF'])('a %s is told only the owner pays all branches; the pay-all body (and its fees read) never mounts', (role) => {
    host.profile = { ...host.profile, myRole: role };
    host.index = 0;
    const tree = VendorPayAllScreen({});
    expect(text(tree)).toContain('Only the business owner can pay all branches at once.');
    expect(find(tree, (e) => e.type === VendorPayAll)).toEqual([]);
  });

  it('the owner gets the pay-all body, on the notice\'s ref', () => {
    host.index = 0;
    const tree = VendorPayAllScreen({ checkoutRef: 'chain-ref' });
    const body = find(tree, (e) => e.type === VendorPayAll);
    expect(body).toHaveLength(1);
    expect(body[0]!.props.checkoutRef).toBe('chain-ref');
  });

  it('the Weekly fee route opens pay-all only when asked to', () => {
    host.index = 0;
    const payAll = WeeklyFeeRouteScreen({ route: { params: { feeFamily: 'vendor', payAll: true, ref: 'chain-ref' } } }) as El;
    expect(payAll.type).toBe(VendorPayAllScreen);
    expect(payAll.props.checkoutRef).toBe('chain-ref');
    host.index = 0;
    expect((WeeklyFeeRouteScreen({ route: { params: { feeFamily: 'vendor' } } }) as El).type).toBe(VendorSwiftNumberScreen);
  });

  it('the owner of several stores gets the door on their Weekly fee screen; it opens pay-all', () => {
    host.index = 0;
    const screen = VendorSwiftNumberScreen({}) as El;
    expect(screen.type).toBe('WeeklyFeeScreen');
    screen.props.onPayAll!();
    expect(host.push).toHaveBeenCalledExactlyOnceWith('WeeklyFee', { feeFamily: 'vendor', payAll: true });
  });

  it.each([
    ['a manager', { myRole: 'MANAGER' }, null],
    ['staff', { myRole: 'STAFF' }, null],
    ['an owner of one store', { stores: [{ id: 'store-B' }] }, null],
    ['a sample preview', {}, 'RESTAURANT'],
  ] as Array<[string, Partial<typeof host.profile>, string | null]>)('%s never gets the door', (_who, over, previewType) => {
    host.profile = { ...host.profile, ...over };
    host.previewType = previewType;
    host.index = 0;
    expect((VendorSwiftNumberScreen({}) as El).props.onPayAll).toBeUndefined();
  });
});
