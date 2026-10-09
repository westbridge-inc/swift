/**
 * [W5] A store's opening hours for the pickup panel, read the way the phone
 * app reads them (dayOfWeek 0 = Sunday), on Guyana's calendar day — the
 * store's day, whatever clock the customer's device keeps.
 */
export type OpeningHours = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function guyanaWeekday(now: Date = new Date()): number {
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Guyana' }).format(now);
  const day = WEEKDAYS.indexOf(short);
  return day >= 0 ? day : now.getUTCDay();
}

/** "Today 07:00 – 19:00", "Closed today", or null when the store published no hours. */
export function todayHours(hours: OpeningHours[] | null | undefined, now: Date = new Date()): string | null {
  if (!hours?.length) return null;
  const today = hours.find((h) => h.dayOfWeek === guyanaWeekday(now));
  if (!today || today.isClosed) return 'Closed today';
  return `Today ${today.openTime} – ${today.closeTime}`;
}
