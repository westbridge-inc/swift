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
import { HIRE_PERMIT_DOC_TYPE, HIRE_SPLIT_DOC_TYPES, openHirePermitGrace } from './hire-permit-grace';

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
  const rows = await recordEvidenceFor(db, userId, checklist, now);
  // [VERIFY-DOCS · owner ruling, 6 Oct 2026 ~21:25 GYT] While the 60-day window after the hire-car
  // permit split is open, a VALID, unexpired permit counts as BOTH of the licences that replace it,
  // until it expires or the window closes, whichever is first. Same rule, same record source: the
  // permit's own evidence row, carried under the new type names with the earlier end date.
  const split = HIRE_SPLIT_DOC_TYPES.filter((t) => checklist.includes(t));
  if (split.length > 0) {
    const graceEnd = await openHirePermitGrace(db, now);
    if (graceEnd) {
      for (const permit of await recordEvidenceFor(db, userId, [HIRE_PERMIT_DOC_TYPE], now)) {
        const ends = permit.expiresAt && permit.expiresAt.getTime() < graceEnd.getTime() ? permit.expiresAt : graceEnd;
        for (const docType of split) rows.push({ ...permit, docType, expiresAt: ends });
      }
    }
  }
  return rows;
}

/** The records themselves: the evidence rule before any transition allowance. */
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
  // Replacement licences require current evidence or the explicit permit grace, never a legacy flag.
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

/**
 * [VERIFY-DOCS · hire-car permit split] Until when this account's approved permit stands in for the
 * two new licences (the earlier of its expiry and the 60-day window's end), or null if it does not.
 */
export async function hirePermitGraceUntil(db: EvidenceDb, userId: string, now: Date): Promise<Date | null> {
  const graceEnd = await openHirePermitGrace(db, now);
  if (!graceEnd) return null;
  let until: Date | null = null;
  for (const permit of await recordEvidenceFor(db, userId, [HIRE_PERMIT_DOC_TYPE], now)) {
    const ends = permit.expiresAt && permit.expiresAt.getTime() < graceEnd.getTime() ? permit.expiresAt : graceEnd;
    if (!until || ends.getTime() > until.getTime()) until = ends;
  }
  return until;
}
