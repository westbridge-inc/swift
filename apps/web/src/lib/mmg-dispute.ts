/**
 * [Item 10 · S1-6] A direct-MMG order the customer and the store disagree
 * about is paused until a person at Swift resolves it.
 *
 * The server refuses every forward step on it (409 MMG_CLAIM_MISMATCH) and
 * returns `mmgClaimMismatchAt` on the store's order reads. The phone already
 * shows the pause (apps/mobile/src/modules/vendor/order-dispute.ts); the web
 * board now says the same thing in the same words and withholds every forward
 * button, so a store never taps one that can only fail. Declining stays.
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

export const MMG_DISPUTE_NOTICE = {
  title: 'Payment under review — order paused',
  body: 'The customer disputes the MMG payment for this order. Swift support is checking it and will tell you when the order can move. Don’t hand anything over until then.',
} as const;
