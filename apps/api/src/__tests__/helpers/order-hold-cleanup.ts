import { type PrismaClient } from '@prisma/client';

import { assertFixtureReferences, discoverFixtureParents, lockFixtureParents } from './cleanup-parents';

export type HoldFixtures = { userIds: string[]; vendorIds: string[]; orderIds: string[]; alertIds: string[]; notificationIds: string[] };

/** Only recorded rows belong to this journey. Foreign parent references
 * must refuse cleanup, preserving the whole fixture for an owner retry. */
export async function purgeHoldFixtures(prisma: PrismaClient, fixtures: HoldFixtures) {
  const { userIds, vendorIds: suppliedVendorIds, orderIds, alertIds, notificationIds } = fixtures;
  const preflight = await discoverFixtureParents(prisma, userIds, suppliedVendorIds);
  const guard = (client: Parameters<typeof assertFixtureReferences>[0], parents: typeof preflight) =>
    assertFixtureReferences(client, 'Q12', userIds, parents, orderIds, notificationIds, 'Q12 fixture cleanup blocked by foreign orders');
  await guard(prisma, preflight);
  await prisma.$transaction(async (tx) => {
    const parents = await lockFixtureParents(tx, userIds, suppliedVendorIds);
    const { vendorIds, riderIds, driverIds } = parents;
    await guard(tx, parents);
    if (await tx.subscription.count({ where: { vendorId: { in: parents.vendorIds } } })) throw new Error('Foreign vendor subscriptions block fixture cleanup');
    await tx.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await tx.alertDelivery.deleteMany({ where: { id: { in: alertIds } } });
    await tx.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
    await tx.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    await tx.cart.deleteMany({ where: { customerId: { in: userIds } } });
    await tx.address.deleteMany({ where: { userId: { in: userIds } } });
    await tx.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
    await tx.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await tx.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await tx.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await tx.rider.deleteMany({ where: { id: { in: riderIds } } });
    await tx.driver.deleteMany({ where: { id: { in: driverIds } } });
    await tx.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await tx.session.deleteMany({ where: { userId: { in: userIds } } });
    await tx.customer.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
  }, { timeout: 30_000 });
}
