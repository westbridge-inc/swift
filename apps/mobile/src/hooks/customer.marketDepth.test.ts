import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { marketTabVisible } from '../lib/homeReliability';

// Pin the useMarketDepth wiring exactly as the repo pins other hook options
// (see customer.itemSlots.test.ts): capture the query options the real hook
// builds, then drive them through a real QueryObserver as the "source pin".
const mocks = vi.hoisted(() => ({
  depth: vi.fn(),
  remembered: vi.fn<() => { visible: boolean; items: number; vendors: number } | null>(),
  remember: vi.fn<(body: unknown) => void>(),
  queryOptions: null as Record<string, any> | null,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: Record<string, any>) => {
      mocks.queryOptions = options;
      return options;
    },
  };
});

vi.mock('../services/api', () => ({
  marketApi: { depth: mocks.depth },
  customerApi: {},
  discoveryApi: {},
  moderationApi: {},
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: vi.fn(), useAuthStore: () => ({}) }));
vi.mock('../lib/marketDepthMemory', () => ({
  rememberedMarketDepth: mocks.remembered,
  rememberMarketDepth: mocks.remember,
}));

import { useMarketDepth } from './customer';

const VISIBLE = { visible: true, items: 180, vendors: 3 };
const HIDDEN = { visible: false, items: 0, vendors: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryOptions = null;
});

function observe(options: Record<string, any>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(qc, {
    queryKey: ['market', 'depth'],
    queryFn: options['queryFn'],
    staleTime: options['staleTime'],
    initialData: options['initialData'],
    initialDataUpdatedAt: options['initialDataUpdatedAt'],
  });
  const unsubscribe = observer.subscribe(() => {});
  return { qc, observer, unsubscribe };
}

describe('useMarketDepth cold start and verdict handling', () => {
  it('keeps a remembered visible verdict through a failed cold-start read', async () => {
    mocks.remembered.mockReturnValue(VISIBLE);
    mocks.depth.mockRejectedValue(new Error('offline'));
    useMarketDepth();

    const { qc, observer, unsubscribe } = observe(mocks.queryOptions!);
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(true);
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(true);
    unsubscribe();
    qc.clear();
  });

  it('throws on an incomplete 200, so a remembered visible verdict never flips to unknown', async () => {
    mocks.remembered.mockReturnValue(VISIBLE);
    mocks.depth.mockResolvedValue({ data: { data: { visible: 'true', items: 180, vendors: 3 } } });
    useMarketDepth();

    await expect(mocks.queryOptions!['queryFn']()).rejects.toThrow(/incomplete/);
    const { qc, observer, unsubscribe } = observe(mocks.queryOptions!);
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(true);
    expect(mocks.remember).not.toHaveBeenCalled();
    unsubscribe();
    qc.clear();
  });

  it('a complete hidden verdict hides the tab and replaces the remembered visible verdict', async () => {
    mocks.remembered.mockReturnValue(VISIBLE);
    mocks.depth.mockResolvedValue({ data: { data: HIDDEN } });
    useMarketDepth();

    const data = await mocks.queryOptions!['queryFn']();
    expect(data).toEqual(HIDDEN);
    expect(marketTabVisible(data)).toBe(false);
    expect(mocks.remember).toHaveBeenCalledExactlyOnceWith(HIDDEN);

    const { qc, observer, unsubscribe } = observe(mocks.queryOptions!);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(HIDDEN));
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(false);
    unsubscribe();
    qc.clear();
  });

  it('stays hidden on the first-ever launch when nothing is remembered and the read fails — and keeps React Query retries', async () => {
    mocks.remembered.mockReturnValue(null);
    mocks.depth.mockRejectedValue(new Error('offline'));
    useMarketDepth();

    expect(mocks.queryOptions!['initialData']()).toBeUndefined();
    expect(mocks.queryOptions!['retry']).toBeUndefined(); // the hook leaves React Query's own retries in place

    const { qc, observer, unsubscribe } = observe(mocks.queryOptions!);
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(false);
    unsubscribe();
    qc.clear();
  });

  it('persists a complete visible verdict so the next cold start remembers it', async () => {
    mocks.remembered.mockReturnValue(null);
    mocks.depth.mockResolvedValue({ data: { data: VISIBLE } });
    useMarketDepth();

    const data = await mocks.queryOptions!['queryFn']();
    expect(data).toEqual(VISIBLE);
    expect(mocks.remember).toHaveBeenCalledExactlyOnceWith(VISIBLE);
  });
});
