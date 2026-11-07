import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { subscriptionOperability } from '../subscription/operate-gate';
import { readFeePause } from '../billing/mmg-pause';
import type { ChecklistRole } from '../verification/verification.service';
import { storeHoldRefusal } from './store-hold';

type Db = Prisma.TransactionClient | PrismaClient;

/** The one verification read the gate needs (VerificationService.isRoleVerified). */
export interface StoreRoleVerifier {
  isRoleVerified(userId: string, roleKey: ChecklistRole, db?: Db, vendorId?: string): Promise<boolean>;
}

/** Why a business may not take on this work right now (null = it may). */
export type VendorOperateRefusal =
  | { why: 'HOLD'; store: { status: string; suspensionSource: string | null } }
  | { why: 'UNVERIFIED' }
  | { why: 'GRACE_LAPSED' }
  | { why: 'SUBSCRIPTION_INACTIVE' };

/**
 * [BOOK-S3] THE "may this business work orders" predicate, one implementation for
 * every door that moves an order forward for a business: the business's own order
 * routes (vendor.routes assertVendorCanOperate: accept, prepare, ready, complete)
 * and an instant booking's standing acceptance at checkout (order.service), so an
 * automatic confirmation is never given by a business that could not accept the
 * booking itself. Reads on `db` (the caller's transaction, or the root client).
 *
 * A vendor may only DRIVE an order FORWARD while eligible to operate. The
 * doc-expiry sweep sets isVerified=false but leaves status ACTIVE, so a lapsed
 * store is refused here on verification (invariant 2).
 * [BILLING-INFLIGHT · owner ruling 1 Oct ~22:10] "Suspended store: accepted
 * orders are completed; new orders are blocked until it pays." A weekly-fee hold
 * (a billing suspension, or a lapsed fee grace) refuses NEW work only: `work:
 * 'IN_FLIGHT'` (progress on an order the store already accepted) skips the
 * billing arm. Every other hold keeps its rule on both kinds of work: an
 * admin/safety/moderation suspension, a closed store, expired documents. A null
 * suspension source is billing's (the transition rule reinstate uses).
 */
export async function vendorOperateRefusal(
  db: Db,
  verifier: StoreRoleVerifier,
  vendorId: string,
  work: 'NEW' | 'IN_FLIGHT' = 'NEW',
): Promise<VendorOperateRefusal | null> {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { isVerified: true, status: true, vendorType: true, suspensionSource: true },
  });
  if (!vendor) throw new NotFoundError('Vendor', vendorId);
  // [Fable #1481 S4-1] Only a suspension billing stamped is a billing hold; one with no source (e.g. an owner
  // closing their account) keeps the ordinary rule.
  const billingHold = vendor.status === 'SUSPENDED' && vendor.suspensionSource === 'BILLING';
  if ((vendor.status === 'SUSPENDED' && !(work === 'IN_FLIGHT' && billingHold)) || vendor.status === 'CLOSED') {
    return { why: 'HOLD', store: vendor };
  }
  // The verification gate belongs to the BUSINESS (its owner), not to whoever is
  // logged in — a verified store stays verified when staff work in it.
  const verified = vendor.isVerified || (await verifier.isRoleVerified(
    (await db.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { owner: { select: { userId: true } } } })).owner.userId,
    vendor.vendorType as ChecklistRole,
    db,
    vendorId,
  ));
  if (!verified) return { why: 'UNVERIFIED' };
  // THE canOperate rule (operate-gate.ts, G-BILL-03): the grace-lapse check
  // included, so a PAST_DUE vendor whose grace ran out stops at once.
  const sub = await db.subscription.findFirst({ where: { vendorId }, orderBy: { createdAt: 'desc' } });
  // The subscription arm is billing's: it gates NEW work only. (Read either
  // way, so every order step keeps one shape between its order read and its
  // write; the golden race suites hold the route at this read.)
  if (work === 'IN_FLIGHT') return null;
  const operability = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' }, await readFeePause(db, process.env, sub?.id));
  if (!operability.operable) return { why: operability.why === 'GRACE_LAPSED' ? 'GRACE_LAPSED' : 'SUBSCRIPTION_INACTIVE' };
  return null;
}

/** The refusal the BUSINESS reads on its own order routes (unchanged words and codes). */
export function vendorOperateError(refusal: VendorOperateRefusal): AppError {
  switch (refusal.why) {
    // [NO-DEAD-ENDS] Name the hold, what lifts it and what still works —
    // never "Reopen it from Account": no such control exists (store-hold.ts).
    case 'HOLD': return storeHoldRefusal(refusal.store);
    case 'UNVERIFIED': return new AppError(403, 'VERIFICATION_REQUIRED', 'Your store’s documents need verifying before you can work orders — check Documents for anything expired.');
    case 'GRACE_LAPSED': return new AppError(403, 'SUBSCRIPTION_PAST_DUE', 'Your grace period has ended — pay this week’s fee to keep working orders.');
    default: return new AppError(403, 'SUBSCRIPTION_INACTIVE', 'Your subscription must be active to work orders — renew from Account.');
  }
}

/** [BOOK-S3] What the CUSTOMER reads when a business that confirms bookings
 *  automatically cannot take this booking right now: no order is placed. */
export const BUSINESS_CANNOT_CONFIRM_CODE = 'BUSINESS_CANNOT_CONFIRM_BOOKINGS';
export function businessCannotConfirmBooking(vendorName: string): AppError {
  return new AppError(409, BUSINESS_CANNOT_CONFIRM_CODE, `${vendorName} can't take bookings right now, so this time can't be booked. Please try again later.`);
}
