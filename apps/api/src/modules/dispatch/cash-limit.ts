/**
 * [O1 · owner ruling 5 Nov 2026 05:00Z] "Rider cash limit OPEN, no cap; the business decides on huge orders; riders
 * choose." No cap is stored as THIS whole-dollar value in every float column (CountryConfig.floatL1/L2/L3 and
 * Rider.floatLimit), never Infinity, NaN or null:
 *  - it fits DECIMAL(12,2) (at most 9,999,999,999.99) with room, and committedFloat can never pass it (the guarded
 *    commit below keeps committed <= limit), so no write can overflow;
 *  - it stays below 2^31, so the batch planner's integer capacity (Math.round(availableFloat)) is exact;
 *  - every gate (dispatch SQL, the claim's guarded commit, the board grab, the stacking rule R4, the checkout probe)
 *    keeps its own arithmetic and simply always passes.
 * Words never show this number: isNoCashLimit() turns it into "no limit" on every surface.
 */
export const RIDER_CASH_NO_LIMIT = 1_000_000_000;

/** Is this float limit the ruled "no cap"? Anything at or above RIDER_CASH_NO_LIMIT is shown as no limit. */
export function isNoCashLimit(limit: { toString(): string } | number | string | null | undefined): boolean {
  const n = Number(limit);
  return Number.isFinite(n) && n >= RIDER_CASH_NO_LIMIT;
}

/**
 * [O1] The most cash a rider may take on from the OPEN BOARD without the app having shown the amount (an older app
 * sends none). It is the L1 limit those apps were built under, so an older app keeps exactly the board it had; above
 * it the grab is refused with the amount in words, and the rider takes it from the offer card, which shows it. Never
 * a limit on what a rider may carry: an app that shows the amount and sends it back has none.
 */
export const BOARD_GRAB_UNSHOWN_CASH_MAX = 8000;
