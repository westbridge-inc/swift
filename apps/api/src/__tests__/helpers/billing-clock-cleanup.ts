import type { PrismaClient } from '@prisma/client';

/** Synthetic fixtures own these exact subscriptions. Production retention FKs
 * remain RESTRICT; tests explicitly remove their dependent clock evidence. */
export async function cleanupBillingClocks(db: PrismaClient, subscriptionIds: readonly string[]) {
  if (!subscriptionIds.length) return;
  const subscriptionId = { in: [...subscriptionIds] };
  await db.billingNoticeHandoff.deleteMany({ where: { notice: { subscriptionId } } });
  await db.billingFeeNotice.deleteMany({ where: { subscriptionId } });
  await db.paymentConfirmationHold.deleteMany({ where: { subscriptionId } });
  await db.billingDunningClock.deleteMany({ where: { subscriptionId } });
}

export async function cleanupPayerBillingClocks(db: PrismaClient, userIds: readonly string[]) {
  if (!userIds.length) return;
  const users = { in: [...userIds] };
  const subs = await db.subscription.findMany({ where: { OR: [
    { rider: { userId: users } }, { driver: { userId: users } }, { vendor: { owner: { userId: users } } },
  ] }, select: { id: true } });
  await cleanupBillingClocks(db, subs.map((s) => s.id));
}
