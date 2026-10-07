import type { Prisma, PrismaClient } from '@prisma/client';
import { bindTenantTransaction } from '../../plugins/prisma';
import { formatMoney } from '../../utils/currency-amount';
import { LATE_WINDOW_MS } from '../billing/mmg-checkout.service';

/** Account closure preserves financial history. Earnings describe direct payments
 * between participants; Swift holds no balance to pay out. Open cash obligations
 * block erasure, and so does an open loss-protection claim: money Swift itself
 * owes the mover, which support pays or decides (coordinator ruling 2026-10-05,
 * Q1a). Rescue incentives deliberately do not block: they have no payout path
 * and ship switched off (rescue-incentive-deletion-rule.unit.test.ts). The
 * caller also checks live work under authority locks.
 *
 * [GUARDRAILS §1] Weekly-fee money also blocks: a checkout MMG can still
 * confirm (it would be credited to a cancelled, de-identified subscription
 * with no one to tell), an unresolved payment hold, and fee credit Swift holds
 * for the person. Never a silently dropped payment.
 */
export const PARTNER_BLOCKERS = ['CASH_HELD', 'UNSETTLED_CASH', 'OPEN_CLAIM', 'FEE_PAYMENT_PENDING', 'FEE_CREDIT'] as const;
export type PartnerBlocker = (typeof PARTNER_BLOCKERS)[number];

export interface PartnerObligations {
  /** Vendor cash the mover is holding right now, in major units. */
  committedFloat: number;
  /** Cash handovers neither the rider nor the store has closed out. */
  unsettledCashCount: number;
  /** Historical direct-payment earnings; not a Swift payout obligation. */
  earningsOwed: number;
  /** Loss-protection claims for this mover that Swift has neither paid nor rejected. */
  openClaimCount?: number;
  /** Fee checkouts MMG can still confirm, plus unresolved payment confirmation holds. */
  pendingFeePaymentCount?: number;
  /** Fee subscriptions with prepaid credit Swift holds for the person. */
  feeCreditCount?: number;
  /** Credit totals by the wallet's own currency; unlike amounts never mix. */
  feeCreditAmounts?: { currencyCode: string; amount: number }[];
}

export interface PartnerDeletionVerdict {
  blockers: PartnerBlocker[];
  /** Safe to erase — every blocker is clear. */
  clear: boolean;
}

/**
 * What still binds this partner.
 *
 * Deliberately narrow. Anything listed here refuses a person's erasure
 * request, and a refusal that is not about somebody's money is a refusal that
 * should have been a wind-down.
 */
export function verdictFor(o: PartnerObligations): PartnerDeletionVerdict {
  const blockers: PartnerBlocker[] = [];
  if (o.committedFloat > 0) blockers.push('CASH_HELD');
  if (o.unsettledCashCount > 0) blockers.push('UNSETTLED_CASH');
  if ((o.openClaimCount ?? 0) > 0) blockers.push('OPEN_CLAIM');
  if ((o.pendingFeePaymentCount ?? 0) > 0) blockers.push('FEE_PAYMENT_PENDING');
  if ((o.feeCreditCount ?? 0) > 0) blockers.push('FEE_CREDIT');
  return { blockers, clear: blockers.length === 0 };
}

/**
 * What the person is told, and what they can DO about it.
 *
 * Every line names a next action they can take themselves. "Contact Support"
 * is the exact answer this whole module exists to stop giving — and a refusal
 * a person cannot act on is the same dead end wearing a different code.
 */
export const BLOCKER_MESSAGE: Record<PartnerBlocker, string> = {
  CASH_HELD:
    'You are holding vendor cash from a delivery that has not been settled. Hand it in, then return here to delete your account. Use Get help if you cannot resolve the handover.',
  UNSETTLED_CASH:
    'A cash settlement is still open between you and a store. Confirm the handover, then return here to delete your account. Use Get help if the other party cannot confirm.',
  OPEN_CLAIM:
    'Swift has not finished paying a no-show claim it owes you. Wait for the payment, or open Get help to have it paid or closed, then return here to delete your account.',
  FEE_PAYMENT_PENDING:
    'A weekly-fee payment is still in progress or being confirmed with MMG. Wait for it to finish, or open Get help to have it resolved, then return here to delete your account.',
  // [Owner ruling 2026-10-07] Unused credit is refunded by support (recorded
  // in the admin console), then the account can be deleted.
  FEE_CREDIT:
    'You have {amount} of unused weekly-fee credit. Open Get help and we\u2019ll refund it, then your account can be deleted.',
};

/** The whole refusal, as one sentence a person can act on, with the amounts
 *  that apply to this person filled in. */
export function refusalMessage(blockers: PartnerBlocker[], o?: Pick<PartnerObligations, 'feeCreditAmounts'>): string {
  const credit = o?.feeCreditAmounts?.map(({ amount, currencyCode }) => formatMoney(amount, currencyCode, { whole: Number.isInteger(amount) })).join(' and ');
  return blockers.map((b) => b === 'FEE_CREDIT' && credit
    ? BLOCKER_MESSAGE[b].replace('{amount}', credit)
    : BLOCKER_MESSAGE[b]).join(' ');
}

/**
 * Read the obligations inside the caller's transaction.
 *
 * Inspect both sides of a cash handover, including a vendor-only partner.
 * Historical earnings are kept; they are not a balance held by Swift.
 */
export async function partnerObligations(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<PartnerObligations> {
  const [rider, driver] = await Promise.all([
    tx.rider.findUnique({ where: { userId }, select: { id: true, committedFloat: true } }),
    tx.driver.findUnique({ where: { userId }, select: { id: true } }),
  ]);
  const claimants = [...(rider ? [{ riderId: rider.id }] : []), ...(driver ? [{ driverId: driver.id }] : [])];
  const openClaimCount = claimants.length === 0 ? 0 : await tx.reimbursementClaim.count({
    where: { OR: claimants, paidAt: null, status: { in: ['PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED'] } },
  });
  const fees = await feeMoney(tx, userId);
  if (!rider && await tx.vendor.count({ where: { owner: { userId } } }) === 0) {
    return { committedFloat: 0, unsettledCashCount: 0, earningsOwed: 0, openClaimCount, ...fees };
  }

  const unsettled = await tx.deliveryCashSettlement.count({
    where: { status: { not: 'SETTLED' }, OR: [
      ...(rider ? [{ riderId: rider.id }] : []), { vendor: { owner: { userId } } },
    ] },
  });
  return {
    committedFloat: Number(rider?.committedFloat ?? 0),
    unsettledCashCount: unsettled,
    earningsOwed: 0,
    openClaimCount,
    ...fees,
  };
}

/** Weekly-fee money on the person's own fee subscriptions (as a mover, or as
 *  the owner of a store). Read under the caller's lock on the person's user
 *  row, which every fee checkout and credit also takes first (the fee payer
 *  lock), so no checkout can start or settle between this census and cutoff.
 *  EXPIRED and NOT_PAID checkouts are final only once no further MMG check is
 *  due and their late-reply window has closed: a late MMG reply re-arms them
 *  and a confirmation is still credited [MMG-CHECKOUT-API, DS782]. */
async function feeMoney(tx: Prisma.TransactionClient, userId: string) {
  const subscriptions = await tx.subscription.findMany({
    where: { OR: [{ rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }] },
    select: { id: true },
  });
  if (subscriptions.length === 0) return { pendingFeePaymentCount: 0, feeCreditCount: 0, feeCreditAmounts: [] };
  const subscriptionId = { in: subscriptions.map((sub) => sub.id) };
  const lateHorizon = new Date(Date.now() - LATE_WINDOW_MS);
  const [checkouts, cardPayments, payments, holds, credit] = await Promise.all([
    tx.mmgCheckoutIntent.count({ where: { subscriptionId, OR: [
      { status: { in: ['OPEN', 'CONFIRMING', 'HELD'] } },
      // [DS782 S2] A late MMG reply re-arms an EXPIRED or NOT_PAID checkout and
      // a confirmation is still credited, so it is final only once no check is
      // due AND its late-reply window has closed.
      { status: { in: ['EXPIRED', 'NOT_PAID'] }, OR: [
        { nextCheckAt: { not: null } },
        { createdAt: { gt: lateHorizon } },
        { replyAt: { gt: lateHorizon } },
      ] },
    ] } }),
    // A card payment for the fee still open, unknown or held (saving a card moves no money).
    tx.cardSession.count({ where: { subscriptionId, purpose: 'PAY_NOW', status: { in: ['OPEN', 'UNKNOWN', 'HELD'] } } }),
    // The weekly MMG prompt and any other fee payment not yet settled.
    tx.subscriptionPayment.count({ where: { subscriptionId, status: { in: ['PENDING', 'AUTHORIZED', 'UNKNOWN'] } } }),
    tx.paymentConfirmationHold.count({ where: { subscriptionId, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } } }),
    tx.prepaidBalance.groupBy({ by: ['currencyCode'], where: { subscriptionId, balance: { gt: 0 } }, orderBy: { currencyCode: 'asc' }, _count: { _all: true }, _sum: { balance: true } }),
  ]);
  return {
    pendingFeePaymentCount: checkouts + cardPayments + payments + holds,
    feeCreditCount: credit.reduce((count, group) => count + group._count._all, 0),
    feeCreditAmounts: credit.map((group) => ({ currencyCode: group.currencyCode, amount: Number(group._sum.balance ?? 0) })),
  };
}

// ── Winding down what is not a blocker ─────────────────────────────────────

export interface WindDownResult {
  vendorsClosed: number;
  itemsWithdrawn: number;
  staffRevoked: number;
  subscriptionsCancelled: number;
}

/**
 * Close what leaving implies, in the purge phase so a re-sweep repairs it.
 *
 * A storefront is taken off sale rather than deleted: its orders, receipts and
 * sales history are financial records under the same legal-obligation basis as
 * everything else the erasure keeps. What must stop is a customer being able to
 * order from a business that no longer has an owner.
 *
 * Every step is idempotent and none of them moves money — the same rule the
 * advertiser wind-down follows, and for the same reason.
 */
export async function windDownPartner(
  prisma: Prisma.TransactionClient | PrismaClient,
  userId: string,
): Promise<WindDownResult> {
  if ('$transaction' in prisma) return prisma.$transaction((tx) => windDownPartner(tx, userId));
  await bindTenantTransaction(prisma);
  // Cancellation shares the same payer-first order as activation, collection
  // and historical settlement, including all original mover sources.
  await prisma.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
  await prisma.$queryRaw`
    SELECT s.id FROM subscriptions s
    LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
    LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners o ON o.id=v."ownerId"
    WHERE r."userId"=${userId} OR d."userId"=${userId} OR o."userId"=${userId}
    ORDER BY s.id FOR UPDATE OF s
  `;
  const owner = await prisma.vendorOwner.findUnique({ where: { userId }, select: { id: true } });
  const vendorIds = owner
    ? (await prisma.vendor.findMany({ where: { ownerId: owner.id }, select: { id: true } })).map((v) => v.id)
    : [];

  // Billing suspension takes the subscription row before it updates the
  // partner's vendor/rider/driver access rows. Keep deletion in that same
  // order: starting vendor and subscription updates together allowed the
  // database to choose vendor-first here while billing held subscription-first,
  // producing a real ABBA deadlock under overlap.
  const [rider, driver] = await Promise.all([
    prisma.rider.findUnique({ where: { userId }, select: { id: true } }),
    prisma.driver.findUnique({ where: { userId }, select: { id: true } }),
  ]);
  const links: Prisma.SubscriptionWhereInput[] = [];
  if (rider) links.push({ riderId: rider.id });
  if (driver) links.push({ driverId: driver.id });
  if (vendorIds.length) links.push({ vendorId: { in: vendorIds } });
  const subs = links.length === 0
    ? { count: 0 }
    : await prisma.subscription.updateMany({
        // CHURNED is already terminal. CANCELLED is included so an idempotent
        // deletion re-sweep repairs rows written by the old wind-down, which
        // stopped access but left auto-renew and the retry clock armed.
        where: {
          OR: links,
          AND: [
            { status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE', 'PAUSED', 'SUSPENDED', 'CANCELLED'] } },
            { OR: [{ status: { not: 'CANCELLED' } }, { autoRenew: true }, { nextRetryAt: { not: null } }] },
          ],
        },
        data: { status: 'CANCELLED', autoRenew: false, nextRetryAt: null },
      });

  const [items, vendors, staff] = await Promise.all([
    vendorIds.length
      ? prisma.item.updateMany({ where: { vendorId: { in: vendorIds }, isAvailable: true }, data: { isAvailable: false } })
      : Promise.resolve({ count: 0 }),
    vendorIds.length
      ? prisma.vendor.updateMany({
          where: { id: { in: vendorIds } },
          data: { status: 'SUSPENDED', acceptingOrders: false, isCurrentlyOpen: false, suspensionSource: 'WIND_DOWN' },
        })
      : Promise.resolve({ count: 0 }),
    vendorIds.length
      ? prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } })
      : Promise.resolve({ count: 0 }),
  ]);

  // Retain mover rows and their earnings/FKs, but remove live location,
  // vehicle identity and personal payment destinations after account closure.
  if (rider) await prisma.rider.update({ where: { id: rider.id }, data: {
    isOnline: false, isAvailable: false, locationSessionId: null,
    currentLat: null, currentLng: null, lastLocationUpdate: null,
    licensePlate: null,
  } });
  if (driver) await prisma.driver.update({ where: { id: driver.id }, data: {
    isOnline: false, isAvailable: false, locationSessionId: null,
    currentLat: null, currentLng: null, lastLocationUpdate: null,
    licensePlate: 'Deleted', mmgPayUrl: null, mmgPayUrlPending: null,
    mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null,
  } });

  return {
    vendorsClosed: vendors.count,
    itemsWithdrawn: items.count,
    staffRevoked: staff.count,
    subscriptionsCancelled: subs.count,
  };
}
