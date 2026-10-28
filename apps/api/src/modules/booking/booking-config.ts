import { toMinutes } from './availability';

// ---------------------------------------------------------------------------
// [BOOK-S1] What a business may save as a listing's booking settings.
//
//  - Opening times on one day may not overlap: two overlapping windows make two
//    overlapping slot grids, so one person is offered 09:00 and 09:30 for a
//    60-minute service at once. Back to back (09:00–12:00, 12:00–17:00) is fine.
//  - The gap after each booking (bufferMinutes) and the minimum notice
//    (minNoticeMinutes) are the business's to set. An app that does not know
//    them (build 9 and every build before this one) saves without them; the
//    save keeps what is stored instead of erasing it. An explicit value,
//    0 included, replaces it.
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface BookingWindow {
  dayOfWeek: number;
  start: string;
  end: string;
}

/** The first pair of same-day windows that overlap, or null. A window that
 *  ends at or before it starts is empty and overlaps nothing. */
export function overlappingWindows(slots: readonly BookingWindow[]): [BookingWindow, BookingWindow] | null {
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const a = slots[i]!;
      const b = slots[j]!;
      if (a.dayOfWeek !== b.dayOfWeek) continue;
      if (toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end)) return [a, b];
    }
  }
  return null;
}

/** The refusal the business reads. */
export function overlappingWindowsMessage([a, b]: [BookingWindow, BookingWindow]): string {
  return `Two opening times on ${DAY_NAMES[a.dayOfWeek] ?? 'one day'} overlap (${a.start}–${a.end} and ${b.start}–${b.end}). Join them into one, or change one so they do not overlap.`;
}

/** Booking settings an older app does not send: kept from the stored config when absent. */
export const BOOKING_CONFIG_KEPT_FIELDS = ['bufferMinutes', 'minNoticeMinutes'] as const;

/** The config to store for a save: the incoming one, plus every kept field the
 *  save did not mention, taken from what is stored. */
export function mergeBookingConfig(stored: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };
  const previous = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  for (const field of BOOKING_CONFIG_KEPT_FIELDS) {
    if (merged[field] === undefined && previous[field] !== undefined) merged[field] = previous[field];
  }
  return merged;
}
