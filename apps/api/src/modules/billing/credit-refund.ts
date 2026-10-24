import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuditFacts, OnAudit } from '../../lib/audit-writer';
import { AppError } from '../../utils/errors';
import { isDuplicateOn } from '../money/evidence';
import { lockMoverFeeAuthority, lockSubscriptionPayer } from '../subscription/mover-fee-authority';
import { z } from 'zod';
import { isSoleApprover } from '../admin/solo-approval';
import { normaliseReference } from '../money/evidence';
import { postLedger, refundPaidPostings, refundReleasePostings, refundSetAsidePostings } from './ledger';
import { feeReversalOpenInTx } from './dunning-clock';
import { feeReturnMayStillLandInTx, referenceOnRecord } from './mmg-fee-reversal';
import { formatGuyanaTime } from '../../utils/guyana-day';
import { recordSetAsideReleasedInTx, recordWalletDebitInTx } from './fee-receipt-allocation';

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-07] Unused prepaid weekly-fee credit is refunded, then
// the account can be deleted. Swift never moves the money: an admin pays it
// back outside Swift. The order is what keeps a real payout recordable:
//
//   1. SET ASIDE (two admins). The whole credit leaves the wallet into
//      REFUND_PAYABLE. Billing can no longer spend it and a later top-up is new
//      credit, so nothing that happens next can change what is owed back.
//      Nothing is paid before this step has happened.
//   2. PAY, outside Swift.
//   3. RECORD THE PAYOUT (two admins). The set-aside amount and the transfer
//      reference. One transfer reference records one refund across every
//      account (the event key is the reference alone, under a unique index),
//      and a reference that is an inbound payment is refused. The admin who
//      asked for the set-aside cannot be the one who approves its payout.
//   RELEASE (two admins) returns a set-aside that could not be paid.
//
// Each step is one transaction under the payer lock every wallet write takes
// first, posts a balanced ledger movement and writes the caller audit row.
// Open set-aside = RESERVED - PREPAID_REFUND - RELEASED (events), mirrored by
// the REFUND_PAYABLE subledger (the nightly invariant compares the two).
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;
export type RefundMethod = 'MMG' | 'BANK_TRANSFER';

const SET_ASIDE_KEY = 'credit-refund-reserve:';
const PAID_KEY = 'credit-refund-paid:';
const RELEASE_KEY = 'credit-refund-release:';
const REFUND_TYPES = ['PREPAID_REFUND_RESERVED', 'PREPAID_REFUND', 'PREPAID_REFUND_RELEASED'] as const;

const cents = (n: unknown) => Math.round(Number(n) * 100);
const fromCents = (c: number) => c / 100;

/** The amount set aside for a refund and not yet paid or released, per
 *  subscription (only subscriptions with an open set-aside appear). */
export async function openCreditRefunds(db: Db, subscriptionIds: string[]): Promise<Map<string, number>> {
  const open = new Map<string, number>();
  if (subscriptionIds.length === 0) return open;
  const rows = await db.billingEvent.groupBy({
    by: ['subscriptionId', 'type'],
    where: { subscriptionId: { in: subscriptionIds }, type: { in: [...REFUND_TYPES] } },
    _sum: { amount: true },
  });
  const byId = new Map<string, number>();
  for (const row of rows) {
    const sign = row.type === 'PREPAID_REFUND_RESERVED' ? 1 : -1;
    byId.set(row.subscriptionId, (byId.get(row.subscriptionId) ?? 0) + sign * cents(row._sum.amount ?? 0));
  }
  for (const [id, c] of byId) if (c > 0) open.set(id, fromCents(c));
  return open;
}

/** [Sol r2 S1] The id of each open set-aside (its PREPAID_REFUND_RESERVED
 *  event). A payout record or a release names it, so an approval can only ever
 *  act on the set-aside it was asked for. */
export async function openSetAsideIds(db: Db, subscriptionIds: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const open = await openCreditRefunds(db, subscriptionIds);
  if (open.size === 0) return ids;
  const opened = await db.billingEvent.findMany({
    where: { subscriptionId: { in: [...open.keys()] }, type: 'PREPAID_REFUND_RESERVED' },
    orderBy: { createdAt: 'asc' }, select: { id: true, subscriptionId: true },
  });
  for (const row of opened) ids.set(row.subscriptionId, row.id); // the newest one opened the open set-aside
  return ids;
}

/** What the console shows after any step: the LIVE wallet and the open set-aside. */
export interface CreditRefundState {
  balance: number;
  currencyCode: string;
  refundSetAside: number;
}

export async function creditRefundState(db: Db, subscriptionId: string): Promise<CreditRefundState> {
  const [wallet, open] = await Promise.all([
    db.prepaidBalance.findUnique({ where: { subscriptionId }, select: { balance: true, currencyCode: true } }),
    openCreditRefunds(db, [subscriptionId]),
  ]);
  return { balance: Number(wallet?.balance ?? 0), currencyCode: wallet?.currencyCode ?? 'GYD', refundSetAside: open.get(subscriptionId) ?? 0 };
}

/** Locks the payer (and a mover's fee authority) and answers every subscription that pays into the
 *  same fee credit: the one named, and a mover's sources. */
async function lockPayer(tx: Prisma.TransactionClient, subscriptionId: string): Promise<string[]> {
  const payer = await lockSubscriptionPayer(tx, subscriptionId);
  const mover = payer.kind === 'MOVER' ? await lockMoverFeeAuthority(tx, payer) : null;
  return [...new Set([subscriptionId, ...(mover?.sourceSubscriptionIds ?? [])])];
}

/** The open set-aside under the payer lock, with the event that opened it. */
async function openSetAside(tx: Prisma.TransactionClient, subscriptionId: string) {
  const amount = (await openCreditRefunds(tx, [subscriptionId])).get(subscriptionId) ?? 0;
  if (amount <= 0) return null;
  const opened = await tx.billingEvent.findFirst({
    where: { subscriptionId, type: 'PREPAID_REFUND_RESERVED' },
    orderBy: { createdAt: 'desc' },
  });
  if (!opened) throw new Error(`Open refund set-aside without its event for subscription ${subscriptionId}`);
  return { amount, currencyCode: opened.currencyCode, opened };
}

/** [Sol r2 S1] The route a payout record is asked on; its approval row is
 *  the durable "a payout was reported" marker for the set-aside it names. */
export const PAID_ACTION = 'POST /subscriptions/:id/refund-credit/paid';

/**
 * [DS1122 S1] One lock per partner's refund, held to the end of the
 * transaction. The approval gate writes a payout-record ask under it, and a
 * release takes it before looking for that ask: a release can never commit
 * around an ask it could not yet see. It ends with the transaction.
 */
export async function lockCreditRefundAsks(tx: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`credit-refund-ask:${subscriptionId}`}, 0))`;
}

/** What the console shows about the OPEN set-aside's payout records:
 *  ACTIVE = one is waiting for approval or to be applied (show "payment
 *  reported", offer no other step); NOT_COMPLETED = every one was refused,
 *  expired, withdrawn or failed (offer "record it again"; the release stays
 *  refused, Q-1527 keeps the hold). [DS1122 S3 · review S2-1] */
export type PayoutAskState = 'ACTIVE' | 'NOT_COMPLETED';
export async function payoutAskStateFor(db: Db, openIds: Map<string, string>, now: Date = new Date()): Promise<Map<string, PayoutAskState>> {
  const state = new Map<string, PayoutAskState>();
  if (openIds.size === 0) return state;
  const asks = await db.privilegedApproval.findMany({
    where: { action: PAID_ACTION, entityId: { in: [...openIds.keys()] } },
    select: { entityId: true, bodySnapshot: true, status: true, expiresAt: true },
  });
  for (const ask of asks) {
    const named = (ask.bodySnapshot as { body?: { setAsideId?: unknown } } | null)?.body?.setAsideId;
    if (!ask.entityId || named !== openIds.get(ask.entityId)) continue;
    const active = (ask.status === 'PENDING' || ask.status === 'APPROVED') && ask.expiresAt.getTime() > now.getTime();
    if (active) state.set(ask.entityId, 'ACTIVE');
    else if (!state.has(ask.entityId)) state.set(ask.entityId, 'NOT_COMPLETED');
  }
  return state;
}

/**
 * [Sol r2 S1] A payout record or a release acts only on the set-aside it was
 * asked for (`setAsideId`, part of what the second admin approved). An approval
 * for an earlier set-aside never touches a later one, even of the same amount.
 */
async function namedOpenSetAside(tx: Prisma.TransactionClient, subscriptionId: string, setAsideId: string, nothing: string, changed: string) {
  const open = await openSetAside(tx, subscriptionId);
  if (open && open.opened.id === setAsideId) return open;
  const named = await tx.billingEvent.findFirst({ where: { id: setAsideId, subscriptionId, type: 'PREPAID_REFUND_RESERVED' }, select: { id: true } });
  if (!open && !named) throw new AppError(409, 'NO_REFUND_SET_ASIDE', nothing);
  throw new AppError(409, 'REFUND_CYCLE_CHANGED', changed);
}

export interface CreditRefundStep extends CreditRefundState {
  replayed: boolean;
  /** This step's own amount: set aside, paid back, or released. */
  amount: number;
  billingEventId: string;
}

/**
 * Step 1: set the whole credit aside for a refund. `approvalId` is the second
 * admin's approval this request carries; it names the step, so applying it
 * again is a replay.
 */
export async function setAsideCreditRefund(prisma: PrismaClient, input: {
  adminId: string;
  approvalId: string;
  subscriptionId: string;
  amount: number;
  onAudit?: OnAudit;
}): Promise<CreditRefundStep> {
  if (!(input.amount > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'A refund must be positive.');
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Setting credit aside for a refund needs a second admin.');
  const eventKey = `${SET_ASIDE_KEY}${input.approvalId}`;
  const done = await prisma.$transaction(async (tx) => {
    const sources = await lockPayer(tx, input.subscriptionId);
    const prior = await tx.billingEvent.findUnique({ where: { idempotencyKey: eventKey } });
    if (prior) return { replayed: true, amount: Number(prior.amount), billingEventId: prior.id };
    // [#1527 review S2-2] While MMG is returning one of this payer's fee payments (asked, sent, or held for a
    // person), the credit may be about to go back through MMG: setting it aside too could pay the same money
    // back twice. Decided under the payer lock the return also takes, so neither can start beside the other.
    if (await feeReversalOpenInTx(tx, sources)) {
      throw new AppError(409, 'REFUND_REVERSAL_IN_FLIGHT', 'MMG is returning one of this partner\'s weekly-fee payments right now. Nothing was set aside: wait until that return is closed, then ask again for the credit that is left.');
    }
    // [#1527 review S3-1] A return closed "not returned" is watched for a week in case MMG finishes it late,
    // and one MMG returned after that close is unbooked until it is asked again: either may still take this
    // credit back through MMG, so it is not set aside beside them.
    const pending = await feeReturnMayStillLandInTx(tx, sources, new Date());
    if (pending) {
      throw new AppError(409, 'REFUND_REVERSAL_WATCHED', 'unbookedReturn' in pending
        ? 'MMG returned one of this partner\'s weekly-fee payments after it was closed as not returned, and that return is not booked yet. Nothing was set aside: book it first (ask for the return again on that payment), then ask again for the credit that is left.'
        : `MMG may still return one of this partner's weekly-fee payments (a return closed as not returned is watched for a week). Nothing was set aside: ask again after ${formatGuyanaTime(pending.watchedUntil, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })} (Guyana time), or once that return is settled.`);
    }
    if (await openSetAside(tx, input.subscriptionId)) {
      throw new AppError(409, 'REFUND_ALREADY_SET_ASIDE', 'A refund is already set aside for this account. Record its payout, or release it, first.');
    }
    const wallet = await tx.prepaidBalance.findUnique({ where: { subscriptionId: input.subscriptionId } });
    if (!wallet || cents(wallet.balance) <= 0) {
      throw new AppError(409, 'NO_FEE_CREDIT', 'There is no unused weekly-fee credit to refund. Nothing was set aside.');
    }
    if (cents(wallet.balance) !== cents(input.amount)) {
      throw new AppError(409, 'FEE_CREDIT_CHANGED', `The unused credit is now ${Number(wallet.balance)} ${wallet.currencyCode}. Nothing was set aside: ask again for exactly that amount.`);
    }
    const emptied = await tx.prepaidBalance.updateMany({
      where: { subscriptionId: input.subscriptionId, balance: wallet.balance, currencyCode: wallet.currencyCode },
      data: { balance: 0 },
    });
    if (emptied.count !== 1) throw new AppError(409, 'FEE_CREDIT_CHANGED', 'The credit changed while it was being set aside. Nothing was set aside: check it and ask again.');
    const amount = Number(wallet.balance);
    const event = await tx.billingEvent.create({ data: {
      subscriptionId: input.subscriptionId, type: 'PREPAID_REFUND_RESERVED', amount, currencyCode: wallet.currencyCode,
      idempotencyKey: eventKey,
      note: `Unused fee credit set aside for a refund (asked by ${input.adminId}). Not paid yet: pay it outside Swift, then record the payout.`,
    } });
    // [R12] The whole wallet is set aside: each receipt's unused money says so.
    await recordWalletDebitInTx(tx, { subscriptionId: input.subscriptionId, amount, balanceBefore: amount, kind: 'REFUND_SET_ASIDE', billingEventId: event.id });
    await postLedger(tx, {
      idempotencyKey: `ledger:${eventKey}`,
      description: 'Unused fee credit set aside for a refund',
      entries: refundSetAsidePostings(input.subscriptionId, amount),
    });
    await audit(tx, input, { step: 'SET_ASIDE', amount, currencyCode: wallet.currencyCode, billingEventId: event.id });
    return { replayed: false, amount, billingEventId: event.id };
  });
  return { ...done, ...(await creditRefundState(prisma, input.subscriptionId)) };
}

// A wallet is Decimal(12,2): any balance it can hold can be refunded whole.
export const REFUND_AMOUNT = z.number().positive().max(9_999_999_999.99)
  .refine((n) => new Prisma.Decimal(n).decimalPlaces() <= 2, 'At most two decimal places');
export const REFUND_SET_ASIDE_ID = z.string().min(1, 'Name the set-aside this step is for.').max(64);
/** The payout record's body: one schema for the approval gate's ask check and the route. */
export const PAID_REFUND_BODY = z.object({ amount: REFUND_AMOUNT, method: z.enum(['MMG', 'BANK_TRANSFER']), reference: z.string().max(200), setAsideId: REFUND_SET_ASIDE_ID });
export const refundReferenceOf = (raw: unknown) => normaliseReference(raw, {
  required: 'Enter the MMG or bank reference of the refund you paid. It is the only proof the money went back.',
  invalid: 'That does not look like a transfer reference. Copy it from the MMG or bank record.',
}, 'REFUND_REFERENCE');

const REFERENCE_REUSED = 'This transfer reference already recorded a refund. One transfer pays one refund: check the reference.';

/** A refund reference is money going OUT, through one transfer. One that Swift already has on record (a
 *  payment that came IN, or another refund or payout that went out) is a typing mistake, never proof of
 *  this payout [review S3-1: the shared census]. A replay of this same payout is answered before this. */
async function refuseInboundReference(tx: Prisma.TransactionClient, reference: string): Promise<void> {
  if (await referenceOnRecord(tx, reference)) {
    throw new AppError(409, 'REFUND_REFERENCE_IS_A_PAYMENT', 'Swift already has that reference on record: a payment Swift received, or another refund or payout that was sent. It is not this refund\'s transfer. Enter the reference of the refund transfer you sent.');
  }
}

const NOTHING_SET_ASIDE = 'No refund is set aside for this account. Set the credit aside first; pay only after that.';
const PAYOUT_CYCLE_CHANGED = 'The refund this payout record names is no longer the one set aside (it was paid or returned since). Nothing was recorded. If you already sent this payout, tell finance: it is settled by the refund procedure.';

/**
 * [Review S2-1] The payout record is checked when it is ASKED, before the
 * approval gate writes the request: an ask is the "payout reported" marker,
 * and one that could never be recorded (no reference, an inbound payment's
 * reference, another set-aside, another amount) must never become one. Runs
 * inside the gate's transaction, under the refund's ask lock. A re-send of a
 * payout already recorded for this account passes (the record answers it as
 * a replay).
 */
export async function validatePaidAsk(tx: Prisma.TransactionClient, subscriptionId: string, body: unknown): Promise<void> {
  const parsed = PAID_REFUND_BODY.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'The payout record is not complete.');
  }
  const reference = refundReferenceOf(parsed.data.reference);
  const prior = await tx.billingEvent.findUnique({ where: { idempotencyKey: `${PAID_KEY}${reference}` }, select: { subscriptionId: true, type: true, amount: true } });
  if (prior) {
    if (prior.subscriptionId !== subscriptionId || prior.type !== 'PREPAID_REFUND' || cents(prior.amount) !== cents(parsed.data.amount)) {
      throw new AppError(409, 'REFUND_REFERENCE_REUSED', REFERENCE_REUSED);
    }
    return;
  }
  await refuseInboundReference(tx, reference);
  const open = await namedOpenSetAside(tx, subscriptionId, parsed.data.setAsideId, NOTHING_SET_ASIDE, PAYOUT_CYCLE_CHANGED);
  if (cents(open.amount) !== cents(parsed.data.amount)) {
    throw new AppError(409, 'REFUND_AMOUNT_MISMATCH', `The amount set aside is ${open.amount} ${open.currencyCode}. Record exactly that amount.`);
  }
}

/**
 * Step 3: the set-aside was paid back outside Swift. The amount must be the
 * open set-aside; the reference is the transfer that paid it.
 */
export async function recordCreditRefundPaid(prisma: PrismaClient, input: {
  adminId: string;
  approvalId: string;
  subscriptionId: string;
  amount: number;
  method: RefundMethod;
  /** Already normalised (trimmed, upper-cased) by the caller. */
  reference: string;
  /** The set-aside this payout pays (its PREPAID_REFUND_RESERVED event id). */
  setAsideId: string;
  onAudit?: OnAudit;
}): Promise<CreditRefundStep> {
  if (!(input.amount > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'A refund must be positive.');
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Recording a refund payout needs a second admin.');
  const reference = input.reference.trim().toUpperCase();
  const eventKey = `${PAID_KEY}${reference}`;
  let done: { replayed: boolean; amount: number; billingEventId: string };
  try {
    done = await prisma.$transaction(async (tx) => {
      await lockPayer(tx, input.subscriptionId);
      const prior = await tx.billingEvent.findUnique({ where: { idempotencyKey: eventKey } });
      if (prior) {
        if (prior.subscriptionId !== input.subscriptionId || prior.type !== 'PREPAID_REFUND' || cents(prior.amount) !== cents(input.amount)) {
          throw new AppError(409, 'REFUND_REFERENCE_REUSED', REFERENCE_REUSED);
        }
        return { replayed: true, amount: Number(prior.amount), billingEventId: prior.id };
      }
      // A refund reference is money going OUT. One that names money that came
      // IN (a fee payment or a top-up) is a typing mistake, never proof of a payout.
      await refuseInboundReference(tx, reference);
      const open = await namedOpenSetAside(tx, input.subscriptionId, input.setAsideId, NOTHING_SET_ASIDE, PAYOUT_CYCLE_CHANGED);
      if (cents(open.amount) !== cents(input.amount)) {
        throw new AppError(409, 'REFUND_AMOUNT_MISMATCH', `The amount set aside is ${open.amount} ${open.currencyCode}. Record exactly that amount.`);
      }
      // [Coordinator 2026-10-07] The two-person rule holds across the pair: the
      // admin who asked for the set-aside does not approve its payout record.
      const setAsideApprovalId = open.opened.idempotencyKey.startsWith(SET_ASIDE_KEY) ? open.opened.idempotencyKey.slice(SET_ASIDE_KEY.length) : null;
      const [asked, approving] = await Promise.all([
        setAsideApprovalId ? tx.privilegedApproval.findUnique({ where: { id: setAsideApprovalId }, select: { requestedBy: true } }) : null,
        tx.privilegedApproval.findUnique({ where: { id: input.approvalId }, select: { approvedBy: true, requestedBy: true, decidedSolo: true } }),
      ]);
      if (!asked || !approving?.approvedBy) {
        throw new AppError(409, 'REFUND_APPROVAL_UNKNOWN', 'The approvals behind this refund cannot be read. Nothing was recorded.');
      }
      // [Owner ruling 14 Oct, S1-1] While the owner is the ONLY admin, the owner may approve both
      // steps under the solo ceremony [OWNER #13]: the gate counted "still the only admin" again
      // when this approval was applied, and it is counted once more here. Once a second admin
      // exists, solo decisions are void at the gate and the pair rule below holds again.
      const soloOwner = approving.decidedSolo === true && approving.approvedBy === approving.requestedBy
        && await isSoleApprover(tx, approving.approvedBy, 'subscription.refund');
      if (approving.approvedBy === asked.requestedBy && !soloOwner) {
        throw new AppError(403, 'REFUND_SAME_PERSON', 'You asked for this refund to be set aside, so you cannot also approve its payout. Another admin must approve it.');
      }
      const event = await tx.billingEvent.create({ data: {
        subscriptionId: input.subscriptionId, type: 'PREPAID_REFUND', amount: open.amount, currencyCode: open.currencyCode,
        paymentRef: reference, idempotencyKey: eventKey,
        note: `Set-aside fee credit paid back outside Swift by ${input.method} (recorded by ${input.adminId})`,
      } });
      await postLedger(tx, {
        idempotencyKey: `ledger:${eventKey}`,
        description: `Fee credit refund paid via ${input.method} (${reference})`,
        entries: refundPaidPostings(input.subscriptionId, open.amount, input.method),
      });
      await audit(tx, input, { step: 'PAID', amount: open.amount, currencyCode: open.currencyCode, method: input.method, reference, billingEventId: event.id });
      return { replayed: false, amount: open.amount, billingEventId: event.id };
    });
  } catch (error) {
    // Two payouts racing on one reference for different accounts: the unique
    // event key lets exactly one commit, and the other is told why.
    if (isDuplicateOn(error, 'idempotencyKey')) {
      throw new AppError(409, 'REFUND_REFERENCE_REUSED', REFERENCE_REUSED);
    }
    throw error;
  }
  return { ...done, ...(await creditRefundState(prisma, input.subscriptionId)) };
}

/** A set-aside that could not be paid goes back to the wallet. */
export async function releaseCreditRefund(prisma: PrismaClient, input: {
  adminId: string;
  approvalId: string;
  subscriptionId: string;
  amount: number;
  /** The set-aside this release returns (its PREPAID_REFUND_RESERVED event id). */
  setAsideId: string;
  onAudit?: OnAudit;
}): Promise<CreditRefundStep> {
  if (!(input.amount > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'A release must be positive.');
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Releasing a refund set-aside needs a second admin.');
  const eventKey = `${RELEASE_KEY}${input.approvalId}`;
  const done = await prisma.$transaction(async (tx) => {
    await lockPayer(tx, input.subscriptionId);
    const prior = await tx.billingEvent.findUnique({ where: { idempotencyKey: eventKey } });
    if (prior) return { replayed: true, amount: Number(prior.amount), billingEventId: prior.id };
    // [DS1122 S1] Before looking for a payout-record ask: one being written now finishes first.
    await lockCreditRefundAsks(tx, input.subscriptionId);
    const open = await namedOpenSetAside(tx, input.subscriptionId, input.setAsideId,
      'No refund is set aside for this account. Nothing was released.',
      'The refund this release names is no longer the one set aside (it was paid or returned since). Nothing was released: ask again for the refund that is set aside now.');
    // [Sol r2 S1 · keep the hold] Once a payout record has been asked for this
    // set-aside (its approval row is written before that request is answered),
    // the payout may have been sent: the set-aside is never returned to the
    // partner's fee money, even if that record is later refused or expires.
    // The payout is recorded, or finance settles it by the refund procedure.
    const reported = await tx.privilegedApproval.findFirst({
      where: { action: PAID_ACTION, entityId: input.subscriptionId, bodySnapshot: { path: ['body', 'setAsideId'], equals: open.opened.id } },
      select: { id: true },
    });
    if (reported) {
      throw new AppError(409, 'REFUND_PAYOUT_REPORTED', `A payout was reported for this refund (approval ${reported.id}), so it cannot go back to the partner's fee money. Record the payout, or have finance settle it by the refund procedure. Nothing was released.`);
    }
    if (cents(open.amount) !== cents(input.amount)) {
      throw new AppError(409, 'REFUND_AMOUNT_MISMATCH', `The amount set aside is ${open.amount} ${open.currencyCode}. Release exactly that amount.`);
    }
    await tx.prepaidBalance.upsert({
      where: { subscriptionId: input.subscriptionId },
      update: { balance: { increment: 0 } },
      create: { subscriptionId: input.subscriptionId, balance: 0, currencyCode: open.currencyCode },
    });
    const returned = await tx.prepaidBalance.updateMany({
      where: { subscriptionId: input.subscriptionId, currencyCode: open.currencyCode },
      data: { balance: { increment: open.amount } },
    });
    if (returned.count !== 1) throw new AppError(409, 'WALLET_CURRENCY_CONFLICT', 'The partner\'s weekly-fee money is now in another currency. Nothing was released: this needs finance review.');
    const event = await tx.billingEvent.create({ data: {
      subscriptionId: input.subscriptionId, type: 'PREPAID_REFUND_RELEASED', amount: open.amount, currencyCode: open.currencyCode,
      idempotencyKey: eventKey,
      note: `Refund set-aside returned to the fee credit unpaid (asked by ${input.adminId})`,
    } });
    // [R12] The receipts the set-aside came from get that money back.
    await recordSetAsideReleasedInTx(tx, { subscriptionId: input.subscriptionId, setAsideEventId: open.opened.id, amount: Number(open.amount), billingEventId: event.id });
    await postLedger(tx, {
      idempotencyKey: `ledger:${eventKey}`,
      description: 'Refund set-aside returned to the fee credit unpaid',
      entries: refundReleasePostings(input.subscriptionId, open.amount),
    });
    await audit(tx, input, { step: 'RELEASED', amount: open.amount, currencyCode: open.currencyCode, billingEventId: event.id });
    return { replayed: false, amount: open.amount, billingEventId: event.id };
  });
  return { ...done, ...(await creditRefundState(prisma, input.subscriptionId)) };
}

async function audit(tx: Prisma.TransactionClient, input: { adminId: string; subscriptionId: string; onAudit?: OnAudit }, facts: AuditFacts) {
  if (input.onAudit) {
    await input.onAudit(tx, facts);
    return;
  }
  await tx.auditLog.create({
    data: { userId: input.adminId, action: `PREPAID_REFUND_${String(facts['step'])}`, entity: 'Subscription', entityId: input.subscriptionId, changes: facts as Prisma.InputJsonValue },
  });
}
