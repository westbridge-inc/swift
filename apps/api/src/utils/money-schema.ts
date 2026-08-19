import { z } from 'zod';

/**
 * SWIFT-103: client-supplied money is integer MINOR UNITS — never a float.
 * Swift's currencies (GYD at launch) are whole-unit in practice, amounts are
 * stored as integers, and rounding belongs only at derivation seams, never at
 * intake. A fractional, non-finite, or absurd value from a client is a bug or
 * an attack, so reject it at the edge (rule #3: never trust client money).
 *
 * Use this for EVERY client-supplied amount / tip / fare / price so the
 * minor-units invariant holds by construction and new money inputs can't
 * silently reintroduce float drift.
 */
// ~GYD 100M (~USD 478k) — far above any real order, fare, or tip, but a hard
// ceiling against overflow / absurd injection. [REPORT-006 carryover] One
// minor unit BELOW the smallest money sink: Earning.amount and
// DeliveryCashSettlement.amount are Decimal(10,2) whose ceiling is
// 99,999,999.99 — an accepted 100,000,000 would overflow the settlement row
// it later creates.
export const MONEY_MAX_MINOR = 99_999_999;

/** Non-negative integer minor units, bounded. */
export const zMoneyMinor = z.number().int().min(0).max(MONEY_MAX_MINOR);
