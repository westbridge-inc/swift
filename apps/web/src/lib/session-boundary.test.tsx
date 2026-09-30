import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { isCancelledError, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@/components/account/account-api';

const route = vi.hoisted(() => ({ pathname: '/orders/detail-a' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useParams: () => ({ id: 'detail-a' }), useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));

async function browser() {
  vi.resetModules();
  const deliveries: (() => void)[] = [];
  const endpoints: Channel[] = [];
  class Channel {
    onmessage: ((_event: MessageEvent) => void) | null = null;
    constructor() { endpoints.push(this); }
    postMessage(data: unknown) {
      // Browser channel delivery is a later task, never a synchronous call.
      for (const peer of endpoints) if (peer !== this) deliveries.push(() => peer.onmessage?.({ data } as MessageEvent));
    }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  let identity = 'a';
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/me')
    ? response({ user: { id: identity } }) : response({ visible: false }));
  vi.stubGlobal('fetch', fetcher);
  const auth = await import('./auth');
  const { Providers, usePrivateCacheEpoch } = await import('@/components/providers');
  const { default: Layout } = await import('@/app/(app)/layout');
  const { useCustomerSession } = await import('@/components/customer-session');
  auth.adoptSession('a');
  return { auth, Providers, Layout, usePrivateCacheEpoch, useCustomerSession, fetcher, deliveries, switchTo: (id: string) => { identity = id; } };
}

afterEach(() => { route.pathname = '/orders/detail-a'; vi.useRealTimers(); });

describe('AX350 A–D: one session boundary for state and pending work', () => {
  it('AX356 F1 masks a second resume inside the throttle and drops A at the trailing probe', async () => {
    const tab = await browser();
    const { Layout, auth } = tab;
    function Draft() {
      const [address] = useState(() => `Private address ${auth.getSessionPrincipal()}`);
      return <p>{address}</p>;
    }
    render(<Layout><Draft /></Layout>);
    await screen.findByText('Private address a');
    vi.useFakeTimers();
    await act(async () => window.dispatchEvent(new Event('focus')));
    const probes = () => tab.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/me')).length;
    const before = probes();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    tab.switchTo('b');
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(screen.getByText('Private address a').closest('[hidden][inert]')).not.toBeNull();
    expect(probes()).toBe(before);
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(probes()).toBe(before);
    expect(screen.getByText('Private address a').closest('[hidden][inert]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(probes()).toBe(before + 1);
    expect(screen.queryByText('Private address a')).toBeNull();
    expect(screen.getByText('Private address b').closest('[hidden]')).toBeNull();
  });

  it('removes the real order-detail address when B receives not found after a missed notification', async () => {
    const { Layout, fetcher } = await browser();
    const { default: Detail } = await import('@/app/(app)/orders/[id]/page');
    let identity = 'a';
    fetcher.mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith('/auth/me')) return response({ user: { id: identity } });
      if (path.endsWith('/orders/detail-a')) return identity === 'a'
        ? response({ id: 'detail-a', orderNumber: 'TEST-1', status: 'ACCEPTED', paymentMethod: 'CASH', totalAmount: 500,
          items: [], deliveryAddress: 'Private destination A', vendor: { name: 'Test store' } })
        : new Response(JSON.stringify({ success: false, error: { message: 'Order not found' } }), { status: 404 });
      return response({ visible: false });
    });
    render(<Layout><Detail /></Layout>);
    await screen.findByText('Private destination A');
    identity = 'b';
    await act(async () => window.dispatchEvent(new Event('focus')));
    await screen.findByText('Order not found');
    expect(screen.queryByText('Private destination A')).toBeNull();
    expect(screen.queryByText('TEST-1')).toBeNull();
  });

  it.each(['focus', 'pageshow', 'online'])('missed notification then %s drops private component state with only public queries', async (event) => {
    const tab = await browser();
    const { Layout, auth } = tab;
    let client!: QueryClient;
    function Detail() {
      client = useQueryClient();
      // Like order detail: an ownership error on the next read cannot erase
      // the address already retained in component state. The boundary must.
      const [address] = useState(() => `Private address ${auth.getSessionPrincipal()}`);
      return <p>{address}</p>;
    }
    render(<Layout><Detail /></Layout>);
    await screen.findByText('Private address a');
    expect(client.getQueryCache().getAll().every((query) => query.queryKey[0] === 'market')).toBe(true);
    const header = screen.getByRole('banner');
    const proof = deferred<Response>();
    tab.fetcher.mockReturnValueOnce(proof.promise);
    tab.switchTo('b'); // Both invalidation transports were missed.
    const before = tab.fetcher.mock.calls.length;
    act(() => window.dispatchEvent(new Event(event)));
    expect(tab.fetcher.mock.calls.length).toBe(before + 1);
    expect(screen.getByText('Private address a').closest('[hidden][inert]')).not.toBeNull();
    await act(async () => proof.resolve(response({ user: { id: 'b' } })));
    await screen.findByText('Private address b');
    expect(screen.queryByText('Private address a')).toBeNull();
    expect(screen.getByRole('banner')).toBe(header);
  });

  it('probes an empty private page and throttles resume storms to one probe per 15 seconds', async () => {
    const { Providers, fetcher } = await browser();
    render(<Providers><p>Private form</p></Providers>);
    const time = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('online'));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    time.mockReturnValue(115_000);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['/orders', '/orders/detail-a', '/account', '/cart', '/account/favourites'])('keys the whole %s subtree and consumer context to the shared epoch', async (pathname) => {
    route.pathname = pathname;
    const { Layout, auth, useCustomerSession } = await browser();
    function PrivateState() {
      const [value] = useState(() => `mounted-${auth.currentSessionEpoch()}`);
      const session = useCustomerSession();
      return <p>{value}:context-{session.epoch}</p>;
    }
    render(<Layout><PrivateState /></Layout>);
    const previous = auth.currentSessionEpoch();
    await screen.findByText(`mounted-${previous}:context-${previous}`);
    // Same-principal reauthentication is still a new session.
    act(() => auth.adoptSession('a'));
    const next = auth.currentSessionEpoch();
    expect(next).toBeGreaterThan(previous);
    await screen.findByText(`mounted-${next}:context-${next}`);
    expect(screen.queryByText(`mounted-${previous}:context-${previous}`)).toBeNull();
  });

  it('does not hand the new subtree an old shell location, including a late location callback', async () => {
    const { Layout, auth, useCustomerSession } = await browser();
    const seen: string[] = [];
    let setPoint!: ReturnType<typeof useCustomerSession>['setNearPoint'];
    function Location() {
      const session = useCustomerSession();
      setPoint = session.setNearPoint;
      const value = `${auth.getSessionPrincipal()}:${session.nearPoint?.lat ?? 'none'}`;
      seen.push(value);
      return <p>{value}</p>;
    }
    render(<Layout><Location /></Layout>);
    await screen.findByText('a:none');
    act(() => setPoint({ lat: 1, lng: 2 }));
    expect(screen.getByText('a:1')).toBeTruthy();
    const oldCallback = setPoint;
    act(() => auth.adoptSession('b'));
    expect(seen).not.toContain('b:1');
    act(() => oldCallback({ lat: 1, lng: 2 }));
    expect(screen.getByText('b:none')).toBeTruthy();
    expect(seen).not.toContain('b:1');
  });

  it('does not reuse A’s pending /orders on return before a missed switch is verified', async () => {
    route.pathname = '/orders';
    const { Providers, auth, fetcher, switchTo } = await browser();
    const orders = deferred<Response>();
    const proof = deferred<Response>();
    let check = false;
    let reads = 0;
    fetcher.mockImplementation(async (input) => String(input).endsWith('/auth/me')
      ? check ? proof.promise : response({ user: { id: 'a' } })
      : ++reads === 1 ? orders.promise : response([{ address: 'Private address b' }]));
    let client!: QueryClient;
    const requested = vi.fn(() => auth.apiFetch('/api/v1/customer/orders'));
    function Orders() {
      client = useQueryClient();
      const query = useQuery({ queryKey: ['orders'], queryFn: requested, retry: false });
      return <p>{query.data?.data?.[0]?.address ?? 'Waiting for orders'}</p>;
    }
    const view = render(<Providers><Orders /></Providers>);
    await waitFor(() => expect(requested).toHaveBeenCalledTimes(1));
    const old = client;
    const pendingQuery = old.getQueryCache().getAll()[0]!;
    const outcome = pendingQuery.promise!.catch((error: unknown) => error);
    route.pathname = '/market';
    view.rerender(<Providers><p>Market</p></Providers>);
    await screen.findByText('Market');
    switchTo('b');
    check = true;
    route.pathname = '/orders';
    view.rerender(<Providers><Orders /></Providers>);
    expect(screen.queryByText('Waiting for orders')).toBeNull();
    await act(async () => orders.resolve(response([{ address: 'Private address a' }])));
    expect(screen.queryByText('Private address a')).toBeNull();
    await act(async () => proof.resolve(response({ user: { id: 'b' } })));
    expect(isCancelledError(await outcome)).toBe(true);
    expect(old.getQueryCache().getAll()).toHaveLength(0);
    expect(pendingQuery.state.data).toBeUndefined();
    await screen.findByText('Private address b');
    expect(screen.queryByText('Private address a')).toBeNull();
  });

  it('holds response resolution behind an active identity probe, then rejects the old epoch', async () => {
    const { auth, fetcher } = await browser();
    const orders = deferred<Response>();
    const proof = deferred<Response>();
    fetcher.mockReturnValueOnce(orders.promise).mockReturnValueOnce(proof.promise);
    let settled = false;
    const pending = auth.apiFetch('/api/v1/customer/orders').finally(() => { settled = true; });
    const outcome = pending.catch((error: unknown) => error);
    const checking = auth.verifySessionNow();
    await act(async () => orders.resolve(response([{ address: 'Private address a' }])));
    expect(settled).toBe(false);
    proof.resolve(response({ user: { id: 'b' } }));
    await checking;
    expect(await outcome).toMatchObject({ code: 'SESSION_CHANGED' });
  });

  it('rejects a response whose JSON finishes after the epoch changes', async () => {
    const { auth, fetcher } = await browser();
    const body = deferred<unknown>();
    fetcher.mockResolvedValue({ ok: true, status: 200, json: () => body.promise } as Response);
    const pending = auth.apiFetch('/api/v1/customer/orders').catch((error: unknown) => error);
    await act(async () => undefined);
    auth.adoptSession('b');
    body.resolve({ data: [{ address: 'Private address a' }] });
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
  });

  it('cancels pending queries synchronously at an epoch change, even if their fetch ignores abort', async () => {
    const { Providers, auth } = await browser();
    let client!: QueryClient;
    function Capture() { client = useQueryClient(); return null; }
    render(<Providers><Capture /></Providers>);
    const old = client;
    const result = deferred<string>();
    const cancelled = vi.fn();
    const pending = old.fetchQuery({ queryKey: ['orders'], queryFn: ({ signal }) => {
      signal.addEventListener('abort', cancelled);
      return result.promise;
    } }).catch(() => undefined);
    act(() => auth.adoptSession('b'));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(client).not.toBe(old);
    result.resolve('Private address a');
    await pending;
    expect(client.getQueryData(['orders'])).toBeUndefined();
  });

  it('same-tick resume masks A before the asynchronous sibling notification arrives', async () => {
    const tab = await browser();
    const { Layout, auth } = tab;
    function Detail() {
      const [value] = useState(() => `Private address ${auth.getSessionPrincipal()}`);
      return <p>{value}</p>;
    }
    const view = render(<Layout><Detail /></Layout>);
    await screen.findByText('Private address a');
    vi.resetModules();
    const sibling = await import('./auth');
    tab.switchTo('b');
    sibling.adoptSession('b');
    expect(tab.deliveries.length).toBeGreaterThan(0);
    expect(auth.getSessionPrincipal()).toBe('a'); // No synchronous delivery.
    const proof = deferred<Response>();
    tab.fetcher.mockReturnValueOnce(proof.promise);
    act(() => window.dispatchEvent(new Event('focus')));
    view.rerender(<Layout><Detail /></Layout>);
    expect(screen.getByText('Private address a').closest('[hidden][inert]')).not.toBeNull();
    await act(async () => {
      await new Promise<void>((done) => setTimeout(() => { tab.deliveries.splice(0).forEach((deliver) => deliver()); done(); }, 0));
    });
    expect(auth.getSessionPrincipal()).toBeNull();
    await act(async () => proof.resolve(response({ user: { id: 'a' } })));
    expect(screen.queryByText('Private address a')).toBeNull();
  });

  it('exposes one synchronous epoch, unsubscribe, and a coalesced forced verification', async () => {
    const { auth, fetcher } = await browser();
    const epochs: number[] = [];
    const stop = auth.subscribeSession(() => epochs.push(auth.currentSessionEpoch()));
    const initial = auth.currentSessionEpoch();
    auth.adoptSession('a');
    expect(epochs).toEqual([initial + 1]);
    stop();
    const proof = deferred<Response>();
    fetcher.mockReturnValueOnce(proof.promise);
    const first = auth.verifySessionNow();
    const second = auth.verifySessionNow();
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    proof.resolve(response({ user: { id: 'b' } }));
    await first;
    expect(auth.currentSessionEpoch()).toBe(initial + 2);
    expect(epochs).toEqual([initial + 1]);
  });

  it('notifies billing store subscribers only after the new session identity and epoch are settled', async () => {
    const { auth } = await browser();
    auth.setSelectedStore('store-a');
    const epoch = auth.currentSessionEpoch();
    const heard: unknown[] = [];
    const stop = auth.subscribeSelectedStore(() => heard.push({
      principal: auth.getSessionPrincipal(), epoch: auth.currentSessionEpoch(), store: auth.getSelectedStore(),
    }));
    auth.adoptSession('b');
    expect(heard).toEqual([{ principal: 'b', epoch: epoch + 1, store: null }]);
    stop();
  });

  it('rejects a profile write that resolves after reauthentication as the same principal', async () => {
    const { auth } = await browser();
    const { writeSessionProfile } = await import('./session-profile-cache');
    const result = deferred<Profile>();
    const pending = writeSessionProfile(() => result.promise).catch((error: unknown) => error);
    auth.adoptSession('a');
    result.resolve({ id: 'a', firstName: 'Old', lastName: 'Profile', phone: 'test', email: null });
    expect(await pending).toBeInstanceOf(Error);
  });
});
