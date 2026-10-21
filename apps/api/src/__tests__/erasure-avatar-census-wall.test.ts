/**
 * [Phase C · erasure under the tenant wall] An account erasure ends with a
 * GLOBAL census of the person's open avatar obligations (storage_orphans),
 * because a historical row can carry another tenant. On the walled
 * credentials (TENANT_RLS_BIND=1, least-privilege request login) the
 * request's connection only sees its own tenant, so the census used to refuse
 * every time and the person, the admin and the retry job were all told the
 * erasure was still pending, for ever. The census is system work now: it runs
 * on the system login, and certifies that connection sees every row.
 * Measured through the app's own client on per-suite request/system logins:
 *  - a person with nothing outstanding is told the erasure is complete, from
 *    their own request and from an admin's;
 *  - a person whose avatar obligation is still open — a row in ANOTHER tenant,
 *    which only the system login can see — is still told it is pending;
 *  - the census connection is the system login, and refuses a policy that
 *    would narrow it (a restrictive policy) or a login that is no bypass member.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import { openAvatarErasureObligationIds, storageOrphanCensusSeesEveryRow } from '../lib/storage-orphans';
import { storageProviderKind } from '../providers/storage/storage-key';
import { resolveUnreferencedAvatarObject } from '../modules/verification/object-authority';

// [R048-001] creates only this suite's temporary request/system LOGIN roles (and, rolled back, one probe role and policy).
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const OTHER_TENANT = `eac-tenant-${RUN}`;

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { admin: '', selfServe: '', closed: '', pending: '', orphan: '', withAvatar: '', withCase: '', kase: '' };
const users: string[] = [];

const mkUser = async (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Census', lastName: `Wall${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } })).id;
  users.push(id);
  return id;
};

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  ids.admin = await mkUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });
  ids.selfServe = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.closed = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.pending = await mkUser(['CUSTOMER'], 'CUSTOMER');
  // An open avatar obligation for `pending`, on a row of ANOTHER tenant (a historical mismatch the census exists to
  // catch). Its reason is not one the retry pass acts on, so it stays open whatever the storage does.
  await owner.tenant.create({ data: { id: OTHER_TENANT, name: `Census ${RUN}`, slug: OTHER_TENANT } });
  ids.orphan = (await owner.storageOrphan.create({ data: {
    tenantId: OTHER_TENANT, key: `avatars/${ids.pending}/census${RUN}.jpg`, reason: 'SELFIE_AUTHORITY_UNPROVEN', userId: ids.pending,
  } })).id;

  // [copy run #5a] People with a signup avatar (the server-issued key shape, so the exact-row retry may delete it):
  // their erasure queues the avatar obligation under the user lock and closes that exact row before answering.
  // One of them is also inside an open incident case, so their answer is the safety-hold receipt.
  ids.withAvatar = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.withCase = await mkUser(['CUSTOMER'], 'CUSTOMER');
  for (const id of [ids.withAvatar, ids.withCase]) {
    const relative = `avatars/${id}/${`av${RUN}`.padEnd(16, 'x').slice(0, 16)}.jpg`;
    await owner.user.update({ where: { id }, data: { avatar: storageProviderKind() === 'local' ? `/uploads/${relative}` : relative } });
  }
  ids.kase = (await owner.incidentCase.create({ data: {
    caseNumber: `INC-${RUN.toUpperCase()}`, status: 'OPEN', severity: 'S1', category: 'SAFETY_ASSAULT', intake: 'OPS_CREATED',
    subjectUserId: ids.withCase, summary: 'census wall test', slaAckBy: new Date(), slaDecideBy: new Date(), tenantId: PRODUCTION,
  } })).id;

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { socketPlugin } = await import('../plugins/socket');
  app = Fastify({ logger: false });
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
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
      await owner.storageOrphan.deleteMany({ where: { userId: { in: users } } });
      await owner.safetyDeletionHold.deleteMany({ where: { userId: { in: users } } });
      await owner.incidentCase.deleteMany({ where: { id: ids.kase } }).catch(() => undefined);
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeFixtureAuditTrail(owner, users, 'erasure-avatar-census-wall');
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    }
    await owner.tenant.deleteMany({ where: { id: OTHER_TENANT } }).catch(() => undefined);
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

/** A flow bound the way a request is: its tenant and the person it acts for (awaited INSIDE the context). */
const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());
const erase = async (actor: string, subject: string, selfServe = false) => {
  const { AccountService } = await import('../modules/user/account.service');
  return asPerson(actor, () => new AccountService(app).deleteAccount(subject, selfServe));
};

describe('[Phase C] the erasure answer under the tenant wall', () => {
  it('nothing outstanding: complete, from the person\'s own request and from an admin\'s', async () => {
    expect(await erase(ids.selfServe, ids.selfServe, true)).toEqual({ deleted: true });
    expect(await erase(ids.admin, ids.closed)).toEqual({ deleted: true });
    for (const id of [ids.selfServe, ids.closed]) {
      expect(await owner.user.findUniqueOrThrow({ where: { id } }), id).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${id}` });
    }
  });

  it('an avatar obligation still open in another tenant: still pending, from an admin\'s request', async () => {
    expect(await erase(ids.admin, ids.pending)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingAvatarObjects: 1 });
    expect(await owner.storageOrphan.findUniqueOrThrow({ where: { id: ids.orphan } })).toMatchObject({ purgedAt: null });
  });
});

describe('[Phase C · copy run #5a] the exact avatar obligation closes before the answer, under the wall', () => {
  it('a person with a signup avatar is told the erasure is complete (P1), and the obligation row is closed', async () => {
    expect(await erase(ids.withAvatar, ids.withAvatar, true)).toEqual({ deleted: true });
    expect(await owner.user.findUniqueOrThrow({ where: { id: ids.withAvatar } })).toMatchObject({ status: 'DEACTIVATED', avatar: null });
    const rows = await owner.storageOrphan.findMany({ where: { userId: ids.withAvatar } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'ACCOUNT_DELETION_DELETE_PENDING' });
    expect(rows[0]!.purgedAt).not.toBeNull();
  });

  it('inside an open incident case: the safety-hold receipt, deleted:true (P2), never a pending answer', async () => {
    const answer = await erase(ids.admin, ids.withCase);
    expect(answer).toMatchObject({ deleted: true, status: 'PENDING_SAFETY_HOLD', holdReasons: ['OPEN_INCIDENT'] });
    expect(answer).not.toHaveProperty('pendingAvatarObjects');
    expect((await owner.storageOrphan.findFirstOrThrow({ where: { userId: ids.withCase } })).purgedAt).not.toBeNull();
  });
});

describe('[Phase C] the census runs on the system login and proves it sees every row', () => {
  it('from inside a request it finds the other tenant\'s row the request itself cannot see', async () => {
    expect(await asPerson(ids.admin, () => app.prisma.storageOrphan.count({ where: { id: ids.orphan } }))).toBe(0);
    expect(await asPerson(ids.admin, () => openAvatarErasureObligationIds(app.prisma, ids.pending))).toEqual([ids.orphan]);
    // The request's own transaction is tenant-filtered: there the census proof refuses.
    expect(await asPerson(ids.admin, () => app.prisma.$transaction((tx) => storageOrphanCensusSeesEveryRow(tx)))).toBe(false);
  });

  it('refuses a login that is no bypass member, a restrictive policy, and a tenant policy without the escape (rolled back)', async () => {
    const systemRole = decodeURIComponent(new URL(logins!.systemUrl).username);
    const requestRole = decodeURIComponent(new URL(logins!.requestUrl).username);
    const seen: Record<string, boolean> = {};
    const ROLLBACK = new Error('rolled back on purpose');
    await expect(owner.$transaction(async (tx) => {
      const as = async (role: string) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        const sees = await storageOrphanCensusSeesEveryRow(tx);
        await tx.$executeRawUnsafe('RESET ROLE');
        return sees;
      };
      seen['superuser'] = await storageOrphanCensusSeesEveryRow(tx);
      seen['system'] = await as(systemRole);
      seen['request'] = await as(requestRole);
      await tx.$executeRawUnsafe(`CREATE POLICY census_probe_${RUN} ON storage_orphans AS RESTRICTIVE FOR SELECT USING ("tenantId" = current_setting('app.current_tenant', true))`);
      seen['system, narrowed'] = await as(systemRole);
      // A tenant policy without the bypass escape: the system login would see one tenant only.
      await tx.$executeRawUnsafe(`DROP POLICY census_probe_${RUN} ON storage_orphans`);
      await tx.$executeRawUnsafe('ALTER POLICY tenant_isolation ON storage_orphans USING ("tenantId" = current_setting(\'app.current_tenant\', true))');
      seen['system, no escape'] = await as(systemRole);
      throw ROLLBACK;
    }, { timeout: 30_000 })).rejects.toBe(ROLLBACK);
    expect(seen).toEqual({ superuser: true, system: true, request: false, 'system, narrowed': false, 'system, no escape': false });
    expect(await owner.$queryRaw`SELECT 1 FROM pg_policy WHERE polname = ${`census_probe_${RUN}`}`).toEqual([]);
    expect(await asPerson(ids.admin, () => openAvatarErasureObligationIds(app.prisma, ids.pending))).toEqual([ids.orphan]); // the escape is back
  });

  it('the exact retry\'s users census: the system login proves it, the request login and a narrowed system login do not (rolled back)', async () => {
    const systemRole = decodeURIComponent(new URL(logins!.systemUrl).username);
    const requestRole = decodeURIComponent(new URL(logins!.requestUrl).username);
    // An unreferenced key of the server-issued shape: authority is proven only when the census sees every users row.
    const relative = `avatars/${ids.pending}/${`un${RUN}`.padEnd(16, 'y').slice(0, 16)}.jpg`;
    const ref = { fileKey: storageProviderKind() === 'local' ? `/uploads/${relative}` : relative, userId: ids.pending };
    const seen: Record<string, boolean> = {};
    const ROLLBACK = new Error('rolled back on purpose');
    await expect(owner.$transaction(async (tx) => {
      const as = async (role: string) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        const proven = await resolveUnreferencedAvatarObject(tx, ref).then(() => true, () => false);
        await tx.$executeRawUnsafe('RESET ROLE');
        return proven;
      };
      seen['system'] = await as(systemRole);
      seen['request'] = await as(requestRole);
      await tx.$executeRawUnsafe(`CREATE POLICY users_census_probe_${RUN} ON users AS RESTRICTIVE FOR SELECT USING ("tenantId" = current_setting('app.current_tenant', true))`);
      seen['system, narrowed'] = await as(systemRole);
      throw ROLLBACK;
    }, { timeout: 30_000 })).rejects.toBe(ROLLBACK);
    expect(seen).toEqual({ system: true, request: false, 'system, narrowed': false });
    expect(await owner.$queryRaw`SELECT 1 FROM pg_policy WHERE polname = ${`users_census_probe_${RUN}`}`).toEqual([]);
  });
});
