import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap"] A grocery or shop store ticks every line of an order as it
// picks. The box used to tick only after the write AND a re-read of every vendor order query (the board, every open
// order, the history): ~1.3 s a line on a mobile link, so a 20-line order was ~26 s of waiting. Now the tick shows at
// the tap, the server's answer is written, a refusal puts it back, and the order alone is read again once after the
// last tick. The board's switches (Pause / Resume, Deliver my own orders, Ask for the pickup code) take the server's
// answer at once instead of waiting for a second round trip. Driven through the REAL hooks with a real query cache.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  invalidated: [] as unknown[],
  store: { selectedStoreId: 'store-a' as string | null, storeGeneration: 1 },
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
  toastError: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: vi.fn(), useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ vendorApi: fx.api, vendorDiscoveryApi: {} }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('./useVendorMutation', () => ({ guardVendorOperation: vi.fn(), useVendorMutation: (options: unknown) => options }));
vi.mock('../lib/vendorPreviewData', () => ({
  vendorPreviewDataset: () => null, vendorPreviewSubscription: () => null, previewQuery: vi.fn(), previewMutation: vi.fn(), VENDOR_PREVIEW_MARKET: {},
}));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => fx.store }) }));
vi.mock('../kit/toast', () => ({ toast: { error: fx.toastError, show: vi.fn(), success: vi.fn() } }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { PICK_KEY, usePickingActions, useSetRequirePickupCode, useSetSelfDelivery, useToggleOrders } from './vendorops';

type Hook = {
  mutationKey?: unknown;
  mutationFn: (vars: any) => Promise<unknown>;
  onMutate?: (vars: any) => unknown;
  onSuccess?: (answer: any, vars: any, ctx: any) => unknown;
  onError?: (error: unknown, vars: any, ctx: any) => unknown;
  onSettled?: (answer: any, error: unknown, vars: any, ctx: any) => unknown;
};
const DETAIL = ['vendor', 'orders', 'detail', 'o1'];
const BOARD = ['vendor', 'orders'];
const PROFILE = ['vendor', 'profile'];
const order = () => ({ id: 'o1', status: 'PREPARING', items: [{ id: 'l1', name: 'Rice', picked: false }, { id: 'l2', name: 'Oil', picked: false }] });
const line = (key: unknown[], id: string) => (fx.qc.getQueryData<any>(key)?.items ?? (fx.qc.getQueryData<any[]>(key) ?? [])[0]?.items ?? []).find((l: any) => l.id === id);
const keyText = (k: unknown) => JSON.stringify(k);

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated.length = 0;
  fx.store.selectedStoreId = 'store-a';
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
  fx.qc.setQueryData(DETAIL, order());
  fx.qc.setQueryData(BOARD, [order()]);
  fx.qc.setQueryData(PROFILE, { id: 'owner', myRole: 'OWNER', vendors: [
    { id: 'store-a', acceptingOrders: true, isCurrentlyOpen: true, selfDeliveryEnabled: false, requirePickupCode: false },
    { id: 'store-b', acceptingOrders: true, isCurrentlyOpen: true, selfDeliveryEnabled: false, requirePickupCode: false },
  ] });
  Object.assign(fx.api, {
    setLinePicked: vi.fn(async (_o: string, lineId: string, picked: boolean) => ({ data: { data: { id: lineId, picked } } })),
    toggleOrders: vi.fn(async (accepting: boolean) => ({ data: { data: { isCurrentlyOpen: true, acceptingOrders: accepting } } })),
    updateProfile: vi.fn(async (body: Record<string, boolean>) => ({ data: { data: { id: 'store-a', selfDeliveryEnabled: false, requirePickupCode: false, ...body } } })),
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('[TAP-AUDIT] a pick tick shows at the tap', () => {
  const usePicker = () => (usePickingActions() as unknown as { setPicked: Hook }).setPicked;

  it('the box ticks on the order AND its board card before the server answers', async () => {
    await usePicker().onMutate?.({ orderId: 'o1', lineId: 'l1', picked: true });
    expect(line(DETAIL, 'l1').picked).toBe(true);
    expect(line(BOARD, 'l1').picked).toBe(true);
    expect(line(DETAIL, 'l2').picked, 'the other line is untouched').toBe(false);
  });

  it('a refused tick puts the box back', async () => {
    const hook = usePicker();
    await hook.onMutate?.({ orderId: 'o1', lineId: 'l1', picked: true });
    hook.onError?.(new Error('refused'), { orderId: 'o1', lineId: 'l1', picked: true }, undefined);
    expect(line(DETAIL, 'l1').picked).toBe(false);
    expect(line(BOARD, 'l1').picked).toBe(false);
  });

  it('[REVIEW-F #2143 S3-2] ... and says why: the server\'s words, or plain words, once (the app-wide notice is quiet)', async () => {
    fx.toastError.mockClear();
    const hook = usePicker() as Hook & { meta?: Record<string, unknown> };
    expect(hook.meta?.['silent'], 'one message, not two').toBe(true);
    hook.onError?.({ response: { data: { error: { code: 'ORDER_MOVED_ON', message: 'This order has moved on.' } } } }, { orderId: 'o1', lineId: 'l1', picked: true }, undefined);
    await vi.waitFor(() => expect(fx.toastError).toHaveBeenLastCalledWith('That tick didn’t save', 'This order has moved on.'));
    hook.onError?.({}, { orderId: 'o1', lineId: 'l1', picked: true }, undefined);
    await vi.waitFor(() => expect(fx.toastError).toHaveBeenLastCalledWith('That tick didn’t save', 'Check your connection and tap it again.'));
    hook.onError?.({ message: 'Network Error' }, { orderId: 'o1', lineId: 'l1', picked: true }, undefined);
    await vi.waitFor(() => expect(fx.toastError.mock.calls.at(-1)?.[1]).toMatch(/offline/i));
  });

  it('[REVIEW-M #2143 S4-2] the server\'s answer wins over the tap (another device unticked it)', async () => {
    const hook = usePicker();
    const vars = { orderId: 'o1', lineId: 'l1', picked: true };
    await hook.onMutate?.(vars);
    expect(line(DETAIL, 'l1').picked).toBe(true);
    hook.onSuccess?.({ id: 'l1', picked: false }, vars, undefined);
    expect(line(DETAIL, 'l1').picked).toBe(false);
    expect(line(BOARD, 'l1').picked).toBe(false);
  });

  it('the answer is written, and only this order is read again (not the board, every open order and the history)', async () => {
    const hook = usePicker();
    const vars = { orderId: 'o1', lineId: 'l1', picked: true };
    await hook.onMutate?.(vars);
    const answer = await hook.mutationFn(vars);
    expect(hook.onSuccess?.(answer, vars, undefined), 'nothing to wait for').toBeUndefined();
    hook.onSettled?.(answer, null, vars, undefined);
    expect(line(DETAIL, 'l1').picked).toBe(true);
    expect(fx.invalidated.map(keyText)).toEqual([keyText(DETAIL)]);
    expect(hook.mutationKey).toEqual(PICK_KEY);
  });

  it('while another tick is still out, the re-read waits for the last one', async () => {
    const hook = usePicker();
    const out = fx.qc.getMutationCache().build(fx.qc, { mutationKey: [...PICK_KEY], mutationFn: () => new Promise<void>(() => undefined) });
    void out.execute(undefined);
    const extra = fx.qc.getMutationCache().build(fx.qc, { mutationKey: [...PICK_KEY], mutationFn: () => new Promise<void>(() => undefined) });
    void extra.execute(undefined);
    hook.onSettled?.({}, null, { orderId: 'o1', lineId: 'l1', picked: true }, undefined);
    expect(fx.invalidated).toEqual([]);
  });

  it('a read already on its way is cancelled before the tick shows (it would land with the box unticked)', async () => {
    let land!: (o: unknown) => void;
    const stale = fx.qc.fetchQuery({ queryKey: DETAIL, queryFn: () => new Promise((resolve) => { land = resolve; }), staleTime: 0 }).catch(() => undefined);
    await usePicker().onMutate?.({ orderId: 'o1', lineId: 'l1', picked: true });
    land(order());
    await stale;
    expect(line(DETAIL, 'l1').picked).toBe(true);
  });
});

describe('[TAP-AUDIT] the board\'s switches take the server\'s answer at once', () => {
  it('Pause new orders: both flags from the answer go into THIS store; the re-read is not awaited', async () => {
    const hook = useToggleOrders() as unknown as Hook;
    const storeId = hook.onMutate?.(false);
    expect(storeId).toBe('store-a');
    const answer = await hook.mutationFn(false);
    expect(hook.onSuccess?.(answer, false, storeId)).toBeUndefined();
    const vendors = fx.qc.getQueryData<any>(PROFILE).vendors;
    expect(vendors[0].acceptingOrders).toBe(false);
    expect(vendors[1].acceptingOrders, 'the other store').toBe(true);
  });

  it('Deliver my own orders: the saved value is in the store at the answer; nothing awaited', async () => {
    const hook = useSetSelfDelivery() as unknown as Hook;
    const storeId = hook.onMutate?.(true);
    const answer = await hook.mutationFn(true);
    expect(hook.onSuccess?.(answer, true, storeId)).toBeUndefined();
    expect(fx.qc.getQueryData<any>(PROFILE).vendors[0].selfDeliveryEnabled).toBe(true);
    expect(fx.invalidated.map(keyText)).toEqual([keyText(PROFILE)]);
  });

  it('Ask for the pickup code: the saved value at the answer, and the cards are re-read (they carry the setting)', async () => {
    const hook = useSetRequirePickupCode() as unknown as Hook;
    const storeId = hook.onMutate?.(true);
    const answer = await hook.mutationFn(true);
    expect(hook.onSuccess?.(answer, true, storeId)).toBeUndefined();
    expect(fx.qc.getQueryData<any>(PROFILE).vendors[0].requirePickupCode).toBe(true);
    expect(fx.invalidated.map(keyText).sort()).toEqual([keyText(BOARD), keyText(PROFILE)].sort());
  });

  it('an answer that lands after a switch to another store is written into the store it was sent for, never the other', async () => {
    const hook = useSetSelfDelivery() as unknown as Hook;
    const storeId = hook.onMutate?.(true);
    const answer = await hook.mutationFn(true);
    fx.store.selectedStoreId = 'store-b';
    hook.onSuccess?.(answer, true, storeId);
    const vendors = fx.qc.getQueryData<any>(PROFILE).vendors;
    expect(vendors[0].selfDeliveryEnabled).toBe(true);
    expect(vendors[1].selfDeliveryEnabled).toBe(false);
  });
});
