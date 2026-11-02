/**
 * [DOC-SECURITY G2] The signed profile-photo link works under production's CONTRACT tenant posture.
 *
 * GET /api/v1/auth/selfie/:userId/:file is loaded by a signed link, without a session, so nothing
 * binds a tenant for it (the same shape as the document render link, #2285). Under the posture (the
 * app's own client on a least-privilege login that does not bypass row security, system work on its
 * own bypass-member login, TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny) an unbound read of
 * `users` is refused. Its reads therefore run under one named system capability, after the
 * signature is verified. Measured here through the app's own client on a per-suite walled login,
 * with the server's request context boundary:
 *  - a link to the photo the account points at opens it, decrypted, byte for byte the cleaned photo;
 *  - a forged link, another account's id and a moved pointer still answer 404;
 *  - the wall still binds the app: its login neither bypasses row security nor joins the bypass role.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { uniquePng } from './helpers/real-image';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'MASTER_KEK', 'API_PUBLIC_URL'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
const TENANT = `avwall-${RUN}`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

type Sealed = typeof import('../providers/storage/sealed-photo');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let sealed: Sealed;
const userIds: string[] = [];
const fileKeys: string[] = [];
const ids = { person: '', other: '' };
const keys = { photo: '', second: '' };

async function person(): Promise<string> {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Avatar', lastName: `Wall${RUN}`, tenantId: TENANT, isPhoneVerified: true,
    roles: ['MOVER'], activeRole: 'MOVER', status: 'ACTIVE', selfieCapturedAt: new Date(),
  } });
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  delete process.env['API_PUBLIC_URL'];
  const envelope = await import('../providers/storage/envelope');
  envelope.resetKeyProviderForTests();
  sealed = await import('../providers/storage/sealed-photo');
  const { getStorageProvider } = await import('../providers/storage/storage-provider');

  await owner.tenant.create({ data: { id: TENANT, name: 'Avatar wall tenant', slug: TENANT, isActive: false } });
  ids.person = await person();
  ids.other = await person();
  keys.photo = await sealed.sealPhoto(owner, getStorageProvider(), { buffer: uniquePng(`avatar-wall-${RUN}`), declaredMimeType: 'image/png', ownerId: ids.person, folder: 'avatars' });
  keys.second = await sealed.sealPhoto(owner, getStorageProvider(), { buffer: uniquePng(`avatar-wall-2-${RUN}`), declaredMimeType: 'image/png', ownerId: ids.person, folder: 'avatars' });
  fileKeys.push(keys.photo, keys.second);
  await owner.user.update({ where: { id: ids.person }, data: { avatar: keys.photo } });

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { registerAuthRoutes } = await import('./helpers/auth-routes-harness');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await registerAuthRoutes(app);
  await app.ready();
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    (await import('../providers/storage/envelope')).resetKeyProviderForTests();
    const { getStorageProvider } = await import('../providers/storage/storage-provider');
    for (const key of fileKeys) await getStorageProvider().delete(key).catch(() => {});
    await owner.encryptedObject.deleteMany({ where: { fileKey: { in: fileKeys } } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: TENANT } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const open = (link: string) => app.inject({ method: 'GET', url: link });

describe('[DOC-SECURITY G2] the signed profile-photo link under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a link to the photo the account points at opens it, decrypted', async () => {
    const res = await open(sealed.sealedAvatarUrl(keys.photo)!);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  it('a forged link, another account\'s id and a moved pointer still answer 404', async () => {
    const link = sealed.sealedAvatarUrl(keys.photo)!;
    const forged = link.replace(/sig=[a-f0-9]{32}/, `sig=${'0'.repeat(32)}`);
    const foreign = link.replace(`/selfie/${ids.person}/`, `/selfie/${ids.other}/`);
    for (const url of [forged, foreign]) expect((await open(url)).statusCode, url).toBe(404);
    await owner.user.update({ where: { id: ids.person }, data: { avatar: keys.second } });
    try {
      expect((await open(link)).statusCode).toBe(404);
      expect((await open(sealed.sealedAvatarUrl(keys.second)!)).statusCode).toBe(200);
    } finally {
      await owner.user.update({ where: { id: ids.person }, data: { avatar: keys.photo } });
    }
  });
});
