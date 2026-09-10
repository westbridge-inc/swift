import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import {
  EnvKeyProvider, decryptBuffer, encryptBuffer, generateDek,
  mintRenderPath, resetKeyProviderForTests, signRenderToken, verifyRenderToken,
} from '../providers/storage/envelope';
import { getStorageProvider } from '../providers/storage/storage-provider';
import { canonicalVerificationObjectKey, verificationObjectKeyIsNamespacedTo } from '../modules/verification/storage-ownership';
import { submitDocumentWithUpload } from './helpers/verification-upload';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Envelope encryption (onboarding spec §5): the bucket only ever holds
// ciphertext; the wrapped DEK is the document's life switch — nulling it is
// the crypto-shred that makes even backups unrecoverable.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let userId: string;
const marker = nanoid(6).toLowerCase();
// Real PNG magic at offset 0 — the upload route magic-byte-sniffs content now.
const PLAINTEXT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`swift-envelope-test-${marker}`),
]);
const ORIGINAL_BIOMETRIC_FLAG = process.env['FEATURE_BIOMETRIC_FACE_MATCH'];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = '0';
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();

  // Direct user + session (the orders.test pattern) — no OTP dance needed.
  const user = await app.prisma.user.create({
    data: {
      phone: `+59267${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Env', lastName: 'Crypt',
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true,
    },
  });
  userId = user.id;
  token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'envelope-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
});

afterAll(async () => {
  if (ORIGINAL_BIOMETRIC_FLAG === undefined) delete process.env['FEATURE_BIOMETRIC_FACE_MATCH'];
  else process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = ORIGINAL_BIOMETRIC_FLAG;
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  if (userId) {
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: userId } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    // The immutable upload ledger intentionally retains its synthetic owner and
    // consumed document in this isolated test database.
  }
  await app.close();
});

type UploadIntent = {
  purpose: 'CHECKLIST_DOCUMENT' | 'IDENTITY_DOCUMENT' | 'IDENTITY_SELFIE';
  role: 'MOVER' | 'CUSTOMER';
  docType?: string;
};

function uploadAs(
  bearer: string,
  bytes: Buffer,
  intent: UploadIntent = { purpose: 'CHECKLIST_DOCUMENT', role: 'MOVER', docType: 'police_clearance' },
) {
  const boundary = `----swift${marker}`;
  const query = new URLSearchParams({ purpose: intent.purpose, role: intent.role });
  if (intent.docType) query.set('docType', intent.docType);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="doc.png"\r\ncontent-type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/v1/verification/upload?${query.toString()}`,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}
function uploadMultipart() {
  return uploadAs(token, PLAINTEXT);
}

async function uploadClaim(response: Awaited<ReturnType<typeof uploadMultipart>>) {
  const uploadId = response.json().data.uploadId as string;
  const claim = await app.prisma.verificationUpload.findUniqueOrThrow({
    where: { id: uploadId },
    select: { providerKey: true, objectVersion: true, purpose: true, roleKey: true, docType: true },
  });
  if (!claim.objectVersion) throw new Error('verification fixture did not seal an object generation');
  return { uploadId, ...claim, objectVersion: claim.objectVersion };
}

describe('crypto primitives', () => {
  it('round-trips and rejects a tampered auth tag', () => {
    const dek = generateDek();
    const { ciphertext, iv, authTag } = encryptBuffer(PLAINTEXT, dek);
    expect(ciphertext.equals(PLAINTEXT)).toBe(false);
    expect(decryptBuffer(ciphertext, dek, iv, authTag).equals(PLAINTEXT)).toBe(true);

    const badTag = Buffer.from(authTag);
    badTag[0] = badTag[0]! ^ 0xff;
    expect(() => decryptBuffer(ciphertext, dek, iv, badTag)).toThrow();
  });

  it('SWIFT-106: verifyRenderToken is constant-time, accepts valid, rejects tampered/wrong-length', () => {
    const docId = 'doc-abc';
    const expires = 1_900_000_000;
    const good = signRenderToken(docId, expires);
    expect(verifyRenderToken(docId, expires, good)).toBe(true);
    // One byte flipped, SAME length — timingSafeEqual still compares fully.
    const tampered = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    expect(verifyRenderToken(docId, expires, tampered)).toBe(false);
    // Wrong length must return false, never throw (timingSafeEqual throws on ≠ length).
    expect(verifyRenderToken(docId, expires, good.slice(0, 10))).toBe(false);
    // Bound to the exact docId + expiry.
    expect(verifyRenderToken('other-doc', expires, good)).toBe(false);
  });

  it('wrap/unwrap round-trips; a different KEK cannot unwrap', async () => {
    const kp = new EnvKeyProvider(crypto.randomBytes(32).toString('base64'));
    const dek = generateDek();
    const wrapped = await kp.wrapDek(dek);
    expect((await kp.unwrapDek(wrapped)).equals(dek)).toBe(true);

    const other = new EnvKeyProvider(crypto.randomBytes(32).toString('base64'));
    await expect(other.unwrapDek(wrapped)).rejects.toThrow();
  });
});

describe('verification object ownership', () => {
  it('canonicalizes provider spellings and rejects URLs, traversal and another account namespace', () => {
    expect(canonicalVerificationObjectKey(`/uploads/verification/${userId}/a.enc`)).toBe(`verification/${userId}/a.enc`);
    expect(canonicalVerificationObjectKey(`verification/${userId}/a.enc`)).toBe(`verification/${userId}/a.enc`);
    expect(canonicalVerificationObjectKey('https://objects.example/victim.enc')).toBeNull();
    expect(canonicalVerificationObjectKey(`/uploads/verification/${userId}/../victim.enc`)).toBeNull();
    expect(verificationObjectKeyIsNamespacedTo(`/uploads/verification/other/a.enc`, userId)).toBe(false);
  });

  it('refuses a foreign upload at intake, render and DSAR erasure without touching its bytes or key', async () => {
    const victimUpload = await uploadMultipart();
    expect(victimUpload.statusCode).toBe(200);
    const victimClaim = await uploadClaim(victimUpload);
    const victimKey = victimClaim.providerKey;
    const attacker = await app.prisma.user.create({
      data: {
        phone: `+59266${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Object', lastName: 'Boundary', roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
        isPhoneVerified: true,
      },
    });
    const attackerToken = app.jwt.sign({ userId: attacker.id, role: 'MOVER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: attacker.id, token: attackerToken, refreshToken: nanoid(48), deviceId: 'ownership-test', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    let poisonedDocId = '';
    try {
      const submit = await app.inject({
        method: 'POST',
        url: '/api/v1/verification/documents',
        headers: { authorization: `Bearer ${attackerToken}`, 'content-type': 'application/json' },
        payload: {
          role: 'MOVER',
          docType: 'police_clearance',
          uploadId: victimClaim.uploadId,
          consent: true,
          privacyNoticeVersion: 'test-v1',
        },
      });
      expect(submit.statusCode, submit.body).toBe(409);
      expect(submit.json().error.code).toBe('UPLOAD_CLAIM_INVALID');

      // Simulate a legacy/poisoned row to prove every read/destructive sink is
      // independently fail-closed even if intake was bypassed in the past.
      const poisoned = await app.prisma.verificationDocument.create({
        data: { userId: attacker.id, role: 'MOVER', docType: 'police_clearance', fileUrl: victimKey, status: 'PENDING' },
      });
      poisonedDocId = poisoned.id;
      const rendered = await app.inject({ method: 'GET', url: mintRenderPath(poisoned.id, 60).path });
      expect(rendered.statusCode, rendered.body).toBe(410);
      expect(rendered.json().error.code).toBe('DOCUMENT_OWNERSHIP_INVALID');

      const erased = await app.inject({
        method: 'POST',
        url: '/api/v1/verification/dsar/documents/erase',
        headers: { authorization: `Bearer ${attackerToken}`, 'content-type': 'application/json' },
        payload: { documentIds: [poisoned.id] },
      });
      expect(erased.statusCode, erased.body).toBe(409);
      expect(erased.json().error.code).toBe('DOCUMENT_OBJECT_NOT_OWNED');

      expect((await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: victimKey } })).wrappedDek).toBeTruthy();
      await expect(getStorageProvider().getObject(victimKey, victimClaim.objectVersion)).resolves.toBeInstanceOf(Buffer);
    } finally {
      if (poisonedDocId) await app.prisma.verificationDocument.deleteMany({ where: { id: poisonedDocId } });
      await app.prisma.session.deleteMany({ where: { userId: attacker.id } });
      await app.prisma.customer.deleteMany({ where: { userId: attacker.id } });
      await app.prisma.user.deleteMany({ where: { id: attacker.id } }).catch(() => {});
      await app.prisma.encryptedObject.deleteMany({ where: { fileKey: victimKey } });
      await getStorageProvider().deleteExact(victimKey, victimClaim.objectVersion);
    }
  });
});

describe('encrypted upload → render → shred', () => {
  let fileKey: string;
  let uploadId: string;
  let objectVersion: string;
  let docId: string;

  it('stores ONLY ciphertext and records the envelope metadata', async () => {
    const res = await uploadMultipart();
    expect(res.statusCode).toBe(200);
    const claim = await uploadClaim(res);
    fileKey = claim.providerKey;
    uploadId = claim.uploadId;
    objectVersion = claim.objectVersion;
    expect(claim).toMatchObject({ purpose: 'CHECKLIST_DOCUMENT', roleKey: 'MOVER', docType: 'police_clearance' });

    const meta = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey } });
    expect(meta.wrappedDek).toBeTruthy();
    expect(meta.mimeType).toBe('image/png');
    expect(meta.sizeBytes).toBe(PLAINTEXT.length);

    // The object in storage must NOT be the plaintext.
    const stored = await getStorageProvider().getObject(fileKey, objectVersion);
    expect(stored.equals(PLAINTEXT)).toBe(false);
    expect(stored.includes(marker)).toBe(false);
  });

  it('the minted render link decrypts back to the original bytes', async () => {
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/verification/documents',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {
        role: 'MOVER',
        docType: 'police_clearance',
        uploadId,
        consent: true,
        privacyNoticeVersion: 'test-v1',
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const doc = submitted.json().data;
    docId = doc.id;

    const minted = mintRenderPath(docId, 60);
    const res = await app.inject({ method: 'GET', url: minted.path });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(res.rawPayload).equals(PLAINTEXT)).toBe(true);
  });

  it('rejects a bad signature and an expired token', async () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/verification/render/${docId}?expires=${expires}&sig=${'0'.repeat(32)}`,
    });
    expect(bad.statusCode).toBe(403);

    const past = Math.floor(Date.now() / 1000) - 5;
    const expired = await app.inject({
      method: 'GET',
      url: `/api/v1/verification/render/${docId}?expires=${past}&sig=${signRenderToken(docId, past)}`,
    });
    expect(expired.statusCode).toBe(410);
  });

  it('crypto-shred makes the document permanently unrecoverable', async () => {
    await app.prisma.encryptedObject.update({
      where: { fileKey },
      data: { wrappedDek: null, shreddedAt: new Date() },
    });
    const minted = mintRenderPath(docId, 60);
    const res = await app.inject({ method: 'GET', url: minted.path });
    expect(res.statusCode).toBe(410);
    // Ownership validation now proves the live envelope before the render path;
    // a shredded envelope therefore fails closed at that earlier boundary.
    expect(res.json().error.code).toBe('DOCUMENT_OWNERSHIP_INVALID');
  });
});

describe('retention purge shreds the envelope', () => {
  it('purgeExpiredDocuments nulls wrappedDek alongside the object delete', async () => {
    const { VerificationService } = await import('../modules/verification/verification.service');
    const { NotificationService } = await import('../modules/notification/notification.service');
    const { getKycProvider } = await import('../providers/kyc/kyc-provider');
    const svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    const seeded = await submitDocumentWithUpload(app.prisma, svc, {
      userId,
      roleKey: 'MOVER',
      docType: 'police_clearance',
      marker: `auto-reject-retention-${marker}`,
    });
    expect(seeded.document.status).toBe('REJECTED');
    const key = seeded.primary.providerKey;
    await app.prisma.verificationDocument.update({
      where: { id: seeded.document.id },
      data: { retentionExpiresAt: new Date(Date.now() - 1000) },
    });
    const purged = await svc.purgeExpiredDocuments();
    expect(purged).toBeGreaterThanOrEqual(1);

    const meta = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: key } });
    expect(meta.wrappedDek).toBeNull();
    expect(meta.shreddedAt).toBeTruthy();
  });
});

describe('duplicate-document detection [SWIFT-078]', () => {
  it('flags a document already on another account and alerts admins', async () => {
    const admin = await app.prisma.user.create({
      data: { phone: `+59268${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Adm', lastName: 'In', roles: ['ADMIN'] as never[], activeRole: 'ADMIN' as never, isPhoneVerified: true },
    });
    const userB = await app.prisma.user.create({
      data: { phone: `+59269${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Env', lastName: 'B', roles: ['MOVER'] as never[], activeRole: 'MOVER' as never, isPhoneVerified: true },
    });
    const tokenB = app.jwt.sign({ userId: userB.id, role: 'MOVER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: userB.id, token: tokenB, refreshToken: nanoid(48), deviceId: 't', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });

    // A distinct valid PNG so this test doesn't collide with the others' hash.
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`dup-${marker}`)]);

    const a = await uploadAs(token, bytes); // applicant A
    expect(a.statusCode).toBe(200);
    expect(a.json().data.duplicate).toBe(false);

    const b = await uploadAs(tokenB, bytes); // applicant B — same physical document
    expect(b.statusCode).toBe(200);
    // RED before SWIFT-078: no detection → duplicate false and no admin alert.
    expect(b.json().data.duplicate).toBe(true);

    const alert = await app.prisma.notification.findFirst({
      where: { userId: admin.id, data: { path: ['kind'], equals: 'dup_doc' } },
    });
    expect(alert).not.toBeNull();

    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: [userB.id] } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: [admin.id, userB.id] } } });
    await app.prisma.session.deleteMany({ where: { userId: userB.id } });
    await app.prisma.user.deleteMany({ where: { id: admin.id } }).catch(() => {});
    // userB remains as the owner of its append-only upload authority.
  });
});
