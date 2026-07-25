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
