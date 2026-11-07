// [TAP-AUDIT 27 Oct · owner: "every single button tap"] The cart's + and − answer at the tap, and no tap is lost.
//
// Before: one add or +/− disabled EVERY + on the store page (one shared "busy") until the write answered, and the
// number moved only after the write AND the cart's re-quote (2 round trips, ~1.3 s on a mobile link). Worse, a + tapped
// after the write answered but before the re-quote landed sent the OLD quantity again (1 -> + -> + ended at 2, not 3).
//
// Now each cart line (or option-less item not in the cart yet) keeps the quantity the customer has tapped to
// (`target`): the number shows it at once, and the cart is told the target — one request at a time per line, each
// built from what the server last said about THAT line: the write's own answer (POST and PUT /cart/items answer with
// the whole cart) or a fresh read of the cart, never a quantity nobody has confirmed. Taps made meanwhile add up into
// the target, which is sent next. A request goes again only for a NEW tap: a server that keeps a different quantity
// is believed, never argued with. Prices are never computed here: only the quantity the customer asked for.

export const MAX_CART_QTY = 99;

/** A cart line as the server sends it (only what a tap needs). */
export type CartLine = { id: string; itemId?: string; quantity?: unknown; selectedOptions?: unknown; specialInstructions?: unknown; fulfillment?: unknown };

/** What to tell the server next: add N of an item not in the cart yet (the server adds to a line), or set a line. */
export type CartSend = { kind: 'add'; quantity: number } | { kind: 'set'; lineId: string; quantity: number };

export function clampQty(n: number, max: number = MAX_CART_QTY): number {
  return Math.max(0, Math.min(max, Math.round(Number.isFinite(n) ? n : 0)));
}

/**
 * [BOOK-POLISH · #2205] A booking (an APPOINTMENT listing, or its cart line) is ONE appointment: the server refuses any
 * other number (APPOINTMENT_QUANTITY), so it has no + / − anywhere; the cart shows its time instead.
 */
export function isBooking(x: { fulfillment?: unknown } | null | undefined): boolean {
  return x?.fulfillment === 'APPOINTMENT';
}

/** The most a line may be tapped to: 1 for a booking, MAX_CART_QTY otherwise. */
export function maxQtyFor(line: { fulfillment?: unknown } | null | undefined): number {
  return isBooking(line) ? 1 : MAX_CART_QTY;
}

/** The line's quantity as the server last answered it (no line = none in the cart). */
export function heldQty(line: { quantity?: unknown } | null | undefined): number {
  const q = Number(line?.quantity);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/**
 * The request that takes a line from what the server holds to the tapped target, or null (nothing to send). `line`
 * null = the item has no line yet (a + adds it; a − has nothing to take).
 */
export function nextSend(target: number, line: CartLine | null): CartSend | null {
  if (target === heldQty(line)) return null;
  if (line) return { kind: 'set', lineId: line.id, quantity: target };
  return target > 0 ? { kind: 'add', quantity: target } : null;
}

/** The cart a cart write answered with (an empty one when its last line went); undefined when the answer is not one. */
export function answeredCart(answer: unknown): { items: CartLine[] } | undefined {
  if (!answer || typeof answer !== 'object' || !('cart' in answer)) return undefined;
  const cart = (answer as { cart: unknown }).cart;
  if (cart === null) return { items: [] };
  const items = cart && typeof cart === 'object' ? (cart as { items?: unknown }).items : undefined;
  return Array.isArray(items) ? { items: items as CartLine[] } : undefined;
}

/** No choice and no note: the line a store page's + adds to (the server merges the same item, choices and note). */
export function isPlainLine(line: CartLine): boolean {
  const options = line.selectedOptions;
  const chosen = options && typeof options === 'object'
    ? Object.values(options as Record<string, unknown>).some((v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== ''))
    : false;
  const note = typeof line.specialInstructions === 'string' ? line.specialInstructions.trim() : '';
  return !chosen && !note;
}
