import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ data: { data: unknown } }>>(),
  useQuery: vi.fn<(options: QueryObserverOptions) => unknown>(),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQuery: mocks.useQuery,
}));
vi.mock('../services/api', () => ({
  discoveryApi: { categories: mocks.read }, marketApi: { depth: mocks.read },
  authApi: { pricing: mocks.read }, api: { get: mocks.read },
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: vi.fn(), useAuthStore: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));

import { queryClient } from '../lib/queryClient';
import { useDiscoveryCategories, useMarketDepth } from './customer';
import { usePartnerPricing } from './partnerPricing';
import { useServiceCatalog } from '../modules/services/useServiceCatalog';

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('AX339: real hook options with the app query policy', () => {
  it.each([
    ['discovery categories', () => useDiscoveryCategories(), { enabled: true, categories: [] }],
    ['market depth', () => useMarketDepth(), { visible: true, items: 180, vendors: 3 }],
    ['partner pricing (default)', () => usePartnerPricing(), { currency: 'GYD', trialDays: 7 }],
    ['partner pricing (fresh false)', () => usePartnerPricing('GY', true, { fresh: false }), { currency: 'GYD', trialDays: 7 }],
    ['service catalog', () => useServiceCatalog(), { version: 1, categories: [] }],
  ] as const)('%s refreshes even on an immediate revisit while retaining cached content', async (_name, hook, cached) => {
    vi.useFakeTimers();
    mocks.read.mockResolvedValueOnce({ data: { data: cached } });
    hook();
    const options = mocks.useQuery.mock.lastCall![0];
    const first = new QueryObserver(queryClient, options);
    const offFirst = first.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.getCurrentResult()).toMatchObject({ data: cached, isFetching: false });
    } finally { offFirst(); }

    await vi.advanceTimersByTimeAsync(1);
    let finish!: (response: { data: { data: unknown } }) => void;
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    hook();
    const revisit = new QueryObserver(queryClient, mocks.useQuery.mock.lastCall![0]);
    const off = revisit.subscribe(() => {});
    try {
      expect(mocks.read).toHaveBeenCalledTimes(2);
      expect(revisit.getCurrentResult()).toMatchObject({ data: cached, isLoading: false, isFetching: true });
      const current = { ...cached, revision: 'current' };
      finish({ data: { data: current } });
      await vi.advanceTimersByTimeAsync(0);
      expect(revisit.getCurrentResult()).toMatchObject({ data: current, isFetching: false });
    } finally { off(); }
  });
});
