import { apiFetch } from './auth';
import type { Cart } from './customer';

/**
 * [E01 · W5] The checkout's quote for the customer's choices. The fields mean
 * exactly what the checkout body's fields of these names mean (GET /cart
 * takes them as a query). Only the checkout asks for a priced choice, so this
 * lives apart from the shared customer module every page loads.
 */
export type CartQuoteChoices = { fulfillmentSelections?: Record<string, 'DELIVERY' | 'PICKUP'>; tipAmount?: number };

export async function getCartQuote(choices?: CartQuoteChoices): Promise<Cart> {
  const query = new URLSearchParams();
  if (choices?.fulfillmentSelections) query.set('fulfillmentSelections', JSON.stringify(choices.fulfillmentSelections));
  if (choices?.tipAmount !== undefined) query.set('tipAmount', String(choices.tipAmount));
  const qs = query.toString();
  const data = (await apiFetch(`/api/v1/customer/cart${qs ? `?${qs}` : ''}`)).data as Cart | null;
  return data ?? { items: [] };
}

/** [W5 · review S2] Take the promotion off the saved cart. A cart with a
 *  promotion is ordered in the phone app for now (owner ruling, 8 Oct). */
export async function removeCartPromotion(): Promise<void> {
  await apiFetch('/api/v1/customer/cart/promo', { method: 'DELETE' });
}

/** [W5] The stores a cart's quote prices, from its own lines (sorted, so an
 *  unchanged cart gives an unchanged selection). */
export function quoteStoreIds(items: Cart['items'] | null | undefined): string[] {
  return [...new Set((items ?? []).map((line) => line.vendorId).filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
}

/**
 * [W5] Pickup, priced the way the phone app prices it (cartQuote.ts
 * cartPricingChoices; pickup.test.tsx holds the two equal): the one pickup
 * choice applies to EVERY store in the basket, and with no rider there is no
 * rider tip. The same object prices the quote and goes in the order.
 */
export function pickupChoices(storeIds: readonly string[]): Required<CartQuoteChoices> {
  return { fulfillmentSelections: Object.fromEntries(storeIds.map((id) => [id, 'PICKUP' as const])), tipAmount: 0 };
}
