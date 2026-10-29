// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-4] ONE WAY TO WRITE A DATE IN THE CONSOLE.
//
// Pages printed dates in the browser's locale and zone: Subscribers said
// "trial → 11/10/2026" (10 Nov or 11 Oct?), order detail "10/27/2026, 2:56:21
// PM", while Support, Ops alerts and the Audit log said "27 Oct 2026, 15:04".
// Every date the console shows is now written here: day first, the month in
// words, in Guyana time (America/Guyana), whatever the reader's browser is set
// to. A value that is not a date prints an em-dash: a wrong date is a lie, a
// missing one is only missing.
//
// A bare calendar day the server sends as YYYY-MM-DD (a revenue bucket) is not
// an instant: gyCalendarDay prints exactly the three fields the server sent.
// ---------------------------------------------------------------------------

export const GUYANA_TIME_ZONE = 'America/Guyana';

type DateInput = string | number | Date | null | undefined;

function instant(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: GUYANA_TIME_ZONE, ...options });
const DAY = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const DAY_TIME = fmt({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const TIME = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const LONG_DAY = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const CALENDAR_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

/** A value at exactly 00:00:00.000 UTC is a calendar day the server stored as a date (a document's typed expiry is
 *  sent as `new Date('2028-06-30').toISOString()`), not a moment: in Guyana time it would print the day before. */
const isCalendarDay = (d: Date) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

/** "10 Nov 2026": the Guyana day of a moment; the stored day of a calendar date (UTC midnight). */
export const gyDate = (value: DateInput): string => {
  const d = instant(value);
  if (!d) return '—';
  return isCalendarDay(d) ? CALENDAR_DAY.format(d) : DAY.format(d);
};
/** "27 Oct 2026, 15:04" */
export const gyDateTime = (value: DateInput): string => { const d = instant(value); return d ? DAY_TIME.format(d) : '—'; };
/** "15:04" */
export const gyTime = (value: DateInput): string => { const d = instant(value); return d ? TIME.format(d) : '—'; };
/** "Tuesday 27 October 2026" — the Today page's heading. */
export const gyLongDate = (value: DateInput): string => { const d = instant(value); return d ? LONG_DAY.format(d) : '—'; };
/** A Guyana calendar day the server sent as "YYYY-MM-DD" (DASH-06 buckets): "23 Aug 2026" in every zone. Anchored at
 *  UTC midnight and printed in UTC, so the day printed is the day sent. Anything else is an em-dash. */
export const gyCalendarDay = (ymd: unknown): string =>
  typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? CALENDAR_DAY.format(new Date(`${ymd}T00:00:00Z`)) : '—';

const YMD_PARTS = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
/** [REVIEW-F #2155 S4-b] Today in Guyana, `plusDays` on, as a date input's value ("2026-10-27"). Cut from the UTC
 *  clock (toISOString().slice(0, 10)) it is already tomorrow from 20:00 Guyana time. Guyana keeps UTC-4 all year,
 *  so whole days added to the moment land on whole Guyana days. */
export const gyTodayYmd = (now: Date = new Date(), plusDays = 0): string => {
  const parts = YMD_PARTS.formatToParts(new Date(now.getTime() + plusDays * 86_400_000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
