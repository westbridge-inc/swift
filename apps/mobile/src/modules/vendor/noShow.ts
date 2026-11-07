import { errorMessage } from '../../lib/apiError';
import { formatAppointmentClock } from '../../lib/appointmentTime';
import { mmgDisputePaused } from './order-dispute';
import { MMG_MONEY_MOVED } from './storeOrderRules';

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
// [REVIEW-F S3-1 on #2201] The button needs the server's own word: GET /vendor/orders/:id (appointments) and every
// GET /vendor/bookings row carry noShow { allowed }, computed by the server at the read. An older server sends no word,
// so no button there (a server without the step can never be tapped into its not-found answer).
// ---------------------------------------------------------------------------

export const NO_SHOW_WORDS = {
  button: 'Customer didn’t come',
  confirmTitle: 'Mark as ‘Customer didn’t come’?',
  confirmBody: 'The booking closes. No fee, no strike.',
  confirmYes: 'Yes, they didn’t come',
  keep: 'Keep the booking',
  closedTitle: 'Booking closed',
  done: 'Done',
  /** [REVIEW-F S3-1 on #2201] The server this phone talks to has no such step yet (an older server): never its route text. */
  notAvailable: 'This isn’t available yet. Contact Swift Support if the customer didn’t come.',
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

/** The server's word on this order or booking row: true only when it says so (absent on an older server). */
export function serverAllowsNoShow(row: unknown): boolean {
  return (row as { noShow?: { allowed?: unknown } | null } | null | undefined)?.noShow?.allowed === true;
}

/** An order the store may mark: the server says so, and it is an appointment it accepted whose time has started (not
 *  paused for an MMG review, not paid by MMG). */
export function orderNoShowOpen(order: any, now: number): boolean {
  if (!serverAllowsNoShow(order)) return false;
  if (order?.fulfillment !== 'APPOINTMENT') return false;
  if (String(order?.status ?? '').toUpperCase() !== 'ACCEPTED') return false;
  if (mmgDisputePaused(order)) return false;
  // [REVIEW-F S4-1 on #2201] Paid by MMG: the server refuses it (NO_SHOW_PAID_MMG, no money moves there), so no button.
  if (order?.paymentMethod === 'MOBILE_MONEY' && (MMG_MONEY_MOVED as readonly unknown[]).includes(order?.paymentStatus)) return false;
  const wait = msUntilStart(order?.appointmentSlot, now);
  return wait !== null && wait <= 0;
}

/** A Schedule booking the store may mark: the server says so, and it is confirmed (its order accepted), tied to an
 *  order, its time started. */
export function bookingNoShowOpen(b: { status?: unknown; orderId?: unknown; slotStart?: unknown; noShow?: unknown }, now: number): boolean {
  if (!serverAllowsNoShow(b)) return false;
  if (b?.status !== 'CONFIRMED') return false;
  if (typeof b.orderId !== 'string' || b.orderId.length === 0) return false;
  const wait = msUntilStart(b.slotStart, now);
  return wait !== null && wait <= 0;
}

/** [REVIEW-F S3-1 on #2201] A server without the step answers its not-found handler: 404 with no code, the route-not-found
 *  code, or NOT_FOUND worded "Route PUT /... not found". An order of another business is a 404 too, but in its own words. */
function routeMissing(error: unknown): boolean {
  const r = (error as { response?: { status?: unknown; data?: { error?: { code?: unknown; message?: unknown } } } } | null | undefined)?.response;
  if (r?.status !== 404) return false;
  const code = r.data?.error?.code;
  const message = r.data?.error?.message;
  if (code === undefined || code === null || code === 'ROUTE_NOT_FOUND') return true;
  return code === 'NOT_FOUND' && typeof message === 'string' && /^Route [A-Z]+ /.test(message);
}

/** A refusal, in the server's own words (a server without the step: one plain line, never its route text). */
export function noShowRefusalWords(error: unknown): string {
  if (routeMissing(error)) return NO_SHOW_WORDS.notAvailable;
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
