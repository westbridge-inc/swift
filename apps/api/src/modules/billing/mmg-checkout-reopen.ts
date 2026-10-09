import type { PrismaClient } from '@prisma/client';
import { billingEffectsReady } from './billing-cutover';
import { ACTIVE_CONFIRMATION_STATES, confirmationSources } from './dunning-clock';
import { unresolvedConfirmationSources } from './fee-payment-authority';
import { readFeeCollectionAuthority } from '../subscription/mover-fee-authority';

export interface ReopenableMmgCheckout { ref: string; expiresAt: string }

/** A read-only hint for reopening one existing page, never permission for a
 * new payment. The reopen POST reads it again for the ref it names and then
 * repeats the locked authority before handing out a URL. The caller checks the
 * switches and that the payer is in a production tenant. */
export async function readReopenableMmgCheckout(
  db: PrismaClient, subscriptionId: string, ref: string, now: Date,
): Promise<ReopenableMmgCheckout | null> {
  return db.$transaction(async (tx) => {
    if (!await billingEffectsReady(tx)) return null;
    const authority = await readFeeCollectionAuthority(tx, subscriptionId);
    if (!authority.allowed) return null;
    const [sub, clock, latest] = await Promise.all([
      tx.subscription.findUnique({ where: { id: subscriptionId } }),
      tx.billingDunningClock.findUnique({ where: { subscriptionId } }),
      tx.mmgCheckoutIntent.findFirst({ where: { subscriptionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    ]);
    if (!sub || !clock || !latest || latest.id !== ref || latest.status !== 'OPEN' || latest.expiresAt <= now
      || clock.subscriptionId !== subscriptionId || !clock.pausedAt || clock.authorityHoldReason
      || clock.dueAt.getTime() !== sub.nextBillingDate.getTime()
      || (authority.mover && (clock.moverPayerUserId !== authority.mover.payerUserId
        || clock.tenantId !== authority.mover.tenantId || clock.authorityRevision !== authority.mover.revision))) return null;
    const sourceIds = authority.mover?.sourceSubscriptionIds ?? [subscriptionId];
    const [holds, census, pendingCards] = await Promise.all([
      tx.paymentConfirmationHold.findMany({ where: {
        OR: [{ clockId: clock.id }, { subscriptionId: { in: sourceIds } }],
        status: { in: ACTIVE_CONFIRMATION_STATES },
      } }),
      confirmationSources(tx, sourceIds),
      // Card payment rows may precede discovery of their session/hold.
      tx.subscriptionPayment.count({ where: { subscriptionId: { in: sourceIds }, paymentMethod: 'CARD', status: { in: ['PENDING', 'UNKNOWN'] } } }),
    ]);
    const own = holds[0];
    if (holds.length !== 1 || !own || own.status !== 'ACTIVE' || own.checkoutId !== latest.id
      || own.subscriptionId !== subscriptionId || own.clockId !== clock.id || own.sourceEpoch !== clock.epoch
      || pendingCards) return null;
    // [review F3] The census lists resolved history too: the SAME per-source
    // hold filter as the new-payment rule decides what is still unresolved,
    // and the only unresolved source must be this checkout.
    const unresolved = await unresolvedConfirmationSources(tx, census.sources, clock.id, 2);
    const source = unresolved[0]?.source;
    if (unresolved.length !== 1 || !source || !('checkoutId' in source) || source.checkoutId !== latest.id) return null;
    return { ref: latest.id, expiresAt: latest.expiresAt.toISOString() };
  }, { isolationLevel: 'RepeatableRead' });
}
