/**
 * [Row 331 · DSAR-ERASURE · GUARDRAILS §2] Account erasure takes EVERY upload, and forgets the fingerprint.
 *
 *  (a) An encrypted upload no document claims (an abandoned onboarding file, the optional
 *      L2 ID selfie, which is checked but never linked) is deleted with the account: bytes
 *      gone, key shredded, a receipt. So are the shift liveness selfies, whose rows were
 *      the only record of where the photos were.
 *  (c) After erasure the same document uploaded by someone else links nobody: the erased
 *      account's shredded objects no longer carry their content hash, and an object it
 *      still keeps under a legal hold never makes it a duplicate holder.
 *  A legal hold keeps everything; bytes whose absence is not confirmed stay an open
 *  obligation that the account tombstone's retry sweep finishes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { AccountService } from '../modules/user/account.service';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { placeDocLegalHold, releaseDocLegalHold } from '../modules/verification/legal-hold';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { signupSelfieFixture } from './helpers/verification-object';

const storage = new LocalStorageProvider();
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));

let app: FastifyInstance;
const ids: string[] = [];
const keys: string[] = [];
const NUM = String(Date.now()).slice(-6);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'account-upload-erasure-test');
const io = { in: () => ({ disconnectSockets: () => undefined }) };
const service = () => new AccountService({ prisma: app.prisma, log: app.log, io: io as never });
/** What the account tombstone's daily retry sweep runs for this person (retryAccountErasures → deleteAccount). */
const retry = (userId: string) => service().deleteAccount(userId);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

class ApprovingKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: `ok_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: `ok_${nanoid(6)}` }; }
  async getStatus(): Promise<'approved'> { return 'approved'; }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: ids } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: ids } } });
    await app.prisma.livenessCheck.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  });
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await app.close();
});

let seq = 0;
/** A customer account (erasable in the app). `onboarding` makes it a store owner mid-onboarding, as the collision suite does. */
async function person(onboarding = false) {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59262${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Upload', lastName: `Erasure${seq}`,
    roles: ['CUSTOMER'], activeRole: onboarding ? 'VENDOR_OWNER' : 'CUSTOMER', status: 'ACTIVE', countryCode: 'GY',
  } }));
  ids.push(u.id);
  if (onboarding) await signupSelfieFixture(app.prisma, u.id);
  return u.id;
}

/** What POST /verification/upload leaves behind: the ciphertext in the subject's namespace and its envelope. */
async function upload(userId: string, bytes = Buffer.from(`synthetic upload ${nanoid(12)}`)) {
  const { url } = await storage.upload({ buffer: bytes, filename: 'verification.enc', mimeType: 'application/octet-stream', folder: `verification/${userId}` });
  keys.push(url);
  await app.prisma.encryptedObject.create({ data: {
    fileKey: url, createdBy: userId, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(60, 3),
    mimeType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes),
  } });
  return { key: url, sha256: sha(bytes) };
}

async function livenessSelfie(userId: string, rows = 1) {
  const { url } = await storage.upload({ buffer: Buffer.from(`synthetic face ${nanoid(8)}`), filename: 'selfie.jpg', mimeType: 'application/octet-stream', folder: `liveness/${userId}` });
  keys.push(url);
  for (let i = 0; i < rows; i++) {
    await runWithTenant('swift-default', () => app.prisma.livenessCheck.create({ data: { userId, profile: 'DRIVER', selfieUrl: url, outcome: 'PASS' } }));
  }
  return url;
}

const envelope = (key: string) => system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: key } }));
const gone = (key: string) => expect(storage.getObject(key)).rejects.toMatchObject({ code: 'ENOENT' });

describe('(a) an upload no document claims goes with the account', () => {
  it('deletes the bytes, shreds the key, forgets the hash and writes a receipt — the L2 selfie included', async () => {
    const userId = await person();
    const abandoned = await upload(userId);
    const l2Selfie = await upload(userId);
    expect(await service().deleteAccount(userId)).toMatchObject({ deleted: true });
    for (const u of [abandoned, l2Selfie]) {
      await gone(u.key);
      const e = await envelope(u.key);
      expect(e.wrappedDek).toBeNull();
      expect(e.shreddedAt).not.toBeNull();
      expect(e.sha256).toBe('erased');
    }
    const receipts = await system(() => app.prisma.deletionReceipt.findMany({ where: { subjectId: userId, docTypeCode: 'unclaimed_upload' } }));
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) => r.verificationProbeResult === 'CONFIRMED_ABSENT')).toBe(true);
    expect(receipts.map((r) => Buffer.from(r.contentSha256!).toString('hex')).sort()).toEqual([abandoned.sha256, l2Selfie.sha256].sort());
  });

  it('leaves a claimed upload to its document: the document pass purges it under the document’s own receipt', async () => {
    const userId = await person();
    const claimed = await upload(userId);
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId, role: 'CUSTOMER', docType: 'national_id', fileUrl: claimed.key } }));
    expect(await service().deleteAccount(userId)).toMatchObject({ deleted: true });
    await gone(claimed.key);
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { subjectId: userId, docTypeCode: 'unclaimed_upload' } }))).toBe(0);
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { subjectId: userId, docTypeCode: 'national_id' } }))).toBe(1);
    expect((await envelope(claimed.key)).sha256).toBe('erased');
  });

  it('a legal hold on the person keeps every upload; the retry sweep erases them after release', async () => {
    const userId = await person();
    const doc = await upload(userId);
    const loose = await upload(userId);
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId, role: 'CUSTOMER', docType: 'national_id', fileUrl: doc.key } }));
    const { hold } = await placeDocLegalHold(app.prisma, { subjectUserId: userId, placedBy: userId, ownerId: userId, reason: 'Synthetic preservation case', reviewBy: new Date(Date.now() + 2 * 86_400_000) });
    expect(await service().deleteAccount(userId)).toMatchObject({ deleted: false, status: 'PENDING_LEGAL_HOLD' });
    for (const u of [doc, loose]) {
      expect((await storage.getObject(u.key)).length).toBeGreaterThan(0);
      const e = await envelope(u.key);
      expect(e.wrappedDek).not.toBeNull();
      expect(e.sha256).toBe(u.sha256);
    }
    await releaseDocLegalHold(app.prisma, { holdId: hold.id, releasedBy: userId, reason: 'Synthetic case closed' });
    await retry(userId);
    for (const u of [doc, loose]) { await gone(u.key); expect((await envelope(u.key)).sha256).toBe('erased'); }
  });

  it('bytes that survive keep the upload open (key already shredded); the retry finishes it without a sign-in', async () => {
    const userId = await person();
    const u = await upload(userId);
    const realDelete = storage.delete.bind(storage);
    vi.spyOn(storage, 'delete').mockImplementation(async (key) => { if (key !== u.key) await realDelete(key); });
    expect(await service().deleteAccount(userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    const open = await envelope(u.key);
    expect(open.wrappedDek).toBeNull();
    expect(open.shreddedAt).toBeNull();
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { subjectId: userId, docTypeCode: 'unclaimed_upload' } }))).toBe(0);
    vi.restoreAllMocks();
    expect(await retry(userId)).toMatchObject({ deleted: true });
    await gone(u.key);
    const closed = await envelope(u.key);
    expect(closed.shreddedAt).not.toBeNull();
    expect(closed.sha256).toBe('erased');
  });

  it('never deletes an object another account’s document points at', async () => {
    const userId = await person();
    const other = await person();
    const u = await upload(userId);
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId: other, role: 'CUSTOMER', docType: 'national_id', fileUrl: u.key.replace('/uploads/', '') } }));
    const del = vi.spyOn(storage, 'delete');
    await service().deleteAccount(userId);
    expect(del).not.toHaveBeenCalledWith(u.key);
    expect((await storage.getObject(u.key)).length).toBeGreaterThan(0);
    expect((await envelope(u.key)).wrappedDek).not.toBeNull();
  });
});

describe('(a) the shift liveness selfies go with the account', () => {
  it('deletes every photo, then its rows', async () => {
    const userId = await person();
    const first = await livenessSelfie(userId, 2);
    const second = await livenessSelfie(userId);
    expect(await service().deleteAccount(userId)).toMatchObject({ deleted: true });
    await gone(first);
    await gone(second);
    expect(await system(() => app.prisma.livenessCheck.count({ where: { userId } }))).toBe(0);
  });

  it('a photo whose absence is not confirmed keeps its row as the obligation; the retry finishes it', async () => {
    const userId = await person();
    const photo = await livenessSelfie(userId);
    const realDelete = storage.delete.bind(storage);
    vi.spyOn(storage, 'delete').mockImplementation(async (key) => { if (key !== photo) await realDelete(key); });
    expect(await service().deleteAccount(userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    expect(await system(() => app.prisma.livenessCheck.count({ where: { userId } }))).toBe(1);
    vi.restoreAllMocks();
    expect(await retry(userId)).toMatchObject({ deleted: true });
    await gone(photo);
    expect(await system(() => app.prisma.livenessCheck.count({ where: { userId } }))).toBe(0);
  });
});

describe('(c) after erasure the same document links nobody', () => {
  const submit = (userId: string, fileKey: string) => runWithTenant('swift-default', () => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ApprovingKyc())
    .submitDocument(userId, 'RESTAURANT', 'owner_national_id', fileKey, 'v1'));
  const docContent = (accountId: string) => system(() => app.prisma.identityKey.count({ where: { type: 'DOC_CONTENT', accountId } }));

  it('an erased account’s purged document is no duplicate: a new account with the same bytes auto-approves, nobody is linked', async () => {
    const bytes = Buffer.from(`same physical document ${nanoid(12)}`);
    const erased = await person(true);
    const theirs = await upload(erased, bytes);
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId: erased, role: 'VENDOR_OWNER', docType: 'owner_national_id', fileUrl: theirs.key } }));
    expect(await service().deleteAccount(erased)).toMatchObject({ deleted: true });
    const newcomer = await person(true);
    const mine = await upload(newcomer, bytes);
    const doc = await submit(newcomer, mine.key);
    expect(doc.status).toBe('APPROVED');
    expect(await docContent(erased)).toBe(0);
    expect(await docContent(newcomer)).toBe(0);
  });

  it('an object an erased account keeps under a legal hold links nobody either; a live holder still does', async () => {
    const bytes = Buffer.from(`held physical document ${nanoid(12)}`);
    const held = await person(true);
    const theirs = await upload(held, bytes);
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId: held, role: 'VENDOR_OWNER', docType: 'owner_national_id', fileUrl: theirs.key } }));
    await placeDocLegalHold(app.prisma, { subjectUserId: held, placedBy: held, ownerId: held, reason: 'Synthetic preservation case', reviewBy: new Date(Date.now() + 2 * 86_400_000) });
    expect(await service().deleteAccount(held)).toMatchObject({ status: 'PENDING_LEGAL_HOLD' });
    expect((await envelope(theirs.key)).sha256).toBe(theirs.sha256);

    const newcomer = await person(true);
    const mine = await upload(newcomer, bytes);
    expect((await submit(newcomer, mine.key)).status).toBe('APPROVED');
    expect(await docContent(held)).toBe(0);

    // Control: a LIVE account with the same bytes is still a duplicate, and both are linked.
    const live = await person(true);
    const again = await upload(live, bytes);
    expect((await submit(live, again.key)).status).toBe('PENDING');
    expect(await docContent(live)).toBe(1);
    expect(await docContent(held)).toBe(0);
  });
});
