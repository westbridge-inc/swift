import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuditFacts, OnAudit } from '../../lib/audit-writer';
import { AppError } from '../../utils/errors';
import { isDuplicateOn } from '../money/evidence';
import { lockMoverFeeAuthority, lockSubscriptionPayer } from '../subscription/mover-fee-authority';
import { postLedger, refundPaidPostings, refundReleasePostings, refundSetAsidePostings } from './ledger';

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

async function lockPayer(tx: Prisma.TransactionClient, subscriptionId: string) {
  const payer = await lockSubscriptionPayer(tx, subscriptionId);
  if (payer.kind === 'MOVER') await lockMoverFeeAuthority(tx, payer);
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
    await lockPayer(tx, input.subscriptionId);
    const prior = await tx.billingEvent.findUnique({ where: { idempotencyKey: eventKey } });
    if (prior) return { replayed: true, amount: Number(prior.amount), billingEventId: prior.id };
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
          throw new AppError(409, 'REFUND_REFERENCE_REUSED', 'This transfer reference already recorded a refund. One transfer pays one refund: check the reference.');
        }
        return { replayed: true, amount: Number(prior.amount), billingEventId: prior.id };
      }
      // A refund reference is money going OUT. One that names money that came
      // IN (a fee payment or a top-up) is a typing mistake, never proof of a payout.
      const [inbound] = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT (
          (SELECT count(*) FROM provider_payments p WHERE mmg_txn_canon(p."providerTxnId") = mmg_txn_canon(${reference}))
          + (SELECT count(*) FROM provider_payment_aliases a WHERE mmg_txn_canon(a."aliasKey") = mmg_txn_canon(${reference}))
          + (SELECT count(*) FROM topup_commands t WHERE upper(t."providerRef") = ${reference})
          + (SELECT count(*) FROM subscription_payments s WHERE upper(s."externalRef") = ${reference})
        )::int AS n`;
      if ((inbound?.n ?? 0) > 0) {
        throw new AppError(409, 'REFUND_REFERENCE_IS_A_PAYMENT', 'That reference is a payment Swift received, not the refund you sent. Enter the reference of the refund transfer.');
      }
      const open = await openSetAside(tx, input.subscriptionId);
      if (!open) throw new AppError(409, 'NO_REFUND_SET_ASIDE', 'No refund is set aside for this account. Set the credit aside first; pay only after that.');
      if (cents(open.amount) !== cents(input.amount)) {
        throw new AppError(409, 'REFUND_AMOUNT_MISMATCH', `The amount set aside is ${open.amount} ${open.currencyCode}. Record exactly that amount.`);
      }
      // [Coordinator 2026-10-07] The two-person rule holds across the pair: the
      // admin who asked for the set-aside does not approve its payout record.
      const setAsideApprovalId = open.opened.idempotencyKey.startsWith(SET_ASIDE_KEY) ? open.opened.idempotencyKey.slice(SET_ASIDE_KEY.length) : null;
      const [asked, approving] = await Promise.all([
        setAsideApprovalId ? tx.privilegedApproval.findUnique({ where: { id: setAsideApprovalId }, select: { requestedBy: true } }) : null,
        tx.privilegedApproval.findUnique({ where: { id: input.approvalId }, select: { approvedBy: true } }),
      ]);
      if (!asked || !approving?.approvedBy) {
        throw new AppError(409, 'REFUND_APPROVAL_UNKNOWN', 'The approvals behind this refund cannot be read. Nothing was recorded.');
      }
      if (approving.approvedBy === asked.requestedBy) {
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
      throw new AppError(409, 'REFUND_REFERENCE_REUSED', 'This transfer reference already recorded a refund. One transfer pays one refund: check the reference.');
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
  onAudit?: OnAudit;
}): Promise<CreditRefundStep> {
  if (!(input.amount > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'A release must be positive.');
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Releasing a refund set-aside needs a second admin.');
  const eventKey = `${RELEASE_KEY}${input.approvalId}`;
  const done = await prisma.$transaction(async (tx) => {
    await lockPayer(tx, input.subscriptionId);
    const prior = await tx.billingEvent.findUnique({ where: { idempotencyKey: eventKey } });
    if (prior) return { replayed: true, amount: Number(prior.amount), billingEventId: prior.id };
    const open = await openSetAside(tx, input.subscriptionId);
    if (!open) throw new AppError(409, 'NO_REFUND_SET_ASIDE', 'No refund is set aside for this account. Nothing was released.');
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
    if (returned.count !== 1) throw new AppError(409, 'WALLET_CURRENCY_CONFLICT', 'The wallet now holds another currency. Nothing was released: this needs finance review.');
    const event = await tx.billingEvent.create({ data: {
      subscriptionId: input.subscriptionId, type: 'PREPAID_REFUND_RELEASED', amount: open.amount, currencyCode: open.currencyCode,
      idempotencyKey: eventKey,
      note: `Refund set-aside returned to the wallet unpaid (asked by ${input.adminId})`,
    } });
    await postLedger(tx, {
      idempotencyKey: `ledger:${eventKey}`,
      description: 'Refund set-aside returned to the wallet unpaid',
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
