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
  mintRenderPath, resetKeyProviderForTests, signRenderToken,
} from '../providers/storage/envelope';
import { getStorageProvider } from '../providers/storage/storage-provider';
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

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
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
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  if (userId) {
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: userId } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId } });
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  }
  await app.close();
});

function uploadMultipart() {
  const boundary = `----swift${marker}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="doc.png"\r\ncontent-type: image/png\r\n\r\n`,
    ),
    PLAINTEXT,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
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

  it('wrap/unwrap round-trips; a different KEK cannot unwrap', async () => {
    const kp = new EnvKeyProvider(crypto.randomBytes(32).toString('base64'));
    const dek = generateDek();
    const wrapped = await kp.wrapDek(dek);
    expect((await kp.unwrapDek(wrapped)).equals(dek)).toBe(true);

    const other = new EnvKeyProvider(crypto.randomBytes(32).toString('base64'));
    await expect(other.unwrapDek(wrapped)).rejects.toThrow();
  });
});

describe('encrypted upload → render → shred', () => {
  let fileKey: string;
  let docId: string;

  it('stores ONLY ciphertext and records the envelope metadata', async () => {
    const res = await uploadMultipart();
    expect(res.statusCode).toBe(200);
    fileKey = res.json().data.url;

    const meta = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey } });
    expect(meta.wrappedDek).toBeTruthy();
    expect(meta.mimeType).toBe('image/png');
    expect(meta.sizeBytes).toBe(PLAINTEXT.length);

    // The object in storage must NOT be the plaintext.
    const stored = await getStorageProvider().getObject(fileKey);
    expect(stored.equals(PLAINTEXT)).toBe(false);
    expect(stored.includes(marker)).toBe(false);
  });

  it('the minted render link decrypts back to the original bytes', async () => {
    const doc = await app.prisma.verificationDocument.create({
      data: { userId, role: 'MOVER', docType: 'national_id', fileUrl: fileKey, status: 'PENDING' },
    });
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
    expect(res.json().error.code).toBe('DOCUMENT_SHREDDED');
  });
});

describe('retention purge shreds the envelope', () => {
  it('purgeExpiredDocuments nulls wrappedDek alongside the object delete', async () => {
    const up = await uploadMultipart();
    const key = up.json().data.url;
    await app.prisma.verificationDocument.create({
      data: {
        userId, role: 'MOVER', docType: 'police_clearance', fileUrl: key, status: 'REJECTED',
        retentionExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const { VerificationService } = await import('../modules/verification/verification.service');
    const { NotificationService } = await import('../modules/notification/notification.service');
    const { getKycProvider } = await import('../providers/kyc/kyc-provider');
    const svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    const purged = await svc.purgeExpiredDocuments();
    expect(purged).toBeGreaterThanOrEqual(1);

    const meta = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: key } });
    expect(meta.wrappedDek).toBeNull();
    expect(meta.shreddedAt).toBeTruthy();
  });
});
