// ---------------------------------------------------------------------------
// Handover verification security [HND — engagement #7].
//
// Swift proves a handover with a short numeric code the CUSTOMER holds and the
// counterparty enters: the taxi ride PIN (driver verifies), the delivery PIN
// (rider verifies), the pickup code (vendor verifies). A short code is only
// safe if guessing it is rate-limited — otherwise the ~10^6 space is trivially
// brute-forced by an automated client. The taxi ride-PIN path already locks
// out after N tries; this is the shared rule so every handover path enforces
// the SAME lockout instead of each re-implementing (or forgetting) it.
// ---------------------------------------------------------------------------

/** Max wrong tries before a handover code locks and must go to support. */
export const MAX_HANDOVER_ATTEMPTS = 5;

/**
 * The other half of the rule above: a rate limit only matters if the verifier
 * doesn't already HAVE the code. Per the header — the driver verifies the ride
 * PIN, the rider verifies the delivery PIN, the vendor verifies the pickup code
 * — so none of those three may ever READ the value they check.
 *
 * Spread into every rider- and driver-facing order serialization. The one path
 * that genuinely needs a code fetches it explicitly at the comparison site
 * (see vendor complete-pickup, driver verify-pin, rider delivered).
 *
 * [F-0011] Before this existed, `claimOrder` and six driver endpoints returned
 * the full order row, so a driver could read the PIN out of their own accept
 * response and start a ride with nobody in the car. Asserted by
 * __tests__/handover-secrets.test.ts against serialized response bodies.
 */
// NOTE: deliberately NOT `as const`. A readonly literal makes Prisma's `omit`
// generic fall back to an index signature, which silently degrades every
// downstream result type to `string | number | Decimal | ... | undefined`.
// Plain `true` literals keep inference exact.
export const HANDOVER_SECRETS_OMIT: { ridePin: true; pickupCode: true; pickupCodeAttempts: true } = {
  ridePin: true,
  pickupCode: true,
  pickupCodeAttempts: true,
};

/**
 * Given how many wrong tries a code has ALREADY taken, decide the next verify.
 * `locked` — refuse before comparing (the budget is spent).
 * `remaining` — tries left AFTER consuming this one (for the "N left" message),
 * mirroring the ride-PIN path's `MAX - attempts - 1`.
 */
export function handoverAttemptState(
  currentAttempts: number,
  max: number = MAX_HANDOVER_ATTEMPTS,
): { locked: boolean; remaining: number } {
  const locked = currentAttempts >= max;
  const remaining = Math.max(0, max - currentAttempts - 1);
  return { locked, remaining };
}
