// ---------------------------------------------------------------------------
// [BOOK-S2 · owner 28 Oct 2026 B4] INSTANT_BOOKING — the appointment-booking
// switch. Built now and kept OFF until the whole instant-booking track has
// passed CI, a real-Postgres race run and a staging run; then the owner is
// asked to switch it on.
//
// While it is off, checkout behaves exactly as before: an appointment order is
// a request, and its slot is taken only when the business accepts.
//
// With it on (this PR), ONE thing changes: the slot is taken when the customer
// books. Checkout writes the booking (RESERVED, linked to the order) inside the
// checkout transaction, under the business's time lock and the one overlap
// rule, so two customers can never wait on the same time. Losing the race is
// 409 SLOT_TAKEN and no order at all. Acceptance turns RESERVED into
// CONFIRMED; every order death frees it (booking/order-coupling.ts).
// ---------------------------------------------------------------------------

/** INSTANT_BOOKING: on only when exactly "1" (surrounding blanks ignored). */
export function instantBookingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['INSTANT_BOOKING'] ?? '').trim() === '1';
}
