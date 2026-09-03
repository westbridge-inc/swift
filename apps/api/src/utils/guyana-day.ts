import { GUYANA_TZ } from '../modules/prep/prep-time';

// ---------------------------------------------------------------------------
// A DAY IN GUYANA IS NOT A DAY IN UTC.
//
// An operator types a promo window as two dates — "4 September" to
// "4 October" — and `z.coerce.date()` reads a bare `YYYY-MM-DD` as UTC
// midnight. Guyana is UTC−4 and does not observe daylight saving, so:
//
//   validFrom  "2026-09-04" → 2026-09-04T00:00Z → live from 8pm on the 3rd
//   validUntil "2026-10-04" → 2026-10-04T00:00Z → DEAD at 8pm on the 3rd
//
// The promo starts four hours early and dies four hours early — and those four
// hours are the evening, which is when people order. A code advertised as
// running "until the 4th" stops working on the 3rd while the customer is
// looking at it.
//
// These read a date-only string as the day the person meant, in the country the
// platform operates in. A full timestamp is respected as given: an operator who
// specifies an instant has said something more precise than a day.
//
// The offset is READ from the zone, never hard-coded: `America/Guyana` is
// UTC−4 with no DST today, and a constant would be a lie the day that changes.
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC offset of `America/Guyana` at a given instant, in minutes. */
function guyanaOffsetMinutes(at: Date): number {
  // Format the instant as Guyana wall-clock, read it back as if it were UTC,
  // and the difference IS the offset — no table, no assumption.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GUYANA_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant a Guyanese wall-clock time corresponds to. */
function guyanaWallClockToInstant(y: number, m: number, d: number, hh: number, mm: number, ss: number, ms: number): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  // One correction is enough for a fixed-offset zone, and a second settles any
  // zone that shifts, because the offset is re-read at the corrected instant.
  let instant = new Date(naive - guyanaOffsetMinutes(new Date(naive)) * 60_000);
  instant = new Date(naive - guyanaOffsetMinutes(instant) * 60_000);
  return instant;
}

/** True when the value is a bare `YYYY-MM-DD`, i.e. a DAY and not an instant. */
export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value.trim());
}

/** The first instant of that calendar day in Guyana. */
export function startOfGuyanaDay(dateOnly: string): Date {
  const [y, m, d] = dateOnly.trim().split('-').map(Number) as [number, number, number];
  return guyanaWallClockToInstant(y, m, d, 0, 0, 0, 0);
}

/** The LAST instant of that calendar day in Guyana — the day the person meant
 *  includes its own evening. */
export function endOfGuyanaDay(dateOnly: string): Date {
  const [y, m, d] = dateOnly.trim().split('-').map(Number) as [number, number, number];
  return guyanaWallClockToInstant(y, m, d, 23, 59, 59, 999);
}
