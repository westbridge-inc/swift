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
}

export function reviewByWindow(now = new Date()): { min: Date; max: Date } {
  return {
    min: new Date(now.getTime() + DOC_LEGAL_HOLD_MIN_REVIEW_DAYS * 86_400_000),
    max: new Date(now.getTime() + DOC_LEGAL_HOLD_MAX_REVIEW_DAYS * 86_400_000),
  };
}

export async function placeDocLegalHold(prisma: PrismaClient, input: PlaceDocLegalHoldInput, now = new Date()) {
  const window = reviewByWindow(now);
  if (!(input.reviewBy >= window.min && input.reviewBy <= window.max)) {
    throw new AppError(400, 'REVIEW_DATE_OUT_OF_WINDOW', `The review date must be between ${DOC_LEGAL_HOLD_MIN_REVIEW_DAYS} and ${DOC_LEGAL_HOLD_MAX_REVIEW_DAYS} days from now`);
  }
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "users" WHERE "id" = ${input.subjectUserId} FOR UPDATE /* verification-document-purge-authority */
    `;
    if (!locked[0]) throw new NotFoundError('User', input.subjectUserId);
    const holdable = await tx.verificationDocument.findMany({
      where: {
        userId: input.subjectUserId, purgedAt: null, legalHoldId: null,
        ...(input.documentIds && input.documentIds.length > 0 ? { id: { in: input.documentIds } } : {}),
      },
      select: { id: true },
    });
    if (holdable.length === 0) {
      throw new AppError(409, 'NOTHING_TO_HOLD', 'No unpurged, unheld document to hold — a hold never resurrects purged bytes');
    }
    const hold = await tx.docLegalHold.create({ data: {
      subjectUserId: input.subjectUserId, reason: input.reason, ownerId: input.ownerId, reviewBy: input.reviewBy,
      placedBy: input.placedBy, placedAt: now, incidentCaseId: input.incidentCaseId ?? null,
    } });
    const stamped = await tx.verificationDocument.updateMany({
      where: { id: { in: holdable.map((d) => d.id) }, purgedAt: null, legalHoldId: null },
      data: { legalHoldId: hold.id },
    });
    return { hold, documents: stamped.count };
  });
}

export async function releaseDocLegalHold(prisma: PrismaClient, input: { holdId: string; releasedBy: string; reason: string }, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.docLegalHold.findUnique({ where: { id: input.holdId } });
    if (!hold) throw new NotFoundError('DocLegalHold', input.holdId);
    if (hold.releasedAt) throw new AppError(409, 'HOLD_ALREADY_RELEASED', 'This hold was already released');
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${hold.subjectUserId} FOR UPDATE /* verification-document-purge-authority */`;
    const released = await tx.docLegalHold.update({
      where: { id: hold.id },
      data: { releasedAt: now, releasedBy: input.releasedBy, releaseReason: input.reason },
    });
    const unstamped = await tx.verificationDocument.updateMany({ where: { legalHoldId: hold.id }, data: { legalHoldId: null } });
    return { hold: released, documents: unstamped.count };
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
