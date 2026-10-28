import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [BOOK-NS-APP · owner B3] "Customer didn't come", through the REAL hook with a real query cache: the tap goes to
// PUT /vendor/orders/:id/no-show; nothing shows before the server answers; its confirmed close (CANCELLED and when)
// goes into the order and the board at once; the order and the Schedule are read again whatever the outcome (a
// refusal can mean the booking already moved on); the popup shows the server's own words, so the app-wide toast
// stays out (meta.silent).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as QueryClient, invalidated: [] as unknown[], markNoShow: (() => undefined) as (id: string) => unknown }));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: vi.fn(), useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ vendorApi: { markNoShow: (id: string) => fx.markNoShow(id) }, vendorDiscoveryApi: {} }));
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

import { NO_SHOW_KEY, useMarkNoShow } from './vendorops';

type Options = {
  mutationKey: readonly unknown[];
  meta?: Record<string, unknown>;
  mutationFn: (id: string) => Promise<unknown>;
  onSuccess: (answer: unknown, id: string) => unknown;
  onSettled: () => unknown;
};
const DETAIL = (id: string) => ['vendor', 'orders', 'detail', id];
const BOARD = ['vendor', 'orders'];
const BOOKINGS = ['vendor', 'bookings'];
const order = (id: string, status: string) => ({ id, status, orderNumber: `SW-${id}`, fulfillment: 'APPOINTMENT', appointmentSlot: '2026-10-29T14:00:00.000Z', customer: { firstName: 'Test' } });
const ANSWER = { id: 'o1', status: 'CANCELLED', cancelledAt: '2026-10-29T14:42:00.000Z', cancellationReason: "Customer didn't come (recorded by the business).", appointmentNoShow: { bookingId: 'b-1', recordedAt: '2026-10-29T14:42:00.000Z' } };

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated.length = 0;
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
  fx.qc.setQueryData(DETAIL('o1'), order('o1', 'ACCEPTED'));
  fx.qc.setQueryData(BOARD, [order('o1', 'ACCEPTED'), order('o2', 'ACCEPTED')]);
});

describe('[BOOK-NS-APP] "Customer didn\'t come" goes to the server and its answer is shown', () => {
  it('the tap is PUT /vendor/orders/:id/no-show for that order; the answer is the server\'s data', async () => {
    const sent: string[] = [];
    fx.markNoShow = (id) => { sent.push(id); return Promise.resolve({ data: { success: true, data: ANSWER } }); };
    const options = useMarkNoShow() as unknown as Options;
    await expect(options.mutationFn('o1')).resolves.toEqual(ANSWER);
    expect(sent).toEqual(['o1']);
  });

  it('a refusal reaches the popup as the server sent it (the hook never rewrites it)', async () => {
    const refusal = Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, data: { error: { code: 'NO_SHOW_PAID_MMG', message: 'This booking is already paid by MMG, so it cannot be closed here. Settle it with the customer directly, or contact Swift Support.' } } } });
    fx.markNoShow = () => Promise.reject(refusal);
    const options = useMarkNoShow() as unknown as Options;
    await expect(options.mutationFn('o1')).rejects.toBe(refusal);
  });

  it('its own key, and the popup owns the words (no app-wide toast)', () => {
    const options = useMarkNoShow() as unknown as Options;
    expect(options.mutationKey).toEqual(NO_SHOW_KEY);
    expect(options.mutationKey).toEqual(['vendor', 'order-no-show']);
    expect(options.meta).toEqual({ silent: true });
  });

  it('the confirmed close goes into the order and the board at once; the other order is untouched', () => {
    const options = useMarkNoShow() as unknown as Options;
    options.onSuccess(ANSWER, 'o1');
    expect(fx.qc.getQueryData(DETAIL('o1'))).toEqual({ ...order('o1', 'CANCELLED'), cancelledAt: '2026-10-29T14:42:00.000Z' });
    const board = fx.qc.getQueryData<any[]>(BOARD)!;
    expect(board[0]).toMatchObject({ id: 'o1', status: 'CANCELLED', cancelledAt: '2026-10-29T14:42:00.000Z' });
    expect(board[1]).toEqual(order('o2', 'ACCEPTED'));
  });

  it('an answer that is not this order changes nothing', () => {
    const options = useMarkNoShow() as unknown as Options;
    options.onSuccess({ ...ANSWER, id: 'o2' }, 'o1');
    options.onSuccess(undefined, 'o1');
    expect(fx.qc.getQueryData(DETAIL('o1'))).toEqual(order('o1', 'ACCEPTED'));
  });

  it('whatever the outcome, the orders and the Schedule are read again', () => {
    fx.qc.setQueryData(BOOKINGS, []);
    const options = useMarkNoShow() as unknown as Options;
    options.onSettled();
    expect(fx.invalidated).toEqual([BOARD, BOOKINGS]);
  });
});
