/**
 * [Row 249 · COORD ruling option A, 18 Oct (delegated privacy)] AN ABANDONED APPLICATION DOES NOT KEEP ITS DOCUMENTS FOREVER.
 *
 *  - The applicant left it (nothing waits on Swift, no activity for 90 days): an in-app notice at day 76, the documents
 *    through the fenced purge 14 days after the notice (a legal hold beats it, a receipt per document).
 *  - Activity after the notice voids it. Anything waiting on Swift, a role ever verified, a customer's own ID: never.
 *  - An upload nobody claimed within 30 days is erased while the account stays open; a document can no longer claim one
 *    that old (one day inside the window), so the sweep never races a claim.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { DocState, PrismaClient, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { placeDocLegalHold } from '../modules/verification/legal-hold';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { sweepStaleUnclaimedUploads, UNCLAIMED_SWEEP_ACTOR } from '../modules/user/upload-erasure';
import { assertClaimableUpload, UNCLAIMED_UPLOAD_DAYS, UPLOAD_CLAIM_DAYS } from '../modules/verification/upload-window';
import {
  ABANDON_NOTICE_ACTION, ABANDON_NOTICE_BODY, ABANDON_NOTICE_DAYS, ABANDON_PURGE_ACTOR, ABANDON_PURGE_DAYS, stillAbandoned,
} from '../modules/verification/abandoned-application';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { signupSelfieFixture } from './helpers/verification-object';

const storage = new LocalStorageProvider();
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));

const DAY = 86_400_000;
const NUM = String(Date.now()).slice(-6);
let app: FastifyInstance;
const ids: string[] = [];
const keys: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'abandoned-application-test');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

class ApprovingKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: `ok_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: `ok_${nanoid(6)}` }; }
  async getStatus(): Promise<'approved'> { return 'approved'; }
}

/** The sweeps read every person's rows; in the shared test database they may only ever see this suite's. */
const scoped = (only: readonly string[] = ids): PrismaClient => app.prisma.$extends({ query: {
  verificationDocument: { async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { userId: { in: [...only] } }] } }); } },
  encryptedObject: { async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { createdBy: { in: [...only] } }] } }); } },
} }) as unknown as PrismaClient;
const service = (only?: readonly string[]) => new VerificationService(scoped(only), new NotificationService(app.prisma, app.io), new ApprovingKyc());
/** One person's sweep (each case sees only its own person). */
const sweep = (now: Date, userId: string) => system(() => service([userId]).sweepAbandonedApplications(now));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
});
afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: ids } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.subscription.deleteMany({ where: { rider: { userId: { in: ids } } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  });
  for (const key of keys) await storage.delete(key).catch(() => undefined);
  await app.close();
});

let seq = 0;
async function person(role: UserRole = 'RIDER', id?: string) {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    ...(id ? { id } : {}),
    phone: `+59263${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Left', lastName: `Halfway${seq}`,
    roles: role === 'CUSTOMER' ? ['CUSTOMER'] : ['CUSTOMER', role], activeRole: role, status: 'ACTIVE', countryCode: 'GY',
  } }));
  ids.push(u.id);
  return u.id;
}

/** What POST /verification/upload leaves behind, `daysAgo` days ago. */
async function upload(userId: string, daysAgo: number) {
  const bytes = Buffer.from(`synthetic upload ${nanoid(12)}`);
  const { url } = await storage.upload({ buffer: bytes, filename: 'verification.enc', mimeType: 'application/octet-stream', folder: `verification/${userId}` });
  keys.push(url);
  await app.prisma.encryptedObject.create({ data: {
    fileKey: url, createdBy: userId, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(60, 3),
    mimeType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes), createdAt: new Date(Date.now() - daysAgo * DAY),
  } });
  return url;
}

/** A submitted document, `daysAgo` days ago, in `state`, with its upload. */
async function doc(userId: string, role: UserRole, state: DocState, daysAgo: number, docType = 'driver_license') {
  const fileUrl = await upload(userId, daysAgo);
  const at = new Date(Date.now() - daysAgo * DAY);
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl, state, createdAt: at,
    ...(state === 'REVIEW_QUEUED' || state === 'CAPTURED' ? {} : { reviewedAt: at, reviewedBy: 'abandon-test' }),
  } }));
}
const riderOf = (userId: string) => system(() => app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } }));
const subscribeRider = (riderId: string) => system(() => app.prisma.subscription.create({ data: {
  riderId, type: 'DELIVERY_RIDER', weeklyRate: 1000,
  currentPeriodStart: new Date(Date.now() - 400 * DAY), currentPeriodEnd: new Date(Date.now() - 393 * DAY), nextBillingDate: new Date(Date.now() - 393 * DAY),
} }));
const docOf = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }));
const stored = async (key: string) => { try { await storage.getObject(key); return true; } catch { return false; } };
const notices = (userId: string) => system(() => app.prisma.notification.findMany({ where: { userId, body: ABANDON_NOTICE_BODY } }));
const later = (days: number) => new Date(Date.now() + days * DAY);

describe('[Row 249] an abandoned application: a notice at day 76, the documents 14 days after it', () => {
  it('the windows are the ruling: 76 / 90 days, uploads 30 days, a claim refused one day inside the upload window', () => {
    expect([ABANDON_NOTICE_DAYS, ABANDON_PURGE_DAYS, UNCLAIMED_UPLOAD_DAYS, UPLOAD_CLAIM_DAYS]).toEqual([76, 90, 30, 29]);
  });

  it('notices once at day 76+, keeps the documents until 14 days after the notice, then purges them with a receipt', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'INFO_REQUESTED', 80);
    const now = new Date();
    expect(await sweep(now, u)).toMatchObject({ noticed: 1, purged: 0 });
    expect(await notices(u)).toHaveLength(1);
    expect(await system(() => app.prisma.auditLog.count({ where: { userId: u, action: ABANDON_NOTICE_ACTION } }))).toBe(1);
    expect(await sweep(now, u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(1);
    expect(await sweep(later(13), u)).toMatchObject({ purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
    expect(await sweep(later(14.01), u)).toMatchObject({ purged: 1 });
    const after = await docOf(d.id);
    expect(after.purgedAt).not.toBeNull();
    expect(after.fileUrl).toBe('');
    expect(await stored(d.fileUrl)).toBe(false);
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: d.id, deletedBy: ABANDON_PURGE_ACTOR } }))).toBe(1);
  });

  it('day 75 of inactivity: no notice, nothing deleted', async () => {
    const u = await person('DRIVER');
    const d = await doc(u, 'DRIVER', 'REJECTED', 75);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(0);
    expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('activity after the notice voids it: nothing goes, and a fresh notice is needed after a new 76 days', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 80);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 1 });
    await upload(u, -1); // the applicant uploads again tomorrow
    expect(await sweep(later(20), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await sweep(later(1 + 76.01), u)).toMatchObject({ noticed: 1, purged: 0 });
    expect(await notices(u)).toHaveLength(2);
  });

  it('never while anything of theirs waits on Swift, however old', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'INFO_REQUESTED', 200);
    await doc(u, 'RIDER', 'REVIEW_QUEUED', 150, 'vehicle_insurance');
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(60), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(0);
    expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('never for a role the person was ever verified for (a subscription is born on full verification)', async () => {
    const u = await person('RIDER');
    await subscribeRider((await riderOf(u)).id);
    const d = await doc(u, 'RIDER', 'REJECTED', 300);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('[COORD security review (1)] a verified mover whose subscription is keyed on the OTHER profile is never purged', async () => {
    const u = await person('DRIVER');
    await subscribeRider((await riderOf(u)).id); // the fee is on the rider profile; the documents are the driver's
    const d = await doc(u, 'DRIVER', 'REJECTED', 300);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('[COORD security review (1)] durable signals without any subscription: documents verified once, or a document of the role ever approved', async () => {
    const a = await person('DRIVER');
    const rider = await riderOf(a);
    await system(() => app.prisma.rider.update({ where: { id: rider.id }, data: { documentsVerified: false, documentsVerifiedAt: new Date(Date.now() - 200 * DAY) } }));
    const da = await doc(a, 'DRIVER', 'REJECTED', 300);
    const b = await person('VENDOR_OWNER');
    await doc(b, 'VENDOR_OWNER', 'EXPIRED', 300, 'business_registration');
    const db = await doc(b, 'VENDOR_OWNER', 'REJECTED', 300, 'owner_national_id');
    for (const u of [a, b]) {
      expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
      expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    }
    expect((await docOf(da.id)).purgedAt).toBeNull();
    expect((await docOf(db.id)).purgedAt).toBeNull();
  });

  it('[COORD security review (2)] more than a page of excluded people still lets the person behind them be swept', async () => {
    const tag = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
    const excluded: string[] = [];
    for (const n of [1, 2]) {
      const x = await person('RIDER', `r249a${n}${tag}`);
      await subscribeRider((await riderOf(x)).id);
      await doc(x, 'RIDER', 'REJECTED', 200);
      excluded.push(x);
    }
    const z = await person('RIDER', `r249z${tag}`);
    await doc(z, 'RIDER', 'REJECTED', 100);
    const r = await system(() => service([...excluded, z]).sweepAbandonedApplications(new Date(), 1));
    expect(r).toMatchObject({ noticed: 1, purged: 0 });
    expect(await notices(z)).toHaveLength(1);
  });

  it('a legal hold beats it: noticed, but nothing is deleted while the hold stands', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 1 });
    await placeDocLegalHold(app.prisma, { subjectUserId: u, placedBy: u, ownerId: u, reason: 'Synthetic preservation case', reviewBy: new Date(Date.now() + 2 * DAY) });
    expect(await sweep(later(15), u)).toMatchObject({ purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
  });

  it('a customer\'s own ID is never an application', async () => {
    const u = await person('CUSTOMER');
    const d = await doc(u, 'CUSTOMER', 'COMMITTED', 300, 'identity_l2');
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('the purge re-checks under the lock: a document submitted after the decision stops it', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'INFO_REQUESTED', 120);
    const lastActivityAt = new Date(Date.now() - 120 * DAY);
    await doc(u, 'RIDER', 'COMMITTED', 0, 'vehicle_insurance');
    const outcome = await system(() => service().purgeDocumentNow(
      { id: d.id, userId: u, fileUrl: d.fileUrl, docType: d.docType, user: { tenantId: 'swift-default' } },
      ABANDON_PURGE_ACTOR, { requireRetentionElapsed: false, shredFields: true, still: stillAbandoned(lastActivityAt) },
    ));
    expect(outcome).toBe('NOT_PURGED');
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
  });
});

describe('[Row 249] an upload nobody claimed goes after 30 days while the account stays open', () => {
  it('erases a 31-day-old unclaimed upload with a receipt; keeps a 29-day-old one and a claimed one', async () => {
    const u = await person('RIDER');
    const stale = await upload(u, 31);
    const fresh = await upload(u, 29);
    const claimed = (await doc(u, 'RIDER', 'COMMITTED', 31)).fileUrl;
    const r = await system(() => sweepStaleUnclaimedUploads(scoped([u]), storage, { now: new Date() }));
    expect(r).toMatchObject({ erased: 1, held: 0, pending: 0 });
    const env = (key: string) => system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: key } }));
    expect((await env(stale)).shreddedAt).not.toBeNull();
    expect(await stored(stale)).toBe(false);
    expect((await env(fresh)).shreddedAt).toBeNull();
    expect((await env(claimed)).shreddedAt).toBeNull();
    expect(await stored(claimed)).toBe(true);
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { subjectId: u, docTypeCode: 'unclaimed_upload', deletedBy: UNCLAIMED_SWEEP_ACTOR } }))).toBe(1);
  });

  it('a document can no longer claim an upload older than 29 days: the person sends it again', async () => {
    expect(() => assertClaimableUpload({ createdAt: new Date(Date.now() - 28 * DAY) })).not.toThrow();
    expect(() => assertClaimableUpload({ createdAt: new Date(Date.now() - 29 * DAY - 60_000) })).toThrow(expect.objectContaining({ code: 'UPLOAD_TOO_OLD' }));
    const u = await person('VENDOR_OWNER');
    await signupSelfieFixture(app.prisma, u);
    const old = await upload(u, 30);
    await expect(runWithTenant('swift-default', () => service().submitDocument(u, 'RESTAURANT', 'owner_national_id', old, 'v1')))
      .rejects.toMatchObject({ code: 'UPLOAD_TOO_OLD' });
  });
});
