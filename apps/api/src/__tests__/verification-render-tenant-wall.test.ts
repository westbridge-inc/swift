/**
 * [VIEWER-FIX · 1 Nov 2026] The admin console's document viewer works under
 * production's CONTRACT tenant posture.
 *
 * The render route (GET /api/v1/verification/render/:docId) is loaded by a
 * signed link, without a session, so nothing binds a tenant for it. Under the
 * posture (the app's own client on a least-privilege login that does not
 * bypass row security, system work on its own bypass-member login,
 * TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny) its live reviewer check
 * read `users` with no tenant bound and was refused (TENANT_CONTEXT_REQUIRED,
 * a 500): no document could be displayed. The route's other suites build an
 * app with no request context and the default policy, where the same reads
 * run unbound and pass.
 *
 * Measured here through the app's own client on a per-suite walled login,
 * with the same request context boundary as server.ts:
 *  - a link minted for an active reviewer renders the document, byte for byte;
 *  - every refusal still answers as it did: a reviewer of another tenant, a
 *    reviewer without the grant, a suspended reviewer or one without a staff
 *    role (403 DOCUMENT_REVIEWER_REQUIRED), an expired link (410), a forged
 *    or re-aimed link (403), a purged or unknown document (410), an upload
 *    still waiting for its malware scan (409), a shredded object or another
 *    person's upload (400);
 *  - the wall still binds the app: its login neither bypasses row security
 *    nor joins the bypass role.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { uniquePng } from './helpers/real-image';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'MASTER_KEK'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
const PRODUCTION = 'swift-default';
/** The document owner's operator: a tenant of this suite's own, so a read bound to any other tenant sees none of it. */
const TENANT = `vfwall-${RUN}`;

type Envelope = typeof import('../providers/storage/envelope');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let envelope: Envelope;

const userIds: string[] = [];
const fileKeys: string[] = [];
const ids = {
  applicant: '', otherApplicant: '', reviewer: '', otherTenantReviewer: '', noGrant: '', suspended: '', noStaffRole: '',
  doc: '', purged: '', awaitingScan: '', shredded: '', foreignObject: '',
};
const PLAINTEXT = uniquePng(`viewer-fix-${RUN}`);

async function person(tenantId: string, opts: { roles: string[]; status?: string; permissions?: string[] }) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Viewer', lastName: `Wall${RUN}`, tenantId, isPhoneVerified: true,
    roles: opts.roles as never[], activeRole: opts.roles[0] as never, status: (opts.status ?? 'ACTIVE') as never,
    ...(opts.permissions ? { admin: { create: { permissions: opts.permissions } } } : {}),
  } });
  userIds.push(user.id);
  return user.id;
}

/** A sealed verification upload of `userId`, stored exactly as POST /upload stores one. */
async function sealedUpload(userId: string): Promise<string> {
  const dek = envelope.generateDek();
  const { ciphertext, iv, authTag } = envelope.encryptBuffer(PLAINTEXT, dek);
  const { getStorageProvider } = await import('../providers/storage/storage-provider');
  const { url } = await getStorageProvider().upload({
    buffer: ciphertext, filename: 'verification.enc', mimeType: 'application/octet-stream', folder: `verification/${userId}`,
  });
  fileKeys.push(url);
  await owner.encryptedObject.create({ data: {
    fileKey: url, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag),
    wrappedDek: new Uint8Array(await envelope.getKeyProvider()!.wrapDek(dek)),
    mimeType: 'image/png', sizeBytes: PLAINTEXT.length,
    sha256: createHash('sha256').update(Buffer.concat([PLAINTEXT, Buffer.from(url)])).digest('hex'), createdBy: userId,
  } });
  return url;
}

async function submission(userId: string, fileUrl: string, extra: { purgedAt?: Date } = {}): Promise<string> {
  const doc = await owner.verificationDocument.create({ data: { userId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'PENDING', ...extra } });
  return doc.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  envelope = await import('../providers/storage/envelope');
  envelope.resetKeyProviderForTests();

  await owner.tenant.create({ data: { id: TENANT, name: 'Viewer wall tenant', slug: TENANT, isActive: true } });
  ids.applicant = await person(TENANT, { roles: ['MOVER'] });
  ids.otherApplicant = await person(TENANT, { roles: ['MOVER'] });
  ids.reviewer = await person(TENANT, { roles: ['SUPER_ADMIN'], permissions: ['documents.review'] });
  ids.otherTenantReviewer = await person(PRODUCTION, { roles: ['SUPER_ADMIN'], permissions: ['documents.review'] });
  ids.noGrant = await person(TENANT, { roles: ['ADMIN'], permissions: ['*'] });
  ids.suspended = await person(TENANT, { roles: ['SUPER_ADMIN'], status: 'SUSPENDED', permissions: ['documents.review'] });
  ids.noStaffRole = await person(TENANT, { roles: ['CUSTOMER'], permissions: ['documents.review'] });

  ids.doc = await submission(ids.applicant, await sealedUpload(ids.applicant));
  ids.purged = await submission(ids.applicant, await sealedUpload(ids.applicant), { purgedAt: new Date() });
  const waiting = await sealedUpload(ids.applicant);
  ids.awaitingScan = await submission(ids.applicant, waiting);
  // Stored while the scanner was down: never served before its rescan answers CLEAN.
  await owner.uploadScanDebt.create({ data: { surface: 'verification', reason: 'bypass', fileKey: waiting, sealed: true, sha256: 'a'.repeat(64) } });
  const shredded = await sealedUpload(ids.applicant);
  ids.shredded = await submission(ids.applicant, shredded);
  await owner.encryptedObject.update({ where: { fileKey: shredded }, data: { wrappedDek: null, shreddedAt: new Date() } });
  // A submission pointing at SOMEONE ELSE's sealed upload: intact, decryptable, and never this applicant's to show.
  ids.foreignObject = await submission(ids.applicant, await sealedUpload(ids.otherApplicant));

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
  const { verificationRoutes } = await import('../modules/verification/verification.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
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
    envelope?.resetKeyProviderForTests();
    const { getStorageProvider } = await import('../providers/storage/storage-provider');
    for (const key of fileKeys) await getStorageProvider().delete(key).catch(() => {});
    await owner.uploadScanDebt.deleteMany({ where: { fileKey: { in: fileKeys } } });
    await owner.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await owner.encryptedObject.deleteMany({ where: { fileKey: { in: fileKeys } } });
    await owner.admin.deleteMany({ where: { userId: { in: userIds } } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: TENANT } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const render = (docId: string, reviewerId: string) => app.inject({ method: 'GET', url: envelope.mintRenderPath(docId, reviewerId, 60).path });
const refusal = (res: { statusCode: number; json: () => { error?: { code?: string } } }) => [res.statusCode, res.json().error?.code];

describe('[VIEWER-FIX] the document viewer under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a link minted for an active document reviewer of the applicant’s operator renders the document, byte for byte', async () => {
    const res = await render(ids.doc, ids.reviewer);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(Buffer.from(res.rawPayload).equals(PLAINTEXT)).toBe(true);
  });

  it('a reviewer of another operator, one without the grant, a suspended one and one without a staff role are refused as before (403)', async () => {
    for (const who of [ids.otherTenantReviewer, ids.noGrant, ids.suspended, ids.noStaffRole]) {
      expect(refusal(await render(ids.doc, who)), who).toEqual([403, 'DOCUMENT_REVIEWER_REQUIRED']);
    }
  });

  it('revoking the grant kills a link that is already open; restoring it opens it again', async () => {
    const path = envelope.mintRenderPath(ids.doc, ids.reviewer, 60).path;
    await owner.admin.update({ where: { userId: ids.reviewer }, data: { permissions: [] } });
    try {
      expect(refusal(await app.inject({ method: 'GET', url: path }))).toEqual([403, 'DOCUMENT_REVIEWER_REQUIRED']);
    } finally {
      await owner.admin.update({ where: { userId: ids.reviewer }, data: { permissions: ['documents.review'] } });
    }
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
  });

  it('an expired, forged or re-aimed link is refused as before', async () => {
    const past = Math.floor(Date.now() / 1000) - 5;
    const expired = await app.inject({ method: 'GET', url: `/api/v1/verification/render/${ids.doc}?expires=${past}&reviewer=${ids.reviewer}&sig=${envelope.signRenderToken(ids.doc, past, ids.reviewer)}` });
    expect(refusal(expired)).toEqual([410, 'LINK_EXPIRED']);
    const soon = Math.floor(Date.now() / 1000) + 60;
    const forged = await app.inject({ method: 'GET', url: `/api/v1/verification/render/${ids.doc}?expires=${soon}&reviewer=${ids.reviewer}&sig=${'0'.repeat(32)}` });
    expect(refusal(forged)).toEqual([403, 'BAD_SIGNATURE']);
    const reaimed = envelope.mintRenderPath(ids.doc, ids.reviewer, 60).path.replace(`reviewer=${ids.reviewer}`, `reviewer=${ids.otherTenantReviewer}`);
    expect(refusal(await app.inject({ method: 'GET', url: reaimed }))).toEqual([403, 'BAD_SIGNATURE']);
  });

  it('a purged or unknown document, an upload awaiting its malware scan, a shredded object and another person’s upload answer as before', async () => {
    expect(refusal(await render(ids.purged, ids.reviewer))).toEqual([410, 'DOCUMENT_PURGED']);
    expect(refusal(await render(`missing${RUN}`, ids.reviewer))).toEqual([410, 'DOCUMENT_PURGED']);
    expect(refusal(await render(ids.awaitingScan, ids.reviewer))).toEqual([409, 'AWAITING_MALWARE_SCAN']);
    expect(refusal(await render(ids.shredded, ids.reviewer))).toEqual([400, 'VERIFICATION_OBJECT_UNAVAILABLE']);
    expect(refusal(await render(ids.foreignObject, ids.reviewer))).toEqual([400, 'VERIFICATION_OBJECT_UNAVAILABLE']);
  });
});
