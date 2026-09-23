import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, onlineManager } from '@tanstack/react-query';
import {
  createHomeRefreshGate,
  homeFeedState,
  homePlaceholderData,
  homeQueryKey,
  isHomeFeed,
  marketDepthVerdict,
  marketTabVisible,
  retainedHomeData,
  subscribeToHomeAttention,
} from './homeReliability';

afterEach(() => onlineManager.setOnline(true));

function client() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
}

describe('Home query ownership and cancellation', () => {
  it('starts a new account fetch instead of accepting a fresh guest feed', async () => {
    const qc = client();
    qc.setQueryData(homeQueryKey(6, -58, 'guest'), { activeOrder: null, featured: ['guest'] });
    const load = vi.fn(async () => ({ activeOrder: 'account-order', featured: ['account'] }));
    const observer = new QueryObserver(qc, {
      queryKey: homeQueryKey(6, -58, 'account'), queryFn: load,
      placeholderData: (previous, prior) => homePlaceholderData(previous, prior, 'account'),
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data).toBeUndefined();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.activeOrder).toBe('account-order'));
    unsubscribe();
    qc.clear();
  });

  it('retains same-account sections through a location refresh failure, then replaces them', async () => {
    const qc = client();
    const prior: { activeOrder: string | null; featured: string[] } = { activeOrder: 'old-order', featured: ['old'] };
    qc.setQueryData(homeQueryKey(6, -58, 'account'), prior);
    const observer = new QueryObserver(qc, {
      queryKey: homeQueryKey(6, -58, 'account'), queryFn: async () => prior,
    });
    const unsubscribe = observer.subscribe(() => {});
    let rejectNew!: (reason: Error) => void;
    observer.setOptions({
      queryKey: homeQueryKey(7, -58, 'account'),
      queryFn: () => new Promise<typeof prior>((_, reject) => { rejectNew = reject; }),
      retry: false,
      placeholderData: (previous, query) => homePlaceholderData(previous, query, 'account'),
    });
    expect(observer.getCurrentResult().data).toEqual(prior);
    rejectNew(new Error('timeout'));
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    const visible = retainedHomeData(observer.getCurrentResult().data, { scope: 'account', data: prior }, 'account');
    expect(homeFeedState({ ...observer.getCurrentResult(), data: visible })).toBe('content');
    expect(visible?.featured).toEqual(['old']);
    observer.setOptions({
      queryKey: homeQueryKey(7, -58, 'account'),
      queryFn: async () => ({ activeOrder: null, featured: ['new'] }),
      retry: false,
    });
    await observer.refetch();
    expect(observer.getCurrentResult().data).toEqual({ activeOrder: null, featured: ['new'] });
    unsubscribe();
    qc.clear();
  });

  it('does not borrow personalized content across A-to-B or A-to-guest transitions', () => {
    const prior = { activeOrder: 'a-private', featured: ['a-only'] };
    for (const next of ['account-b', 'guest']) {
      expect(homePlaceholderData(prior, { queryKey: homeQueryKey(6, -58, 'account-a') }, next)).toBeUndefined();
      expect(retainedHomeData(undefined, { scope: 'account-a', data: prior }, next)).toBeUndefined();
    }
    expect(homePlaceholderData(prior, { queryKey: homeQueryKey(6, -58, 'account-a') }, 'account-a')).toEqual(prior);
  });

  it('aborts the obsolete coordinate request when a newer location key replaces it', async () => {
    const qc = client();
    const aborts: number[] = [];
    const observer = new QueryObserver(qc, {
      queryKey: homeQueryKey(6, -58, 'account'),
      queryFn: ({ signal }) => new Promise<{ featured: string[] }>((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborts.push(6); reject(new Error('aborted')); });
      }),
    });
    const unsubscribe = observer.subscribe(() => {});
    observer.setOptions({
      queryKey: homeQueryKey(7, -58, 'account'),
      queryFn: async () => ({ featured: ['new'] }),
    });
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ featured: ['new'] }));
    expect(aborts).toEqual([6]);
    unsubscribe();
    qc.clear();
  });
});

describe('Home body and Market route states', () => {
  it('distinguishes paused offline, pending, first error, stale error and a healthy empty feed', () => {
    expect(homeFeedState({ data: undefined, fetchStatus: 'paused', isError: false })).toBe('offline');
    expect(homeFeedState({ data: undefined, fetchStatus: 'fetching', isError: false })).toBe('loading');
    expect(homeFeedState({ data: undefined, fetchStatus: 'idle', isError: true })).toBe('error');
    expect(homeFeedState({ data: { featured: [] }, fetchStatus: 'idle', isError: true })).toBe('content');
    expect(homeFeedState({ data: { featured: [] }, fetchStatus: 'idle', isError: false })).toBe('content');
  });

  it('rejects an incomplete response envelope instead of treating it as an empty marketplace', () => {
    expect(isHomeFeed(null)).toBe(false);
    expect(isHomeFeed({})).toBe(false);
    expect(isHomeFeed({ featured: [] })).toBe(false);
    expect(isHomeFeed({
      featured: [], popularItems: [], nearby: [], orderAgain: [], categories: [], openVendors: [], closedVendors: [],
    })).toBe(true);
  });

  it('resumes one paused request when connectivity returns', async () => {
    onlineManager.setOnline(false);
    const qc = client();
    qc.mount();
    const load = vi.fn(async () => ({ featured: ['open'] }));
    const observer = new QueryObserver(qc, { queryKey: homeQueryKey(6, -58, 'guest'), queryFn: load });
    const unsubscribe = observer.subscribe(() => {});
    expect(homeFeedState(observer.getCurrentResult())).toBe('offline');
    expect(load).not.toHaveBeenCalled();
    onlineManager.setOnline(true);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ featured: ['open'] }));
    expect(load).toHaveBeenCalledOnce();
    unsubscribe();
    qc.unmount();
    qc.clear();
  });

  it('hides Market on a cold unknown or failed depth read', () => {
    for (const body of [undefined, null, {}, { visible: false }, { visible: false, items: -1, vendors: 0 }, { visible: 'false', items: 0, vendors: 0 }]) {
      expect(marketDepthVerdict(body)).toBe('unknown');
      expect(marketTabVisible(body)).toBe(false);
    }
  });

  it('does not mount Market after a first depth request fails without a prior verdict', async () => {
    const qc = client();
    const observer = new QueryObserver(qc, {
      queryKey: ['market', 'depth'],
      queryFn: async (): Promise<{ visible: boolean; items: number; vendors: number }> => { throw new Error('offline'); },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(false);
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(false);
    unsubscribe();
    qc.clear();
  });

  it('shows only an authoritative visible verdict and hides an authoritative false verdict', () => {
    expect(marketDepthVerdict({ visible: true, items: 150, vendors: 2 })).toBe('visible');
    expect(marketTabVisible({ visible: true, items: 150, vendors: 2 })).toBe(true);
    expect(marketDepthVerdict({ visible: false, items: 0, vendors: 0 })).toBe('hidden');
    expect(marketTabVisible({ visible: false, items: 0, vendors: 0 })).toBe(false);
  });

  it('keeps a previously confirmed Market tab during a failed refetch with retained data', async () => {
    const qc = client();
    const key = ['market', 'depth'];
    qc.setQueryData(key, { visible: true, items: 180, vendors: 3 });
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async (): Promise<{ visible: boolean; items: number; vendors: number }> => { throw new Error('offline'); },
      staleTime: 0,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(marketTabVisible(observer.getCurrentResult().data)).toBe(true);
    unsubscribe();
    qc.clear();
  });
});

describe('external order refresh', () => {
  it('refreshes on focus and one background-to-active transition, then removes the listener on blur', () => {
    const refresh = vi.fn();
    let listener: ((state: string) => void) | undefined;
    const remove = vi.fn(() => { listener = undefined; });
    const add = vi.fn((callback: (state: string) => void) => { listener = callback; return { remove }; });
    const blur = subscribeToHomeAttention('active', add, refresh);
    expect(refresh).toHaveBeenCalledOnce();
    listener?.('active');
    expect(refresh).toHaveBeenCalledOnce();
    listener?.('background');
    listener?.('active');
    expect(refresh).toHaveBeenCalledTimes(2);
    blur();
    expect(remove).toHaveBeenCalledOnce();
    expect(listener).toBeUndefined();
  });

  it('coalesces focus and resume and permits a later authoritative refresh', () => {
    const refresh = vi.fn();
    const gate = createHomeRefreshGate(refresh, 750);
    expect(gate(1_000, false)).toBe(true);
    expect(gate(1_100, false)).toBe(false);
    expect(gate(2_000, false)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not restart an active fetch', () => {
    const refresh = vi.fn();
    const gate = createHomeRefreshGate(refresh, 750);
    expect(gate(1_000, true)).toBe(false);
    expect(gate(1_100, false)).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('replaces a cancelled order banner after one authoritative focus invalidation', async () => {
    const qc = client();
    const key = homeQueryKey(6, -58, 'account');
    qc.setQueryData(key, { activeOrder: { id: 'order-1' }, featured: [] });
    let serverOrder: { id: string } | null = { id: 'order-1' };
    const load = vi.fn(async () => ({ activeOrder: serverOrder, featured: [] }));
    const observer = new QueryObserver(qc, { queryKey: key, queryFn: load });
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data?.activeOrder).toEqual({ id: 'order-1' });
    serverOrder = null;
    const gate = createHomeRefreshGate(() => {
      void qc.invalidateQueries({ queryKey: ['customer', 'home'], refetchType: 'active' });
    }, 750);
    expect(gate(1_000, false)).toBe(true);
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.activeOrder).toBeNull());
    expect(load).toHaveBeenCalledOnce();
    unsubscribe();
    qc.clear();
  });
});
