import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [PERF row 562] The phone's "Store open" switch answers at the tap. The
// screen shows the tapped state while the request is out (lib/storeOpenSwitch);
// this hook then puts the server's own answer (both flags) into the store at
// once and lets the re-read run on its own. Before, the switch stayed put until
// the answer AND a fresh read had both come back. A failure re-reads, so the
// switch goes back to what the server holds. Driven through the REAL hook with
// a real query cache.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as QueryClient, invalidated: [] as unknown[], selectedStoreId: 'store-b' as string | null }));

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
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => ({ selectedStoreId: fx.selectedStoreId }) }) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { useToggleOpen } from './vendorops';

type Options = {
  onMutate?: (open: boolean) => unknown;
  onSuccess: (answer: unknown, open: boolean, storeId: unknown) => unknown;
  onError?: (error: unknown, open: boolean, storeId: unknown) => unknown;
};
const PROFILE = ['vendor', 'profile'];
const store = (id: string, isCurrentlyOpen: boolean, acceptingOrders = true) => ({ id, name: `Store ${id}`, isCurrentlyOpen, acceptingOrders, status: 'ACTIVE', operatingHours: [] });
// Store A is closed but taking orders, store B closed and paused: every answer below differs from the OTHER store.
const profile = () => ({ id: 'owner-1', myRole: 'OWNER', vendors: [store('store-a', false, true), store('store-b', false, false)] });

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated.length = 0;
  fx.selectedStoreId = 'store-b';
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
  fx.qc.setQueryData(PROFILE, profile());
});

describe('[PERF row 562] the phone Store-open switch: the server\'s answer at once, the re-read on its own', () => {
  it('the request remembers the store it was sent for (the selected store, which the header carries)', () => {
    const options = useToggleOpen() as unknown as Options;
    expect(options.onMutate?.(true)).toBe('store-b');
    fx.selectedStoreId = null;
    expect(options.onMutate?.(true)).toBeNull();
  });

  it('opening: the answer\'s two flags go into that store; the other store and every other field are untouched', () => {
    const options = useToggleOpen() as unknown as Options;
    // Both flags are the server's (another device may have resumed orders meanwhile).
    options.onSuccess({ isCurrentlyOpen: true, acceptingOrders: true }, true, 'store-b');
    expect(fx.qc.getQueryData(PROFILE)).toEqual({
      id: 'owner-1', myRole: 'OWNER', vendors: [store('store-a', false, true), store('store-b', true, true)],
    });
  });

  it('the switch is free at the answer: the re-read runs on its own, not awaited', () => {
    const options = useToggleOpen() as unknown as Options;
    const result = options.onSuccess({ isCurrentlyOpen: true, acceptingOrders: true }, true, 'store-a');
    expect(result).toBeUndefined();
    expect(fx.invalidated).toEqual([PROFILE]);
    expect((fx.qc.getQueryData(PROFILE) as ReturnType<typeof profile>).vendors).toEqual([store('store-a', true, true), store('store-b', false, false)]);
  });

  it('an answer it cannot place changes nothing and keeps the switch on the tapped state until the re-read lands', () => {
    const options = useToggleOpen() as unknown as Options;
    for (const [answer, storeId] of [
      [{ isCurrentlyOpen: true }, 'store-b'], // one flag only
      [{ success: true }, 'store-b'],
      [undefined, 'store-b'],
      [{ isCurrentlyOpen: true, acceptingOrders: true }, 'store-z'], // not in this profile
      [{ isCurrentlyOpen: true, acceptingOrders: true }, null], // no store selected: the server chose
    ] as const) {
      const result = options.onSuccess(answer, true, storeId);
      expect(result).toBeInstanceOf(Promise);
      expect(fx.qc.getQueryData(PROFILE)).toEqual(profile());
    }
    expect(fx.invalidated).toHaveLength(5);
  });

  it('a refusal or a dropped line writes nothing and re-reads, so the switch goes back to what the server holds', () => {
    const options = useToggleOpen() as unknown as Options;
    expect(options.onError).toBeTypeOf('function');
    const result = options.onError?.({ response: { data: { error: { message: 'Your store isn’t live yet' } } } }, true, 'store-b');
    expect(result).toBeUndefined();
    expect(fx.qc.getQueryData(PROFILE)).toEqual(profile());
    expect(fx.invalidated).toEqual([PROFILE]);
  });
});
