import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver, onlineManager } from '@tanstack/react-query';
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
import { queryClient as client } from './queryClient';
import { createHomeRefreshGate, homeFeedState, homeQueryKey } from './homeReliability';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { client.clear(); onlineManager.setOnline(true); vi.useRealTimers(); });

describe('app query policy with the real QueryClient', () => {
  it('keeps Home content visible through three settled attention refreshes', async () => {
    const queryKey = homeQueryKey(6, -58, 'fixture');
    client.setQueryData(queryKey, { activeOrder: { status: 'PREPARING' }, featured: [] });
    const load = vi.fn(async () => ({ activeOrder: { status: 'PREPARING' }, featured: [] }));
    const observer = new QueryObserver(client, { queryKey, queryFn: load });
    const off = observer.subscribe(() => {});
    await tick();
    load.mockClear();
    const gate = createHomeRefreshGate(() => { void client.invalidateQueries({ queryKey: ['customer', 'home'] }); }, 750);
    for (const now of [1000, 2000, 3000]) {
      expect(gate(now, observer.getCurrentResult().isFetching)).toBe(true);
      expect(observer.getCurrentResult()).toMatchObject({ isLoading: false, isFetching: true });
      expect(homeFeedState(observer.getCurrentResult())).toBe('content');
      await tick();
    }
    expect(load).toHaveBeenCalledTimes(3);
    off();
  });
  it('keeps a visited tab readable during a background refresh, with one shared request', async () => {
    const key = ['market', 'items', 'all', 'new'];
    client.setQueryData(key, { items: ['last loaded item'] });
    let finish!: (value: { items: string[] }) => void;
    const load = vi.fn(() => new Promise<{ items: string[] }>((resolve) => { finish = resolve; }));
    const first = new QueryObserver(client, { queryKey: key, queryFn: load });
    const second = new QueryObserver(client, { queryKey: key, queryFn: load });
    const off1 = first.subscribe(() => {});
    const off2 = second.subscribe(() => {});
    const refresh = client.invalidateQueries({ queryKey: key });
    expect(first.getCurrentResult()).toMatchObject({ isLoading: false, isFetching: true, data: { items: ['last loaded item'] } });
    expect(second.getCurrentResult().isLoading).toBe(false);
    expect(load).toHaveBeenCalledOnce();
    finish({ items: ['new item'] });
    await refresh;
    off1(); off2();
  });

  it.each([
    ['customer', 'home'], ['customer', 'order'], ['customer', 'orders'], ['customer', 'cart'],
    ['customer', 'slots'], ['mover', 'available'], ['mover', 'earnings'], ['mover', 'subscription'],
    ['vendor', 'orders'], ['vendor', 'subscription'], ['rides', 'active'], ['services', 'jobs'],
    ['ads', 'invoices'], ['wallet', 'balance'], ['payments'],
  ])('does not mark time-critical %s/%s snapshots fresh', (...queryKey) => {
    client.setQueryData(queryKey, { lastKnown: true });
    const observer = new QueryObserver(client, { queryKey, queryFn: async () => ({ lastKnown: false }) });
    expect(observer.getCurrentResult().isStale).toBe(true);
    observer.destroy();
  });

  it('retains browse data for a minute without requesting it again on remount', async () => {
    const key = ['market', 'items', 'all', 'new'];
    client.setQueryData(key, { items: [] }, { updatedAt: Date.now() - 45_000 });
    const load = vi.fn(async () => ({ items: [] }));
    const observer = new QueryObserver(client, { queryKey: key, queryFn: load });
    const off = observer.subscribe(() => {});
    expect(observer.getCurrentResult().isLoading).toBe(false);
    expect(load).not.toHaveBeenCalled();
    off();
  });

  it('bounds a flapping reconnect to one attempt per query during the cooldown', async () => {
    client.mount();
    const loads = Array.from({ length: 8 }, () => vi.fn(async () => { throw new Error('weak wifi'); }));
    const observers = loads.map((queryFn, index) => {
      const queryKey = ['customer', 'order', `synthetic-${index}`];
      client.setQueryData(queryKey, { lastKnown: true }, { updatedAt: Date.now() - 60_000 });
      const observer = new QueryObserver(client, { queryKey, queryFn, retry: false, refetchOnMount: false });
      return observer.subscribe(() => {});
    });
    for (let i = 0; i < 10; i++) {
      onlineManager.setOnline(false); onlineManager.setOnline(true);
      await tick();
    }
    const attempts = loads.reduce((n, load) => n + load.mock.calls.length, 0);
    observers.forEach((off) => off());
    client.unmount();
    expect(attempts).toBe(8);
  });

  it('coalesces the final healthy reconnect into a trailing refresh and cancels it on scope wipe', async () => {
    vi.useFakeTimers();
    client.mount();
    let healthy = false;
    const load = vi.fn(async () => { if (!healthy) throw new Error('flaky'); return { current: true }; });
    const queryKey = ['customer', 'order', 'trailing-fixture'];
    client.setQueryData(queryKey, { current: false });
    const observer = new QueryObserver(client, { queryKey, queryFn: load, retry: false, refetchOnMount: false });
    const off = observer.subscribe(() => {});
    onlineManager.setOnline(false); onlineManager.setOnline(true);
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    healthy = true;
    onlineManager.setOnline(false); onlineManager.setOnline(true);
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult()).toMatchObject({ data: { current: true }, isError: false });
    onlineManager.setOnline(false); onlineManager.setOnline(true);
    await tick();
    client.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(2);
    off(); client.unmount();
  });

  it('does not queue a mutation to run when connectivity returns', async () => {
    onlineManager.setOnline(false);
    const action = vi.fn(async () => { throw new Error('offline'); });
    const mutation = client.getMutationCache().build(client, { mutationFn: action, meta: { silent: true } });
    const outcome = mutation.execute(undefined).catch(() => undefined);
    await tick();
    expect(mutation.state.isPaused).toBe(false);
    expect(action).toHaveBeenCalledOnce();
    onlineManager.setOnline(true);
    await outcome;
    expect(action).toHaveBeenCalledOnce();
  });
});
