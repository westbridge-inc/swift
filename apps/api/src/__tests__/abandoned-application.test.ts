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
    await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: ids } } }).catch(() => undefined);
    await app.prisma.complianceReviewCase.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
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
const riderOf = (userId: string, vehicleType: 'BICYCLE' | 'MOTORCYCLE' = 'BICYCLE') => system(() => app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType } }));
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

  it('[COORD security review (1) + 16:50Z] durable signals without any subscription: the checklist verified once, or ever online in the role', async () => {
    const a = await person('DRIVER');
    const ra = await riderOf(a);
    await system(() => app.prisma.rider.update({ where: { id: ra.id }, data: { documentsVerified: false, documentsVerifiedAt: new Date(Date.now() - 200 * DAY) } }));
    const da = await doc(a, 'DRIVER', 'REJECTED', 300);
    const b = await person('RIDER');
    const rb = await riderOf(b);
    await system(() => app.prisma.rider.update({ where: { id: rb.id }, data: { isOnline: false, lastLocationUpdate: new Date(Date.now() - 200 * DAY) } }));
    const db = await doc(b, 'RIDER', 'REJECTED', 300);
    for (const u of [a, b]) {
      expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
      expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    }
    expect((await docOf(da.id)).purgedAt).toBeNull();
    expect((await docOf(db.id)).purgedAt).toBeNull();
  });

  it('[COORD 16:50Z] one approved document is not a verified role: ID approved, insurance never sent -> noticed, then deleted', async () => {
    const u = await person('RIDER');
    await riderOf(u, 'MOTORCYCLE'); // a motorcycle needs a licence and insurance too; never verified, never online, no fee
    const id = await doc(u, 'RIDER', 'COMMITTED', 100, 'national_id');
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 1, purged: 0 });
    expect(await sweep(later(14.01), u)).toMatchObject({ purged: 1 });
    expect((await docOf(id.id)).purgedAt).not.toBeNull();
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: id.id, deletedBy: ABANDON_PURGE_ACTOR } }))).toBe(1);
  });

  it('[COORD 16:50Z] the full checklist approved IS a verified role: a bicycle courier needs only the ID, so that ID is kept', async () => {
    const u = await person('RIDER');
    await riderOf(u, 'BICYCLE');
    const id = await doc(u, 'RIDER', 'COMMITTED', 100, 'national_id');
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect((await docOf(id.id)).purgedAt).toBeNull();
  });

  it('[COORD security review 17:1xZ] a store whose full checklist was approved but is not activated yet is never swept', async () => {
    const u = await person('VENDOR_OWNER');
    const checklist = await system(() => (service([u]) as unknown as { checklistFor: (u: string, c: string, r: string) => Promise<string[]> }).checklistFor(u, 'GY', 'RESTAURANT'));
    expect(checklist.length).toBeGreaterThan(1);
    const docs = [];
    for (const t of checklist) docs.push(await doc(u, 'VENDOR_OWNER', 'COMMITTED', 100, t));
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    for (const d of docs) expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('[REVIEW-M S3-1] one person who cannot be processed is counted and skipped; the people behind them are still swept', async () => {
    const tag = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
    const poisoned = await person('RIDER', `r249b${tag}`);
    await doc(poisoned, 'RIDER', 'REJECTED', 200);
    const z = await person('RIDER', `r249y${tag}`);
    await doc(z, 'RIDER', 'REJECTED', 100);
    const svc = service([poisoned, z]);
    const step = (svc as unknown as { abandonedApplicationStep: (u: string, n: Date) => Promise<unknown> });
    const real = step.abandonedApplicationStep.bind(svc);
    step.abandonedApplicationStep = async (userId, now) => { if (userId === poisoned) throw new Error('synthetic poisoned person'); return real(userId, now); };
    expect(await system(() => svc.sweepAbandonedApplications(new Date(), 1))).toMatchObject({ noticed: 1, failed: 1 });
    expect(await notices(z)).toHaveLength(1);
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
    const d = await doc(u, 'CUSTOMER', 'REJECTED', 300, 'identity_l2');
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

describe('[Row 249 · REVIEW-M S4-3 · COORD] an open fraud, safety, compliance or dispute case keeps the documents, like a hold', () => {
  const incident = (userId: string) => system(() => app.prisma.incidentCase.create({ data: {
    caseNumber: `INC-${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, '0')}`, severity: 'S3', category: 'dispute', intake: 'OPS_CREATED',
    subjectUserId: userId, summary: 'synthetic open case', slaAckBy: later(1), slaDecideBy: later(10),
  } }));

  it('an open safety case: no notice, nothing deleted; once it is closed (no hold) the 76/90-day clock runs and the documents go', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    const c = await incident(u);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(0);
    expect((await docOf(d.id)).purgedAt).toBeNull();
    await system(() => app.prisma.incidentCase.update({ where: { id: c.id }, data: { status: 'CLOSED', closedAt: new Date() } }));
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 1, purged: 0 });
    // [REVIEW-M S4-1] the record says which inbox row the notice is, and whether a push reached a phone
    const audit = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { userId: u, action: ABANDON_NOTICE_ACTION } }));
    expect(audit.changes).toMatchObject({ pushed: false });
    expect(typeof (audit.changes as { notificationId?: unknown }).notificationId).toBe('string');
    expect(await sweep(later(14.01), u)).toMatchObject({ purged: 1 });
    expect((await docOf(d.id)).purgedAt).not.toBeNull();
  });

  it('a case opened AFTER the notice still blocks the purge (checked again right before deleting)', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 1, purged: 0 });
    const c = await incident(u);
    expect(await sweep(later(14.01), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(40), u)).toMatchObject({ purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
    await system(() => app.prisma.incidentCase.update({ where: { id: c.id }, data: { status: 'CLOSED', closedAt: new Date() } }));
    expect(await sweep(later(41), u)).toMatchObject({ purged: 1 });
  });

  it('an unreadable case census reads as an open case: nothing is noticed or deleted', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    const svc = service([u]);
    const broken = new Proxy((svc as unknown as { prisma: object }).prisma, { get: (t, k) => (k === 'complianceReviewCase'
      ? { count: async () => { throw new Error('synthetic census failure'); } } : Reflect.get(t, k)) });
    (svc as unknown as { prisma: object }).prisma = broken;
    expect(await system(() => svc.sweepAbandonedApplications(new Date()))).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(0);
    expect((await docOf(d.id)).purgedAt).toBeNull();
  });

  it('an open compliance review keeps them too', async () => {
    const u = await person('DRIVER');
    const d = await doc(u, 'DRIVER', 'REJECTED', 100);
    await system(() => app.prisma.complianceReviewCase.create({ data: { userId: u, dueAt: later(5) } }));
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect((await docOf(d.id)).purgedAt).toBeNull();
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
