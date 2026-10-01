/**
 * [DOC-1 §9.4 · P9-4] Legal holds on document submissions.
 *
 * A hold names ONE person, a reason, an accountable owner and a review date.
 * Placing it stamps every unpurged, unheld document of that person (or the
 * listed ones) in the same transaction, under the person's row lock — the
 * same authority row the reaper and erasure take — so a hold and a purge
 * cannot interleave. While stamped, a document is skipped by the reaper and
 * by account erasure (DOC-INV-14). Release clears the stamp and the purge
 * clock resumes (T22: the document's state was never touched). A hold never
 * resurrects purged bytes: with nothing left to hold it is refused. Holds are
 * placed only through the admin endpoint and logged there; every hold has an
 * owner and a review date, and overdue holds alarm (DOC-INV-32).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { docLegalHoldGauge } from '../../plugins/observability';
import { lockPurgeUser, purgeEvent, assertPurgeTenant } from './purge-fence';
import { eraseFaceRecordsOnRelease } from './face-evidence';

type Db = PrismaClient | Prisma.TransactionClient;

/** Review dates: at least a day out, at most a year — a hold with no horizon is not a hold, it is forgetting. */
export const DOC_LEGAL_HOLD_MIN_REVIEW_DAYS = 1;
export const DOC_LEGAL_HOLD_MAX_REVIEW_DAYS = 366;

export interface PlaceDocLegalHoldInput {
  subjectUserId: string;
  /** Narrow the hold to these documents; default = every unpurged, unheld document of the person. */
  documentIds?: string[];
  reason: string;
  ownerId: string;
  reviewBy: Date;
  placedBy: string;
  incidentCaseId?: string;
  /** Explicit acknowledgement that only remaining record/fields can be preserved. */
  preserveRemainingData?: boolean;
  /**
   * What a committed purge of the person does to this hold. REFUSE (the default,
   * and the only mode the admin API reaches): the whole hold is refused with a
   * typed conflict. EXCLUDE_AND_RECORD (fraud confirmation only, inside its own
   * transaction): every document that can still be preserved is held, each
   * committed purge is excluded and recorded against its claim, and the caller's
   * transaction commits. Committed destruction is never revoked either way.
   */
  committedPurge?: 'REFUSE' | 'EXCLUDE_AND_RECORD';
}

export function reviewByWindow(now = new Date()): { min: Date; max: Date } {
  return {
    min: new Date(now.getTime() + DOC_LEGAL_HOLD_MIN_REVIEW_DAYS * 86_400_000),
    max: new Date(now.getTime() + DOC_LEGAL_HOLD_MAX_REVIEW_DAYS * 86_400_000),
  };
}

export class PurgeHoldConflict extends AppError {
  constructor(public readonly tenantId: string, public readonly input: PlaceDocLegalHoldInput,
    public readonly conflicts: Array<{ claimId: string; documentId: string | null; scope: string }>, code = 'DOCUMENT_PURGE_COMMITTED') {
    super(409, code, code === 'DOCUMENT_PURGE_COMMITTED'
      ? 'Preservation cannot be promised: deletion is already committed.'
      : 'The image is already purged. Explicitly acknowledge preservation of remaining data.',
    { conflictCount: conflicts.length, conflicts: conflicts.slice(0, 100).map(({ documentId, scope }) => ({ documentId, scope })) });
  }
}

type HoldConflict = { claimId: string; documentId: string | null; scope: string };

async function appendHoldConflicts(tx: Pick<Prisma.TransactionClient, 'documentPurgeEvent'>, tenantId: string,
  input: PlaceDocLegalHoldInput, conflicts: HoldConflict[], kind: 'HOLD_CONFLICT_PURGE_COMMITTED' | 'HOLD_CONFLICT_IMAGE_PURGED') {
  for (const conflict of conflicts) await purgeEvent(tx, {
    tenantId, userId: input.subjectUserId, claimId: conflict.claimId, kind,
    actorId: input.placedBy, details: { documentId: conflict.documentId, scope: conflict.scope },
  });
}

export async function recordHoldConflict(tx: Pick<Prisma.TransactionClient, 'documentPurgeEvent'>, error: PurgeHoldConflict) {
  await appendHoldConflicts(tx, error.tenantId, error.input, error.conflicts,
    error.code === 'DOCUMENT_PURGE_COMMITTED' ? 'HOLD_CONFLICT_PURGE_COMMITTED' : 'HOLD_CONFLICT_IMAGE_PURGED');
}

export async function placeDocLegalHold(prisma: PrismaClient, input: PlaceDocLegalHoldInput, now = new Date()) {
  const window = reviewByWindow(now);
  if (!(input.reviewBy >= window.min && input.reviewBy <= window.max)) {
    throw new AppError(400, 'REVIEW_DATE_OUT_OF_WINDOW', `The review date must be between ${DOC_LEGAL_HOLD_MIN_REVIEW_DAYS} and ${DOC_LEGAL_HOLD_MAX_REVIEW_DAYS} days from now`);
  }
  const outcome = await prisma.$transaction(async (tx) => {
    try { return { result: await placeDocLegalHoldIn(tx, input, now) }; }
    catch (error) {
      if (!(error instanceof PurgeHoldConflict)) throw error;
      await recordHoldConflict(tx, error);
      return { conflict: error };
    }
  });
  if (outcome.conflict) throw outcome.conflict;
  return outcome.result!;
}

/** Caller-owned fraud transactions must record typed denial outside their rollback. */
export async function placeDocLegalHoldIn(tx: Prisma.TransactionClient, input: PlaceDocLegalHoldInput, now = new Date()) {
  const user = await lockPurgeUser(tx, input.subjectUserId);
  const ids = input.documentIds?.length ? [...new Set(input.documentIds)].sort() : undefined;
  await tx.$queryRaw`SELECT id FROM verification_documents WHERE "userId" = ${user.id} ORDER BY id FOR UPDATE`;
  const docs = await tx.verificationDocument.findMany({
    where: { userId: user.id, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { id: 'asc' },
  });
  if (ids && docs.length !== ids.length) throw new AppError(404, 'DOCUMENTS_NOT_FOUND', 'Every requested document must belong to the subject');
  const committed = await tx.documentPurgeClaim.findMany({ where: {
    userId: user.id, tenantId: user.tenantId, state: 'COMMITTED',
    ...(ids ? { documentId: { in: ids } } : {}),
  }, orderBy: { id: 'asc' } });
  const conflicts = committed.map((c) => ({ claimId: c.id, documentId: c.documentId, scope: c.mode }));
  const excludeCommitted = input.committedPurge === 'EXCLUDE_AND_RECORD';
  if (conflicts.length && !excludeCommitted) throw new PurgeHoldConflict(user.tenantId, input, conflicts);
  // Fraud confirmation: what is already committed to destruction stays committed
  // and is recorded against its claim, in this transaction; the rest is held.
  if (conflicts.length) await appendHoldConflicts(tx, user.tenantId, input, conflicts, 'HOLD_CONFLICT_PURGE_COMMITTED');
  const underCommittedPurge = new Set(committed.flatMap((c) => (c.documentId ? [c.documentId] : [])));
  const destroyed = docs.filter((d) => d.fieldsPurgedAt !== null);
  if (ids && destroyed.length) throw new AppError(409, 'NOTHING_TO_HOLD', 'A requested document has already been fully erased', { documentIds: destroyed.map((d) => d.id) });
  const remaining = docs.filter((d) => !d.fieldsPurgedAt && !d.legalHoldId && !underCommittedPurge.has(d.id));
  const missingImages = remaining.filter((d) => d.imagePurgedAt !== null || d.purgedAt !== null);
  if (missingImages.length && !input.preserveRemainingData) {
    const conflicts = missingImages.filter((d) => d.imageCompletionClaimId).map((d) => ({ claimId: d.imageCompletionClaimId!, documentId: d.id, scope: 'IMAGE' }));
    if (conflicts.length) throw new PurgeHoldConflict(user.tenantId, input, conflicts, 'DOCUMENT_IMAGE_ALREADY_PURGED');
    throw new AppError(409, 'DOCUMENT_IMAGE_ALREADY_PURGED', 'The image is absent without a claim-backed completion record');
  }
  if (!remaining.length) throw new AppError(409, 'NOTHING_TO_HOLD', 'No remaining unheld document to preserve');
  if (ids && remaining.length !== ids.length) throw new AppError(409, 'DOCUMENT_ALREADY_HELD', 'A requested document already belongs to a hold');
  const receipts = missingImages.length ? await tx.deletionReceipt.findMany({
    where: { submissionId: { in: missingImages.map((d) => d.id) }, tenantId: user.tenantId, verificationProbeResult: { in: ['CONFIRMED_ABSENT', 'NOT_APPLICABLE'] } }, select: { id: true, submissionId: true },
  }) : [];
  const absentImages = remaining.filter((d) => !d.fileUrl || d.imagePurgedAt !== null || d.purgedAt !== null);
  const scope = absentImages.length ? 'REMAINING_DATA' : 'DOCUMENT_AND_IMAGE';
  // No document list means the person: later documents are covered too (the claim guards read this).
  const subjectWide = !ids;
  const hold = await tx.docLegalHold.create({ data: {
    tenantId: user.tenantId, subjectUserId: user.id, reason: input.reason, ownerId: input.ownerId, reviewBy: input.reviewBy,
    placedBy: input.placedBy, placedAt: now, incidentCaseId: input.incidentCaseId ?? null, subjectWide,
  } });
  const stamped = await tx.verificationDocument.updateMany({
    where: { id: { in: remaining.map((d) => d.id) }, userId: user.id, legalHoldId: null }, data: { legalHoldId: hold.id },
  });
  if (stamped.count !== remaining.length) throw new AppError(409, 'HOLD_SCOPE_CHANGED', 'The preservation scope changed');
  const missingImageDocumentIds = absentImages.map((d) => d.id);
  const excludedClaimIds = conflicts.map((c) => c.claimId);
  await purgeEvent(tx, { tenantId: user.tenantId, userId: user.id, holdId: hold.id, kind: 'HOLD_PLACED', actorId: input.placedBy,
    details: { scope, subjectWide, documentIds: remaining.map((d) => d.id), missingImageDocumentIds, priorReceiptIds: receipts.map((r) => r.id), excludedClaimIds } });
  return { hold, documents: stamped.count, scope, subjectWide, missingImageDocumentIds, priorReceiptIds: receipts.map((r) => r.id), excludedClaimIds };
}

export async function releaseDocLegalHold(prisma: PrismaClient, input: { holdId: string; releasedBy: string; reason: string }, now = new Date()) {
  const seed = await prisma.docLegalHold.findUnique({ where: { id: input.holdId } });
  if (!seed) throw new NotFoundError('DocLegalHold', input.holdId);
  assertPurgeTenant(seed.tenantId);
  return prisma.$transaction(async (tx) => {
    await lockPurgeUser(tx, seed.subjectUserId, seed.tenantId);
    await tx.$queryRaw`SELECT id FROM verification_documents WHERE "legalHoldId" = ${seed.id}::uuid ORDER BY id FOR UPDATE`;
    const hold = await tx.docLegalHold.findUniqueOrThrow({ where: { id: input.holdId } });
    const won = await tx.docLegalHold.updateMany({
      where: { id: hold.id, releasedAt: null }, data: { releasedAt: now, releasedBy: input.releasedBy, releaseReason: input.reason },
    });
    if (won.count !== 1) throw new AppError(409, 'HOLD_ALREADY_RELEASED', 'This hold was already released');
    const unstamped = await tx.verificationDocument.updateMany({ where: { legalHoldId: hold.id }, data: { legalHoldId: null } });
    await purgeEvent(tx, { tenantId: hold.tenantId, userId: hold.subjectUserId, holdId: hold.id, kind: 'HOLD_RELEASED', actorId: input.releasedBy,
      details: { reason: input.reason, documents: unstamped.count } });
    // [DS625] An erased person's face records were kept only for their holds.
    await eraseFaceRecordsOnRelease(tx, hold, input.releasedBy);
    return { hold: await tx.docLegalHold.findUniqueOrThrow({ where: { id: hold.id } }), documents: unstamped.count };
  });
}

export async function listDocLegalHolds(prisma: Db, opts: { active?: boolean } = {}) {
  const holds = await prisma.docLegalHold.findMany({
    where: opts.active === undefined ? {} : opts.active ? { releasedAt: null } : { releasedAt: { not: null } },
    orderBy: [{ releasedAt: 'asc' }, { reviewBy: 'asc' }],
    include: { _count: { select: { documents: true } } },
  });
  return holds.map(({ _count, ...h }) => ({ ...h, documents: _count.documents }));
}

export async function overdueDocLegalHolds(prisma: Db, now = new Date()) {
  return prisma.docLegalHold.findMany({ where: { releasedAt: null, reviewBy: { lt: now } }, orderBy: { reviewBy: 'asc' } });
}

/** [DOC-INV-32] Daily: every active hold past its review date is told to the admins of its tenant, and the gauge says how many. */
export async function alertOverdueDocLegalHolds(prisma: PrismaClient, notifications: NotificationService, now = new Date()): Promise<number> {
  const active = await prisma.docLegalHold.count({ where: { releasedAt: null } });
  const overdue = await overdueDocLegalHolds(prisma, now);
  docLegalHoldGauge.labels('active').set(active);
  docLegalHoldGauge.labels('overdue').set(overdue.length);
  const byTenant = new Map<string, typeof overdue>();
  for (const h of overdue) byTenant.set(h.tenantId, [...(byTenant.get(h.tenantId) ?? []), h]);
  for (const [tenantId, holds] of byTenant) {
    await notifyAdmins(prisma, notifications, {
      tenantId,
      title: 'Legal holds past their review date',
      body: `${holds.length} document legal hold${holds.length === 1 ? ' is' : 's are'} past review — each owner must review or release.`,
      data: { kind: 'verification_legal_hold_overdue', overdue: holds.length, holdIds: holds.map((h) => h.id) },
    });
  }
  return overdue.length;
}
