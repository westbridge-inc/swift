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

import { createHash, timingSafeEqual } from 'node:crypto';

/** Five failed comparisons exhaust the proof budget. Pickup counts its
 * successful comparison too, then becomes terminal; delivery counts failures.
 * Check and consume under the canonical Order lock. A wrong result commits
 * before reporting its error, and a correct sixth guess remains refused.
 * Only support recovery may reset an exhausted budget; ordinary retries never do. */
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
//
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The store's committed MMG destination rides the same list: the MMG
// NUMBER (and the dormant pay link) is shown ONLY to that order's customer, by the customer order read's own
// explicit projection, and only after the store accepts. A wholesale row serialisation (a mover's job, a
// claim answer, a socket payload) never carries it.
export const HANDOVER_SECRETS_OMIT: {
  ridePin: true; pickupCode: true; pickupCodeAttempts: true; mmgNumberSnapshot: true; mmgPayUrlSnapshot: true;
} = {
  ridePin: true,
  pickupCode: true,
  pickupCodeAttempts: true,
  mmgNumberSnapshot: true,
  mmgPayUrlSnapshot: true,
};

/**
 * [Row 207] THE comparison of a handover code (taxi ride PIN, delivery PIN,
 * pickup code) with a guess. Both sides are hashed to fixed-length digests and
 * compared with timingSafeEqual, so neither how much of a guess is right nor
 * its length changes the time taken. A missing or empty secret never matches.
 * Every handover path calls this; never write a second comparison.
 */
export function handoverCodeMatches(secret: string | null | undefined, guess: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const matches = timingSafeEqual(digest(secret ?? ''), digest(guess));
  return matches && typeof secret === 'string' && secret.length > 0;
}

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

/**
 * [A-15] What a support surface may know about a handover code: THAT one
 * exists and how much guessing budget is left — never the value.
 *
 * The admin console used to render the pickup code on the order list and the
 * order detail, which collapsed the holder and the verifier into one role: an
 * operator (or anyone reading over their shoulder, a screen share, a
 * screenshot, a compromised session) could complete a stranger's pickup. The
 * value now leaves the general admin DTO entirely and this derived status
 * takes its place, so the console can still answer "is a code set?" and "is
 * this order locked out?" without holding the secret.
 */
export interface HandoverStatus {
  /** a pickup code exists on this order (the customer holds it) */
  pickupCodeIssued: boolean;
  /** a ride PIN exists on this order */
  ridePinIssued: boolean;
  /** wrong tries already spent */
  attempts: number;
  /** the guessing budget is spent — verification refuses until support intervenes */
  locked: boolean;
  /** tries left after the next one */
  remaining: number;
  /** [MKT-F057] Wrong delivery-PIN tries so far, and whether the door is locked (support reset). */
  ridePinAttempts: number;
  ridePinLocked: boolean;
}

export function handoverStatus(
  row: { pickupCode?: string | null; ridePin?: string | null; pickupCodeAttempts?: number | null; ridePinAttempts?: number | null },
  max: number = MAX_HANDOVER_ATTEMPTS,
): HandoverStatus {
  const attempts = row.pickupCodeAttempts ?? 0;
  const { locked, remaining } = handoverAttemptState(attempts, max);
  // [MKT-F057] The delivery PIN keeps its own budget; support must see ITS lockout,
  // not the pickup code's, before reaching for the reset.
  const pinAttempts = row.ridePinAttempts ?? 0;
  const pin = handoverAttemptState(pinAttempts, max);
  return {
    pickupCodeIssued: typeof row.pickupCode === 'string' && row.pickupCode.length > 0,
    ridePinIssued: typeof row.ridePin === 'string' && row.ridePin.length > 0,
    attempts,
    locked,
    remaining,
    ridePinAttempts: pinAttempts,
    ridePinLocked: pin.locked,
  };
}
