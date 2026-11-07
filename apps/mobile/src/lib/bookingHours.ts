// ---------------------------------------------------------------------------
// [BOOK-S5a · owner A4/C1/C2 28 Oct 2026] A bookable service's settings as the
// partner app edits them: hours per day (more than one window a day, so a lunch
// break is a gap between two windows), the gap after each booking, the minimum
// notice, and "Confirm bookings automatically".
//
// The server is the judge (vendor.routes bookingConfig, booking-config.ts): it
// refuses overlapping windows on one day in its own words, keeps what an older
// app does not send, and refuses "confirm automatically" while the switch is
// off. This module only keeps the editor honest before the save: it never
// flattens a listing's per-day hours into one, and it says plainly what is
// wrong with a time before sending it.
// ---------------------------------------------------------------------------

export interface HoursWindow { start: string; end: string }
/** Seven days, Sunday first (dayOfWeek 0..6); an empty day is closed. */
export type WeekHours = HoursWindow[][];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** A new bookable service: Monday to Friday, 09:00 to 17:00. */
export function newListingHours(): WeekHours {
  return Array.from({ length: 7 }, (_, d) => (d >= 1 && d <= 5 ? [{ start: '09:00', end: '17:00' }] : []));
}

/** The listing's stored windows, per day, in time order. Every stored window is
 *  kept (the old editor applied the first window's times to every day). */
export function weekHoursFromSlots(slots: unknown): WeekHours {
  const week: WeekHours = Array.from({ length: 7 }, () => []);
  if (!Array.isArray(slots) || slots.length === 0) return newListingHours();
  for (const s of slots) {
    const w = s as { dayOfWeek?: unknown; start?: unknown; end?: unknown };
    if (typeof w.dayOfWeek !== 'number' || w.dayOfWeek < 0 || w.dayOfWeek > 6) continue;
    if (typeof w.start !== 'string' || typeof w.end !== 'string') continue;
    week[w.dayOfWeek]!.push({ start: w.start, end: w.end });
  }
  for (const day of week) day.sort((a, b) => a.start.localeCompare(b.start));
  return week;
}

/** The wire windows for a save, Sunday first, each day in time order. */
export function slotsFromWeekHours(week: WeekHours): Array<{ dayOfWeek: number; start: string; end: string }> {
  return week.flatMap((day, dayOfWeek) =>
    [...day].sort((a, b) => a.start.localeCompare(b.start)).map((w) => ({ dayOfWeek, start: w.start.trim(), end: w.end.trim() })));
}

/** What is wrong with the hours, in plain words, or null. Back to back
 *  (09:00–12:00 and 12:00–17:00) is fine, as on the server. */
export function weekHoursProblem(week: WeekHours): string | null {
  if (!week.some((day) => day.length > 0)) return 'Pick at least one day with hours.';
  for (let d = 0; d < 7; d += 1) {
    const day = (week[d] ?? []).map((w) => ({ start: w.start.trim(), end: w.end.trim() }));
    for (const w of day) {
      if (!HHMM.test(w.start) || !HHMM.test(w.end)) return `On ${DAY_NAMES[d]}, write times as HH:MM, like 09:00.`;
      if (toMin(w.start) >= toMin(w.end)) return `On ${DAY_NAMES[d]}, ${w.start}–${w.end} must start before it ends.`;
    }
    const sorted = [...day].sort((a, b) => toMin(a.start) - toMin(b.start));
    for (let i = 1; i < sorted.length; i += 1) {
      if (toMin(sorted[i]!.start) < toMin(sorted[i - 1]!.end)) {
        return `On ${DAY_NAMES[d]}, ${sorted[i - 1]!.start}–${sorted[i - 1]!.end} and ${sorted[i]!.start}–${sorted[i]!.end} overlap. Join them into one, or change one.`;
      }
    }
  }
  return null;
}

/** The window "Add hours" adds to a day: an hour after the day's last window
 *  ends, for two hours (kept inside the day); 09:00–17:00 on an empty day. */
export function nextWindow(day: HoursWindow[]): HoursWindow {
  const last = [...day].filter((w) => HHMM.test(w.end)).sort((a, b) => toMin(a.end) - toMin(b.end)).at(-1);
  if (!last) return { start: '09:00', end: '17:00' };
  const start = Math.min(toMin(last.end) + 60, 22 * 60);
  return { start: fromMin(start), end: fromMin(Math.min(start + 120, 23 * 60 + 59)) };
}

/** The gap after each booking, in minutes (the server allows up to 240). */
export const BUFFER_CHOICES = [0, 5, 10, 15, 30, 60] as const;
/** The minimum notice, in minutes (owner C2: two hours for a new service). */
export const NOTICE_CHOICES = [0, 60, 120, 240, 1440] as const;

/** "None", "15 min", "1 hour", "2 hours", "1 day", "2 days". */
export function minutesLabel(minutes: number): string {
  if (minutes <= 0) return 'None';
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} min`;
}

/** The chips to offer: the standard choices, plus the stored value when it is
 *  not one of them (so a value set elsewhere is shown, never silently changed). */
export function choicesWith(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

const storedNumber = (config: unknown, field: string): number | null => {
  const v = config && typeof config === 'object' ? (config as Record<string, unknown>)[field] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
};

/** The editor's opening settings for a listing. `stored` is the listing's
 *  bookingConfig (null for a service that is not bookable yet); `instantAvailable`
 *  is the server's word that "Confirm bookings automatically" can be chosen. A
 *  new bookable service starts the way the server starts one while the switch
 *  is on (owner A4/C2): confirmed automatically, two hours' notice. */
export function openingBookingSettings(stored: unknown, instantAvailable: boolean): {
  instantBooking: boolean; bufferMinutes: number; minNoticeMinutes: number;
} {
  const isNew = !stored || typeof stored !== 'object' || Array.isArray(stored);
  const instantStored = !isNew && (stored as Record<string, unknown>)['instantBooking'] === true;
  return {
    instantBooking: instantAvailable && (isNew || instantStored),
    bufferMinutes: storedNumber(stored, 'bufferMinutes') ?? 0,
    minNoticeMinutes: storedNumber(stored, 'minNoticeMinutes') ?? (isNew && instantAvailable ? 120 : 0),
  };
}

/** The server's word on the profile that "Confirm bookings automatically" can be
 *  chosen (the INSTANT_BOOKING switch is on). Absent (an older server, the switch
 *  off): the setting is not shown and never sent. */
export function instantBookingAvailable(profile: unknown): boolean {
  return !!profile && typeof profile === 'object' && (profile as { instantBookingAvailable?: unknown }).instantBookingAvailable === true;
}
