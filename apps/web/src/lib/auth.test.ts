import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockApi, API_ORIGIN } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [W-01] THE CUSTOMER AND VENDOR WEB APP HOLDS NO CREDENTIAL.
//
// It used to keep both tokens in localStorage under `swift_web_token` and
// `swift_web_refresh`. The refresh token is not a short window: it is a
// renewable session belonging to a business that accepts orders and settles
// money, or to an earner whose pay link lives behind it — and any script that
// ran one line on this origin could read it and keep it.
//
// The session is now the HttpOnly cookie pair the API issues to a named
// browser client (A-01's rail, which already accepted `web`). Sign-in, sign-up
// and refresh all arrive as cookies with NO credential in the body; every
// request is credentialed; and every page that used to gate on "is there a
// token in localStorage" now gates on the SERVER's answer, because there is no
// token left to inspect.
//
// What this must NOT break is the guard that stops one account's response
// rendering under another. That was never about where the token lived, so it
// is kept — tracked from the server's attestation instead of a decoded token.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), 'src', 'lib', 'auth.ts'), 'utf8');
const CUSTOMER_SOURCE = readFileSync(join(process.cwd(), 'src', 'lib', 'customer.ts'), 'utf8');

/** Source with comments removed: a claim about what the code does must not be
 *  satisfiable, or breakable, by prose that names what the code no longer has. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A fresh module instance per test: the session principal, the generation
 *  counter and the refresh single-flight are module state. */
async function loadAuth() {
  vi.resetModules();
  return import('@/lib/auth');
}
async function loadCustomer() {
  vi.resetModules();
  return import('@/lib/customer');
}

const signedInAs = (id: string) => ({
  body: { success: true, data: { user: { id, roles: ['CUSTOMER'], activeRole: 'CUSTOMER' }, client: 'web' } },
});

describe('[W-01] nothing a script can read', () => {
  it('a partner sign-in writes no credential anywhere — not localStorage, not sessionStorage, not a cookie a script can see', async () => {
    const auth = await loadAuth();
    const fetchMock = mockApi(() => ({
      body: { success: true, data: { isNewUser: false, user: { id: 'u1', roles: ['VENDOR'], activeRole: 'VENDOR' }, session: 'cookie' } },
    }));
    await auth.verifyPartnerLogin('+5926001000', '246810');
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(document.cookie).toBe('');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Swift-Client']).toBe(auth.BROWSER_CLIENT);
  });

  it('a customer sign-in and a brand-new sign-up write no credential either — and both are credentialed, named requests', async () => {
    const customer = await loadCustomer();
    const login = mockApi(() => ({
      body: { success: true, data: { isNewUser: false, user: { id: 'c1', roles: ['CUSTOMER'] }, session: 'cookie' } },
    }));
    await customer.verifyCustomerLogin('+5926001001', '246810');
    expect(Object.keys(localStorage)).toEqual([]);
    expect(document.cookie).toBe('');
    const [, loginInit] = login.mock.calls[0]!;
    expect(loginInit?.credentials).toBe('include');
    expect((loginInit?.headers as Record<string, string>)['X-Swift-Client']).toBe('web');

    const signup = mockApi(() => ({
      status: 201,
      body: { success: true, data: { user: { id: 'c2', roles: ['CUSTOMER'] }, onboarding: null, session: 'cookie' } },
    }));
    const created = await customer.registerAccount({ phone: '+5926001002', firstName: 'New', lastName: 'Customer', role: 'CUSTOMER', acceptTerms: true });
    expect(created.user.id).toBe('c2');
    expect(Object.keys(localStorage)).toEqual([]);
    expect(document.cookie).toBe('');
    const [, signupInit] = signup.mock.calls[0]!;
    expect(signupInit?.credentials).toBe('include');
    expect((signupInit?.headers as Record<string, string>)['X-Swift-Client']).toBe('web');
  });

  it('a sign-up the server answers with a user but no tokens still signs the person in — the body carries no credential by design', async () => {
    const customer = await loadCustomer();
    // the SAME module graph customer.ts bound to — a second reset would hand
    // back a different auth instance and the assertion would grade nothing
    const auth = await import('@/lib/auth');
    mockApi(() => ({ status: 201, body: { success: true, data: { user: { id: 'c9' }, session: 'cookie' } } }));
    await customer.registerAccount({ phone: '+5926001009', firstName: 'A', lastName: 'B', role: 'CUSTOMER' });
    // the app's own record of who it is comes from the SERVER's user, not a token
    expect(auth.getSessionPrincipal()).toBe('c9');
  });

  it('neither module stores a token or sends one in a header — the storage it does keep is a store id, never a credential', () => {
    // the comments SAY the old key names, on purpose: they record what was
    // removed. Grade the CODE.
    expect(code(SOURCE)).not.toMatch(/swift_web_token|swift_web_refresh/);
    expect(code(SOURCE)).not.toMatch(/Authorization/);
    expect(code(CUSTOMER_SOURCE)).not.toMatch(/Authorization|setTokens|accessToken/);
    expect(SOURCE).toContain("credentials: 'include'");
    // every localStorage key this module still touches, named
    const keys = [...code(SOURCE).matchAll(/localStorage\.\w+\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect([...new Set(keys)]).toEqual(['STORE_KEY']);
  });

  it('no page in the app reads a credential out of storage or attaches a bearer', () => {
    const pages = readFileSync(join(process.cwd(), 'src', 'app', 'dashboard', 'layout.tsx'), 'utf8')
      + readFileSync(join(process.cwd(), 'src', 'app', 'portal', 'layout.tsx'), 'utf8')
      + readFileSync(join(process.cwd(), 'src', 'app', '(app)', 'layout.tsx'), 'utf8')
      + readFileSync(join(process.cwd(), 'src', 'app', 'selfie', 'page.tsx'), 'utf8')
      + readFileSync(join(process.cwd(), 'src', 'app', 'dashboard', 'inventory', 'import', 'page.tsx'), 'utf8')
      + readFileSync(join(process.cwd(), 'src', 'components', 'storefront', 'storefront-experience.tsx'), 'utf8');
    expect(pages).not.toMatch(/getToken|Bearer/);
    // and the one raw fetch left in a page still sends the session
    expect(pages).toContain("credentials: 'include'");
  });
});

describe('[W-01] every request carries the client name and the cookies; a 401 refreshes once', () => {
  it('a 401 triggers exactly one refresh — no body, because the cookie IS the credential — and the request is retried', async () => {
    const auth = await loadAuth();
    let calls = 0;
    const fetchMock = mockApi(({ url, method }) => {
      if (url.pathname.endsWith('/auth/refresh')) { expect(method).toBe('POST'); return { body: { success: true, data: { expiresIn: 900, session: 'cookie' } } }; }
      calls += 1;
      return calls === 1 ? { status: 401, body: { success: false } } : { body: { success: true, data: { ok: true } } };
    });
    await expect(auth.apiFetch('/api/v1/vendor/orders')).resolves.toMatchObject({ data: { ok: true } });
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    const [, refreshInit] = refreshCalls[0]!;
    expect(refreshInit?.credentials).toBe('include');
    expect(refreshInit?.body).toBeUndefined();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include');
      expect((init?.headers as Record<string, string>)['X-Swift-Client']).toBe(auth.BROWSER_CLIENT);
    }
  });

  it('three concurrent 401s share ONE refresh — a rotated refresh cookie is never replayed, which would revoke the family', async () => {
    const auth = await loadAuth();
    let refreshes = 0;
    const seen = new Map<string, number>();
    mockApi(async ({ url }) => {
      if (url.pathname.endsWith('/auth/refresh')) { refreshes += 1; await new Promise((r) => setTimeout(r, 20)); return { body: { success: true, data: { session: 'cookie' } } }; }
      // the first THREE reads of the path are the three expired requests; the
      // retries they make after the ONE shared refresh succeed
      const n = (seen.get(url.pathname) ?? 0) + 1; seen.set(url.pathname, n);
      return n <= 3 ? { status: 401, body: {} } : { body: { success: true, data: { ok: true } } };
    });
    const orders = '/api/v1/vendor/orders';
    await Promise.all([auth.apiFetch(orders), auth.apiFetch(orders), auth.apiFetch(orders)]);
    expect(refreshes).toBe(1);
  });

  it('a second 401 after the refresh sends the page to /login and keeps where it was, so the person comes back to it', async () => {
    const auth = await loadAuth();
    mockApi(({ url }) => (url.pathname.endsWith('/auth/refresh') ? { body: { success: true, data: {} } } : { status: 401, body: {} }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { pathname: '/dashboard/orders', search: '?status=NEW', set href(v: string) { assign(v); } },
      configurable: true,
    });
    await expect(auth.apiFetch('/api/v1/vendor/orders')).rejects.toThrow(/Session expired/);
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fdashboard%2Forders%3Fstatus%3DNEW');
  });

  it('a caller that asked not to be redirected is NOT redirected — it still learns the session expired', async () => {
    const auth = await loadAuth();
    mockApi(({ url }) => (url.pathname.endsWith('/auth/refresh') ? { body: { success: true, data: {} } } : { status: 401, body: {} }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { pathname: '/store/roti-hut', search: '', set href(v: string) { assign(v); } }, configurable: true });
    await expect(auth.apiFetch('/api/v1/customer/cart', undefined, { redirectOnExpired: false }))
      .rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('[W-01] the gate is the server’s word, not a token’s presence', () => {
  it('sessionProbe is ok only when the server names a user; a 401 and a network failure are both "not signed in"', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    expect(await auth.sessionProbe()).toMatchObject({ ok: true, user: { id: 'u1' } });
    expect(auth.getSessionPrincipal()).toBe('u1');

    const auth2 = await loadAuth();
    mockApi(() => ({ status: 401, body: { success: false } }));
    expect(await auth2.sessionProbe()).toEqual({ ok: false });

    const auth3 = await loadAuth();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await auth3.sessionProbe()).toEqual({ ok: false });
  });

  it('a 200 that names nobody is not a session — a shape change must not read as signed in', async () => {
    const auth = await loadAuth();
    mockApi(() => ({ body: { success: true, data: { user: null } } }));
    expect(await auth.sessionProbe()).toEqual({ ok: false });
    const auth2 = await loadAuth();
    mockApi(() => ({ body: { success: true, data: { user: { id: 12345 } } } }));
    expect(await auth2.sessionProbe()).toEqual({ ok: false });
  });

  it('the probe reaches the server credentialed and named, or the cookie is not a credential at all', async () => {
    const auth = await loadAuth();
    const fetchMock = mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${API_ORIGIN}/api/v1/auth/me`);
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Swift-Client']).toBe('web');
  });
});

describe('[W-01] signing out is a server act, because only the server can expire the cookie', () => {
  it('sign out POSTs to the server, credentialed and named — deleting local state cannot end a session the page cannot see', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    const fetchMock = mockApi(({ url, method }) => {
      expect(url.pathname).toBe('/api/v1/auth/logout');
      expect(method).toBe('POST');
      return { body: { success: true } };
    });
    await auth.logout();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${API_ORIGIN}/api/v1/auth/logout`);
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Swift-Client']).toBe('web');
    expect(auth.getSessionPrincipal()).toBeNull();
  });

  it('a sign-out with an EXPIRED access cookie still ends the session — it refreshes and retries instead of leaving the refresh cookie alive', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    let logouts = 0; let refreshes = 0;
    mockApi(({ url }) => {
      if (url.pathname.endsWith('/auth/refresh')) { refreshes += 1; return { body: { success: true, data: { session: 'cookie' } } }; }
      logouts += 1;
      // the fifteen-minute access cookie has expired on a tab left open
      return logouts === 1 ? { status: 401, body: { success: false } } : { body: { success: true } };
    });
    await auth.logout();
    expect(refreshes).toBe(1);
    expect(logouts).toBe(2);
    expect(auth.getSessionPrincipal()).toBeNull();
  });

  it('an unreachable server still signs out locally — the button never hangs and never throws', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    auth.setSelectedStore('store-a');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(auth.logout()).resolves.toBeUndefined();
    expect(auth.getSessionPrincipal()).toBeNull();
    expect(auth.getSelectedStore()).toBeNull();
  });

  it('no sign-out button clears local state alone — every one of them asks the server', () => {
    for (const file of [
      ['src', 'app', 'portal', 'layout.tsx'],
      ['src', 'app', 'dashboard', 'layout.tsx'],
      ['src', 'app', '(app)', 'account', 'page.tsx'],
    ]) {
      const source = readFileSync(join(process.cwd(), ...file), 'utf8');
      expect(source, file.join('/')).toMatch(/logout\(\)/);
      expect(code(source), file.join('/')).not.toMatch(/clearSession/);
    }
  });
});

describe('[W-01] the account-change guards survive the move off tokens', () => {
  it('a response that arrives after the account changed is refused, not rendered under the new one', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    mockApi(async () => {
      // the account changes while this request is in flight
      auth.adoptSession('u2');
      return { body: { success: true, data: { secret: 'u1 only' } } };
    });
    await expect(auth.apiFetch('/api/v1/customer/orders')).rejects.toMatchObject({ status: 409, code: 'SESSION_CHANGED' });
  });

  it('a response that arrives after the vendor switched stores is refused too — the wrong store’s orders are not shown', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('v1'));
    await auth.sessionProbe();
    auth.setSelectedStore('store-a');
    mockApi(async ({ init }) => {
      expect((init?.headers as Record<string, string>)['x-vendor-id']).toBe('store-a');
      auth.setSelectedStore('store-b');
      return { body: { success: true, data: { orders: [] } } };
    });
    await expect(auth.apiFetch('/api/v1/vendor/orders')).rejects.toMatchObject({ status: 409, code: 'SESSION_CHANGED' });
  });

  it('LEARNING who the session belongs to is not an account change — a page that loads while the probe runs is not killed', async () => {
    const auth = await loadAuth();
    // the shape every page has: a probe and a data read start together, and the
    // probe answers first. Nothing changed accounts — the app just found out.
    mockApi(({ url }) => (url.pathname.endsWith('/auth/me') ? signedInAs('u1') : { body: { success: true, data: { ok: true } } }));
    const [probe, data] = await Promise.all([auth.sessionProbe(), auth.apiFetch('/api/v1/customer/home')]);
    expect(probe.ok).toBe(true);
    expect(data).toMatchObject({ data: { ok: true } });
  });

  it('a signed-OUT answer does not render under a session that began while it was in flight', async () => {
    const auth = await loadAuth();
    // nobody is signed in yet — the storefront's reads run for a visitor
    expect(auth.getSessionPrincipal()).toBeNull();
    mockApi(async () => {
      // the person signs in (in the drawer, in another component) while the
      // visitor's read is still out. What comes back was computed for NOBODY.
      auth.adoptSession('u1');
      return { body: { success: true, data: { cart: null } } };
    });
    await expect(auth.apiFetch('/api/v1/customer/cart')).rejects.toMatchObject({ status: 409, code: 'SESSION_CHANGED' });
  });

  it('but a session that goes AWAY mid-request is still refused — the tolerance is for learning, not for losing', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    expect(auth.getSessionPrincipal()).toBe('u1');
    mockApi(async ({ url }) => {
      if (url.pathname.endsWith('/auth/me')) return { status: 401, body: { success: false } };
      // the probe discovers the session is gone while this read is in flight
      await auth.sessionProbe();
      return { body: { success: true, data: { secret: 'u1 only' } } };
    });
    await expect(auth.apiFetch('/api/v1/customer/orders')).rejects.toMatchObject({ status: 409, code: 'SESSION_CHANGED' });
  });

  it('signing out and back in as someone else clears what was keyed to the first person', async () => {
    const auth = await loadAuth();
    sessionStorage.setItem('swift_web_checkout_attempt:store-a', 'sig-1');
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    expect(sessionStorage.getItem('swift_web_checkout_attempt:store-a')).toBe('sig-1');
    auth.adoptSession('u2');
    expect(sessionStorage.getItem('swift_web_checkout_attempt:store-a')).toBeNull();
  });

  it('clearSession forgets the principal and the selected store, so the next page renders as nobody', async () => {
    const auth = await loadAuth();
    mockApi(() => signedInAs('u1'));
    await auth.sessionProbe();
    auth.setSelectedStore('store-a');
    auth.clearSession();
    expect(auth.getSessionPrincipal()).toBeNull();
    expect(auth.getSelectedStore()).toBeNull();
  });
});
