/**
 * [TENANT-WALL · 1 Nov 2026] The owner's ops pages fire under production's
 * CONTRACT tenant posture.
 *
 * Under the posture (the app's own client on a least-privilege login that does
 * not bypass row security, system work on its own bypass-member login,
 * TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny) three paging paths failed
 * silently:
 *  - /health's worker-death pages (scheduler stalled, scheduler never started):
 *    the probe carries no session, so pageOps' open-page lookup was refused
 *    (TENANT_CONTEXT_REQUIRED) and the refusal was swallowed: the page never
 *    fired, and the clearing probe could not close one either;
 *  - a platform page raised inside a SIGNED-IN request (the address-search
 *    page): its lookup and resolve were scoped to the caller's tenant, so they
 *    could never see the platform row (tenantId null): a second row opened
 *    once the dedupe window passed, and the page was never closed;
 *  - an admin page raised from a request with no tenant bound (the 5xx-spike
 *    pager counting a public route's errors): the inbox row was written, but
 *    the push fan-out's read of the admin was refused, so no phone rang.
 *
 * Measured here through the app's own client on a per-suite walled login, the
 * whole app (buildApp) for /health and the error handler on its own app, with
 * the server's request context boundary. A push is what the dev push adapter
 * records for this suite's own admin device.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'RUN_WORKERS', 'LOG_LEVEL', 'SCHEDULER_STALL_ALERT_MINUTES', 'ERROR_RATE_ALERT_PER_MIN'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
/** The admin's operator: a tenant of this suite's own. */
const TENANT = `opswall-${RUN}`;
const STALLED = 'Job scheduler stalled';
const NEVER_STARTED = 'Job scheduler never started';
const SPIKE = 'Server error spike';
const SIGNED_IN_TITLE = `Address search is failing [opswall ${RUN}]`;
const DEDUPE_KEYS = ['ops_page:scheduler-stall', 'ops_page:scheduler-never-booted', 'ops_page:error-spike', `ops_page:opswall-${RUN}`];
const DEVICE = `ExponentPushToken[opswall-${RUN}]`;
/** The device of an admin who turned push off. */
const DEVICE_QUIET = `ExponentPushToken[opswall-quiet-${RUN}]`;
const MINUTE = 60_000;

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let boomApp: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let channels: typeof import('../providers/notifications/channels');
let priorBeat: string | null = null;
const suiteStart = new Date();
let adminId = '';
let quietAdminId = '';

async function person(roles: string[]) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Ops', lastName: `Wall${RUN}`, tenantId: TENANT, isPhoneVerified: true,
    roles: roles as never[], activeRole: roles[0] as never, status: 'ACTIVE',
  } });
  return user.id;
}

/** Closes every open platform page of these titles: residue of earlier runs on this database, never this suite's own. */
async function closeOpen(titles: string[]) {
  await owner.opsAlert.updateMany({ where: { kind: 'PLATFORM', title: { in: titles }, closedAt: null }, data: { closedAt: new Date(), closeReason: 'test-residue' } });
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.tenant.create({ data: { id: TENANT, name: 'Ops wall tenant', slug: TENANT, isActive: true } });
  adminId = await person(['SUPER_ADMIN']);
  quietAdminId = await person(['SUPER_ADMIN']);
  await owner.user.update({ where: { id: quietAdminId }, data: { notificationPrefs: { push: false } } });
  await owner.deviceToken.create({ data: { userId: adminId, token: DEVICE, platform: 'ios', isActive: true } });
  await owner.deviceToken.create({ data: { userId: quietAdminId, token: DEVICE_QUIET, platform: 'ios', isActive: true } });
  await closeOpen([STALLED, NEVER_STARTED, SIGNED_IN_TITLE]);

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['RUN_WORKERS'] = '0';
  process.env['LOG_LEVEL'] = 'silent';
  prismaModule = await import('../plugins/prisma');
  channels = await import('../providers/notifications/channels');
  const { buildApp } = await import('../app');
  app = await buildApp();
  await app.ready();
  priorBeat = await app.redis.get('scheduler:heartbeat');
  await app.redis.del(...DEDUPE_KEYS);

  // The error handler on its own app (the same hooks and plugins it needs), with one route that fails.
  const Fastify = (await import('fastify')).default;
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  boomApp = Fastify({ logger: false });
  registerErrorHandler(boomApp);
  await boomApp.register(prismaModule.prismaPlugin);
  await boomApp.register(redisPlugin);
  await boomApp.register(authPlugin);
  await boomApp.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  boomApp.addHook('onRequest', async () => { beginRequestTenantContext(); });
  boomApp.get('/boom', async () => { throw new Error('opswall boom'); });
  await boomApp.ready();
}, 180_000);

afterAll(async () => {
  try {
    if (app?.redis) {
      await app.redis.del(...DEDUPE_KEYS);
      if (priorBeat === null) await app.redis.del('scheduler:heartbeat'); else await app.redis.set('scheduler:heartbeat', priorBeat);
    }
    await boomApp?.close();
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    const mine = await owner.opsAlert.findMany({ where: { kind: 'PLATFORM', title: { in: [STALLED, NEVER_STARTED, SIGNED_IN_TITLE] }, createdAt: { gte: suiteStart } }, select: { id: true } });
    await owner.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: mine.map((r) => r.id) } } });
    await owner.opsAlert.deleteMany({ where: { id: { in: mine.map((r) => r.id) } } });
    await owner.alertDelivery.deleteMany({ where: { recipientId: { in: [adminId, quietAdminId].filter(Boolean) } } }).catch(() => {});
    await owner.notification.deleteMany({ where: { userId: { in: [adminId, quietAdminId].filter(Boolean) } } });
    await owner.deviceToken.deleteMany({ where: { token: { in: [DEVICE, DEVICE_QUIET] } } });
    await owner.identityKey.deleteMany({ where: { accountId: { in: [adminId, quietAdminId].filter(Boolean) } } }).catch(() => {});
    await owner.user.deleteMany({ where: { tenantId: TENANT } });
    await owner.tenant.deleteMany({ where: { id: TENANT } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const openPages = (title: string) => owner.opsAlert.findMany({
  where: { kind: 'PLATFORM', title, closedAt: null, createdAt: { gte: suiteStart } },
  include: { recipients: { select: { userId: true } } },
});
const pushedTo = (title: string, device = DEVICE) => channels.devChannelLog.filter((e) => e.channel === 'push' && e.to === device && e.title === title).length;
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const health = () => app.inject({ method: 'GET', url: '/health' });

describe('[TENANT-WALL] the worker-death pages behind /health fire under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a worker that died (stale heartbeat) is PAGED: one open platform page, the admin pushed', async () => {
    await app.redis.set('scheduler:heartbeat', String(Date.now() - 30 * MINUTE));
    expect((await health()).statusCode).toBe(503);
    await until(async () => (await openPages(STALLED)).length > 0 && pushedTo(STALLED) > 0, 'the stall page and its push');
    const [page] = await openPages(STALLED);
    expect(page!.tenantId).toBeNull();
    expect(page!.recipients.map((r) => r.userId)).toContain(adminId);
    expect(pushedTo(STALLED)).toBe(1);
  });

  it('the next probe finds the open page and opens no other, even once the dedupe window has passed', async () => {
    await app.redis.del('ops_page:scheduler-stall');
    expect((await health()).statusCode).toBe(503);
    await new Promise((r) => setTimeout(r, 500));
    expect((await openPages(STALLED)).length).toBe(1);
    expect(pushedTo(STALLED)).toBe(1);
  });

  it('the worker back (fresh heartbeat) closes the page', async () => {
    await app.redis.set('scheduler:heartbeat', String(Date.now()));
    expect((await health()).statusCode).toBe(200);
    await until(async () => (await openPages(STALLED)).length === 0, 'the stall page to close');
    const closed = await owner.opsAlert.findMany({ where: { kind: 'PLATFORM', title: STALLED, createdAt: { gte: suiteStart } }, select: { closeReason: true } });
    expect(closed.map((c) => c.closeReason)).toEqual(['condition-cleared']);
  });

  it('a worker fleet that never started (no heartbeat past the grace) is PAGED too', async () => {
    await app.redis.del('scheduler:heartbeat');
    process.env['SCHEDULER_STALL_ALERT_MINUTES'] = '0.001';
    try {
      expect((await health()).statusCode).toBe(503);
      await until(async () => (await openPages(NEVER_STARTED)).length > 0 && pushedTo(NEVER_STARTED) > 0, 'the never-started page and its push');
      expect((await openPages(NEVER_STARTED))[0]!.recipients.map((r) => r.userId)).toContain(adminId);
    } finally {
      delete process.env['SCHEDULER_STALL_ALERT_MINUTES'];
      await app.redis.set('scheduler:heartbeat', String(Date.now()));
    }
  });
});

describe('[TENANT-WALL] a platform page raised inside a signed-in request lives in the PLATFORM scope', () => {
  const input = { key: `ops_page:opswall-${RUN}`, title: SIGNED_IN_TITLE, body: 'Address search failed 5 times in a row.', data: { kind: 'ops_places_down' } };

  it('one open page however often the caller raises it, and it closes when the condition clears', async () => {
    const { pageOps, resolveOpsPage } = await import('../modules/ops/ops-page');
    const { NotificationService } = await import('../modules/notification/notification.service');
    const { runWithTenant } = await import('../plugins/tenant-context');
    const deps = { prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, app.io) };
    // A signed-in customer's request: bound to the caller's tenant.
    const asCaller = <T>(fn: () => Promise<T>) => runWithTenant(TENANT, fn);
    expect((await asCaller(() => pageOps(deps, input))).status).toBe('delivered');
    await app.redis.del(input.key); // the dedupe window has passed
    expect((await asCaller(() => pageOps(deps, input))).status).toBe('deduped');
    expect((await openPages(SIGNED_IN_TITLE)).length).toBe(1);
    expect(await asCaller(() => resolveOpsPage(app.prisma, SIGNED_IN_TITLE, 'places-recovered'))).toBe(1);
    expect((await openPages(SIGNED_IN_TITLE)).length).toBe(0);
  });
});

describe('[TENANT-WALL] an admin page raised from a request with no tenant bound reaches the admin’s phone', () => {
  it('notifyAdmins in an unbound request: the inbox row AND the push', async () => {
    const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
    const { tenantContext } = await import('../plugins/tenant-context');
    const title = `Platform notice [opswall ${RUN}]`;
    const reached = await tenantContext.run({ tenantId: null, mode: 'request' }, () =>
      notifyAdmins(app.prisma, new NotificationService(app.prisma, app.io), { tenantId: null, title, body: 'A platform notice.', data: { kind: 'ops_opswall' } }));
    expect(reached).toBeGreaterThan(0);
    expect(await owner.notification.count({ where: { userId: adminId, title } })).toBe(1);
    await until(async () => pushedTo(title) > 0, 'the push');
    expect(pushedTo(title)).toBe(1);
    // ...read in each admin's own tenant: an admin who turned push off has the notice in the inbox, and no push.
    expect(await owner.notification.count({ where: { userId: quietAdminId, title } })).toBe(1);
    expect(pushedTo(title, DEVICE_QUIET)).toBe(0);
  });

  it('the 5xx-spike pager, counting a public route’s failures, pages the admin with a push', async () => {
    await boomApp.redis.del('ops_page:error-spike');
    // Not in the last seconds of a minute: the spike counter's window is one minute.
    while (Date.now() % MINUTE > MINUTE - 5_000) await new Promise((r) => setTimeout(r, 250));
    const windowKey = `err5xx:${Math.floor(Date.now() / MINUTE)}`;
    const already = Number((await boomApp.redis.get(windowKey)) ?? 0);
    process.env['ERROR_RATE_ALERT_PER_MIN'] = String(already + 1);
    const res = await boomApp.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    await until(async () => (await owner.notification.count({ where: { userId: adminId, title: SPIKE, createdAt: { gte: suiteStart } } })) > 0, 'the spike inbox row');
    await until(async () => pushedTo(SPIKE) > 0, 'the spike push');
    expect(pushedTo(SPIKE)).toBe(1);
    // the page runs after the response: let it finish (its tracking rows are its last write) before the apps close
    await until(async () => (await owner.alertDelivery.count({ where: { recipientId: adminId, subjectId: 'ops_error_spike' } })) > 0, 'the spike page to finish');
  });
});
