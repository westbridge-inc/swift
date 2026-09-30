import type { BillingDunningClock, Prisma, Subscription } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** A settled period requires its captured original payment and matching
 * successful charge record, including durably recorded zero-fee periods. */
export async function settledFeePeriodInTx(tx: Tx, sub: Subscription, start: Date, end: Date) {
  const payments = await tx.subscriptionPayment.findMany({ where: { subscriptionId: sub.id,
    status: 'CAPTURED', paidAt: { not: null }, externalRef: { not: null }, periodStart: start, periodEnd: end } });
  const matches = [];
  for (const payment of payments) {
    const event = await tx.billingEvent.findFirst({ where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS',
      idempotencyKey: `success:${sub.id}:${start.toISOString().slice(0, 10)}`, paymentRef: payment.externalRef,
      amount: payment.amount, currencyCode: sub.currencyCode } });
    if (event) matches.push({ payment, event });
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** A settled period may authorize one voluntary restart. The immutable
 * transition's unique payment identity also covers restarting exactly at period
 * end, where changing the due date alone would not consume the proof. */
export async function voluntaryResumeProofInTx(tx: Tx, sub: Subscription, clock: BillingDunningClock) {
  if (clock.subscriptionId !== sub.id || clock.pausedAt || sub.failedAttempts !== 0
    || sub.nextBillingDate.getTime() !== sub.currentPeriodEnd.getTime()
    || clock.dueAt.getTime() !== sub.currentPeriodEnd.getTime()) return null;
  const proof = await settledFeePeriodInTx(tx, sub, sub.currentPeriodStart, sub.currentPeriodEnd);
  if (!proof || await tx.billingObligationTransition.findUnique({ where: { paymentId_kind: { paymentId: proof.payment.id, kind: 'VOLUNTARY_RESUME' } } })) return null;
  const paidAdvance = await tx.billingObligationTransition.findUnique({ where: { paymentId_kind: { paymentId: proof.payment.id, kind: 'PAID' } } });
  if (paidAdvance ? paidAdvance.clockId !== clock.id || paidAdvance.toEpoch !== clock.epoch
    || paidAdvance.toDue.getTime() !== clock.dueAt.getTime() : clock.epoch !== 1) return null;
  const authority = clock.moverPayerUserId ? await tx.moverFeeAuthority.findUnique({
    where: { userId: clock.moverPayerUserId }, include: { members: true } }) : null;
  const ids = authority?.members.map((m) => m.subscriptionId) ?? [sub.id];
  // An issued instruction remains a liability after a bound decline. Changing
  // a rail never voids the fee obligation for which it was issued.
  if (await tx.subscriptionPayment.findFirst({ where: { subscriptionId: { in: ids }, periodStart: { gte: clock.dueAt } } })) return null;
  for (const id of ids) if (await tx.billingEvent.findFirst({ where: { subscriptionId: id, type: 'CHARGE_ATTEMPT',
    idempotencyKey: { startsWith: `charge:${id}:${clock.dueAt.toISOString().slice(0, 10)}` } } })) return null;
  return proof;
}

export async function voluntaryLapseInTx(tx: Tx, sub: Subscription, clock: BillingDunningClock,
  proof: NonNullable<Awaited<ReturnType<typeof settledFeePeriodInTx>>>) {
  return tx.billingEvent.findFirst({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE',
    idempotencyKey: `pause:${sub.id}:${clock.id}:${clock.epoch}`, paymentRef: proof.payment.externalRef,
    amount: proof.payment.amount, currencyCode: sub.currencyCode } });
}
