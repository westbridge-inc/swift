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

/** Server diagnostics must never become checkout instructions. Preserve the
 * original error for status/code decisions; display only customer copy. */
export function cartErrorMessage(error: unknown, fallback = 'Could not update your cart. Please try again.'): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Please sign in again to continue.';
    const messages: Record<string, string> = {
      DELIVERY_NO_RIDERS: 'No delivery riders are online right now. Please try again shortly.',
      VENDOR_CLOSED: 'This store is closed right now. Please try again when it opens.',
      INSUFFICIENT_STOCK: 'There are not enough of an item available. Reduce its quantity or remove it.',
      ITEM_UNAVAILABLE: 'An item is no longer available. Remove it before ordering.',
      ID_VERIFICATION_REQUIRED: 'Please verify your identity in the Swift phone app before ordering.',
      ACCOUNT_RESTRICTED: 'Your account cannot place orders right now. Contact support for help.',
      STRIKE_RESTRICTED: 'Please verify your identity in the Swift phone app before ordering. Contact support if you need help.',
      OUT_OF_RANGE: 'This store cannot deliver to that address. Choose a closer delivery address.',
      MIN_ORDER: 'Add more items to reach this store’s minimum order amount.',
      CART_CHANGED: 'Your cart changed. Review your items and total before ordering again.',
    };
    if (error.code && messages[error.code]) return messages[error.code]!;
    if (error.code?.startsWith('MMG_')) return 'MMG is unavailable for this order. Review your payment choice and try again.';
  }
  return fallback;
}
