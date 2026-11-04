/**
 * [BUG-HUNT F20] The staff door's open-case census under the real walls: a NOBYPASSRLS request login, the tenant wall and
 * the owner wall on, an admin's request. A support ticket is owner-walled, so an admin's transaction cannot see another
 * person's: a census that ran as the caller would read "no case" and close the account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { testPrismaClient } from './helpers/test-prisma-client';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const PRODUCTION = 'swift-default';
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: typeof import('../plugins/tenant-context');
let prismaModule: typeof import('../plugins/prisma');
const users: string[] = [];
let adminId = '';

const mkUser = async (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Wall', lastName: `Gate${RUN}`, roles: roles as never, activeRole: activeRole as never, isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } })).id;
  users.push(id);
  return id;
};

/** The door's erasure, as an admin's request runs it. */
const door = async (userId: string) => {
  const { AccountService } = await import('../modules/user/account.service');
  return tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId: adminId }, async () => await new AccountService(app).deleteAccount(userId, false, 'app', { verifiedRequest: true }));
};
const statusOf = async (id: string) => (await owner.user.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${decodeURIComponent(new URL(logins.requestUrl).username)}`);
  adminId = await mkUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  app = Fastify({ logger: false });
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
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
      await owner.supportTicket.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

describe('the census sees every case table under the walls', () => {
  it('an owner-walled case the caller cannot see still refuses, in the same transaction', async () => {
    const subject = await mkUser(['CUSTOMER'], 'CUSTOMER');
    await owner.supportTicket.create({ data: { userId: subject, category: 'ACCOUNT', subject: 'synthetic', message: 'synthetic' } });
    await expect(door(subject)).rejects.toMatchObject({ code: 'OPEN_CASE' });
    expect(await statusOf(subject)).toBe('ACTIVE');
  }, 30_000);

  it('a tenant-walled case refuses', async () => {
    const subject = await mkUser(['CUSTOMER'], 'CUSTOMER');
    await owner.incidentCase.create({ data: {
      tenantId: PRODUCTION, caseNumber: `INC-${nanoid(8).toUpperCase()}`, status: 'OPEN', severity: 'S1', category: 'SAFETY_ASSAULT', intake: 'OPS_CREATED', subjectUserId: subject, summary: 'synthetic', slaAckBy: new Date(), slaDecideBy: new Date(),
    } as never });
    await expect(door(subject)).rejects.toMatchObject({ code: 'OPEN_CASE' });
    expect(await statusOf(subject)).toBe('ACTIVE');
  }, 30_000);

  it('the transaction is the caller\'s again once the census has read', async () => {
    const subject = await mkUser(['CUSTOMER'], 'CUSTOMER');
    const { refuseVerifiedDeletion } = await import('../modules/user/verified-deletion-gate');
    const after = await tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId: adminId }, async () => await app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${PRODUCTION}, true), set_config('app.current_user', ${adminId}, true)`;
      await refuseVerifiedDeletion(tx, { id: subject, status: 'ACTIVE', tenantId: PRODUCTION });
      const [row] = await tx.$queryRaw<Array<{ owner: string }>>`SELECT current_setting('app.current_user', true) AS owner`;
      return row!.owner;
    }));
    expect(after).toBe(adminId);
  }, 30_000);

  it('with no case it closes, and the caller is back in place for the erasure that follows', async () => {
    const subject = await mkUser(['CUSTOMER'], 'CUSTOMER');
    await door(subject);
    expect(await statusOf(subject)).toBe('DEACTIVATED');
  }, 30_000);
});
