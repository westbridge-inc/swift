import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [PERF #10] The ads switch was re-read every 30 s by every open app, though
// ads are OFF at launch. While ads are on it is the kill switch and keeps its
// 30 s; while they are off the app asks every 5 minutes.

// React Query schedules interval refetches only where a window exists; this
// unit project runs in Node, so give it one before the library loads.
const mocks = vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  return { get: vi.fn(), queryOptions: null as Record<string, any> | null };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: Record<string, any>) => {
      mocks.queryOptions = options;
      return { isFetchedAfterMount: false, isError: false, data: undefined };
    },
  };
});
vi.mock('../services/api', () => ({ api: { get: mocks.get } }));

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { ADS_OFF_RECHECK_MS, ADS_ON_RECHECK_MS, useAdsEnabled } from './useAdsEnabled';

const answer = (adsEnabled: boolean) => ({ data: { success: true, data: { adsEnabled } } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.queryOptions = null;
});
afterEach(() => vi.useRealTimers());

/** Drive the options the hook built through a real observer, as a mounted screen would. */
function observe(options: Record<string, any>) {
  const client = new QueryClient();
  const observer = new QueryObserver(client, options as ConstructorParameters<typeof QueryObserver>[1]);
  const unsubscribe = observer.subscribe(() => {});
  return { observer, stop: () => { unsubscribe(); client.clear(); } };
}

describe('useAdsEnabled re-reads the ads switch (PERF #10)', () => {
  it('asks every 5 minutes while ads are off, not every 30 s', async () => {
    mocks.get.mockResolvedValue(answer(false));
    useAdsEnabled();
    const { observer, stop } = observe(mocks.queryOptions!);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data).toBe(false);
    await vi.advanceTimersByTimeAsync(ADS_OFF_RECHECK_MS - 1_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps the 30 s kill switch while ads are on: switching them off is seen within 30 s', async () => {
    mocks.get.mockResolvedValue(answer(true));
    useAdsEnabled();
    const { observer, stop } = observe(mocks.queryOptions!);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toBe(true);
    mocks.get.mockResolvedValue(answer(false));
    await vi.advanceTimersByTimeAsync(ADS_ON_RECHECK_MS);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data).toBe(false);
    // Off again: back to the slow re-check.
    await vi.advanceTimersByTimeAsync(ADS_ON_RECHECK_MS * 2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    stop();
  });

  it('switching ads on is picked up at the next 5-minute check, then re-checked every 30 s', async () => {
    mocks.get.mockResolvedValue(answer(false));
    useAdsEnabled();
    const { observer, stop } = observe(mocks.queryOptions!);
    await vi.advanceTimersByTimeAsync(0);
    mocks.get.mockResolvedValue(answer(true));
    await vi.advanceTimersByTimeAsync(ADS_OFF_RECHECK_MS);
    expect(observer.getCurrentResult().data).toBe(true);
    await vi.advanceTimersByTimeAsync(ADS_ON_RECHECK_MS);
    expect(mocks.get).toHaveBeenCalledTimes(3);
    stop();
  });

  it('a failed re-check while ads are on keeps the 30 s cadence (entry closes on the error)', async () => {
    mocks.get.mockResolvedValue(answer(true));
    useAdsEnabled();
    const { observer, stop } = observe(mocks.queryOptions!);
    await vi.advanceTimersByTimeAsync(0);
    mocks.get.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(ADS_ON_RECHECK_MS);
    expect(observer.getCurrentResult().isError).toBe(true);
    mocks.get.mockResolvedValue(answer(true));
    await vi.advanceTimersByTimeAsync(ADS_ON_RECHECK_MS);
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().isError).toBe(false);
    stop();
  });

  it('still reads the server on every mount and never keeps an answer between mounts', () => {
    useAdsEnabled();
    expect(mocks.queryOptions).toMatchObject({ queryKey: ['public', 'capabilities'], staleTime: 0, gcTime: 0, refetchOnMount: 'always', retry: false });
  });
});
