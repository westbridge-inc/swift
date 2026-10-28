/**
 * [DOC-1 §4.4 · P4-2 · §3.11 · P3-4] THE evidence query — the one place that says which
 * approved documents count for an account. It reads `document_record` (the durable,
 * post-purge truth kept by the database), never the image row's file column:
 *  - a record is evidence while it is VALID, unexpired, and its submission has not been
 *    retired by the retention purge (`purgedAt` null, retention clock not elapsed);
 *  - an image purged under its bucket's policy (`imagePurgedAt`, E2E-DOC-5) changes nothing;
 *  - the account's own records count, and so do the records of every VEHICLE subject the
 *    account holds an OPEN, APPROVED link to (a fleet's insurance serves every assigned
 *    driver) — [High #9 · DS109] a PENDING link (retyped plate) propagates nothing.
 * Used by the verification service (predicate, validity bound, live-operation gate) and
 * by the service-provider projection — one rule, one implementation.
 */
import type { CoverageClass, Prisma, PrismaClient } from '@prisma/client';
import { validExpiryOr } from './document-validity';
import { HIRE_SPLIT_DOC_TYPES } from './hire-permit-grace';

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
  /** [ROLE-DOCS · PR 3] Who approved the record ('system' / 'kyc:auto' for an engine; else the reviewer's user id), and when. */
  approvedBy: string;
  approvedAt: Date;
}

export async function approvedEvidenceFor(db: EvidenceDb, userId: string, checklist: readonly string[], now: Date): Promise<EvidenceRow[]> {
  if (checklist.length === 0) return [];
  // [Owner ruling 15 Oct 2026 · no grace] The records alone. The old hire-car permit never stands in for the
  // Hire Car Driver's Licence or the car's hire licence (the 6 Oct 60-day allowance is removed).
  return recordEvidenceFor(db, userId, checklist, now);
}

/** The records themselves: the evidence rule. */
export async function recordEvidenceFor(db: EvidenceDb, userId: string, checklist: readonly string[], now: Date): Promise<EvidenceRow[]> {
  const vehicles = await db.subjectLink.findMany({
    where: { accountId: userId, validTo: null, approvedAt: { not: null }, subject: { kind: 'VEHICLE' } },
    select: { subjectId: true },
  });
  const vehicleIds = vehicles.map((v) => v.subjectId);
  const records = await db.documentRecord.findMany({
    where: {
      docType: { in: [...checklist] },
      status: 'VALID',
      AND: [
        // [FOLLOWUPS ruling] valid through the end of its expiry day in Guyana (document-validity.ts)
        { OR: validExpiryOr('expiresOn', now) },
        { OR: [{ accountId: userId }, ...(vehicleIds.length ? [{ subjectId: { in: vehicleIds } }] : [])] },
        { submission: { purgedAt: null, OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] } },
      ],
    },
    select: {
      docType: true, expiresOn: true, approvedBy: true, approvedAt: true,
      submission: { select: { retentionExpiresAt: true, reviewedAt: true, userId: true, subjectId: true, coverageClass: true, hireClassConfirmed: true, plateCrossChecked: true } },
    },
  });
  return records.map((r) => ({
    docType: r.docType, expiresAt: r.expiresOn, retentionExpiresAt: r.submission.retentionExpiresAt, reviewedAt: r.submission.reviewedAt,
    userId: r.submission.userId, subjectId: r.submission.subjectId, coverageClass: r.submission.coverageClass,
    hireClassConfirmed: r.submission.hireClassConfirmed, plateCrossChecked: r.submission.plateCrossChecked,
    approvedBy: r.approvedBy, approvedAt: r.approvedAt,
  }));
}

/**
 * [AUD-L8b-001] Has this account EVER held checklist evidence — valid, expired,
 * rejected or superseded?
 *
 * `approvedEvidenceFor` answers "what is current". This answers "was a record
 * for this type ever filed", which is the only question the legacy
 * `documentsVerified` grandfather clause was ever entitled to ask — and it is
 * asked of the MISSING types alone. A type missing because its record lapsed is
 * an expiry; a type missing because nothing was ever filed is the pre-checklist
 * state the clause exists for. Historical approved vehicle links remain relevant, including closed links.
 * Deliberately NO purge, status or expiry filter, because a
 * record that has expired is precisely the case the flag must not be allowed to
 * paper over.
 */
export async function anyChecklistEvidenceFor(db: EvidenceDb, userId: string, checklist: readonly string[], currentSubjectId?: string | null): Promise<boolean> {
  if (checklist.length === 0) return false;
  // The hire licences require current evidence, never a legacy flag (and never the old permit: no grace).
  if (checklist.some((type) => HIRE_SPLIT_DOC_TYPES.includes(type))) return true;
  // Historical links and retired submissions still establish that proof was
  // filed. A missing current record is not a never-filed legacy account.
  const vehicles = await db.subjectLink.findMany({
    where: { accountId: userId, approvedAt: { not: null }, subject: { kind: 'VEHICLE' } },
    select: { subjectId: true },
  });
  const vehicleIds = [...vehicles.map((v) => v.subjectId), ...(currentSubjectId ? [currentSubjectId] : [])];
  const held = await db.verificationDocument.count({
    where: {
      docType: { in: [...checklist] },
      OR: [{ userId }, ...(vehicleIds.length ? [{ subjectId: { in: vehicleIds } }] : [])],
    },
  });
  return held > 0;
}
