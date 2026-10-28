import { toMinutes } from './availability';

// ---------------------------------------------------------------------------
// [BOOK-S1] What a business may save as a listing's booking settings.
//
//  - Opening times on one day may not overlap: two overlapping windows make two
//    overlapping slot grids, so one person is offered 09:00 and 09:30 for a
//    60-minute service at once. Back to back (09:00–12:00, 12:00–17:00) is fine.
//    A NEW overlap is refused. A listing saved before this rule may already
//    store overlapping windows; a save that sends those stored windows again
//    (an unchanged config, from any app build) is accepted and the overlapping
//    ones are joined into one (normaliseWindows) — it is never refused.
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

const windowKey = (w: BookingWindow) => `${w.dayOfWeek}|${w.start}|${w.end}`;

/** Join every group of same-day windows that overlap into one window (their
 *  union); windows that do not overlap any other are left exactly as sent.
 *  Ordered by day, then start. */
export function joinOverlappingWindows(slots: readonly BookingWindow[]): BookingWindow[] {
  const out: BookingWindow[] = [];
  for (let day = 0; day <= 6; day += 1) {
    const sorted = slots.filter((w) => w.dayOfWeek === day).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (const w of sorted) {
      const last = out[out.length - 1];
      if (last && last.dayOfWeek === day && toMinutes(w.start) < toMinutes(last.end) && toMinutes(last.start) < toMinutes(w.end)) {
        if (toMinutes(w.end) > toMinutes(last.end)) out[out.length - 1] = { ...last, end: w.end };
      } else {
        out.push({ dayOfWeek: w.dayOfWeek, start: w.start, end: w.end });
      }
    }
  }
  return out;
}

/** [BOOK-S1 · REVIEW-M S4-3] The windows to store for a save. No overlap: as
 *  sent. An overlap made only of windows the listing already stores (an older
 *  listing, saved again unchanged): joined, never refused. An overlap that
 *  involves a window the save adds: refused with that pair. */
export function windowsForSave(
  incoming: readonly BookingWindow[],
  stored: unknown,
): { ok: true; slots: BookingWindow[] } | { ok: false; pair: [BookingWindow, BookingWindow] } {
  if (!overlappingWindows(incoming)) return { ok: true, slots: [...incoming] };
  const storedSlots = (stored as { slots?: unknown } | null | undefined)?.slots;
  const known = new Set(Array.isArray(storedSlots) ? (storedSlots as BookingWindow[]).map(windowKey) : []);
  for (let i = 0; i < incoming.length; i += 1) {
    for (let j = i + 1; j < incoming.length; j += 1) {
      const pair: [BookingWindow, BookingWindow] = [incoming[i]!, incoming[j]!];
      if (overlappingWindows(pair) && !(known.has(windowKey(pair[0])) && known.has(windowKey(pair[1])))) return { ok: false, pair };
    }
  }
  return { ok: true, slots: joinOverlappingWindows(incoming) };
}
