import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct] The store page's heart fills (or empties) at the tap and goes back if the server refuses; a heart
// no longer downloads the whole store page again (it carries the full menu) — the lists that show hearts (favourites,
// Home, store lists) are re-read as before. The REAL hook's options against a real query cache.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient, invalidated: [] as unknown[] }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: vi.fn(), useInfiniteQuery: vi.fn(), useMutation: (options: unknown) => options, useQueryClient: () => fx.qc };
});
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => null,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: Object.assign(() => ({}), { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false, sessionGeneration: 0 }) }),
}));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));

import { customerKeys, useToggleFavorite } from './customer';

type Hook = { onMutate: (v: unknown) => Promise<unknown>; onError: (e: unknown, v: unknown) => void; onSuccess: () => void };
const STORE = customerKeys.vendor('store-1');

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fx.invalidated = [];
  const real = fx.qc.invalidateQueries.bind(fx.qc);
  fx.qc.invalidateQueries = ((filters: { queryKey: unknown }) => { fx.invalidated.push(filters.queryKey); return real(filters as never); }) as never;
  fx.qc.setQueryData(STORE, { id: 'store-1', name: 'Store', isFavorite: false, categories: [] });
});

describe('[TAP-AUDIT] the store page\'s heart', () => {
  it('fills at the tap', async () => {
    await (useToggleFavorite() as unknown as Hook).onMutate({ vendorId: 'store-1', isFavorite: false });
    expect(fx.qc.getQueryData<{ isFavorite: boolean }>(STORE)?.isFavorite).toBe(true);
  });

  it('goes back if the server refuses', async () => {
    const hook = useToggleFavorite() as unknown as Hook;
    await hook.onMutate({ vendorId: 'store-1', isFavorite: false });
    hook.onError(new Error('down'), { vendorId: 'store-1', isFavorite: false });
    expect(fx.qc.getQueryData<{ isFavorite: boolean }>(STORE)?.isFavorite).toBe(false);
  });

  it('re-reads the lists that show hearts, not the whole store page', () => {
    (useToggleFavorite() as unknown as Hook).onSuccess();
    expect(fx.invalidated).toEqual([['customer', 'favorites'], ['customer', 'home'], ['customer', 'vendors']]);
  });
});
