import { Prisma, PrismaClient } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { customAlphabet, nanoid } from 'nanoid';
import { expect } from 'vitest';

/** A database lock, observed through pg_blocking_pids, schedules the second
 * writer. No elapsed sleep is accepted as evidence that cleanup reached it. */
export async function insertWhileCleanupWaits<T>(peer: PrismaClient, table: 'vendor_owners' | 'vendors' | 'riders' | 'users', id: string,
  cleanup: () => Promise<unknown>, insert: (tx: Prisma.TransactionClient) => Promise<T>) {
  let outcome: Promise<unknown> | undefined;
  let blockedQuery = '';
  let row: T;
  try { row = await peer.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE`);
    const backends = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const pid = backends[0]!.pid;
    outcome = cleanup().then(() => undefined, (error: unknown) => error);
    const deadline = performance.now() + 10_000;
    while (!blockedQuery) {
      await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
      const blocked = await tx.$queryRaw<Array<{ query: string }>>`SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
      blockedQuery = blocked[0]?.query ?? '';
      if (performance.now() > deadline) throw new Error('cleanup never reached the held parent lock');
      if (!blockedQuery) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return insert(tx);
  }, { timeout: 20_000 }); } catch (error) { await outcome; throw error; }
  const error = await outcome;
  return { row, error, blockedQuery };
}

async function fixtureSnapshot(client: Prisma.TransactionClient, userId: string) {
  const vendors = await client.vendor.findMany({ where: { owner: { userId } }, orderBy: { id: 'asc' } });
  const vendorIds = vendors.map((v) => v.id);
  const riders = await client.rider.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  const drivers = await client.driver.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  return {
    user: await client.user.findUnique({ where: { id: userId } }),
    owners: await client.vendorOwner.findMany({ where: { userId }, orderBy: { id: 'asc' } }), vendors, riders, drivers,
    sessions: await client.session.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    items: await client.item.findMany({ where: { vendorId: { in: vendorIds } }, orderBy: { id: 'asc' } }),
    categories: await client.category.findMany({ where: { vendorId: { in: vendorIds } }, orderBy: { id: 'asc' } }),
    subscriptions: await client.subscription.findMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { riderId: { in: riders.map((r) => r.id) } }, { driverId: { in: drivers.map((d) => d.id) } }] }, orderBy: { id: 'asc' } }),
    orders: await client.order.findMany({ where: { OR: [{ customerId: userId }, { vendorId: { in: vendorIds } }, { riderId: { in: riders.map((r) => r.id) } }, { driverId: { in: drivers.map((d) => d.id) } }] }, orderBy: { id: 'asc' } }),
    notices: await client.notification.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    alerts: await client.alertDelivery.findMany({ where: { recipientId: userId }, orderBy: { id: 'asc' } }),
  };
}

export async function provePeerOrderRefusal(prisma: PrismaClient, cleanup: () => Promise<unknown>,
  parent: { table: 'vendors' | 'riders'; id: string; userId: string }) {
  const peer = new PrismaClient();
  const orderIds: string[] = [];
  const customer = await peer.user.create({ data: { phone: `+592096${customAlphabet('0123456789', 10)()}`,
    firstName: 'Fixture', lastName: 'Peer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
  const ownAlert = await prisma.alertDelivery.create({ data: { kind: 'ADMIN_OPS', subjectId: parent.id, recipientId: parent.userId } });
  const readParent = () => parent.table === 'vendors' ? peer.vendor.findUnique({ where: { id: parent.id } }) : peer.rider.findUnique({ where: { id: parent.id } });
  const before = { parent: await readParent(), user: await peer.user.findUnique({ where: { id: parent.userId } }), alert: ownAlert };
  const insert = async (client: Prisma.TransactionClient) => {
    const row = await client.order.create({ data: { orderNumber: `HYGR3-${nanoid(16)}`, customerId: customer.id,
      ...(parent.table === 'vendors' ? { vendorId: parent.id } : { riderId: parent.id }),
      orderType: 'COURIER', fulfillment: 'DELIVERY', status: 'PENDING', deliveryAddress: 'Fixture Lane', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 1200, totalAmount: 1200, paymentMethod: 'CASH' } });
    orderIds.push(row.id); return row;
  };
  const unchanged = async (order: Awaited<ReturnType<typeof insert>>) => {
    expect(await peer.order.findUnique({ where: { id: order.id } })).toEqual(order);
    expect(await readParent()).toEqual(before.parent);
    expect(await peer.user.findUnique({ where: { id: parent.userId } })).toEqual(before.user);
    expect(await peer.alertDelivery.findUnique({ where: { id: ownAlert.id } })).toEqual(before.alert);
  };
  try {
    const existing = await insert(peer);
    const existingSnapshot = await fixtureSnapshot(peer, parent.userId);
    await expect(cleanup()).rejects.toThrow(/foreign orders/);
    await unchanged(existing);
    expect(await fixtureSnapshot(peer, parent.userId)).toEqual(existingSnapshot);
    await peer.order.delete({ where: { id: existing.id } });
    let lateSnapshot: Awaited<ReturnType<typeof fixtureSnapshot>> | undefined;
    const late = await insertWhileCleanupWaits(peer, parent.table, parent.id, cleanup, async (tx) => {
      const row = await insert(tx); lateSnapshot = await fixtureSnapshot(tx, parent.userId); return row;
    });
    expect(late.blockedQuery).toMatch(/FOR UPDATE/);
    expect(late.error).toBeInstanceOf(Error);
    expect(String(late.error)).toMatch(/foreign orders/);
    await unchanged(late.row);
    expect(await fixtureSnapshot(peer, parent.userId)).toEqual(lateSnapshot);
    await peer.order.delete({ where: { id: late.row.id } });
  } finally {
    await peer.order.deleteMany({ where: { id: { in: orderIds } } });
    await peer.alertDelivery.deleteMany({ where: { id: ownAlert.id } });
    await peer.user.deleteMany({ where: { id: customer.id } });
    await peer.$disconnect();
  }
}

export async function proveOwnerDiscovery(prisma: PrismaClient, cleanup: () => Promise<unknown>, ownerId: string, userId: string) {
  const peer = new PrismaClient();
  const customer = await peer.user.create({ data: { phone: `+592096${customAlphabet('0123456789', 10)()}`, firstName: 'Fixture', lastName: 'Peer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
  const vendors: string[] = [];
  const orders: string[] = [];
  const ownedAlert = await prisma.alertDelivery.create({ data: { kind: 'ADMIN_OPS', subjectId: ownerId, recipientId: userId } });
  const owner = await peer.vendorOwner.findUniqueOrThrow({ where: { id: ownerId } });
  const insert = async (tx: Prisma.TransactionClient) => {
    const vendor = await tx.vendor.create({ data: { ownerId, name: 'Peer descendant', slug: `hyg-peer-${nanoid(16)}`, vendorType: 'RESTAURANT', phone: customer.phone,
      addressLine1: 'Fixture Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15 } });
    vendors.push(vendor.id);
    const order = await tx.order.create({ data: { orderNumber: `HYGDESC-${nanoid(16)}`, customerId: customer.id, vendorId: vendor.id,
      orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'PENDING', deliveryAddress: 'Fixture Lane', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1200, subtotalMarkup: 0, subtotalCustomer: 1200, deliveryFee: 0, totalAmount: 1200, paymentMethod: 'CASH' } });
    orders.push(order.id); return { vendor, order };
  };
  const unchanged = async (row: Awaited<ReturnType<typeof insert>>) => {
    expect(await peer.vendor.findUnique({ where: { id: row.vendor.id } })).toEqual(row.vendor);
    expect(await peer.order.findUnique({ where: { id: row.order.id } })).toEqual(row.order);
    expect(await peer.vendorOwner.findUnique({ where: { id: owner.id } })).toEqual(owner);
    expect(await peer.alertDelivery.findUnique({ where: { id: ownedAlert.id } })).toEqual(ownedAlert);
  };
  try {
    const existing = await insert(peer);
    const existingSnapshot = await fixtureSnapshot(peer, userId);
    await expect(cleanup()).rejects.toThrow(/foreign orders/);
    await unchanged(existing);
    expect(await fixtureSnapshot(peer, userId)).toEqual(existingSnapshot);
    await peer.order.delete({ where: { id: existing.order.id } });
    await peer.vendor.delete({ where: { id: existing.vendor.id } });
    let lateSnapshot: Awaited<ReturnType<typeof fixtureSnapshot>> | undefined;
    const late = await insertWhileCleanupWaits(peer, 'vendor_owners', ownerId, cleanup, async (tx) => {
      const row = await insert(tx); lateSnapshot = await fixtureSnapshot(tx, userId); return row;
    });
    expect(late.blockedQuery).toMatch(/FOR UPDATE/);
    expect(String(late.error)).toMatch(/foreign orders/);
    await unchanged(late.row);
    expect(await fixtureSnapshot(peer, userId)).toEqual(lateSnapshot);
    await peer.order.delete({ where: { id: late.row.order.id } });
    await peer.vendor.delete({ where: { id: late.row.vendor.id } });
  } finally {
    await peer.order.deleteMany({ where: { id: { in: orders } } });
    await peer.vendor.deleteMany({ where: { id: { in: vendors } } });
    await peer.alertDelivery.deleteMany({ where: { id: ownedAlert.id } });
    await peer.user.deleteMany({ where: { id: customer.id } });
    await peer.$disconnect();
  }
}

/** Shared recipients and JSON subjects never confer insert ownership. */
export async function proveMessageRefusal(prisma: PrismaClient, cleanup: () => Promise<unknown>, userId: string, orderId: string) {
  const peer = new PrismaClient();
  const peerUser = await peer.user.create({ data: { phone: `+592096${customAlphabet('0123456789', 10)()}`, firstName: 'Fixture', lastName: 'Messages', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
  const notices: string[] = [];
  const alerts: string[] = [];
  const ownNotices: string[] = [];
  const ownAlerts: string[] = [];
  const data = { type: 'SYSTEM_ANNOUNCEMENT' as const, title: 'Shared subject', body: 'Fixture only', data: { orderId } };
  try {
    const external = await peer.notification.create({ data: { ...data, userId: peerUser.id } }); notices.push(external.id);
    const peerAlert = await peer.alertDelivery.create({ data: { kind: 'ADMIN_OPS', subjectId: orderId, recipientId: userId } }); alerts.push(peerAlert.id);
    const own = await prisma.notification.create({ data: { ...data, userId } }); ownNotices.push(own.id);
    const ownAlert = await prisma.alertDelivery.create({ data: { kind: 'ADMIN_OPS', subjectId: orderId, recipientId: userId } }); ownAlerts.push(ownAlert.id);
    const bulkNoticeId = `hyg-notice-${nanoid(16)}`;
    const bulkAlertId = `hyg-alert-${nanoid(16)}`;
    expect(await prisma.notification.createMany({ data: [{ ...data, userId, id: bulkNoticeId }, { ...data, userId: peerUser.id, id: external.id }], skipDuplicates: true })).toEqual({ count: 1 }); ownNotices.push(bulkNoticeId);
    expect(await prisma.alertDelivery.createMany({ data: [{ kind: 'ADMIN_OPS', subjectId: orderId, recipientId: userId, id: bulkAlertId }, { kind: 'ADMIN_OPS', subjectId: orderId, recipientId: userId, id: peerAlert.id }], skipDuplicates: true })).toEqual({ count: 1 }); ownAlerts.push(bulkAlertId);
    await expect(prisma.notification.create({ data: { ...data, userId, id: external.id } })).rejects.toThrow();
    await expect(prisma.alertDelivery.create({ data: { kind: 'ADMIN_OPS', subjectId: orderId, recipientId: userId, id: peerAlert.id } })).rejects.toThrow();
    const snapshot = async (client: Prisma.TransactionClient = peer) => ({ fixture: await fixtureSnapshot(client, userId), user: await client.user.findUnique({ where: { id: userId } }), order: await client.order.findUnique({ where: { id: orderId } }),
      notices: await client.notification.findMany({ where: { id: { in: [...notices, ...ownNotices] } }, orderBy: { id: 'asc' } }),
      alerts: await client.alertDelivery.findMany({ where: { id: { in: [...alerts, ...ownAlerts] } }, orderBy: { id: 'asc' } }) });
    const existing = await peer.notification.create({ data: { ...data, userId } }); notices.push(existing.id);
    const before = await snapshot();
    await expect(cleanup()).rejects.toThrow(/notifications/);
    expect(await snapshot()).toEqual(before);
    await peer.notification.delete({ where: { id: existing.id } }); notices.splice(notices.indexOf(existing.id), 1);
    let lateBefore: Awaited<ReturnType<typeof snapshot>> | undefined;
    const late = await insertWhileCleanupWaits(peer, 'users', userId, cleanup, async (tx) => {
      const row = await tx.notification.create({ data: { ...data, userId } }); notices.push(row.id);
      const alert = await tx.alertDelivery.create({ data: { kind: 'ADMIN_OPS', subjectId: orderId, recipientId: userId } }); alerts.push(alert.id);
      lateBefore = await snapshot(tx);
      return row;
    });
    expect(late.blockedQuery).toMatch(/FOR UPDATE/);
    expect(String(late.error)).toMatch(/notifications/);
    expect(await snapshot()).toEqual(lateBefore);
    await peer.notification.delete({ where: { id: late.row.id } }); notices.splice(notices.indexOf(late.row.id), 1);
    const peerNoticesBefore = await peer.notification.findMany({ where: { id: { in: notices } }, orderBy: { id: 'asc' } });
    const peerAlertsBefore = await peer.alertDelivery.findMany({ where: { id: { in: alerts } }, orderBy: { id: 'asc' } });
    await cleanup();
    expect(await peer.notification.findMany({ where: { id: { in: notices } }, orderBy: { id: 'asc' } })).toEqual(peerNoticesBefore);
    expect(await peer.alertDelivery.findMany({ where: { id: { in: alerts } }, orderBy: { id: 'asc' } })).toEqual(peerAlertsBefore);
    expect(await peer.notification.count({ where: { id: { in: ownNotices } } })).toBe(0);
    expect(await peer.alertDelivery.count({ where: { id: { in: ownAlerts } } })).toBe(0);
  } finally {
    await peer.notification.deleteMany({ where: { id: { in: [...notices, ...ownNotices] } } });
    await peer.alertDelivery.deleteMany({ where: { id: { in: [...alerts, ...ownAlerts] } } });
    await peer.user.deleteMany({ where: { id: peerUser.id } });
    await peer.$disconnect();
  }
}
