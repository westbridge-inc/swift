import { drainRiderCancellationNotices } from '../modules/order/rider-cancel-notice';
import { drainCheckoutOutbox } from '../modules/order/checkout-outbox';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';

// Real cancellation transaction. External publications are recorded; no Redis
// or notification provider is contacted by this fixture.
let app: FastifyInstance;
const users: string[] = [];
const orders: string[] = [];
let seq = 0;
const emit = vi.fn();
let service: OrderService;
beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  service = new OrderService(app.prisma, { to: () => ({ emit }) } as never);
});
afterEach(() => { vi.restoreAllMocks(); emit.mockClear(); });
afterAll(async () => {
  if (!app) return;
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});
async function fixture(assigned = true) {
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);
  const customer = await app.prisma.user.create({ data: {
    phone: `+5920788${String(++seq).padStart(4, '0')}`, firstName: 'Synthetic', lastName: 'Customer',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} },
  } });
  const mover = await app.prisma.user.create({ data: {
    phone: `+5920788${String(++seq).padStart(4, '0')}`, firstName: 'Synthetic', lastName: 'Mover',
    roles: ['RIDER'], activeRole: 'RIDER', rider: { create: { riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } },
  }, include: { rider: true } });
  users.push(customer.id, mover.id);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `L07-C-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    customerId: customer.id, riderId: assigned ? mover.rider!.id : null,
    status: assigned ? 'RIDER_ASSIGNED' : 'READY_FOR_PICKUP',
    deliveryAddress: 'Synthetic destination', deliveryLat: 3.39, deliveryLng: -59.78,
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0, totalAmount: 0,
    paymentMethod: 'CASH', readyAt: new Date(),
  } });
  orders.push(order.id);
  return { customer, mover, order };
}
const noticeRows = (orderId: string) => app.prisma.orderOutbox.findMany({ where: { orderId, kind: 'rider-cancel-notice' } });

describe('assigned riders retain a durable cancellation notice', () => {
  it('commits the captured recipient and retry work with cancellation', async () => {
    const { customer, mover, order } = await fixture();
    const result = await service.cancelOrder(order.id, customer.id, 'Synthetic cancellation');
    expect(result.message).toContain('cancelled');
    const rows = await noticeRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: order.tenantId, orderId: order.id, kind: 'rider-cancel-notice', queue: 'notification', processedAt: null,
      payload: { orderId: order.id, riderUserId: mover.id } });
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED' });
  });
  it('does not create a rider notice for an unassigned order', async () => {
    const { customer, order } = await fixture(false);
    await service.cancelOrder(order.id, customer.id);
    expect(await noticeRows(order.id)).toHaveLength(0);
  });
  it('a failed cancellation leaves neither a cancelled order nor retry work', async () => {
    const { customer, order } = await fixture();
    vi.spyOn(service as unknown as { stageRiderRelease: (...args: unknown[]) => Promise<void> }, 'stageRiderRelease')
      .mockRejectedValueOnce(new Error('synthetic release failure'));
    await expect(service.cancelOrder(order.id, customer.id)).rejects.toThrow('synthetic release failure');
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'RIDER_ASSIGNED' });
    expect(await noticeRows(order.id)).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });
  it('keeps a failed push pending, then retries the same durable inbox row', async () => {
    const { customer, order } = await fixture();
    await service.cancelOrder(order.id, customer.id);
    const [row] = await noticeRows(order.id);
    const noticeId = (row!.payload as { notificationId: string }).notificationId;
    const push = vi.fn().mockRejectedValueOnce(new Error('synthetic provider outage')).mockResolvedValue({ sent: 1 });
    const publisher = new NotificationService(app.prisma, { to: () => ({ emit }) } as never, { push: { sendPush: push } } as never);
    const notice = await app.prisma.notification.findUniqueOrThrow({ where: { id: noticeId } });
    await app.prisma.deviceToken.create({ data: { userId: notice.userId, token: `ExpoPushToken[synthetic-${nanoid(8)}]`, platform: 'ios' } });
    const now = new Date(Date.now() + 600_000);
    const first = await drainRiderCancellationNotices({ prisma: app.prisma, notifications: publisher, now: () => now }, { orderId: order.id });
    expect(first).toEqual({ delivered: 0, pending: 1 });
    expect((await noticeRows(order.id))[0]!.processedAt).toBeNull();
    const second = await drainRiderCancellationNotices({ prisma: app.prisma, notifications: publisher, now: () => new Date(now.getTime() + 600_000) }, { orderId: order.id });
    expect(second).toEqual({ delivered: 1, pending: 0 });
    expect(push).toHaveBeenCalledTimes(2);
    expect(await app.prisma.notification.count({ where: { dedupeKey: row!.dedupeKey } })).toBe(1);
  });
  it('the generic queue publisher leaves this notice for its confirmed-push drainer', async () => {
    const { customer, order } = await fixture();
    await service.cancelOrder(order.id, customer.id);
    const add = vi.fn(async () => ({}));
    await drainCheckoutOutbox({ prisma: app.prisma, queues: { orderQueue: { add } as never, notificationQueue: { add } as never }, log: app.log }, { orderIds: [order.id] });
    expect(add).not.toHaveBeenCalled();
    expect((await noticeRows(order.id))[0]!.processedAt).toBeNull();
  });
  it('two simultaneous drains claim one notification attempt', async () => {
    const { customer, order } = await fixture();
    await service.cancelOrder(order.id, customer.id);
    const publishPersisted = vi.fn(async () => true);
    const now = () => new Date(Date.now() + 600_000);
    const results = await Promise.all([0, 1].map(() => drainRiderCancellationNotices({ prisma: app.prisma, notifications: { publishPersisted }, now }, { orderId: order.id })));
    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(1);
    expect(publishPersisted).toHaveBeenCalledTimes(1);
  });

});
