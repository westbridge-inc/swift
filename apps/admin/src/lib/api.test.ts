import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockApi, API_ORIGIN } from '@/test/test-utils';
import { BROWSER_CLIENT, logout, sessionProbe, verifyOtpLogin } from '@/lib/api';

// ---------------------------------------------------------------------------
// [A-01] The console holds no credential. After a sign-in nothing is written
// to any browser storage; every request names the client and carries
// credentials (the HttpOnly cookies the browser keeps for us); a 401 refreshes
// ONCE from the refresh cookie — concurrent 401s share one refresh — and a
// second 401 sends the console to /login. The shell gates on the server's
// session probe, and logout revokes on the server.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), 'src', 'lib', 'api.ts'), 'utf8');

async function loadApi() {
  // a fresh module instance per test so the refresh single-flight state starts clean
  vi.resetModules();
  return import('@/lib/api');
}

describe('[A-01] nothing a script can read', () => {
  it('a sign-in stores no credential anywhere — not localStorage, not sessionStorage, not the cookie jar a script can see', async () => {
    const fetchMock = mockApi(({ url }) => {
      if (url.pathname.endsWith('/auth/verify-otp')) return { body: { success: true, data: { isNewUser: false, user: { id: 'u1', roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE' }, onboarding: null, session: 'cookie' } } };
      return { body: { success: true, data: {} } };
    });
    await verifyOtpLogin('+5926001000', '246810');
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(document.cookie).toBe('');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Swift-Client']).toBe(BROWSER_CLIENT);
  });

  it('the client module never touches browser storage and never puts a token in a header', () => {
    expect(SOURCE).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(SOURCE).not.toMatch(/Authorization: `Bearer/);
    expect(SOURCE).toContain("credentials: 'include'");
  });
});

describe('[A-01] every request carries the client name and credentials; a 401 refreshes once', () => {
  it('a 401 triggers exactly one refresh (no body — the cookie is the credential) and the request is retried', async () => {
    const api = await loadApi();
    let calls = 0;
    const fetchMock = mockApi(({ url, method }) => {
      if (url.pathname.endsWith('/auth/refresh')) { expect(method).toBe('POST'); return { body: { success: true, data: { expiresIn: 900, session: 'cookie' } } }; }
      calls += 1;
      return calls === 1 ? { status: 401, body: { success: false } } : { body: { success: true, data: { ok: true } } };
    });
    const result = await api.fetchDashboard();
    expect(result).toBeTruthy();
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    const [, refreshInit] = refreshCalls[0]!;
    expect(refreshInit?.credentials).toBe('include');
    expect(refreshInit?.body).toBeUndefined();
    expect((refreshInit?.headers as Record<string, string>)['X-Swift-Client']).toBe(BROWSER_CLIENT);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include');
      expect((init?.headers as Record<string, string>)['X-Swift-Client']).toBe(BROWSER_CLIENT);
    }
  });

  it('three concurrent 401s share ONE refresh', async () => {
    const api = await loadApi();
    let refreshes = 0;
    const seen = new Map<string, number>();
    mockApi(async ({ url }) => {
      if (url.pathname.endsWith('/auth/refresh')) { refreshes += 1; await new Promise((r) => setTimeout(r, 20)); return { body: { success: true, data: { session: 'cookie' } } }; }
      // the FIRST THREE calls on the path all come back 401 (three concurrent
      // expired requests); their retries after the shared refresh succeed
      const n = (seen.get(url.pathname) ?? 0) + 1; seen.set(url.pathname, n);
      return n <= 3 ? { status: 401, body: {} } : { body: { success: true, data: { ok: true } } };
    });
    await Promise.all([api.fetchDashboard(), api.fetchDashboard(), api.fetchDashboard()]);
    expect(refreshes).toBe(1);
  });

  it('a second 401 after the refresh signs the console out (to /login) instead of looping', async () => {
    const api = await loadApi();
    mockApi(({ url }) => (url.pathname.endsWith('/auth/refresh') ? { body: { success: true, data: { session: 'cookie' } } } : { status: 401, body: {} }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { pathname: '/dashboard', set href(v: string) { assign(v); } }, configurable: true });
    await expect(api.fetchDashboard()).rejects.toThrow(/Session expired/);
    expect(assign).toHaveBeenCalledWith('/login');
  });
});

describe('[A-01] the production CSP grants no unsafe-eval', () => {
  it('next.config.ts grants unsafe-eval to development only, never to a production build', () => {
    const cfg = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
    expect(cfg).toContain("isProductionBuild ? \"script-src 'self' 'unsafe-inline'\"");
    const productionBranch = cfg.slice(cfg.indexOf('isProductionBuild ?'), cfg.indexOf(' : ', cfg.indexOf('isProductionBuild ?')));
    expect(productionBranch).not.toContain('unsafe-eval');
  });
});

describe('[A-01] the shell asks the server, and logout revokes on the server', () => {
  it('sessionProbe is the server’s answer: ok with a user, not ok on 401 or a network failure', async () => {
    mockApi(() => ({ body: { success: true, data: { user: { id: 'u1', activeRole: 'ADMIN', roles: ['ADMIN'] }, client: BROWSER_CLIENT } } }));
    expect(await sessionProbe()).toMatchObject({ ok: true, user: { id: 'u1' } });
    mockApi(() => ({ status: 401, body: { success: false } }));
    expect(await sessionProbe()).toEqual({ ok: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await sessionProbe()).toEqual({ ok: false });
  });

  it('logout POSTs to the server with credentials and the client name, and never throws', async () => {
    const fetchMock = mockApi(({ url, method }) => { expect(url.pathname).toBe('/api/v1/auth/logout'); expect(method).toBe('POST'); return { body: { success: true } }; });
    await logout();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${API_ORIGIN}/api/v1/auth/logout`);
    expect(init?.credentials).toBe('include');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(logout()).resolves.toBeUndefined();
  });
});
