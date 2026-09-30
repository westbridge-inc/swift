import { Prisma } from '@prisma/client';

type Client = Prisma.TransactionClient;
export async function discoverFixtureParents(client: Client, userIds: string[], suppliedVendorIds: string[] = []) {
  const vendors = await client.vendor.findMany({ where: { OR: [{ owner: { userId: { in: userIds } } }, { id: { in: suppliedVendorIds } }] }, select: { id: true } });
  const riders = await client.rider.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const drivers = await client.driver.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  return { vendorIds: vendors.map((v) => v.id), riderIds: riders.map((r) => r.id), driverIds: drivers.map((d) => d.id) };
}

/** User locks stop new profiles. VendorOwner locks stop new vendors. Only
 * after locking these intermediate parents is the descendant census final.
 * Child locks stop FK insertions until refusal or the atomic purge commits. */
export async function lockFixtureParents(tx: Client, userIds: string[], suppliedVendorIds: string[] = []) {
  if (userIds.length) await tx.$queryRaw`SELECT id FROM "users" WHERE id IN (${Prisma.join(userIds)}) ORDER BY id FOR UPDATE`;
  if (userIds.length || suppliedVendorIds.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM "vendor_owners" WHERE
    "userId" IN (${Prisma.join(userIds.length ? userIds : [''])}) OR id IN (
      SELECT "ownerId" FROM "vendors" WHERE id IN (${Prisma.join(suppliedVendorIds.length ? suppliedVendorIds : [''])})
    ) ORDER BY id FOR UPDATE`);
  const parents = await discoverFixtureParents(tx, userIds, suppliedVendorIds);
  if (parents.vendorIds.length) await tx.$queryRaw`SELECT id FROM "vendors" WHERE id IN (${Prisma.join(parents.vendorIds)}) ORDER BY id FOR UPDATE`;
  if (parents.riderIds.length) await tx.$queryRaw`SELECT id FROM "riders" WHERE id IN (${Prisma.join(parents.riderIds)}) ORDER BY id FOR UPDATE`;
  if (parents.driverIds.length) await tx.$queryRaw`SELECT id FROM "drivers" WHERE id IN (${Prisma.join(parents.driverIds)}) ORDER BY id FOR UPDATE`;
  return parents;
}

export async function assertFixtureReferences(tx: Client, label: string, userIds: string[], parents: Awaited<ReturnType<typeof discoverFixtureParents>>, orderIds: string[], notificationIds: string[], orderError = `${label}: foreign orders block fixture cleanup`) {
  const foreignOrders = await tx.order.findMany({ where: { OR: [
    { customerId: { in: userIds } }, { vendorId: { in: parents.vendorIds } },
    { riderId: { in: parents.riderIds } }, { driverId: { in: parents.driverIds } },
  ], id: { notIn: orderIds } }, select: { id: true } });
  if (foreignOrders.length) throw new Error(`${orderError}: ${foreignOrders.map((o) => o.id).join(', ')}`);
  const foreignNotices = await tx.notification.findMany({ where: { userId: { in: userIds }, id: { notIn: notificationIds } }, select: { id: true } });
  if (foreignNotices.length) throw new Error(`${label}: untracked notifications block fixture user cleanup: ${foreignNotices.map((n) => n.id).join(', ')}`);
  const foreignRatings = await tx.rating.findMany({ where: { OR: [{ rateeId: { in: userIds } }, { raterId: { in: userIds } }], orderId: { notIn: orderIds } }, select: { id: true } });
  if (foreignRatings.length) throw new Error(`${label}: foreign ratings block fixture cleanup`);
  const foreignTickets = await tx.supportTicket.findMany({ where: { resolvedById: { in: userIds } }, select: { id: true } });
  if (foreignTickets.length) throw new Error(`${label}: foreign support resolutions block fixture cleanup`);
  const moverSubscriptions = await tx.subscription.findMany({ where: { OR: [{ riderId: { in: parents.riderIds } }, { driverId: { in: parents.driverIds } }] }, select: { id: true } });
  // These five purges own no mover subscription inserts; detachment is refused.
  if (moverSubscriptions.length) throw new Error(`${label}: foreign mover subscriptions block fixture cleanup`);
  // Earning's mover FKs are SET NULL too; a peer earning must retain its parent.
  const foreignEarnings = await tx.earning.findMany({ where: { OR: [{ riderId: { in: parents.riderIds } }, { driverId: { in: parents.driverIds } }], orderId: { notIn: orderIds } }, select: { id: true } });
  if (foreignEarnings.length) throw new Error(`${label}: foreign earnings block fixture cleanup`);
}
