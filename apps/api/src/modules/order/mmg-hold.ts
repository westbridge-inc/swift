import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-108-01] ONE DECISION: "MAY THIS MMG ORDER MOVE?"
//
// The marketplace MMG contract is payment-first. Until the store's claim or a
// provider capture lands, no rider may accept, prepare, ready, claim or be
// assigned the order — and if the two parties disagree about that payment, it
// is held until a person resolves it.
//
// Both facts were enforced at the ASSIGNMENT seam and nowhere else. So the
// engine happily advertised a payment-pending MMG order: a card was installed,
// `dispatch:offer` published, the board listed it, the demand map counted its
// fee as money waiting — and the first rider to act was refused with
// MMG_PAYMENT_PENDING. My previous patch closed that loop for a DISPUTE and
// left the far commoner case, an unpaid one, wide open. Codex found it, and
// found the transition that manufactures it in production: an admin resolving
// a dispute as CUSTOMER_DID_NOT_PAY sets paymentStatus back to PENDING while
// the order stays ACCEPTED/PREPARING/READY_FOR_PICKUP.
//
// So the decision lives HERE, once, in two shapes that must agree:
//
//   * `mmgFulfilmentHold(order)` — the pure answer, for code holding a row;
//   * `NOT_MMG_HELD` — the same answer as a Prisma filter, for code asking the
//     database which rows are offerable.
//
// `mmg-hold-parity.test.ts` proves the two agree over EVERY combination of
// rail, payment state and mismatch, against a real database. A predicate and a
// filter that drift apart is exactly how "held" came to mean two things.
// ---------------------------------------------------------------------------

/** Payment states in which MMG money has actually moved. */
export const MMG_MONEY_MOVED: ReadonlySet<string> = new Set(['CAPTURED', 'CLAIMED']);

/** Why an MMG order may not move. A closed set — each reason has its own error and its own counter. */
export type MmgHoldReason = 'mismatch' | 'payment_pending';

export interface MmgHoldSubject {
  paymentMethod: string | null;
  paymentStatus: string;
  orderType: string | null;
  /** REQUIRED. `undefined` means a projection forgot it, which is never a passing gate. */
  mmgClaimMismatchAt: Date | null;
}

/**
 * The hold on this order, or null if it may move.
 *
 * Scope, stated explicitly because two gates once disagreed about it:
 *   * a non-MMG rail is never held here — CASH and CARD have their own rules;
 *   * TAXI is out of scope by design (the MMG store-payment contract is a
 *     marketplace-order contract; a ride settles at the kerb);
 *   * a dispute outranks an unlanded payment, because it is the fact a person
 *     must resolve rather than one the store can simply fix.
 */
export function mmgFulfilmentHold(order: MmgHoldSubject): MmgHoldReason | null {
  if (order.paymentMethod !== 'MOBILE_MONEY') return null;
  if (order.orderType === 'TAXI') return null;
  if (order.mmgClaimMismatchAt === undefined) {
    throw new Error('mmgFulfilmentHold: mmgClaimMismatchAt was not projected — the hold cannot be evaluated');
  }
  if (order.mmgClaimMismatchAt !== null) return 'mismatch';
  if (!MMG_MONEY_MOVED.has(order.paymentStatus)) return 'payment_pending';
  return null;
}

/** True when this order is held for a person and must not be advertised, offered or counted. */
export function isMmgHeld(order: MmgHoldSubject): boolean {
  return mmgFulfilmentHold(order) !== null;
}

/**
 * The SAME rule as a Prisma filter: rows that are NOT held.
 *
 * Written as the negation of the predicate, term for term:
 *   held  ==  MMG rail  AND  not TAXI  AND  (mismatch present OR money not moved)
 *
 * `Order.paymentMethod` is NOT NULL in the schema, so `not` is safe here — a
 * three-valued-logic hole would need a nullable column. The predicate's own
 * parameter type stays `string | null` because callers project from places the
 * schema does not constrain, and there `!== 'MOBILE_MONEY'` is the safe read.
 * The parity test covers every row this database can actually hold.
 */
export const NOT_MMG_HELD: Prisma.OrderWhereInput = {
  OR: [
    { paymentMethod: { not: 'MOBILE_MONEY' } },
    { orderType: 'TAXI' },
    {
      AND: [
        { mmgClaimMismatchAt: null },
        { paymentStatus: { in: ['CAPTURED', 'CLAIMED'] } },
      ],
    },
  ],
};
