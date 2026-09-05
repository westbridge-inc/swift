import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import multipart from '@fastify/multipart';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { mintRenderPath, resetKeyProviderForTests } from '../providers/storage/envelope';
import { getStorageProvider } from '../providers/storage/storage-provider';

// ---------------------------------------------------------------------------
// [DOC-1 §10.5] test_characterization_legacy_upload_paths
//
// DOC-1 forbids changing the document system before its current behaviour is
// pinned. Most of it already is: verification.test.ts (checklists, consent,
// approve/reject flows, retention purge), envelope-encryption.test.ts (the
// vault: ciphertext only, render tokens, crypto-shred, duplicate-hash alert),
// verification-hardening.test.ts (expiry sweep, GEI licence, SLA). This file
// pins what those do not, so the REWIRE in Movement 0's plan has a floor:
//   1. the upload gate — mime allowlist and magic-byte sniff refuse before storage
//   2. the plaintext fallback when no MASTER_KEK is configured
//   3. the render path never lets a document be cached (Cache-Control: no-store)
//   4. the approval expiry rule [A-19]: an expiring type needs a printed date,
//      never a past one; a non-expiring type stores none
// ---------------------------------------------------------------------------

let app: FastifyInstance;      // verification routes + multipart (the upload/render surface)
let adminApp: FastifyInstance; // admin routes (the review surface) — mounted apart: the harness
                               // cannot start @fastify/multipart with both route trees in one app
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const userIds: string[] = [];
const docIds: string[] = [];
const uploadedKeys: string[] = [];
let moverToken = '';
let adminToken = '';
const REASON = 'Document review, onboarding queue, ticket GY-8001';
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TEST_KEK = Buffer.alloc(32, 7).toString('base64');

function uploadAs(bearer: string, bytes: Buffer, mime: string, filename = 'doc.png') {
  const boundary = `----swift${RUN}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
}
const approve = (docId: string, payload: Record<string, unknown> = {}) => adminApp.inject({
  method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, payload,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON } });
async function pendingDoc(docType: string) {
  const d = await app.prisma.verificationDocument.create({ data: {
    userId: userIds[1]!, role: 'RIDER', docType, fileUrl: `verification/${userIds[1]}/${docType}-${RUN}`, status: 'PENDING',
    consentAt: new Date(), privacyNoticeVersion: 'test-1' } });
  docIds.push(d.id); return d;
}

beforeAll(async () => {
  delete process.env['MASTER_KEK']; resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin);
  await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59268${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Doc', lastName: `Admin${RUN}`,
    roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
  const mover = await app.prisma.user.create({ data: {
    phone: `+59267${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Doc', lastName: `Mover${RUN}`,
    roles: ['RIDER'], activeRole: 'RIDER', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(admin.id, mover.id);
  for (const [u, dev] of [[admin, 'doc-admin'], [mover, 'doc-mover']] as const) {
    const token = app.jwt.sign({ userId: u.id, role: u.activeRole, jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: dev, deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    if (u.id === admin.id) adminToken = token; else moverToken = token;
  }
});

afterAll(async () => {
  delete process.env['MASTER_KEK']; resetKeyProviderForTests();
  for (const key of uploadedKeys) await getStorageProvider().delete(key).catch(() => {});
  await runWithoutTenant(async () => {
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: userIds } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'doc1').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'doc1').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'doc1');
  await adminApp.close();
  await app.close();
});

describe('test_characterization_legacy_upload_paths', () => {
  describe('1. the upload gate refuses before anything is stored', () => {
    it('a mime type outside the allowlist is refused (BAD_TYPE)', async () => {
      const res = await uploadAs(moverToken, Buffer.from('hello'), 'text/plain', 'notes.txt');
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error?.code ?? res.json().code).toBe('BAD_TYPE');
    });
    it('a file whose bytes do not match its declared format is refused (BAD_CONTENT)', async () => {
      const res = await uploadAs(moverToken, Buffer.from('not really a png at all'), 'image/png');
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error?.code ?? res.json().code).toBe('BAD_CONTENT');
    });
    it('a PDF must begin with %PDF-', async () => {
      const res = await uploadAs(moverToken, Buffer.from('<html>'), 'application/pdf', 'doc.pdf');
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code ?? res.json().code).toBe('BAD_CONTENT');
    });
  });

  describe('2. without MASTER_KEK the object is stored as-is and no envelope row is written', () => {
    it('plaintext fallback', async () => {
      const res = await uploadAs(moverToken, PNG_1x1, 'image/png');
      expect(res.statusCode, res.body).toBe(200);
      const { url } = res.json().data as { url: string };
      uploadedKeys.push(url);
      expect(url).toContain(`verification/${userIds[1]}`);
      expect(url.endsWith('.enc')).toBe(false);
      expect(await app.prisma.encryptedObject.findUnique({ where: { fileKey: url } })).toBeNull();
    });
  });

  describe('3. the render path never lets a document be cached', () => {
    it('Cache-Control: no-store, inline, decrypted only through a minted token', async () => {
      process.env['MASTER_KEK'] = TEST_KEK; resetKeyProviderForTests();
      try {
        const up = await uploadAs(moverToken, PNG_1x1, 'image/png');
        expect(up.statusCode, up.body).toBe(200);
        const { url } = up.json().data as { url: string };
        uploadedKeys.push(url);
        expect(url.endsWith('.enc')).toBe(true);
        const doc = await app.prisma.verificationDocument.create({ data: {
          userId: userIds[1]!, role: 'RIDER', docType: 'national_id', fileUrl: url, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'test-1' } });
        docIds.push(doc.id);
        const { path } = mintRenderPath(doc.id, 60);
        const res = await app.inject({ method: 'GET', url: path });
        expect(res.statusCode, res.body.slice(0, 120)).toBe(200);
        expect(res.headers['cache-control']).toContain('no-store');
        expect(String(res.headers['content-disposition'])).toContain('inline');
        expect(res.headers['content-type']).toContain('image/png');
        expect(Buffer.from(res.rawPayload).equals(PNG_1x1), 'the bytes come back decrypted').toBe(true);
      } finally { delete process.env['MASTER_KEK']; resetKeyProviderForTests(); }
    });
  });

  describe('4. [A-19] the approval expiry rule', () => {
    it('an expiring type refuses approval without a printed date (EXPIRY_REQUIRED)', async () => {
      const d = await pendingDoc('police_clearance');
      const res = await approve(d.id, {});
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error?.code ?? res.json().code).toBe('EXPIRY_REQUIRED');
      expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('PENDING');
    });
    it('a date already passed is refused (EXPIRY_IN_PAST)', async () => {
      const d = await pendingDoc('police_clearance');
      const res = await approve(d.id, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error?.code ?? res.json().code).toBe('EXPIRY_IN_PAST');
    });
    it('a future printed date is stored with the approval', async () => {
      const d = await pendingDoc('police_clearance');
      const future = new Date(Date.now() + 300 * 86_400_000);
      const res = await approve(d.id, { expiresAt: future.toISOString() });
      expect(res.statusCode, res.body).toBe(200);
      const fresh = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: d.id } });
      expect(fresh.status).toBe('APPROVED');
      expect(fresh.expiresAt?.toISOString().slice(0, 10)).toBe(future.toISOString().slice(0, 10));
      expect(fresh.reviewedBy).toBe(userIds[0]);
    });
    it('a non-expiring type approves without a date and stores none', async () => {
      const d = await pendingDoc('business_registration');
      const res = await approve(d.id, {});
      expect(res.statusCode, res.body).toBe(200);
      const fresh = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: d.id } });
      expect(fresh.status).toBe('APPROVED');
      expect(fresh.expiresAt).toBeNull();
    });
  });
});
