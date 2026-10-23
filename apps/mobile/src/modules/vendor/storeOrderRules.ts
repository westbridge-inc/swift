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

/**
 * [REVIEW-F S3-2 on #2048 · with #2043 S3-1] The line is the order's LAST item still coming: every
 * other line came off, or is already being asked about for removal. Asking the customer about it
 * would offer a "Continue without it" that empties the order, so the step is Reject (out of stock).
 */
export function lastLineStanding(order: OrderLike, line: LineLike): boolean {
  if (!canMarkOutOfStock(order, line)) return false;
  const coming = linesOf(order).filter((l) => l?.subStatus !== 'REFUNDED' && l?.subStatus !== 'REJECTED' && lineQuestion(l) !== 'removal');
  return coming.length === 1 && coming[0] === line;
}

/**
 * [REVIEW-F S3-1 on #2048] The customer answered: orders the store asked about (`asked`) that are
 * waiting again with no open question are the store's decision again — the phone re-raises the
 * new-order screen for them (the server sends no push for an answer, and the store's response
 * clock restarts from it). Returns those, and the orders still being decided (the next `asked`).
 */
export function answeredSinceAsked(
  asked: ReadonlySet<string>,
  board: unknown,
): { answered: Array<{ orderId: string; orderNumber?: string }>; deciding: Set<string> } {
  const orders = Array.isArray(board) ? (board as Array<{ id?: unknown; orderNumber?: unknown } & NonNullable<OrderLike>>) : [];
  const deciding = new Set<string>();
  const answered: Array<{ orderId: string; orderNumber?: string }> = [];
  for (const o of orders) {
    if (typeof o?.id !== 'string') continue;
    if (customerDeciding(o)) deciding.add(o.id);
    else if (asked.has(o.id) && waiting(o)) answered.push({ orderId: o.id, ...(typeof o.orderNumber === 'string' ? { orderNumber: o.orderNumber } : {}) });
  }
  return { answered, deciding };
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
  // [REVIEW-F S3-2 on #2048] The last item: the step is Reject, asked once (it cannot be undone).
  lastButton: 'Out of stock — reject the order',
  lastAsk: 'This is the last item. Reject the order as out of stock? The customer is told right away.',
  lastYes: 'Yes, reject',
  lastKeep: 'Keep it',
  /** The reject reason a last-item rejection sends (the store's own preset). */
  lastReason: 'Out of stock',
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

// ─── O-2 hand-overs (owner ruling 22 Oct 19:45Z; server contract STORE-FLOW 07:58Z) ───────────────
// - Takeaway: the store's requirePickupCode setting is OFF by default; the server says per order
//   (pickupCodeRequired). Off = "Handed to customer" in one tap, after checking the customer's first
//   name and the order number (PUT complete-pickup with no code). On = today's typed code.
// - Delivery with a Swift rider: "Handed to rider" (PUT handed-to-rider) writes one status-log row;
//   custody stays the rider's "Picked up". Shown only when the server knows the step (the order
//   carries handedToRiderAt), so an older server never gets a request it cannot answer.

type HandoverOrder = {
  status?: unknown; fulfillment?: unknown; fulfillmentMode?: unknown; riderId?: unknown; rider?: unknown;
  pickupCodeRequired?: unknown; handedToRiderAt?: unknown;
} | null | undefined;

/** The takeaway hand-over needs no code: the store's setting is off. Unknown (an older server) = the code is still needed. */
export function handoverNeedsNoCode(order: HandoverOrder): boolean {
  return order?.pickupCodeRequired === false;
}

const RIDER_AT_STORE = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'READY_FOR_PICKUP', 'READY'];

/** "Handed to rider" may be tapped: a Swift-rider delivery with its rider assigned, not marked yet, on a server that knows the step. */
export function canMarkHandedToRider(order: HandoverOrder): boolean {
  if (!order || !('handedToRiderAt' in order) || order.handedToRiderAt) return false;
  if (order.fulfillment !== 'DELIVERY' || order.fulfillmentMode === 'VENDOR_DELIVERY') return false;
  if (!order.riderId && !order.rider) return false;
  return RIDER_AT_STORE.includes(String(order.status ?? '').toUpperCase());
}

type RiderLike = { user?: { firstName?: unknown } | null; vehicleType?: unknown; vehicleMake?: unknown; vehicleModel?: unknown; vehicleColor?: unknown; licensePlate?: unknown; photoUrl?: unknown } | null | undefined;
const word = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** What the store checks at the hand-over: the rider's first name and vehicle (colour make model · plate). */
export function riderHandoverLine(rider: RiderLike): string | null {
  const name = word(rider?.user?.firstName);
  const vehicle = [word(rider?.vehicleColor), word(rider?.vehicleMake), word(rider?.vehicleModel)].filter(Boolean).join(' ') || word(rider?.vehicleType);
  const plate = word(rider?.licensePlate);
  const parts = [name, [vehicle, plate].filter(Boolean).join(' · ') || null].filter(Boolean);
  return parts.length ? parts.join(' — ') : null;
}

/** The rider's photo, only as the server's resolved address (never a raw storage key). */
export function riderPhotoUrl(rider: RiderLike): string | null {
  const url = word(rider?.photoUrl);
  return url && /^https?:\/\//.test(url) ? url : null;
}

export const HANDOVER_WORDS = {
  toRider: 'Handed to rider',
  toCustomer: 'Handed to customer',
  checkName: (firstName: unknown, orderNumber: unknown) =>
    `Check the name before you hand it over: ${word(firstName) ?? 'the customer'} · order #${word(orderNumber) ?? ''}`.trimEnd(),
  checkRider: 'Check the rider before you hand it over:',
  handedToRider: 'Handed to the rider',
  settingTitle: 'Ask for the pickup code',
  settingOn: 'Customers collecting an order read out their code; you type it.',
  settingOff: 'You hand takeaway orders over after checking the customer’s first name and order number.',
} as const;
