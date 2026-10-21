import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [PERF row 562] A store's Accept / Start preparing / Mark ready on the phone
// is dispatch: nothing shows before the server confirms, and that stays so.
// But after the answer the tap stayed busy until a re-read of the orders came
// back (one more round trip). Now the server's confirmed answer (status and
// its clocks) goes into the order and the board at once, and the re-read runs
// on its own. Driven through the REAL hook with a real query cache.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as QueryClient, invalidated: [] as unknown[] }));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: vi.fn(), useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ vendorApi: {}, vendorDiscoveryApi: {} }));
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
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => ({ selectedStoreId: 'store-a' }) }) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { useOrderAction } from './vendorops';

type Options = { onSuccess: (answer: unknown, vars: { id: string; action: string }) => unknown };
const DETAIL = (id: string) => ['vendor', 'orders', 'detail', id];
const BOARD = ['vendor', 'orders'];
const order = (id: string, status: string) => ({ id, status, orderNumber: `SW-${id}`, items: [{ id: 'line-1' }], customer: { firstName: 'Test' }, acceptedAt: null });

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated.length = 0;
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
  fx.qc.setQueryData(DETAIL('o1'), order('o1', 'PENDING'));
  fx.qc.setQueryData(BOARD, [order('o1', 'PENDING'), order('o2', 'PENDING')]);
});

describe('[PERF row 562] the phone shows a store tap\'s confirmed answer at once', () => {
  it('Accept: the answer\'s status and clocks go into the order and the board; nothing else of the order is lost', () => {
    const options = useOrderAction() as unknown as Options;
    options.onSuccess({ id: 'o1', status: 'ACCEPTED', acceptedAt: '2026-10-21T03:00:00.000Z', estimatedPrepTime: 20, customerId: 'c1' }, { id: 'o1', action: 'accept' });
    expect(fx.qc.getQueryData(DETAIL('o1'))).toEqual({ ...order('o1', 'ACCEPTED'), acceptedAt: '2026-10-21T03:00:00.000Z', estimatedPrepTime: 20 });
    const board = fx.qc.getQueryData<any[]>(BOARD)!;
    expect(board[0]).toMatchObject({ id: 'o1', status: 'ACCEPTED', acceptedAt: '2026-10-21T03:00:00.000Z', items: [{ id: 'line-1' }] });
    expect(board[1]).toEqual(order('o2', 'PENDING'));
    expect(board[0]).not.toHaveProperty('customerId'); // only what the answer confirms is taken
  });

  it('the tap is free at the answer: the re-read runs on its own, not awaited', () => {
    const options = useOrderAction() as unknown as Options;
    const result = options.onSuccess({ id: 'o1', status: 'PREPARING', preparingAt: 'now' }, { id: 'o1', action: 'preparing' });
    expect(result).toBeUndefined();
    expect(fx.invalidated).toEqual([BOARD]);
  });

  it('an answer that is not this order (or has no status) changes nothing but still re-reads', () => {
    const options = useOrderAction() as unknown as Options;
    options.onSuccess({ id: 'o2', status: 'ACCEPTED' }, { id: 'o1', action: 'accept' });
    options.onSuccess({ ok: true }, { id: 'o1', action: 'confirm-payment' });
    options.onSuccess(undefined, { id: 'o1', action: 'accept' });
    expect(fx.qc.getQueryData(DETAIL('o1'))).toEqual(order('o1', 'PENDING'));
    expect(fx.qc.getQueryData<any[]>(BOARD)![0]).toEqual(order('o1', 'PENDING'));
    expect(fx.invalidated).toHaveLength(3);
  });

  it('a board or order not loaded yet is left alone (no invented order)', () => {
    fx.qc.removeQueries({ queryKey: BOARD, exact: true });
    fx.qc.removeQueries({ queryKey: DETAIL('o1'), exact: true });
    const options = useOrderAction() as unknown as Options;
    options.onSuccess({ id: 'o1', status: 'ACCEPTED' }, { id: 'o1', action: 'accept' });
    expect(fx.qc.getQueryData(BOARD)).toBeUndefined();
    expect(fx.qc.getQueryData(DETAIL('o1'))).toBeUndefined();
  });
});
