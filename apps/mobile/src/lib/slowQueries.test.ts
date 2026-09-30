import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLOW_QUERY_MS, watchSlowQueries } from './slowQueries';
import { readRetryDelay, retryRead } from './appQueryPolicy';

afterEach(() => vi.useRealTimers());

describe('weak-network presentation and backoff', () => {
  it('signals a slow read after five seconds without removing cached content, then clears', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const publish = vi.fn();
    const stop = watchSlowQueries(client, publish);
    client.setQueryData(['fixture'], { visible: true });
    let finish!: (data: { visible: boolean }) => void;
    const observer = new QueryObserver(client, {
      queryKey: ['fixture'], queryFn: () => new Promise<{ visible: boolean }>((resolve) => { finish = resolve; }),
    });
    const off = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(SLOW_QUERY_MS - 1);
    expect(publish).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenLastCalledWith(true);
    expect(observer.getCurrentResult()).toMatchObject({ data: { visible: true }, isLoading: false });
    finish({ visible: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenLastCalledWith(false);
    off(); stop(); client.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a slow banner when the session cache is wiped', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const publish = vi.fn();
    const stop = watchSlowQueries(client, publish);
    const observer = new QueryObserver(client, { queryKey: ['fixture'], queryFn: () => new Promise(() => {}) });
    const off = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(SLOW_QUERY_MS);
    expect(publish).toHaveBeenLastCalledWith(true);
    client.clear();
    expect(publish).toHaveBeenLastCalledWith(false);
    off(); stop();
  });

  it('retries transient reads twice with exponential jitter, and stops on permanent rejections', () => {
    expect(retryRead(0, { response: { status: 401 } })).toBe(false);
    expect(retryRead(0, { response: { status: 403 } })).toBe(false);
    expect(retryRead(0, { response: { status: 404 } })).toBe(false);
    for (const status of [408, 429, 500, 503]) expect(retryRead(1, { response: { status } })).toBe(true);
    expect(retryRead(2, new Error('offline'))).toBe(false);
    for (const [attempt, floor] of [[0, 1000], [1, 2000], [2, 4000], [9, 8000]] as const) {
      expect(readRetryDelay(attempt)).toBeGreaterThanOrEqual(floor);
      expect(readRetryDelay(attempt)).toBeLessThan(floor + 500);
    }
  });
});
