// ---------------------------------------------------------------------------
// [BOOK-S6a · owner A3/A4/B2 28 Oct 2026] What the SERVER says about a booking,
// read for the customer's screens: the item screen's badge, the cart button,
// the success popup and the booking screen's "Change time".
//
// Every field is read strictly. A server without these fields (or with the
// INSTANT_BOOKING switch off) sends none of them, and the screens then say what
// is true there: a booking is a request the business confirms, and the time is
// changed by contacting the business. The app never guesses that a booking is
// confirmed, and never authors a rule (cut-off, window) of its own.
// ---------------------------------------------------------------------------

/** The slots answer says this listing's cash bookings are confirmed at once:
 *  the switch is on AND the business chose "Confirm bookings automatically". */
export function listingConfirmsInstantly(slotsAnswer: unknown): boolean {
  return !!slotsAnswer && typeof slotsAnswer === 'object'
    && (slotsAnswer as { instantConfirmation?: unknown }).instantConfirmation === true;
}

export type PlacedBookingOutcome = 'confirmed' | 'requested';

/** From the checkout answer: "confirmed" only when every appointment order it
 *  placed is already ACCEPTED (the business's standing acceptance at checkout);
 *  any other status is a request. Null when the answer names no appointment. */
export function placedBookingOutcome(answer: unknown): PlacedBookingOutcome | null {
  const orders = answer && typeof answer === 'object' && Array.isArray((answer as { orders?: unknown }).orders)
    ? ((answer as { orders: unknown[] }).orders)
    : [];
  const bookings = orders.filter((o): o is { status?: unknown } =>
    !!o && typeof o === 'object' && (o as { fulfillment?: unknown }).fulfillment === 'APPOINTMENT');
  if (bookings.length === 0) return null;
  return bookings.every((o) => o.status === 'ACCEPTED') ? 'confirmed' : 'requested';
}

/** The success popup's title. A booking cart whose answer names no appointment
 *  (an older answer shape) stays a request: never "confirmed" on a guess. */
export function placedPopupTitle(input: { appointment: boolean; outcome: PlacedBookingOutcome | null }): string {
  if (input.outcome === 'confirmed') return 'Booking confirmed';
  if (input.appointment || input.outcome === 'requested') return 'Booking requested';
  return 'Your order is placed';
}

/** The cart's button. "Book now" only when every booking in a bookings-only
 *  cart is one its listing confirms at once and the customer pays cash at the
 *  appointment (owner A3: an MMG booking stays "the business confirms"). */
export function checkoutButtonLabel(input: {
  appointmentOnly: boolean;
  pickup: boolean;
  everyBookingInstant: boolean;
  payingCash: boolean;
}): string {
  if (input.appointmentOnly) return input.everyBookingInstant && input.payingCash ? 'Book now' : 'Request booking';
  return input.pickup ? 'Place pickup order' : 'Place order';
}

/** The cart's booking summary line: what happens when the customer books. */
export function bookingSummaryNote(input: { everyBookingInstant: boolean; payingCash: boolean }): string {
  return input.everyBookingInstant && input.payingCash
    ? 'Your time is confirmed as soon as you book.'
    : 'Your time is confirmed when the business accepts the booking.';
}

/** The line under the cart button when instant bookings are paid by MMG. */
export function mmgBookingWaitsNote(input: { appointmentOnly: boolean; everyBookingInstant: boolean; payingCash: boolean }): string | null {
  return input.appointmentOnly && input.everyBookingInstant && !input.payingCash
    ? 'Paying by MMG: the business confirms the booking first.'
    : null;
}

export interface AppointmentBookingView {
  bookingId: string;
  itemId: string;
  slotStart: string;
  /** The server allows a move now. */
  canReschedule: boolean;
  /** The server's own words when it does not (null: nothing to say). */
  rescheduleUnavailable: string | null;
}

/** The order detail's `appointmentBooking`, or null when the server sends
 *  none (an older server, the switch off, or no live booking). */
export function appointmentBookingView(order: unknown): AppointmentBookingView | null {
  const raw = order && typeof order === 'object' ? (order as { appointmentBooking?: unknown }).appointmentBooking : null;
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as { id?: unknown; itemId?: unknown; slotStart?: unknown; reschedule?: unknown };
  if (typeof b.id !== 'string' || !b.id || typeof b.itemId !== 'string' || !b.itemId || typeof b.slotStart !== 'string') return null;
  const r = b.reschedule && typeof b.reschedule === 'object' ? (b.reschedule as { allowed?: unknown; message?: unknown }) : null;
  return {
    bookingId: b.id,
    itemId: b.itemId,
    slotStart: b.slotStart,
    canReschedule: r?.allowed === true,
    rescheduleUnavailable: r?.allowed !== true && typeof r?.message === 'string' && r.message.trim() ? r.message : null,
  };
}

/** The words for a refused move: the server's message, else a plain retry line. */
export function rescheduleErrorMessage(error: unknown): string {
  const message = (error as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message;
  return typeof message === 'string' && message.trim() ? message : 'Couldn’t change the time. Check your connection and try again.';
}
