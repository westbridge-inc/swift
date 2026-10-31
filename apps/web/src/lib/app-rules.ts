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
// [#2252 REVIEW-F S4-1] The order page's status rail: which step is done (Preparing only on a kitchen fact, never by
// position), the step the order is at, and the travel step's words — the phone's timeline rule, one copy (no imports).
export { deliveryTransitLabel, orderPrepFacts, orderStepState, orderTimelineIndex } from '../../../mobile/src/modules/orders/timeline-states';
