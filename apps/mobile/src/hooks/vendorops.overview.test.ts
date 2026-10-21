import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF partner #6] Through the REAL store hooks: the overview query polls at
// the overview pace (not a fixed 30 s), and the store feed's order events
// refresh the overview query itself.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    opts: [] as any[],
    invalidated: [] as unknown[],
    socket: {
      connected: true,
      emit: () => undefined,
      on: (event: string, cb: (payload?: unknown) => void) => { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb); },
      off: (event: string, cb: (payload?: unknown) => void) => { listeners.get(event)?.delete(cb); },
      fire: (event: string, payload?: unknown) => { for (const cb of listeners.get(event) ?? []) cb(payload); },
    },
  };
});

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: (effect: () => void) => { effect(); }, useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f() };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...real,
    useQuery: (options: unknown) => { fx.opts.push(options); return options; },
    useMutation: (options: unknown) => options,
    useQueryClient: () => ({ invalidateQueries: (filter: { queryKey: unknown }) => { fx.invalidated.push(filter.queryKey); } }),
  };
});
vi.mock('../services/api', () => ({ vendorApi: {}, vendorDiscoveryApi: {} }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('./useVendorMutation', () => ({ guardVendorOperation: vi.fn(), useVendorMutation: vi.fn() }));
vi.mock('../lib/vendorPreviewData', () => ({
  vendorPreviewDataset: () => null, vendorPreviewSubscription: () => null, previewQuery: vi.fn(), previewMutation: vi.fn(), VENDOR_PREVIEW_MARKET: {},
}));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => fx.socket }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => ({ selectedStoreId: 'store-a' }) }) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { useVendorAnalytics, useVendorOrdersLive } from './vendorops';
import { POLL } from '../lib/pollPolicy';

beforeEach(() => { fx.opts.length = 0; fx.invalidated.length = 0; });

describe('[PERF partner #6] the store hooks', () => {
  it('the overview query polls at the overview pace', () => {
    const q = useVendorAnalytics() as unknown as { queryKey: unknown[]; refetchInterval: () => number };
    expect(q.queryKey).toEqual(['vendor', 'analytics']);
    expect(typeof q.refetchInterval).toBe('function');
    expect(q.refetchInterval()).toBe(POLL.vendorAnalytics());
  });

  it('a new order and a status change refresh the overview query (and the orders)', () => {
    useVendorOrdersLive('store-a', true);
    fx.socket.fire('order:new', { orderId: 'o1' });
    expect(fx.invalidated).toContainEqual(['vendor', 'analytics']);
    expect(fx.invalidated).toContainEqual(['vendor', 'orders']);
    fx.invalidated.length = 0;
    fx.socket.fire('order:status_changed');
    expect(fx.invalidated).toEqual(expect.arrayContaining([['vendor', 'analytics'], ['vendor', 'orders']]));
    fx.invalidated.length = 0;
    fx.socket.fire('order:prep_update');
    expect(fx.invalidated).not.toContainEqual(['vendor', 'analytics']);
  });
});
