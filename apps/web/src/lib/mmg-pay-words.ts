/**
 * What the store is told about an MMG order's payment, in one place for the
 * board's cards and the order window.
 *
 * Money has moved when the provider captured it (CAPTURED) or the store has
 * confirmed it landed (CLAIMED — the store's own confirmation is never
 * recorded as CAPTURED). The server lets both proceed (order.service.ts
 * MMG_MONEY_MOVED).
 */
export function mmgMoneyMoved(paymentStatus: string | null | undefined): boolean {
  return paymentStatus === 'CAPTURED' || paymentStatus === 'CLAIMED';
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
