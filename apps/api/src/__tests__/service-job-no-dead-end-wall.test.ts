/**
 * Swift support's close of a service job is the first admin write to a job, and the new reads sit beside it. Measured
 * through the app's own client on per-suite logins in the production posture (a walled request login in swift_owner_wall,
 * TENANT_RLS_BIND=1, TENANT_UNSCOPED_ACCESS=deny, OWNER_RLS_BIND=1, system work on its own bypass login): the list reads,
 * the close commits, and both people hold their notice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma');
const users: string[] = [];

async function person(roles: string[], extra: Record<string, unknown> = {}) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Job', lastName: 'Wall', roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await owner.session.create({ data: {
    userId: user.id, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP',
    deviceId: `job-wall-${user.id.slice(-6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${decodeURIComponent(new URL(logins.requestUrl).username)}`);
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { adminRoutes } = await import('../modules/admin/admin.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    if (users.length) {
      await owner.serviceJob.deleteMany({ where: { customerId: { in: users } } });
      await owner.serviceProvider.deleteMany({ where: { userId: { in: users } } });
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeAuditLogs(owner, { userId: { in: users } }, 'test-cleanup:service-job-no-dead-end-wall');
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } });
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

describe('Swift support on a service job, in the production posture', () => {
  it('reads the person, reads the jobs, closes the job, and both people hold their notice', async () => {
    const admin = await person(['ADMIN'], { status: 'ACTIVE', admin: { create: { permissions: ['*'] } } });
    const customer = await person(['CUSTOMER']);
    const pro = await person(['CUSTOMER']);
    const provider = await owner.serviceProvider.create({ data: { userId: pro.userId, trade: 'carpenter', isVerified: true } });
    const job = await owner.serviceJob.create({ data: {
      customerId: customer.userId, providerId: provider.id, tenantId: PRODUCTION, description: 'Fix a door', status: 'IN_PROGRESS', scheduledFor: new Date(Date.now() - DAY), providerConfirmedAt: new Date(Date.now() - 2 * DAY),
    } });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${admin.token}` } });

    const profile = await get(`/api/v1/admin/users/${pro.userId}`);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data.serviceProvider).toMatchObject({ id: provider.id, trade: 'carpenter' });
    const list = await get(`/api/v1/admin/users/${pro.userId}/service-jobs`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.map((j: { id: string }) => j.id)).toEqual([job.id]);

    const closed = await app.inject({
      method: 'POST', url: `/api/v1/admin/service-jobs/${job.id}/close`, payload: {},
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await owner.serviceJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CANCELLED');
    for (const who of [customer, pro]) {
      expect(await owner.notification.count({ where: { userId: who.userId, title: 'Job closed by Swift' } })).toBe(1);
    }
  });
});
