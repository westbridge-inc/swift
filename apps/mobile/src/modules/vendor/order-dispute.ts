/**
 * [NO-DEAD-ENDS · S1-6] A direct-MMG order the customer and the store disagree
 * about is paused until a person at Swift resolves it.
 *
 * The server refuses every forward step on it (409 MMG_CLAIM_MISMATCH) and
 * returns `mmgClaimMismatchAt` on the store's order reads, but the store's
 * board and order screen ignored it: the order looked like any other, with an
 * Accept / Start preparing / Mark ready button that failed on every tap. The
 * customer's screen already says "Payment under review · order paused"; the
 * store now sees the same truth, no forward button, and what happens next.
 *
 * Declining stays exactly where it was (the server allows it); nothing new is
 * offered. Pure: no React Native imports, so it is unit-testable.
 */
const TERMINAL = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED']);

export function mmgDisputePaused(order: {
  paymentMethod?: unknown; orderType?: unknown; status?: unknown; mmgClaimMismatchAt?: unknown;
} | null | undefined): boolean {
  if (!order) return false;
  if (order.paymentMethod !== 'MOBILE_MONEY') return false;
  if (order.orderType === 'TAXI') return false;
  if (TERMINAL.has(String(order.status ?? '').toUpperCase())) return false;
  return order.mmgClaimMismatchAt != null && order.mmgClaimMismatchAt !== false && order.mmgClaimMismatchAt !== '';
}

/** While paused, only a decline the board already offered survives; every forward step is withheld. */
export function withoutForwardWorkWhilePaused<A extends { action: string }>(order: Parameters<typeof mmgDisputePaused>[0], actions: A[]): A[] {
  return mmgDisputePaused(order) ? actions.filter((a) => a.action === 'reject') : actions;
}

export const MMG_DISPUTE_NOTICE = {
  title: 'Payment under review — order paused',
  body: 'The customer disputes the MMG payment for this order. Swift support is checking it and will tell you when the order can move. Don’t hand anything over until then.',
} as const;
