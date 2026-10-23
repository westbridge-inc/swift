/**
 * [STORE-DASH · owner 22 Oct 2026, O-4] What a store may do with a waiting
 * order's items, and when it waits for the customer — one plain file (no
 * React Native imports), read by the phone (shared.tsx, the order screen, the
 * takeover) and imported as is by the web dashboard, so the two never drift.
 *
 * The server's contract (STORE-FLOW, #2043):
 * - On a waiting (PENDING) order, every store type, "Out of stock" on a line
 *   asks the customer: POST .../refund-line makes a REMOVAL question (line
 *   subStatus PENDING, nothing proposed); POST .../substitute makes a swap
 *   question. The customer agrees to the changed total before paying and is
 *   never charged for an item not supplied; no answer by the deadline = the
 *   item comes off and the total only goes down.
 * - Accept is refused while any line's question is open (409 CUSTOMER_DECIDING)
 *   and when every line came off (409 NOTHING_TO_ACCEPT: reject with a reason).
 * - Ticks are optional; there are no tick boxes before Accept.
 *
 * [REVIEW-F S4-2 on #2032] The money-moved set lives here once: an MMG order
 * moves only after its money moved (CAPTURED, or the store's own CLAIMED
 * report) — the server's MMG_MONEY_MOVED.
 */

export const MMG_MONEY_MOVED = ['CAPTURED', 'CLAIMED'] as const;

type OrderLike = { status?: unknown; paymentMethod?: unknown; paymentStatus?: unknown; items?: unknown } | null | undefined;
type LineLike = { subStatus?: unknown; substituteName?: unknown } | null | undefined;

const linesOf = (order: OrderLike): LineLike[] => (Array.isArray(order?.items) ? (order!.items as LineLike[]) : []);
const waiting = (order: OrderLike) => ['PENDING', 'PLACED'].includes(String(order?.status ?? '').toUpperCase());

/** An MMG order whose money has not moved yet: "Paid by MMG" is its one step after Accept. */
export function mmgAwaitingPayment(order: OrderLike): boolean {
  return order?.paymentMethod === 'MOBILE_MONEY' && !(MMG_MONEY_MOVED as readonly unknown[]).includes(order?.paymentStatus);
}

/** The line's open question to the customer, if any: a removal (nothing proposed) or a swap. */
export function lineQuestion(line: LineLike): 'removal' | 'swap' | null {
  if (line?.subStatus !== 'PENDING') return null;
  return typeof line?.substituteName === 'string' && line.substituteName.trim() !== '' ? 'swap' : 'removal';
}

/** The customer is answering an "Out of stock" question: the store waits to accept. */
export function customerDeciding(order: OrderLike): boolean {
  return waiting(order) && linesOf(order).some((l) => lineQuestion(l) !== null);
}

/** Every item came off a waiting order: there is nothing to accept. */
export function nothingToAccept(order: OrderLike): boolean {
  const lines = linesOf(order);
  return waiting(order) && lines.length > 0 && lines.every((l) => l?.subStatus === 'REFUNDED' || l?.subStatus === 'REJECTED');
}

/** "Out of stock" is one tap on a line of a waiting order that has not been asked about yet. */
export function canMarkOutOfStock(order: OrderLike, line: LineLike): boolean {
  if (!waiting(order)) return false;
  const sub = line?.subStatus;
  return sub == null || sub === 'NONE';
}

/** The store's words, phone and web alike. */
export const OUT_OF_STOCK_WORDS = {
  button: 'Out of stock',
  removalAsked: 'Asked the customer: continue without it, or cancel',
  swapAsked: (name: string) => `Asked the customer about a swap: ${name}`,
  removed: 'Removed — not charged',
  declined: 'Swap declined — removed',
  deciding: 'Waiting on the customer’s answer — accept after they reply.',
  nothing: 'Every item is out of stock — reject the order with a reason.',
} as const;

/** What a line says about its out-of-stock state, or null when there is nothing to say. */
export function lineStockWords(line: LineLike): string | null {
  const q = lineQuestion(line);
  if (q === 'removal') return OUT_OF_STOCK_WORDS.removalAsked;
  if (q === 'swap') return OUT_OF_STOCK_WORDS.swapAsked(String(line?.substituteName));
  if (line?.subStatus === 'REFUNDED') return OUT_OF_STOCK_WORDS.removed;
  if (line?.subStatus === 'REJECTED') return OUT_OF_STOCK_WORDS.declined;
  return null;
}
