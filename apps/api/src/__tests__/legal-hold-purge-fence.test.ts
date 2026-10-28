/**
 * [Row 243 · DOC-INV-14 · GUARDRAILS §2] A legal hold always beats a document purge.
 * The purge destroys bytes only under the person's row lock and only while the document is
 * still unheld; placing a hold takes the same lock. So, whichever comes first:
 *  - a hold being placed: the purge waits, sees the hold, destroys nothing;
 *  - a purge already destroying: the hold waits, then does not claim the destroyed document.
 * Covers the retention reaper, the post-decision image purge (R24) and data-subject erasure.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { placeDocLegalHold, placeDocLegalHoldIn } from '../modules/verification/legal-hold';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { AccountService } from '../modules/user/account.service';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const storage = new LocalStorageProvider();
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));

let app: FastifyInstance;
const ids: string[] = [];
const keys: string[] = [];
const NUM = String(Date.now()).slice(-6);
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'legal-hold-purge-fence-test');

class NoKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: 'x' }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: 'x' }; }
  async getStatus(): Promise<'approved'> { return 'approved'; }
}
const service = () => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new NoKyc());

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
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
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  });
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await app.close();
});

async function personWithDocument(extra: Record<string, unknown>) {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59263${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Fence', lastName: `Subject${seq}`,
    roles: ['MOVER'], activeRole: 'MOVER', status: 'ACTIVE', countryCode: 'GY',
  } }));
  ids.push(u.id);
  const bytes = Buffer.from(`held document ${nanoid(12)}`);
  const { url } = await storage.upload({ buffer: bytes, filename: 'verification.enc', mimeType: 'application/octet-stream', folder: `verification/${u.id}` });
  keys.push(url);
  await app.prisma.encryptedObject.create({ data: {
    fileKey: url, createdBy: u.id, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(60, 3),
    mimeType: 'image/jpeg', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  } });
  const doc = await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
    userId: u.id, role: 'MOVER', docType: 'national_id', fileUrl: url, ...extra,
  } }));
  return { userId: u.id, docId: doc.id, key: url };
}

const holdInput = (userId: string) => ({ subjectUserId: userId, placedBy: 'legal-hold-test-placer' /* [SEC-PII] never the subject (recusal) */, ownerId: userId, reason: 'Synthetic preservation case', reviewBy: new Date(Date.now() + 2 * 86_400_000) });

/** A hold placement that holds the person's lock until released. */
async function holdingTheLock(userId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const tx = app.prisma.$transaction(async (t) => { await placeDocLegalHoldIn(t, holdInput(userId)); locked(); await gate; }, { timeout: 20_000 });
  await ready;
  return { release, done: tx };
}

async function intact(key: string, docId: string) {
  expect((await storage.getObject(key)).length).toBeGreaterThan(0);
  const e = await system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: key } }));
  expect(e.wrappedDek).not.toBeNull();
  expect(e.shreddedAt).toBeNull();
  const d = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } }));
  expect(d.legalHoldId).not.toBeNull();
  expect(d.purgedAt).toBeNull();
  expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: docId } }))).toBe(0);
}

const settles = async <T>(p: Promise<T>) => {
  let finished = false;
  void p.then(() => { finished = true; }, () => { finished = true; });
  await new Promise((r) => setTimeout(r, 750));
  return finished;
};

describe('a hold being placed beats the purge that races it', () => {
  it('the retention reaper waits for the hold and destroys nothing', async () => {
    const { userId, docId, key } = await personWithDocument({ status: 'REJECTED', retentionExpiresAt: new Date(Date.now() - 60_000) });
    const hold = await holdingTheLock(userId);
    const reaper = service().purgeDocumentNow(
      { id: docId, userId, fileUrl: key, docType: 'national_id', user: { tenantId: 'swift-default' } }, 'reaper',
      { requireRetentionElapsed: true, shredFields: false },
    );
    expect(await settles(reaper)).toBe(false); // it waits on the person's lock the hold holds
    hold.release(); await hold.done;
    expect(await reaper).toBe('NOT_PURGED');
    await intact(key, docId);
  });

  it('the post-decision image purge waits for the hold and destroys nothing', async () => {
    const { userId, docId, key } = await personWithDocument({ status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(Date.now() - 40 * 86_400_000) });
    const hold = await holdingTheLock(userId);
    const purge = service().purgeImageAfterReview(docId, 'partner-image-retention');
    expect(await settles(purge)).toBe(false);
    hold.release(); await hold.done;
    expect(await purge).toBe('NOT_PURGED');
    await intact(key, docId);
  });
});

describe('a purge already destroying is never claimed by a late hold', () => {
  it('the key is shredded under the lock; a hold during the (stalled) storage delete does not wait and does not claim it', async () => {
    const { userId, docId, key } = await personWithDocument({ status: 'REJECTED', retentionExpiresAt: new Date(Date.now() - 60_000) });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let deleting!: () => void;
    const started = new Promise<void>((r) => { deleting = r; });
    const realDelete = storage.delete.bind(storage);
    // The store stalls: no lock may be held across it (a stall past a transaction limit would let a hold in).
    vi.spyOn(storage, 'delete').mockImplementation(async (k) => { if (k === key) { deleting(); await gate; } await realDelete(k); });
    const purge = service().purgeDocumentNow(
      { id: docId, userId, fileUrl: key, docType: 'national_id', user: { tenantId: 'swift-default' } }, 'reaper',
      { requireRetentionElapsed: true, shredFields: false },
    );
    await started;
    const e = await system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: key } }));
    expect(e.wrappedDek).toBeNull(); // already unrecoverable before any storage call
    const hold = placeDocLegalHold(app.prisma, holdInput(userId));
    expect(await settles(hold)).toBe(true); // nothing holds the person's lock during storage I/O
    await expect(hold).rejects.toMatchObject({ code: 'NOTHING_TO_HOLD' });
    release();
    expect(await purge).toBe('PURGED');
    const d = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } }));
    expect(d.purgedAt).not.toBeNull();
    expect(d.legalHoldId).toBeNull();
  });

  it('a purge that could not finish is finished on the next run, not stranded', async () => {
    const { userId, docId, key } = await personWithDocument({ status: 'REJECTED', retentionExpiresAt: new Date(Date.now() - 60_000) });
    const doc = { id: docId, userId, fileUrl: key, docType: 'national_id', user: { tenantId: 'swift-default' } };
    const opts = { requireRetentionElapsed: true, shredFields: false };
    vi.spyOn(storage, 'delete').mockImplementation(async () => undefined); // the store keeps the bytes this time
    expect(await service().purgeDocumentNow(doc, 'reaper', opts)).toBe('PROBE_FAILED');
    vi.restoreAllMocks();
    expect(await service().purgeDocumentNow(doc, 'reaper', opts)).toBe('PURGED');
    await expect(storage.getObject(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the fence never runs without its lock', () => {
  it('a person row it cannot see is never a pass: nothing is shredded', async () => {
    const { shredUnlessHeld } = await import('../modules/verification/purge-receipt');
    const del = vi.spyOn(storage, 'delete');
    const updated: unknown[] = [];
    const fence = {
      $executeRaw: async () => 0, $queryRaw: async () => [],
      verificationDocument: { findMany: async () => [{ id: 'doc-1' }] },
      encryptedObject: { findUnique: async () => null, findMany: async () => [], updateMany: async (a: unknown) => { updated.push(a); return { count: 1 }; } },
    };
    const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fence), ...fence };
    expect(await shredUnlessHeld(db as never, storage, { fileKey: 'verification/u-1/x.enc', userId: 'u-1', documentId: 'doc-1' })).toBeNull();
    expect(updated).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('the account-erasure close re-checks the hold under the person lock (REVIEW-M S2-1)', () => {
  /** A hold placement that has taken the person's lock but not yet touched the document row. */
  async function lockThenHold(userId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const done = app.prisma.$transaction(async (t) => {
      await t.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      locked(); await gate;
      await placeDocLegalHoldIn(t, holdInput(userId));
    }, { timeout: 20_000 });
    await ready;
    return { release, done };
  }

  it('an image-purged document held after the census: the close waits for the hold, then keeps the record', async () => {
    const { userId, docId } = await personWithDocument({ status: 'APPROVED', state: 'COMMITTED', fileUrl: '', imagePurgedAt: new Date(Date.now() - 86_400_000) });
    let hold: Awaited<ReturnType<typeof lockThenHold>> | undefined;
    // The hold lands right after the erasure's census of unheld documents (the window the close must cover).
    const docs = app.prisma.verificationDocument;
    const census = new Proxy(docs, { get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== 'findMany') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (args: { where?: Record<string, unknown> }) => {
        const rows = await docs.findMany(args as never);
        const w = args?.where ?? {};
        if (!hold && w['userId'] === userId && w['purgedAt'] === null && w['legalHoldId'] === null) hold = await lockThenHold(userId);
        return rows;
      };
    } });
    const prisma = new Proxy(app.prisma, { get(target, prop) {
      if (prop === 'verificationDocument') return census;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
    const account = new AccountService({ prisma: prisma as never, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as never });
    const erasure = runWithTenant('swift-default', () => account.deleteAccount(userId));
    for (let i = 0; i < 100 && !hold; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hold).toBeDefined();
    expect(await settles(erasure)).toBe(false); // the close waits on the person's lock the hold placement holds
    hold!.release(); await hold!.done;
    await erasure.catch(() => undefined);
    const d = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } }));
    expect(d.legalHoldId).not.toBeNull();
    expect(d.purgedAt).toBeNull();
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: docId } }))).toBe(0);
  });
});
