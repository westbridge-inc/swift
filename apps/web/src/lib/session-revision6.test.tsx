import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { Profile } from '@/components/account/account-api';

const route = vi.hoisted(() => ({ pathname: '/login', query: 'next=%2F', router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useRouter: () => route.router, useSearchParams: () => new URLSearchParams(route.query) }));
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  let reject!: (_reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const profile = (id: string): Profile => ({ id, firstName: `Saved ${id}`, lastName: 'Test', phone: 'test', email: null });
async function browser(pathname = '/login') {
  vi.resetModules(); route.pathname = pathname; route.query = 'next=%2F';
  route.router.replace.mockReset(); route.router.push.mockReset();
  sessionStorage.clear(); localStorage.clear(); window.history.replaceState(null, '', pathname);
  const deliveries: (() => void)[] = [];
  const channels: Channel[] = [];
  const announce = vi.fn();
  class Channel {
    onmessage: ((_event: MessageEvent) => void) | null = null;
    constructor() { channels.push(this); }
    postMessage(data: unknown) {
      announce(data);
      for (const peer of channels) if (peer !== this) deliveries.push(() => peer.onmessage?.({ data } as MessageEvent));
    }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/me') ? response({ user: { id: 'a' } }) : response({}));
  vi.stubGlobal('fetch', fetcher);
  const auth = await import('./auth');
  return { auth, fetcher, announce, channels, deliveries };
}
async function openOtp(pathname: string) {
  const { default: Page } = pathname === '/signup' ? await import('@/app/signup/page') : await import('@/app/login/page');
  render(<Page />);
  if (pathname === '/signup') fireEvent.click(screen.getByRole('button', { name: /Put my business/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
}
function expectDraft(masked: boolean) {
  const code = screen.getByLabelText('Verification code') as HTMLInputElement;
  expect(code.value).toBe('246810');
  expect(screen.getByText(/Enter the code sent to/).textContent).toContain('+5926001003');
  expect(code.closest('[hidden][inert]') !== null).toBe(masked);
}
afterEach(() => vi.useRealTimers());

it('SX393 F1 obsolete warm proof preserves newer same-account proof, profile cache and OTP draft', async () => {
  const { auth, fetcher } = await browser(); auth.adoptSession('a');
  const { readSessionProfile } = await import('./session-profile-cache');
  const read = vi.fn(async () => profile('a')); await readSessionProfile(read); await openOtp('/login');
  const epoch = auth.currentSessionEpoch(); const old = deferred<Response>(); const fresh = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const cached = readSessionProfile(read);
  act(() => window.dispatchEvent(new Event('focus'))); expectDraft(true);
  await act(async () => fresh.resolve(response({ user: { id: 'a' } }))); expectDraft(false);
  await act(async () => old.resolve(response({ user: { id: 'a' } })));
  expect(await cached).toEqual(profile('a')); expect(auth.getSessionPrincipal()).toBe('a');
  expect(auth.currentSessionEpoch()).toBe(epoch); expect(read).toHaveBeenCalledTimes(1); expectDraft(false);
});

it.each(['a', 'b'])('SX393 F1 obsolete offline failure cannot clear fresh proof of %s', async (identity) => {
  const { auth, fetcher, announce } = await browser(); auth.adoptSession('a'); announce.mockClear();
  const epoch = auth.currentSessionEpoch(); const old = deferred<Response>(); const fresh = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const p1 = auth.verifySessionNow(); const p2 = auth.verifySessionNow({ fresh: true });
  fresh.resolve(response({ user: { id: identity } })); expect(await p2).toMatchObject({ ok: true, user: { id: identity } });
  old.reject(new TypeError('old connection lost')); expect(await p1).toMatchObject({ ok: false, obsolete: true });
  expect(auth.getSessionPrincipal()).toBe(identity); expect(auth.currentSessionEpoch()).toBe(epoch + (identity === 'b' ? 1 : 0));
  expect(announce).toHaveBeenCalledTimes(identity === 'b' ? 1 : 0);
});

it('SX393 F1 older successful proof cannot settle while a newer fresh proof is pending', async () => {
  const { auth, fetcher } = await browser(); auth.adoptSession('a');
  const old = deferred<Response>(); const fresh = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const p1 = auth.verifySessionNow(); const p2 = auth.verifySessionNow({ fresh: true });
  old.resolve(response({ user: { id: 'a' } })); expect(await p1).toMatchObject({ ok: false, obsolete: true });
  fresh.resolve(response({ user: { id: 'b' } })); expect(await p2).toMatchObject({ ok: true, user: { id: 'b' } });
});

it.each(['/login', '/signup'])('SX393 F2 %s restarts masked proof after sibling invalidation and drops old-account OTP', async (pathname) => {
  const { auth, fetcher, channels } = await browser(pathname); auth.adoptSession('a'); await openOtp(pathname);
  const old = deferred<Response>(); const replacement = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
  act(() => window.dispatchEvent(new Event('focus'))); expectDraft(true);
  act(() => channels[0]!.onmessage?.({ data: 'invalidate:sibling:r6' } as MessageEvent));
  expect(screen.queryByLabelText('Verification code')).toBeNull(); expect(screen.getByRole('status').textContent).toBe('Checking your account…');
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'))).toHaveLength(2);
  await act(async () => old.resolve(response({ user: { id: 'a' } }))); expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => replacement.resolve(response({ user: { id: 'b' } })));
  expect(screen.queryByRole('status')).toBeNull(); expect(auth.getSessionPrincipal()).toBe('b');
  if (pathname === '/login') expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+592');
  else expect(screen.getByRole('heading', { name: 'What brings you to Swift?' })).toBeTruthy();
  expect(screen.queryByText(/Enter the code sent to/)).toBeNull();
});

for (const kind of ['customer', 'partner']) {
  it(`SX393 F3 deferred old ${kind} OTP failure cannot change a newer pending send`, async () => {
    const { auth, fetcher } = await browser(); route.query = kind === 'customer' ? 'next=%2F' : 'next=%2Fdashboard';
    await openOtp('/login'); const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); act(() => auth.adoptSession('b'));
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
    const sending = deferred<Response>(); fetcher.mockReturnValueOnce(sending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await act(async () => old.reject(new TypeError('old OTP failure')));
    expect(screen.queryByRole('alert')).toBeNull(); expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(route.router.replace).not.toHaveBeenCalled(); fireEvent.keyDown(screen.getByLabelText('Phone number'), { key: 'Enter' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/send-otp'))).toHaveLength(2);
    await act(async () => sending.resolve(response({})));
    expect((screen.getByLabelText('Verification code') as HTMLInputElement).value).toBe('');
  });
  it(`SX393 F3 deferred old ${kind} OTP success cannot adopt, navigate or unlock a newer pending send`, async () => {
    const { auth, fetcher } = await browser(); route.query = kind === 'customer' ? 'next=%2F' : 'next=%2Fdashboard';
    await openOtp('/login'); const body = deferred<unknown>();
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); await act(async () => undefined);
    act(() => auth.adoptSession('b')); const epoch = auth.currentSessionEpoch();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
    const sending = deferred<Response>(); fetcher.mockReturnValueOnce(sending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await act(async () => body.resolve({ success: true, data: { user: { id: 'a', roles: ['VENDOR'] } } }));
    expect(auth.getSessionPrincipal()).toBe('b'); expect(auth.currentSessionEpoch()).toBe(epoch); expect(route.router.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull(); expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => sending.resolve(response({})));
    expect(screen.getByText(/Enter the code sent to/).textContent).toContain('+5926001004');
  });
  it(`SX393 F3 current ${kind} OTP success still adopts and navigates`, async () => {
    const { auth, fetcher } = await browser(); route.query = kind === 'customer' ? 'next=%2F' : 'next=%2Fdashboard';
    await openOtp('/login'); fetcher.mockResolvedValueOnce(response({ user: { id: 'a', roles: ['VENDOR'] } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    expect(auth.getSessionPrincipal()).toBe('a'); expect(route.router.replace).toHaveBeenCalledWith(kind === 'customer' ? '/' : '/dashboard');
  });
}

it.each(['refused', 'retried'])('DS393 delayed default-policy signup guest 401 with %s refresh preserves OTP without redirect', async (refresh) => {
  const { auth, fetcher, announce } = await browser('/signup'); const previous = deferred<Response>(); fetcher.mockReturnValueOnce(previous.promise);
  const pending = auth.apiFetch('/api/v1/customer/cart').catch((error: unknown) => error); await openOtp('/signup'); const epoch = auth.currentSessionEpoch();
  fetcher.mockImplementation(async (input) => String(input).endsWith('/auth/refresh') && refresh === 'retried' ? response({}) : new Response(null, { status: 401 }));
  await act(async () => { previous.resolve(new Response(null, { status: 401 })); expect(await pending).toMatchObject({ code: 'SESSION_EXPIRED', status: 401 }); });
  expect(window.location.pathname).toBe('/signup'); expect(auth.currentSessionEpoch()).toBe(epoch); expect(announce).not.toHaveBeenCalled(); expectDraft(false);
});

const uncertain = [
  ['offline', () => Promise.reject(new TypeError('offline'))], ['503', async () => new Response(null, { status: 503 })],
  ['429', async () => new Response(null, { status: 429 })], ['invalid JSON', async () => new Response('invalid-json')],
  ['missing identity', async () => response({ user: null })],
] as const;

it.each(uncertain)('DS393 current %s proof invalidates only this tab and preserves the sibling account/draft', async (_kind, result) => {
  const tab = await browser('/account'); tab.auth.adoptSession('a'); vi.resetModules();
  const sibling = await import('./auth'); sibling.adoptSession('a'); const { SessionBoundary } = await import('@/components/providers');
  function Draft() { const [value] = useState(`sibling private address ${sibling.getSessionPrincipal()}`); return <p>{value}</p>; }
  render(<SessionBoundary><Draft /></SessionBoundary>); tab.deliveries.splice(0); tab.announce.mockClear();
  const epoch = sibling.currentSessionEpoch(); tab.fetcher.mockImplementationOnce(result);
  await act(async () => { expect(await tab.auth.verifySessionNow()).toMatchObject({ ok: false }); });
  await act(async () => tab.deliveries.splice(0).forEach((deliver) => deliver()));
  expect(tab.auth.getSessionPrincipal()).toBeNull(); expect(tab.announce).not.toHaveBeenCalled(); expect(sibling.getSessionPrincipal()).toBe('a');
  expect(sibling.currentSessionEpoch()).toBe(epoch); expect(screen.getByText('sibling private address a').closest('[hidden]')).toBeNull();
});

it.each(uncertain)('DS393 obsolete %s proof cannot invalidate either tab after newer same-account proof', async (_kind, result) => {
  const tab = await browser(); tab.auth.adoptSession('a'); vi.resetModules(); const sibling = await import('./auth'); sibling.adoptSession('a');
  tab.deliveries.splice(0); tab.announce.mockClear(); const old = deferred<Response>(); tab.fetcher.mockReturnValueOnce(old.promise);
  const p1 = tab.auth.verifySessionNow(); await tab.auth.verifySessionNow({ fresh: true });
  await result().then(old.resolve, old.reject); expect(await p1).toMatchObject({ ok: false, obsolete: true });
  await act(async () => tab.deliveries.splice(0).forEach((deliver) => deliver()));
  expect(tab.auth.getSessionPrincipal()).toBe('a'); expect(sibling.getSessionPrincipal()).toBe('a'); expect(tab.announce).not.toHaveBeenCalled();
});

it('SX393 response resolution waits through replacement by another fresh probe', async () => {
  const { auth, fetcher } = await browser(); auth.adoptSession('a');
  const read = deferred<Response>(); const old = deferred<Response>(); const fresh = deferred<Response>();
  fetcher.mockReturnValueOnce(read.promise).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  let settled = false; const request = auth.apiFetch('/api/v1/customer/orders').finally(() => { settled = true; });
  const outcome = request.catch((error: unknown) => error); const p1 = auth.verifySessionNow();
  await act(async () => read.resolve(response([{ address: 'old address a' }]))); const p2 = auth.verifySessionNow({ fresh: true });
  await act(async () => old.resolve(response({ user: { id: 'a' } }))); await p1; expect(settled).toBe(false);
  fresh.resolve(response({ user: { id: 'b' } })); await p2; expect(await outcome).toMatchObject({ code: 'SESSION_CHANGED' });
});

it('SX393 standalone boundary retains same-account draft and discards it after changed-identity proof', async () => {
  const { auth, fetcher } = await browser('/account'); auth.adoptSession('a'); const { SessionBoundary } = await import('@/components/providers');
  let client!: QueryClient;
  function Draft() { client = useQueryClient(); const [value] = useState(`private draft ${auth.getSessionPrincipal()}`); return <p>{value}</p>; }
  render(<SessionBoundary><Draft /></SessionBoundary>); const oldClient = client; const element = screen.getByText('private draft a');
  const old = deferred<Response>(); const fresh = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const p1 = auth.verifySessionNow(); act(() => window.dispatchEvent(new Event('focus'))); expect(element.closest('[hidden][inert]')).not.toBeNull();
  await act(async () => fresh.resolve(response({ user: { id: 'a' } }))); await act(async () => old.resolve(response({ user: { id: 'a' } }))); await p1;
  expect(screen.getByText('private draft a')).toBe(element); expect(client).toBe(oldClient);
  vi.useFakeTimers(); fetcher.mockResolvedValueOnce(response({ user: { id: 'b' } })); act(() => window.dispatchEvent(new Event('online')));
  await act(async () => vi.advanceTimersByTimeAsync(15_000)); expect(screen.queryByText('private draft a')).toBeNull();
  expect(screen.getByText('private draft b').closest('[hidden]')).toBeNull(); expect(client).not.toBe(oldClient);
});

for (const kind of ['customer', 'partner']) {
  it.each(['new operation', 'external epoch', 'external epoch only'])('SX393 F3 completed real '+kind+' login delivered after %s cannot navigate or unlock', async (transition) => {
    const { auth, fetcher } = await browser();
    route.query = kind === 'customer' ? 'next=%2F' : 'next=%2Fdashboard';
    // Delay only delivery to the form: the actual helper still fetches,
    // checks its epoch, adopts the issued session and invokes its callback.
    const delivered = deferred<void>();
    if (kind === 'customer') {
      const customerModule = await import('./customer');
      const original = customerModule.verifyCustomerLogin;
      vi.spyOn(customerModule, 'verifyCustomerLogin').mockImplementation(async (...args) => {
        const result = await original(...args); await delivered.promise; return result;
      });
    } else {
      const original = auth.verifyPartnerLogin;
      vi.spyOn(auth, 'verifyPartnerLogin').mockImplementation(async (...args) => {
        const result = await original(...args); await delivered.promise; return result;
      });
    }
    await openOtp('/login');
    fetcher.mockResolvedValueOnce(response({ user: { id: 'a', roles: ['VENDOR'] } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    expect(auth.getSessionPrincipal()).toBe('a');
    expect(route.router.replace).not.toHaveBeenCalled();
    if (transition !== 'new operation') act(() => auth.adoptSession('b'));
    if (transition === 'external epoch only') {
      await act(async () => delivered.resolve());
      expect(route.router.replace).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
      expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+592');
      return;
    }
    const epoch = auth.currentSessionEpoch();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
    const sending = deferred<Response>(); fetcher.mockReturnValueOnce(sending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await act(async () => delivered.resolve());
    expect(route.router.replace).not.toHaveBeenCalled();
    expect(auth.currentSessionEpoch()).toBe(epoch);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => sending.resolve(response({})));
    expect(screen.getByText(/Enter the code sent to/).textContent).toContain('+5926001004');
  });
}

it('SX393 current partner mismatch after intentional adoption remains a visible, settled failure', async () => {
  const { auth, fetcher } = await browser(); route.query = 'next=%2Fdashboard'; await openOtp('/login');
  fetcher.mockResolvedValueOnce(response({ user: { id: 'customer', roles: ['CUSTOMER'] } }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
  expect(auth.getSessionPrincipal()).toBe('customer');
  expect(screen.getByRole('alert').textContent).toContain('No business or earner profile');
  expect(route.router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Send code' })).toBeTruthy();
});

it('SX393 a deferred probe cannot adopt after same-account reauthentication without a replacement probe', async () => {
  const { auth, fetcher } = await browser(); auth.adoptSession('a');
  const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise);
  const probe = auth.sessionProbe(); auth.adoptSession('a'); const epoch = auth.currentSessionEpoch();
  old.resolve(response({ user: { id: 'b' } }));
  expect(await probe).toMatchObject({ ok: false, obsolete: true });
  expect(auth.getSessionPrincipal()).toBe('a'); expect(auth.currentSessionEpoch()).toBe(epoch);
});

it('SX393 a deferred old login failure cannot set an error after an epoch reset with no newer operation', async () => {
  const { auth, fetcher } = await browser(); await openOtp('/login');
  const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); act(() => auth.adoptSession('b'));
  await act(async () => old.reject(new TypeError('old failure without new send')));
  expect(screen.queryByRole('alert')).toBeNull(); expect(route.router.replace).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+592');
});

it('DS393 known-account default-policy expiry still redirects signup and discards private state', async () => {
  const { auth, fetcher, announce } = await browser('/signup'); auth.adoptSession('a'); await openOtp('/signup');
  const epoch = auth.currentSessionEpoch(); announce.mockClear(); fetcher.mockResolvedValue(new Response(null, { status: 401 }));
  await act(async () => { await expect(auth.apiFetch('/api/v1/customer/cart')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' }); });
  expect(window.location.pathname).toBe('/login'); expect(auth.currentSessionEpoch()).toBe(epoch + 1);
  expect(auth.getSessionPrincipal()).toBeNull(); expect(announce).toHaveBeenCalledTimes(1); expect(screen.queryByLabelText('Verification code')).toBeNull();
});

it.each(['a', 'b'])('SX393 masked boundary recovers after its proof is superseded by fresh external proof of %s', async (identity) => {
  const { auth, fetcher } = await browser('/account'); auth.adoptSession('a');
  const { SessionBoundary } = await import('@/components/providers');
  function Draft() { const [value] = useState(`retained draft ${auth.getSessionPrincipal()}`); return <p>{value}</p>; }
  render(<SessionBoundary><Draft /></SessionBoundary>);
  const old = deferred<Response>(); const fresh = deferred<Response>(); const replacement = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(replacement.promise);
  act(() => window.dispatchEvent(new Event('focus')));
  const p2 = auth.verifySessionNow({ fresh: true });
  await act(async () => fresh.resolve(response({ user: { id: identity } })));
  await p2;
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => old.resolve(response({ user: { id: 'a' } })));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'))).toHaveLength(3);
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => replacement.resolve(response({ user: { id: identity } })));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText(`retained draft ${identity}`).closest('[hidden]')).toBeNull();
  if (identity === 'b') expect(screen.queryByText('retained draft a')).toBeNull();
});

it.each(['a', 'b'])('SX393 real customer shell rejects obsolete initial proof after fresh proof of %s', async (identity) => {
  const { auth, fetcher } = await browser('/orders/detail-a'); auth.adoptSession('a');
  const { default: Layout } = await import('@/app/(app)/layout');
  const old = deferred<Response>(); const fresh = deferred<Response>(); let proofs = 0;
  fetcher.mockImplementation(async (input) => String(input).endsWith('/auth/me')
    ? ++proofs === 1 ? old.promise : fresh.promise : response({ visible: false }));
  function Draft() { const [value] = useState(`shell private draft ${auth.getSessionPrincipal()}`); return <p>{value}</p>; }
  render(<Layout><Draft /></Layout>);
  act(() => window.dispatchEvent(new Event('focus')));
  await act(async () => fresh.resolve(response({ user: { id: identity } })));
  await act(async () => old.resolve(response({ user: { id: 'a' } })));
  expect(auth.getSessionPrincipal()).toBe(identity);
  expect(screen.getByText(`shell private draft ${identity}`).closest('[hidden]')).toBeNull();
  expect(screen.queryByText('Sign in to see your orders')).toBeNull();
  if (identity === 'b') expect(screen.queryByText('shell private draft a')).toBeNull();
});

it('SX393 real customer shell ignores obsolete restore proof after newer confirmed identity', async () => {
  const { auth, fetcher } = await browser('/orders/detail-a');
  const { default: Layout } = await import('@/app/(app)/layout');
  const old = deferred<Response>(); const fresh = deferred<Response>(); let proofs = 0;
  fetcher.mockImplementation(async (input) => String(input).endsWith('/auth/me')
    ? ++proofs === 1 ? new Response(null, { status: 401 }) : proofs === 2 ? old.promise : fresh.promise
    : response({ visible: false }));
  function Draft() { const [value] = useState(`restored private draft ${auth.getSessionPrincipal()}`); return <p>{value}</p>; }
  render(<Layout><Draft /></Layout>);
  await waitFor(() => expect(proofs).toBe(2));
  act(() => window.dispatchEvent(new Event('focus')));
  await act(async () => fresh.resolve(response({ user: { id: 'b' } })));
  await act(async () => old.resolve(response({ user: { id: 'a' } })));
  expect(auth.getSessionPrincipal()).toBe('b');
  expect(screen.getByText('restored private draft b').closest('[hidden]')).toBeNull();
  expect(screen.queryByText('restored private draft a')).toBeNull();
});

it.each(uncertain)('DS393 current %s proof preserves a sibling QR continuation without shared-epoch announcement', async (_kind, result) => {
  const { auth, fetcher, announce } = await browser(); auth.adoptSession('a');
  const continuation = await import('./storefront-continuation');
  const makeStorage = () => {
    const entries = new Map<string, string>();
    return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); }, key: (index: number) => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
  };
  const local = makeStorage(); const sibling = makeStorage();
  const intent = { storeSlug: 'test-store', itemId: 'test-meal', selectedOptions: {}, returnPath: '/store/test-store' };
  vi.stubGlobal('sessionStorage', sibling); continuation.queueStorefrontContinuation(intent);
  const sharedEpoch = localStorage.getItem('swift_storefront_epoch');
  vi.stubGlobal('sessionStorage', local); announce.mockClear(); fetcher.mockImplementationOnce(result);
  expect(await auth.verifySessionNow()).toMatchObject({ ok: false });
  expect(auth.getSessionPrincipal()).toBeNull(); expect(announce).not.toHaveBeenCalled();
  expect(localStorage.getItem('swift_storefront_epoch')).toBe(sharedEpoch);
  vi.stubGlobal('sessionStorage', sibling);
  expect(continuation.readStorefrontContinuation()).toEqual(intent);
});
