import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { requestOtp } from './helpers/otp';
import {
  ACCESS_COOKIE, ACCESS_COOKIE_PATH, REFRESH_COOKIE, REFRESH_COOKIE_PATH, allowedBrowserOrigins, parseCookies, resetBrowserOriginsForTests, setSessionCookies,
} from '../modules/auth/browser-session';
import { browserSessionCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [A-01 / W-01] A browser session is credentials a script can never read.
//
// A browser client (the admin console names itself with `X-Swift-Client`)
// signs in and receives its session as HttpOnly, SameSite=Strict cookies —
// the refresh cookie scoped to the auth path — and NO credential in the
// body. The cookie is a credential only with the client header AND an
// allowed Origin (the CSRF gate); a cookie alone is nothing. Refresh rotates
// the cookies from the refresh cookie and the old one is a replay that
// revokes the family. Logout clears the cookies and the old cookie no longer
// authenticates. The native clients' Bearer flow is untouched.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const ORIGIN = 'http://localhost:3001';
const EVIL = 'https://evil.example';
const RUN = nanoid(6).toLowerCase();
const phone = `+59277${String(Math.floor(Math.random() * 90000) + 10000)}`;
const userIds: string[] = [];
const BROWSER = { 'x-swift-client': 'admin-web', origin: ORIGIN } as const;

const count = async (event: string) => (await browserSessionCounter.get()).values.find((v) => v.labels['event'] === event)?.value ?? 0;

type Jar = Record<string, string>;
/** A browser's cookie jar: every Set-Cookie header applied in order (an empty Max-Age=0 value deletes). */
function applySetCookies(jar: Jar, res: { headers: Record<string, unknown> }): { raw: string[] } {
  const raw = ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
  for (const line of raw) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const at = pair!.indexOf('=');
    const name = pair!.slice(0, at); const value = decodeURIComponent(pair!.slice(at + 1));
    const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
    if (maxAge && Number(maxAge.split('=')[1]) <= 0) delete jar[name]; else jar[name] = value;
  }
  return { raw };
}
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

beforeAll(async () => {
  process.env['CORS_ORIGIN'] = `${ORIGIN},http://localhost:3002`;
  resetBrowserOriginsForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
  const u = await app.prisma.user.create({ data: { phone, firstName: 'Browser', lastName: `Admin${RUN}`, roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
  userIds.push(u.id);
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:browser-session');
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  await app.close();
});

async function browserLogin(): Promise<{ jar: Jar; raw: string[]; body: Record<string, unknown> }> {
  const code = await requestOtp(app, phone);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: BROWSER, payload: { phone, code } });
  expect(res.statusCode, res.body).toBe(200);
  const jar: Jar = {};
  const { raw } = applySetCookies(jar, res);
  return { jar, raw, body: res.json().data };
}

describe('[A-01] the sign-in response carries the session as HttpOnly cookies and no credential', () => {
  it('a browser client gets two HttpOnly SameSite=Strict cookies, the refresh cookie scoped to the auth path, and a body without tokens; a native client still gets tokens in the body and no cookie', async () => {
    const { jar, raw, body } = await browserLogin();
    expect(raw).toHaveLength(2);
    for (const line of raw) {
      expect(line).toMatch(/HttpOnly/);
      expect(line).toMatch(/SameSite=Strict/);
    }
    const accessLine = raw.find((l) => l.startsWith(`${ACCESS_COOKIE}=`))!;
    const refreshLine = raw.find((l) => l.startsWith(`${REFRESH_COOKIE}=`))!;
    expect(accessLine).toContain('Path=/api/v1;');
    // the refresh cookie travels ONLY to the auth routes — a literal, so a widened constant cannot pass by tautology
    expect(refreshLine).toContain('Path=/api/v1/auth;');
    expect(REFRESH_COOKIE_PATH.startsWith(ACCESS_COOKIE_PATH + '/')).toBe(true);
    expect(jar[ACCESS_COOKIE]).toBeTruthy();
    expect(jar[REFRESH_COOKIE]).toBeTruthy();
    expect(body['session']).toBe('cookie');
    expect(body['tokens']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(jar[ACCESS_COOKIE]!);
    expect(JSON.stringify(body)).not.toContain(jar[REFRESH_COOKIE]!);
    // the native flow: no client header → tokens in the body, no Set-Cookie
    const code = await requestOtp(app, phone);
    const native = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', payload: { phone, code } });
    expect(native.statusCode).toBe(200);
    expect(native.json().data.tokens.accessToken).toBeTruthy();
    expect(native.headers['set-cookie']).toBeUndefined();
  });

  it('the XSS harness: nothing readable by a script anywhere — every cookie is HttpOnly, no token appears in any response body', async () => {
    const { raw, jar } = await browserLogin();
    expect(raw.every((l) => /HttpOnly/.test(l))).toBe(true);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toContain(jar[ACCESS_COOKIE]!);
    expect(me.body).not.toContain(jar[REFRESH_COOKIE]!);
    expect(me.json().data.user.id).toBe(userIds[0]);
    expect(me.json().data.client).toBe('admin-web');
  });
});

describe('[A-01] a cookie is a credential only with the client header and an allowed origin', () => {
  it('the same cookie is refused without the client header, and from an origin outside the allowlist — counted each way', async () => {
    const { jar } = await browserLogin();
    const cookie = cookieHeader(jar);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie } });
    expect(ok.statusCode).toBe(200);
    const h = await count('cookie_rejected_header');
    const noHeader = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { origin: ORIGIN, cookie } });
    expect(noHeader.statusCode).toBe(401);
    expect(await count('cookie_rejected_header')).toBeGreaterThan(h);
    const o = await count('cookie_rejected_origin');
    const evil = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-swift-client': 'admin-web', origin: EVIL, cookie } });
    expect(evil.statusCode).toBe(401);
    const none = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-swift-client': 'admin-web', cookie } });
    expect(none.statusCode).toBe(401);
    expect(await count('cookie_rejected_origin')).toBeGreaterThanOrEqual(o + 2);
    // the second allowlisted origin works; a Referer stands in for a missing Origin
    const second = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-swift-client': 'admin-web', origin: 'http://localhost:3002', cookie } });
    expect(second.statusCode).toBe(200);
    const referer = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-swift-client': 'admin-web', referer: `${ORIGIN}/dashboard`, cookie } });
    expect(referer.statusCode).toBe(200);
    expect(allowedBrowserOrigins().has(ORIGIN)).toBe(true);
    expect(parseCookies('a=1; b=%20x; a=2')).toEqual({ a: '1', b: ' x' });
  });

  it('the refresh cookie never reaches an ordinary API path, and a forged Bearer never adopts a cookie', async () => {
    const { jar } = await browserLogin();
    // only the refresh cookie, presented on /me: not a credential there
    const onlyRefresh = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: `${REFRESH_COOKIE}=${encodeURIComponent(jar[REFRESH_COOKIE]!)}` } });
    expect(onlyRefresh.statusCode).toBe(401);
    // a wrong Bearer wins over a valid cookie: the header is the credential when present
    const forged = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(jar), authorization: 'Bearer not-a-token' } });
    expect(forged.statusCode).toBe(401);
  });
});

describe('[A-01] refresh rotates from the cookie; logout clears and revokes', () => {
  it('refresh from the refresh cookie rotates both cookies with no token in the body; the old refresh cookie is a replay that revokes the family', async () => {
    const { jar } = await browserLogin();
    const oldRefresh = jar[REFRESH_COOKIE]!;
    const before = await count('cookie_refreshed');
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ expiresIn: 900, session: 'cookie' });
    applySetCookies(jar, res);
    expect(jar[REFRESH_COOKIE]).not.toBe(oldRefresh);
    expect(await count('cookie_refreshed')).toBe(before + 1);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(me.statusCode).toBe(200);
    // the rotated-away cookie replayed INSIDE the reuse grace (a retried request): the current cookies are re-issued, nothing rotates
    const graced = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...BROWSER, cookie: `${REFRESH_COOKIE}=${encodeURIComponent(oldRefresh)}` } });
    expect(graced.statusCode).toBe(200);
    const regraced: Jar = {}; applySetCookies(regraced, graced);
    expect(regraced[REFRESH_COOKIE]).toBe(jar[REFRESH_COOKIE]);
    // ...and replayed OUTSIDE the grace: refused, and the whole family is revoked — the live cookies stop working too
    const restoreGrace = process.env['REFRESH_REUSE_GRACE_MS'];
    process.env['REFRESH_REUSE_GRACE_MS'] = '0';
    try {
      const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...BROWSER, cookie: `${REFRESH_COOKIE}=${encodeURIComponent(oldRefresh)}` } });
      expect(replay.statusCode).toBe(401);
    } finally {
      if (restoreGrace === undefined) delete process.env['REFRESH_REUSE_GRACE_MS']; else process.env['REFRESH_REUSE_GRACE_MS'] = restoreGrace;
    }
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(after.statusCode).toBe(401);
    // a browser with no refresh cookie is told so, never read from a body it cannot have
    const bare = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: BROWSER });
    expect(bare.statusCode).toBe(401);
  });

  it('logout clears both cookies (Max-Age=0) and revokes the session: the old cookies no longer authenticate or refresh', async () => {
    const { jar } = await browserLogin();
    const old = { ...jar };
    const before = await count('cookie_cleared');
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...BROWSER, cookie: cookieHeader(jar), 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const { raw } = applySetCookies(jar, res);
    expect(raw.every((l) => /Max-Age=0/.test(l) && /HttpOnly/.test(l))).toBe(true);
    expect(jar[ACCESS_COOKIE]).toBeUndefined();
    expect(jar[REFRESH_COOKIE]).toBeUndefined();
    expect(await count('cookie_cleared')).toBe(before + 1);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(old) } });
    expect(me.statusCode).toBe(401);
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...BROWSER, cookie: cookieHeader(old) } });
    expect(refresh.statusCode).toBe(401);
  });

  it('logout from the refresh cookie alone (the client has no access cookie left) still revokes and clears', async () => {
    const { jar } = await browserLogin();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout/refresh', headers: { ...BROWSER, cookie: `${REFRESH_COOKIE}=${encodeURIComponent(jar[REFRESH_COOKIE]!)}`, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(refresh.statusCode).toBe(401);
  });
});


// ---------------------------------------------------------------------------
// [A-01] THE REFRESH COOKIE'S OWN GATE.
//
// The access-cookie gate is exercised above through /auth/me. The REFRESH
// cookie has a second, separate gate in `refreshCredentialOf`, and it was
// untested: mutations that made the refresh path accept a cookie WITHOUT the
// client header, or from an origin outside the allowlist, passed the whole
// suite. That is the CSRF boundary on the one credential that mints new
// sessions — a cross-site page that can spend the refresh cookie owns the
// account for as long as it keeps rotating.
// ---------------------------------------------------------------------------
describe('[A-01] the refresh cookie is spendable only by a named client from an allowed origin', () => {
  it('a refresh cookie WITHOUT the client header is refused, and counted', async () => {
    const { jar } = await browserLogin();
    const before = await count('cookie_rejected_header');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { origin: ORIGIN, cookie: cookieHeader(jar) },
    });
    // Refused either way: without the client header this is not a browser at
    // all, so it falls through to the native path and fails body validation.
    // What must hold is that the COOKIE was never spent, and it was counted.
    expect([400, 401]).toContain(res.statusCode);
    expect(await count('cookie_rejected_header')).toBeGreaterThan(before);
    // and the session is untouched — a refused refresh is not a logout
    const still = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(still.statusCode).toBe(200);
  });

  it('a refresh cookie from an origin OUTSIDE the allowlist is refused, and counted', async () => {
    const { jar } = await browserLogin();
    const before = await count('cookie_rejected_origin');
    const evil = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { 'x-swift-client': 'admin-web', origin: EVIL, cookie: cookieHeader(jar) },
    });
    expect(evil.statusCode).toBe(401);
    // …and with no origin at all, which is the shape a naive forged request takes
    const noOrigin = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { 'x-swift-client': 'admin-web', cookie: cookieHeader(jar) },
    });
    expect(noOrigin.statusCode).toBe(401);
    expect(await count('cookie_rejected_origin')).toBeGreaterThanOrEqual(before + 2);
    const still = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...BROWSER, cookie: cookieHeader(jar) } });
    expect(still.statusCode).toBe(200);
  });
});

describe('[A-01] the cookie is marked Secure where it travels over the network', () => {
  /** The Set-Cookie strings the API would send under a given environment. */
  const issued = (env: Record<string, string | undefined>): string[] => {
    let sent: string[] = [];
    const reply = { header: (_name: string, value: string[]) => { sent = value; } } as unknown as Parameters<typeof setSessionCookies>[0];
    setSessionCookies(reply, { accessToken: 'a.a.a', refreshToken: 'r.r.r' }, env);
    return sent;
  };

  it('production sets Secure; development does not, or nothing would work over http://localhost', () => {
    const prod = issued({ NODE_ENV: 'production' });
    for (const c of prod) {
      expect(c, c).toMatch(/;\s*Secure/);
      expect(c, c).toMatch(/HttpOnly/);
      expect(c, c).toMatch(/SameSite=Strict/);
    }
    const dev = issued({ NODE_ENV: 'development' });
    for (const c of dev) {
      expect(c, c).not.toMatch(/;\s*Secure/);
      // the properties that are not about transport still hold
      expect(c, c).toMatch(/HttpOnly/);
      expect(c, c).toMatch(/SameSite=Strict/);
    }
  });
});
