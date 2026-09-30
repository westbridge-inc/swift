import { act, render, screen, waitFor } from '@testing-library/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import type { Profile } from '@/components/account/account-api';

const route = vi.hoisted(() => ({ pathname: '/account', router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useRouter: () => route.router }));
const person = (id: string): Profile => ({ id, firstName: `Person ${id}`, lastName: 'Test', phone: `phone-${id}`, email: null });
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function browserStorage(emit: (_key: string, _value: string) => void, blocked = false): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    clear: () => values.clear(),
    setItem: (key, value) => { if (blocked) throw new Error('Blocked'); values.set(key, value); emit(key, value); },
    removeItem: (key) => { if (blocked) throw new Error('Blocked'); values.delete(key); },
  };
}

// Independent module graphs are two tabs: separate auth state, profile cache,
// channel endpoints and query providers; only the server cookie identity and
// browser transport are shared. No manual calls to tab one's clearSession.
async function twoTabs(transport: 'broadcast' | 'storage') {
  const endpoints: Channel[] = [];
  class Channel {
    onmessage: ((_event: MessageEvent) => void) | null = null;
    constructor() { if (transport !== 'broadcast') throw new Error('Unavailable'); endpoints.push(this); }
    postMessage(data: unknown) {
      for (const endpoint of endpoints) if (endpoint !== this) endpoint.onmessage?.({ data } as MessageEvent);
    }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const storage = browserStorage((key, value) => {
    if (transport === 'storage') window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
  });
  vi.stubGlobal('localStorage', storage);
  expect(window.localStorage).toBe(storage);
  vi.resetModules();
  const first = await import('./auth');
  const cache = await import('./session-profile-cache');
  const { Providers } = await import('@/components/providers');
  const { default: AppLayout } = await import('@/app/(app)/layout');
  const { default: AccountPage } = await import('@/app/(app)/account/page');
  let identity: string | null = 'a';
  const fetcher = vi.fn(async (_input?: RequestInfo | URL) => new Response(JSON.stringify({ success: !!identity, data: { user: identity ? { id: identity } : null } }), { status: identity ? 200 : 401 }));
  vi.stubGlobal('fetch', fetcher);
  first.adoptSession('a');
  let client!: QueryClient;
  function Capture() { client = useQueryClient(); return null; }
  render(<Providers><Capture /></Providers>);
  await cache.readSessionProfile(async () => person('a'));
  vi.resetModules();
  const second = await import('./auth');
  // Establish tab two before populating private caches in tab one.
  act(() => second.adoptSession('a'));
  await act(async () => { await first.sessionProbe(); });
  await cache.readSessionProfile(async () => person('a'));
  client.setQueryData(['customer', 'addresses', 'a'], [{ addressLine1: 'Private address A' }]);
  client.setQueryData(['customer', 'orders', 'a'], [{ id: 'Private order A' }]);
  client.getMutationCache().build(client, { mutationKey: ['private-draft'] });
  sessionStorage.setItem('swift_web_checkout_attempt:a', 'private attempt');
  localStorage.setItem('swift_web_appointments', 'private appointment');
  return { first, second, cache, client, fetcher, AppLayout, AccountPage, switchTo: (id: string | null) => { identity = id; } };
}

afterEach(() => { route.pathname = '/account'; });

describe('AX329 F1: two browser tabs sharing cookie identity', () => {
  it.each(['broadcast', 'storage'] as const)('two-tab sign-out clears every private cache via %s', async (transport) => {
    const tabs = await twoTabs(transport);
    tabs.switchTo(null);
    act(() => tabs.second.clearSession());
    expect(tabs.first.getSessionPrincipal()).toBeNull();
    expect(tabs.client.getQueryCache().getAll()).toHaveLength(0);
    expect(tabs.client.getMutationCache().getAll()).toHaveLength(0);
    expect(sessionStorage.getItem('swift_web_checkout_attempt:a')).toBeNull();
    expect(localStorage.getItem('swift_web_appointments')).toBeNull();
    const read = vi.fn(async () => { throw new Error('Signed out'); });
    await expect(tabs.cache.readSessionProfile(read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['broadcast', 'storage'] as const)('two-tab account switch hides A until B is proven via %s', async (transport) => {
    const tabs = await twoTabs(transport);
    tabs.switchTo('b');
    act(() => tabs.second.adoptSession('b'));
    // A message invalidates; it must never assert another tab's identity.
    expect(tabs.first.getSessionPrincipal()).toBeNull();
    expect(tabs.client.getQueryCache().getAll()).toHaveLength(0);
    expect(tabs.client.getMutationCache().getAll()).toHaveLength(0);
    await tabs.first.sessionProbe();
    expect(tabs.first.getSessionPrincipal()).toBe('b');
    const result = await tabs.cache.readSessionProfile(async () => person('b'));
    expect(result).toEqual(person('b'));
    expect(JSON.stringify(result)).not.toContain('phone-a');
  });

  it.each([null, 'b'])('missed messages cannot reuse A when the server proves %s', async (identity) => {
    const tabs = await twoTabs('broadcast');
    tabs.switchTo(identity); // No notification: frozen tab or unavailable transport.
    const proof = deferred<Response>();
    tabs.fetcher.mockReturnValueOnce(proof.promise);
    const read = vi.fn(async () => { if (!identity) throw new Error('Signed out'); return person(identity); });
    let rendered: Profile | undefined;
    const reading = tabs.cache.readSessionProfile(read).then((value) => { rendered = value; return value; });
    const outcome = reading.catch(() => undefined);
    await Promise.resolve();
    expect(rendered).toBeUndefined();
    await act(async () => proof.resolve(new Response(JSON.stringify({ data: { user: identity ? { id: identity } : null } }), { status: identity ? 200 : 401 })));
    await outcome;
    expect(rendered).toEqual(identity ? person(identity) : undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(tabs.client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('an old identity probe cannot undo a newer cross-tab invalidation', async () => {
    const tabs = await twoTabs('broadcast');
    const proof = deferred<Response>();
    tabs.fetcher.mockReturnValueOnce(proof.promise);
    const checking = tabs.first.sessionProbe();
    tabs.switchTo(null);
    act(() => tabs.second.clearSession());
    await act(async () => proof.resolve(new Response(JSON.stringify({ data: { user: { id: 'a' } } }))));
    expect(await checking).toEqual({ ok: false });
    expect(tabs.first.getSessionPrincipal()).toBeNull();
  });

  it('does not reuse a cached profile when identity verification is offline', async () => {
    const tabs = await twoTabs('broadcast');
    tabs.fetcher.mockRejectedValue(new Error('Offline'));
    const read = vi.fn(async () => { throw new Error('Offline'); });
    await expect(tabs.cache.readSessionProfile(read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('gates shared query-cache reuse on navigation until the current identity is proven', async () => {
    const tabs = await twoTabs('broadcast');
    const { Providers } = await import('@/components/providers');
    let client!: QueryClient;
    function PrivatePage() {
      client = useQueryClient();
      const query = useQuery({ queryKey: ['private', route.pathname], queryFn: async () => 'Current data', staleTime: 60_000 });
      return <p>{query.data}</p>;
    }
    const view = render(<Providers><PrivatePage /></Providers>);
    await screen.findByText('Current data');
    client.setQueryData(['private', '/orders'], 'Private A');
    const proof = deferred<Response>();
    tabs.fetcher.mockReturnValueOnce(proof.promise);
    route.pathname = '/orders';
    view.rerender(<Providers><PrivatePage /></Providers>);
    expect(screen.queryByText('Private A')).toBeNull();
    await waitFor(() => expect(tabs.fetcher).toHaveBeenCalled());
    await act(async () => proof.resolve(new Response(JSON.stringify({ data: { user: { id: 'b' } } }))));
    await screen.findByText('Current data');
    expect(screen.queryByText('Private A')).toBeNull();
    expect(client.getQueryData(['private', '/account'])).toBeUndefined();
  });
  it('blocked broadcast and storage cannot prevent local private-cache invalidation', async () => {
    vi.resetModules();
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('Blocked'); } });
    const storage = browserStorage(() => undefined, true);
    vi.stubGlobal('localStorage', storage);
    expect(window.localStorage).toBe(storage);
    const auth = await import('./auth');
    const cache = await import('./session-profile-cache');
    expect(() => auth.adoptSession('a')).not.toThrow();
    await cache.readSessionProfile(async () => person('a'));
    expect(() => auth.clearSession()).not.toThrow();
    const read = vi.fn(async () => { throw new Error('Signed out'); });
    await expect(cache.readSessionProfile(read)).rejects.toThrow('Signed out');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a late mutation rollback cannot repopulate the new person’s query client', async () => {
    const tabs = await twoTabs('broadcast');
    const { Providers } = await import('@/components/providers');
    let current!: QueryClient;
    function Capture() { current = useQueryClient(); return null; }
    render(<Providers><Capture /></Providers>);
    const previous = current;
    let reject!: (_error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const mutation = previous.getMutationCache().build(previous, {
      mutationFn: () => pending,
      onError: () => { previous.setQueryData(['private-draft'], 'Private A'); },
    });
    const result = mutation.execute(undefined).catch(() => undefined);
    act(() => tabs.second.adoptSession('b'));
    // This provider belongs to tab two, so its own adoption also resets it.
    expect(current).not.toBe(previous);
    await act(async () => { reject(new Error('Old write failed')); await result; });
    expect(previous.getQueryData(['private-draft'])).toBe('Private A');
    expect(current.getQueryData(['private-draft'])).toBeUndefined();
  });

  it.each(['focus', 'pageshow', 'visibilitychange'])('masks cached private data on %s until identity is revalidated', async (event) => {
    const tabs = await twoTabs('broadcast');
    const { Providers } = await import('@/components/providers');
    function PrivatePage() {
      const query = useQuery({ queryKey: ['private'], queryFn: async () => 'Private A', staleTime: 60_000 });
      return <p>{query.data}</p>;
    }
    render(<Providers><PrivatePage /></Providers>);
    await screen.findByText('Private A');
    const proof = deferred<Response>();
    tabs.fetcher.mockReturnValueOnce(proof.promise);
    act(() => {
      if (event === 'visibilitychange') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        document.dispatchEvent(new Event(event));
      } else window.dispatchEvent(new Event(event));
    });
    expect(screen.queryByText('Private A')).toBeNull();
    await act(async () => proof.resolve(new Response(JSON.stringify({ data: { user: { id: 'a' } } }))));
    await screen.findByText('Private A');
  });

  it('an in-flight profile read is not reused after an unannounced identity switch', async () => {
    const tabs = await twoTabs('broadcast');
    act(() => { tabs.first.clearSession(); tabs.first.adoptSession('a'); });
    const pending = deferred<Profile>();
    const firstRead = tabs.cache.readSessionProfile(() => pending.promise).catch(() => undefined);
    tabs.switchTo('b');
    const nextRead = vi.fn(async () => person('b'));
    await expect(tabs.cache.readSessionProfile(nextRead)).resolves.toEqual(person('b'));
    pending.resolve(person('a'));
    expect(await firstRead).toBeUndefined();
    expect(nextRead).toHaveBeenCalledTimes(1);
  });

  it('an older probe cannot replace a newer server-proven identity', async () => {
    const tabs = await twoTabs('broadcast');
    act(() => tabs.first.clearSession());
    const old = deferred<Response>();
    tabs.fetcher.mockReturnValueOnce(old.promise);
    const checking = tabs.first.sessionProbe();
    tabs.switchTo('b');
    await tabs.first.sessionProbe();
    old.resolve(new Response(JSON.stringify({ data: { user: { id: 'a' } } })));
    expect(await checking).toEqual({ ok: false });
    expect(tabs.first.getSessionPrincipal()).toBe('b');
  });

  it.each([null, 'b'])('Account → Market → Account never paints A after tab two changes to %s', async (identity) => {
    const tabs = await twoTabs('broadcast');
    let current: string | null = 'a';
    tabs.fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const data = path.endsWith('/auth/me') ? { user: current ? { id: current } : null }
        : path.endsWith('/profile') ? person(current!) : { visible: false };
      return new Response(JSON.stringify({ success: true, data }), { status: path.endsWith('/auth/me') && !current ? 401 : 200 });
    });
    const { AppLayout, AccountPage } = tabs;
    const view = render(<AppLayout><AccountPage /></AppLayout>);
    await screen.findByText('Person a Test');
    const header = screen.getByRole('banner');
    route.pathname = '/market';
    view.rerender(<AppLayout><p>Market page</p></AppLayout>);
    await screen.findByText('Market page');
    expect(screen.getByRole('banner')).toBe(header);
    current = identity;
    tabs.switchTo(identity);
    act(() => { if (identity) tabs.second.adoptSession(identity); else tabs.second.clearSession(); });
    route.pathname = '/account';
    view.rerender(<AppLayout><AccountPage /></AppLayout>);
    expect(screen.queryByText('Person a Test')).toBeNull();
    expect(screen.queryByText('phone-a')).toBeNull();
    if (identity) {
      expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
      await act(async () => { await tabs.first.sessionProbe(); });
      await screen.findByText('Person b Test');
    } else {
      expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('Person a Test')).toBeNull();
    expect(screen.getByRole('banner')).toBe(header);
  });

  it('failed identity verification discards the old client before a late rollback can refill it', async () => {
    const tabs = await twoTabs('broadcast');
    const { Providers } = await import('@/components/providers');
    let current!: QueryClient;
    function PrivatePage() {
      current = useQueryClient();
      const query = useQuery({ queryKey: ['private'], queryFn: async () => 'Fresh server response', staleTime: 60_000 });
      return <p>{query.data}</p>;
    }
    const view = render(<Providers><PrivatePage /></Providers>);
    await screen.findByText('Fresh server response');
    const previous = current;
    let failProof!: (_error: Error) => void;
    const proof = new Promise<Response>((_resolve, reject) => { failProof = reject; });
    tabs.fetcher.mockReturnValueOnce(proof);
    route.pathname = '/orders';
    view.rerender(<Providers><PrivatePage /></Providers>);
    expect(screen.queryByText('Fresh server response')).toBeNull();
    await act(async () => failProof(new Error('Offline')));
    expect(screen.queryByText('Fresh server response')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Checking your account…');
    previous.setQueryData(['private'], 'Private A');
    expect(screen.queryByText('Private A')).toBeNull();
    // Offline proof keeps the page masked; a later conclusive resume may
    // mount it with the replacement client, never the one a rollback holds.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000);
    await act(async () => window.dispatchEvent(new Event('online')));
    await screen.findByText('Fresh server response');
    expect(current).not.toBe(previous);
    previous.setQueryData(['private'], 'Private A');
    expect(current.getQueryData(['private'])).toBe('Fresh server response');
  });

  it.each(['read', 'write'])('a fresh %s for B cannot be cached under stale identity A', async (operation) => {
    const tabs = await twoTabs('broadcast');
    act(() => { tabs.first.clearSession(); tabs.first.adoptSession('a'); });
    tabs.switchTo('b'); // The transport was missed; memory still says A.
    const response = async () => person('b');
    const pending = operation === 'read' ? tabs.cache.readSessionProfile(response) : tabs.cache.writeSessionProfile(response);
    await expect(pending).rejects.toThrow();
    // Even returning to A must not surface a B response mislabeled as A.
    tabs.switchTo('a');
    await tabs.first.sessionProbe();
    const read = vi.fn(async () => person('a'));
    await expect(tabs.cache.readSessionProfile(read)).resolves.toEqual(person('a'));
    expect(read).toHaveBeenCalledTimes(1);
  });

});
