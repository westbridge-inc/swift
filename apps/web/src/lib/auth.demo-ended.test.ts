import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest } from '@/test/test-utils';
import { DEMO_ENDED_NOTICE, isClosedDemoAnswer, takeDemoEndedNotice } from '@/lib/demo-ended';

// ---------------------------------------------------------------------------
// [Row 353 · DL-9] The store-review demo's session is over: every request it
// makes is answered 410 REVIEW_SESSION_CLOSED. The website signs that browser
// out — the server clears the HttpOnly cookies through /auth/logout/refresh,
// which needs no live access session — and the sign-in page says why. Never
// an error page, a blank screen or a refresh loop. Any other 410 is an
// ordinary error, and nobody is signed out for it.
// ---------------------------------------------------------------------------

async function loadAuth() {
  vi.resetModules();
  return import('@/lib/auth');
}
const closed = { success: false, error: { code: 'REVIEW_SESSION_CLOSED', message: 'This demo has ended, so its sample stores and orders are no longer available.' } };
let assign = vi.fn<(href: string) => void>();
const at = (pathname: string) => {
  assign = vi.fn<(href: string) => void>();
  Object.defineProperty(window, 'location', { value: { pathname, search: '', set href(v: string) { assign(v); } }, configurable: true });
};
const calls = (fetchMock: ReturnType<typeof mockApi>, path: string) =>
  fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === path);

beforeEach(() => { window.sessionStorage.clear(); at('/account'); });
afterEach(() => { window.sessionStorage.clear(); });

describe('a request answered 410 REVIEW_SESSION_CLOSED', () => {
  it('signs this browser out at the server, then sends the page to sign-in with the reason; the caller gets the plain sentence', async () => {
    const auth = await loadAuth();
    auth.adoptSession('demo-user');
    const fetchMock = mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/auth/logout/refresh') return { body: { success: true } };
      return { status: 410, body: closed };
    });
    await expect(auth.apiFetch('/api/v1/customer/orders')).rejects.toMatchObject({ status: 410, code: 'REVIEW_SESSION_CLOSED', message: DEMO_ENDED_NOTICE });
    const out = calls(fetchMock, '/api/v1/auth/logout/refresh');
    expect(out).toHaveLength(1);
    expect(out[0]![1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((out[0]![1]!.headers as Record<string, string>)['X-Swift-Client']).toBe('web');
    expect(auth.getSessionPrincipal()).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login?ended=demo');
    // No refresh is spent and nothing is retried.
    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(0);
    expect(calls(fetchMock, '/api/v1/customer/orders')).toHaveLength(1);
  });

  it('a caller that asked not to be moved is not moved; the sign-in page still says why when they get there', async () => {
    const auth = await loadAuth();
    mockApi((request: ApiRequest) => (request.url.pathname === '/api/v1/auth/logout/refresh' ? { body: { success: true } } : { status: 410, body: closed }));
    await expect(auth.apiFetch('/api/v1/customer/cart', undefined, { redirectOnExpired: false })).rejects.toMatchObject({ code: 'REVIEW_SESSION_CLOSED' });
    expect(assign).not.toHaveBeenCalled();
    expect(takeDemoEndedNotice(null)).toBe(true);
    expect(takeDemoEndedNotice(null)).toBe(false);
  });

  it('already on the sign-in page: signed out, not reloaded', async () => {
    at('/login');
    const auth = await loadAuth();
    mockApi((request: ApiRequest) => (request.url.pathname === '/api/v1/auth/logout/refresh' ? { body: { success: true } } : { status: 410, body: closed }));
    await expect(auth.apiFetch('/api/v1/customer/home')).rejects.toMatchObject({ code: 'REVIEW_SESSION_CLOSED' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('offline while signing out: still signed out locally and sent to sign-in', async () => {
    const auth = await loadAuth();
    auth.adoptSession('demo-user');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/v1/auth/logout/refresh')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(closed), { status: 410, headers: { 'Content-Type': 'application/json' } });
    }));
    await expect(auth.apiFetch('/api/v1/customer/home')).rejects.toMatchObject({ code: 'REVIEW_SESSION_CLOSED' });
    expect(auth.getSessionPrincipal()).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login?ended=demo');
  });
});

describe('the session probe meets a closed demo', () => {
  it('is "not signed in", clears the cookies at the server, does not move the page, and leaves the reason for sign-in', async () => {
    const auth = await loadAuth();
    auth.adoptSession('demo-user');
    const fetchMock = mockApi((request: ApiRequest) => (request.url.pathname === '/api/v1/auth/logout/refresh' ? { body: { success: true } } : { status: 410, body: closed }));
    expect(await auth.sessionProbe()).toEqual({ ok: false });
    expect(calls(fetchMock, '/api/v1/auth/logout/refresh')).toHaveLength(1);
    expect(auth.getSessionPrincipal()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(takeDemoEndedNotice(null)).toBe(true);
  });
});

describe('nothing else is a closed demo', () => {
  it('another 410 is an ordinary error: nobody is signed out or moved', async () => {
    const auth = await loadAuth();
    auth.adoptSession('real-user');
    const fetchMock = mockApi(() => ({ status: 410, body: { success: false, error: { code: 'GONE', message: 'That offer has ended.' } } }));
    await expect(auth.apiFetch('/api/v1/customer/offers/1')).rejects.toMatchObject({ status: 410, code: 'GONE', message: 'That offer has ended.' });
    expect(calls(fetchMock, '/api/v1/auth/logout/refresh')).toHaveLength(0);
    expect(auth.getSessionPrincipal()).toBe('real-user');
    expect(assign).not.toHaveBeenCalled();
    expect(takeDemoEndedNotice(null)).toBe(false);
  });

  it('only a 410 naming REVIEW_SESSION_CLOSED counts', () => {
    expect(isClosedDemoAnswer(410, closed)).toBe(true);
    expect(isClosedDemoAnswer(403, closed)).toBe(false);
    expect(isClosedDemoAnswer(410, { error: { code: 'GONE' } })).toBe(false);
    expect(isClosedDemoAnswer(410, null)).toBe(false);
    expect(takeDemoEndedNotice('demo')).toBe(true);
    expect(takeDemoEndedNotice('other')).toBe(false);
  });
});
