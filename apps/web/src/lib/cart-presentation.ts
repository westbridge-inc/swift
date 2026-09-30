import { ApiRequestError } from './auth';
import type { Cart, CartLine } from './customer';

export function cartStoreGroups(cart: Cart): Array<{ id: string | null; name: string; items: CartLine[] }> {
  const groups = new Map<string | null, { id: string | null; name: string; items: CartLine[] }>();
  for (const item of cart.items) {
    // Older responses lack vendorId. Keep those items unassigned until the
    // existing live-menu check proves them; never guess from cart.vendor.
    const id = item.vendorId || null;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: cart.vendors?.find((vendor) => vendor.vendorId === id)?.name
        ?? (id === cart.vendor?.id ? cart.vendor?.name : undefined)
        ?? item.vendorName ?? (id ? 'Store' : 'Items to review'), items: [] };
      groups.set(id, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

export type CartStockRefusal = { itemId: string; available: number; message: string };

/** Only structured identity can mark a row; never infer it from prose. */
export function cartStockRefusal(error: unknown, cart?: Cart | null): CartStockRefusal | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'INSUFFICIENT_STOCK'
    || !error.details || typeof error.details !== 'object') return null;
  const { itemId, available } = error.details as Record<string, unknown>;
  if (typeof itemId !== 'string' || typeof available !== 'number'
    || !Number.isSafeInteger(available) || available < 0) return null;
  const item = cart?.items.find((line) => line.itemId === itemId);
  if (!item) return null;
  return { itemId, available, message: available === 0
    ? `${item.name} is sold out — remove it to continue`
    : `Only ${available} ${item.name} left — change the quantity` };
}

/** Known refusals get customer copy; unmapped definite refusals retain their
 * user-facing message. Transport failures and uncertain responses use fallback. */
export function cartErrorMessage(error: unknown, fallback = 'Could not update your cart. Please try again.', cart?: Cart | null): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Please sign in again to continue.';
    const stock = cartStockRefusal(error, cart);
    if (stock) return stock.message;
    if (error.code === 'VENDOR_AT_CAPACITY') {
      return `${cart?.vendor?.name || 'This store'} is very busy right now — try again in a few minutes`;
    }
    if (error.code === 'VENDOR_TIER_CAP' && error.message.trim()) return error.message;
    // Older responses may omit structured stock details, but still carry
    // the item's name and remaining quantity in their customer message.
    if (error.code === 'INSUFFICIENT_STOCK' && /^(Only \d+ of .+ left — reduce the quantity|.+ is sold out)$/.test(error.message)) {
      return error.message;
    }
    const messages: Record<string, string> = {
      DELIVERY_NO_RIDERS: 'No delivery riders are online right now. Please try again shortly.',
      VENDOR_TIER_CAP: 'This store has reached its order limit. Please try again later.',
      VENDOR_CLOSED: 'This store is closed right now. Please try again when it opens.',
      INSUFFICIENT_STOCK: 'There are not enough of an item available. Reduce its quantity or remove it.',
      ITEM_UNAVAILABLE: 'An item is no longer available. Remove it before ordering.',
      ID_VERIFICATION_REQUIRED: 'Please verify your identity in the Swift phone app before ordering.',
      ACCOUNT_RESTRICTED: 'Your account cannot place orders right now. Contact support for help.',
      STRIKE_RESTRICTED: 'Please verify your identity in the Swift phone app before ordering. Contact support if you need help.',
      OUT_OF_RANGE: 'This store cannot deliver to that address. Choose a closer delivery address.',
      MIN_ORDER: 'Add more items to reach this store’s minimum order amount.',
      CART_CHANGED: 'Your cart changed. Review your items and total before ordering again.',
      PROMO_WRONG_VENDOR: 'This promo code was for another store. Remove it to continue.',
      INVALID_PROMO: 'This promo code is no longer available. Remove it to continue.',
      EXPIRED_PROMO: 'This promo code has expired. Remove it to continue.',
      USED_PROMO: 'This promo code cannot be used again. Remove it to continue.',
      MIN_ORDER_PROMO: 'Your order no longer meets the minimum amount for this promo code. Remove it to continue.',
      PROMO_UNAVAILABLE_CASH_DELIVERY: 'This promo code cannot be used for cash delivery. Remove it to continue.',
    };
    if (error.code && messages[error.code]) return messages[error.code]!;
    if (error.code?.startsWith('MMG_')) return 'MMG is unavailable for this order. Review your payment choice and try again.';
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.code !== 'DUPLICATE_REQUEST') {
      return error.message.trim() || 'Could not place this order. Review your cart and try again.';
    }
  }
  return fallback;
}
