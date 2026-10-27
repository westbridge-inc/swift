// [TAP-AUDIT 27 Oct · owner: "every single button tap"] The cart's + and − answer at the tap, and no tap is lost.
//
// Before: one add or +/− disabled EVERY + on the store page (one shared "busy") until the write answered, and the
// number moved only after the write AND the cart's re-quote (2 round trips, ~1.3 s on a mobile link). Worse, a + tapped
// after the write answered but before the re-quote landed sent the OLD quantity again (1 -> + -> + ended at 2, not 3).
//
// Now each line (or option-less item) keeps the quantity the customer has tapped to (`target`): the number shows it at
// once, and the cart is told the target — one request at a time per line, the next only after the cart has been read
// again (so a request is never built from a quantity the screen has not seen). Taps made meanwhile add up into the
// target, which is sent next. Totals and the Place order button still wait for the server's quote (`settled`).
// Prices are never computed here: only the quantity the customer asked for.

export const MAX_CART_QTY = 99;

/** One line's taps: what the customer tapped to, and whether a request or the cart's re-read is still on its way. */
export type Stepper = { target: number; inFlight: boolean; awaitingRead: boolean };

/** What to tell the server next: add N of an item not in the cart yet (the server adds to a line), or set a line. */
export type CartSend = { kind: 'add'; quantity: number } | { kind: 'set'; lineId: string; quantity: number };

export function clampQty(n: number): number {
  return Math.max(0, Math.min(MAX_CART_QTY, Math.round(Number.isFinite(n) ? n : 0)));
}

/** The line's quantity as the server last answered it (no line = none in the cart). */
export function heldQty(line: { quantity?: unknown } | null | undefined): number {
  const q = Number(line?.quantity);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/** A tap to a new quantity: from what the screen shows (the target while taps are pending, else the server's). */
export function tapTo(s: Stepper | undefined, next: number): Stepper {
  return { target: clampQty(next), inFlight: s?.inFlight ?? false, awaitingRead: s?.awaitingRead ?? false };
}

/** The request to send now, or null: one at a time per line, and never before the cart has been read again. */
export function nextSend(s: Stepper, line: { id: string; quantity?: unknown } | null | undefined): CartSend | null {
  if (s.inFlight || s.awaitingRead) return null;
  if (s.target === heldQty(line)) return null;
  if (line) return { kind: 'set', lineId: line.id, quantity: s.target };
  // Not in the cart yet: add what was tapped. Taking it below zero needs nothing; a decrease waits for the line.
  return s.target > 0 ? { kind: 'add', quantity: s.target } : null;
}

/** The server holds what the customer tapped to and nothing is on its way: the line needs no more help. */
export function isSettled(s: Stepper, line: { quantity?: unknown } | null | undefined): boolean {
  return !s.inFlight && !s.awaitingRead && heldQty(line) === s.target;
}
