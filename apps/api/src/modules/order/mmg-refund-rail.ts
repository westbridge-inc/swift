import { Prisma, type MmgRefundStatus, type PrismaClient } from '@prisma/client';
import { insertTicketFor } from '../../lib/owner-wall-tickets';
import { bindTenantTransaction } from '../../plugins/prisma';
import { AppError } from '../../utils/errors';
import { formatGuyanaTime } from '../../utils/guyana-day';
import { requireIdentityAuthority } from '../integrity/identity-review';
import { assertClearOfParties } from '../integrity/party-authority';
import { normaliseReference } from '../money/evidence';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import {
  decideMmgRefundObligation, MMG_REFUND_OPEN_STATUSES, mmgRefundOwed, mmgRefundPolicy, mmgRefundRemainder, openMmgRefundObligation, sendMatchesOwed, type MmgRefundCommand,
} from './mmg-refund-law';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G08 · COORD 4 Nov 2026] THE MMG REFUND RAIL, MADE REAL.
//
// A paid MMG order that cannot be fulfilled was closed with an OWED row nothing else ever read: the store could not say it
// had paid, the customer could not say it arrived, nobody watched the deadline. The Store Terms s6 say the app records
// these obligations. Now it does, by the law in mmg-refund-law.ts:
//   - the store says "Refund sent", with the MMG reference and the exact amount;
//   - the customer says it arrived, or it did not, and "did not" opens a support case;
//   - support finds it received or not received, and may void the record (two people);
//   - a sweep marks a missed deadline and tells the store and support.
// RECORD ONLY (GUARDRAILS s1): Swift holds no money and moves none here. Nothing in this file calls a payment provider,
// and paymentStatus, the total and every cash-refund column stay as they are.
//
// LOCK ORDER (the law's header): the ORDER row first, then its obligations and sends.
// ---------------------------------------------------------------------------

export const MMG_REFUND_DISPUTE_SUBJECT = 'The customer says the MMG refund did not arrive';
export const MMG_REFUND_OVERDUE_TITLE = 'MMG refund overdue';
export const MMG_REFUND_OVERDUE_KEY = 'ops_page:mmg-refund-overdue';
export const MMG_REFUND_OVERDUE_WINDOW_SECONDS = 6 * 3_600;
/** Ruling 1 of the rail plan: a "Refund sent" the customer never answers stays open, and they are asked again. */
export const MMG_REFUND_NUDGE_AFTER_HOURS = 48;

type Tx = Prisma.TransactionClient;
const OBLIGATION_SELECT = {
  id: true, status: true, amount: true, currencyCode: true, deadlineHours: true, dueAt: true, missedAt: true, sendId: true, revision: true,
  orderId: true, vendorId: true, customerId: true, kind: true,
} as const satisfies Prisma.MmgRefundObligationSelect;

/** The order's row lock, then the order. Every command here starts with it. */
async function lockedOrder(tx: Tx, orderId: string) {
  await bindTenantTransaction(tx);
  await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, tenantId: true, orderNumber: true, customerId: true, vendorId: true, currencyCode: true, mmgAttestedRef: true },
  });
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

/** One command on one obligation, read under the order lock: the law decides, a compare-and-set writes. */
async function applyToObligation(tx: Tx, row: Parameters<typeof decideMmgRefundObligation>[0], command: MmgRefundCommand, now: Date): Promise<boolean> {
  const decision = decideMmgRefundObligation(row, command, now);
  if (decision.kind === 'UNCHANGED') return false;
  const written = await tx.mmgRefundObligation.updateMany({ where: { id: row.id, revision: decision.expectedRevision }, data: decision.data });
  if (written.count !== 1) throw new AppError(409, 'MMG_REFUND_STALE', 'This refund changed just now. Refresh and try again.');
  return true;
}

/**
 * What a send still covers, judged on the row under the order lock. A send support already found on, or one whose
 * obligations were voided, is closed: an empty list used to walk straight past the law, record the answer or flip the
 * finding, and open a case about nothing.
 */
async function coveredBy(tx: Tx, send: { id: string; resolution: string | null }) {
  const covered = send.resolution === null ? await tx.mmgRefundObligation.findMany({ where: { sendId: send.id }, select: OBLIGATION_SELECT }) : [];
  if (covered.length === 0) throw new AppError(409, 'MMG_REFUND_NOT_OPEN', 'This refund is already closed. Refresh to see where it stands.');
  return covered;
}

/** One write to a send: a compare-and-set on the generation read under the lock. */
async function writeSend(tx: Tx, send: { id: string; revision: number }, data: Prisma.MmgRefundSendUncheckedUpdateManyInput): Promise<void> {
  const written = await tx.mmgRefundSend.updateMany({ where: { id: send.id, revision: send.revision }, data: { ...data, revision: send.revision + 1 } });
  if (written.count !== 1) throw new AppError(409, 'MMG_REFUND_STALE', 'This refund changed just now. Refresh and try again.');
}

export interface SendRefundInput { orderId: string; actorUserId: string; reference: unknown; amount: Prisma.Decimal }
export interface SendRefundResult { sendId: string; replayed: boolean; orderNumber: string; customerId: string; vendorId: string; amount: Prisma.Decimal; currencyCode: string; tenantId: string }

/**
 * The store's "Refund sent": one send covering every OWED obligation on the order, for exactly what they add up to. A
 * reference is evidence only if it is unique; a second tap with the same reference on the same order is the answer it lost.
 */
export async function recordMmgRefundSent(prisma: PrismaClient, input: SendRefundInput): Promise<SendRefundResult> {
  const reference = normaliseReference(input.reference, {
    required: 'Enter the reference from your MMG message. It is the only proof the refund was sent.',
    invalid: 'That does not look like an MMG reference. Copy it from your MMG message.',
  }, 'MMG_REFUND_REF');
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await lockedOrder(tx, input.orderId);
      const already = await tx.mmgRefundSend.findUnique({ where: { mmgRefundRef: reference } });
      if (already) {
        // Support found this one did not arrive: its reference is spent, and a new send needs a new transfer.
        if (already.orderId !== order.id || already.resolution === 'NOT_RECEIVED') throw refUsed();
        return { sendId: already.id, replayed: true, orderNumber: order.orderNumber, customerId: order.customerId, vendorId: already.vendorId, amount: already.amount, currencyCode: already.currencyCode, tenantId: order.tenantId };
      }
      if (reference === order.mmgAttestedRef?.toUpperCase()) {
        throw new AppError(409, 'MMG_REFUND_REF_IS_PAYMENT', 'That is the reference of the customer\'s payment. Enter the reference of the refund you sent.');
      }
      const obligations = await tx.mmgRefundObligation.findMany({ where: { orderId: order.id }, select: OBLIGATION_SELECT, orderBy: { createdAt: 'asc' } });
      const owed = obligations.filter((o) => o.status === 'OWED');
      if (owed.length === 0) throw new AppError(409, 'MMG_REFUND_NOTHING_OWED', 'No refund is waiting to be sent on this order.');
      if (!sendMatchesOwed(input.amount, obligations)) {
        throw new AppError(409, 'MMG_REFUND_AMOUNT_MISMATCH', `This order owes GY$${mmgRefundOwed(obligations).toNumber().toLocaleString('en-US')}. Enter exactly what you sent.`, { owed: mmgRefundOwed(obligations).toFixed(2) });
      }
      const first = owed[0]!;
      const send = await tx.mmgRefundSend.create({ data: {
        tenantId: order.tenantId, orderId: order.id, vendorId: first.vendorId, customerId: first.customerId, mmgRefundRef: reference,
        amount: input.amount, currencyCode: first.currencyCode, sentById: input.actorUserId, coveredObligationIds: owed.map((o) => o.id),
      } });
      const now = new Date();
      for (const obligation of owed) await applyToObligation(tx, obligation, { event: 'SEND', sendId: send.id }, now);
      return { sendId: send.id, replayed: false, orderNumber: order.orderNumber, customerId: first.customerId, vendorId: first.vendorId, amount: input.amount, currencyCode: first.currencyCode, tenantId: order.tenantId };
    });
  } catch (error) {
    // Two stores racing the same reference: the unique index decides.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw refUsed();
    throw error;
  }
}

const refUsed = () => new AppError(409, 'MMG_REFUND_REF_USED', 'That MMG reference is already on another refund. Check it and try again.');

export interface AnswerRefundResult { replayed: boolean; received: boolean; ticketId: string | null; orderNumber: string; vendorId: string; amount: Prisma.Decimal; tenantId: string }

/** The customer's word on a "Refund sent": it arrived, or it did not, and then a support case opens in the same commit. */
export async function answerMmgRefund(prisma: PrismaClient, input: { orderId: string; sendId: string; customerId: string; received: boolean }): Promise<AnswerRefundResult> {
  return prisma.$transaction(async (tx) => {
    const order = await lockedOrder(tx, input.orderId);
    if (order.customerId !== input.customerId) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const send = await tx.mmgRefundSend.findFirst({ where: { id: input.sendId, orderId: order.id } });
    if (!send) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
    const answer = input.received ? 'RECEIVED' : 'NOT_RECEIVED';
    if (send.answer !== null) {
      if (send.answer !== answer) throw new AppError(409, 'MMG_REFUND_ALREADY_ANSWERED', 'You already answered this. If that was a mistake, contact Swift support.');
      return { replayed: true, received: input.received, ticketId: send.supportTicketId, orderNumber: order.orderNumber, vendorId: send.vendorId, amount: send.amount, tenantId: order.tenantId };
    }
    const covered = await coveredBy(tx, send);
    const now = new Date();
    for (const obligation of covered) {
      await applyToObligation(tx, obligation, { event: input.received ? 'CUSTOMER_RECEIVED' : 'CUSTOMER_NOT_RECEIVED', actorId: input.customerId }, now);
    }
    const ticket = input.received ? null : await insertTicketFor(tx, {
      userId: input.customerId, orderId: order.id, category: 'PAYMENT', subject: MMG_REFUND_DISPUTE_SUBJECT,
      message: `The store marked a refund of GY$${send.amount.toNumber().toLocaleString('en-US')} sent for order ${order.orderNumber}. The customer says it did not arrive.`,
    });
    await writeSend(tx, send, { answer, answeredAt: now, ...(ticket ? { supportTicketId: ticket.id } : {}) });
    return { replayed: false, received: input.received, ticketId: ticket?.id ?? null, orderNumber: order.orderNumber, vendorId: send.vendorId, amount: send.amount, tenantId: order.tenantId };
  });
}

/** Support's finding on a disputed send. NOT_RECEIVED owes it again on a new deadline, and that reference stays spent. */
export async function resolveMmgRefundDispute(
  prisma: PrismaClient,
  input: { sendId: string; actorId: string; received: boolean; note: string; authorize: (tx: Tx, parties: { customerId: string; vendorId: string }) => Promise<void>; audit: (tx: Tx, facts: Record<string, string>) => Promise<void> },
): Promise<{ orderId: string; orderNumber: string; customerId: string; vendorId: string; amount: Prisma.Decimal }> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.mmgRefundSend.findUnique({ where: { id: input.sendId }, select: { orderId: true } });
    if (!found) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
    const order = await lockedOrder(tx, found.orderId);
    const send = await tx.mmgRefundSend.findUniqueOrThrow({ where: { id: input.sendId } });
    await input.authorize(tx, { customerId: send.customerId, vendorId: send.vendorId });
    const covered = await coveredBy(tx, send);
    const policy = await mmgRefundPolicy(tx);
    const now = new Date();
    for (const obligation of covered) {
      await applyToObligation(tx, obligation, input.received
        ? { event: 'SUPPORT_RECEIVED', actorId: input.actorId, note: input.note }
        : { event: 'SUPPORT_NOT_RECEIVED', actorId: input.actorId, note: input.note, policy }, now);
    }
    await writeSend(tx, send, { resolution: input.received ? 'RECEIVED' : 'NOT_RECEIVED', resolvedById: input.actorId, resolvedAt: now, note: input.note });
    await input.audit(tx, { resolution: input.received ? 'RECEIVED' : 'NOT_RECEIVED', orderId: order.id });
    return { orderId: order.id, orderNumber: order.orderNumber, customerId: send.customerId, vendorId: send.vendorId, amount: send.amount };
  });
}

/** Support voids one obligation (two people, the C4 gate). The record stays; nothing is owed on it any more. */
export async function voidMmgRefundObligation(
  prisma: PrismaClient,
  input: { obligationId: string; actorId: string; note: string; authorize: (tx: Tx, parties: { customerId: string; vendorId: string }) => Promise<void>; audit: (tx: Tx, facts: Record<string, string>) => Promise<void> },
): Promise<{ orderId: string; orderNumber: string; customerId: string; vendorId: string; amount: Prisma.Decimal }> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.mmgRefundObligation.findUnique({ where: { id: input.obligationId }, select: { orderId: true } });
    if (!found) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
    const order = await lockedOrder(tx, found.orderId);
    const row = await tx.mmgRefundObligation.findUniqueOrThrow({ where: { id: input.obligationId }, select: OBLIGATION_SELECT });
    await input.authorize(tx, { customerId: row.customerId, vendorId: row.vendorId });
    await applyToObligation(tx, row, { event: 'VOID', actorId: input.actorId, note: input.note }, new Date());
    await input.audit(tx, { orderId: order.id, previousStatus: row.status });
    return { orderId: order.id, orderNumber: order.orderNumber, customerId: row.customerId, vendorId: row.vendorId, amount: row.amount };
  });
}

/** The sweep's one obligation: under the order lock, the law decides. True when this pass marked the miss. */
export async function markMmgRefundMissed(prisma: PrismaClient, obligationId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.mmgRefundObligation.findUnique({ where: { id: obligationId }, select: { orderId: true } });
    if (!found) return false;
    await lockedOrder(tx, found.orderId);
    const row = await tx.mmgRefundObligation.findUniqueOrThrow({ where: { id: obligationId }, select: OBLIGATION_SELECT });
    return applyToObligation(tx, row, { event: 'DEADLINE_PASSED' }, now);
  });
}

/**
 * [BUG-HUNT-2 G22 · COORD 4 Nov 2026] A paid MMG order whose goods came back. The customer has no goods and the store has the
 * money: that is owed, and until now nothing said so. Called on the locked row, in the commit that closes the return, or in
 * the commit of support's finding when a dispute held it. An open dispute records nothing yet: support's finding decides.
 * What it records is what the store attested, less what is already owed on the order; one per order, by its cause key.
 * Record only, like the rest of the rail: the order's payment and total stay as they are.
 */
export async function openMmgRefundOnReturn(tx: Tx, orderId: string, actorId: string | null, now: Date): Promise<ReturnRefund | null> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, orderNumber: true, tenantId: true, vendorId: true, customerId: true, paymentMethod: true, paymentStatus: true, mmgAttestedAmount: true, mmgClaimMismatchAt: true },
  });
  const paid = order.paymentStatus === 'CLAIMED' || order.paymentStatus === 'CAPTURED';
  if (order.paymentMethod !== 'MOBILE_MONEY' || !order.vendorId || !paid || order.mmgClaimMismatchAt) return null;
  const held = await tx.mmgRefundObligation.findMany({ where: { orderId }, select: { kind: true, status: true, amount: true } });
  if (held.some((row) => row.kind === 'CANCELLATION')) return null;
  const amount = mmgRefundRemainder(order.mmgAttestedAmount, held);
  if (!amount.gt(0)) return null;
  const obligation = await tx.mmgRefundObligation.create({
    data: openMmgRefundObligation({
      kind: 'CANCELLATION', tenantId: order.tenantId, orderId, vendorId: order.vendorId, customerId: order.customerId, amount, currencyCode: 'GYD',
      basis: 'ATTESTED_REMAINDER', reason: MMG_RETURN_REFUND_REASON, createdById: actorId,
    }, await mmgRefundPolicy(tx), now),
    select: { id: true, dueAt: true },
  });
  return { obligationId: obligation.id, orderId, orderNumber: order.orderNumber, customerId: order.customerId, vendorId: order.vendorId, amount, dueAt: obligation.dueAt };
}

export const MMG_RETURN_REFUND_REASON = 'The order came back to the store after the customer paid by MMG.';

export type ReturnRefund = { obligationId: string; orderId: string; orderNumber: string; customerId: string; vendorId: string; amount: Prisma.Decimal; dueAt: Date };

// ─── The words ──────────────────────────────────────────────────────────────

const gyd = (amount: Prisma.Decimal | number): string => `GY$${Number(amount).toLocaleString('en-US')}`;
const when = (at: Date): string => formatGuyanaTime(at, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }, 'en-US');

type RefundRow = { status: MmgRefundStatus; amount: Prisma.Decimal; dueAt: Date; currencyCode: string; sendId: string | null };
type SendRow = { id: string; mmgRefundRef: string; amount: Prisma.Decimal; answer: string | null };

export type RefundState = 'OWED' | 'OVERDUE' | 'SENT' | 'DISPUTED' | 'DONE';

/** Where an order's refund stands: the worst state any obligation on it is in. */
function refundState(rows: readonly RefundRow[], now: Date): { state: RefundState; rows: RefundRow[] } | null {
  const pick = (status: MmgRefundStatus) => rows.filter((r) => r.status === status);
  const owed = pick('OWED');
  if (owed.length > 0) return { state: owed.some((r) => r.dueAt.getTime() <= now.getTime()) ? 'OVERDUE' : 'OWED', rows: owed };
  const disputed = pick('DISPUTED');
  if (disputed.length > 0) return { state: 'DISPUTED', rows: disputed };
  const sent = pick('SENT');
  if (sent.length > 0) return { state: 'SENT', rows: sent };
  const done = rows.filter((r) => r.status === 'CONFIRMED' || r.status === 'SETTLED');
  return done.length > 0 ? { state: 'DONE', rows: done } : null;
}

const total = (rows: readonly RefundRow[]): Prisma.Decimal => rows.reduce((sum, r) => sum.plus(r.amount), new Prisma.Decimal(0));
const due = (rows: readonly RefundRow[]): Date => rows.reduce((at, r) => (r.dueAt.getTime() < at.getTime() ? r.dueAt : at), rows[0]!.dueAt);

export interface StoreRefundView { state: RefundState; amount: string; currencyCode: string; dueAt: string; line: string; canMarkSent: boolean }

/** What the store's order screen shows. The screen renders this; it decides nothing. */
export function storeRefundView(rows: readonly RefundRow[], now: Date, mayMarkSent: boolean): StoreRefundView | null {
  const at = refundState(rows, now);
  if (!at) return null;
  const amount = total(at.rows);
  const owedBy = due(at.rows);
  const line: Record<RefundState, string> = {
    OWED: `You owe the customer ${gyd(amount)} by MMG, by ${when(owedBy)}. Send it from your MMG, then tap Refund sent.`,
    OVERDUE: `Your refund of ${gyd(amount)} was due by ${when(owedBy)}. Send it from your MMG now, then tap Refund sent. Leaving it unpaid can suspend your store.`,
    SENT: `You marked ${gyd(amount)} sent. The customer has been asked whether it arrived.`,
    DISPUTED: `The customer says your refund of ${gyd(amount)} did not arrive. Swift support is checking.`,
    DONE: `Your refund of ${gyd(amount)} is confirmed.`,
  };
  return {
    state: at.state, amount: amount.toFixed(2), currencyCode: at.rows[0]!.currencyCode, dueAt: owedBy.toISOString(), line: line[at.state],
    canMarkSent: mayMarkSent && (at.state === 'OWED' || at.state === 'OVERDUE'),
  };
}

export interface CustomerRefundView { state: RefundState; amount: string; currencyCode: string; dueAt: string; line: string; sendId: string | null; canAnswer: boolean }

/** What the customer's order screen shows. Never "refunded" before the customer or support said so (AF.4 #16). */
export function customerRefundView(rows: readonly RefundRow[], sends: readonly SendRow[], storeName: string, now: Date): CustomerRefundView | null {
  const at = refundState(rows, now);
  if (!at) return null;
  const amount = total(at.rows);
  const owedBy = due(at.rows);
  const send = at.state === 'SENT' ? sends.find((s) => s.id === at.rows[0]!.sendId && s.answer === null) ?? null : null;
  const line: Record<RefundState, string> = {
    OWED: `${storeName} owes you ${gyd(amount)} by MMG, by ${when(owedBy)}. Swift does not hold your money. If it does not arrive, contact Swift support.`,
    OVERDUE: `${storeName} has not marked your refund of ${gyd(amount)} sent, and it is past the deadline. Swift support has been told. You can contact them from this screen.`,
    SENT: send ? `${storeName} says it sent ${gyd(amount)} by MMG, reference ${send.mmgRefundRef}. Did it arrive?` : `${storeName} says it sent ${gyd(amount)} by MMG.`,
    DISPUTED: `You said your refund of ${gyd(amount)} did not arrive. Swift support is checking with ${storeName}.`,
    DONE: `Your refund of ${gyd(amount)} is confirmed.`,
  };
  return {
    state: at.state, amount: amount.toFixed(2), currencyCode: at.rows[0]!.currencyCode, dueAt: owedBy.toISOString(), line: line[at.state],
    sendId: send?.id ?? null, canAnswer: send !== null,
  };
}

export const refundSentCustomerNotice = (orderNumber: string, storeName: string, amount: Prisma.Decimal) => ({
  title: 'Did your refund arrive?',
  body: `${storeName} says it sent your ${gyd(amount)} refund for order ${orderNumber} by MMG. Open the order and tell Swift whether it arrived.`,
});
export const refundNudgeCustomerNotice = (orderNumber: string, amount: Prisma.Decimal) => ({
  title: 'Did your refund arrive?',
  body: `The ${gyd(amount)} refund for order ${orderNumber} is still waiting for your answer. Open the order and tell Swift whether it arrived.`,
});
export const refundConfirmedStoreNotice = (orderNumber: string, amount: Prisma.Decimal) => ({
  title: 'Refund confirmed',
  body: `The customer confirmed your ${gyd(amount)} refund for order ${orderNumber} arrived.`,
});
export const refundDisputedStoreNotice = (orderNumber: string, amount: Prisma.Decimal) => ({
  title: 'Customer says the refund did not arrive',
  body: `The customer says your ${gyd(amount)} refund for order ${orderNumber} did not arrive. Swift support is checking and may contact you.`,
});
export const refundOverdueStoreNotice = (orderNumber: string, amount: Prisma.Decimal) => ({
  title: 'Refund overdue',
  body: `Your ${gyd(amount)} refund for order ${orderNumber} is past its deadline. Send it from your MMG, then tap Refund sent on the order. Leaving it unpaid can suspend your store.`,
});
export const refundResolvedNotice = (orderNumber: string, amount: Prisma.Decimal, received: boolean) => (received
  ? { title: 'Refund closed', body: `Swift support found your ${gyd(amount)} refund for order ${orderNumber} was received. It is closed.` }
  : { title: 'Refund still owed', body: `Swift support found the ${gyd(amount)} refund for order ${orderNumber} did not arrive, so it is owed again. Swift moved no money.` });
export const refundVoidedNotice = (orderNumber: string, amount: Prisma.Decimal) => ({
  title: 'Refund record closed',
  body: `Swift support closed the ${gyd(amount)} refund record for order ${orderNumber}. Swift moved no money. If you have a question, contact Swift support.`,
});

/** The customer's view, read for the order screen. */
export async function customerMmgRefund(prisma: PrismaClient, orderId: string, storeName: string, now: Date): Promise<CustomerRefundView | null> {
  const rows = await prisma.mmgRefundObligation.findMany({ where: { orderId }, select: { status: true, amount: true, dueAt: true, currencyCode: true, sendId: true } });
  if (rows.length === 0) return null;
  const sends = await prisma.mmgRefundSend.findMany({ where: { orderId }, select: { id: true, mmgRefundRef: true, amount: true, answer: true } });
  return customerRefundView(rows, sends, storeName, now);
}

/** [BUG-HUNT-2 G22] Both sides read what the return left owing, once each, after the commit. The order screens say it too. */
export async function tellOfReturnRefund(prisma: PrismaClient, notifications: NotificationService, refund: ReturnRefund): Promise<void> {
  const store = await prisma.vendor.findUnique({ where: { id: refund.vendorId }, select: { name: true, owner: { select: { userId: true } } } });
  const storeName = store?.name ?? 'The store';
  await notifications.send({
    userId: refund.customerId, type: 'ORDER_UPDATE', audience: 'customer',
    title: 'Order returned: the store refunds you',
    body: `Your order ${refund.orderNumber} went back to ${storeName}. Swift does not hold your money. ${storeName} received ${gyd(refund.amount)} by MMG and must refund it to you by ${when(refund.dueAt)}. If it does not, contact Swift support from the order screen.`,
    data: { orderId: refund.orderId, kind: 'mmg_refund_owed' }, dedupeKey: `mmg-refund-owed:customer:${refund.obligationId}`,
  });
  if (!store) return;
  await notifications.send({
    userId: store.owner.userId, type: 'ORDER_UPDATE', audience: 'business',
    title: 'Order returned: refund the customer',
    body: `Order ${refund.orderNumber} came back to you. The customer paid your store by MMG: send them ${gyd(refund.amount)} from your MMG by ${when(refund.dueAt)}, then tap Refund sent on the order.`,
    data: { orderId: refund.orderId, kind: 'mmg_refund_owed_store' }, dedupeKey: `mmg-refund-owed:store:${refund.obligationId}`,
  });
}

/** The store is told the answer after the commit, once; a "no" pages support on its case. */
export async function tellStoreOfRefundAnswer(prisma: PrismaClient, notifications: NotificationService, orderId: string, outcome: AnswerRefundResult): Promise<void> {
  const ownerUserId = (await prisma.vendor.findUnique({ where: { id: outcome.vendorId }, select: { owner: { select: { userId: true } } } }))?.owner.userId;
  if (ownerUserId) {
    await notifications.send({
      userId: ownerUserId, type: 'ORDER_UPDATE', audience: 'business',
      ...(outcome.received
        ? { ...refundConfirmedStoreNotice(outcome.orderNumber, outcome.amount), data: { orderId, kind: 'mmg_refund_confirmed' } }
        : { ...refundDisputedStoreNotice(outcome.orderNumber, outcome.amount), data: { orderId, kind: 'mmg_refund_disputed' } }),
      dedupeKey: `mmg-refund-answer:${orderId}:${outcome.received ? 'yes' : 'no'}`,
    }).catch(() => undefined);
  }
  if (outcome.ticketId) {
    await notifyAdmins(prisma, notifications, {
      tenantId: outcome.tenantId, title: 'MMG refund disputed',
      body: `Order ${outcome.orderNumber}: the store marked a refund sent and the customer says it did not arrive.`,
      data: { kind: 'support_ticket', ticketId: outcome.ticketId, orderId },
    }).catch(() => undefined);
  }
}

/** Both sides told of support's finding or a void, after the commit. */
export async function tellBothOfRefund(prisma: PrismaClient, notifications: NotificationService, facts: { orderId: string; customerId: string; vendorId: string }, words: { title: string; body: string }, key: string): Promise<void> {
  const ownerUserId = (await prisma.vendor.findUnique({ where: { id: facts.vendorId }, select: { owner: { select: { userId: true } } } }))?.owner.userId;
  await notifications.send({ userId: facts.customerId, type: 'ORDER_UPDATE', audience: 'customer', ...words, data: { orderId: facts.orderId, kind: 'mmg_refund_resolved' }, dedupeKey: `${key}:customer` }).catch(() => undefined);
  if (ownerUserId) await notifications.send({ userId: ownerUserId, type: 'ORDER_UPDATE', audience: 'business', ...words, data: { orderId: facts.orderId, kind: 'mmg_refund_resolved' }, dedupeKey: `${key}:store` }).catch(() => undefined);
}

/**
 * Who may decide a refund. Nobody decides one they are on, through any account of theirs, and that goes for the second
 * person of a two-person decision too: the customer, or anyone who owns or works at the store, with every account linked to
 * them. An identity waiting for a person refuses it outright, because then nobody knows who is on this order. With a staff
 * account anywhere among them it goes to a SUPER_ADMIN who is not on it, so a colleague's refund is never out of everyone's
 * reach. Called inside the transaction, on the people the locked row names, with the database's roles at that moment,
 * never the session's.
 */
export async function assertMayDecideRefund(tx: Tx, actorId: string, parties: { customerId: string; vendorId: string }, approvalId?: string | null): Promise<void> {
  const store = await tx.vendor.findUnique({ where: { id: parties.vendorId }, select: { owner: { select: { userId: true } }, staff: { select: { userId: true } } } });
  const named = [parties.customerId, ...(store ? [store.owner.userId, ...store.staff.map((member) => member.userId)] : [])];
  const approver = approvalId ? (await tx.privilegedApproval.findUnique({ where: { id: approvalId }, select: { approvedBy: true } }))?.approvedBy ?? null : null;
  if (approvalId && !approver) throw new AppError(403, 'APPROVAL_NOT_FOUND', 'This approval could not be read. Ask for a new one.');
  const staff = new AppError(403, 'STAFF_ON_ORDER', 'A staff account is on this order. Only a SUPER_ADMIN who is not on it can decide this refund.');
  await requireIdentityAuthority(tx, actorId);
  if (approver) {
    await requireIdentityAuthority(tx, approver);
    await assertClearOfParties(tx, approver, named, { own: new AppError(403, 'APPROVER_ON_ORDER', 'The admin who approved this is on the order. Ask someone else to approve it.'), staff });
  }
  await assertClearOfParties(tx, actorId, named, { own: new AppError(403, 'OWN_ORDER', 'You are on this order. Someone else at Swift must decide this refund.'), staff });
}

/** Open obligations, for the sweep and the list. */
export const openRefundWhere = { status: { in: [...MMG_REFUND_OPEN_STATUSES] } } satisfies Prisma.MmgRefundObligationWhereInput;
