import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { prismaPlugin, runWithoutTenant, setSystemPrismaClient } from '../plugins/prisma';
import { runAsSystem } from '../plugins/tenant-context';
import { tenantBindCounter } from '../plugins/observability';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { ACCESS_COOKIE, REFRESH_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { SESSION_CREDENTIAL_DIGEST_RE, sessionCredentialDigest } from '../lib/session-credential';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { loginWithOtp, requestOtp, requestPasswordResetOtp } from './helpers/otp';
import { grantStepUp } from './helpers/step-up';
import { testPhone } from './helpers/fixture-ids';

// The migration test replays the migration against a session-scoped TEMP copy of the table (raw DDL).
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [Row 231 · FABLE-AUTH-1 / DS108] Session credentials at rest are digests.
//
// A row of `sessions` used to BE a login: the bearer access token and both
// refresh tokens sat in plaintext, so one database read (a backup, a replica,
// an injection, an operator's psql) yielded every live session. Every path
// that mints, rotates or resolves a session — OTP, password, the browser's
// cookie pair, refresh, the race-grace replay, logout by refresh credential,
// the socket — now stores and compares only SHA-256 digests; the plaintext the
// client holds keeps working unchanged (old phone builds included); the
// database refuses a plaintext write from ANY path; and nothing a database
// read returns is a credential.
// ---------------------------------------------------------------------------

const MIGRATION = 'prisma/migrations/20261018190000_session_credential_digests/migration.sql';
const ORIGIN = 'http://localhost:3001';
const PASSWORD = 'digest-at-rest-passphrase';
const BROWSER = { 'x-swift-client': 'admin-web', origin: ORIGIN } as const;
const PHONE_A = testPhone();
const PHONE_B = testPhone();
const PHONE_ADMIN = testPhone();

let app: FastifyInstance;
let url = '';
const openSockets: Socket[] = [];
const userIds: string[] = [];
const ids: Record<'A' | 'B' | 'ADMIN', string> = { A: '', B: '', ADMIN: '' };

function inject(method: 'GET' | 'POST', path: string, payload?: unknown, token?: string, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

async function tokensOf(phone: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await loginWithOtp(app, phone);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.tokens;
}

/** The row behind a session id, read RAW — exactly what a database read (backup, replica, psql) yields. */
async function rawRow(sessionId: string) {
  const rows = await app.prisma.$queryRaw<Array<{ token: string; refreshToken: string; previousRefreshToken: string | null }>>`
    SELECT "token", "refreshToken", "previousRefreshToken" FROM "sessions" WHERE "id" = ${sessionId}
  `;
  return rows[0];
}

/** The id of the session an access token belongs to, looked up exactly as the auth plugin looks it up. */
async function sessionIdOf(accessToken: string): Promise<string> {
  const row = await app.prisma.session.findUniqueOrThrow({ where: { token: accessToken }, select: { id: true } });
  return row.id;
}

/** How many rows hold this exact value in ANY credential column — the plaintext must be in none. */
async function rowsHoldingPlaintext(value: string): Promise<number> {
  const rows = await app.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "sessions"
    WHERE "token" = ${value} OR "refreshToken" = ${value} OR "previousRefreshToken" = ${value}
  `;
  return rows[0]?.n ?? -1;
}

function cookieValues(res: { headers: Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? [])) {
    const pair = line.split(';')[0]!;
    const at = pair.indexOf('=');
    out[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
  }
  return out;
}

/** A socket handshake with this access token: 'ready' once the post-connect authority read accepted it. */
function socketVerdict(token: string): Promise<'ready' | string> {
  return new Promise((resolve) => {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
    openSockets.push(socket);
    const timer = setTimeout(() => resolve('timeout'), 7_500);
    let settled = false;
    const done = (verdict: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(verdict);
      socket.disconnect();
    };
    socket.on('auth:ready', () => done('ready'));
    socket.on('connect_error', (error) => done(`refused: ${error.message}`));
    socket.on('disconnect', (reason) => done(`disconnected: ${reason}`));
  });
}

beforeAll(async () => {
  process.env['CORS_ORIGIN'] = ORIGIN;
  resetBrowserOriginsForTests();

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const mk = (phone: string, admin: boolean) => app.prisma.user.create({
    data: {
      phone, firstName: 'Digest', lastName: `Rest${nanoid(4)}`, isPhoneVerified: true, status: 'ACTIVE',
      roles: admin ? ['ADMIN', 'CUSTOMER'] : ['CUSTOMER'], activeRole: admin ? 'ADMIN' : 'CUSTOMER',
      customer: { create: {} },
      ...(admin && { admin: { create: { permissions: ['*'] } } }),
    },
    select: { id: true },
  });
  ids.A = (await mk(PHONE_A, false)).id;
  ids.B = (await mk(PHONE_B, false)).id;
  ids.ADMIN = (await mk(PHONE_ADMIN, true)).id;
  userIds.push(ids.A, ids.B, ids.ADMIN);
});

afterAll(async () => {
  for (const socket of openSockets) socket.disconnect();
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:session-credential-digest');
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  await app.close();
});

describe('[Row 231] a session row holds digests, never the credential', () => {
  it('OTP login: the row is the SHA-256 of each token, the plaintext is in no column, and the plaintext still authenticates', async () => {
    const { accessToken, refreshToken } = await tokensOf(PHONE_A);
    const id = await sessionIdOf(accessToken);
    const row = await rawRow(id);
    expect(row?.token).toBe(sessionCredentialDigest(accessToken));
    expect(row?.refreshToken).toBe(sessionCredentialDigest(refreshToken));
    expect(row?.token).toMatch(SESSION_CREDENTIAL_DIGEST_RE);
    expect(row?.refreshToken).toMatch(SESSION_CREDENTIAL_DIGEST_RE);
    expect(await rowsHoldingPlaintext(accessToken)).toBe(0);
    expect(await rowsHoldingPlaintext(refreshToken)).toBe(0);
    expect((await inject('GET', '/api/v1/auth/me', undefined, accessToken)).statusCode).toBe(200);
  });

  it('nothing a database read returns is a credential: the stored values neither authenticate nor refresh', async () => {
    const first = await tokensOf(PHONE_A);
    const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(rotate.statusCode, rotate.body).toBe(200);
    const live = rotate.json().data as { accessToken: string; refreshToken: string };
    const row = await rawRow(await sessionIdOf(live.accessToken));
    expect(row?.previousRefreshToken).toBeTruthy();
    // the stolen row, presented every way a client can present a credential
    expect((await inject('GET', '/api/v1/auth/me', undefined, row!.token)).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/auth/me', undefined, undefined, { ...BROWSER, cookie: `${ACCESS_COOKIE}=${row!.token}` })).statusCode).toBe(401);
    for (const stolen of [row!.refreshToken, row!.previousRefreshToken!]) {
      expect((await inject('POST', '/api/v1/auth/refresh', { refreshToken: stolen })).statusCode).toBe(401);
    }
    expect(await socketVerdict(row!.token)).not.toBe('ready');
    // …and the session the row belongs to is untouched: the real holder carries on
    expect((await inject('GET', '/api/v1/auth/me', undefined, live.accessToken)).statusCode).toBe(200);
    expect((await inject('POST', '/api/v1/auth/refresh', { refreshToken: live.refreshToken })).statusCode).toBe(200);
  });

  it('password login: the same digests at rest', async () => {
    const otp = await tokensOf(PHONE_A);
    await grantStepUp(app, otp.accessToken);
    const set = await inject('POST', '/api/v1/auth/password/set', { password: PASSWORD }, otp.accessToken);
    expect(set.statusCode, set.body).toBe(200);

    const login = await inject('POST', '/api/v1/auth/password/login', { phone: PHONE_A, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
    const { accessToken, refreshToken } = login.json().data.tokens;
    const row = await rawRow(await sessionIdOf(accessToken));
    expect(row?.token).toBe(sessionCredentialDigest(accessToken));
    expect(row?.refreshToken).toBe(sessionCredentialDigest(refreshToken));
    expect(await rowsHoldingPlaintext(accessToken)).toBe(0);
    expect(await rowsHoldingPlaintext(refreshToken)).toBe(0);
    expect((await inject('GET', '/api/v1/auth/me', undefined, accessToken)).statusCode).toBe(200);
  });

  it('password/set ends the other sessions and re-keys this one: the new pair is digested too', async () => {
    const other = await tokensOf(PHONE_A);
    const mine = await tokensOf(PHONE_A);
    await grantStepUp(app, mine.accessToken);
    const set = await inject('POST', '/api/v1/auth/password/set', { password: `${PASSWORD}-2` }, mine.accessToken);
    expect(set.statusCode, set.body).toBe(200);
    const next = set.json().data.tokens as { accessToken: string; refreshToken: string } | undefined;
    expect(next).toBeDefined();
    const row = await rawRow(await sessionIdOf(next!.accessToken));
    expect(row?.token).toBe(sessionCredentialDigest(next!.accessToken));
    expect(row?.refreshToken).toBe(sessionCredentialDigest(next!.refreshToken));
    expect(row?.previousRefreshToken).toBeNull();
    expect(await rowsHoldingPlaintext(next!.accessToken)).toBe(0);
    expect(await rowsHoldingPlaintext(next!.refreshToken)).toBe(0);
    expect((await inject('GET', '/api/v1/auth/me', undefined, next!.accessToken)).statusCode).toBe(200);
    expect((await inject('GET', '/api/v1/auth/me', undefined, other.accessToken)).statusCode).toBe(401);
  });

  it('the browser session: the cookie values are digested at rest and the cookie still signs in', async () => {
    const code = await requestOtp(app, PHONE_ADMIN);
    const res = await inject('POST', '/api/v1/auth/verify-otp', { phone: PHONE_ADMIN, code }, undefined, BROWSER);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.tokens).toBeUndefined();
    const jar = cookieValues(res);
    const access = jar[ACCESS_COOKIE]!;
    const refresh = jar[REFRESH_COOKIE]!;
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();

    const row = await rawRow(await sessionIdOf(access));
    expect(row?.token).toBe(sessionCredentialDigest(access));
    expect(row?.refreshToken).toBe(sessionCredentialDigest(refresh));
    expect(await rowsHoldingPlaintext(access)).toBe(0);
    expect(await rowsHoldingPlaintext(refresh)).toBe(0);

    const me = await inject('GET', '/api/v1/auth/me', undefined, undefined, { ...BROWSER, cookie: `${ACCESS_COOKIE}=${encodeURIComponent(access)}` });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(ids.ADMIN);
  });

  it('refresh: the rotated pair is digested and previousRefreshToken is the digest of the credential it replaced', async () => {
    const first = await tokensOf(PHONE_B);
    const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(rotate.statusCode, rotate.body).toBe(200);
    const next = rotate.json().data as { accessToken: string; refreshToken: string };
    const row = await rawRow(await sessionIdOf(next.accessToken));
    expect(row?.token).toBe(sessionCredentialDigest(next.accessToken));
    expect(row?.refreshToken).toBe(sessionCredentialDigest(next.refreshToken));
    expect(row?.previousRefreshToken).toBe(sessionCredentialDigest(first.refreshToken));
    for (const value of [first.accessToken, first.refreshToken, next.accessToken, next.refreshToken]) {
      expect(await rowsHoldingPlaintext(value)).toBe(0);
    }
    expect((await inject('GET', '/api/v1/auth/me', undefined, first.accessToken)).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/auth/me', undefined, next.accessToken)).statusCode).toBe(200);
  });

  it('the socket handshake and its post-connect authority read accept the plaintext the client holds', async () => {
    const { accessToken } = await tokensOf(PHONE_B);
    expect(await socketVerdict(accessToken)).toBe('ready');
  });
});

describe('[Row 231] the race-grace replay never answers with a stored credential', () => {
  it('a replay inside the grace window is not theft: it is answered with a FRESH pair and the session lives on', async () => {
    // Only digests are stored, so the pair that answered the first call cannot
    // be handed out again (that was the old answer: the row's own plaintext).
    // The replay mints a fresh generation; the first answer's pair is
    // superseded (401), never revoked; the chain (previousRefreshToken,
    // rotatedAt) stays where the first rotation put it.
    const first = await tokensOf(PHONE_B);
    const id = await sessionIdOf(first.accessToken);
    const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(rotate.statusCode, rotate.body).toBe(200);
    const answered = rotate.json().data as { accessToken: string; refreshToken: string };
    const rotatedAt = (await app.prisma.session.findUniqueOrThrow({ where: { id }, select: { rotatedAt: true } })).rotatedAt;

    const replay = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(replay.statusCode, replay.body).toBe(200);
    const fresh = replay.json().data as { accessToken: string; refreshToken: string; expiresIn: number };
    expect(fresh.expiresIn).toBe(900);
    expect(fresh.refreshToken).not.toBe(answered.refreshToken);
    expect(fresh.accessToken).not.toBe(answered.accessToken);

    const row = await rawRow(id);
    expect(row?.token).toBe(sessionCredentialDigest(fresh.accessToken));
    expect(row?.refreshToken).toBe(sessionCredentialDigest(fresh.refreshToken));
    expect(row?.previousRefreshToken).toBe(sessionCredentialDigest(first.refreshToken));
    expect((await app.prisma.session.findUniqueOrThrow({ where: { id }, select: { rotatedAt: true } })).rotatedAt).toEqual(rotatedAt);
    for (const value of [answered.accessToken, answered.refreshToken, fresh.accessToken, fresh.refreshToken]) {
      expect(await rowsHoldingPlaintext(value)).toBe(0);
    }
    expect((await inject('GET', '/api/v1/auth/me', undefined, fresh.accessToken)).statusCode).toBe(200);
    expect((await inject('GET', '/api/v1/auth/me', undefined, answered.accessToken)).statusCode).toBe(401);
    // superseded, not theft: the session survives and the current generation keeps rotating
    expect(await app.prisma.session.findUnique({ where: { id } })).not.toBeNull();
    const onward = await inject('POST', '/api/v1/auth/refresh', { refreshToken: fresh.refreshToken });
    expect(onward.statusCode, onward.body).toBe(200);
  });

  it('two refreshes racing on the same credential both succeed, and exactly one answer is the live session', async () => {
    const first = await tokensOf(PHONE_B);
    const id = await sessionIdOf(first.accessToken);
    const [a, b] = await Promise.all([
      inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken }),
      inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken }),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    const pairs = [a.json().data, b.json().data] as Array<{ accessToken: string; refreshToken: string }>;
    const row = await rawRow(id);
    const live = pairs.filter((p) => sessionCredentialDigest(p.accessToken) === row?.token);
    expect(live).toHaveLength(1);
    expect(row?.refreshToken).toBe(sessionCredentialDigest(live[0]!.refreshToken));
    expect(row?.previousRefreshToken).toBe(sessionCredentialDigest(first.refreshToken));
  });

  it('a grace replay cannot extend its own grace: the same credential after the window is still theft', async () => {
    // rotatedAt is left where the FIRST rotation put it, so a replay answered
    // inside the window does not restart the clock; a thief who keeps replaying
    // is caught the moment the original window closes and the family is revoked.
    const previousGrace = process.env['REFRESH_REUSE_GRACE_MS'];
    process.env['REFRESH_REUSE_GRACE_MS'] = '600';
    try {
      const first = await tokensOf(PHONE_B);
      const id = await sessionIdOf(first.accessToken);
      const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
      expect(rotate.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 400));
      const graced = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
      expect(graced.statusCode, graced.body).toBe(200);
      await new Promise((r) => setTimeout(r, 400));
      // 800 ms after the first rotation, 400 ms after the graced replay: outside the ORIGINAL window
      const theft = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
      expect(theft.statusCode).toBe(401);
      expect(await app.prisma.session.findUnique({ where: { id } })).toBeNull();
      const live = graced.json().data as { accessToken: string };
      expect((await inject('GET', '/api/v1/auth/me', undefined, live.accessToken)).statusCode).toBe(401);
    } finally {
      if (previousGrace === undefined) delete process.env['REFRESH_REUSE_GRACE_MS'];
      else process.env['REFRESH_REUSE_GRACE_MS'] = previousGrace;
    }
  });
});

describe('[Row 231] every revocation path resolves the row through its digest', () => {
  it('logout by refresh credential: the current AND the immediately-previous credential', async () => {
    const current = await tokensOf(PHONE_B);
    const byCurrent = await inject('POST', '/api/v1/auth/logout/refresh', { refreshToken: current.refreshToken });
    expect(byCurrent.statusCode, byCurrent.body).toBe(200);
    expect(await app.prisma.session.findUnique({ where: { token: current.accessToken } })).toBeNull();
    expect((await inject('GET', '/api/v1/auth/me', undefined, current.accessToken)).statusCode).toBe(401);

    const first = await tokensOf(PHONE_B);
    const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(rotate.statusCode).toBe(200);
    const next = rotate.json().data as { accessToken: string };
    const byPrevious = await inject('POST', '/api/v1/auth/logout/refresh', { refreshToken: first.refreshToken });
    expect(byPrevious.statusCode, byPrevious.body).toBe(200);
    expect(await app.prisma.session.findUnique({ where: { token: next.accessToken } })).toBeNull();
    expect((await inject('GET', '/api/v1/auth/me', undefined, next.accessToken)).statusCode).toBe(401);
  });

  it('logout by refresh credential refuses a stored digest presented as the credential', async () => {
    const live = await tokensOf(PHONE_B);
    const id = await sessionIdOf(live.accessToken);
    const row = await rawRow(id);
    await inject('POST', '/api/v1/auth/logout/refresh', { refreshToken: row!.refreshToken });
    expect(await app.prisma.session.findUnique({ where: { id } })).not.toBeNull();
    expect((await inject('GET', '/api/v1/auth/me', undefined, live.accessToken)).statusCode).toBe(200);
  });

  it('password reset (logout everywhere) leaves no row for the account, digests included', async () => {
    const one = await tokensOf(PHONE_B);
    await tokensOf(PHONE_B);
    expect(await app.prisma.session.count({ where: { userId: ids.B } })).toBeGreaterThanOrEqual(2);
    const code = await requestPasswordResetOtp(app, PHONE_B);
    const res = await inject('POST', '/api/v1/auth/password/reset', { phone: PHONE_B, code, newPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(await app.prisma.session.count({ where: { userId: ids.B } })).toBe(0);
    expect((await inject('GET', '/api/v1/auth/me', undefined, one.accessToken)).statusCode).toBe(401);
  });
});

describe('[Row 231] a session query the tenant layers re-issue on the system connection is digested exactly once', () => {
  // With the wall bound (TENANT_RLS_BIND=1) and a system connection, system
  // work on a model without a tenant is re-issued on that connection
  // (plugins/prisma.ts onSystemClient). Both clients carry the digest layer
  // INNERMOST, so the re-issued query still holds the caller's plaintext and is
  // digested once, by the connection that runs it. Installed any higher, it
  // would be digested twice and match nothing.
  const reissued = async () => (await tenantBindCounter.get()).values.find((v) => v.labels['kind'] === 'nontenant_system')?.value ?? 0;

  it('a system-mode lookup by the plaintext access token finds its row on the system connection', async () => {
    const { accessToken } = await tokensOf(PHONE_A);
    const priorBind = process.env['TENANT_RLS_BIND'];
    const priorSystemUrl = process.env['SYSTEM_DATABASE_URL'];
    const system = testPrismaClient();
    setSystemPrismaClient(system);
    // the routing asks for a system connection only when one is configured
    process.env['SYSTEM_DATABASE_URL'] = process.env['DATABASE_URL'];
    process.env['TENANT_RLS_BIND'] = '1';
    try {
      const before = await reissued();
      const row = await runAsSystem('test:session-digest-reissue', () => app.prisma.session.findUnique({ where: { token: accessToken }, select: { userId: true } }));
      expect(await reissued()).toBe(before + 1); // it really ran on the system connection
      expect(row?.userId).toBe(ids.A);
    } finally {
      if (priorBind === undefined) delete process.env['TENANT_RLS_BIND']; else process.env['TENANT_RLS_BIND'] = priorBind;
      if (priorSystemUrl === undefined) delete process.env['SYSTEM_DATABASE_URL']; else process.env['SYSTEM_DATABASE_URL'] = priorSystemUrl;
      setSystemPrismaClient(null);
      await system.$disconnect();
    }
  });
});

describe('[Row 231] plaintext cannot be stored from any path', () => {
  const insert = (token: string, refreshToken: string) => app.prisma.$executeRaw`
    INSERT INTO "sessions" ("id", "userId", "token", "refreshToken", "authMethod", "deviceId", "deviceType", "expiresAt", "createdAt")
    VALUES (${`digest-${nanoid(12)}`}, ${ids.A}, ${token}, ${refreshToken}, 'OTP'::"SessionAuthMethod", 'digest-test', 'test', now() + interval '1 hour', now())
  `;

  it('the database refuses a plaintext access token, a plaintext refresh token, and a plaintext previous credential', async () => {
    const jwt = app.jwt.sign({ userId: ids.A, role: 'CUSTOMER', jti: nanoid(8) });
    await expect(insert(jwt, sessionCredentialDigest(nanoid(64)))).rejects.toThrow(/sessions_token_digest_check/);
    await expect(insert(sessionCredentialDigest(jwt), nanoid(64))).rejects.toThrow(/sessions_refreshToken_digest_check/);
    await expect(app.prisma.$executeRaw`
      UPDATE "sessions" SET "previousRefreshToken" = ${nanoid(64)} WHERE "userId" = ${ids.A}
    `).rejects.toThrow(/sessions_previousRefreshToken_digest_check/);
  });

  it('the constraint is the SHAPE of a digest, not a blanket refusal: a digest-shaped raw write is accepted', async () => {
    const jwt = app.jwt.sign({ userId: ids.A, role: 'CUSTOMER', jti: nanoid(8) });
    await expect(insert(sessionCredentialDigest(jwt), sessionCredentialDigest(nanoid(64)))).resolves.toBe(1);
    // …and that row is exactly what the auth plugin finds for the plaintext
    expect((await inject('GET', '/api/v1/auth/me', undefined, jwt)).statusCode).toBe(200);
  });

  it('the storage boundary refuses an empty credential and a non-equality credential filter', async () => {
    await expect(app.prisma.session.create({
      data: { userId: ids.A, token: '', refreshToken: nanoid(64), deviceId: 'digest-test', deviceType: 'test', expiresAt: new Date(Date.now() + 60_000) },
    })).rejects.toThrow(/empty credential/);
    await expect(app.prisma.session.findFirst({ where: { token: { startsWith: 'eyJ' } } })).rejects.toThrow(/equality/);
    await expect(app.prisma.session.findMany({ where: { OR: [{ refreshToken: { contains: 'a' } }] } })).rejects.toThrow(/equality/);
  });

  it('the three CHECK constraints are live on this database', async () => {
    const rows = await app.prisma.$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = '"sessions"'::regclass AND contype = 'c' AND conname LIKE 'sessions\\_%\\_digest\\_check'
      ORDER BY conname
    `;
    expect(rows.map((r) => r.conname)).toEqual([
      'sessions_previousRefreshToken_digest_check',
      'sessions_refreshToken_digest_check',
      'sessions_token_digest_check',
    ]);
    for (const r of rows) expect(r.def).toContain(SESSION_CREDENTIAL_DIGEST_RE.source);
  });
});

describe('[Row 231] the migration hashes live rows in place (nobody is signed out)', () => {
  const sql = () => readFileSync(join(process.cwd(), MIGRATION), 'utf8');

  it('replayed on a copy of the table: a plaintext row becomes its digests, a NULL previous stays NULL, an already-digested row is left alone, then the shape is enforced', async () => {
    const legacy = { token: `eyJ.${nanoid(40)}.sig`, refreshToken: nanoid(64), previous: nanoid(64) };
    const fresh = { token: `eyJ.${nanoid(40)}.sig`, refreshToken: nanoid(64) };
    const done = { token: sessionCredentialDigest('already'), refreshToken: sessionCredentialDigest('already-r') };
    // The statements run inside one transaction against a TEMP "sessions" (pg_temp is searched first),
    // so the live table is never touched; the transaction rolls back at the end.
    const statements = sql().split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(3);
    const outcome = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "sessions" (LIKE public."sessions" INCLUDING DEFAULTS) ON COMMIT DROP');
      await tx.$executeRaw`INSERT INTO "sessions" ("id", "userId", "token", "refreshToken", "previousRefreshToken", "authMethod", "deviceId", "deviceType", "expiresAt", "createdAt")
        VALUES ('m-legacy', ${ids.A}, ${legacy.token}, ${legacy.refreshToken}, ${legacy.previous}, 'OTP'::"SessionAuthMethod", 'd', 't', now() + interval '1 day', now()),
               ('m-fresh', ${ids.A}, ${fresh.token}, ${fresh.refreshToken}, NULL, 'OTP'::"SessionAuthMethod", 'd', 't', now() + interval '1 day', now()),
               ('m-done', ${ids.A}, ${done.token}, ${done.refreshToken}, NULL, 'OTP'::"SessionAuthMethod", 'd', 't', now() + interval '1 day', now())`;
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<Array<{ id: string; token: string; refreshToken: string; previousRefreshToken: string | null }>>`
        SELECT "id", "token", "refreshToken", "previousRefreshToken" FROM pg_temp."sessions" ORDER BY "id"`;
      const refused = await tx.$executeRawUnsafe(`UPDATE pg_temp."sessions" SET "token" = 'plain' WHERE "id" = 'm-done'`)
        .then(() => 'accepted', (error: Error) => error.message);
      throw Object.assign(new Error('rollback'), { rows, refused });
    }).catch((error: Error & { rows?: unknown; refused?: string }) => {
      if (error.message !== 'rollback') throw error;
      return { rows: error.rows as Array<{ id: string; token: string; refreshToken: string; previousRefreshToken: string | null }>, refused: error.refused };
    });
    const byId = Object.fromEntries(outcome.rows.map((r) => [r.id, r]));
    expect(byId['m-legacy']).toEqual({
      id: 'm-legacy',
      token: sessionCredentialDigest(legacy.token),
      refreshToken: sessionCredentialDigest(legacy.refreshToken),
      previousRefreshToken: sessionCredentialDigest(legacy.previous),
    });
    expect(byId['m-fresh']).toEqual({
      id: 'm-fresh',
      token: sessionCredentialDigest(fresh.token),
      refreshToken: sessionCredentialDigest(fresh.refreshToken),
      previousRefreshToken: null,
    });
    expect(byId['m-done']).toEqual({ id: 'm-done', token: done.token, refreshToken: done.refreshToken, previousRefreshToken: null });
    expect(outcome.refused).toMatch(/sessions_token_digest_check|check constraint/);
  });

  it('bounds its table-lock wait and adds no other DDL', () => {
    const text = sql();
    expect(text.indexOf("SET lock_timeout = '10s';")).toBeGreaterThan(-1);
    expect(text.indexOf('ALTER TABLE "sessions"')).toBeGreaterThan(text.indexOf('UPDATE "sessions"'));
    const statements = text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/DROP|RENAME|ADD COLUMN|DELETE/i);
  });

  it('rollback.sql (a sign-out-everywhere): drops the three constraints, empties the table and its migration row, so the previous code can write again', async () => {
    const text = readFileSync(join(process.cwd(), MIGRATION.replace('migration.sql', 'rollback.sql')), 'utf8');
    // Statements end with ';' at the end of a line; the DO $ledger$ block is one statement. BEGIN/COMMIT are
    // left to the test's own transaction, which runs against TEMP copies and always rolls back.
    const statements: string[] = []; let current = '';
    for (const line of text.split('\n').filter((l) => !l.trim().startsWith('--'))) {
      current += `${line}\n`;
      const inBlock = (current.match(/\$ledger\$/g) ?? []).length % 2 === 1;
      if (!inBlock && line.trim().endsWith(';')) { statements.push(current.trim().replace(/;$/, '')); current = ''; }
    }
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    const outcome = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "sessions" (LIKE public."sessions" INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP');
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "_prisma_migrations" ("migration_name" text) ON COMMIT DROP');
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp."_prisma_migrations" VALUES ('20261018190000_session_credential_digests'), ('20261017230000_other')`);
      // a refused insert would abort the whole transaction: each attempt runs inside its own savepoint
      const plain = async () => {
        await tx.$executeRawUnsafe('SAVEPOINT plain_attempt');
        return tx.$executeRawUnsafe(`INSERT INTO pg_temp."sessions" ("id", "userId", "token", "refreshToken", "authMethod", "deviceId", "deviceType", "expiresAt", "createdAt")
          VALUES ('${nanoid(12)}', '${ids.A}', 'eyJ.plain.sig', '${nanoid(64)}', 'OTP', 'd', 't', now() + interval '1 day', now())`)
          .then(async () => { await tx.$executeRawUnsafe('RELEASE SAVEPOINT plain_attempt'); return 'accepted'; },
            async (error: Error) => { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT plain_attempt'); return error.message; });
      };
      const before = await plain();
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp."sessions" ("id", "userId", "token", "refreshToken", "authMethod", "deviceId", "deviceType", "expiresAt", "createdAt")
        VALUES ('r-digest', '${ids.A}', '${sessionCredentialDigest('a')}', '${sessionCredentialDigest('r')}', 'OTP', 'd', 't', now() + interval '1 day', now())`);
      for (const statement of statements.slice(1, -1)) await tx.$executeRawUnsafe(statement);
      const left = await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_temp."sessions"`;
      const ledger = await tx.$queryRaw<Array<{ migration_name: string }>>`SELECT "migration_name" FROM pg_temp."_prisma_migrations"`;
      const after = await plain();
      throw Object.assign(new Error('rollback'), { before, left: left[0]!.n, ledger: ledger.map((r) => r.migration_name), after });
    }).catch((error: Error & { before?: string; left?: number; ledger?: string[]; after?: string }) => {
      if (error.message !== 'rollback') throw error;
      return error;
    });
    expect(outcome.before).toMatch(/digest_check|check constraint/);
    expect(outcome.left).toBe(0);
    expect(outcome.ledger).toEqual(['20261017230000_other']);
    expect(outcome.after).toBe('accepted');
  });
});
