import type { Prisma, VehicleType } from '@prisma/client';
import { BUCKET_OF, VEHICLE_REGISTRATION_DOC_TYPE } from './doc-registry';
import { hopDocState } from './doc-state';
import { normalizeRegistrationMark, resolveSubject, rootSubjectId } from './subjects';
import type { VehicleSubmissionProfile } from './submission-authority';

const vehicleTypes = Object.entries(BUCKET_OF).filter(([, bucket]) => bucket === 'VEHICLE').map(([type]) => type);
const awaiting = ['REVIEW_QUEUED', 'IN_REVIEW', 'INFO_REQUESTED'] as const;

/**
 * [DOC-1 §24.2 · Opus 13 Oct, #1551 S2-1] Of these awaiting papers, the ones whose open case sits in
 * SECOND_REVIEW: a suspicion awaiting a DIFFERENT reviewer (a reviewer escalated it, or intake routed a
 * collision there). Its confirmation opens the fraud case and the legal hold, so a vehicle edit keeps such a
 * paper and its case exactly as they are, like a legal hold, and still succeeds (the applicant is never told
 * of suspicion). Only SECOND_REVIEW: ESCALATED is the review-SLA watchdog's "overdue", not suspicion.
 * The caller locks these papers' cases FOR UPDATE first, so an escalation that committed before the edit is
 * seen here.
 */
export async function papersUnderSecondReview(tx: Prisma.TransactionClient, awaitingIds: string[]): Promise<Set<string>> {
  if (awaitingIds.length === 0) return new Set();
  const cases = await tx.reviewCase.findMany({
    where: { submissionId: { in: awaitingIds }, closedAt: null, queue: 'SECOND_REVIEW' },
    select: { submissionId: true },
  });
  return new Set(cases.map((kase) => kase.submissionId));
}

/** Caller holds User and mover profile locks. Every writer uses the same review reset. */
export async function requireFreshVehicleReview(tx: Prisma.TransactionClient, userId: string, previousPlate: string | null, next: VehicleSubmissionProfile) {
  const now = new Date();
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true, countryCode: true } });
  const subjects = new Set<string>();
  for (const plate of [previousPlate, next.licensePlate]) {
    const registrationMark = normalizeRegistrationMark(plate ?? '');
    if (!registrationMark) continue;
    const vehicle = await tx.vehicleProfile.findUnique({ where: { registrationMark_countryCode: { registrationMark, countryCode: user.countryCode } }, select: { subjectId: true } });
    if (vehicle) { subjects.add(vehicle.subjectId); subjects.add(await rootSubjectId(tx, vehicle.subjectId)); }
  }
  await tx.subjectLink.updateMany({
    where: { accountId: userId, relation: 'ASSIGNED_DRIVER', validTo: null, subject: { kind: 'VEHICLE' } },
    data: { validTo: now },
  });
  const papers = await tx.verificationDocument.findMany({
    where: { userId, role: 'MOVER', docType: { in: vehicleTypes }, state: { in: ['COMMITTED', ...awaiting] },
      OR: [{ subjectId: null }, { subjectId: { in: [...subjects] } }] },
    select: { id: true, state: true, legalHoldId: true },
  });
  const mutable = papers.filter(paper => !paper.legalHoldId);
  const awaitingIds = mutable.filter(paper => paper.state !== 'COMMITTED').map(paper => paper.id);
  if (awaitingIds.length) {
    // Case, then paper (the escalation's order): the paper lock serializes with an escalation even when the paper
    // has no open case, so the second-review read below sees an escalation that committed first [DS1064 S3].
    await tx.$queryRaw`SELECT id FROM review_case WHERE "submissionId" = ANY(${awaitingIds}) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM verification_documents WHERE id = ANY(${awaitingIds}) ORDER BY id FOR UPDATE`;
  }
  const underSecondReview = await papersUnderSecondReview(tx, awaitingIds);
  const superseded: string[] = [], withdrawn: string[] = [];
  for (const paper of mutable) {
    if (underSecondReview.has(paper.id)) continue;
    if (paper.state === 'COMMITTED') {
      if (await hopDocState(tx, { id: paper.id, userId }, 'COMMITTED', 'SUPERSEDED', { reviewNote: 'SUPERSEDED: the mover changed vehicle identity' })) superseded.push(paper.id);
    } else if (await hopDocState(tx, { id: paper.id, userId }, [...awaiting], 'EXPIRED', { status: 'EXPIRED', reviewNote: 'WITHDRAWN: the mover changed vehicle identity' })) withdrawn.push(paper.id);
  }
  if (superseded.length) await tx.renewalSchedule.updateMany({ where: { documentId: { in: superseded }, suspendedAt: null }, data: { suspendedAt: now } });
  if (withdrawn.length) await tx.reviewCase.updateMany({ where: { submissionId: { in: withdrawn }, closedAt: null }, data: { closedAt: now } });
  const subject = await resolveSubject(tx, { userId, ...user, docType: VEHICLE_REGISTRATION_DOC_TYPE, vehicleProfile: next });
  if (subject) await tx.subjectLink.updateMany({ where: { id: subject.linkId }, data: { approvedAt: null } });
  await alignStoredVehicleKind(tx, userId, user.countryCode, next.licensePlate, next.vehicleType);
  return { superseded, withdrawn };
}

/**
 * [Opus 12 Oct · H-plate follow-up] The registrant re-declared the vehicle on this plate as another class
 * (a car declared as a motorbike, or back): the stored record follows the vehicle now in use, so it — not
 * one the mover no longer has — decides how that plate's papers are judged at approval. A vehicle another
 * account registered is never rewritten. (Old papers cannot smuggle the old class back: a taxi still needs
 * an H plate at approval and at go-online, and hire insurance at go-online.)
 */
export async function alignStoredVehicleKind(tx: Prisma.TransactionClient, userId: string, countryCode: string, plate: string | null | undefined, vehicleType: VehicleType) {
  const registrationMark = normalizeRegistrationMark(plate ?? '');
  if (!registrationMark) return;
  await tx.vehicleProfile.updateMany({
    where: { registrationMark, countryCode, registeredById: userId, vehicleKind: { not: vehicleType } },
    data: { vehicleKind: vehicleType },
  });
}
