import type { Prisma } from '@prisma/client';
import { formatGuyanaTime } from '../../utils/guyana-day';

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
}

/**
 * The moment an accepted, unpaid MMG store order cancels — or null when this
 * order never auto-cancels. A field the caller did not read (undefined) is
 * never taken as "no claim": the order is left alone (fail closed).
 */
export function mmgAcceptedPayBy(order: UnpaidMmgAcceptanceFacts): Date | null {
  if (order.status !== 'ACCEPTED') return null;
  if (order.paymentMethod !== 'MOBILE_MONEY') return null;
  if (order.orderType === 'TAXI' || !order.vendorId) return null;
  if (MONEY_MOVED.has(order.paymentStatus)) return null;
  if (order.mmgAttestedRef !== null || order.mmgClaimMismatchAt !== null) return null;
  if (!order.acceptedAt) return null;
  return new Date(order.acceptedAt.getTime() + MMG_ACCEPTED_PAY_WINDOW_MS);
}

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
    acceptedAt: { lte: new Date(now.getTime() - MMG_ACCEPTED_PAY_WINDOW_MS) },
  };
}

/** The order's recorded reason (the store's order card shows it). */
export const MMG_ACCEPT_EXPIRY_REASON =
  `Cancelled automatically: not marked "Paid by MMG" within ${MMG_ACCEPTED_PAY_WINDOW_MINUTES} minutes of being accepted`;

function clock(at: Date): string {
  return formatGuyanaTime(at, { hour: 'numeric', minute: '2-digit', hour12: true }, 'en-US');
}

/** The customer's line under "Pay $X by MMG to …", while the order waits. */
export function mmgPayByCustomerLine(payBy: Date, storeName: string): string {
  return `If ${storeName} hasn't marked it paid by ${clock(payBy)}, the order is cancelled automatically.`;
}

/** The store's line on an accepted order that waits for its MMG payment. */
export function mmgPayByStoreLine(payBy: Date): string {
  return `Cancels automatically at ${clock(payBy)} unless you mark it "Paid by MMG".`;
}

/** What the customer is told when it cancels (push + the order card). */
export function mmgAcceptExpiryCustomerCopy(orderNumber: string, storeName: string): { title: string; body: string; notice: string } {
  const notice = `${storeName} didn't mark your MMG payment as received within ${MMG_ACCEPTED_PAY_WINDOW_MINUTES} minutes of accepting, so this order was cancelled automatically. If you already sent the MMG payment, ${storeName} refunds you directly.`;
  return {
    title: 'Order cancelled — MMG payment not confirmed',
    body: `Order ${orderNumber}: ${notice}`,
    notice,
  };
}

/** What the store is told when it cancels. */
export function mmgAcceptExpiryStoreBody(orderNumber: string): string {
  return `Order ${orderNumber} was cancelled automatically: it was not marked "Paid by MMG" within ${MMG_ACCEPTED_PAY_WINDOW_MINUTES} minutes of being accepted. If the customer's MMG transfer arrived, refund them directly.`;
}

/** The customer's order-card notice for an order this rule cancelled (null for every other order). */
export function mmgAcceptExpiryNotice(order: { status: string; cancellationReason: string | null; cancelledBy?: string | null; orderNumber: string }, storeName: string): string | null {
  if (order.status !== 'CANCELLED' || order.cancellationReason !== MMG_ACCEPT_EXPIRY_REASON) return null;
  if (order.cancelledBy != null) return null;
  return mmgAcceptExpiryCustomerCopy(order.orderNumber, storeName).notice;
}
