// Ad week math (ads-platform spec §7.1). A "week" is Monday 00:00 → Sunday
// 23:59 in the tenant's weekTimezone; every week column stores the Monday as a
// DATE. One shared helper so availability, reservation, and the lifecycle cron
// all agree on which Monday a date belongs to — and the DB's ISODOW=1 CHECK
// constraint refuses anything else.
//
// Correctness across TZ/DST: we resolve the LOCAL calendar date via Intl (so a
// future non-Guyana tenant with DST is still correct), then do pure calendar
// weekday math on that date. Guyana itself is UTC-4 year-round.

const DAY_MS = 86_400_000;

/** The tenant-local calendar date (Y-M-D) of an instant, DST-correct. */
function localYmd(instant: Date, tz: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), mo: get('month'), d: get('day') };
}

/** The Monday (as a UTC-midnight Date whose Y-M-D IS the Monday, ready for a
 *  @db.Date column) of the tenant-local week containing `instant`. */
export function mondayOf(instant: Date, tz = 'America/Guyana'): Date {
  const { y, mo, d } = localYmd(instant, tz);
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  const dow = asUtc.getUTCDay(); // 0=Sun .. 6=Sat
  const deltaToMonday = dow === 0 ? -6 : 1 - dow;
  asUtc.setUTCDate(asUtc.getUTCDate() + deltaToMonday);
  return asUtc;
}

/** The Monday of a CALENDAR date (a @db.Date value that is already a UTC-
 *  midnight day) — pure UTC weekday math, NO timezone shift. Use this for
 *  stored week columns and advertiser-picked range bounds; use mondayOf() only
 *  for a genuine instant (e.g. `new Date()` when a cron needs "this week"). */
export function mondayOfDate(date: Date): Date {
  const asUtc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = asUtc.getUTCDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  asUtc.setUTCDate(asUtc.getUTCDate() + delta);
  return asUtc;
}

/** True when `date` (a @db.Date value) falls on a Monday — matches the DB CHECK. */
export function isMonday(date: Date): boolean {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).getUTCDay() === 1;
}

/** Every Monday from startWeek to endWeek inclusive (both must already be
 *  Mondays). Throws if start > end or either isn't a Monday. */
export function weeksBetween(startWeek: Date, endWeek: Date): Date[] {
  if (!isMonday(startWeek) || !isMonday(endWeek)) {
    throw new Error('weeksBetween: both bounds must be Mondays');
  }
  const start = Date.UTC(startWeek.getUTCFullYear(), startWeek.getUTCMonth(), startWeek.getUTCDate());
  const end = Date.UTC(endWeek.getUTCFullYear(), endWeek.getUTCMonth(), endWeek.getUTCDate());
  if (end < start) throw new Error('weeksBetween: endWeek precedes startWeek');
  const weeks: Date[] = [];
  for (let t = start; t <= end; t += 7 * DAY_MS) weeks.push(new Date(t));
  return weeks;
}

/** Inclusive week count. */
export function weekCount(startWeek: Date, endWeek: Date): number {
  return weeksBetween(startWeek, endWeek).length;
}

/** The UTC instant of tenant-local midnight on a stored Monday — the moment a
 *  week actually begins. Guyana is UTC-4 (offset −240 min, no DST); crons that
 *  need hour precision (the auto-cancel cutoff) use this rather than the
 *  date-only column. offsetMinutes = local − UTC. */
export function weekStartInstant(weekStart: Date, offsetMinutes = -240): Date {
  const utcMidnight = Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate());
  return new Date(utcMidnight - offsetMinutes * 60_000);
}
