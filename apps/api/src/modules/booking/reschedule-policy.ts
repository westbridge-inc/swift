// ---------------------------------------------------------------------------
// [BOOK-S6a · owner B2 28 Oct 2026] THE customer reschedule rule, one predicate
// for the order screen's preview (GET /customer/orders/:id appointmentBooking)
// and the move itself (BookingService.rescheduleBooking for a customer), so the
// screen never offers a move the server then refuses.
//
// With INSTANT_BOOKING on, the customer can move a booking in the app to
// another free time of the same service until the same cut-off as the free
// cancel (owner B1): two hours before it starts. After that, the customer
// contacts the provider. The business can move a booking at any time (B2:
// "the business can reschedule too"); this rule is the customer's only.
// With the switch off the move route behaves as before and the order screen
// projects nothing (no phone build calls the route).
//
// Pure: no services, no Prisma (the cancel rule's constant is read from the
// light cancel-policy module).
// ---------------------------------------------------------------------------
import { APPOINTMENT_FREE_CANCEL_BEFORE_MIN } from '../order/cancel-policy';

/** Minutes before the start after which the customer can no longer move a booking in the app. */
export const CUSTOMER_RESCHEDULE_BEFORE_MIN = APPOINTMENT_FREE_CANCEL_BEFORE_MIN;

export const RESCHEDULE_WINDOW_CLOSED_CODE = 'RESCHEDULE_WINDOW_CLOSED';

export const RESCHEDULE_WINDOW_CLOSED_MESSAGE =
  `This booking can no longer be moved in the app: it starts in less than ${CUSTOMER_RESCHEDULE_BEFORE_MIN / 60} hours. Contact the provider to change it.`;

export type CustomerRescheduleVerdict =
  | { allowed: true; code: null; message: null }
  | { allowed: false; code: typeof RESCHEDULE_WINDOW_CLOSED_CODE; message: string };

/** May the customer move a booking that starts at `slotStart`, now? */
export function customerRescheduleVerdict(slotStart: Date, now: Date): CustomerRescheduleVerdict {
  const cutoff = slotStart.getTime() - CUSTOMER_RESCHEDULE_BEFORE_MIN * 60_000;
  return now.getTime() < cutoff
    ? { allowed: true, code: null, message: null }
    : { allowed: false, code: RESCHEDULE_WINDOW_CLOSED_CODE, message: RESCHEDULE_WINDOW_CLOSED_MESSAGE };
}
