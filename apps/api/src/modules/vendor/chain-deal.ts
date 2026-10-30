import type { Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { lockVendorActivationBilling } from '../billing/billing-access';
import { ACTIVE_CONFIRMATION_STATES, feeReversalOpenInTx, lateCardApprovalHeldInTx } from '../billing/dunning-clock';
import { CountryConfigService } from '../country/country-config.service';
import { weeklyFeeAmount } from '../billing/subscription-fee';
import { FEE_RISE_NOTICE_DAYS, feeRiseKey, holdChainDealRiseInTx, readHeldFeeRise, type HeldFeeRise } from '../billing/fee-rise-notice';

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
  /** [ENTERPRISE E2] Held rises of a pending deal change this deal dropped (the caller tells those already told). */
  droppedRises?: DroppedRise[];
}

/** [ENTERPRISE E2] END: the deal stops, each branch back to its own tier fee. RAISE: a higher deal. */
export type DealChangeKind = 'END' | 'RAISE';
export interface DroppedRise { subscriptionId: string; held: HeldFeeRise }

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
      id: true, dealWeeklyRate: true, dealCurrencyCode: true, dealSetAt: true, dealSetBy: true, dealReason: true,
      dealChangeKind: true, dealChangeFrom: true, dealChangeTo: true, dealChangeNotBefore: true, dealChangeReason: true,
      dealChangeSetBy: true, dealChangeSetAt: true, dealChangeSwitchedAt: true,
      user: { select: { tenantId: true } },
      vendors: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, name: true, status: true, city: true,
          subscription: { select: { id: true, status: true, weeklyRate: true, customRate: true, feeWaived: true, currencyCode: true, trialEndDate: true, nextBillingDate: true } },
        },
      },
    },
  });
  if (!owner || owner.user.tenantId !== tenantId) throw new NotFoundError('VendorOwner', ownerId);
  // [ENTERPRISE E2] Each branch's held fee change, as the billing run will tell and apply it.
  const subIds = owner.vendors.flatMap((v) => (v.subscription ? [v.subscription.id] : []));
  const rises = subIds.length ? await prisma.platformConfig.findMany({ where: { key: { in: subIds.map(feeRiseKey) } }, select: { key: true, value: true } }) : [];
  const riseOf = new Map(rises.map((r) => [r.key, readHeldFeeRise(r.value)]));
  return {
    ownerId: owner.id,
    deal: owner.dealWeeklyRate === null ? null : {
      weeklyRate: Number(owner.dealWeeklyRate), currencyCode: owner.dealCurrencyCode, setAt: owner.dealSetAt, setBy: owner.dealSetBy, reason: owner.dealReason,
    },
    change: owner.dealChangeKind === null ? null : {
      kind: owner.dealChangeKind as DealChangeKind, from: Number(owner.dealChangeFrom), to: owner.dealChangeTo === null ? null : Number(owner.dealChangeTo),
      notBefore: owner.dealChangeNotBefore, reason: owner.dealChangeReason, setBy: owner.dealChangeSetBy, setAt: owner.dealChangeSetAt,
      switchedAt: owner.dealChangeSwitchedAt,
    },
    branches: owner.vendors.map((v) => ({
      vendorId: v.id, name: v.name, status: v.status, city: v.city,
      subscription: v.subscription ? {
        id: v.subscription.id, status: v.subscription.status, currencyCode: v.subscription.currencyCode, feeWaived: v.subscription.feeWaived,
        weeklyRate: Number(v.subscription.weeklyRate),
        customRate: v.subscription.customRate === null ? null : Number(v.subscription.customRate),
        weeklyFee: v.subscription.feeWaived ? 0 : weeklyFeeAmount(v.subscription),
        trialEndDate: v.subscription.trialEndDate, nextBillingDate: v.subscription.nextBillingDate,
        heldChange: heldChangeView(riseOf.get(feeRiseKey(v.subscription.id)) ?? null),
      } : null,
    })),
  };
}

/** A branch's held fee change, as the admin console shows it: what it pays now and then, and when (once told). */
function heldChangeView(held: HeldFeeRise | null) {
  if (!held) return null;
  return {
    source: held.source, from: held.from, to: held.to, told: held.noticeAt !== null, toldAt: held.noticeAt, appliesFrom: held.appliesFrom,
    ...(held.source === 'CHAIN_DEAL' ? { dealTo: held.customTo ?? null, notBefore: held.notBefore ?? null } : {}),
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
        `This chain's deal is ${Number(owner.dealWeeklyRate)} a week. Raising it raises the owner's fees: use "Raise deal" or "End deal", which tell every branch 14 days ahead.`,
        { current: Number(owner.dealWeeklyRate) });
    }
    // [ENTERPRISE E2] A lower deal supersedes a pending end or raise: that change will not happen, and every branch's
    // held rise for it is dropped (a branch already told is told it will not happen, after the commit).
    const superseded = await supersedeDealChangeInTx(tx, input.ownerId, 'SUPERSEDED_BY_LOWER_DEAL', input.adminUserId, now);
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
    const result: ChainDealResult = { ownerId: owner.id, ownerUserId: owner.userId, dealWeeklyRate: input.weeklyRate, currencyCode, branches, droppedRises: superseded };
    await audit(tx, result);
    return result;
  });
}

// ---------------------------------------------------------------------------
// [ENTERPRISE E2 · owner 29 Oct 2026 "just do whats best"; COORD ruling 21:28Z]
// A chain deal's END date, and "end deal" / "raise deal". Both RAISE what the
// branches pay, so both go through the fee-change notice (GUARDRAILS s7
// standing rule 2; fee-rise-notice.ts): every branch on the deal is told in
// the app at least 14 days ahead (FEE_RISE_NOTICE_DAYS), pays the new fee only
// from its first weekly fee due on or after the end date AND 14 days after it
// was told, and a week already paid keeps its price. Never retroactive.
//
//  - The change is the owner's (VendorOwner.dealChange*, one at a time). A
//    person at Swift asks for it with a reason; a second person approves (C4).
//  - From 14 days before its end date (at once for "end now"), each branch
//    still on the deal gets a held CHAIN_DEAL rise (sweepChainDealChanges, every
//    billing run; idempotent). A branch whose fee does not go up (its own tier
//    fee is already at or under the deal) simply leaves the deal: no notice.
//    A held rise that stops matching (the branch's tier moved) is dropped by the
//    billing run and held again here with the new numbers, told again.
//  - At the end date the owner's own deal moves to the new terms (a branch
//    approved after that is born on them); the change is done once no branch
//    is left on the old deal.
//  - A LOWER deal (setChainDeal) supersedes a pending change, and cancelling it
//    is always allowed: neither raises anything, and every held rise of it is
//    dropped (a branch already told is told it will not happen).
// ---------------------------------------------------------------------------

/** A change may be asked for at most this far ahead. */
export const DEAL_CHANGE_MAX_AHEAD_DAYS = 366;
const DAY_MS = 86_400_000;
/** Branches are held (and so told) this long before the end date: the notice period, plus a day of slack. */
export const DEAL_CHANGE_HOLD_LEAD_MS = (FEE_RISE_NOTICE_DAYS + 1) * DAY_MS;

export type BranchChangeOutcome = 'HELD' | 'UNCHANGED' | 'LEFT_DEAL' | 'NOT_ON_DEAL' | 'NOT_BILLED' | 'NO_FEE_YET' | 'WAITING';
export interface BranchChangeRow { vendorId: string; vendorName: string; subscriptionId: string | null; from: number | null; to: number | null; outcome: BranchChangeOutcome }
export interface DealChangeResult {
  ownerId: string;
  ownerUserId: string;
  kind: DealChangeKind;
  dealFrom: number;
  dealTo: number | null;
  notBefore: string;
  branches: BranchChangeRow[];
}

/**
 * Ask for an END or a RAISE of the owner's chain deal, from `notBefore` (now when absent), in ONE transaction with
 * the caller's audit row. Branches are held for the notice at once when the end date is within the notice period.
 */
export async function changeChainDeal(
  prisma: PrismaClient,
  input: { ownerId: string; kind: DealChangeKind; weeklyRate?: number | null; notBefore?: Date | null; reason: string; adminUserId: string; tenantId: string; now?: Date },
  audit: (tx: Prisma.TransactionClient, result: DealChangeResult) => Promise<void>,
): Promise<DealChangeResult> {
  const now = input.now ?? new Date();
  const notBefore = input.notBefore ?? now;
  if (Number.isNaN(notBefore.getTime()) || notBefore.getTime() < now.getTime() - 60_000 || notBefore.getTime() > now.getTime() + DEAL_CHANGE_MAX_AHEAD_DAYS * DAY_MS) {
    throw new AppError(400, 'DEAL_CHANGE_DATE_INVALID', `The end date is today or a day within the next ${DEAL_CHANGE_MAX_AHEAD_DAYS} days. A fee never changes for a past week.`);
  }
  if (input.kind === 'RAISE' && (!Number.isInteger(input.weeklyRate) || !(Number(input.weeklyRate) > 0))) {
    throw new AppError(400, 'DEAL_RATE_INVALID', 'A raised deal is a whole amount above zero.');
  }
  if (input.kind === 'END' && input.weeklyRate != null) throw new AppError(400, 'DEAL_RATE_INVALID', 'Ending a deal names no new deal.');
  return prisma.$transaction(async (tx) => {
    const found = await tx.vendorOwner.findUnique({ where: { id: input.ownerId }, select: { userId: true, user: { select: { tenantId: true } } } });
    if (!found || found.user.tenantId !== input.tenantId) throw new NotFoundError('VendorOwner', input.ownerId);
    await lockVendorActivationBilling(tx, found.userId);
    const owner = await tx.vendorOwner.findUniqueOrThrow({ where: { id: input.ownerId }, select: { id: true, userId: true, dealWeeklyRate: true, dealChangeKind: true } });
    if (owner.dealWeeklyRate === null) throw new AppError(409, 'NO_DEAL', 'This owner has no chain deal to end or raise.');
    if (owner.dealChangeKind !== null) {
      throw new AppError(409, 'DEAL_CHANGE_PENDING', 'A change to this deal is already pending. Cancel it first, or set a lower deal.');
    }
    const dealFrom = Number(owner.dealWeeklyRate);
    const dealTo = input.kind === 'RAISE' ? Number(input.weeklyRate) : null;
    if (dealTo !== null && !(dealTo > dealFrom)) {
      throw new AppError(409, 'DEAL_NOT_RAISED', `The deal is ${dealFrom} a week now. A lower or equal deal is set with "Set deal", which applies from the next weekly fee.`, { current: dealFrom });
    }
    await tx.vendorOwner.update({ where: { id: owner.id }, data: {
      dealChangeKind: input.kind, dealChangeFrom: dealFrom, dealChangeTo: dealTo, dealChangeNotBefore: notBefore,
      dealChangeReason: input.reason, dealChangeSetBy: input.adminUserId, dealChangeSetAt: now, dealChangeSwitchedAt: null,
    } });
    const branches = await holdBranchesInTx(tx, owner.id, now);
    const result: DealChangeResult = { ownerId: owner.id, ownerUserId: owner.userId, kind: input.kind, dealFrom, dealTo, notBefore: notBefore.toISOString(), branches };
    await audit(tx, result);
    return result;
  });
}

/** Cancel the owner's pending deal change before the deal moves (nothing is raised; every held rise of it dropped). */
export async function cancelChainDealChange(
  prisma: PrismaClient,
  input: { ownerId: string; reason: string; adminUserId: string; tenantId: string; now?: Date },
  audit: (tx: Prisma.TransactionClient, dropped: DroppedRise[]) => Promise<void>,
): Promise<DroppedRise[]> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const found = await tx.vendorOwner.findUnique({ where: { id: input.ownerId }, select: { userId: true, user: { select: { tenantId: true } } } });
    if (!found || found.user.tenantId !== input.tenantId) throw new NotFoundError('VendorOwner', input.ownerId);
    await lockVendorActivationBilling(tx, found.userId);
    const owner = await tx.vendorOwner.findUniqueOrThrow({ where: { id: input.ownerId }, select: { dealChangeKind: true, dealChangeSwitchedAt: true } });
    if (owner.dealChangeKind === null) throw new AppError(409, 'NO_DEAL_CHANGE', 'There is no pending change to this deal.');
    if (owner.dealChangeSwitchedAt !== null) {
      throw new AppError(409, 'DEAL_CHANGE_IN_FORCE', 'This change already took effect for the owner. To bring the fee back down, set a lower deal.');
    }
    const dropped = await supersedeDealChangeInTx(tx, input.ownerId, `CANCELLED: ${input.reason}`, input.adminUserId, now);
    await audit(tx, dropped);
    return dropped;
  });
}

/** Clear a pending change and drop every held rise of it, under the owner's billing locks (the caller holds them). */
async function supersedeDealChangeInTx(tx: Prisma.TransactionClient, ownerId: string, why: string, actor: string, now: Date): Promise<DroppedRise[]> {
  const owner = await tx.vendorOwner.findUniqueOrThrow({
    where: { id: ownerId },
    select: { dealChangeKind: true, dealChangeFrom: true, dealChangeTo: true, dealChangeNotBefore: true, vendors: { select: { subscription: { select: { id: true } } } } },
  });
  if (owner.dealChangeKind === null) return [];
  const dropped: DroppedRise[] = [];
  for (const vendor of owner.vendors) {
    const subId = vendor.subscription?.id;
    if (!subId) continue;
    const key = feeRiseKey(subId);
    const row = await tx.platformConfig.findUnique({ where: { key } });
    const held = row ? readHeldFeeRise(row.value) : null;
    if (!held || held.source !== 'CHAIN_DEAL') continue;
    await tx.platformConfig.delete({ where: { key } });
    await tx.auditLog.create({ data: { action: 'BILLING_FEE_RISE_DROPPED', entity: 'Subscription', entityId: subId, changes: {
      from: held.from, to: held.to, told: held.noticeAt !== null, appliesFrom: held.appliesFrom, why: 'DEAL_CHANGE_WITHDRAWN', detail: why,
      customFrom: held.customFrom ?? null, customTo: held.customTo ?? null,
    } } });
    dropped.push({ subscriptionId: subId, held });
  }
  await tx.vendorOwner.update({ where: { id: ownerId }, data: {
    dealChangeKind: null, dealChangeFrom: null, dealChangeTo: null, dealChangeNotBefore: null, dealChangeReason: null,
    dealChangeSetBy: null, dealChangeSetAt: null, dealChangeSwitchedAt: null,
  } });
  await tx.auditLog.create({ data: { action: 'CHAIN_DEAL_CHANGE_WITHDRAWN', entity: 'VendorOwner', entityId: ownerId, userId: actor, changes: {
    kind: owner.dealChangeKind, dealFrom: Number(owner.dealChangeFrom), dealTo: owner.dealChangeTo === null ? null : Number(owner.dealChangeTo),
    notBefore: owner.dealChangeNotBefore?.toISOString() ?? null, why, droppedRises: dropped.length, at: now.toISOString(),
  } } });
  return dropped;
}

/**
 * Hold, for the fee-change notice, every branch still on the deal a pending change moves (the caller holds the
 * owner's billing locks). Before the hold lead nothing is held (WAITING): the notice goes out about 15 days ahead.
 */
async function holdBranchesInTx(tx: Prisma.TransactionClient, ownerId: string, now: Date): Promise<BranchChangeRow[]> {
  const owner = await tx.vendorOwner.findUniqueOrThrow({
    where: { id: ownerId },
    select: {
      dealChangeKind: true, dealChangeFrom: true, dealChangeTo: true, dealChangeNotBefore: true,
      vendors: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true, subscription: true } },
    },
  });
  if (owner.dealChangeKind === null || owner.dealChangeFrom === null || owner.dealChangeNotBefore === null) return [];
  const dealFrom = Number(owner.dealChangeFrom);
  const dealTo = owner.dealChangeTo === null ? null : Number(owner.dealChangeTo);
  const notBefore = owner.dealChangeNotBefore;
  const due = now.getTime() >= notBefore.getTime() - DEAL_CHANGE_HOLD_LEAD_MS;
  const rows: BranchChangeRow[] = [];
  for (const vendor of owner.vendors) {
    const sub = vendor.subscription;
    const row = (outcome: BranchChangeOutcome, from: number | null = null, to: number | null = null): BranchChangeRow => ({
      vendorId: vendor.id, vendorName: vendor.name, subscriptionId: sub?.id ?? null, from, to, outcome,
    });
    if (!sub) { rows.push(row('NO_FEE_YET')); continue; }
    if (sub.customRate === null || Number(sub.customRate) !== dealFrom) { rows.push(row('NOT_ON_DEAL', weeklyFeeAmount(sub))); continue; }
    const from = weeklyFeeAmount(sub);
    const to = weeklyFeeAmount({ weeklyRate: sub.weeklyRate, customRate: dealTo });
    // Nothing moves before the notice period of the end date begins: the branch stays on the deal.
    if (!due) { rows.push(row('WAITING', from, to)); continue; }
    if (NOT_BILLED.includes(sub.status) || sub.feeWaived || !(to > from)) {
      // Nothing it is charged goes up (not billed, waived, or its own tier fee is at or under the deal): it leaves
      // the deal for the new terms now, with no notice to give and no fee changed.
      await tx.subscription.update({ where: { id: sub.id }, data: { customRate: dealTo } });
      await tx.auditLog.create({ data: { action: 'CHAIN_DEAL_BRANCH_LEFT', entity: 'Subscription', entityId: sub.id, changes: {
        ownerId, dealFrom, dealTo, charged: from, chargedAfter: sub.feeWaived ? 0 : to, status: sub.status, feeWaived: sub.feeWaived,
      } } });
      rows.push(row('LEFT_DEAL', from, to));
      continue;
    }
    const held = await holdChainDealRiseInTx(tx, {
      subscriptionId: sub.id, from, to, customFrom: dealFrom, customTo: dealTo, notBefore, currencyCode: sub.currencyCode,
      sourceRef: `chain-deal:${ownerId}`, now,
    });
    rows.push(row(held === 'held' ? 'HELD' : 'UNCHANGED', from, to));
  }
  return rows;
}

/**
 * Every billing run: move each owner's pending deal change on. Hold the branches due their notice, move the owner's
 * own deal to the new terms at the end date, and close the change once no branch is left on the old deal. One
 * owner's failure never stops the others. The billing run then tells and applies the held rises (sweepFeeRises).
 */
export async function sweepChainDealChanges(prisma: PrismaClient, now = new Date()): Promise<{ owners: number; held: number; switched: number; done: number }> {
  const out = { owners: 0, held: 0, switched: 0, done: 0 };
  const owners = await prisma.vendorOwner.findMany({ where: { dealChangeKind: { not: null } }, select: { id: true, userId: true }, orderBy: { id: 'asc' } });
  for (const { id, userId } of owners) {
    try {
      await prisma.$transaction(async (tx) => {
        await lockVendorActivationBilling(tx, userId);
        const owner = await tx.vendorOwner.findUniqueOrThrow({ where: { id } });
        if (owner.dealChangeKind === null || owner.dealChangeFrom === null || owner.dealChangeNotBefore === null) return;
        out.owners += 1;
        const rows = await holdBranchesInTx(tx, id, now);
        out.held += rows.filter((r) => r.outcome === 'HELD').length;
        const dealTo = owner.dealChangeTo === null ? null : Number(owner.dealChangeTo);
        if (owner.dealChangeSwitchedAt === null && now.getTime() >= owner.dealChangeNotBefore.getTime()) {
          // The owner's own deal moves to the new terms: a branch approved from now on is born on them.
          await tx.vendorOwner.update({ where: { id }, data: dealTo === null
            ? { dealWeeklyRate: null, dealCurrencyCode: null, dealSetAt: null, dealSetBy: null, dealReason: null, dealChangeSwitchedAt: now }
            : { dealWeeklyRate: dealTo, dealSetAt: now, dealSetBy: owner.dealChangeSetBy, dealReason: owner.dealChangeReason, dealChangeSwitchedAt: now } });
          await tx.auditLog.create({ data: { action: 'CHAIN_DEAL_CHANGE_IN_FORCE', entity: 'VendorOwner', entityId: id, changes: {
            kind: owner.dealChangeKind, dealFrom: Number(owner.dealChangeFrom), dealTo, notBefore: owner.dealChangeNotBefore.toISOString(), at: now.toISOString(),
          } } });
          out.switched += 1;
        }
        const switched = owner.dealChangeSwitchedAt !== null || now.getTime() >= owner.dealChangeNotBefore.getTime();
        const remaining = await tx.subscription.count({ where: { vendor: { ownerId: id }, customRate: owner.dealChangeFrom } });
        if (switched && remaining === 0) {
          await tx.vendorOwner.update({ where: { id }, data: {
            dealChangeKind: null, dealChangeFrom: null, dealChangeTo: null, dealChangeNotBefore: null, dealChangeReason: null,
            dealChangeSetBy: null, dealChangeSetAt: null, dealChangeSwitchedAt: null,
          } });
          await tx.auditLog.create({ data: { action: 'CHAIN_DEAL_CHANGE_DONE', entity: 'VendorOwner', entityId: id, changes: {
            kind: owner.dealChangeKind, dealFrom: Number(owner.dealChangeFrom), dealTo, at: now.toISOString(),
          } } });
          out.done += 1;
        }
      });
    } catch (err) {
      log().error({ err, ownerId: id }, '[E2] a chain deal change could not be moved on; the next billing run retries');
    }
  }
  return out;
}
