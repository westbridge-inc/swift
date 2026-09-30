import { Prisma, type PrismaClient } from '@prisma/client';

export type HoldFixtures = { userIds: string[]; vendorIds: string[]; orderIds: string[]; alertIds: string[]; notificationIds: string[] };

/** Only recorded rows belong to this journey. Foreign parent references
 * must refuse cleanup, preserving the whole fixture for an owner retry. */
export async function purgeHoldFixtures(prisma: PrismaClient, fixtures: HoldFixtures) {
  const { userIds, vendorIds, orderIds, alertIds, notificationIds } = fixtures;
  const guard = async (client: Prisma.TransactionClient) => {
    const foreignOrders = await client.order.findMany({ where: {
      OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }], id: { notIn: orderIds },
    }, select: { id: true } });
    if (foreignOrders.length) throw new Error(`Q12 fixture cleanup blocked by foreign orders: ${foreignOrders.map((o) => o.id).join(', ')}`);
    const foreignNotices = await client.notification.findMany({ where: { userId: { in: userIds }, id: { notIn: notificationIds } }, select: { id: true } });
    if (foreignNotices.length) throw new Error('Q12 fixture cleanup blocked by foreign notifications');
  };
  await guard(prisma);
  await prisma.$transaction(async (tx) => {
    if (userIds.length) await tx.$queryRaw`SELECT id FROM "users" WHERE id IN (${Prisma.join(userIds)}) ORDER BY id FOR UPDATE`;
    if (vendorIds.length) await tx.$queryRaw`SELECT id FROM "vendors" WHERE id IN (${Prisma.join(vendorIds)}) ORDER BY id FOR UPDATE`;
    await guard(tx);
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
    await tx.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await tx.session.deleteMany({ where: { userId: { in: userIds } } });
    await tx.customer.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
  }, { timeout: 30_000 });
}
