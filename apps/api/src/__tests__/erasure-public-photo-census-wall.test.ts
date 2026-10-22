/**
 * [IMAGES-E2E · REVIEW-G S3-1 / DUP-AUDIT B-4 on #1918 · Phase C] An account erasure ends by
 * counting the person's open public-photo deletion obligations (store and portfolio photos,
 * storage_orphans). A row can carry another tenant, and on the walled credentials the request's
 * connection sees only its own tenant, so the count must be a proven system-login read
 * (#1953's storageOrphanCensusSeesEveryRow), never a plain query that may read 0 and answer
 * "deleted" while a photo is still owed. Measured on per-suite request/system logins:
 *  - the census finds another tenant's row the request itself cannot see;
 *  - a person with such a row is still told the erasure is pending; one with none, complete;
 *  - with no system login the census cannot prove anything and answers null (pending), not [].
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
import { openPublicPhotoObligationIds, owedPublicPhotoCount } from '../lib/storage-orphans';
import { PUBLIC_PHOTO_DELETE_REASONS, PUBLIC_PHOTO_REMOVED } from '../utils/public-photo-deletion';

// [R048-001] creates only this suite's temporary request/system LOGIN roles.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const OTHER_TENANT = `epc-tenant-${RUN}`;
const REASONS = [...PUBLIC_PHOTO_DELETE_REASONS];

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { admin: '', clean: '', owed: '', orphan: '', avatarRow: '', unproven: '' };
const users: string[] = [];

const mkUser = async (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Photo', lastName: `Wall${RUN}`, roles: roles as never, activeRole: activeRole as never,
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
  ids.clean = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.owed = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.unproven = await mkUser(['CUSTOMER'], 'CUSTOMER');
  // An owed portfolio-photo deletion for `owed`, on a row of ANOTHER tenant. Its folder belongs to no provider
  // of this person, so the retry may never delete it (the folder-owner check refuses): it stays open.
  await owner.tenant.create({ data: { id: OTHER_TENANT, name: `Photo census ${RUN}`, slug: OTHER_TENANT } });
  ids.orphan = (await owner.storageOrphan.create({ data: {
    tenantId: OTHER_TENANT, key: `portfolio/nobody${RUN}/${`pc${RUN}`.padEnd(16, 'x').slice(0, 16)}.jpg`,
    reason: PUBLIC_PHOTO_REMOVED, userId: ids.owed,
  } })).id;
  // An obligation of another kind (an avatar one) for the same person: not a photo this census counts.
  ids.avatarRow = (await owner.storageOrphan.create({ data: {
    tenantId: OTHER_TENANT, key: `avatars/${ids.owed}/pc${RUN}.jpg`, reason: 'SELFIE_AUTHORITY_UNPROVEN', userId: ids.owed,
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
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeFixtureAuditTrail(owner, users, 'erasure-public-photo-census-wall');
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    }
    await owner.tenant.deleteMany({ where: { id: OTHER_TENANT } }).catch(() => undefined);
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());
const erase = async (actor: string, subject: string) => {
  const { AccountService } = await import('../modules/user/account.service');
  return asPerson(actor, () => new AccountService(app).deleteAccount(subject, false));
};

describe('[Phase C] the public-photo erasure census under the tenant wall', () => {
  it('runs on the system login: it finds the other tenant\'s owed photo the request itself cannot see', async () => {
    expect(await asPerson(ids.admin, () => app.prisma.storageOrphan.count({ where: { id: ids.orphan } }))).toBe(0);
    expect(await asPerson(ids.admin, () => openPublicPhotoObligationIds(app.prisma, ids.owed, REASONS))).toEqual([ids.orphan]);
    expect(await asPerson(ids.admin, () => openPublicPhotoObligationIds(app.prisma, ids.clean, REASONS))).toEqual([]);
  });

  it('a photo still owed in another tenant keeps the answer pending; nothing owed is complete', async () => {
    expect(await erase(ids.admin, ids.owed)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingUploads: 1, pendingAvatarObjects: 1 });
    expect(await owner.storageOrphan.findUniqueOrThrow({ where: { id: ids.orphan } })).toMatchObject({ purgedAt: null });
    expect(await erase(ids.admin, ids.clean)).toEqual({ deleted: true });
  });

  it('with no system login nothing is proven: the census answers null and the erasure counts a photo still owed', async () => {
    const system = prismaModule.systemPrismaClient();
    const url = process.env['SYSTEM_DATABASE_URL'];
    delete process.env['SYSTEM_DATABASE_URL'];
    prismaModule.setSystemPrismaClient(null);
    try {
      expect(prismaModule.systemPrismaClient()).toBeNull();
      expect(await asPerson(ids.admin, () => openPublicPhotoObligationIds(app.prisma, ids.unproven, REASONS))).toBeNull();
      // Unproven counts as one photo still owed (never 0, the false "deleted"), and nothing is retried blind.
      const retried: string[] = [];
      expect(await asPerson(ids.admin, () => owedPublicPhotoCount(app.prisma, ids.unproven, REASONS, async (id) => { retried.push(id); }))).toBe(1);
      expect(retried).toEqual([]);
      const answer = await erase(ids.admin, ids.unproven) as { deleted: boolean; pendingUploads?: number };
      expect(answer.deleted).toBe(false);
      expect(answer.pendingUploads ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      process.env['SYSTEM_DATABASE_URL'] = url;
      // The next system read opens a fresh system client from the URL; the old one is closed.
      prismaModule.setSystemPrismaClient(null);
      await system?.$disconnect().catch(() => {});
    }
  });
});
