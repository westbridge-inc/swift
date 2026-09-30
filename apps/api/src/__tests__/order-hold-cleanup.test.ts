import { Prisma, PrismaClient } from '@prisma/client';
import { customAlphabet, nanoid } from 'nanoid';
import { expect, it, vi } from 'vitest';
import { purgeHoldFixtures } from './helpers/order-hold-cleanup';

it('refuses a post-preflight peer order without detaching its vendor or partially purging the held fixture', async () => {
  const prisma = new PrismaClient();
  const peer = new PrismaClient();
  const phone = customAlphabet('0123456789', 10);
  const ids: string[] = [];
  const orders: string[] = [];
  let vendorId: string | undefined;
  let restore: (() => void) | undefined;
  try {
    const user = async (role: 'CUSTOMER' | 'VENDOR_OWNER') => {
      const row = await prisma.user.create({ data: { phone: `+592096${phone()}`, firstName: 'Fixture', lastName: 'Cleanup', roles: [role], activeRole: role } });
      ids.push(row.id); return row;
    };
    const owner = await user('VENDOR_OWNER');
    const buyer = await user('CUSTOMER');
    const outsider = await user('CUSTOMER');
    const vendorOwner = await prisma.vendorOwner.create({ data: { userId: owner.id } });
    const vendor = await prisma.vendor.create({ data: { ownerId: vendorOwner.id, name: 'Cleanup fixture', slug: `q12-cleanup-${nanoid(16)}`, vendorType: 'RESTAURANT', phone: owner.phone, addressLine1: 'Fixture Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15 } });
    vendorId = vendor.id;
    const orderData = { orderType: 'FOOD_DELIVERY' as const, fulfillment: 'DELIVERY' as const, vendorId, status: 'PENDING' as const, deliveryAddress: 'Fixture Lane', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1200, subtotalMarkup: 0, subtotalCustomer: 1200, deliveryFee: 0, totalAmount: 1200, paymentMethod: 'CASH' as const };
    const own = await prisma.order.create({ data: { ...orderData, orderNumber: `Q12OWN-${nanoid(16)}`, customerId: buyer.id } }); orders.push(own.id);
    const alert = await prisma.alertDelivery.create({ data: { kind: 'VENDOR_ORDER', subjectId: own.id, recipientId: owner.id } });
    const findOrders = prisma.order.findMany.bind(prisma.order);
    let late: typeof own | undefined;
    const interleave = vi.spyOn(prisma.order, 'findMany').mockImplementation((async (args: Prisma.OrderFindManyArgs) => {
      const result = await findOrders(args);
      if (!late) {
        late = await peer.order.create({ data: { ...orderData, orderNumber: `Q12PEER-${nanoid(16)}`, customerId: outsider.id } });
        orders.push(late.id);
      }
      return result;
    }) as typeof findOrders);
    restore = () => interleave.mockRestore();
    try {
      await expect(purgeHoldFixtures(prisma, { userIds: [owner.id, buyer.id], vendorIds: [vendor.id], orderIds: [own.id], alertIds: [alert.id], notificationIds: [] })).rejects.toThrow(/blocked by foreign orders/);
      expect(late).toBeDefined();
      expect(await peer.order.findUnique({ where: { id: late!.id } })).toEqual(late);
      expect(await peer.vendor.findUnique({ where: { id: vendor.id } })).toEqual(vendor);
      expect(await peer.order.findUnique({ where: { id: own.id } })).toEqual(own);
      expect(await peer.alertDelivery.findUnique({ where: { id: alert.id } })).toEqual(alert);
    } finally { restore(); }
    await peer.order.delete({ where: { id: late!.id } });
    await purgeHoldFixtures(prisma, { userIds: [owner.id, buyer.id], vendorIds: [vendor.id], orderIds: [own.id], alertIds: [alert.id], notificationIds: [] });
    expect(await peer.vendor.findUnique({ where: { id: vendor.id } })).toBeNull();
  } finally {
    restore?.();
    await prisma.alertDelivery.deleteMany({ where: { subjectId: { in: orders } } });
    await prisma.order.deleteMany({ where: { id: { in: orders } } });
    if (vendorId) await prisma.vendor.deleteMany({ where: { id: vendorId } });
    await prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect(); await peer.$disconnect();
  }
});
