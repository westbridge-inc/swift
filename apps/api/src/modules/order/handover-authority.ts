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
  /** [F-106-01] The rule set that produced this answer; the client rejects an unknown one. */
  policy: string;
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
  /**
   * [DOC-INV-48 · F-103-01] When the customer disputes the store's payment
   * claim. REQUIRED — never optional. An optional property is exactly how the
   * MMG fulfilment gate came to be inert: a forgotten projection type-checked
   * and the gate read `undefined` as "no dispute". The door is the one place
   * where being wrong hands physical goods to someone; it does not get the
   * weaker type.
   */
  mmgClaimMismatchAt: Date | string | null;
}

/** [F-103-01] Why the door refuses a disputed MMG order — one stable code the client renders. */
export const MMG_CLAIM_MISMATCH_BLOCK = 'MMG_CLAIM_MISMATCH';
/** [F-103-01] The projection forgot the column. Fail closed and say which. */
export const MMG_MISMATCH_UNKNOWN_BLOCK = 'MMG_MISMATCH_UNKNOWN';
/**
 * [F-106-04] A dispute marker on a rail that cannot carry one. The canonical
 * fulfilment gate returns early for non-MMG orders, so calling this a customer
 * MMG dispute would make the two gates say different things about the same row
 * — and would tell the rider a story about a payment dispute that cannot exist
 * on their order. It is a corrupt state: refused, and named as what it is.
 */
export const PAYMENT_STATE_INCONSISTENT_BLOCK = 'PAYMENT_STATE_INCONSISTENT';

/**
 * [F-106-01] THE POLICY THIS AUTHORITY WAS COMPUTED UNDER.
 *
 * A client cannot tell a correct authority from one produced by a server that
 * predates the dispute rule — both are syntactically valid, and the older one
 * will happily say DELIVER_NO_CASH on a disputed order. During any rollout
 * where both servers are reachable, or where a cached payload survives an
 * update, that is the same open door by another route.
 *
 * So the authority carries the policy that produced it, and the client refuses
 * one it does not recognise. Bump this whenever the door's RULES change, never
 * for a refactor.
 */
export const HANDOVER_POLICY = 'mismatch-1';

export function paymentRailOf(paymentMethod: string): PaymentRail {
  if (paymentMethod === 'CASH') return 'CASH';
  if (paymentMethod === 'MOBILE_MONEY') return 'MOBILE_MONEY';
  return 'OTHER';
}

/**
 * A short digest of (order, custody state, payment state, DISPUTE GENERATION,
 * last write) — the door's version.
 *
 * [F-103-01] The dispute is in the digest, not merely implied by `updatedAt`.
 * Codex asked for the version to be bound to the mismatch generation rather
 * than to a proxy: a screen loaded before a dispute committed must be refused
 * on its own terms, whatever a clock or a same-millisecond write does.
 */
export function handoverVersionFor(order: Pick<HandoverOrderLike, 'id' | 'status' | 'paymentStatus' | 'updatedAt' | 'mmgClaimMismatchAt'>): string {
  const at = order.updatedAt instanceof Date ? order.updatedAt.getTime() : Date.parse(String(order.updatedAt));
  const dispute = mismatchGenerationOf(order.mmgClaimMismatchAt);
  return createHash('sha256').update(`${order.id}|${order.status}|${order.paymentStatus}|${dispute}|${Number.isFinite(at) ? at : 'x'}`).digest('hex').slice(0, 16);
}

/** `none`, `unknown` (the projection forgot it), or the exact instant of the dispute. */
function mismatchGenerationOf(value: Date | string | null | undefined): string {
  if (value === undefined) return 'unknown';
  if (value === null) return 'none';
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(at) ? String(at) : 'unparseable';
}

export function handoverAuthorityFor(order: HandoverOrderLike): HandoverAuthority {
  const rail = paymentRailOf(order.paymentMethod);
  const base = {
    policy: HANDOVER_POLICY,
    rail,
    paymentState: order.paymentStatus,
    custodyState: order.status,
    amount: Number(order.totalAmount),
    currency: order.currencyCode ?? 'GYD',
    version: handoverVersionFor(order),
  };
  // [F-103-01] THE DISPUTE IS CHECKED BEFORE THE DOOR OPENS.
  //
  // This branch used to sit below the CLAIMED one, which is to say it did not
  // exist. An order that was MOBILE_MONEY + CLAIMED + disputed was served
  // `DELIVER_NO_CASH` — the server telling the person at the door to hand the
  // goods over on a payment the customer says never happened. The canonical
  // status write refuses afterwards, but nothing can un-hand food already
  // given to a customer because the server said the door was open.
  //
  // `undefined` means a projection forgot the column. That is a programming
  // error, but a THROW here would take down the rider's active-order screen;
  // the door's fail-closed answer is to refuse and be counted, and the
  // required field above is what actually stops it reaching production.
  const generation = mismatchGenerationOf(order.mmgClaimMismatchAt);
  // [F-106-04] Rail-scoped, to agree with the canonical gate. A dispute marker
  // on a CASH or CARD order is not a customer MMG dispute — it is a state that
  // should not exist. Still refused (never hand over on a corrupt payment row),
  // but named honestly rather than dressed as a dispute the rider cannot chase.
  if (rail !== 'MOBILE_MONEY') {
    // `unknown` is not interesting here: this rail's door never depended on the
    // column, so an unprojected one must not close a cash door. A marker that
    // is genuinely PRESENT on a non-MMG order is the corrupt state.
    if (generation !== 'none' && generation !== 'unknown') {
      return { ...base, permitted: 'BLOCKED', blockReason: PAYMENT_STATE_INCONSISTENT_BLOCK };
    }
  } else {
    if (generation === 'unknown') return { ...base, permitted: 'BLOCKED', blockReason: MMG_MISMATCH_UNKNOWN_BLOCK };
    if (generation !== 'none') return { ...base, permitted: 'BLOCKED', blockReason: MMG_CLAIM_MISMATCH_BLOCK };
  }
  // CAPTURED (provider evidence) or CLAIMED (the store's own word on its own wallet, §31.5): the door opens without cash.
  if (order.paymentStatus === 'CAPTURED' || order.paymentStatus === 'CLAIMED') return { ...base, permitted: 'DELIVER_NO_CASH', blockReason: null };
  if (rail === 'CASH') return { ...base, permitted: 'COLLECT_CASH_THEN_DELIVER', blockReason: null };
  // A non-cash rail whose money has not landed: the door is closed until it does.
  return { ...base, permitted: 'BLOCKED', blockReason: `${rail}_${order.paymentStatus}` };
}

/** True when the client's echoed version names the order's current state. */
export function handoverVersionMatches(order: Pick<HandoverOrderLike, 'id' | 'status' | 'paymentStatus' | 'updatedAt' | 'mmgClaimMismatchAt'>, echoed: string | undefined | null): boolean {
  if (echoed === undefined || echoed === null) return true; // an older client that does not echo is not refused for it
  return echoed === handoverVersionFor(order);
}
