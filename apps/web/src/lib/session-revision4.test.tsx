import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/signup', router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname, useRouter: () => route.router,
  useSearchParams: () => new URLSearchParams('next=%2Fstore%2Ftest'),
}));
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
async function browser(pathname: string) {
  vi.resetModules();
  route.pathname = pathname;
  route.router.replace.mockClear();
  sessionStorage.clear();
  const announce = vi.fn();
  vi.stubGlobal('BroadcastChannel', class { postMessage = announce; });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/me')
    ? new Response(null, { status: 401 }) : response({}));
  vi.stubGlobal('fetch', fetcher);
  const auth = await import('./auth');
  return { auth, fetcher, announce };
}
afterEach(() => vi.useRealTimers());

it.each(['/signup', '/login'])('AX362 (4) guest %s OTP survives Messages and a signed-out resume', async (pathname) => {
  const { auth } = await browser(pathname);
  const { default: Page } = pathname === '/signup' ? await import('@/app/signup/page') : await import('@/app/login/page');
  render(<Page />);
  if (pathname === '/signup') fireEvent.click(screen.getByRole('button', { name: /Put my business/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  const epoch = auth.currentSessionEpoch();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(auth.currentSessionEpoch()).toBe(epoch);
  expect((screen.getByLabelText('Verification code') as HTMLInputElement).value).toBe('246810');
  expect(screen.getByText(/Enter the code sent to/).textContent).toContain('+5926001003');
});

it('AX362 (4) repeated guest 401 verification never advances the epoch or announces a change', async () => {
  const { auth, announce } = await browser('/signup');
  const epoch = auth.currentSessionEpoch();
  await auth.verifySessionNow();
  await auth.verifySessionNow();
  expect(auth.currentSessionEpoch()).toBe(epoch);
  expect(announce).not.toHaveBeenCalled();
});

const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

it('AX362 (1) a stalled pre-resume verification cannot unmask the retained draft', async () => {
  const { auth, fetcher } = await browser('/signup');
  auth.adoptSession('a');
  fetcher.mockImplementation(async () => response({ user: { id: 'a' } }));
  const { default: Page } = await import('@/app/signup/page');
  render(<Page />);
  fireEvent.click(screen.getByRole('button', { name: /Put my business/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  vi.useFakeTimers();
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  const old = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise);
  const oldProof = auth.verifySessionNow();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const fresh = deferred<Response>();
  fetcher.mockReturnValueOnce(fresh.promise);
  act(() => window.dispatchEvent(new Event('pageshow')));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await act(async () => { old.resolve(response({ user: { id: 'a' } })); await oldProof; });
  expect(screen.getByDisplayValue('+5926001003').closest('[hidden][inert]')).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
  await act(async () => fresh.resolve(response({ user: { id: 'b' } })));
  expect(screen.queryByDisplayValue('+5926001003')).toBeNull();
  expect(screen.getByRole('heading', { name: 'What brings you to Swift?' })).toBeTruthy();
});

it('AX362 (2) a first probe discovering B clears the guest signup draft and QR Add', async () => {
  const { auth, fetcher } = await browser('/signup');
  const continuation = await import('./storefront-continuation');
  continuation.queueStorefrontContinuation({ storeSlug: 'test', itemId: 'meal', selectedOptions: {}, returnPath: '/store/test' });
  const { default: Page } = await import('@/app/signup/page');
  render(<Page />);
  fireEvent.click(screen.getByRole('button', { name: /Put my business/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  const epoch = auth.currentSessionEpoch();
  sessionStorage.setItem('swift_web_checkout_attempt:test', 'guest-draft');
  fetcher.mockResolvedValueOnce(response({ user: { id: 'b' } }));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(auth.currentSessionEpoch()).toBe(epoch + 1);
  expect(screen.queryByDisplayValue('+5926001003')).toBeNull();
  expect(screen.getByRole('heading', { name: 'What brings you to Swift?' })).toBeTruthy();
  expect(continuation.readStorefrontContinuation()).toBeNull();
  expect(sessionStorage.getItem('swift_web_checkout_attempt:test')).toBeNull();
});

it.each(['draft', 'pending-send'])('AX362 (3) login discards the old %s on a session change', async (state) => {
  const { auth, fetcher } = await browser('/login');
  const { default: Page } = await import('@/app/login/page');
  render(<Page />);
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  const send = deferred<Response>();
  if (state === 'pending-send') fetcher.mockReturnValueOnce(send.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  if (state === 'draft') fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  act(() => auth.adoptSession('b'));
  if (state === 'pending-send') await act(async () => send.resolve(response({})));
  expect(screen.queryByLabelText('Verification code')).toBeNull();
  expect(screen.queryByText(/\+5926001003/)).toBeNull();
  expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+592');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/verify-otp'))).toBe(false);
});

it('AX362 (5) rejected customer-only partner login adopts and announces cookies already issued', async () => {
  const { auth, fetcher, announce } = await browser('/login');
  auth.adoptSession('a');
  announce.mockClear();
  const epoch = auth.currentSessionEpoch();
  const changed = vi.fn();
  const unsubscribe = auth.subscribeSession(changed);
  fetcher.mockResolvedValueOnce(response({ user: { id: 'b', roles: ['CUSTOMER'] } }));
  await expect(auth.verifyPartnerLogin('+5926001003', '246810')).rejects.toThrow('No business or earner profile');
  expect(auth.getSessionPrincipal()).toBe('b');
  expect(auth.currentSessionEpoch()).toBe(epoch + 1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it('QR composition: a peer invalidation and its first probe preserve the signing-in tab’s own Add', async () => {
  const { auth } = await browser('/login');
  const deliveries: (() => void)[] = [];
  const endpoints: Channel[] = [];
  class Channel {
    onmessage: ((_event: MessageEvent) => void) | null = null;
    constructor() { endpoints.push(this); }
    postMessage(data: unknown) {
      for (const peer of endpoints) if (peer !== this) deliveries.push(() => peer.onmessage?.({ data } as MessageEvent));
    }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  auth.getSessionPrincipal();
  const continuation = await import('./storefront-continuation');
  vi.resetModules();
  const peer = await import('./auth');
  peer.getSessionPrincipal();
  const local = sessionStorage;
  const intent = { storeSlug: 'test', itemId: 'meal', selectedOptions: {}, returnPath: '/store/test' };
  continuation.queueStorefrontContinuation(intent);
  auth.adoptSession('customer');
  const entries = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
  });
  expect(deliveries).toHaveLength(1);
  deliveries.shift()!();
  vi.stubGlobal('sessionStorage', local);
  expect(continuation.readStorefrontContinuation()).toEqual(intent);
  vi.stubGlobal('fetch', vi.fn(async () => response({ user: { id: 'customer' } })));
  // The peer has no Add. Its subsequent proof must not invalidate the sender.
  vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem() {}, length: 0 });
  expect((await peer.sessionProbe()).ok).toBe(true);
  vi.stubGlobal('sessionStorage', local);
  expect(continuation.takeStorefrontContinuation('test')).toEqual(intent);
  expect(continuation.takeStorefrontContinuation('test')).toBeNull();
});
