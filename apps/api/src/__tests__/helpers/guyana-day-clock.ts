import { guyanaDayKey, startOfGuyanaDay } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// A SUITE THAT COUNTS "TODAY" MUST NOT RUN ACROSS GUYANA MIDNIGHT.
//
// Some journeys seed an order "a minute ago" or move an order "five minutes"
// back, then read the store's counters for the GUYANA day. Run in the first
// minutes after Guyana midnight (04:00 UTC), the seeded time lands in the day
// before and the count reads 0; run just before it, the day can turn between
// seeding and reading. Production is right both times: the test's timing is
// not.
//
// The clock is NOT faked or shifted. These suites also run the checkout outbox,
// which claims rows by the database's own clock (CURRENT_TIMESTAMP) against an
// `availableAt` the server writes from the JS clock: a JS clock moved even an
// hour either way stalls due work or turns a retry backoff into a tight loop.
// So a suite that starts inside the window around Guyana midnight waits, in
// real time, until the window has passed — at most ten minutes, and only on
// the rare run that starts there. Its fixtures and assertions are unchanged.
// ---------------------------------------------------------------------------

/** Longer than either suite takes, so a run started before the window ends before midnight. */
export const GUYANA_MIDNIGHT_BEFORE_MS = 3 * 60_000;
/** Longer than the furthest either suite moves an order back (five minutes). */
export const GUYANA_MIDNIGHT_AFTER_MS = 7 * 60_000;
/** The hook timeout the wait needs (the longest wait, plus a minute). */
export const GUYANA_MIDNIGHT_WAIT_TIMEOUT_MS = GUYANA_MIDNIGHT_BEFORE_MS + GUYANA_MIDNIGHT_AFTER_MS + 60_000;

/** How long a suite starting at `now` must wait to be clear of Guyana
 *  midnight: 0 outside the window, else until the window after midnight ends. */
export function msUntilClearOfGuyanaMidnight(now: Date): number {
  const dayStart = startOfGuyanaDay(guyanaDayKey(now)).getTime();
  // The next day's start read from the zone (never "+ 24 h" by assumption).
  const nextDayStart = startOfGuyanaDay(guyanaDayKey(new Date(dayStart + 30 * 3_600_000))).getTime();
  const at = now.getTime();
  if (at - dayStart < GUYANA_MIDNIGHT_AFTER_MS) return dayStart + GUYANA_MIDNIGHT_AFTER_MS - at;
  if (nextDayStart - at <= GUYANA_MIDNIGHT_BEFORE_MS) return nextDayStart + GUYANA_MIDNIGHT_AFTER_MS - at;
  return 0;
}

/** Register FIRST: `beforeAll(waitClearOfGuyanaMidnight, GUYANA_MIDNIGHT_WAIT_TIMEOUT_MS)`. */
export async function waitClearOfGuyanaMidnight(): Promise<void> {
  const ms = msUntilClearOfGuyanaMidnight(new Date());
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}
