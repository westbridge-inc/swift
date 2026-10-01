/**
 * [DS625 · DOC-1 §9.4] Face evidence under a legal hold — the real routes, the
 * database and the local storage provider; only the outbound notifier is a stub.
 *
 * The signup selfie (the avatar object), the shift liveness checks and the
 * biometric face template are the person's face evidence. While a legal hold
 * names the person, none of it is destroyed: not by a selfie replacement, not by
 * the standing orphan sweep, not by account erasure. Each preservation is
 * recorded against the hold. Nothing is dropped: after release the sweep deletes
 * the kept selfie, and an erased person's liveness checks and face template go
 * with the release of the last hold on them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { getStorageProvider } from '../providers/storage/storage-provider';
import { queueStorageOrphan, retryStorageOrphans } from '../lib/storage-orphans';
import { placeDocLegalHold, releaseDocLegalHold } from '../modules/verification/legal-hold';
import { VerificationService } from '../modules/verification/verification.service';
import type { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

const DAY = 86_400_000;
const RUN = nanoid(8).replace(/[^A-Za-z0-9]/g, '0');
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-face-hold-${RUN}`);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const REASON = `Synthetic preservation ${RUN}`;
const log = { error: () => undefined };
const notifications = { send: vi.fn(async () => undefined) } as unknown as NotificationService;

let app: FastifyInstance;
// Fixtures and reads go through a plain client; only the routes under test use the app.
const db = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
let seq = 0;

async function person() {
  seq += 1;
  const id = `facehold-${RUN}-${seq}`;
  const user = await db.user.create({ data: {
    id, phone: `synthetic:${id}`, firstName: 'Synthetic', lastName: 'FaceHold', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    status: 'ACTIVE', isPhoneVerified: true, customer: { create: {} },
  } });
  const token = app.jwt.sign({ userId: id, role: 'CUSTOMER', jti: nanoid(8) });
  await db.session.create({ data: {
    userId: id, token, refreshToken: nanoid(48), deviceId: 'face-hold-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { id, tenantId: user.tenantId, token };
}

function postSelfie(token: string) {
  const boundary = `----swift${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="selfie.png"\r\ncontent-type: image/png\r\n\r\n`),
    PNG, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST', url: '/api/v1/auth/selfie', payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
}

const avatarOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { avatar: true } })).avatar!;
const stored = (key: string) => getStorageProvider().getObject(key).then(() => true, () => false);
/** The standing sweep (the expiry-sweep job's own call), kept to this suite's people. */
const sweep = (...users: string[]) => retryStorageOrphans(db.$extends({ query: { storageOrphan: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { userId: { in: users } }] } });
} } } }) as unknown as PrismaClient, getStorageProvider(), log, 100);
const heldEvents = (userId: string, holdId: string) =>
  db.documentPurgeEvent.findMany({ where: { userId, holdId, kind: 'FACE_EVIDENCE_HELD' }, orderBy: { createdAt: 'asc' } });

/** A document of the person on a canonical, never-written source name; PENDING only for a fraud target. */
async function submittedDocument(userId: string, name: string, status: 'PENDING' | 'APPROVED' = 'APPROVED') {
  const fileKey = `/uploads/verification/${userId}/${name}.enc`;
  await db.encryptedObject.create({ data: {
    fileKey, createdBy: userId, storageNamespace: await getStorageProvider().purgeNamespace!(),
    iv: new Uint8Array(12).fill(1), authTag: new Uint8Array(16).fill(2), wrappedDek: new Uint8Array(40).fill(3),
    sha256: 'a'.repeat(64), mimeType: 'image/jpeg', sizeBytes: 1,
  } });
  return db.verificationDocument.create({ data: {
    userId, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: fileKey, status, retentionExpiresAt: null,
  } });
}

/** DOC-1 §24.2: a fraud-class verdict escalates, and a different reviewer confirms it. Returns the fraud hold. */
async function fraudConfirmed(userId: string) {
  const doc = await submittedDocument(userId, 'fraud-target', 'PENDING');
  const reviewer = async (n: string) => (await db.user.create({ data: {
    id: `facehold-reviewer-${RUN}-${seq}-${n}`, phone: `synthetic:facehold-reviewer-${RUN}-${seq}-${n}`,
    firstName: 'Synthetic', lastName: `Reviewer ${n}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE',
  } })).id;
  const [first, second] = [await reviewer('a'), await reviewer('b')];
  const verification = new VerificationService(db, notifications, new SandboxKycProvider());
  expect((await verification.rejectDocument(doc.id, first, 'Synthetic suspicion', 'DUPLICATE')).status).toBe('PENDING');
  expect((await verification.rejectDocument(doc.id, second, 'Synthetic confirmation', 'DUPLICATE')).status).toBe('REJECTED');
  const fraud = await db.fraudCase.findFirstOrThrow({ where: { submissionId: doc.id } });
  const hold = await db.docLegalHold.findUniqueOrThrow({ where: { id: fraud.legalHoldId! } });
  expect(hold).toMatchObject({ subjectUserId: userId, subjectWide: true, releasedAt: null });
  // The person stays ACTIVE: the founder-pending block is an enforcement row, not a status.
  expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('ACTIVE');
  return hold.id;
}

const release = (holdId: string, by: string) => releaseDocLegalHold(db, { holdId, releasedBy: by, reason: `Synthetic release ${RUN}` });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['STORAGE_PROVIDER'] = 'local';
  process.env['UPLOAD_DIR'] = UPLOAD_DIR;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  // Holds, their events and the people they name are permanent provenance: they are retained.
  await app?.close();
  await db.$disconnect();
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe('[DS625 F1] face evidence is kept while a legal hold names the person', () => {
  it('a fraud-confirmed person may still replace the selfie; the old one is kept and recorded, and goes after release', async () => {
    const p = await person();
    expect((await postSelfie(p.token)).statusCode).toBe(200);
    const original = await avatarOf(p.id);
    // Control, no hold: a replacement deletes the previous selfie at once.
    expect((await postSelfie(p.token)).statusCode).toBe(200);
    const previous = await avatarOf(p.id);
    expect(await stored(original)).toBe(false);
    expect((await db.storageOrphan.findUniqueOrThrow({ where: { key: original } })).purgedAt).not.toBeNull();

    const holdId = await fraudConfirmed(p.id);
    // No new refusal: the person can still take a selfie, and the one it replaces is kept.
    const replaced = await postSelfie(p.token);
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(await avatarOf(p.id)).not.toBe(previous);
    expect(await stored(previous)).toBe(true);
    const orphan = await db.storageOrphan.findUniqueOrThrow({ where: { key: previous } });
    expect(orphan).toMatchObject({ userId: p.id, reason: 'REPLACED_SELFIE_DELETE_PENDING', purgedAt: null });
    const events = await heldEvents(p.id, holdId);
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({ evidence: 'AVATAR_OBJECT', orphanId: orphan.id, reason: 'REPLACED_SELFIE_DELETE_PENDING', holdIds: [holdId] });

    // The standing sweep keeps it while the hold lasts, and records it only once.
    expect(await sweep(p.id)).toBe(0);
    expect(await stored(previous)).toBe(true);
    expect(await heldEvents(p.id, holdId)).toHaveLength(1);
    // Released: the obligation that stayed open is honoured.
    await release(holdId, p.id);
    expect(await sweep(p.id)).toBe(1);
    expect(await stored(previous)).toBe(false);
    expect((await db.storageOrphan.findUniqueOrThrow({ where: { id: orphan.id } })).purgedAt).not.toBeNull();
  });

  it('the standing sweep never deletes a selfie under a hold, and deletes it once the hold is released', async () => {
    const p = await person();
    const { url } = await getStorageProvider().upload({ buffer: PNG, filename: 'swift-selfie.png', mimeType: 'image/png', folder: `avatars/${p.id}` });
    // An earlier replacement whose immediate delete did not complete: exactly what the sweep retries.
    const orphan = await queueStorageOrphan(db, { key: url, reason: 'REPLACED_SELFIE_DELETE_PENDING', userId: p.id, tenantId: p.tenantId });
    await submittedDocument(p.id, 'held-identity');
    const { hold } = await placeDocLegalHold(db, { subjectUserId: p.id, reason: REASON, ownerId: p.id, placedBy: p.id, reviewBy: new Date(Date.now() + 7 * DAY) });

    expect(await sweep(p.id)).toBe(0);
    expect(await stored(url)).toBe(true);
    expect((await db.storageOrphan.findUniqueOrThrow({ where: { id: orphan.id } })).purgedAt).toBeNull();
    expect((await heldEvents(p.id, hold.id)).map((e) => e.details)).toEqual([
      expect.objectContaining({ evidence: 'AVATAR_OBJECT', orphanId: orphan.id }),
    ]);

    await release(hold.id, p.id);
    expect(await sweep(p.id)).toBe(1);
    expect(await stored(url)).toBe(false);
    expect((await db.storageOrphan.findUniqueOrThrow({ where: { id: orphan.id } })).purgedAt).not.toBeNull();
  });

  it('account erasure under a hold that names a document keeps the selfie, liveness checks and face template, records them, and erases the rest', async () => {
    const p = await person();
    expect((await postSelfie(p.token)).statusCode).toBe(200);
    const selfie = await avatarOf(p.id);
    for (const n of [1, 2]) {
      await db.livenessCheck.create({ data: {
        userId: p.id, tenantId: p.tenantId, profile: 'DRIVER', selfieUrl: `/uploads/liveness/${p.id}/shift-${n}.jpg`, outcome: 'PASS',
      } });
    }
    await db.faceTemplate.create({ data: { accountId: p.id, embedding: Buffer.alloc(32, 9), modelVer: 'synthetic-1' } });
    const doc = await submittedDocument(p.id, 'named-by-hold');
    // A hold that names one document still names the person whose face that document was matched against.
    const { hold } = await placeDocLegalHold(db, {
      subjectUserId: p.id, documentIds: [doc.id], reason: REASON, ownerId: p.id, placedBy: p.id, reviewBy: new Date(Date.now() + 7 * DAY),
    });
    expect(hold.subjectWide).toBe(false);
    const second = await placeDocLegalHold(db, {
      subjectUserId: p.id, documentIds: [(await submittedDocument(p.id, 'named-by-second-hold')).id], reason: REASON, ownerId: p.id, placedBy: p.id,
      reviewBy: new Date(Date.now() + 7 * DAY),
    });

    const erased = await app.inject({ method: 'DELETE', url: '/api/v1/customer/account', headers: { authorization: `Bearer ${p.token}` } });
    expect(erased.statusCode, erased.body).toBe(202);
    expect(erased.json().data).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });

    // Kept: the selfie object, both liveness checks and the face template.
    expect(await stored(selfie)).toBe(true);
    expect(await db.livenessCheck.count({ where: { userId: p.id } })).toBe(2);
    expect(await db.faceTemplate.count({ where: { accountId: p.id } })).toBe(1);
    const avatarOrphan = await db.storageOrphan.findUniqueOrThrow({ where: { key: selfie } });
    expect(avatarOrphan).toMatchObject({ reason: 'ACCOUNT_DELETION_DELETE_PENDING', purgedAt: null });
    // Recorded against the hold, as the fence records its own deferrals.
    const events = await heldEvents(p.id, hold.id);
    expect(events.map((e) => (e.details as { evidence: string }).evidence).sort()).toEqual(['AVATAR_OBJECT', 'FACE_TEMPLATE', 'LIVENESS_CHECKS']);
    expect(events.find((e) => (e.details as { evidence: string }).evidence === 'LIVENESS_CHECKS')!.details).toMatchObject({ count: 2, holdIds: [hold.id, second.hold.id] });
    const deferred = await db.auditLog.findFirstOrThrow({ where: { action: 'ERASURE_DEFERRED_LEGAL_HOLD', entityId: p.id } });
    expect(deferred.changes).toMatchObject({ heldDocuments: 2, heldFaceEvidence: { avatarObject: 1, livenessChecks: 2, faceTemplates: 1 } });
    // Everything else was erased: the person is de-identified and signed out everywhere.
    expect(await db.user.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
      status: 'DEACTIVATED', phone: `deleted:${p.id}`, firstName: 'Deleted', lastName: 'User', avatar: null, selfieCapturedAt: null,
    });
    expect(await db.session.count({ where: { userId: p.id } })).toBe(0);

    // One hold released, one remaining: still kept.
    await release(hold.id, p.id);
    expect(await sweep(p.id)).toBe(0);
    expect(await stored(selfie)).toBe(true);
    expect(await db.livenessCheck.count({ where: { userId: p.id } })).toBe(2);
    // The last hold released: the erasure the person asked for completes.
    await release(second.hold.id, p.id);
    expect(await db.livenessCheck.count({ where: { userId: p.id } })).toBe(0);
    expect(await db.faceTemplate.count({ where: { accountId: p.id } })).toBe(0);
    expect(await db.documentPurgeEvent.findFirstOrThrow({ where: { userId: p.id, holdId: second.hold.id, kind: 'FACE_EVIDENCE_ERASED' } }))
      .toMatchObject({ details: { faceTemplates: 1, livenessChecks: 2 } });
    expect(await sweep(p.id)).toBe(1);
    expect(await stored(selfie)).toBe(false);
    expect((await db.storageOrphan.findUniqueOrThrow({ where: { id: avatarOrphan.id } })).purgedAt).not.toBeNull();
  });
});
