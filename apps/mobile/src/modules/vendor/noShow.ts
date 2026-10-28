import { errorMessage } from '../../lib/apiError';
import { formatAppointmentClock } from '../../lib/appointmentTime';
import { mmgDisputePaused } from './order-dispute';

// ---------------------------------------------------------------------------
// [BOOK-NS-APP · owner B3, 28 Oct 2026] "CUSTOMER DIDN'T COME" in the partner app.
//
// The server (PUT /vendor/orders/:id/no-show) closes an appointment the business accepted once its time has started:
// the booking closes, a record is kept, no fee, no strike. The app offers the button only where the server would take
// it (an accepted appointment whose start has passed), asks once, and then shows what the server said:
//   - a refusal in the server's own words (APPOINTMENT_NOT_STARTED, NO_SHOW_NOT_OPEN, NO_SHOW_PAID_MMG, ...);
//   - on success, the closed state from the answer (appointmentNoShow.recordedAt). An answer without that field
//     still reads as closed, without a time.
// The server is the judge: the device clock only decides when the button appears.
// ---------------------------------------------------------------------------

export const NO_SHOW_WORDS = {
  button: 'Customer didn’t come',
  confirmTitle: 'Mark as ‘Customer didn’t come’?',
  confirmBody: 'The booking closes. No fee, no strike.',
  confirmYes: 'Yes, they didn’t come',
  keep: 'Keep the booking',
  closedTitle: 'Booking closed',
  done: 'Done',
  /** Only when the server gave no words (no connection, a timeout). */
  fallback: 'Couldn’t record that. Check your connection and try again.',
} as const;

/** The instant an ISO time names, or null when it names none. */
function instant(iso: unknown): number | null {
  if (typeof iso !== 'string' && !(iso instanceof Date)) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** How long until the time starts (0 or less once it has), or null when there is no time. */
export function msUntilStart(iso: unknown, now: number): number | null {
  const t = instant(iso);
  return t === null ? null : t - now;
}

/** An order the store may mark: an appointment it accepted, whose time has started (not paused for an MMG review). */
export function orderNoShowOpen(order: any, now: number): boolean {
  if (order?.fulfillment !== 'APPOINTMENT') return false;
  if (String(order?.status ?? '').toUpperCase() !== 'ACCEPTED') return false;
  if (mmgDisputePaused(order)) return false;
  const wait = msUntilStart(order?.appointmentSlot, now);
  return wait !== null && wait <= 0;
}

/** A Schedule booking the store may mark: confirmed (its order accepted), tied to an order, its time started. */
export function bookingNoShowOpen(b: { status?: unknown; orderId?: unknown; slotStart?: unknown }, now: number): boolean {
  if (b?.status !== 'CONFIRMED') return false;
  if (typeof b.orderId !== 'string' || b.orderId.length === 0) return false;
  const wait = msUntilStart(b.slotStart, now);
  return wait !== null && wait <= 0;
}

/** A refusal, in the server's own words. */
export function noShowRefusalWords(error: unknown): string {
  return errorMessage(error, NO_SHOW_WORDS.fallback);
}

/** The closed state, from the server's answer: when it was recorded, if the answer says. */
export function noShowClosedLine(answer: unknown): string {
  const record = (answer as { appointmentNoShow?: { recordedAt?: unknown } | null } | null | undefined)?.appointmentNoShow;
  const at = instant(record?.recordedAt);
  return at === null
    ? 'Recorded: the customer didn’t come. No fee, no strike.'
    : `Recorded at ${formatAppointmentClock(new Date(at))}: the customer didn’t come. No fee, no strike.`;
}
