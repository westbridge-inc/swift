import type { PrismaClient } from '@prisma/client';
import { billingEffectsReady } from './billing-cutover';
import { ACTIVE_CONFIRMATION_STATES, confirmationSources } from './dunning-clock';
import { readFeeCollectionAuthority } from '../subscription/mover-fee-authority';

export interface ReopenableMmgCheckout { ref: string; expiresAt: string }

/** A read-only hint for reopening one existing page, never permission for a
 * new payment. The POST repeats the locked authority before handing out a URL. */
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
    const [holds, unresolved, pendingCards] = await Promise.all([
      tx.paymentConfirmationHold.findMany({ where: {
        OR: [{ clockId: clock.id }, { subscriptionId: { in: sourceIds } }],
        status: { in: ACTIVE_CONFIRMATION_STATES },
      } }),
      confirmationSources(tx, sourceIds),
      // Card payment rows may precede discovery of their session/hold.
      tx.subscriptionPayment.count({ where: { subscriptionId: { in: sourceIds }, paymentMethod: 'CARD', status: { in: ['PENDING', 'UNKNOWN'] } } }),
    ]);
    const own = holds[0];
    const source = unresolved.sources[0]?.source;
    if (holds.length !== 1 || !own || own.status !== 'ACTIVE' || own.checkoutId !== latest.id
      || own.subscriptionId !== subscriptionId || own.clockId !== clock.id || own.sourceEpoch !== clock.epoch
      || pendingCards || unresolved.sources.length !== 1 || !source || !('checkoutId' in source) || source.checkoutId !== latest.id) return null;
    return { ref: latest.id, expiresAt: latest.expiresAt.toISOString() };
  }, { isolationLevel: 'RepeatableRead' });
}
