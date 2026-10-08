/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026, ~21:25 GYT] HOME VISITS NEED A POLICE CLEARANCE.
 *
 * "Service businesses: a home-visit booking is possible only while the owner holds an
 * approved, current police clearance; in-shop listings never need it." Marketplace
 * tradespeople (SERVICE_PROVIDER) keep it as a requirement of their own list.
 *
 * A home visit is an appointment listing whose service mode brings the business to the
 * customer: MOBILE, or BOTH when the customer does not choose the business's place
 * (the checkout's own rule, order.service). The clearance is read through THE evidence
 * rule (document records): approved, VALID and unexpired — so it survives its image
 * being deleted after review, and lapses with the certificate's re-check date.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { guyanaDayKey, startOfGuyanaDay } from '../../utils/guyana-day';
import { approvedEvidenceFor } from './evidence';
import { POLICE_CLEARANCE_DOC_TYPE } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

export const HOME_VISIT_UNAVAILABLE = 'HOME_VISIT_UNAVAILABLE';
export const HOME_VISITS_PAUSED_TITLE = 'Home visits are paused';

/** Does the owner hold an approved, current police clearance? */
export async function homeVisitsCleared(db: Db, ownerUserId: string, now: Date = new Date()): Promise<boolean> {
  return (await approvedEvidenceFor(db, ownerUserId, [POLICE_CLEARANCE_DOC_TYPE], now)).length > 0;
}

/** Does any store this person owns list a service that comes to the customer? */
export async function ownerOffersHomeVisits(db: Db, ownerUserId: string): Promise<boolean> {
  const listing = await db.item.findFirst({
    where: {
      vendor: { owner: { userId: ownerUserId } },
      fulfillment: 'APPOINTMENT',
      OR: [
        { bookingConfig: { path: ['serviceMode'], equals: 'MOBILE' } },
        { bookingConfig: { path: ['serviceMode'], equals: 'BOTH' } },
      ],
    },
    select: { id: true },
  });
  return listing !== null;
}

/** What the customer is told. A BOTH listing can still be booked at the business's place. */
export function homeVisitRefusal(vendorName: string, inShopAvailable: boolean): AppError {
  return new AppError(
    409,
    HOME_VISIT_UNAVAILABLE,
    inShopAvailable
      ? `${vendorName} can't come to your home yet. You can book this service at their place instead.`
      : `${vendorName} can't come to your home yet, so this service can't be booked right now. Please try again later.`,
  );
}

/**
 * What the owner is told, at most once a Guyana day: a customer wanted a home visit and
 * could not book one, and what unlocks it. Never thrown into the customer's checkout.
 */
export async function tellOwnerHomeVisitsPaused(
  db: Db,
  notifications: { send: (input: { userId: string; type: 'SYSTEM_ANNOUNCEMENT'; title: string; body: string; audience: 'business'; dedupeKey?: string }) => Promise<unknown> },
  ownerUserId: string,
  vendorName: string,
  now: Date = new Date(),
): Promise<boolean> {
  const already = await db.notification.findFirst({
    where: { userId: ownerUserId, title: HOME_VISITS_PAUSED_TITLE, createdAt: { gte: startOfGuyanaDay(guyanaDayKey(now)) } },
    select: { id: true },
  });
  if (already) return false;
  await notifications.send({
    userId: ownerUserId,
    type: 'SYSTEM_ANNOUNCEMENT',
    title: HOME_VISITS_PAUSED_TITLE,
    body: `A customer tried to book a home visit from ${vendorName}. Home visits need your police clearance, approved and current. Upload it under Documents; bookings at your place are not affected.`,
    audience: 'business',
    dedupeKey: `home-visits-paused:${guyanaDayKey(now)}`,
  });
  return true;
}
