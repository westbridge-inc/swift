import type { Prisma } from '@prisma/client';
import { ACTIVE_CONFIRMATION_STATES, feeReversalOpenInTx, lateCardApprovalHeldInTx } from './dunning-clock';

/**
 * A payment of this subscription's weekly fee that is not settled yet — an open or confirming MMG checkout, a
 * confirmation hold, a held late card approval, a reversal: its quote must not change under it. ONE predicate for every
 * path that moves a fee outside a charge: a chain deal (vendor/chain-deal.ts) and a card price cut (card-price-cut.ts).
 */
export async function paymentInFlightInTx(tx: Prisma.TransactionClient, subscriptionId: string): Promise<boolean> {
  const [checkout, hold] = await Promise.all([
    tx.mmgCheckoutIntent.findFirst({ where: { subscriptionId, status: { in: ['OPEN', 'CONFIRMING'] } }, select: { id: true } }),
    tx.paymentConfirmationHold.findFirst({ where: { subscriptionId, status: { in: [...ACTIVE_CONFIRMATION_STATES] } }, select: { id: true } }),
  ]);
  return !!checkout || !!hold || await lateCardApprovalHeldInTx(tx, [subscriptionId]) || await feeReversalOpenInTx(tx, [subscriptionId]);
}
