import type { DocState, Prisma, PrismaClient, UserRole } from '@prisma/client';
import type { ChecklistRole } from './verification.service';
import { runAsSystem } from '../../plugins/tenant-context';
import { DAY_MS } from './retention-rules';

/**
 * [Row 249 · COORD 17:09Z ruling option A (18 Oct, delegated privacy)] An ABANDONED application.
 *
 * The applicant left it: nothing of theirs waits on Swift (no document in our pipeline or a
 * reviewer's queue), and they did nothing on their application for ABANDON_PURGE_DAYS. At
 * ABANDON_NOTICE_DAYS they get an in-app notice; ABANDON_NOTICE_LEAD_DAYS after that notice
 * (never before day ABANDON_PURGE_DAYS) the documents go through the one fenced purge
 * (verification.service purgeDocumentNow: a legal hold beats it, a receipt per document).
 * Any activity after the notice voids it: the clock restarts from that activity, and a fresh
 * notice is needed before anything is deleted.
 *
 *  - "Activity" = a document submitted, a decision of ours on one, or an upload made.
 *  - A role the person was EVER verified for is not an application: a Subscription is born on
 *    full verification (rider, driver, store); a service provider counts if verified now or ever
 *    given a job. Its documents follow the participant rules (scheduleDocumentRetention), never this.
 *  - A customer's own ID is not a partner document (PARTNER_DOCUMENT_WHERE), an AML record keeps
 *    its own law, a synthetic account and an erased account are never swept here.
 */
export const ABANDON_NOTICE_DAYS = 76;
export const ABANDON_PURGE_DAYS = 90;
export const ABANDON_NOTICE_LEAD_DAYS = ABANDON_PURGE_DAYS - ABANDON_NOTICE_DAYS;
export const ABANDON_NOTICE_ACTION = 'VERIFICATION_APPLICATION_ABANDON_NOTICE';
/** The receipts' deletedBy for a document the abandoned-application sweep deleted. */
export const ABANDON_PURGE_ACTOR = 'abandoned-application';

export const ABANDON_NOTICE_TITLE = 'Your unfinished application';
export const ABANDON_NOTICE_BODY =
  'Your unfinished application documents will be deleted in 14 days. Finish your application now, or upload them again later.';

/** Every state in which a document waits on Swift (our pipeline, our reviewers, our commit) — never abandoned. */
export const WAITING_ON_SWIFT_STATES: readonly DocState[] = [
  'CAPTURED', 'PREPROCESSED', 'EXTRACTING', 'EXTRACTED', 'VALIDATED', 'AUTO_APPROVED', 'REVIEW_QUEUED', 'IN_REVIEW', 'APPROVED',
];

export const WAITING_ON_SWIFT_WHERE: Prisma.VerificationDocumentWhereInput = {
  OR: [{ state: { in: [...WAITING_ON_SWIFT_STATES] } }, { state: null, status: 'PENDING' }],
};

/**
 * The guard the purge re-checks under the person's lock (purgeDocumentNow `still`): nothing of theirs
 * waits on Swift and nothing happened on their documents since the activity the notice was about.
 * A submission takes the same lock, so a document submitted at the last moment stops the purge.
 */
export function stillAbandoned(lastActivityAt: Date): Prisma.VerificationDocumentWhereInput {
  return {
    user: {
      verificationDocuments: {
        none: { OR: [WAITING_ON_SWIFT_WHERE, { createdAt: { gt: lastActivityAt } }, { reviewedAt: { gt: lastActivityAt } }] },
      },
    },
  };
}

/** When the documents may go: day 90 of inactivity, and never sooner than 14 days after the notice. */
export function abandonPurgeDueAt(lastActivityAt: Date, noticeAt: Date): Date {
  return new Date(Math.max(lastActivityAt.getTime() + ABANDON_PURGE_DAYS * DAY_MS, noticeAt.getTime() + ABANDON_NOTICE_LEAD_DAYS * DAY_MS));
}

type Db = Pick<PrismaClient, 'rider' | 'driver' | 'vendorOwner' | 'serviceProvider' | 'subscription' | 'moverFeeAuthority'>;

/**
 * [Row 249 · REVIEW-M S4-3 · COORD rulings 18:4xZ + security review] AN OPEN CASE KEEPS THE DOCUMENTS, like a hold: no
 * notice, nothing deleted, until it closes (then the 76/90-day clock applies as usual). The census covers EVERY case,
 * report, dispute and hold model that can name a person, directly or through their rider, driver or store ids, and a
 * report about something of theirs (their rating, message, store or item). Checked before the notice and again right
 * before the purge; any lookup error reads as an open case (fail toward keeping).
 *
 * Not in the census, with the reason: Strike (a record, not a case: nothing to close), LegalHold (it hangs off an
 * IncidentCase, covered there), SosRetrigger / SosEscalation (they hang off an SosAlert, covered there), AttributionClaim
 * (names no person).
 */
export const OPEN_CASE_CENSUS = [
  'fraud_case', 'identity_review_case', 'enforcement_appeal', 'incident_case', 'sos_alert', 'safety_deletion_hold',
  'doc_legal_hold', 'compliance_review_case', 'compliance_violation', 'review_case', 'rectification_request',
  'custody_recovery_case', 'content_report', 'rating_report', 'reimbursement_claim', 'support_ticket', 'payment_confirmation_hold',
] as const;
export type OpenCaseKind = (typeof OPEN_CASE_CENSUS)[number];

/** Every open case naming this person, by census name. Throws on any lookup error (the caller keeps). */
export async function openCasesOf(db: PrismaClient, userId: string): Promise<OpenCaseKind[]> {
  const [docs, rider, driver, owner, member] = await Promise.all([
    db.verificationDocument.findMany({ where: { userId }, select: { id: true } }),
    db.rider.findUnique({ where: { userId }, select: { id: true } }),
    db.driver.findUnique({ where: { userId }, select: { id: true } }),
    db.vendorOwner.findUnique({ where: { userId }, select: { vendors: { select: { id: true } } } }),
    db.identityClusterMember.findUnique({ where: { accountId: userId }, select: { clusterId: true } }),
  ]);
  const docIds = docs.map((d) => d.id);
  const moverIds = [rider?.id, driver?.id].filter((id): id is string => !!id);
  const vendorIds = owner?.vendors.map((v) => v.id) ?? [];
  const subscriptionIds = (moverIds.length || vendorIds.length ? await db.subscription.findMany({
    where: { OR: [{ riderId: { in: moverIds } }, { driverId: { in: moverIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true },
  }) : []).map((x) => x.id);
  const checks: Record<OpenCaseKind, () => Promise<number>> = {
    fraud_case: () => db.fraudCase.count({ where: { OR: [{ subjectUserId: userId }, { submissionId: { in: docIds } }] } }),
    identity_review_case: async () => member ? db.identityReviewCase.count({ where: { clusterId: member.clusterId, status: 'OPEN' } }) : 0,
    enforcement_appeal: () => db.enforcementAction.count({ where: { accountId: userId, appeal: 'OPEN' } }),
    incident_case: () => db.incidentCase.count({ where: {
      OR: [{ subjectUserId: userId }, { reporterUserId: userId }],
      AND: [{ OR: [{ status: { not: 'CLOSED' } }, { legalHold: true }, { legalHoldRecord: { isNot: null } }] }],
    } }),
    sos_alert: () => db.sosAlert.count({ where: {
      OR: [{ actorUserId: userId }, { counterpartyUserId: userId }], status: { in: ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] },
    } }),
    safety_deletion_hold: () => db.safetyDeletionHold.count({ where: { userId, status: 'PENDING' } }),
    doc_legal_hold: () => db.docLegalHold.count({ where: { OR: [{ subjectUserId: userId }, { ownerId: userId }], releasedAt: null } }),
    compliance_review_case: () => db.complianceReviewCase.count({ where: { userId, status: 'OPEN' } }),
    compliance_violation: () => db.complianceViolation.count({ where: { userId, resolvedAt: null } }),
    review_case: async () => docIds.length ? db.reviewCase.count({ where: { submissionId: { in: docIds }, closedAt: null } }) : 0,
    rectification_request: () => db.rectificationRequest.count({ where: { OR: [{ userId }, { submissionId: { in: docIds } }], resolvedAt: null } }),
    custody_recovery_case: () => db.custodyRecoveryCase.count({ where: {
      OR: [{ ownerUserId: userId }, { holderRiderId: { in: moverIds } }, { relayRiderId: { in: moverIds } }], resolvedAt: null,
    } }),
    // A report by them, about them, or about their rating (written or received), message, store or item.
    content_report: async () => (await db.$queryRaw<Array<{ n: number }>>`
      SELECT 1 AS n FROM content_reports r
      WHERE r."status"::text IN ('PENDING', 'REVIEWING') AND (
        r."reporterId" = ${userId}
        OR (r."targetType"::text = 'USER' AND r."targetId" = ${userId})
        OR (r."targetType"::text = 'RATING' AND EXISTS (SELECT 1 FROM ratings x WHERE x."id" = r."targetId" AND (x."raterId" = ${userId} OR x."rateeId" = ${userId})))
        OR (r."targetType"::text = 'CHAT_MESSAGE' AND EXISTS (SELECT 1 FROM chat_messages m WHERE m."id" = r."targetId" AND m."senderId" = ${userId}))
        OR (r."targetType"::text = 'VENDOR' AND EXISTS (SELECT 1 FROM vendors v JOIN vendor_owners o ON o."id" = v."ownerId" WHERE v."id" = r."targetId" AND o."userId" = ${userId}))
        OR (r."targetType"::text = 'ITEM' AND EXISTS (SELECT 1 FROM items i JOIN vendors v ON v."id" = i."vendorId" JOIN vendor_owners o ON o."id" = v."ownerId" WHERE i."id" = r."targetId" AND o."userId" = ${userId}))
      ) LIMIT 1 /* abandoned-application-open-case-census */
    `).length,
    rating_report: async () => (await db.$queryRaw<Array<{ n: number }>>`
      SELECT 1 AS n FROM rating_reports r LEFT JOIN ratings x ON x."id" = r."ratingId"
      WHERE r."status" = 'PENDING' AND (r."reporterId" = ${userId} OR x."raterId" = ${userId} OR x."rateeId" = ${userId})
      LIMIT 1 /* abandoned-application-open-case-census */
    `).length,
    reimbursement_claim: () => db.reimbursementClaim.count({ where: {
      OR: [{ customerId: userId }, { riderId: { in: moverIds } }, { driverId: { in: moverIds } }], status: { in: ['PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED'] },
    } }),
    support_ticket: () => db.supportTicket.count({ where: { userId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    payment_confirmation_hold: async () => subscriptionIds.length
      ? db.paymentConfirmationHold.count({ where: { subscriptionId: { in: subscriptionIds }, resolvedAt: null } }) : 0,
  };
  const open: OpenCaseKind[] = [];
  for (const kind of OPEN_CASE_CENSUS) if (await checks[kind]() > 0) open.push(kind);
  return open;
}

/** True while any open case names the person; any error reads as an open case (fail toward keeping). */
export async function openCaseKeeps(db: PrismaClient, userId: string): Promise<boolean> {
  try {
    return (await runAsSystem('verification:abandoned-case-census', () => openCasesOf(db, userId))).length > 0;
  } catch {
    return true;
  }
}

/** A document Swift approved at some point (it may since have lapsed, or its image gone). */
export const EVER_APPROVED_WHERE: Prisma.VerificationDocumentWhereInput = {
  OR: [{ state: { in: ['AUTO_APPROVED', 'APPROVED', 'COMMITTED', 'EXPIRED'] } }, { status: { in: ['APPROVED', 'EXPIRED'] } }, { imagePurgedAt: { not: null } }],
};

/** The mover roles: one person's riding and driving are one mover account, so a signal for either counts for all three. */
export const MOVER_ROLES: readonly UserRole[] = ['RIDER', 'DRIVER', 'MOVER'];

/**
 * The partner roles this person was EVER verified for (COORD rulings 16:2xZ security review + 16:50Z). Durable signals
 * only, never which id a subscription row happens to be keyed on; one approved document alone does NOT count (an
 * incomplete application is swept on the 76/90-day clock).
 *  - Mover (RIDER, DRIVER, MOVER together): the full checklist verified now or ever (documentsVerified / documentsVerifiedAt,
 *    or every required document ever approved: `checklistComplete`), a mover fee authority (born on activation), any subscription held by the person's
 *    rider OR driver profile, or ever online in the role (online now, a location or a liveness pass on record, an order
 *    ever assigned).
 *  - Store (VENDOR_OWNER): any store verified now, ever activated (activationValidUntil), holding a subscription, or its
 *    type's full checklist ever approved (waiting on activation or payment is not abandonment).
 *  - Service provider (CUSTOMER partner documents): verified now, ever given a job, or the provider checklist ever approved.
 */
export async function everVerifiedRoles(db: Db, userId: string, checklistComplete?: (roleKey: ChecklistRole) => Promise<boolean>): Promise<Set<UserRole>> {
  const moverSelect = {
    id: true, documentsVerified: true, documentsVerifiedAt: true, isOnline: true, lastLocationUpdate: true,
    lastLivenessPassAt: true, _count: { select: { orders: true } },
  } as const;
  const [rider, driver, owner, provider, feeAuthority] = await Promise.all([
    db.rider.findUnique({ where: { userId }, select: moverSelect }),
    db.driver.findUnique({ where: { userId }, select: moverSelect }),
    db.vendorOwner.findUnique({ where: { userId }, select: { vendors: { select: { id: true, vendorType: true, isVerified: true, activationValidUntil: true } } } }),
    db.serviceProvider.findUnique({ where: { userId }, select: { isVerified: true, _count: { select: { jobs: true } } } }),
    db.moverFeeAuthority.findUnique({ where: { userId }, select: { userId: true } }),
  ]);
  const vendorIds = owner?.vendors.map((v) => v.id) ?? [];
  const movers = [rider, driver].filter((p): p is NonNullable<typeof p> => !!p);
  const moverIds = movers.map((p) => p.id);
  const [moverSubscriptions, vendorSubscriptions] = await Promise.all([
    moverIds.length ? db.subscription.count({ where: { OR: [{ riderId: { in: moverIds } }, { driverId: { in: moverIds } }] } }) : 0,
    vendorIds.length ? db.subscription.count({ where: { vendorId: { in: vendorIds } } }) : 0,
  ]);
  const roles = new Set<UserRole>();
  const verifiedMover = movers.some((p) => p.documentsVerified || p.documentsVerifiedAt);
  const everOnline = movers.some((p) => p.isOnline || p.lastLocationUpdate || p.lastLivenessPassAt || p._count.orders > 0);
  // The full checklist approved at any time, per role (verification.service everCompletedChecklist; fails toward keeping).
  const complete = async (roleKey: ChecklistRole) => !!checklistComplete && await checklistComplete(roleKey);
  const mover = verifiedMover || everOnline || !!feeAuthority || moverSubscriptions > 0 || await complete('MOVER');
  if (mover) for (const r of MOVER_ROLES) roles.add(r);
  let store = vendorSubscriptions > 0 || !!owner?.vendors.some((v) => v.isVerified || v.activationValidUntil);
  // A store's own type; with no store row yet, every store type (fail toward keeping).
  const storeTypes: ChecklistRole[] = owner?.vendors.length ? owner.vendors.map((v) => v.vendorType) : ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'];
  for (const t of storeTypes) if (!store && await complete(t)) store = true;
  if (store) roles.add('VENDOR_OWNER');
  if ((provider && (provider.isVerified || provider._count.jobs > 0)) || await complete('SERVICE_PROVIDER')) roles.add('CUSTOMER');
  return roles;
}
