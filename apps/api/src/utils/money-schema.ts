import { z } from 'zod';

/**
 * SWIFT-103: client-supplied money is an integer in the platform's storage
 * unit — never a float. [M-36] That unit is MAJOR units (whole GYD today):
 * the schema was named "minor" while the business rule accepted whole GYD,
 * and a name that lies about units is how a value ends up 100× wrong at a
 * boundary. The unit is now in the name; the old names remain as aliases so
 * nothing compiles against a lie without knowing it.
 *
 * Use this for EVERY client-supplied amount / tip / fare / price so the
 * integer-major invariant holds by construction and new money inputs can't
 * silently reintroduce float drift. Fractional currencies would need a
 * per-currency schema derived from the exponent registry
 * (utils/currency-amount.ts) — none of the platform's markets prices in
 * fractions today.
 */
// ~GYD 100M (~USD 478k) — far above any real order, fare, or tip, but a hard
// ceiling against overflow / absurd injection. [REPORT-006 carryover] One
// unit BELOW the smallest money sink: Earning.amount and
// DeliveryCashSettlement.amount are Decimal(10,2) whose ceiling is
// 99,999,999.99 — an accepted 100,000,000 would overflow the settlement row
// it later creates.
export const MONEY_MAX_WHOLE = 99_999_999;

/** Non-negative integer MAJOR units (whole GYD), bounded. */
export const zMoneyWhole = z.number().int().min(0).max(MONEY_MAX_WHOLE);

/** @deprecated [M-36] the name lied about the unit — use zMoneyWhole. Same schema. */
export const zMoneyMinor = zMoneyWhole;
/** @deprecated [M-36] use MONEY_MAX_WHOLE. */
export const MONEY_MAX_MINOR = MONEY_MAX_WHOLE;
