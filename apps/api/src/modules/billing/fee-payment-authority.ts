import type { Prisma, PrismaClient } from '@prisma/client';
import { billingEffectsReady } from './billing-cutover';
import { ACTIVE_CONFIRMATION_STATES, confirmationSources, currentDunningClock, type ConfirmationSource } from './dunning-clock';
import { lockFeeCollectionAuthority, readFeeCollectionAuthority } from '../subscription/mover-fee-authority';

export type FeePaymentDecision =
  | { allowed: true; reason: null }
  | { allowed: false; reason: 'BILLING_PREPARING' | 'BILLING_REVIEW_REQUIRED' | 'PAYMENT_CONFIRMING' };
const allow: FeePaymentDecision = { allowed: true, reason: null };
const blocked = (reason: Exclude<FeePaymentDecision['reason'], null>): FeePaymentDecision => ({ allowed: false, reason });

/** Call inside the payer/source transaction. Commit a blocked result before
 * throwing an API error: source discovery must retain its pause and evidence.
 * A replay may exempt only its own current unresolved instruction. */
export async function lockFeePaymentDecision(
  tx: Prisma.TransactionClient, subscriptionId: string, now: Date, replay?: ConfirmationSource,
): Promise<FeePaymentDecision> {
  const authority = await lockFeeCollectionAuthority(tx, subscriptionId);
  const clock = await currentDunningClock(tx, subscriptionId, now);
  if (!await billingEffectsReady(tx)) return blocked('BILLING_PREPARING');
  if (!authority.allowed || clock.authorityHoldReason || clock.subscriptionId !== subscriptionId) return blocked('BILLING_REVIEW_REQUIRED');
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  if (clock.dueAt.getTime() !== sub.nextBillingDate.getTime()) return blocked('BILLING_REVIEW_REQUIRED');
  const holds = await tx.paymentConfirmationHold.findMany({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } } });
  if (!replay) return holds.length || clock.pausedAt ? blocked('PAYMENT_CONFIRMING') : allow;
  const own = holds.find((hold) => Object.entries(replay).every(([field, id]) => hold[field as keyof typeof hold] === id));
  if (!own || own.subscriptionId !== subscriptionId || own.sourceEpoch !== clock.epoch || own.status !== 'ACTIVE'
    || !clock.pausedAt || holds.some((hold) => hold.id !== own.id)) return blocked('PAYMENT_CONFIRMING');
  return allow;
}

/** Read-only display hint for NEW Pay actions. It cannot reserve or emit a
 * payable instruction. Missing/stale clock coverage fails closed; the write
 * path repeats the locked decision immediately before reservation/handoff. */
export async function readFeePaymentDecision(db: PrismaClient, subscriptionId: string): Promise<FeePaymentDecision> {
  return db.$transaction(async (tx) => {
    if (!await billingEffectsReady(tx)) return blocked('BILLING_PREPARING');
    const authority = await readFeeCollectionAuthority(tx, subscriptionId);
    if (!authority.allowed) return blocked('BILLING_REVIEW_REQUIRED');
    const [sub, clock] = await Promise.all([
      tx.subscription.findUnique({ where: { id: subscriptionId } }),
      tx.billingDunningClock.findUnique({ where: { subscriptionId } }),
    ]);
    if (!sub || !clock || clock.dueAt.getTime() !== sub.nextBillingDate.getTime()
      || clock.authorityHoldReason || (authority.mover && (clock.moverPayerUserId !== authority.mover.payerUserId
        || clock.tenantId !== authority.mover.tenantId || clock.authorityRevision !== authority.mover.revision))) return blocked('BILLING_REVIEW_REQUIRED');
    if (clock.pausedAt || await tx.paymentConfirmationHold.count({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } } })) return blocked('PAYMENT_CONFIRMING');
    const { sources } = await confirmationSources(tx, authority.mover?.sourceSubscriptionIds ?? [subscriptionId]);
    for (const source of sources) {
      const hold = await tx.paymentConfirmationHold.findFirst({ where: source.source });
      if (!hold || hold.clockId !== clock.id || ACTIVE_CONFIRMATION_STATES.includes(hold.status)) return blocked('PAYMENT_CONFIRMING');
    }
    return allow;
  });
}
