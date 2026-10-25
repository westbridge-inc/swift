import { afterEach, expect, it, vi } from 'vitest';
import { QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';

type TrendingItem = { id: string; basePrice: number };
type Response = { data: { data: TrendingItem[] } };
const mocks = vi.hoisted(() => ({
  searchTrending: vi.fn<() => Promise<Response>>(),
  useQuery: vi.fn<(options: QueryObserverOptions<TrendingItem[]>) => unknown>(),
}));

// Capture every option from the real hook; retain the real query core and
// app-wide defaults so a hook-level freshness override cannot escape this test.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: mocks.useQuery,
}));
vi.mock('../services/api', () => ({ customerApi: { searchTrending: mocks.searchTrending } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: vi.fn(), useAuthStore: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));

import { queryClient } from '../lib/queryClient';
import { useSearchTrending } from './customer';

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('R1: trending remount at 45 seconds keeps cached items visible while refreshing availability and prices', async () => {
  vi.useFakeTimers();
  const cached = [{ id: 'closed-store-item', basePrice: 100 }, { id: 'open-store-item', basePrice: 200 }];
  const current = [{ id: 'open-store-item', basePrice: 250 }];
  mocks.searchTrending.mockResolvedValueOnce({ data: { data: cached } });
  useSearchTrending<TrendingItem[]>();
  const first = new QueryObserver(queryClient, mocks.useQuery.mock.lastCall![0]);
  const offFirst = first.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.searchTrending).toHaveBeenCalledOnce();
    expect(first.getCurrentResult()).toMatchObject({ data: cached, isFetching: false });
  } finally { offFirst(); }

  await vi.advanceTimersByTimeAsync(45_000);
  let finish!: (response: Response) => void;
  mocks.searchTrending.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  useSearchTrending<TrendingItem[]>();
  const remount = new QueryObserver(queryClient, mocks.useQuery.mock.lastCall![0]);
  const offRemount = remount.subscribe(() => {});
  try {
    expect(mocks.searchTrending).toHaveBeenCalledTimes(2);
    expect(remount.getCurrentResult()).toMatchObject({ data: cached, isLoading: false, isFetching: true });
    finish({ data: { data: current } });
    await vi.advanceTimersByTimeAsync(0);
    expect(remount.getCurrentResult()).toMatchObject({ data: current, isLoading: false, isFetching: false });
    expect(mocks.searchTrending).toHaveBeenCalledTimes(2);
  } finally { offRemount(); }
});
