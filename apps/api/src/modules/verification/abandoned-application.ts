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

type Db = Pick<PrismaClient, 'rider' | 'driver' | 'vendorOwner' | 'serviceProvider' | 'subscription'>;

/**
 * The partner roles this person was EVER verified for (durable signals only: vendor/provider
 * isVerified flip back on a lapse, a Subscription row never goes away). CUSTOMER here means the
 * service-provider documents (stored with role CUSTOMER); MOVER is both rider and driver.
 */
export async function everVerifiedRoles(db: Db, userId: string): Promise<Set<UserRole>> {
  const [rider, driver, owner, provider] = await Promise.all([
    db.rider.findUnique({ where: { userId }, select: { id: true } }),
    db.driver.findUnique({ where: { userId }, select: { id: true } }),
    db.vendorOwner.findUnique({ where: { userId }, select: { vendors: { select: { id: true, isVerified: true } } } }),
    db.serviceProvider.findUnique({ where: { userId }, select: { isVerified: true, _count: { select: { jobs: true } } } }),
  ]);
  const vendorIds = owner?.vendors.map((v) => v.id) ?? [];
  const holders: Prisma.SubscriptionWhereInput[] = [
    ...(rider ? [{ riderId: rider.id }] : []),
    ...(driver ? [{ driverId: driver.id }] : []),
    ...(vendorIds.length ? [{ vendorId: { in: vendorIds } }] : []),
  ];
  const subscribed = holders.length
    ? await db.subscription.findMany({ where: { OR: holders }, select: { riderId: true, driverId: true, vendorId: true } })
    : [];
  const roles = new Set<UserRole>();
  if (subscribed.some((s) => s.riderId)) { roles.add('RIDER'); roles.add('MOVER'); }
  if (subscribed.some((s) => s.driverId)) { roles.add('DRIVER'); roles.add('MOVER'); }
  if (subscribed.some((s) => s.vendorId) || owner?.vendors.some((v) => v.isVerified)) roles.add('VENDOR_OWNER');
  if (provider && (provider.isVerified || provider._count.jobs > 0)) roles.add('CUSTOMER');
  return roles;
}
