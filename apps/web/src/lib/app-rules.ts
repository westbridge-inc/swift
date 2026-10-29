/**
 * [Q7b] The phone app's own rules, reused by the web app — never
 * re-expressed. Each is a pure function whose only imports are types, so the
 * web bundle takes it from the one source (the same way design-tokens reads
 * the vertical tints).
 *
 * - marketTabVisible: a complete server depth verdict is the only authority
 *   for showing the Market tab.
 * - isHomeFeed: a success envelope missing Home's rails is a failed read, not
 *   a healthy empty marketplace.
 * - the cart payment rules: MMG is offered only when the server's capability
 *   for THIS cart says so, a choice lives only as long as that capability's
 *   scope, and the wording of each option is the phone app's.
 */
export { isHomeFeed, marketTabVisible } from '../../../mobile/src/lib/homeReliability';
export {
  cartPaymentOptions,
  checkoutPaymentFields,
  checkoutPaymentMethod,
  mmgOffered,
  normalizeCartPaymentCapabilities,
  reconcileCartPaymentSelection,
  selectCartPaymentMethod,
  type CartPaymentSelection,
} from '../../../mobile/src/modules/cart/cartPayment';
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The accepted order's "Pay $X by MMG to <store>'s MMG number": one parser.
export { mmgStorePaymentDeadline, mmgStorePaymentNote, parseMmgStorePayment } from '../../../mobile/src/lib/mmgStorePayment';
// [BOOK-S6b · owner C3 28 Oct 2026] Web customer booking says what the phone says, from the same rules:
// the "Instant confirmation" badge only on the slots answer's own word, "Book now" vs "Request booking",
// the booking summary line, and a placed booking is "confirmed" only when the checkout answer's
// appointment order is already ACCEPTED (never a guess). The order's "Change time" reads the server's
// appointmentBooking projection the same way.
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
