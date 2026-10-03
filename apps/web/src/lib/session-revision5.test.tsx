import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/login', router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname, useRouter: () => route.router,
  useSearchParams: () => new URLSearchParams('next=%2Fstore%2Ftest'),
}));
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
async function browser(pathname: string) {
  vi.resetModules();
  route.pathname = pathname;
  sessionStorage.clear();
  const announce = vi.fn();
  vi.stubGlobal('BroadcastChannel', class { postMessage = announce; });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/me')
    ? new Response(null, { status: 401 }) : response({}));
  vi.stubGlobal('fetch', fetcher);
  const auth = await import('./auth');
  return { auth, fetcher, announce };
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

it.each(['refused', 'retried'] as const)('SX384 (4) delayed guest API 401 with %s refresh retains the login OTP journey', async (refresh) => {
  const { auth, fetcher, announce } = await browser('/login');
  const priorPage = deferred<Response>();
  fetcher.mockReturnValueOnce(priorPage.promise);
  const pending = auth.apiFetch('/api/v1/customer/cart', undefined, { redirectOnExpired: false }).catch((error: unknown) => error);
  await openOtp('/login');
  const epoch = auth.currentSessionEpoch();
  fetcher.mockImplementation(async (input) => String(input).endsWith('/auth/refresh') && refresh === 'retried'
    ? response({}) : new Response(null, { status: 401 }));
  await act(async () => {
    priorPage.resolve(new Response(null, { status: 401 }));
    expect(await pending).toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
  });
  expect(auth.currentSessionEpoch()).toBe(epoch);
  expect(auth.getSessionPrincipal()).toBeNull();
  expect(announce).not.toHaveBeenCalled();
  expectDraft(false);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/customer/cart'))).toHaveLength(refresh === 'retried' ? 2 : 1);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
});

const uncertainResults = [
  ['offline', () => Promise.reject(new TypeError('offline'))],
  ['server error', async () => new Response(null, { status: 503 })],
  ['rate limited', async () => new Response(null, { status: 429 })],
  ['unreadable body', async () => new Response('invalid-json')],
  ['missing identity', async () => response({ user: null })],
] as const;

it('SX384 (4) a final API 401 still retires a known account and its private state', async () => {
  const { auth, fetcher, announce } = await browser('/login');
  auth.adoptSession('a');
  auth.setSelectedStore('store-a');
  sessionStorage.setItem('swift_web_checkout_attempt:a', 'private attempt');
  announce.mockClear();
  const epoch = auth.currentSessionEpoch();
  fetcher.mockImplementation(async () => new Response(null, { status: 401 }));
  await expect(auth.apiFetch('/api/v1/customer/cart', undefined, { redirectOnExpired: false }))
    .rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
  expect(auth.currentSessionEpoch()).toBe(epoch + 1);
  expect(auth.getSessionPrincipal()).toBeNull();
  expect(auth.getSelectedStore()).toBeNull();
  expect(sessionStorage.getItem('swift_web_checkout_attempt:a')).toBeNull();
  expect(announce).toHaveBeenCalledTimes(1);
});

for (const pathname of ['/login', '/signup']) {
  for (const recovery of ['guest', 'other account']) {
    it.each(uncertainResults)(`SX384 (1) ${pathname} retains a masked OTP draft after %s until ${recovery} is proved`, async (_kind, uncertain) => {
      const { auth, fetcher, announce } = await browser(pathname);
      await openOtp(pathname);
      const epoch = auth.currentSessionEpoch();
      vi.useFakeTimers();
      fetcher.mockImplementationOnce(uncertain);
      await act(async () => window.dispatchEvent(new Event('focus')));
      expectDraft(true);
      expect(screen.getByRole('status').textContent).toBe('Checking your account…');
      expect(auth.currentSessionEpoch()).toBe(epoch);
      expect(announce).not.toHaveBeenCalled();

      const fresh = deferred<Response>();
      fetcher.mockReturnValueOnce(fresh.promise);
      act(() => window.dispatchEvent(new Event('online')));
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expectDraft(true);
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'))).toHaveLength(2);
      await act(async () => fresh.resolve(recovery === 'guest'
        ? new Response(null, { status: 401 }) : response({ user: { id: 'b' } })));
      expect(screen.queryByRole('status')).toBeNull();
      if (recovery === 'guest') {
        expectDraft(false);
        expect(auth.currentSessionEpoch()).toBe(epoch);
        expect(announce).not.toHaveBeenCalled();
      } else {
        expect(screen.queryByLabelText('Verification code')).toBeNull();
        expect(screen.queryByText(/Enter the code sent to/)).toBeNull();
        expect(auth.currentSessionEpoch()).toBe(epoch + 1);
        expect(auth.getSessionPrincipal()).toBe('b');
        if (pathname === '/login') expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+592');
        else expect(screen.getByRole('heading', { name: 'What brings you to Swift?' })).toBeTruthy();
      }
    });
  }
}
