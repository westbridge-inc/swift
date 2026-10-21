/**
 * [Phase C · erasure under the tenant wall] The other global erasure censuses
 * (upload-erasure: unclaimed uploads, liveness selfies, fingerprints;
 * mover-object-erasure: legacy rider/driver pointers) read every tenant's rows
 * to prove an object is not shared. They demanded row_security_active = false
 * on the request's own transaction, which the walled request login never gives
 * (nor the system login: its escape is a policy term), so a walled erasure of
 * a person who has such objects answered "pending" and no sweep could finish
 * it. Each pass now runs on the system login and proves visibility there
 * (lib/census-visibility). Measured through the app's own client on per-suite
 * request/system logins with TENANT_RLS_BIND=1: each person's own erasure
 * answers { deleted: true } at once, and the object is really gone.
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
import { storageProviderKind } from '../providers/storage/storage-key';

// [R048-001] creates only this suite's temporary request/system LOGIN roles (and, rolled back, one probe role and policy).
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { upload: '', liveness: '', fingerprint: '', mover: '', rider: '', liveness2: '', mover2: '', rider2: '' };
const keyOf = (relative: string) => (storageProviderKind() === 'local' ? `/uploads/${relative}` : relative);
const name16 = (tag: string) => `${tag}${RUN}`.padEnd(16, 'q').slice(0, 16);
const keys = { upload: '', liveness: '', fingerprint: '', mover: '', liveness2: '', mover2: '' };
// The value upload-erasure writes over a forgotten hash. Imported lazily (like every app module here) so no app
// client is built before the env below points DATABASE_URL at the walled request login.
const erasedFingerprint = async () => (await import('../modules/user/upload-erasure')).ERASED_FINGERPRINT;
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
  ids.upload = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.liveness = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.fingerprint = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.mover = await mkUser(['CUSTOMER', 'MOVER'], 'CUSTOMER');
  const envelope = (fileKey: string, createdBy: string, shredded: boolean) => owner.encryptedObject.create({ data: {
    fileKey, createdBy, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: shredded ? null : Buffer.alloc(60, 3),
    mimeType: 'image/jpeg', sizeBytes: 42, sha256: 'a'.repeat(64), ...(shredded && { shreddedAt: new Date() }),
  } });
  // (U) an upload no document and no mover pointer claims; (F) an already-shredded object that still carries its hash;
  // (L) a shift liveness selfie; (M) a mover's legacy profile photo pointer. No bytes exist: absence is confirmed at once.
  keys.upload = keyOf(`verification/${ids.upload}/${name16('up')}.enc`);
  await envelope(keys.upload, ids.upload, false);
  keys.fingerprint = keyOf(`verification/${ids.fingerprint}/${name16('fp')}.enc`);
  await envelope(keys.fingerprint, ids.fingerprint, true);
  keys.liveness = keyOf(`liveness/${ids.liveness}/${name16('lv')}.jpg`);
  await owner.livenessCheck.create({ data: { userId: ids.liveness, profile: 'DRIVER', selfieUrl: keys.liveness, outcome: 'PASS', tenantId: PRODUCTION } });
  keys.mover = keyOf(`avatars/${ids.mover}/${name16('mv')}.jpg`);
  ids.rider = (await owner.rider.create({ data: { userId: ids.mover, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', profilePhotoUrl: keys.mover } })).id;
  // The same two shapes again, for the narrowed-census refusals below.
  ids.liveness2 = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.mover2 = await mkUser(['CUSTOMER', 'MOVER'], 'CUSTOMER');
  keys.liveness2 = keyOf(`liveness/${ids.liveness2}/${name16('lw')}.jpg`);
  await owner.livenessCheck.create({ data: { userId: ids.liveness2, profile: 'DRIVER', selfieUrl: keys.liveness2, outcome: 'PASS', tenantId: PRODUCTION } });
  keys.mover2 = keyOf(`avatars/${ids.mover2}/${name16('mw')}.jpg`);
  ids.rider2 = (await owner.rider.create({ data: { userId: ids.mover2, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', profilePhotoUrl: keys.mover2 } })).id;

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
      for (const table of ['users', '"LivenessCheck"']) await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS erasure_probe_${RUN} ON ${table}`);
      await owner.storageOrphan.deleteMany({ where: { userId: { in: users } } });
      await owner.livenessCheck.deleteMany({ where: { userId: { in: users } } });
      await owner.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
      await owner.rider.deleteMany({ where: { userId: { in: users } } });
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeFixtureAuditTrail(owner, users, 'erasure-avatar-census-wall');
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    }
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

describe('[Phase C] the upload and mover erasure answers under the tenant wall', () => {
  it('the requests below run on the walled request login (row security applies to users there)', async () => {
    const requestRole = decodeURIComponent(new URL(logins!.requestUrl).username);
    const [row] = await asPerson(ids.upload, () => app.prisma.$transaction((tx) => tx.$queryRaw<Array<{ who: string; active: boolean }>>`
      SELECT current_user::text AS "who", row_security_active('users'::regclass) AS "active"`));
    expect(row).toEqual({ who: requestRole, active: true });
  });

  it('an unclaimed upload: complete at once, the envelope shredded', async () => {
    expect(await erase(ids.upload, ids.upload, true)).toEqual({ deleted: true });
    expect(await owner.encryptedObject.findUniqueOrThrow({ where: { fileKey: keys.upload } })).toMatchObject({ wrappedDek: null, sha256: await erasedFingerprint() });
    expect((await owner.encryptedObject.findUniqueOrThrow({ where: { fileKey: keys.upload } })).shreddedAt).not.toBeNull();
  });

  it('a liveness selfie: complete at once, the row gone', async () => {
    expect(await erase(ids.liveness, ids.liveness, true)).toEqual({ deleted: true });
    expect(await owner.livenessCheck.count({ where: { userId: ids.liveness } })).toBe(0);
  });

  it('a shredded object that still carries its hash: complete at once, the fingerprint forgotten', async () => {
    expect(await erase(ids.fingerprint, ids.fingerprint, true)).toEqual({ deleted: true });
    expect((await owner.encryptedObject.findUniqueOrThrow({ where: { fileKey: keys.fingerprint } })).sha256).toBe(await erasedFingerprint());
  });

  it('a mover\'s legacy photo pointer: complete at once, the pointer cleared', async () => {
    expect(await erase(ids.mover, ids.mover, true)).toEqual({ deleted: true });
    expect((await owner.rider.findUniqueOrThrow({ where: { id: ids.rider } })).profilePhotoUrl).toBeNull();
  });

  /** A RESTRICTIVE policy that narrows nothing (USING true), for THIS suite's system login only: the census must still
   *  refuse it (a restrictive policy is never proven harmless), so the erasure stays pending and the object stays. */
  const narrowed = async <T>(table: string, run: () => Promise<T>): Promise<T> => {
    const systemRole = decodeURIComponent(new URL(logins!.systemUrl).username);
    await owner.$executeRawUnsafe(`CREATE POLICY erasure_probe_${RUN} ON ${table} AS RESTRICTIVE FOR SELECT TO ${systemRole} USING (true)`);
    try { return await run(); } finally { await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS erasure_probe_${RUN} ON ${table}`); }
  };

  it('a narrowed liveness census on the system login: still pending, the photo row kept', async () => {
    expect(await narrowed('"LivenessCheck"', () => erase(ids.liveness2, ids.liveness2, true)))
      .toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingUploads: 1 });
    expect(await owner.livenessCheck.count({ where: { userId: ids.liveness2 } })).toBe(1);
  });

  it('a narrowed users census on the system login: the mover photo still pending, the pointer kept', async () => {
    expect(await narrowed('users', () => erase(ids.mover2, ids.mover2, true)))
      .toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingDocuments: 1 });
    expect((await owner.rider.findUniqueOrThrow({ where: { id: ids.rider2 } })).profilePhotoUrl).toBe(keys.mover2);
  });
});
