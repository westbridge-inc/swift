import type { DocState, Prisma, PrismaClient, UserRole } from '@prisma/client';
import type { ChecklistRole } from './verification.service';
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

type CaseDb = Pick<PrismaClient, 'verificationDocument' | 'rider' | 'driver' | 'fraudCase' | 'incidentCase' | 'complianceReviewCase' | 'reviewCase'
  | 'identityClusterMember' | 'identityReviewCase' | 'custodyRecoveryCase' | 'contentReport' | 'ratingReport' | 'reimbursementClaim'>;

/**
 * [Row 249 · REVIEW-M S4-3 · COORD ruling 18:4xZ] An OPEN fraud, safety, compliance or dispute case on the person or on
 * one of their documents keeps their documents, like a hold: no notice, nothing deleted, until it closes (then the
 * 76/90-day clock applies as usual). Fails toward keeping: any error reads as an open case.
 *  - fraud: any confirmed FraudCase on the person or a document (it has no closed state: the founder decides), an OPEN
 *    identity review of the person's identity cluster;
 *  - safety: an IncidentCase the person is subject or reporter of that is not CLOSED, or is under a legal hold;
 *  - compliance: an OPEN ComplianceReviewCase; a document ReviewCase not closed;
 *  - disputes: an unresolved custody recovery the person owns, a content report by or about them still PENDING or
 *    REVIEWING, a rating report of theirs still PENDING, a reimbursement claim on them not yet decided or paid.
 */
export async function openCaseKeeps(db: CaseDb, userId: string): Promise<boolean> {
  try {
    const [docs, rider, driver, member] = await Promise.all([
      db.verificationDocument.findMany({ where: { userId }, select: { id: true } }),
      db.rider.findUnique({ where: { userId }, select: { id: true } }),
      db.driver.findUnique({ where: { userId }, select: { id: true } }),
      db.identityClusterMember.findUnique({ where: { accountId: userId }, select: { clusterId: true } }),
    ]);
    const docIds = docs.map((d) => d.id);
    const counts = await Promise.all([
      db.fraudCase.count({ where: { OR: [{ subjectUserId: userId }, { submissionId: { in: docIds } }] } }),
      member ? db.identityReviewCase.count({ where: { clusterId: member.clusterId, status: 'OPEN' } }) : 0,
      db.incidentCase.count({ where: {
        OR: [{ subjectUserId: userId }, { reporterUserId: userId }],
        AND: [{ OR: [{ status: { not: 'CLOSED' } }, { legalHold: true }, { legalHoldRecord: { isNot: null } }] }],
      } }),
      db.complianceReviewCase.count({ where: { userId, status: 'OPEN' } }),
      docIds.length ? db.reviewCase.count({ where: { submissionId: { in: docIds }, closedAt: null } }) : 0,
      db.custodyRecoveryCase.count({ where: { ownerUserId: userId, resolvedAt: null } }),
      db.contentReport.count({ where: { OR: [{ targetId: userId }, { reporterId: userId }], status: { in: ['PENDING', 'REVIEWING'] } } }),
      db.ratingReport.count({ where: { reporterId: userId, status: 'PENDING' } }),
      db.reimbursementClaim.count({ where: {
        OR: [{ customerId: userId }, ...(rider ? [{ riderId: rider.id }] : []), ...(driver ? [{ driverId: driver.id }] : [])],
        status: { in: ['PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED'] },
      } }),
    ]);
    return counts.some((n) => n > 0);
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
