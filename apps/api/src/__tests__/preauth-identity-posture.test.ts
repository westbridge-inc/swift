/**
 * [L04 · R1 · OTA-016] Every sign-in surface works under production's CONTRACT
 * tenant posture — for a production account AND a store-review (REVIEW
 * tenant) account.
 *
 * The posture: the app's own client is a least-privilege login (NOBYPASSRLS,
 * not the table owner), audited system work runs on its own bypass-member
 * login, TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny. Authentication
 * reads the account before any tenant is known, and the users table is walled,
 * so every pre-auth read goes through ONE named system capability that answers
 * only {id, tenantId}; the tenant is bound before anything else is read or
 * written (modules/auth/preauth-identity.ts).
 *
 * Surfaces: OTP verify, registration, password login, password reset,
 * refresh, bearer and cookie authenticate, socket auth, logout and logout by
 * refresh credential. Each asserts the database effect through the suite's
 * own privileged connection (never the app's client).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { appRoleDdl } from '../lib/tenant-rls';
import { readRlsFacts } from '../lib/rls-attestation';
import { hashReviewCode } from '../modules/review/credentials';
import { storePasswordResetOtp, storeSignupOtp } from '../modules/auth/signup-continuation';
import { installDdl } from './helpers/install-ddl';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { getTenantContext } from '../plugins/tenant-context';

// [R048-001] this suite creates the NOLOGIN probe group and two LOGIN roles by raw DDL, as review-partner-strict-posture does.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>>;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REVIEW = `review-preauth-${RUN}`;
const PRODUCTION = 'swift-default';
const WEB_ORIGIN = 'http://localhost:3001';
const PASSWORD = 'correct horse battery';
const REVIEW_CODE = '864213';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'CORS_ORIGIN', 'SOCKET_AUTH_RECHECK_MS'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const PHONE_BASE = 9000 + Math.floor(Math.random() * 900);
let phoneSeq = 0;
const nextPhone = () => `+592000${String(PHONE_BASE + phoneSeq++).padStart(4, '0')}`.slice(0, 11);

type Tenant = 'PRODUCTION' | 'REVIEW';
const TENANTS: Tenant[] = ['PRODUCTION', 'REVIEW'];
const tenantIdOf = (t: Tenant) => (t === 'PRODUCTION' ? PRODUCTION : REVIEW);

let owner: PrismaClient;
let app: FastifyInstance;
let url = '';
let prismaModule: typeof import('../plugins/prisma') | null = null;
let passwordHash = '';
const userIds: string[] = [];
const phones: string[] = [];
const credentialIds: string[] = [];
const sockets: Socket[] = [];

async function account(tenant: Tenant, opts: { password?: boolean; reviewCredential?: boolean } = {}) {
  const phone = nextPhone();
  phones.push(phone);
  const user = await owner.user.create({ data: {
    phone, firstName: 'Pre', lastName: `Auth ${tenant}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    tenantId: tenantIdOf(tenant), isPhoneVerified: true, status: 'ACTIVE',
    ...(opts.password ? { passwordHash } : {}),
  } as never });
  userIds.push(user.id);
  if (opts.reviewCredential) {
    const id = `rc-${RUN}-${phoneSeq}`;
    credentialIds.push(id);
    await owner.reviewCredential.create({ data: { id, tenantId: REVIEW, role: 'CUSTOMER', identifier: phone, staticOtpHash: hashReviewCode(id, REVIEW_CODE) } as never });
  }
  return { id: user.id, phone };
}

/** A live session minted the way sign-in mints one, written by the suite's own connection. */
async function session(userId: string) {
  const token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  const refreshToken = nanoid(64);
  const row = await owner.session.create({ data: {
    userId, token, refreshToken, authMethod: 'OTP', deviceId: `preauth-${RUN}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return { id: row.id, token, refreshToken };
}

const sessionsOf = (userId: string) => owner.session.count({ where: { userId } });
const post = (path: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/auth${path}`, payload, headers });

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('socket never became ready')), 7_500);
    socket.once('auth:ready', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  owner = new PrismaClient({ datasourceUrl: TEST_URL });
  await installDdl(owner, appRoleDdl());
  logins = await createTenantProbeLogins(owner, TEST_URL);
  // The store-review fiction, as provision leaves it: a REVIEW tenant with a live review session.
  await owner.tenant.create({ data: { id: REVIEW, name: 'Pre-auth posture fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
  await owner.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + 86_400_000) } });

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['CORS_ORIGIN', 'SOCKET_AUTH_RECHECK_MS'] = WEB_ORIGIN;
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const { prismaPlugin } = prismaModule;
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { authRoutes } = await import('../modules/auth/auth.routes');
  const { resetBrowserOriginsForTests } = await import('../modules/auth/browser-session');
  resetBrowserOriginsForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  for (const phone of phones) {
    await app?.redis.del(`otp_rate:${phone}`, `otp_hr:${phone}`, `review_otp:${phone}`, `review_otp_fail:${phone}`).catch(() => {});
  }
  await app?.close();
  await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
  prismaModule?.setSystemPrismaClient(null);
  for (const k of ENV_KEYS) {
    if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
  }
  const { resetBrowserOriginsForTests } = await import('../modules/auth/browser-session');
  resetBrowserOriginsForTests();
  const created = await owner.user.findMany({ where: { phone: { in: phones } }, select: { id: true } });
  const all = [...new Set([...userIds, ...created.map((u) => u.id)])];
  await owner.session.deleteMany({ where: { userId: { in: all } } });
  await owner.reviewCredential.deleteMany({ where: { id: { in: credentialIds } } });
  await owner.customer.deleteMany({ where: { userId: { in: all } } });
  await owner.user.deleteMany({ where: { id: { in: all } } });
  await owner.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
  await owner.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
  await owner.tenant.deleteMany({ where: { id: REVIEW } });
  await logins?.cleanup();
  await owner.$disconnect();
});

describe('[L04 · R1 · OTA-016] sign-in under the production CONTRACT posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('the DATABASE wall holds through the app’s own client: a raw read of a review account sees it only when bound to review', async () => {
    const reviewer = await account('REVIEW');
    const { runWithTenant } = await import('../plugins/tenant-context');
    const { bindTenantTransaction } = prismaModule!;
    // Raw SQL carries no application filter: only the row-level policy decides.
    const rawRead = () => app.prisma.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      return (await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "users" WHERE "id" = ${reviewer.id}`).length;
    });
    expect(await rawRead()).toBe(0); // unbound: nothing
    expect(await runWithTenant(PRODUCTION, rawRead)).toBe(0); // a production caller: nothing
    expect(await runWithTenant(REVIEW, rawRead)).toBe(1); // its own tenant: the row
  });

  it.each(TENANTS)('%s: OTP verify signs the account in — 200, tokens, exactly one new session', async (tenant) => {
    const who = await account(tenant, { reviewCredential: tenant === 'REVIEW' });
    let code = '246813';
    if (tenant === 'REVIEW') {
      const sent = await post('/send-otp', { phone: who.phone });
      expect(sent.statusCode, sent.body).toBe(200);
      code = REVIEW_CODE;
    } else {
      await storeSignupOtp(app.redis, who.phone, code);
    }
    const res = await post('/verify-otp', { phone: who.phone, code });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.isNewUser).toBe(false);
    expect(data.user.id).toBe(who.id);
    expect(typeof data.tokens.accessToken).toBe('string');
    expect(await sessionsOf(who.id)).toBe(1);
  });

  it('PRODUCTION: a new number registers into the production tenant and gets a session', async () => {
    const phone = nextPhone();
    phones.push(phone);
    await storeSignupOtp(app.redis, phone, '135792');
    const verified = await post('/verify-otp', { phone, code: '135792' });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.isNewUser).toBe(true);
    const registered = await post('/register', {
      phone, firstName: 'New', lastName: 'Signup', acceptTerms: true, registrationProof: verified.json().data.registrationProof,
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const created = await owner.user.findUniqueOrThrow({ where: { phone }, select: { id: true, tenantId: true } });
    expect(created.tenantId).toBe(PRODUCTION);
    expect(await sessionsOf(created.id)).toBe(1);
  });

  it.each(TENANTS)('%s: password login — 200, tokens, exactly one new session', async (tenant) => {
    const who = await account(tenant, { password: true });
    const res = await post('/password/login', { phone: who.phone, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(typeof res.json().data.tokens.accessToken).toBe('string');
    expect(await sessionsOf(who.id)).toBe(1);
  });

  it('PRODUCTION: password reset — the credential changes and every session ends', async () => {
    const who = await account('PRODUCTION', { password: true });
    await session(who.id);
    await storePasswordResetOtp(app.redis, who.phone, '975311');
    const res = await post('/password/reset', { phone: who.phone, code: '975311', newPassword: 'a brand new password' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await owner.user.findUniqueOrThrow({ where: { id: who.id }, select: { passwordHash: true } });
    expect(after.passwordHash).not.toBe(passwordHash);
    expect(await sessionsOf(who.id)).toBe(0);
  });

  it.each([false, true])('REVIEW: reset refuses a valid planted OTP (review credential: %s)', async (reviewCredential) => {
    const who = await account('REVIEW', { password: true, reviewCredential });
    const existing = await session(who.id);
    await storePasswordResetOtp(app.redis, who.phone, '975311');
    const res = await post('/password/reset', { phone: who.phone, code: '975311', newPassword: 'a brand new password' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_OTP');
    expect((await owner.user.findUniqueOrThrow({ where: { id: who.id } })).passwordHash).toBe(passwordHash);
    expect(await sessionsOf(who.id)).toBe(1);
    expect((await owner.session.findUniqueOrThrow({ where: { id: existing.id } })).token).toBe(existing.token);
  });

  it.each(TENANTS)('%s: refresh rotates the session’s tokens', async (tenant) => {
    const who = await account(tenant);
    const s = await session(who.id);
    const res = await post('/refresh', { refreshToken: s.refreshToken });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.refreshToken).not.toBe(s.refreshToken);
    const row = await owner.session.findUniqueOrThrow({ where: { id: s.id }, select: { refreshToken: true, previousRefreshToken: true } });
    expect(row.previousRefreshToken).toBe(s.refreshToken);
  });

  it.each(TENANTS)('%s: a bearer request and a browser-cookie request are both authenticated as the account', async (tenant) => {
    const who = await account(tenant);
    const s = await session(who.id);
    const bearer = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${s.token}` } });
    expect(bearer.statusCode, bearer.body).toBe(200);
    expect(bearer.json().data.user.id).toBe(who.id);
    const cookie = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-swift-client': 'web', origin: WEB_ORIGIN, cookie: `swift_at=${s.token}` } });
    expect(cookie.statusCode, cookie.body).toBe(200);
    expect(cookie.json().data.user.id).toBe(who.id);
    expect(cookie.json().data.user.tenant.kind).toBe(tenant);
  });

  it.each(TENANTS)('%s: a socket connects and is authorized as the account', async (tenant) => {
    const who = await account(tenant);
    const s = await session(who.id);
    const socket = await connect(s.token);
    expect(socket.connected).toBe(true);
  });

  it('socket rechecks serialize tenant reads when only one pool slot is available', async () => {
    for (const socket of sockets) socket.disconnect();
    const production = await session((await account('PRODUCTION')).id);
    const review = await session((await account('REVIEW')).id);
    const a = await connect(production.token);
    const b = await connect(review.token);
    const transaction = app.prisma.$transaction.bind(app.prisma);
    let active = 0;
    let peak = 0;
    const completed = new Set<string>();
    const spy = vi.spyOn(app.prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
      const tenantId = getTenantContext()?.tenantId;
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (active > 1) throw new Error('single-slot pool acquisition timed out');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = await (transaction as (...args: unknown[]) => Promise<unknown>)(...args);
        if (tenantId) completed.add(tenantId);
        return result;
      } finally { active -= 1; }
    }) as typeof app.prisma.$transaction);
    try {
      await vi.waitFor(() => expect([...completed].sort()).toEqual([PRODUCTION, REVIEW].sort()), { timeout: 5000 });
      expect(peak).toBe(1);
      expect([a.connected, b.connected]).toEqual([true, true]);
    } finally { spy.mockRestore(); a.disconnect(); b.disconnect(); }
  });

  it('a failed tenant recheck closes only that tenant and still checks healthy tenants', async () => {
    for (const socket of sockets) socket.disconnect();
    const review = await session((await account('REVIEW')).id);
    const production = await session((await account('PRODUCTION')).id);
    const a = await connect(review.token);
    const b = await connect(production.token);
    const transaction = app.prisma.$transaction.bind(app.prisma);
    let healthyReads = 0;
    let reason: string | undefined;
    a.once('disconnect', (value) => { reason = value; });
    const spy = vi.spyOn(app.prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if (getTenantContext()?.tenantId === REVIEW) throw new Error('tenant authority temporarily unavailable');
      const result = await (transaction as (...args: unknown[]) => Promise<unknown>)(...args);
      healthyReads += 1;
      return result;
    }) as typeof app.prisma.$transaction);
    try {
      await vi.waitFor(() => { expect(a.connected).toBe(false); expect(healthyReads).toBeGreaterThan(0); });
      expect(reason).not.toBe('io server disconnect');
      expect(b.connected).toBe(true);
    } finally { spy.mockRestore(); a.disconnect(); b.disconnect(); }
  });

  it.each(TENANTS)('%s: logout ends this session', async (tenant) => {
    const who = await account(tenant);
    const s = await session(who.id);
    const res = await post('/logout', {}, { authorization: `Bearer ${s.token}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(await sessionsOf(who.id)).toBe(0);
  });

  it.each(TENANTS)('%s: logout by refresh credential ends the session', async (tenant) => {
    const who = await account(tenant);
    const s = await session(who.id);
    const res = await post('/logout/refresh', { refreshToken: s.refreshToken });
    expect(res.statusCode, res.body).toBe(200);
    expect(await sessionsOf(who.id)).toBe(0);
  });
});
