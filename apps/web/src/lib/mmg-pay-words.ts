/**
 * What the store is told about an MMG order's payment, in one place for the
 * board's cards and the order window.
 *
 * Money has moved when the provider captured it (CAPTURED) or the store has
 * reported it landed (CLAIMED — the store's own report is never recorded
 * as CAPTURED). The server lets both proceed (order.service.ts
 * MMG_MONEY_MOVED).
 */
export const MMG_MONEY_MOVED = ['CAPTURED', 'CLAIMED'] as const;
export function mmgMoneyMoved(paymentStatus: string | null | undefined): boolean {
  return (MMG_MONEY_MOVED as readonly string[]).includes(String(paymentStatus ?? ''));
}

/**
 * THE rule for every place the web can accept an order (the board card, the
 * new-order popup, the order window): payment-first — an MMG order is held
 * back until its money has moved; the server refuses it otherwise.
 */
export function acceptHeldForPayment(order: { paymentMethod?: string | null; paymentStatus?: string | null }): boolean {
  return order.paymentMethod === 'MOBILE_MONEY' && !mmgMoneyMoved(order.paymentStatus);
}

/** What a moved payment is called. A store's own report is never "confirmed":
 *  only the provider confirms (the receipt says "reported received by the
 *  store — not confirmed by the provider"). */
export function mmgMovedLabel(paymentStatus: string | null | undefined): string {
  return paymentStatus === 'CAPTURED' ? 'MMG payment received' : 'MMG payment reported received by your store';
}

/** Why a payment cannot be confirmed here, said instead of a button; null when there is nothing to say. */
const BLOCKED: Record<string, string> = {
  REFUNDED: 'This payment was refunded — a new payment is a new transaction.',
  PARTIALLY_REFUNDED: 'This payment was partly refunded — support settles the rest.',
  FAILED: 'MMG reports this payment as failed. Contact support with the reference if money did reach you.',
  EXPIRED: 'The payment window closed — ask the customer to pay again.',
  UNKNOWN: 'This payment is unresolved with MMG. Support settles it; it cannot be marked received here.',
  CANCELLED: 'This payment was superseded.',
};
export function mmgPayBlockedReason(paymentStatus: string | null | undefined): string | null {
  return BLOCKED[String(paymentStatus ?? '')] ?? null;
}
