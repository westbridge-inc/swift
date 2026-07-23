// ---------------------------------------------------------------------------
// Guyana-local day/week/month boundaries [SWIFT-DASH-06].
//
// "Today", "this week", "this month" on every MONEY dashboard must be the
// tenant's local day, not the server's. Node in a prod container defaults to
// UTC (no TZ pinned), so a naive `new Date(); setHours(0,0,0,0)` cuts the day
// at UTC midnight — 4 hours early for Guyana (UTC-4, no DST). For the last 4h
// of each Guyana day, orders/earnings then roll into "tomorrow" and today's
// totals read wrong. These helpers return the real UTC instant of the Guyana
// local boundary, so a `>= startOfDayGY()` filter selects the correct rows.
//
// (The busy-hours endpoint already applied this offset inline; this is that
// rule, shared, for the money boundaries.)
// ---------------------------------------------------------------------------

/** Guyana is UTC-4 year-round (no daylight saving). */
export const GUYANA_UTC_OFFSET_HOURS = -4;
const GY_OFFSET_MS = Math.abs(GUYANA_UTC_OFFSET_HOURS) * 60 * 60 * 1000;

/** Shift a real instant into "Guyana wall-clock expressed as a UTC-labeled
 *  Date", so the getUTC / setUTC accessors operate on Guyana-local fields. */
function toGyLocal(date: Date): Date {
  return new Date(date.getTime() - GY_OFFSET_MS);
}
/** Shift a Guyana-local-labeled Date back to the real UTC instant. */
function toUtc(local: Date): Date {
  return new Date(local.getTime() + GY_OFFSET_MS);
}

/** UTC instant of Guyana-local midnight for the given moment's Guyana day. */
export function startOfDayGY(date: Date = new Date()): Date {
  const l = toGyLocal(date);
  l.setUTCHours(0, 0, 0, 0);
  return toUtc(l);
}

/** UTC instant of Guyana-local Monday 00:00 for the given moment's week. */
export function startOfWeekGY(date: Date = new Date()): Date {
  const l = toGyLocal(date);
  const day = l.getUTCDay(); // 0=Sun..6=Sat
  const toMonday = day === 0 ? -6 : 1 - day;
  l.setUTCDate(l.getUTCDate() + toMonday);
  l.setUTCHours(0, 0, 0, 0);
  return toUtc(l);
}

/** UTC instant of Guyana-local 1st-of-month 00:00 for the given moment. */
export function startOfMonthGY(date: Date = new Date()): Date {
  const l = toGyLocal(date);
  l.setUTCDate(1);
  l.setUTCHours(0, 0, 0, 0);
  return toUtc(l);
}

/** `YYYY-MM-DD` of the Guyana-local day an instant falls in. Use this to bucket
 *  rows into day-labelled series, never `date.toISOString().slice(0,10)` —
 *  that keys by the UTC day, so an order at 21:00 GY (01:00 UTC next day) lands
 *  in tomorrow's bucket. [SWIFT-039] */
export function dayKeyGY(date: Date = new Date()): string {
  return toGyLocal(date).toISOString().slice(0, 10);
}
