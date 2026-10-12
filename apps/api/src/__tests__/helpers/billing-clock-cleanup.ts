import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Synthetic fixtures own these exact subscriptions. Production retention FKs
 * remain RESTRICT; tests explicitly remove their dependent clock evidence.
 * A mover payer's clock is keyed to their canonical subscription, so the
 * evidence of a member subscription can live on a clock keyed to another of
 * the payer's rows: every clock these subscriptions feed is removed whole. */
export async function cleanupBillingClocks(db: Db, subscriptionIds: readonly string[]) {
  if (!subscriptionIds.length) return;
  const subscriptionId = { in: [...subscriptionIds] };
  const clocks = await db.billingDunningClock.findMany({ where: { OR: [
    { subscriptionId },
    { holds: { some: { subscriptionId } } },
    { notices: { some: { subscriptionId } } },
    { obligationTransitions: { some: { OR: [{ subscriptionId }, { fromSubscriptionId: subscriptionId }] } } },
  ] }, select: { id: true } });
  const clockId = { in: clocks.map((c) => c.id) };
  await db.billingNoticeHandoff.deleteMany({ where: { notice: { OR: [{ subscriptionId }, { clockId }] } } });
  await db.billingFeeNotice.deleteMany({ where: { OR: [{ subscriptionId }, { clockId }] } });
  await db.paymentConfirmationHold.deleteMany({ where: { OR: [{ subscriptionId }, { clockId }] } });
  await db.billingObligationTransition.deleteMany({ where: { OR: [{ subscriptionId }, { fromSubscriptionId: subscriptionId }, { clockId }] } });
  await db.billingDunningClock.deleteMany({ where: { id: clockId } });
}

export async function cleanupPayerBillingClocks(db: Db, userIds: readonly string[]) {
  if (!userIds.length) return;
  const users = { in: [...userIds] };
  const subs = await db.subscription.findMany({ where: { OR: [
    { rider: { userId: users } }, { driver: { userId: users } }, { vendor: { owner: { userId: users } } },
  ] }, select: { id: true } });
  await cleanupBillingClocks(db, subs.map((s) => s.id));
}
