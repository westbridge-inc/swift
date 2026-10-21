import type { DocState, Prisma, PrismaClient, UserRole } from '@prisma/client';
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

/** The mover roles: one person's riding and driving are one mover account, so a signal for either counts for all three. */
export const MOVER_ROLES: readonly UserRole[] = ['RIDER', 'DRIVER', 'MOVER'];

/**
 * The partner roles this person was EVER verified for (COORD rulings 16:2xZ security review + 16:50Z). Durable signals
 * only, never which id a subscription row happens to be keyed on; one approved document alone does NOT count (an
 * incomplete application is swept on the 76/90-day clock).
 *  - Mover (RIDER, DRIVER, MOVER together): the full checklist verified now or ever (documentsVerified / documentsVerifiedAt,
 *    or `moverChecklistComplete` now), a mover fee authority (born on activation), any subscription held by the person's
 *    rider OR driver profile, or ever online in the role (online now, a location or a liveness pass on record, an order
 *    ever assigned).
 *  - Store (VENDOR_OWNER): any store verified now, ever activated (activationValidUntil), or holding a subscription.
 *  - Service provider (CUSTOMER partner documents): verified now, or ever given a job.
 */
export async function everVerifiedRoles(db: Db, userId: string, moverChecklistComplete?: () => Promise<boolean>): Promise<Set<UserRole>> {
  const moverSelect = {
    id: true, documentsVerified: true, documentsVerifiedAt: true, isOnline: true, lastLocationUpdate: true,
    lastLivenessPassAt: true, _count: { select: { orders: true } },
  } as const;
  const [rider, driver, owner, provider, feeAuthority] = await Promise.all([
    db.rider.findUnique({ where: { userId }, select: moverSelect }),
    db.driver.findUnique({ where: { userId }, select: moverSelect }),
    db.vendorOwner.findUnique({ where: { userId }, select: { vendors: { select: { id: true, isVerified: true, activationValidUntil: true } } } }),
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
  const mover = verifiedMover || everOnline || !!feeAuthority || moverSubscriptions > 0
    || (movers.length > 0 && !!moverChecklistComplete && await moverChecklistComplete());
  if (mover) for (const r of MOVER_ROLES) roles.add(r);
  if (vendorSubscriptions > 0 || owner?.vendors.some((v) => v.isVerified || v.activationValidUntil)) roles.add('VENDOR_OWNER');
  if (provider && (provider.isVerified || provider._count.jobs > 0)) roles.add('CUSTOMER');
  return roles;
}
