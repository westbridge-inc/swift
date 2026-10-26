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
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { DocState, Prisma, PrismaClient, UserRole } from '@prisma/client';
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
  ABANDON_NOTICE_ACTION, ABANDON_NOTICE_BODY, ABANDON_NOTICE_DAYS, ABANDON_PURGE_ACTOR, ABANDON_PURGE_DAYS, OPEN_CASE_CENSUS,
  openCasesOf, stillAbandoned, type OpenCaseKind,
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
const cleanups: Array<() => Promise<unknown>> = [];
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
    for (const undo of cleanups) await undo().catch(() => undefined);
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

  it('[REVIEW-G S3-1] a checklist that cannot be read counts as complete: the documents are kept', async () => {
    const u = await person('RIDER');
    await riderOf(u, 'MOTORCYCLE');
    const id = await doc(u, 'RIDER', 'COMMITTED', 100, 'national_id'); // otherwise swept (the case above)
    const svc = service([u]);
    (svc as unknown as { checklistFor: () => Promise<string[]> }).checklistFor = async () => { throw new Error('synthetic checklist read failure'); };
    expect(await system(() => svc.sweepAbandonedApplications(new Date()))).toMatchObject({ noticed: 0, purged: 0, failed: 0 });
    expect(await system(() => svc.sweepAbandonedApplications(later(30)))).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(0);
    expect((await docOf(id.id)).purgedAt).toBeNull();
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

  // [REVIEW-M #2011 S4-1 · COORD F4] The re-check also runs for EACH document, inside the transaction that destroys its
  // key, under the person's lock. Before, one check ran before the whole purge loop: a case opened while an earlier
  // document's bytes were being deleted and probed (storage calls, outside any lock) let the later documents go.
  it('a case opened while an earlier document is being deleted keeps the documents not yet destroyed', async () => {
    const u = await person('RIDER');
    const first = await doc(u, 'RIDER', 'REJECTED', 100);
    const second = await doc(u, 'RIDER', 'REJECTED', 100, 'vehicle_insurance');
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 1, purged: 0 });
    // the first document's bytes are deleted from storage (after its key is shredded); a case opens meanwhile
    const remove = storage.delete.bind(storage);
    const deleting = vi.spyOn(storage, 'delete').mockImplementationOnce(async (key: string) => {
      await incident(u);
      return remove(key);
    });
    try {
      expect(await sweep(later(14.01), u)).toMatchObject({ noticed: 0, purged: 1 });
    } finally {
      deleting.mockRestore();
    }
    // the one already being deleted is gone; the other is kept whole: its row, its bytes and its key
    const after = await Promise.all([first, second].map(async (d) => ({ d, purgedAt: (await docOf(d.id)).purgedAt })));
    expect(after.filter((x) => x.purgedAt !== null)).toHaveLength(1);
    const kept = after.find((x) => x.purgedAt === null)!.d;
    expect(await stored(kept.fileUrl)).toBe(true);
    expect(await system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: kept.fileUrl }, select: { wrappedDek: true, shreddedAt: true } })))
      .toMatchObject({ wrappedDek: expect.anything(), shreddedAt: null });
  });

  it('the caller’s check runs while the person’s row is locked, before the key is destroyed; true destroys nothing', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    let lockedWhenChecked = -1;
    const outcome = await system(() => service([u]).purgeDocumentNow(
      { id: d.id, userId: u, fileUrl: d.fileUrl, docType: d.docType, user: { tenantId: 'swift-default' } },
      ABANDON_PURGE_ACTOR, { requireRetentionElapsed: false, shredFields: true, keeps: async (tx) => {
        // the person's row lock (FOR UPDATE) shows as this backend's row-share lock on users
        lockedWhenChecked = (await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND relation = 'users'::regclass AND mode = 'RowShareLock'`)[0]!.n;
        return true;
      } },
    ));
    expect(lockedWhenChecked).toBe(1);
    expect(outcome).toBe('NOT_PURGED');
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
    expect(await system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: d.fileUrl }, select: { wrappedDek: true, shreddedAt: true } })))
      .toMatchObject({ wrappedDek: expect.anything(), shreddedAt: null });
  });

  // [REVIEW-M #2118 S4-1] The contract for any caller's check: one that THROWS destroys nothing (the purge fails loudly;
  // the bytes, the key and the row stay). The sweep's openCaseKeeps never throws (an error reads as an open case).
  it('a caller’s check that throws destroys nothing: the purge fails, the document stays whole', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    await expect(system(() => service([u]).purgeDocumentNow(
      { id: d.id, userId: u, fileUrl: d.fileUrl, docType: d.docType, user: { tenantId: 'swift-default' } },
      ABANDON_PURGE_ACTOR, { requireRetentionElapsed: false, shredFields: true, keeps: async () => { throw new Error('synthetic check failure'); } },
    ))).rejects.toThrow('synthetic check failure');
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
    expect(await system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: d.fileUrl }, select: { wrappedDek: true, shreddedAt: true } })))
      .toMatchObject({ wrappedDek: expect.anything(), shreddedAt: null });
  });

  it('a document with no stored file: the check runs in the purge transaction itself (true keeps it, false purges it)', async () => {
    const u = await person('RIDER');
    const d = await system(() => app.prisma.verificationDocument.create({ data: {
      userId: u, role: 'RIDER', docType: 'driver_license', fileUrl: '', state: 'REJECTED', createdAt: new Date(Date.now() - 100 * DAY), reviewedAt: new Date(Date.now() - 100 * DAY), reviewedBy: 'abandon-test',
    } }));
    const purge = (keeps: boolean) => system(() => service([u]).purgeDocumentNow(
      { id: d.id, userId: u, fileUrl: '', docType: d.docType, user: { tenantId: 'swift-default' } },
      ABANDON_PURGE_ACTOR, { requireRetentionElapsed: false, shredFields: true, keeps: async () => keeps },
    ));
    expect(await purge(true)).toBe('NOT_PURGED');
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await purge(false)).toBe('PURGED');
    expect((await docOf(d.id)).purgedAt).not.toBeNull();
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

  it('[REVIEW-G S3-2] an inbox notice that could not be written is no notice: no record, no purge clock, the person is counted and noticed on the next run', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    // sendReach logs a persist failure and answers with no id (best-effort for everyone else); here that must stop the step.
    const unwritable = new Proxy(app.prisma, { get: (t, k) => (k === 'notification'
      ? { create: async () => { throw new Error('synthetic inbox write failure'); } } : Reflect.get(t, k)) }) as PrismaClient;
    const svc = new VerificationService(scoped([u]), new NotificationService(unwritable, app.io), new ApprovingKyc());
    expect(await system(() => svc.sweepAbandonedApplications(new Date()))).toMatchObject({ noticed: 0, purged: 0, failed: 1 });
    expect(await system(() => app.prisma.auditLog.count({ where: { userId: u, action: ABANDON_NOTICE_ACTION } }))).toBe(0);
    expect(await notices(u)).toHaveLength(0);
    // Fifteen days on, with the inbox writable again: noticed now, nothing deleted (the 14 days start at the real notice).
    expect(await sweep(later(15), u)).toMatchObject({ noticed: 1, purged: 0, failed: 0 });
    expect(await notices(u)).toHaveLength(1);
    expect((await docOf(d.id)).purgedAt).toBeNull();
    expect(await stored(d.fileUrl)).toBe(true);
  });
});

describe('[Row 249 · COORD security review] the open-case census: every case, report, dispute and hold that can name the person keeps', () => {
  /** A fixture row written past its foreign keys (orders, rooms, clusters it names need not exist for a read-only census). */
  const raw = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => system(() => app.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    return fn(tx);
  }));
  const other = () => `other-${nanoid(8)}`;
  const fixtures: Record<OpenCaseKind, (u: string, docId: string, riderId: string) => Promise<unknown>> = {
    fraud_case: (u, docId) => raw((tx) => tx.fraudCase.create({ data: { subjectUserId: other(), submissionId: docId, caseId: randomUUID(), reasonCode: 'SYNTHETIC', confirmedBy: 'test', linkedAccountIds: [] } })
      .then((r) => cleanups.push(() => raw((t) => t.fraudCase.delete({ where: { id: r.id } }))))),
    identity_review_case: (u) => raw(async (tx) => {
      const clusterId = `cl-${nanoid(8)}`;
      await tx.identityClusterMember.create({ data: { accountId: u, clusterId, linkedVia: [] } });
      const r = await tx.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId, snapshotDigest: nanoid(8), snapshot: {}, complete: true } });
      cleanups.push(() => raw(async (t) => { await t.identityReviewCase.delete({ where: { id: r.id } }); await t.identityClusterMember.delete({ where: { accountId: u } }); }));
    }),
    enforcement_appeal: (u) => raw((tx) => tx.enforcementAction.create({ data: { accountId: u, level: 'REVIEW_FIRST', reasonCode: 'SYNTHETIC', signalsFired: {}, decidedBy: 'SYSTEM', appeal: 'OPEN' } })
      .then((r) => cleanups.push(() => raw((t) => t.enforcementAction.delete({ where: { id: r.id } }))))),
    incident_case: (u) => raw((tx) => tx.incidentCase.create({ data: {
      caseNumber: `INC-${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, '0')}`, severity: 'S3', category: 'dispute', intake: 'OPS_CREATED',
      subjectUserId: other(), reporterUserId: u, summary: 'synthetic open case', slaAckBy: later(1), slaDecideBy: later(10),
    } }).then((r) => cleanups.push(() => raw((t) => t.incidentCase.delete({ where: { id: r.id } }))))),
    sos_alert: (u) => raw((tx) => tx.sosAlert.create({ data: { actorUserId: other(), counterpartyUserId: u, actorRole: 'CUSTOMER', status: 'ACKNOWLEDGED' } })
      .then((r) => cleanups.push(() => raw((t) => t.sosAlert.delete({ where: { id: r.id } }))))),
    safety_deletion_hold: (u) => raw((tx) => tx.safetyDeletionHold.create({ data: { userId: u, holdRefs: [], purpose: 'synthetic', ownerRole: 'OPS', reviewBy: later(5), purgeBy: later(50) } })
      .then((r) => cleanups.push(() => raw((t) => t.safetyDeletionHold.delete({ where: { id: r.id } }))))),
    doc_legal_hold: (u) => raw((tx) => tx.docLegalHold.create({ data: { subjectUserId: u, reason: 'synthetic', ownerId: other(), placedBy: other(), reviewBy: later(5) } })
      .then((r) => cleanups.push(() => raw((t) => t.docLegalHold.delete({ where: { id: r.id } }))))),
    compliance_review_case: (u) => raw((tx) => tx.complianceReviewCase.create({ data: { userId: u, dueAt: later(5) } })
      .then((r) => cleanups.push(() => raw((t) => t.complianceReviewCase.delete({ where: { id: r.id } }))))),
    compliance_violation: (u) => raw((tx) => tx.complianceViolation.create({ data: { userId: u, moverKind: 'RIDER', reason: 'synthetic', evidence: {} } })
      .then((r) => cleanups.push(() => raw((t) => t.complianceViolation.delete({ where: { id: r.id } }))))),
    review_case: (u, docId) => raw((tx) => tx.reviewCase.create({ data: { submissionId: docId, slaDueAt: later(1) } })
      .then((r) => cleanups.push(() => raw((t) => t.reviewCase.delete({ where: { id: r.id } }))))),
    rectification_request: (u, docId) => raw((tx) => tx.rectificationRequest.create({ data: { userId: other(), submissionId: docId, caseId: randomUUID(), fieldCode: 'name', note: 'synthetic' } })
      .then((r) => cleanups.push(() => raw((t) => t.rectificationRequest.delete({ where: { id: r.id } }))))),
    // The security review's gap (1): named only as the holder, through a RIDER id.
    custody_recovery_case: (u, docId, riderId) => raw((tx) => tx.custodyRecoveryCase.create({ data: { orderId: `o-${nanoid(8)}`, reason: 'CRASH', holderRiderId: riderId, deadlineAt: later(1) } })
      .then((r) => cleanups.push(() => raw((t) => t.custodyRecoveryCase.delete({ where: { id: r.id } }))))),
    // The security review's gap (2): someone else reports a RATING this person wrote.
    content_report: (u) => raw(async (tx) => {
      const rating = await tx.rating.create({ data: { orderId: `o-${nanoid(8)}`, raterId: u, type: 'CUSTOMER_TO_RIDER', score: 1 } });
      const r = await tx.contentReport.create({ data: { reporterId: other(), targetType: 'RATING', targetId: rating.id, reason: 'HARASSMENT' } });
      cleanups.push(() => raw(async (t) => { await t.contentReport.delete({ where: { id: r.id } }); await t.rating.delete({ where: { id: rating.id } }); }));
    }),
    // ... and a rating report on a rating the person wrote, reported by someone else.
    rating_report: (u) => raw(async (tx) => {
      const rating = await tx.rating.create({ data: { orderId: `o-${nanoid(8)}`, raterId: u, type: 'CUSTOMER_TO_RIDER', score: 1 } });
      const r = await tx.ratingReport.create({ data: { ratingId: rating.id, reporterId: other(), reason: 'unfair' } });
      cleanups.push(() => raw(async (t) => { await t.ratingReport.delete({ where: { id: r.id } }); await t.rating.delete({ where: { id: rating.id } }); }));
    }),
    reimbursement_claim: (u, docId, riderId) => raw((tx) => tx.reimbursementClaim.create({ data: { orderId: `o-${nanoid(8)}`, customerId: other(), riderId, amount: 100, reason: 'synthetic', gpsLat: 6.8, gpsLng: -58.1 } })
      .then((r) => cleanups.push(() => raw((t) => t.reimbursementClaim.delete({ where: { id: r.id } }))))),
    support_ticket: (u) => raw((tx) => tx.supportTicket.create({ data: { userId: u, category: 'ORDER_ISSUE', subject: 'synthetic', message: 'synthetic' } })
      .then((r) => cleanups.push(() => raw((t) => t.supportTicket.delete({ where: { id: r.id } }))))),
    payment_confirmation_hold: (u, docId, riderId) => raw(async (tx) => {
      const sub = await tx.subscription.create({ data: { riderId, type: 'DELIVERY_RIDER', weeklyRate: 1000, currentPeriodStart: new Date(), currentPeriodEnd: later(7), nextBillingDate: later(7) } });
      const r = await tx.paymentConfirmationHold.create({ data: { tenantId: 'swift-default', subscriptionId: sub.id, clockId: `c-${nanoid(6)}`, sourceEpoch: 1, paymentId: `p-${nanoid(8)}`, reason: 'synthetic', beganAt: new Date(), reviewDueAt: later(2) } });
      cleanups.push(() => raw(async (t) => { await t.paymentConfirmationHold.delete({ where: { id: r.id } }); }));
    }),
  };

  it('the census names every kind, and each kind has a fixture here', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...OPEN_CASE_CENSUS].sort());
  });

  for (const kind of OPEN_CASE_CENSUS) {
    it(`${kind}: found for the person, and the documents are kept (no notice, nothing deleted)`, async () => {
      const u = await person('RIDER');
      const riderId = (await riderOf(u, 'MOTORCYCLE')).id;
      const d = await doc(u, 'RIDER', 'REJECTED', 100);
      expect(await system(() => openCasesOf(app.prisma, u))).toEqual([]);
      await fixtures[kind](u, d.id, riderId);
      expect(await system(() => openCasesOf(app.prisma, u))).toEqual([kind]);
      expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
      expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
      expect((await docOf(d.id)).purgedAt).toBeNull();
    });
  }

  it('[REVIEW-G S3-1] fraud_case: a confirmed case naming the person only as a LINKED account (founder decision pending) keeps their documents', async () => {
    const u = await person('RIDER');
    const d = await doc(u, 'RIDER', 'REJECTED', 100);
    const fraud = (linked: string[]) => raw((tx) => tx.fraudCase.create({ data: {
      subjectUserId: other(), submissionId: `sub-${nanoid(8)}`, caseId: randomUUID(), reasonCode: 'SYNTHETIC', confirmedBy: 'test', linkedAccountIds: linked,
    } }).then((r) => cleanups.push(() => raw((t) => t.fraudCase.delete({ where: { id: r.id } })))));
    await fraud([other(), other()]);
    expect(await system(() => openCasesOf(app.prisma, u))).toEqual([]);
    await fraud([other(), u]);
    expect(await system(() => openCasesOf(app.prisma, u))).toEqual(['fraud_case']);
    expect(await sweep(new Date(), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await sweep(later(30), u)).toMatchObject({ noticed: 0, purged: 0 });
    expect(await notices(u)).toHaveLength(0);
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
