// ---------------------------------------------------------------------------
// [BOOK-FU3 · 29 Oct 2026] Two rules an appointment checkout keeps, shared by
// the cart routes, the guest-basket merge and the checkout.
//
// 1. ONE APPOINTMENT PER BOOKING LINE (money; REVIEW-M S4-1 on #2202). A booking
//    line is one time slot. The price is unit x quantity, so a line of 2 would
//    charge twice for one slot. The official apps send 1; any other client is
//    refused with a plain 400 at cart add, cart update and checkout (the
//    checkout is the authority: nothing is written and no MMG instruction is
//    given). Re-adding the SAME booking (quantity 1) leaves its line at 1 and
//    lets the app keep the newest time it picked.
//
// 2. CLOSED NOW IS NOT "CAN'T OPERATE" (COORD ruling 29 Oct 00:09Z, delegated).
//    A store's "open now" switch (isCurrentlyOpen) says whether it takes orders
//    to be made right now. A booking is for a later time, so a checkout whose
//    store group is ONLY an appointment is not refused because the store is
//    closed at this moment (a salon closed tonight still takes tomorrow's
//    booking). Everything that says the business cannot operate still refuses
//    it: not ACTIVE (suspended, pending, wound down), orders paused by the owner
//    (acceptingOrders off), documents past their authority (activationValidUntil),
//    and the weekly-fee operability check. The time itself must still be inside
//    the listing's booking windows (BookingService.validateSlot).
// ---------------------------------------------------------------------------
import { AppError } from '../../utils/errors';

export const ONE_APPOINTMENT_CODE = 'APPOINTMENT_QUANTITY';
export const ONE_APPOINTMENT_MESSAGE = 'A booking is for one appointment.';

/** The plain 400 for a booking line asked for in a quantity other than 1. */
export function oneAppointmentRefusal(): AppError {
  return new AppError(400, ONE_APPOINTMENT_CODE, ONE_APPOINTMENT_MESSAGE);
}

/** Refuses a booking line whose quantity is not exactly 1. Other listings pass. */
export function assertOneAppointment(fulfillment: string | null | undefined, quantity: number): void {
  if (fulfillment === 'APPOINTMENT' && quantity !== 1) throw oneAppointmentRefusal();
}

/** True when every line of one store's group is an appointment (a booking-only group). */
export function isAppointmentOnlyGroup(lines: ReadonlyArray<{ item: { fulfillment: string | null | undefined } }>): boolean {
  return lines.length > 0 && lines.every((line) => line.item.fulfillment === 'APPOINTMENT');
}

/**
 * Whether a store's lifecycle flags let this checkout through. "Closed right
 * now" stops goods (food, groceries, retail) but not a booking-only group; a
 * store that is not ACTIVE or has paused its orders stops both.
 */
export function storeFlagsAllowCheckout(
  vendor: { status: string; isCurrentlyOpen: boolean; acceptingOrders: boolean },
  appointmentOnly: boolean,
): boolean {
  if (vendor.status !== 'ACTIVE' || !vendor.acceptingOrders) return false;
  return vendor.isCurrentlyOpen || appointmentOnly;
}
