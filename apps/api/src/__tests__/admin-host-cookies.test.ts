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
import { loginWithOtp, requestOtp } from './helpers/otp';
import { resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { bindBrowseTenant } from '../modules/search/search-scope';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// The admin console's session cookies are bound to the API host.
//
// A plain-named cookie can be SET for the API host by any sibling subdomain
// (`Domain=.<site>`) and is also the web app's cookie on the same host: a
// session tossed into an admin's browser — or the web app's own session in the
// same browser — was sent to the admin console's requests as if the admin had
// signed in (session fixation / cross-app confusion). Over TLS the admin
// console's pair is now `__Host-` prefixed (Secure, Path=/, no Domain: a
// browser refuses any other Set-Cookie for that name, so only the API host
// itself can write it), and on an admin-console request ONLY that pair is a
// credential. The web app's cookies are unchanged; plain HTTP (local
// development, where a browser would drop a Secure cookie) keeps the plain pair.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const ORIGIN = 'https://admin.swift.example';
const WEB_ORIGIN = 'https://web.swift.example';
const RUN = nanoid(6).toLowerCase();
const adminPhone = testPhone();
const otherPhone = testPhone();
const userIds: string[] = [];
const TLS = { 'x-forwarded-proto': 'https' } as const;
const ADMIN = { 'x-swift-client': 'admin-web', origin: ORIGIN, ...TLS } as const;
const WEB = { 'x-swift-client': 'web', origin: WEB_ORIGIN, ...TLS } as const;

type Jar = Record<string, string>;
function setCookies(res: { headers: Record<string, unknown> }): string[] {
  return ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
}
function apply(jar: Jar, res: { headers: Record<string, unknown> }): string[] {
  const raw = setCookies(res);
  for (const line of raw) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const at = pair!.indexOf('=');
    const name = pair!.slice(0, at); const value = decodeURIComponent(pair!.slice(at + 1));
    const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
    if (maxAge && Number(maxAge.split('=')[1]) <= 0) delete jar[name]; else jar[name] = value;
  }
  return raw;
}
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
const line = (raw: string[], name: string) => raw.find((l) => l.startsWith(`${name}=`));

async function signIn(headers: Record<string, string>, phone = adminPhone) {
  const code = await requestOtp(app, phone);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers, payload: { phone, code } });
  expect(res.statusCode, res.body).toBe(200);
  const jar: Jar = {};
  return { jar, raw: apply(jar, res) };
}
/** Another account's live session, as a native client receives it (the credential an attacker would toss). */
async function otherSession(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await loginWithOtp(app, otherPhone);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.tokens;
}
const me = (headers: Record<string, string>, jar: Jar) =>
  app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...headers, cookie: cookieHeader(jar) } });

beforeAll(async () => {
  process.env['CORS_ORIGIN'] = `${ORIGIN},${WEB_ORIGIN},http://localhost:3001`;
  resetBrowserOriginsForTests();
  // trustProxy: the forwarded proto is the TLS edge's, as behind the production/staging proxy
  app = Fastify({ logger: false, trustProxy: true });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  // a browse surface (search, the category rail, the market) as the website and a signed-in customer both call it
  app.get('/browse-probe', { preHandler: bindBrowseTenant(app) }, async (request) => ({
    userId: (request as { user?: { userId?: string } }).user?.userId ?? null,
    guest: typeof request.publicTenantId === 'string',
  }));
  await app.ready();
  const admin = await app.prisma.user.create({ data: { phone: adminPhone, firstName: 'Host', lastName: `Admin${RUN}`, roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
  const other = await app.prisma.user.create({ data: { phone: otherPhone, firstName: 'Other', lastName: `Account${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(admin.id, other.id);
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-host-cookies');
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  await app.close();
});

describe('the admin console over TLS: its session is a __Host- pair', () => {
  it('sign-in issues __Host-swift_at and __Host-swift_rt: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain — and no plain-named session cookie', async () => {
    const { raw } = await signIn(ADMIN);
    for (const name of ['__Host-swift_at', '__Host-swift_rt']) {
      const l = line(raw, name);
      expect(l, name).toBeDefined();
      expect(l).toMatch(/; Path=\/;/);
      expect(l).toMatch(/; Secure(?:;|$)/);
      expect(l).toContain('HttpOnly');
      expect(l).toContain('SameSite=Strict');
      expect(l).not.toMatch(/domain=/i);
    }
    expect(line(raw, 'swift_at')).toBeUndefined();
    expect(line(raw, 'swift_rt')).toBeUndefined();
  });

  it('the __Host- access cookie authenticates the console; another account\'s plain swift_at tossed onto the host is not a credential — alone or beside the real one', async () => {
    const { jar } = await signIn(ADMIN);
    const ok = await me(ADMIN, jar);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.user.id).toBe(userIds[0]);
    const tossed = await otherSession();
    const alone = await me(ADMIN, { swift_at: tossed.accessToken });
    expect(alone.statusCode).toBe(401);
    // a tossed cookie with a longer path is sent FIRST by a browser: it must not displace the console's own
    const both = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...ADMIN, cookie: `swift_at=${tossed.accessToken}; ${cookieHeader(jar)}` } });
    expect(both.statusCode, both.body).toBe(200);
    expect(both.json().data.user.id).toBe(userIds[0]);
  });

  it('refresh rotates the __Host- pair from __Host-swift_rt; a plain swift_rt is not the console\'s refresh credential', async () => {
    const { jar } = await signIn(ADMIN);
    const before = { ...jar };
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...ADMIN, cookie: cookieHeader(jar), 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const raw = apply(jar, res);
    expect(line(raw, '__Host-swift_at')).toMatch(/; Path=\/;/);
    expect(line(raw, '__Host-swift_rt')).toMatch(/; Path=\/;/);
    expect(jar['__Host-swift_rt']).not.toBe(before['__Host-swift_rt']);
    expect((await me(ADMIN, jar)).statusCode).toBe(200);
    const tossed = await otherSession();
    const plain = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...ADMIN, cookie: `swift_rt=${tossed.refreshToken}`, 'content-type': 'application/json' }, payload: {} });
    expect(plain.statusCode).toBe(401);
    expect(setCookies(plain).some((l) => l.startsWith('__Host-swift_at=') && !/Max-Age=0/.test(l))).toBe(false);
  });

  it('sign-out deletes the __Host- pair AND any plain pair left from before, and the old cookies stop working', async () => {
    const { jar } = await signIn(ADMIN);
    const old = { ...jar };
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...ADMIN, cookie: cookieHeader(jar), 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const raw = setCookies(res);
    expect(line(raw, '__Host-swift_at')).toMatch(/Max-Age=0.*Path=\/|Path=\/;.*Max-Age=0/);
    expect(line(raw, '__Host-swift_rt')).toMatch(/Max-Age=0/);
    expect(line(raw, 'swift_at')).toMatch(/Max-Age=0/);
    expect(line(raw, 'swift_at')).toContain('Path=/api/v1;');
    expect(line(raw, 'swift_rt')).toMatch(/Max-Age=0/);
    expect(line(raw, 'swift_rt')).toContain('Path=/api/v1/auth;');
    expect((await me(ADMIN, old)).statusCode).toBe(401);
  });
});

describe('the browse gate reads only the pair that is this request\'s own', () => {
  const browse = (headers: Record<string, string>, cookie: string) =>
    app.inject({ method: 'GET', url: '/browse-probe', headers: { ...headers, cookie } });

  it('B1: the website\'s guest browse in a browser that also holds a console session is a guest — the console\'s __Host- pair is not the website\'s', async () => {
    const consoleSession = await signIn(ADMIN);
    const res = await browse(WEB, cookieHeader(consoleSession.jar));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ userId: null, guest: true });
  });

  it('B2: the console\'s own __Host- pair is a session on its browse requests; a plain pair there is not', async () => {
    const consoleSession = await signIn(ADMIN);
    const own = await browse(ADMIN, cookieHeader(consoleSession.jar));
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ userId: userIds[0], guest: false });
    const tossed = await otherSession();
    const plain = await browse(ADMIN, `swift_at=${tossed.accessToken}`);
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toEqual({ userId: null, guest: true });
  });

  it('B3: the website\'s own plain pair is still a session on its browse requests', async () => {
    const web = await signIn(WEB, otherPhone);
    const res = await browse(WEB, cookieHeader(web.jar));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ userId: userIds[1], guest: false });
  });
});

describe('everything else is unchanged', () => {
  it('the web app over TLS keeps its plain, path-scoped pair, and a __Host- cookie is not a web credential', async () => {
    const { jar, raw } = await signIn(WEB);
    expect(line(raw, 'swift_at')).toContain('Path=/api/v1;');
    expect(line(raw, 'swift_rt')).toContain('Path=/api/v1/auth;');
    expect(line(raw, '__Host-swift_at')).toBeUndefined();
    expect((await me(WEB, jar)).statusCode).toBe(200);
    const console = await signIn(ADMIN);
    expect((await me(WEB, { '__Host-swift_at': console.jar['__Host-swift_at']! })).statusCode).toBe(401);
  });

  it('the admin console over plain HTTP (local development) keeps the plain pair — a browser would drop a Secure cookie there', async () => {
    const local = { 'x-swift-client': 'admin-web', origin: 'http://localhost:3001' };
    const { jar, raw } = await signIn(local);
    expect(line(raw, 'swift_at')).toContain('Path=/api/v1;');
    expect(line(raw, '__Host-swift_at')).toBeUndefined();
    expect((await me(local, jar)).statusCode).toBe(200);
  });
});
