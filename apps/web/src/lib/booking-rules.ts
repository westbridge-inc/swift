/**
 * [BOOK-S6b · owner C3 28 Oct 2026] The phone app's own booking rules, reused by the web app — never re-expressed
 * (like lib/app-rules, kept in their own module so only the pages and parts that book load them).
 *
 * Web customer booking says what the phone says, from the same rules: the "Instant confirmation" badge only on the
 * slots answer's own word, "Book now" vs "Request booking", the booking summary line, and a placed booking is
 * "confirmed" only when the checkout answer's appointment order is already ACCEPTED (never a guess). The order's
 * "Change time" reads the server's appointmentBooking projection the same way.
 */
export {
  appointmentBookingView,
  bookingSummaryNote,
  checkoutButtonLabel,
  listingConfirmsInstantly,
  mmgBookingWaitsNote,
  placedBookingOutcome,
  placedPopupTitle,
  type AppointmentBookingView,
  type PlacedBookingOutcome,
} from '../../../mobile/src/lib/appointmentBooking';
export { paymentActionForCheckout, placedOrderConfirmationCopy } from '../../../mobile/src/modules/cart/cartPayment';
