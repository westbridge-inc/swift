import type { Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { lockVendorActivationBilling } from '../billing/billing-access';
import { ACTIVE_CONFIRMATION_STATES, feeReversalOpenInTx, lateCardApprovalHeldInTx } from '../billing/dunning-clock';
import { CountryConfigService } from '../country/country-config.service';
import { weeklyFeeAmount } from '../billing/subscription-fee';

// ---------------------------------------------------------------------------
// [CHAINS · owner 29 Oct 2026] A CHAIN DEAL: the weekly fee Swift negotiated with
// one business owner for each of its branches. Decision 49 stays (no automatic
// multi-store discount): a person at Swift sets a deal, with a reason, and a
// second person approves it (C4, admin-authority.ts). Paying stays one MMG
// checkout per branch.
//
// The deal is the owner's (VendorOwner.deal*), so a branch approved LATER is born
// on it (SubscriptionService.createRow), and it is written on each branch's
// subscription as its custom rate, which billing already charges
// (subscription-fee.ts weeklyFeeFor) and the weekly re-tier already leaves alone.
//
// MONEY RULES (GUARDRAILS §1, §7 standing rule 2):
//  - A deal never RAISES a fee, on any day. It is a STANDING rule: written on
//    every branch as its custom rate, and the biller charges the lower of the
//    custom rate and the branch's own tier rate (subscription-fee.ts), so a
//    branch whose own fee is lower keeps it (OWN_FEE_LOWER), a branch that
//    moves down a tier pays the lower tier, and a deal branch never moves UP a
//    tier (billing.service recalculateVendorTiers). A deal can only be set at or under the
//    owner's current deal: ending or raising one is a fee rise, which needs the
//    14-day fee-change notice flow, never this button (DEAL_RISE_NEEDS_NOTICE).
//  - It applies from each branch's NEXT weekly fee. A charge already issued keeps
//    its amount (amount-due.ts issuedChargeDue); a paid week keeps its price.
//  - A branch with a payment in flight (an open or confirming MMG checkout, a
//    confirmation hold, a held late card approval, a reversal) is left untouched
//    (PAYMENT_IN_FLIGHT): its quote is never changed under a payment. Setting the
//    same deal again later applies it there (the call is idempotent).
//  - Everything is decided under the locks fee settlement takes (the owner's
//    account row, then every subscription of the owner's stores in id order:
//    billing-access.ts lockVendorActivationBilling).
// ---------------------------------------------------------------------------

export type BranchDealOutcome = 'APPLIED' | 'OWN_FEE_LOWER' | 'UNCHANGED' | 'WOULD_RAISE' | 'PAYMENT_IN_FLIGHT' | 'NOT_BILLED' | 'OTHER_CURRENCY' | 'NO_FEE_YET';

export interface BranchDealRow {
  vendorId: string;
  vendorName: string;
  subscriptionId: string | null;
  status: SubscriptionStatus | null;
  /** The fee the branch pays per week before this call (custom rate, else its tier rate). */
  from: number | null;
  /** The fee it pays per week from its next weekly fee after this call. */
  to: number | null;
  outcome: BranchDealOutcome;
}

export interface ChainDealResult {
  ownerId: string;
  ownerUserId: string;
  dealWeeklyRate: number;
  currencyCode: string;
  branches: BranchDealRow[];
}

const NOT_BILLED: readonly SubscriptionStatus[] = ['CANCELLED', 'CHURNED'];

/** A payment of this subscription's weekly fee that is not settled yet: its quote must not change under it. */
async function paymentInFlight(tx: Prisma.TransactionClient, subscriptionId: string): Promise<boolean> {
  const [checkout, hold] = await Promise.all([
    tx.mmgCheckoutIntent.findFirst({ where: { subscriptionId, status: { in: ['OPEN', 'CONFIRMING'] } }, select: { id: true } }),
    tx.paymentConfirmationHold.findFirst({ where: { subscriptionId, status: { in: [...ACTIVE_CONFIRMATION_STATES] } }, select: { id: true } }),
  ]);
  return !!checkout || !!hold || await lateCardApprovalHeldInTx(tx, [subscriptionId]) || await feeReversalOpenInTx(tx, [subscriptionId]);
}

/** The owner's stores and what each pays per week, as the admin console shows a chain. Reads only. */
export async function chainOf(prisma: PrismaClient, ownerId: string, tenantId: string) {
  const owner = await prisma.vendorOwner.findUnique({
    where: { id: ownerId },
    select: {
      id: true, dealWeeklyRate: true, dealCurrencyCode: true, dealSetAt: true, dealSetBy: true, dealReason: true, brandName: true,
      user: { select: { tenantId: true } },
      vendors: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, name: true, status: true, city: true, brandListedAlone: true,
          subscription: { select: { id: true, status: true, weeklyRate: true, customRate: true, feeWaived: true, currencyCode: true, trialEndDate: true, nextBillingDate: true } },
        },
      },
    },
  });
  if (!owner || owner.user.tenantId !== tenantId) throw new NotFoundError('VendorOwner', ownerId);
  return {
    ownerId: owner.id,
    // [CHAINS PR3] The brand customers see once for these branches (null: none), and which branch is listed alone.
    brandName: owner.brandName,
    deal: owner.dealWeeklyRate === null ? null : {
      weeklyRate: Number(owner.dealWeeklyRate), currencyCode: owner.dealCurrencyCode, setAt: owner.dealSetAt, setBy: owner.dealSetBy, reason: owner.dealReason,
    },
    branches: owner.vendors.map((v) => ({
      vendorId: v.id, name: v.name, status: v.status, city: v.city, brandListedAlone: v.brandListedAlone,
      subscription: v.subscription ? {
        id: v.subscription.id, status: v.subscription.status, currencyCode: v.subscription.currencyCode, feeWaived: v.subscription.feeWaived,
        weeklyRate: Number(v.subscription.weeklyRate),
        customRate: v.subscription.customRate === null ? null : Number(v.subscription.customRate),
        weeklyFee: v.subscription.feeWaived ? 0 : weeklyFeeAmount(v.subscription),
        trialEndDate: v.subscription.trialEndDate, nextBillingDate: v.subscription.nextBillingDate,
      } : null,
    })),
  };
}

/**
 * Set (or lower) the owner's chain deal and write it on every branch it may apply to, in ONE transaction with the
 * caller's audit row (`audit`, called last inside it: a refused audit rolls everything back).
 */
export async function setChainDeal(
  prisma: PrismaClient,
  input: { ownerId: string; weeklyRate: number; reason: string; adminUserId: string; tenantId: string; now?: Date },
  audit: (tx: Prisma.TransactionClient, result: ChainDealResult) => Promise<void>,
): Promise<ChainDealResult> {
  if (!Number.isInteger(input.weeklyRate) || input.weeklyRate <= 0) {
    throw new AppError(400, 'DEAL_RATE_INVALID', 'A chain deal is a whole amount above zero. To stop charging a branch, waive its fee.');
  }
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const found = await tx.vendorOwner.findUnique({ where: { id: input.ownerId }, select: { userId: true, user: { select: { tenantId: true } } } });
    if (!found || found.user.tenantId !== input.tenantId) throw new NotFoundError('VendorOwner', input.ownerId);
    // The settlement lock order: the owner's account row, then each of the owner's subscriptions by id.
    await lockVendorActivationBilling(tx, found.userId);
    const owner = await tx.vendorOwner.findUniqueOrThrow({
      where: { id: input.ownerId },
      select: {
        id: true, userId: true, dealWeeklyRate: true,
        user: { select: { countryCode: true } },
        vendors: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true, subscription: true } },
      },
    });
    if (owner.dealWeeklyRate !== null && input.weeklyRate > Number(owner.dealWeeklyRate)) {
      throw new AppError(409, 'DEAL_RISE_NEEDS_NOTICE',
        `This chain's deal is ${Number(owner.dealWeeklyRate)} a week. Raising it raises the owner's fees, which needs the 14-day fee-change notice, not a new deal.`,
        { current: Number(owner.dealWeeklyRate) });
    }
    const currencyCode = await new CountryConfigService(prisma).getCurrencyCode(owner.user.countryCode, tx);
    const branches: BranchDealRow[] = [];
    for (const vendor of owner.vendors) {
      const sub = vendor.subscription;
      const row = (outcome: BranchDealOutcome, to: number | null = null): BranchDealRow => ({
        vendorId: vendor.id, vendorName: vendor.name, subscriptionId: sub?.id ?? null, status: sub?.status ?? null,
        from: sub ? weeklyFeeAmount(sub) : null, to, outcome,
      });
      // Not live yet: the branch is born on the deal when Swift approves it (SubscriptionService.createRow).
      if (!sub) { branches.push(row('NO_FEE_YET')); continue; }
      // What the branch is charged now: its custom rate, never above its tier rate (weeklyFeeFor).
      const from = weeklyFeeAmount(sub);
      if (NOT_BILLED.includes(sub.status) || sub.feeWaived) { branches.push(row('NOT_BILLED', sub.feeWaived ? 0 : null)); continue; }
      if (sub.currencyCode !== currencyCode) { branches.push(row('OTHER_CURRENCY', from)); continue; }
      if (sub.customRate !== null && Number(sub.customRate) === input.weeklyRate) { branches.push(row('UNCHANGED', from)); continue; }
      // The fee the branch would pay on the deal: the deal, or its own tier rate when that is lower (weeklyFeeFor).
      const to = weeklyFeeAmount({ weeklyRate: sub.weeklyRate, customRate: input.weeklyRate });
      // Never a rise: e.g. a branch on an older, lower custom rate keeps it.
      if (to > from) { branches.push(row('WOULD_RAISE', from)); continue; }
      if (await paymentInFlight(tx, sub.id)) { branches.push(row('PAYMENT_IN_FLIGHT', from)); continue; }
      // The deal is a STANDING rule (REVIEW-G/M #2211 S3-1): written on every branch as its custom rate, so the branch
      // pays the lower of the deal and its own tier rate on every future week, whichever way its tier moves.
      await tx.subscription.update({ where: { id: sub.id }, data: { customRate: input.weeklyRate } });
      if (to === from) { branches.push(row('OWN_FEE_LOWER', from)); continue; }
      const seq = await tx.billingEvent.count({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } }) + 1;
      await tx.billingEvent.create({ data: {
        subscriptionId: sub.id, type: 'TIER_CHANGE', amount: input.weeklyRate, currencyCode: sub.currencyCode,
        idempotencyKey: `chaindeal:${sub.id}:${seq}:${from}->${input.weeklyRate}`,
        note: `Chain deal: the weekly fee changes from ${from} to ${input.weeklyRate} from the next weekly fee; issued charges and paid weeks keep their amount.`,
      } });
      branches.push(row('APPLIED', input.weeklyRate));
    }
    await tx.vendorOwner.update({
      where: { id: owner.id },
      data: { dealWeeklyRate: input.weeklyRate, dealCurrencyCode: currencyCode, dealSetAt: now, dealSetBy: input.adminUserId, dealReason: input.reason },
    });
    const result: ChainDealResult = { ownerId: owner.id, ownerUserId: owner.userId, dealWeeklyRate: input.weeklyRate, currencyCode, branches };
    await audit(tx, result);
    return result;
  });
}
