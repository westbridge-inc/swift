import type { Prisma } from '@prisma/client';
import { ownerRlsBindEnabled } from '../../lib/owner-rls';
import { closeOrderCase } from '../../lib/owner-wall-tickets';
import { formatGuyanaTime } from '../../utils/guyana-day';
import { formatMoney } from '../../utils/currency-amount';

// ---------------------------------------------------------------------------
// [owner 18 Oct 2026 · PAYMENT-SIMPLIFY] An MMG order the store ACCEPTED but
// never marked "Paid by MMG" cancels automatically 30 minutes after it was
// accepted. The customer and the store are both told why (push + order card).
// Until then nothing is prepared and no rider moves (COORD ruling Q1), and the
// customer may still cancel in the app (Q2).
//
// ONE predicate decides which order expires and when, and every reader uses it:
// the sweep's query filter, the locked check in the canonical cancellation seam
// (order.service requireUnpaidMmgAcceptanceExpired), the pay-by time the
// customer and the store see. The decision is made on the LOCKED row: the
// store's "Paid by MMG" takes the same orders row lock, so whichever commits
// first wins and the other sees it — a tap at 29:59 keeps the order; the
// cancel at 30:00 makes a later tap refuse (the order is closed).
//
// Swift never holds the money: when an order cancels, a customer who already
// sent the MMG payment is refunded by the store, directly.
// ---------------------------------------------------------------------------

/** How long the customer has, from the store's acceptance, to pay and be marked paid. */
export const MMG_ACCEPTED_PAY_WINDOW_MINUTES = 30;
export const MMG_ACCEPTED_PAY_WINDOW_MS = MMG_ACCEPTED_PAY_WINDOW_MINUTES * 60_000;

/** The payment states in which money has moved on the store's MMG (order.service MMG_MONEY_MOVED; parity is tested). */
const MONEY_MOVED: ReadonlySet<string> = new Set(['CAPTURED', 'CLAIMED']);

export interface UnpaidMmgAcceptanceFacts {
  status: string;
  paymentMethod: string | null;
  paymentStatus: string;
  orderType: string | null;
  vendorId: string | null;
  acceptedAt: Date | null;
  /** A store claim an operator rejected keeps its reference: that order is support's, never auto-cancelled. */
  mmgAttestedRef?: string | null;
  /** An open disagreement is support's to decide, never auto-cancelled. */
  mmgClaimMismatchAt?: Date | null;
  /** [owner 18 Oct 2026] The customer's recorded "I paid": such an order is never auto-cancelled — at 30:00 the
   *  store is asked to check its MMG and a support case opens instead. Unread (undefined) = never expires. */
  customerMmgClaim?: string | null;
}

/** Accepted, an MMG store order, and nothing says the money moved: the base of both 30-minute outcomes. */
export function isUnpaidMmgAcceptance(order: UnpaidMmgAcceptanceFacts): boolean {
  if (order.status !== 'ACCEPTED') return false;
  if (order.paymentMethod !== 'MOBILE_MONEY') return false;
  if (order.orderType === 'TAXI' || !order.vendorId) return false;
  if (MONEY_MOVED.has(order.paymentStatus)) return false;
  if (order.mmgAttestedRef !== null || order.mmgClaimMismatchAt !== null) return false;
  return order.acceptedAt != null;
}

/**
 * The moment an accepted, unpaid MMG store order cancels — or null when this
 * order never auto-cancels. A field the caller did not read (undefined) is
 * never taken as "no claim": the order is left alone (fail closed).
 */
export function mmgAcceptedPayBy(order: UnpaidMmgAcceptanceFacts): Date | null {
  if (!isUnpaidMmgAcceptance(order)) return null;
  if (order.customerMmgClaim === undefined || order.customerMmgClaim === 'PAID') return null;
  return new Date(order.acceptedAt!.getTime() + MMG_ACCEPTED_PAY_WINDOW_MS);
}

/** [owner 18 Oct 2026] The customer says they paid and the store has been silent for 30 minutes: ask the store, open a case. */
export function isStoreSilentOnClaimedMmgPayment(order: UnpaidMmgAcceptanceFacts, now: Date = new Date()): boolean {
  if (!isUnpaidMmgAcceptance(order) || order.customerMmgClaim !== 'PAID') return false;
  return order.acceptedAt!.getTime() + MMG_ACCEPTED_PAY_WINDOW_MS <= now.getTime();
}

/** The support case's fixed subject: one per order (the sweep and the locked check both look for it). */
export const MMG_STORE_SILENT_SUBJECT = 'MMG payment the customer reported is not confirmed by the store';

/** True once the 30 minutes have run out (at exactly 30:00 the order cancels). */
export function isExpiredUnpaidMmgAcceptance(order: UnpaidMmgAcceptanceFacts, now: Date = new Date()): boolean {
  const payBy = mmgAcceptedPayBy(order);
  return payBy !== null && payBy.getTime() <= now.getTime();
}

/** The sweep's filter: the same predicate as a query (the locked check re-decides each row). */
export function expiredUnpaidMmgAcceptanceWhere(now: Date = new Date()): Prisma.OrderWhereInput {
  return {
    status: 'ACCEPTED',
    paymentMethod: 'MOBILE_MONEY',
    orderType: { not: 'TAXI' },
    vendorId: { not: null },
    paymentStatus: { notIn: ['CAPTURED', 'CLAIMED'] },
    mmgAttestedRef: null,
    mmgClaimMismatchAt: null,
    customerMmgClaim: { not: 'PAID' },
    acceptedAt: { lte: new Date(now.getTime() - MMG_ACCEPTED_PAY_WINDOW_MS) },
  };
}

/** The second sweep filter: claimed "I paid", store silent 30 minutes, and no case opened yet. */
export function storeSilentOnClaimedMmgWhere(now: Date = new Date()): Prisma.OrderWhereInput {
  return {
    ...expiredUnpaidMmgAcceptanceWhere(now),
    customerMmgClaim: 'PAID',
    supportTickets: { none: { category: 'PAYMENT', subject: MMG_STORE_SILENT_SUBJECT } },
  };
}

/** The order's recorded reason (the store's order card shows it). */
export const MMG_ACCEPT_EXPIRY_REASON =
  `Cancelled automatically: not marked "Paid by MMG" within ${MMG_ACCEPTED_PAY_WINDOW_MINUTES} minutes of being accepted`;

function clock(at: Date): string {
  return formatGuyanaTime(at, { hour: 'numeric', minute: '2-digit', hour12: true }, 'en-US');
}

/** [REVIEW-F S3-1b] A booking is a booking in every line, never an "order". */
export type MmgOrderNoun = 'order' | 'booking';
export function mmgOrderNoun(fulfillment: string | null | undefined): MmgOrderNoun {
  return fulfillment === 'APPOINTMENT' ? 'booking' : 'order';
}
const cap = (noun: MmgOrderNoun) => (noun === 'booking' ? 'Booking' : 'Order');
const gyd = (amount: number, currencyCode: string) => formatMoney(amount, currencyCode, { whole: true });

/** The customer's line under "Pay $X by MMG to …", while the order waits. */
export function mmgPayByCustomerLine(payBy: Date, storeName: string, noun: MmgOrderNoun = 'order'): string {
  return `If ${storeName} hasn't marked it paid by ${clock(payBy)}, the ${noun} is cancelled automatically.`;
}

/** The store's line on an accepted order that waits for its MMG payment. */
export function mmgPayByStoreLine(payBy: Date): string {
  return `Cancels automatically at ${clock(payBy)} unless you mark it "Paid by MMG".`;
}

/** [REVIEW-F S2-1] The customer's push when the store ACCEPTS an unpaid MMG order: pay, how much, by when.
 *  Never "preparing" (nothing is prepared before "Paid by MMG"), and never the number (a push shows on the lock screen). */
export function mmgAcceptedPushCopy(orderNumber: string, storeName: string, amount: number, currencyCode: string, payBy: Date, noun: MmgOrderNoun = 'order'): { title: string; body: string } {
  return {
    title: `Pay by MMG to confirm your ${noun}`,
    body: `${storeName} accepted ${noun} ${orderNumber}. Pay ${gyd(amount, currencyCode)} by MMG — open your ${noun} for the number — by ${clock(payBy)}, or it cancels automatically.`,
  };
}

/** Accepted after the customer already said "I paid": it waits for the store, and is never "being prepared". */
export function mmgAcceptedClaimedPushCopy(orderNumber: string, storeName: string, noun: MmgOrderNoun = 'order'): { title: string; body: string } {
  return {
    title: 'Waiting for the store to confirm your MMG payment',
    body: `${storeName} accepted ${noun} ${orderNumber}. It goes ahead once ${storeName} marks your MMG payment received.`,
  };
}

/** [owner 18 Oct 2026] At 30:00 on an order the customer says they paid: the store is asked to check (never the number). */
export function mmgStoreSilentStorePush(orderNumber: string, amount: number, currencyCode: string, noun: MmgOrderNoun = 'order'): { title: string; body: string } {
  return {
    title: `Check your MMG for ${noun} ${orderNumber}`,
    body: `The customer says they paid ${gyd(amount, currencyCode)} to your MMG number. Check your MMG and tap Paid by MMG.`,
  };
}

/** [REVIEW-G S4] The case closes in the same commit as what ends it: the store's "Paid by MMG", or the order's
 *  cancellation (e.g. the customer later says they did not pay, so the 30-minute rule cancels it). */
export async function closeStoreSilentMmgCase(
  tx: { supportTicket: { updateMany(args: Prisma.SupportTicketUpdateManyArgs): Promise<{ count: number }> } }
    & { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  orderId: string,
  outcome: 'PAID_BY_MMG' | 'CANCELLED',
  now: Date = new Date(),
): Promise<number> {
  const adminNote = outcome === 'PAID_BY_MMG' ? 'Closed automatically: the store marked the MMG payment received ("Paid by MMG").' : 'Closed automatically: the order was cancelled.';
  // [item 20] The customer's case, closed in the store's (or the sweep's) transaction: with the wall on, the narrow action.
  if (ownerRlsBindEnabled()) return closeOrderCase(tx, orderId, MMG_STORE_SILENT_SUBJECT, adminNote, now);
  const { count } = await tx.supportTicket.updateMany({
    where: { orderId, category: 'PAYMENT', subject: MMG_STORE_SILENT_SUBJECT, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    data: {
      status: 'RESOLVED', resolution: 'ACTION_TAKEN', resolvedAt: now,
      adminNote,
    },
  });
  return count;
}

/** The support case the same moment opens (one per order). */
export function mmgStoreSilentTicketMessage(orderNumber: string, minutes = MMG_ACCEPTED_PAY_WINDOW_MINUTES): string {
  // Filed under the customer (it is their payment report), so it reads to them as well as to support.
  return `Order ${orderNumber}: you told us you paid by MMG, and the store has not marked it "Paid by MMG" ${minutes} minutes after accepting. Swift support is checking with the store. Your order is not cancelled; nothing is prepared or sent until the store confirms the money arrived. Swift never holds this money.`;
}

/** What the customer is told when it cancels (push + the order card). */
export function mmgAcceptExpiryCustomerCopy(orderNumber: string, storeName: string, noun: MmgOrderNoun = 'order'): { title: string; body: string; notice: string } {
  const notice = `${storeName} didn't mark your MMG payment as received within ${MMG_ACCEPTED_PAY_WINDOW_MINUTES} minutes of accepting, so this ${noun} was cancelled automatically. If you already sent the MMG payment, ${storeName} refunds you directly.`;
  return {
    title: `${cap(noun)} cancelled — MMG payment not confirmed`,
    body: `${cap(noun)} ${orderNumber}: ${notice}`,
    notice,
  };
}

/** What the store is told when it cancels. */
export function mmgAcceptExpiryStoreBody(orderNumber: string, noun: MmgOrderNoun = 'order'): string {
  return `${cap(noun)} ${orderNumber} was cancelled automatically: it was not marked "Paid by MMG" within ${MMG_ACCEPTED_PAY_WINDOW_MINUTES} minutes of being accepted. If the customer's MMG transfer arrived, refund them directly.`;
}

/** The customer's order-card notice for an order this rule cancelled (null for every other order). */
export function mmgAcceptExpiryNotice(order: { status: string; cancellationReason: string | null; cancelledBy?: string | null; orderNumber: string; fulfillment?: string | null }, storeName: string): string | null {
  if (order.status !== 'CANCELLED' || order.cancellationReason !== MMG_ACCEPT_EXPIRY_REASON) return null;
  if (order.cancelledBy != null) return null;
  return mmgAcceptExpiryCustomerCopy(order.orderNumber, storeName, mmgOrderNoun(order.fulfillment)).notice;
}
