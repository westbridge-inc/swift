import { createHash } from 'node:crypto';

/**
 * [MOB-023] The HANDOVER AUTHORITY — what the person at the door may do, said
 * by the server, from the order's own payment rail and payment state.
 *
 * The rider's screen used to decide "collect NOTHING at the door" from
 * `paymentMethod === 'MOBILE_MONEY'` alone. The method says how the customer
 * INTENDED to pay; only `paymentStatus` says whether money landed. An MMG order
 * whose payment is still PENDING, UNKNOWN (the provider window closed without
 * an answer), FAILED, EXPIRED or REFUNDED must never be handed over as "already
 * paid" — the loss lands on the store, the rider or the customer, and the
 * custody record says something that never happened.
 *
 * The fulfilment gate (SPS-F-0016) already refuses to move an MMG order through
 * acceptance while PENDING; this is the door's own authority, derived once
 * here, carried on every rider payload, and validated again by the server at
 * the moment of handover — with a version, so a stale screen cannot act on a
 * state the server has since changed.
 */
export type PaymentRail = 'CASH' | 'MOBILE_MONEY' | 'OTHER';

export type HandoverPermission =
  /** The customer's money already landed: hand over, collect nothing. */
  | 'DELIVER_NO_CASH'
  /** Cash rail, money not yet recorded: collect (or record the failed outcome) through the cash door, which completes the delivery. */
  | 'COLLECT_CASH_THEN_DELIVER'
  /** The rail says "already paid" but the state does not: no hand-over, refresh or a supervisor. */
  | 'BLOCKED';

export interface HandoverAuthority {
  rail: PaymentRail;
  paymentState: string;
  custodyState: string;
  amount: number;
  currency: string;
  /** Changes whenever the payment or custody state does; the client echoes it and the server refuses a stale one. */
  version: string;
  permitted: HandoverPermission;
  /** Why the door is blocked, when it is — never a coordinate, never a secret. */
  blockReason: string | null;
}

export interface HandoverOrderLike {
  id: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  totalAmount: unknown;
  currencyCode?: string | null;
  updatedAt: Date | string;
}

export function paymentRailOf(paymentMethod: string): PaymentRail {
  if (paymentMethod === 'CASH') return 'CASH';
  if (paymentMethod === 'MOBILE_MONEY') return 'MOBILE_MONEY';
  return 'OTHER';
}

/** A short digest of (order, custody state, payment state, last write) — the door's version. */
export function handoverVersionFor(order: Pick<HandoverOrderLike, 'id' | 'status' | 'paymentStatus' | 'updatedAt'>): string {
  const at = order.updatedAt instanceof Date ? order.updatedAt.getTime() : Date.parse(String(order.updatedAt));
  return createHash('sha256').update(`${order.id}|${order.status}|${order.paymentStatus}|${Number.isFinite(at) ? at : 'x'}`).digest('hex').slice(0, 16);
}

export function handoverAuthorityFor(order: HandoverOrderLike): HandoverAuthority {
  const rail = paymentRailOf(order.paymentMethod);
  const base = {
    rail,
    paymentState: order.paymentStatus,
    custodyState: order.status,
    amount: Number(order.totalAmount),
    currency: order.currencyCode ?? 'GYD',
    version: handoverVersionFor(order),
  };
  if (order.paymentStatus === 'CAPTURED') return { ...base, permitted: 'DELIVER_NO_CASH', blockReason: null };
  if (rail === 'CASH') return { ...base, permitted: 'COLLECT_CASH_THEN_DELIVER', blockReason: null };
  // A non-cash rail whose money has not landed: the door is closed until it does.
  return { ...base, permitted: 'BLOCKED', blockReason: `${rail}_${order.paymentStatus}` };
}

/** True when the client's echoed version names the order's current state. */
export function handoverVersionMatches(order: Pick<HandoverOrderLike, 'id' | 'status' | 'paymentStatus' | 'updatedAt'>, echoed: string | undefined | null): boolean {
  if (echoed === undefined || echoed === null) return true; // an older client that does not echo is not refused for it
  return echoed === handoverVersionFor(order);
}
