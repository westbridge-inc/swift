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
  checkoutPaymentMethod,
  normalizeCartPaymentCapabilities,
  reconcileCartPaymentSelection,
  selectCartPaymentMethod,
  type CartPaymentSelection,
} from '../../../mobile/src/modules/cart/cartPayment';
