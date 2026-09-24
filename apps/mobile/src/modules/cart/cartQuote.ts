import type { CartQuoteChoices } from '../../services/api';
import { errorMessage } from '../../lib/apiError';

/**
 * [E01 · E09] The cart screen's half of "the total shown is the total charged".
 *
 * A multi-store cart is several orders, each with its own delivery fee and its
 * own minimum. The server prices them (GET /cart, through the same pricer as
 * checkout); the screen's job is only to:
 *   1. ask for the quote with EXACTLY the choices the order button will submit
 *      — one `CartQuoteChoices` object serves both requests;
 *   2. submit the tip that quote was priced with;
 *   3. render the server's rows — never compute a total itself (the old screen
 *      subtracted ONE store's fee for pickup, a third calculator the server
 *      never saw, wrong the moment a second store joined the cart).
 * Everything here is pure, so it is tested without a renderer.
 */

export type CartMode = 'DELIVERY' | 'PICKUP';

/** The quote fields this module reads (GET /cart `data`). */
export interface CartQuoteStore {
  vendorId: string;
  name: string;
  fulfillment: 'DELIVERY' | 'PICKUP' | 'APPOINTMENT' | string;
  subtotal: number;
  deliveryFee: number;
  standardDeliveryFee?: number;
  tipAmount?: number;
  minOrderAmount: number;
  meetsMinimum: boolean;
  amountToMinimum?: number;
}
export interface CartQuote {
  items?: Array<{ vendorId?: unknown; fulfillment?: unknown }>;
  vendors?: CartQuoteStore[];
  tipAmount?: number | string | null;
  deliveryFee?: number;
  standardDeliveryFee?: number;
  /** The stored promo this quote priced (GET /cart `data.promoCode`): the code
   *  checkout must be sent for the charge to carry the quote's discount. */
  promoCode?: { code: string; discountType?: string; description?: string } | null;
}

/** The stores this cart's quote prices — from its own lines, each naming the
 *  store whose order it joins. Sorted, so an unchanged cart gives an unchanged
 *  selection (and an unchanged query key). */
export function quoteStoreIds(lines: CartQuote['items'] | null | undefined): string[] {
  const ids = (lines ?? []).map((line) => line?.vendorId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort();
}

/** A cart of bookings only: no rider, no delivery fee, no pickup counter. */
export function isBookingsOnly(lines: CartQuote['items'] | null | undefined): boolean {
  return (lines ?? []).length > 0 && (lines ?? []).every((line) => line?.fulfillment === 'APPOINTMENT');
}

/**
 * The pricing choices for the screen's state, as ONE object: the quote is
 * requested with it and the order button submits it.
 *   - the one global pickup toggle (owner decision) applies to EVERY store in
 *     the cart, not just the store `cart.vendor` happens to track;
 *   - express is a delivery speed, so it is not asked for with pickup;
 *   - [F-013-01] the customer's own tip choice outranks the tip persisted on
 *     the cart, and a basket with no rider (pickup / bookings only) carries no
 *     tip; with no choice made the tip is left to the server, which uses the
 *     cart's persisted tip — the same default checkout applies.
 */
export function cartPricingChoices(state: {
  mode: CartMode;
  express: boolean;
  storeIds: readonly string[];
  bookingsOnly: boolean;
  selectedTip: number | null;
  promoCode: string | null;
}): CartQuoteChoices {
  const pickup = !state.bookingsOnly && state.mode === 'PICKUP';
  const noRider = pickup || state.bookingsOnly;
  return {
    // [E01-B] The applied code rides the ONE choices object to the order body
    // (the quote prices the cart's stored promo either way). Absent once the
    // customer removes it.
    ...(state.promoCode ? { promoCode: state.promoCode } : {}),
    ...(state.express && !pickup ? { express: true as const } : {}),
    ...(pickup && state.storeIds.length > 0
      ? { fulfillmentSelections: Object.fromEntries(state.storeIds.map((id) => [id, 'PICKUP' as const])) }
      : {}),
    ...(noRider ? { tipAmount: 0 } : state.selectedTip != null ? { tipAmount: state.selectedTip } : {}),
  };
}

/**
 * [E01-B] The promo refusals checkout can return — the exact codes thrown by
 * `validatePromoCode` and `assertCashDiscountSponsored` in
 * apps/api/src/modules/order/order.service.ts (eligibility, window, caps,
 * per-user use, wrong store, the code's own minimum, and the one rail-dependent
 * combination: a discounted CASH platform delivery). The cart QUOTE does not
 * surface these (owner decision); CHECKOUT does, and the screen shows the
 * message checkout returned — exactly as the web cart does.
 */
export const CHECKOUT_PROMO_REFUSAL_CODES = [
  'INVALID_PROMO',
  'EXPIRED_PROMO',
  'USED_PROMO',
  'PROMO_WRONG_VENDOR',
  'MIN_ORDER_PROMO',
  'PROMO_UNAVAILABLE_CASH_DELIVERY',
] as const;

/** The message a refused checkout shows: the server's own message (every promo
 *  refusal above reaches the customer verbatim), with the generic fallback only
 *  when the response carried none. */
export function checkoutErrorMessage(err: unknown): string {
  return errorMessage(err, 'Could not place the order. Try again.');
}

/**
 * [E01-B] The choices the no-riders pickup retry is QUOTED with — and the order
 * it places carries the same meaning: every store collects (the same global
 * toggle as a manual pickup), express is a delivery speed so it is dropped,
 * there is no rider so no tip, and an applied promo stays applied (pickup
 * accepts it; only discounted CASH delivery is refused). The retry's confirm
 * step shows the quote these produced before anything is placed.
 */
export function pickupRetryChoices(state: {
  storeIds: readonly string[];
  bookingsOnly: boolean;
  promoCode: string | null;
}): CartQuoteChoices {
  return cartPricingChoices({
    mode: 'PICKUP',
    express: false,
    storeIds: state.storeIds,
    bookingsOnly: state.bookingsOnly,
    selectedTip: null,
    promoCode: state.promoCode,
  });
}

/** The tip a quote was priced with — what checkout must be sent for the
 *  charge to be that quote: the chosen tip, else the cart's tip the server
 *  priced (and echoed back as `tipAmount`). */
export function pricedTip(choices: CartQuoteChoices, quote: CartQuote | null | undefined): number {
  return choices.tipAmount ?? (Number(quote?.tipAmount ?? 0) || 0);
}

/** The delivery rows of the summary. More than one delivered store → one row
 *  per store (a multi-store basket is several orders, several fees); otherwise
 *  one "Delivery fee" row. Fees are shown WITHOUT the express premium, which
 *  has its own row. Null when nothing in this quote is delivered. */
export function deliveryFeeRows(quote: CartQuote | null | undefined):
  | { kind: 'perStore'; rows: Array<{ vendorId: string; name: string; fee: number }> }
  | { kind: 'single'; fee: number }
  | null {
  if (!quote) return null;
  const stores = quote.vendors;
  if (!stores) return { kind: 'single', fee: Number(quote.standardDeliveryFee ?? quote.deliveryFee ?? 0) };
  const delivered = stores.filter((s) => s.fulfillment === 'DELIVERY');
  if (delivered.length === 0) return null;
  if (delivered.length === 1) return { kind: 'single', fee: Number(delivered[0]!.standardDeliveryFee ?? delivered[0]!.deliveryFee) };
  return {
    kind: 'perStore',
    rows: delivered.map((s) => ({ vendorId: s.vendorId, name: s.name, fee: Number(s.standardDeliveryFee ?? s.deliveryFee) })),
  };
}

/** The rider tip inside this quote's total (0 when nothing is delivered). */
export function quotedRiderTip(quote: CartQuote | null | undefined, fallback: number): number {
  if (!quote?.vendors) return fallback;
  return quote.vendors.reduce((sum, s) => sum + (Number(s.tipAmount ?? 0) || 0), 0);
}

/** The stores to collect from when this quote is priced as pickup. */
export function pickupStoreNames(quote: CartQuote | null | undefined): string[] {
  return (quote?.vendors ?? []).filter((s) => s.fulfillment === 'PICKUP').map((s) => s.name);
}

/** [E09] Every store below ITS OWN minimum, with the amount still to add —
 *  the warning names each one (checkout refuses the whole basket if any is). */
export function shortStores(quote: CartQuote | null | undefined): Array<{ vendorId: string; name: string; minOrderAmount: number; amountToAdd: number }> {
  return (quote?.vendors ?? [])
    .filter((s) => !s.meetsMinimum)
    .map((s) => ({
      vendorId: s.vendorId,
      name: s.name,
      minOrderAmount: Number(s.minOrderAmount),
      amountToAdd: Number(s.amountToMinimum ?? Math.max(0, Number(s.minOrderAmount) - Number(s.subtotal))),
    }));
}
