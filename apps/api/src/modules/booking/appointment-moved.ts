/**
 * [BOOK-FU2 · the #2188 family] "Your appointment moved" / "Appointment moved": the notice a STORE
 * appointment's move sends to the other side (the customer moved it: the business is told; the
 * business moved it: the customer is told).
 *
 * It used to be sent as `booking_rescheduled` with only the booking id, so no released build could open the
 * booking itself (replayed on each build's router): builds 9 and 11 opened nothing for the customer and
 * Schedule for the business; build 12 opens the customer's orders list and Schedule for the business. This
 * kind carries the booking's order, and the released routers have no case for it, so they route it through
 * the order branches they already have, exactly as they route `appointment_reminder`: the customer opens the
 * booking's order screen, the business that order on its order desk. It stays outside the `booking_` family,
 * whose unnamed kinds those routers open on ServiceJobs. Service JOB notices keep their `booking_` kinds.
 *
 * The payload carries the booking (the new booking row a move writes) and its order when it has one;
 * NotificationService adds the audience. A move writes a NEW booking row, so the per-person dedupe key
 * names exactly one move: a retried send of the same move collapses into the first, while a later move
 * (even back to an earlier time) is a new booking and is told again.
 */
export function appointmentMovedData(booking: { id: string; orderId: string | null }) {
  return { kind: 'appointment_moved', bookingId: booking.id, ...(booking.orderId ? { orderId: booking.orderId } : {}) };
}

/** The once-per-move-per-person key (Notification's per-user dedupe key). */
export function appointmentMovedDedupeKey(bookingId: string): string {
  return `appointment-moved:${bookingId}`;
}
