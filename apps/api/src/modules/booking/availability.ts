import type { BookingConfig } from './booking.service';
import { formatGuyanaTime, guyanaWallClockParts, instantOfGuyanaWallClock } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// THE availability computation (scheduling spec law: "no double-source") —
// bookingConfig windows MINUS exceptions MINUS bookings, honoring buffers and
// lead time. Pure: the picker endpoint, reservation validation, the vendor
// calendar and reschedule all consume THIS, never their own arithmetic.
//
// Vendor windows are Guyana wall-clock fields. A candidate is converted once
// into a true instant; every wire and database slot uses that instant.
//
// [BOOK-S1] The bookings subtracted are EVERY live booking of the business,
// on any of its listings — the business is the resource, not the listing. A
// booking holds the business from its start to its end plus its listing's gap
// (bufferMinutes); a candidate needs the same span of its own. It fits while
// fewer than the business's capacity (default 1) are held at every moment of
// that span: hasRoom() is the ONE rule the picker, checkout, reservation and
// reschedule apply.
// ---------------------------------------------------------------------------

/** The longest gap after a booking a listing may set (vendor bookingConfig). */
export const MAX_BUFFER_MINUTES = 240;
/** The longest minimum notice a listing may set: 30 days. */
export const MAX_MIN_NOTICE_MINUTES = 43_200;

/** [BOOK-S1] The span of the business's time one booking holds: [start, end). */
export interface BusyInterval {
  start: Date;
  end: Date;
}

/** A listing's gap after each booking, as stored: absent, negative or junk is
 *  none, and it never exceeds MAX_BUFFER_MINUTES (so a read window padded by
 *  that much always sees every booking whose gap reaches it). */
export function bufferOf(config: unknown): number {
  const raw = (config as { bufferMinutes?: unknown } | null | undefined)?.bufferMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_BUFFER_MINUTES);
}

/** The business's time a booking holds: its slot plus its listing's gap. */
export function busyIntervalOf(slotStart: Date, slotEnd: Date, bufferMinutes: number): BusyInterval {
  return { start: slotStart, end: new Date(slotEnd.getTime() + Math.max(0, bufferMinutes) * 60_000) };
}

/** The business's time a candidate slot on this listing would hold. */
export function candidateInterval(slotStart: Date, config: BookingConfig): BusyInterval {
  return busyIntervalOf(slotStart, new Date(slotStart.getTime() + config.durationMinutes * 60_000), bufferOf(config));
}

/** The most of `busy` held at one moment inside `span` ([start, end): back to
 *  back is not an overlap). A sweep over the clipped intervals. */
export function peakOverlap(span: BusyInterval, busy: readonly BusyInterval[]): number {
  const events: Array<[number, number]> = [];
  const from = span.start.getTime();
  const to = span.end.getTime();
  for (const b of busy) {
    const s = Math.max(from, b.start.getTime());
    const e = Math.min(to, b.end.getTime());
    if (s < e) events.push([s, 1], [e, -1]);
  }
  // Ends before starts at the same instant: [a, t) and [t, b) never stack.
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let now = 0;
  let peak = 0;
  for (const [, d] of events) {
    now += d;
    if (now > peak) peak = now;
  }
  return peak;
}

/** The most of `busy` held at one moment anywhere, and the first moment it is
 *  reached (null when nothing is held). Same sweep as peakOverlap. */
export function peakMoment(busy: readonly BusyInterval[]): { count: number; at: Date | null } {
  const events: Array<[number, number]> = [];
  for (const b of busy) if (b.start < b.end) events.push([b.start.getTime(), 1], [b.end.getTime(), -1]);
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let now = 0;
  let count = 0;
  let at: number | null = null;
  for (const [t, d] of events) {
    now += d;
    if (now > count) { count = now; at = t; }
  }
  return { count, at: at === null ? null : new Date(at) };
}

/** THE rule: does the business have room for `span`, given what it already
 *  holds and how many it serves at once? */
export function hasRoom(span: BusyInterval, busy: readonly BusyInterval[], capacity: number): boolean {
  return peakOverlap(span, busy) + 1 <= Math.max(1, Math.floor(capacity));
}

export interface ExceptionWindow {
  /** null = whole-vendor block (applies to every listing). */
  itemId: string | null;
  /** "13:00" — null start+end = the full day is blocked. */
  start: string | null;
  end: string | null;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Human form of a true slot instant, used in reschedule notifications. */
export function fmtSlotTime(d: Date): string {
  return formatGuyanaTime(d, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Candidate stride: a buffer widens the grid so every booking leaves its
 *  gap; defaults keep legacy listings byte-identical. */
export function strideMinutes(config: BookingConfig): number {
  return config.durationMinutes + bufferOf(config);
}

/** Does [slotMin, slotMin+duration) overlap this exception on that date? */
function blockedByException(slotMin: number, durationMinutes: number, ex: ExceptionWindow): boolean {
  if (ex.start == null && ex.end == null) return true; // full day off
  const exStart = ex.start != null ? toMinutes(ex.start) : 0;
  const exEnd = ex.end != null ? toMinutes(ex.end) : 24 * 60;
  return slotMin < exEnd && slotMin + durationMinutes > exStart;
}

export function slotBlocked(slotMin: number, durationMinutes: number, itemId: string, exceptions: ExceptionWindow[]): boolean {
  return exceptions.some((ex) => (ex.itemId === null || ex.itemId === itemId) && blockedByException(slotMin, durationMinutes, ex));
}

/**
 * All offerable true slot instants for one Guyana calendar date.
 * `busy` is the business's time held by its live bookings (every listing)
 * around that date; `capacity` is how many it serves at once (default 1).
 */
export function computeDaySlots(opts: {
  itemId: string;
  config: BookingConfig;
  year: number;
  month: number; // 1-based
  day: number;
  exceptions: ExceptionWindow[];
  busy: readonly BusyInterval[];
  capacity?: number;
  now: Date;
}): Date[] {
  const { config } = opts;
  if (!config.durationMinutes || config.durationMinutes <= 0 || !Array.isArray(config.slots)) return [];
  const stride = strideMinutes(config);
  const dayOfWeek = new Date(Date.UTC(opts.year, opts.month - 1, opts.day)).getUTCDay();
  const earliest = new Date(opts.now.getTime() + Math.max(0, config.minNoticeMinutes ?? 0) * 60_000);
  const capacity = opts.capacity ?? 1;

  const out = new Map<number, Date>();
  for (const w of config.slots) {
    if (w.dayOfWeek !== dayOfWeek) continue;
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    for (let t = start; t + config.durationMinutes <= end; t += stride) {
      const slot = instantOfGuyanaWallClock(new Date(Date.UTC(opts.year, opts.month - 1, opts.day, Math.floor(t / 60), t % 60)));
      if (slot <= earliest) continue;
      if (slotBlocked(t, config.durationMinutes, opts.itemId, opts.exceptions)) continue;
      if (!hasRoom(candidateInterval(slot, config), opts.busy, capacity)) continue;
      out.set(slot.getTime(), slot);
    }
  }
  // A stored listing from before overlapping windows were refused can name an
  // instant twice: once, in time order.
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** Reservation-side window check (the endpoint's twin): inside a window,
 *  aligned to the stride, honoring lead time. Exceptions are checked by the
 *  caller with slotBlocked (they need a DB read). */
export function slotFitsConfig(slotStart: Date, config: BookingConfig, now: Date): 'OK' | 'OUTSIDE' | 'TOO_SOON' {
  const stride = strideMinutes(config);
  const local = guyanaWallClockParts(slotStart);
  const day = local.dayOfWeek;
  const minutesIntoDay = local.hour * 60 + local.minute;
  const window = config.slots.find((s) => {
    if (s.dayOfWeek !== day) return false;
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    return (
      minutesIntoDay >= start &&
      minutesIntoDay + config.durationMinutes <= end &&
      (minutesIntoDay - start) % stride === 0
    );
  });
  if (!window) return 'OUTSIDE';
  if (slotStart.getTime() <= now.getTime() + Math.max(0, config.minNoticeMinutes ?? 0) * 60_000) return 'TOO_SOON';
  return 'OK';
}

/** [L09 · M017] Slots are minute-grained: a requested instant is truncated to
 *  its minute so the slot identity checked, stored and enforced by the live
 *  unique index is one value. 10:00:00.400 and 10:00:00.000 are one slot. */
export function canonicalSlotStart(slotStart: Date): Date {
  return new Date(Math.floor(slotStart.getTime() / 60_000) * 60_000);
}
