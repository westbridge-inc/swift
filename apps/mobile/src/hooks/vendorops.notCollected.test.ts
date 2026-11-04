import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// [BUG-HUNT-2 G20] "Not collected", through the REAL hook: the tap goes to PUT /vendor/orders/:id/not-collected, the popup owns
// the words, and the order is read again whatever the outcome.

const fx = vi.hoisted(() => ({ qc: null as unknown as QueryClient, invalidated: [] as unknown[], mark: (() => undefined) as (id: string) => unknown }));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: vi.fn(), useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ vendorApi: { markNotCollected: (id: string) => fx.mark(id) }, vendorDiscoveryApi: {} }));
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

import { useMarkNotCollected } from './vendorops';

type Options = {
  mutationKey: readonly unknown[];
  meta?: Record<string, unknown>;
  mutationFn: (id: string) => Promise<unknown>;
  onSuccess: (answer: unknown, id: string) => unknown;
  onSettled: () => unknown;
};
const DETAIL = (id: string) => ['vendor', 'orders', 'detail', id];

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated.length = 0;
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
});

describe('[G20] useMarkNotCollected', () => {
  it('sends that order and hands back the server\'s data', async () => {
    const sent: string[] = [];
    fx.mark = (id) => { sent.push(id); return Promise.resolve({ data: { success: true, data: { id: 'o1', status: 'READY_FOR_PICKUP', sentToSupport: true } } }); };
    const options = useMarkNotCollected() as unknown as Options;
    await expect(options.mutationFn('o1')).resolves.toEqual({ id: 'o1', status: 'READY_FOR_PICKUP', sentToSupport: true });
    expect(sent).toEqual(['o1']);
  });

  it('the popup owns the words, and the board is read again', () => {
    const options = useMarkNotCollected() as unknown as Options;
    expect(options.meta).toEqual({ silent: true });
    options.onSettled();
    expect(fx.invalidated).toEqual([['vendor', 'orders']]);
  });

  it('a close goes into the order at once', () => {
    fx.qc.setQueryData(DETAIL('o1'), { id: 'o1', status: 'READY_FOR_PICKUP' });
    (useMarkNotCollected() as unknown as Options).onSuccess({ id: 'o1', status: 'CANCELLED' }, 'o1');
    expect(fx.qc.getQueryData(DETAIL('o1'))).toEqual({ id: 'o1', status: 'CANCELLED' });
  });
});
