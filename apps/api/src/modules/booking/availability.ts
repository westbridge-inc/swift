import type { BookingConfig } from './booking.service';

// ---------------------------------------------------------------------------
// THE availability computation (scheduling spec law: "no double-source") —
// bookingConfig windows MINUS exceptions MINUS bookings, honoring buffers and
// lead time. Pure: the picker endpoint, reservation validation, the vendor
// calendar and reschedule all consume THIS, never their own arithmetic.
//
// Time convention (SCH-F): slot instants carry LOCAL wall-clock time on their
// UTC face end-to-end — the vendor types "09:00", the window matches 09:00 on
// the UTC face, the picker formats in UTC. One convention, zero offsets.
// ---------------------------------------------------------------------------

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

/** Candidate stride: a buffer widens the grid so every booking leaves its
 *  gap; defaults keep legacy listings byte-identical. */
export function strideMinutes(config: BookingConfig): number {
  return config.durationMinutes + Math.max(0, config.bufferMinutes ?? 0);
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
 * All offerable slot starts for one listing on one date (UTC-face day parts).
 * `takenStarts` are the non-cancelled booking instants for that item/date.
 */
export function computeDaySlots(opts: {
  itemId: string;
  config: BookingConfig;
  year: number;
  month: number; // 1-based
  day: number;
  exceptions: ExceptionWindow[];
  takenStarts: Date[];
  now: Date;
}): Date[] {
  const { config } = opts;
  if (!config.durationMinutes || config.durationMinutes <= 0 || !Array.isArray(config.slots)) return [];
  const stride = strideMinutes(config);
  const dayOfWeek = new Date(Date.UTC(opts.year, opts.month - 1, opts.day)).getUTCDay();
  const earliest = new Date(opts.now.getTime() + Math.max(0, config.minNoticeMinutes ?? 0) * 60_000);
  const taken = new Set(opts.takenStarts.map((t) => t.toISOString()));

  const out: Date[] = [];
  for (const w of config.slots) {
    if (w.dayOfWeek !== dayOfWeek) continue;
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    for (let t = start; t + config.durationMinutes <= end; t += stride) {
      const slot = new Date(Date.UTC(opts.year, opts.month - 1, opts.day, Math.floor(t / 60), t % 60));
      if (slot <= earliest) continue;
      if (slotBlocked(t, config.durationMinutes, opts.itemId, opts.exceptions)) continue;
      if (taken.has(slot.toISOString())) continue;
      out.push(slot);
    }
  }
  return out;
}

/** Reservation-side window check (the endpoint's twin): inside a window,
 *  aligned to the stride, honoring lead time. Exceptions are checked by the
 *  caller with slotBlocked (they need a DB read). */
export function slotFitsConfig(slotStart: Date, config: BookingConfig, now: Date): 'OK' | 'OUTSIDE' | 'TOO_SOON' {
  const stride = strideMinutes(config);
  const day = slotStart.getUTCDay();
  const minutesIntoDay = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
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
