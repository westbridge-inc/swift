// ---------------------------------------------------------------------------
// [BOOK-S2 · owner 28 Oct 2026 B4] INSTANT_BOOKING — the appointment-booking
// switch. Built now and kept OFF until the whole instant-booking track has
// passed CI, a real-Postgres race run and a staging run; then the owner is
// asked to switch it on.
//
// While it is off, checkout behaves exactly as before: an appointment order is
// a request, and its slot is taken only when the business accepts.
//
// With it on:
//  - [BOOK-S2] the slot is taken when the customer books. Checkout writes the
//    booking (RESERVED, linked to the order) inside the checkout transaction,
//    under the business's time lock and the one overlap rule, so two customers
//    can never wait on the same time. Losing the race is 409 SLOT_TAKEN and no
//    order at all. Acceptance turns RESERVED into CONFIRMED; every order death
//    frees it (booking/order-coupling.ts).
//  - [BOOK-S3 · owner A3/A4 28 Oct] a listing whose business chose "Confirm
//    bookings automatically" (bookingConfig.instantBooking) is booked AND
//    confirmed in that same commit when the customer pays cash at the
//    appointment: the business's standing acceptance moves the order PENDING
//    -> ACCEPTED through the canonical transition, and the booking becomes
//    CONFIRMED through the coupling seam. An MMG booking stays "the business
//    confirms" (A3). New bookable listings start as automatic (A4) with two
//    hours' minimum notice (C2).
//  - [BOOK-S3 · owner B1] an appointment cancels free until two hours before
//    it starts (order/cancel-policy.ts). The Terms wording is owed by S7.
// ---------------------------------------------------------------------------

/** INSTANT_BOOKING: on only when exactly "1" (surrounding blanks ignored). */
export function instantBookingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['INSTANT_BOOKING'] ?? '').trim() === '1';
}

/** [BOOK-S3 · owner A4] Did the business choose "Confirm bookings automatically" for this listing? */
export function listingConfirmsAutomatically(bookingConfig: unknown): boolean {
  return !!bookingConfig && typeof bookingConfig === 'object' && !Array.isArray(bookingConfig)
    && (bookingConfig as Record<string, unknown>)['instantBooking'] === true;
}

/** [BOOK-S3 · owner A3] Instant confirmation is for a cash-at-the-appointment booking only. */
export const INSTANT_CONFIRM_PAYMENT_METHOD = 'CASH';

/** [BOOK-S3] The status-log note of the business's standing acceptance (changedBy 'system'). */
export const INSTANT_CONFIRM_NOTE = 'Confirmed automatically: the business set this listing to confirm bookings automatically (bookingConfig.instantBooking)';

/** [BOOK-S3] Who the standing acceptance is recorded as. */
export const INSTANT_CONFIRM_CHANGED_BY = 'system';

/** [BOOK-S3 · owner A4/C2] What a NEW bookable listing starts with while the switch is on,
 *  for each setting the save does not name: confirmed automatically, two hours' notice. */
export const NEW_BOOKABLE_LISTING_DEFAULTS = { instantBooking: true, minNoticeMinutes: 120 } as const;
