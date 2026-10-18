import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { logout } from './api';

// ---------------------------------------------------------------------------
// [Row 78] Admin Sign out ends the 30-day session, not only the tab.
//
// POST /auth/logout needs a live access cookie, which lasts minutes. An admin
// who signs out of a tab left open got a 401 from the gate before the handler
// ran: nothing was revoked, no cookie was cleared, and the month-long refresh
// cookie could sign the browser straight back in. When /logout does not
// answer success, sign-out now ends the session by its refresh cookie
// (POST /auth/logout/refresh, which revokes and clears without an access
// token). The shell still leaves for /login whatever the server says.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); });

const paths = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.map(([input, init]) => ({
  path: new URL(String(input)).pathname,
  method: init?.method,
  credentials: init?.credentials,
  client: (init?.headers as Record<string, string> | undefined)?.['X-Swift-Client'],
}));

describe('[row 78] admin sign-out ends the 30-day session', () => {
  it('a live session signs out with /logout alone', async () => {
    const fetch = mockApi(() => ({ body: { success: true } }));
    await logout();
    expect(paths(fetch)).toEqual([{ path: '/api/v1/auth/logout', method: 'POST', credentials: 'include', client: 'admin-web' }]);
  });

  it('an expired access cookie (401 at /logout) still ends the session by its refresh cookie', async () => {
    const fetch = mockApi((r) => (r.url.pathname.endsWith('/auth/logout')
      ? { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } } }
      : { body: { success: true } }));
    await logout();
    expect(paths(fetch)).toEqual([
      { path: '/api/v1/auth/logout', method: 'POST', credentials: 'include', client: 'admin-web' },
      { path: '/api/v1/auth/logout/refresh', method: 'POST', credentials: 'include', client: 'admin-web' },
    ]);
  });

  it('a /logout that cannot be reached also falls back, and sign-out never throws', async () => {
    let calls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      if (String(input).endsWith('/auth/logout')) throw new TypeError('Failed to fetch');
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(logout()).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(new URL(String(fetch.mock.calls[1]![0])).pathname).toBe('/api/v1/auth/logout/refresh');
  });
});
