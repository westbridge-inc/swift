import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditFacts, OnAudit } from '../../lib/audit-writer';
import { z } from '../../lib/zod';
import { log } from '../../utils/logger';
import { formatMoney } from '../../utils/currency-amount';
import { getTenantId } from '../../plugins/tenant-context';
import { AppError, NotFoundError } from '../../utils/errors';
import { zMoneyWhole } from '../../utils/money-schema';
import { isDuplicateOn, normaliseReference } from '../money/evidence';
import { subscriptionTenantWhere } from '../subscription/subscription-owner';
import type { BillingService } from './billing.service';
import { PAYABLE } from './fee-pay-actions';
import { feeReceiptDocument } from './fee-receipt';
import { lockFeePaymentDecision, readFeePaymentDecision, type FeePaymentDecision } from './fee-payment-authority';
import { inPersonChannel, inPersonRail, IN_PERSON_CHANNELS, inPersonMethodOf } from './in-person-channel';
import { amountDueNow } from './amount-due';
import { feePauseHoldsBilling } from './mmg-pause';
import { referenceOnRecord } from './mmg-fee-reversal';
import { payAheadRefusal, readPayAhead, type PayAheadPosition } from './pay-ahead';
import { weeklyFeeAmount } from './subscription-fee';

// ---------------------------------------------------------------------------
// [OWNER 5 Nov 2026] ANYONE (a business, a rider, a driver) MAY PAY THE WEEKLY
// FEE IN PERSON, directly to the company, by cash, cheque or bank transfer.
// Recorded here by a person. MMG checkout stays. Never through an agent or a
// Swift Number.
//
// This is a door of its own, not the admin top-up with its hold lifted:
// BILLING_TOPUP_HOLD=1 still refuses the top-up and keeps agent cash off, and
// production still refuses to start without it. The law of this door:
//
//   1. SUPER_ADMIN asks, and the money gate decides: C4, so a reason and a
//      second person (or the owner's solo wait while they are the only admin).
//      Nothing here shortens either.
//   2. It is checked when it is ASKED as well as when it is applied. An ask
//      that could never be recorded is refused now, not after the wait.
//   3. The screen's promises are part of the request: a cheque counts only
//      once it has cleared, a transfer only once it is seen in the company's
//      bank, and cash only with a slip number and a statement of how Swift's
//      own receipt reaches the partner (it is issued when the record executes).
//   4. One reference credits once: the event key and topup_commands.providerRef
//      are unique, and a reference Swift already has on record for any other
//      money is refused (referenceOnRecord).
//   5. The partner's rules are the MMG door's: PAYABLE, the one-week limit, the
//      collection authority (a mover's one fee), no payment beside one being
//      confirmed, no money taken while the fee is paused, and at least what is due
//      when a week is due (a part payment would bill, fail and send a failure
//      notice to someone who just paid). inPersonDoor is the one answer every
//      screen reads before anyone takes money. This door is NOT a
//      "live way to pay" (fee-pause.ts): a partner still owes nothing while
//      Swift's own ways to pay are down.
//   6. One command, on the one wallet-credit funnel: the credit, its receipt, a
//      ledger posting that never touches MMG's account, the audit row and the
//      command commit together. The notice and the re-bill are the top-up's tail,
//      owed and retried the same way.
//
// A refund is the credit refund (credit-refund.ts): only money not yet used on a
// week that has started, set aside, really paid back outside Swift, recorded.
// There is no correction of a mistaken record: it goes to the owner
// (PAY-AHEAD-AND-REFUNDS.md section 6), never a made-up payout.
// ---------------------------------------------------------------------------

/** The route, as the approval gate names it. */
export const IN_PERSON_ACTION = 'POST /subscriptions/:id/in-person-payment';
const EVENT_KEY = 'in-person:';
const PROVIDER_REF = 'IN_PERSON:';
const LIST_LIMIT = 100;
const TOTALS_DAYS = 30;

const paid = {
  amount: zMoneyWhole.refine((n) => n > 0, 'A fee paid in person must be more than zero, in whole Guyana dollars.'),
  reference: z.string().max(200),
  /** Stated in the header by the console; never part of the record's body. */
  reason: z.string().optional(),
};

/** What the person recording it states. The approval gate fingerprints exactly this. */
export const IN_PERSON_BODY = z.discriminatedUnion('method', [
  z.object({ ...paid, method: z.literal('CASH'), receipt: z.enum(['PRINTED', 'SENT'], 'Cash needs a receipt: say whether Swift\'s receipt will be printed for the partner or reach them on their fee page.') }).strict(),
  z.object({ ...paid, method: z.literal('CHEQUE'), cleared: z.literal(true, 'A cheque counts only once it has cleared. Record it when the money is in the bank.') }).strict(),
  z.object({ ...paid, method: z.literal('BANK_TRANSFER'), seenInBank: z.literal(true, 'Record a transfer only once you can see the money in the company bank account.') }).strict(),
], 'Choose how the money was paid: cash, cheque or bank transfer.');
export type InPersonBody = z.infer<typeof IN_PERSON_BODY>;

export function parseInPersonBody(raw: unknown): InPersonBody {
  const parsed = IN_PERSON_BODY.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new AppError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'The payment record is not complete.');
}

/** The standard check digit of a card number. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    const n = Number(d) * (i % 2 === 1 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}

const WHAT_A_REFERENCE_IS = 'Use the slip number, cheque number or bank reference.';

/**
 * [GUARDRAILS 1, 2] A reference is copied to the partner's receipt, the audit row, the ledger and the cash journal, and
 * none of those can be erased: a card number or a phone number must never get in. Letters mean it is not one (a bank's
 * own reference that happens to pass the check digit takes its prefix). A name cannot be told from a reference; the
 * screen says not to type one.
 */
export function inPersonReferenceOf(raw: unknown): string {
  const reference = normaliseReference(raw, {
    required: 'Enter the slip number, cheque number or bank reference. It is the only proof of this payment.',
    invalid: 'That does not look like a reference: 4 to 64 letters or numbers, with dots, dashes or slashes between them. A short number takes a prefix, such as RCPT-42.',
  }, 'IN_PERSON_REFERENCE');
  if (!/[A-Z]/.test(reference)) {
    const digits = reference.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      throw new AppError(400, 'IN_PERSON_REFERENCE_CARD', `That looks like a card number. Swift never records one. ${WHAT_A_REFERENCE_IS}`);
    }
    if (/^592\d{7}$/.test(digits)) {
      throw new AppError(400, 'IN_PERSON_REFERENCE_PHONE', `That looks like a phone number. ${WHAT_A_REFERENCE_IS}`);
    }
  }
  return reference;
}

const ALREADY_RECORDED = 'That reference is already on record. One reference credits once, so nothing was recorded. Check it, or check the billing trail of the account it belongs to.';
const HAND_BACK = 'If you already took it, hand it back.';

function decisionRefusal(reason: Exclude<FeePaymentDecision['reason'], null>): AppError {
  return new AppError(409, reason, reason === 'PAYMENT_CONFIRMING'
    ? `Another weekly-fee payment on this account is being confirmed. Nothing was recorded: do not take this money until that one is settled. ${HAND_BACK}`
    : `This account's billing needs a person to check it first, or this person's fee is paid on another of their subscriptions. Nothing was recorded: do not take this money yet. ${HAND_BACK}`);
}

type DoorDb = Pick<Prisma.TransactionClient, 'subscription' | 'prepaidBalance' | 'subscriptionPayment' | 'platformConfig' | 'billingDunningClock'>;

/** Is this account one that can pay in person now? Refuses in the operator's words, and answers what can be recorded. */
async function assertDoorOpen(db: DoorDb, subscriptionId: string, now: Date): Promise<{ position: PayAheadPosition; dueGyd: number }> {
  const sub = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { id: true, status: true, feeWaived: true, currencyCode: true, weeklyRate: true, customRate: true, nextBillingDate: true },
  });
  if (sub.currencyCode !== 'GYD') {
    throw new AppError(409, 'IN_PERSON_GYD_ONLY', `A fee paid in person is recorded in Guyana dollars, and this account is not billed in them. Nothing was recorded. ${HAND_BACK}`);
  }
  if (!PAYABLE.has(sub.status) || sub.feeWaived || !(weeklyFeeAmount(sub) > 0)) {
    throw new AppError(409, 'FEE_NOT_PAYABLE', `This account has no weekly fee to pay: it is stopped or closed, or its fee is waived. Nothing was recorded: do not take this money. ${HAND_BACK}`);
  }
  if (await feePauseHoldsBilling(db as Parameters<typeof feePauseHoldsBilling>[0], subscriptionId)) {
    throw new AppError(409, 'FEE_PAUSED', `The weekly fee is paused, so nothing is owed right now. Nothing was recorded: do not take this money. ${HAND_BACK}`);
  }
  const position = await readPayAhead(db, subscriptionId, now);
  if (!position) throw new NotFoundError('Subscription', subscriptionId);
  // Whole dollars, rounded up, as the MMG door asks; the part of a dollar above the due stays for the next fee.
  const dueGyd = position.due ? Math.ceil(await amountDueNow(db, sub)) : 0;
  return { position, dueGyd };
}

/** Everything but the locks: read when it is asked, and read again under the payer lock when it is applied. */
async function assertRecordable(tx: Prisma.TransactionClient, subscriptionId: string, amount: number, reference: string, now: Date): Promise<void> {
  const { position, dueGyd } = await assertDoorOpen(tx, subscriptionId, now);
  if (amount > position.room) throw payAheadRefusal(position, 'admin');
  // M15 S4-2: part of what is due would bill, fail and tell someone who just paid that their payment failed.
  if (amount < dueGyd) {
    throw new AppError(409, 'IN_PERSON_LESS_THAN_DUE', `${formatMoney(dueGyd, 'GYD', { whole: true })} is due on this account, and this door takes at least that. Nothing was recorded. ${HAND_BACK}`);
  }
  if (await referenceOnRecord(tx, reference)) throw new AppError(409, 'IN_PERSON_REFERENCE_USED', `${ALREADY_RECORDED} ${HAND_BACK}`);
}

export interface InPersonDoor {
  open: boolean;
  /** Why not, in the operator's words; null when open. */
  refused: string | null;
  /** The most that can be recorded now, and the least while a week is due. */
  mostGyd: number;
  leastGyd: number;
}

/** THE answer to "can this account pay in person right now?", read before anyone takes money. Changes nothing. */
export async function inPersonDoor(prisma: PrismaClient, subscriptionId: string, now: Date = new Date()): Promise<InPersonDoor> {
  const closed = (refused: string): InPersonDoor => ({ open: false, refused, mostGyd: 0, leastGyd: 0 });
  try {
    const { position, dueGyd } = await assertDoorOpen(prisma, subscriptionId, now);
    if (!(position.room > 0)) return closed(payAheadRefusal(position, 'admin').message);
    const decision = await readFeePaymentDecision(prisma, subscriptionId);
    if (!decision.allowed) return closed(decisionRefusal(decision.reason).message);
    return { open: true, refused: null, mostGyd: Math.floor(position.room), leastGyd: Math.min(dueGyd, Math.floor(position.room)) };
  } catch (error) {
    if (error instanceof AppError) return closed(error.message);
    throw error;
  }
}

/** What the partner's fee page reads. `open` only where the door accepts; `waitingGyd` while a person's record stands. */
export interface InPersonFeeView { open: boolean; waitingGyd: number | null }
const CLOSED_VIEW: InPersonFeeView = { open: false, waitingGyd: null };

/** Never stops the fee page: a failed read offers nothing and says nothing. */
export async function inPersonFeeView(prisma: PrismaClient, subscriptionId: string, now: Date = new Date()): Promise<InPersonFeeView> {
  try {
    const ask = await prisma.privilegedApproval.findFirst({
      where: { action: IN_PERSON_ACTION, entityId: subscriptionId, status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' }, select: { bodySnapshot: true },
    });
    if (ask) {
      const amount = (ask.bodySnapshot as { body?: { amount?: unknown } } | null)?.body?.amount;
      return { open: false, waitingGyd: typeof amount === 'number' ? amount : null };
    }
    return { open: (await inPersonDoor(prisma, subscriptionId, now)).open, waitingGyd: null };
  } catch (err) {
    log().error({ err, subscriptionId }, '[in-person fee] the fee page could not read the door; nothing is offered');
    return CLOSED_VIEW;
  }
}

/**
 * The MMG door's own decision, then this door's rules, under the payer lock. A
 * blocked decision is RETURNED: what it found commits (fee-payment-authority.ts).
 */
async function lockedRefusal(tx: Prisma.TransactionClient, subscriptionId: string, amount: number, reference: string, now: Date) {
  const account = await tx.subscription.findFirst({ where: { id: subscriptionId, ...subscriptionTenantWhere(getTenantId() ?? '') }, select: { id: true } });
  if (!account) throw new NotFoundError('Subscription', subscriptionId);
  const decision = await lockFeePaymentDecision(tx, subscriptionId, now);
  if (!decision.allowed) return { refused: decision.reason };
  await assertRecordable(tx, subscriptionId, amount, reference, now);
  return null;
}

/**
 * [Law 2] The gate calls this before it writes an ask, so a person never waits
 * for a request that could only fail. It credits nothing; the same checks run
 * again when the approved request runs.
 */
export async function validateInPersonAsk(prisma: PrismaClient, subscriptionId: string, rawBody: unknown): Promise<void> {
  // The route's own tenant rule, here so another market's ask never waits for a refusal.
  if (getTenantId() !== 'swift-default') throw new AppError(503, 'TENANT_BILLING_UNAVAILABLE', 'Admin billing mutations are unavailable for this tenant until receipt counters are tenant-aware.');
  const body = parseInPersonBody(rawBody);
  const reference = inPersonReferenceOf(body.reference);
  const blocked = await prisma.$transaction((tx) => lockedRefusal(tx, subscriptionId, body.amount, reference, new Date()));
  if (blocked) throw decisionRefusal(blocked.refused);
}

/** The facts the record keeps beside the money: what was promised on the screen. */
function statedOnScreen(body: InPersonBody): AuditFacts {
  if (body.method === 'CASH') return { receipt: body.receipt };
  return body.method === 'CHEQUE' ? { cleared: body.cleared } : { seenInBank: body.seenInBank };
}

export interface InPersonPaymentResult {
  balance: number;
  currencyCode: string;
  billingEventId: string;
  receiptNumber: string;
}

/** The approved request: one command, under the payer lock. */
export async function recordInPersonPayment(prisma: PrismaClient, billing: BillingService, input: {
  adminId: string;
  approvalId: string;
  subscriptionId: string;
  body: InPersonBody;
  /** Already normalised by inPersonReferenceOf. */
  reference: string;
  onAudit: OnAudit;
}): Promise<InPersonPaymentResult> {
  const { body, reference, subscriptionId } = input;
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Recording a fee paid in person needs a second admin.');
  const eventKey = `${EVENT_KEY}${reference}`;
  const now = new Date();
  let done;
  try {
    done = await prisma.$transaction(async (tx) => {
      const blocked = await lockedRefusal(tx, subscriptionId, body.amount, reference, now);
      if (blocked) return blocked;
      const balance = await billing.recordTopUpInTransaction(tx, {
        subscriptionId, amount: body.amount, recordedBy: input.adminId, reference, eventKey,
        channel: inPersonChannel(body.method), rail: inPersonRail(body.method), payAheadLimit: 'refuse',
      });
      const event = await tx.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: eventKey }, select: { id: true } });
      const receipt = await tx.feeReceipt.findUniqueOrThrow({ where: { billingEventId: event.id }, select: { receiptNumber: true } });
      await input.onAudit(tx, {
        method: body.method, amount: body.amount, reference, approvalId: input.approvalId,
        billingEventId: event.id, receiptNumber: receipt.receiptNumber, ...statedOnScreen(body),
      });
      const result: InPersonPaymentResult = { balance: Number(balance.balance), currencyCode: balance.currencyCode, billingEventId: event.id, receiptNumber: receipt.receiptNumber };
      // The top-up's own command row: a unique reference, and the owed notice and re-bill the billing poll drains.
      const command = await tx.topUpCommand.create({
        data: {
          adminId: input.adminId, idempotencyKey: `${EVENT_KEY}${input.approvalId}`,
          requestHash: createHash('sha256').update(JSON.stringify({ subscriptionId, method: body.method, amount: body.amount, reference })).digest('hex'),
          subscriptionId, amount: body.amount, reference, providerRef: `${PROVIDER_REF}${reference}`,
          billingEventId: event.id, result: result as never,
        },
        select: { id: true },
      });
      return { commandId: command.id, result };
    });
  } catch (error) {
    // The unique keys are the last word when two requests race on one reference.
    if (isDuplicateOn(error, 'idempotencyKey') || isDuplicateOn(error, 'providerRef')) {
      throw new AppError(409, 'IN_PERSON_REFERENCE_USED', `${ALREADY_RECORDED} ${HAND_BACK}`);
    }
    throw error;
  }
  if ('refused' in done) throw decisionRefusal(done.refused);
  await billing.runTopUpTail(done.commandId);
  return done.result;
}

/** One receipt from Finance's list: only a fee paid in person. */
export async function inPersonReceipt(prisma: PrismaClient, tenantId: string, receiptNumber: string) {
  const known = await prisma.feeReceipt.findFirst({ where: { tenantId, receiptNumber, channel: { in: [...IN_PERSON_CHANNELS] } }, select: { id: true } });
  return known ? feeReceiptDocument(prisma, receiptNumber, { tenantId, subscriptionWhere: subscriptionTenantWhere(tenantId) }) : null;
}

/** Finance's view: fees paid in person, apart from MMG, with cash taken less cash paid back. Names no person. */
export async function listInPersonPayments(prisma: PrismaClient, tenantId: string, now: Date = new Date()) {
  const inPerson = { tenantId, channel: { in: [...IN_PERSON_CHANNELS] } };
  const [rows, recent, cash] = await Promise.all([
    prisma.feeReceipt.findMany({
      where: inPerson, orderBy: { issuedAt: 'desc' }, take: LIST_LIMIT,
      select: { receiptNumber: true, subscriptionId: true, amount: true, channel: true, mmgRef: true, issuedAt: true },
    }),
    prisma.feeReceipt.groupBy({
      by: ['channel'], where: { ...inPerson, issuedAt: { gte: new Date(now.getTime() - TOTALS_DAYS * 86_400_000) } },
      _count: { _all: true }, _sum: { amount: true },
    }),
    prisma.ledgerEntry.aggregate({ where: { accountCode: 'CASH_ON_HAND' }, _sum: { debit: true, credit: true } }),
  ]);
  const accounts = await prisma.subscription.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subscriptionId))] } }, select: { id: true, san: true, type: true } });
  const account = new Map(accounts.map((a) => [a.id, a]));
  return {
    windowDays: TOTALS_DAYS,
    totals: recent.map((r) => ({ method: inPersonMethodOf(r.channel), count: r._count._all, totalGyd: Number(r._sum.amount ?? 0) })),
    cashOnHandGyd: Number(cash._sum.debit ?? 0) - Number(cash._sum.credit ?? 0),
    rows: rows.map((r) => ({
      receiptNumber: r.receiptNumber, method: inPersonMethodOf(r.channel), amount: Number(r.amount), reference: r.mmgRef, issuedAt: r.issuedAt,
      san: account.get(r.subscriptionId)?.san ?? null, type: account.get(r.subscriptionId)?.type ?? null,
    })),
  };
}
