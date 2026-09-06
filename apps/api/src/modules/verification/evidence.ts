/**
 * [DOC-1 §4.4 · P4-2 · §3.11 · P3-4] THE evidence query — the one place that says which
 * approved documents count for an account. It reads `document_record` (the durable,
 * post-purge truth kept by the database), never the image row's file column:
 *  - a record is evidence while it is VALID, unexpired, and its submission has not been
 *    retired by the retention purge (`purgedAt` null, retention clock not elapsed);
 *  - an image purged under its bucket's policy (`imagePurgedAt`, E2E-DOC-5) changes nothing;
 *  - the account's own records count, and so do the records of every VEHICLE subject the
 *    account holds an OPEN link to (a fleet's insurance serves every assigned driver).
 * Used by the verification service (predicate, validity bound, live-operation gate) and
 * by the service-provider projection — one rule, one implementation.
 */
import type { CoverageClass, Prisma, PrismaClient } from '@prisma/client';

export type EvidenceDb = Prisma.TransactionClient | PrismaClient;

export interface EvidenceRow {
  docType: string;
  expiresAt: Date | null;
  retentionExpiresAt: Date | null;
  reviewedAt: Date | null;
  userId: string;
  subjectId: string | null;
  coverageClass: CoverageClass | null;
  hireClassConfirmed: boolean;
  plateCrossChecked: boolean;
}

export async function approvedEvidenceFor(db: EvidenceDb, userId: string, checklist: readonly string[], now: Date): Promise<EvidenceRow[]> {
  if (checklist.length === 0) return [];
  const vehicles = await db.subjectLink.findMany({
    where: { accountId: userId, validTo: null, subject: { kind: 'VEHICLE' } },
    select: { subjectId: true },
  });
  const vehicleIds = vehicles.map((v) => v.subjectId);
  const records = await db.documentRecord.findMany({
    where: {
      docType: { in: [...checklist] },
      status: 'VALID',
      AND: [
        { OR: [{ expiresOn: null }, { expiresOn: { gt: now } }] },
        { OR: [{ accountId: userId }, ...(vehicleIds.length ? [{ subjectId: { in: vehicleIds } }] : [])] },
        { submission: { purgedAt: null, OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] } },
      ],
    },
    select: {
      docType: true, expiresOn: true,
      submission: { select: { retentionExpiresAt: true, reviewedAt: true, userId: true, subjectId: true, coverageClass: true, hireClassConfirmed: true, plateCrossChecked: true } },
    },
  });
  return records.map((r) => ({
    docType: r.docType, expiresAt: r.expiresOn, retentionExpiresAt: r.submission.retentionExpiresAt, reviewedAt: r.submission.reviewedAt,
    userId: r.submission.userId, subjectId: r.submission.subjectId, coverageClass: r.submission.coverageClass,
    hireClassConfirmed: r.submission.hireClassConfirmed, plateCrossChecked: r.submission.plateCrossChecked,
  }));
}
