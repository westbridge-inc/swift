import { OrderService } from '../modules/order/order.service';
import type { Prisma } from '@prisma/client';
import { drainHandoverNotices, HANDOVER_NOTICE_KIND } from '../modules/handover/handover-notice';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { NotificationService } from '../modules/notification/notification.service';

// Real PostgreSQL locks and HTTP/service entrypoints. Only authentication,
// Redis transport retries, sockets and notification providers are synthetic.
let app: FastifyInstance;
const users: string[] = [];
const vendors: string[] = [];
const orders: string[] = [];
let seq = 0;
const io = { to: () => ({ emit: vi.fn() }), emit: vi.fn() };
const cache = new Map<string, string>();
beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  app.decorate('io', io as never);
  app.decorate('redis', {
    lrange: async () => [],
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && cache.has(key)) return null;
      cache.set(key, value); return 'OK';
    },
    del: async (key: string) => Number(cache.delete(key)),
  } as never);
  app.decorate('authenticate', async (request) => {
    request.user = { userId: String(request.headers['test-actor']), role: 'RIDER' };
  });
  await app.register(riderRoutes, { prefix: '/rider' });
  await app.register(vendorRoutes, { prefix: '/vendor' });
  await app.ready();
});
afterEach(() => { vi.restoreAllMocks(); cache.clear(); });
afterAll(async () => {
  if (!app) return;
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orders } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});
type Door = 'pickup' | 'delivered' | 'cash';
async function fixture(door: Door, deliveryFee = 0) {
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);
  const customer = await app.prisma.user.create({ data: { firstName: 'Synthetic', lastName: 'Fixture', phone: `+5920784${String(++seq).padStart(4, '0')}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} } } });
  const actor = await app.prisma.user.create({ data: { firstName: 'Synthetic', lastName: 'Fixture', phone: `+5920784${String(++seq).padStart(4, '0')}`,
    roles: [door === 'pickup' ? 'VENDOR_OWNER' : 'RIDER'], activeRole: door === 'pickup' ? 'VENDOR_OWNER' : 'RIDER',
    ...(door === 'pickup' ? { vendorOwner: { create: {} } } : { rider: { create: { riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } } }),
  }, include: { vendorOwner: true, rider: true } });
  users.push(customer.id, actor.id);
  const vendor = door === 'pickup' ? await app.prisma.vendor.create({ data: {
    ownerId: actor.vendorOwner!.id, name: 'Synthetic pickup store', slug: `l07-proof-${nanoid(8)}`, vendorType: 'RESTAURANT',
    phone: '+59207849999', addressLine1: 'Synthetic pickup', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 3.38, longitude: -59.79, status: 'ACTIVE', isVerified: true,
  } }) : null;
  if (vendor) vendors.push(vendor.id);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `L07-B-${nanoid(12)}`, customerId: customer.id, vendorId: vendor?.id, riderId: actor.rider?.id,
    orderType: 'FOOD_DELIVERY', fulfillment: door === 'pickup' ? 'PICKUP' : 'DELIVERY',
    status: door === 'pickup' ? 'READY_FOR_PICKUP' : 'ARRIVED', readyAt: new Date(),
    deliveryAddress: 'Synthetic destination', deliveryLat: 3.39, deliveryLng: -59.78,
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee, totalAmount: deliveryFee,
    paymentMethod: 'CASH', paymentStatus: door === 'delivered' ? 'CAPTURED' : 'PENDING',
    ...(door === 'pickup' ? { pickupCode: '135790' } : { ridePin: '135790' }),
  } });
  orders.push(order.id);
  const request = async (code: string, key?: string) => {
    const response = await app.inject({ method: door === 'cash' ? 'POST' : 'PUT', url: door === 'cash' ? `/rider/orders/${order.id}/handover` : door === 'pickup' ? `/vendor/orders/${order.id}/complete-pickup` : `/rider/orders/${order.id}/delivered`,
      headers: { 'test-actor': actor.id, ...(key ? { 'idempotency-key': key } : {}) },
      payload: door === 'cash' ? { outcome: 'paid', gps: { lat: 3.39, lng: -59.78 }, ridePin: code } : door === 'pickup' ? { code } : { ridePin: code },
    });
    return { status: response.statusCode, code: response.json().error?.code };
  };
  return { order, actor, customer, request };
}
async function holdOrder(id: string, change?: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = app.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
    if (change) await change(tx);
    entered(); await gate;
  }, { timeout: 30_000 });
  await waiting;
  return { release, transaction };
}
async function waitForOrderWaiters(count: number) {
  // Observe real database lock waiters, not elapsed wall time or a mock of
  // the verifier. Both the vulnerable write and fixed locked decision wait.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await app.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE '%orders%'`;
    if (rows[0]!.count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe ${count} order-lock waiters`);
}

describe('handover attempt budget is one locked order decision', () => {
  for (const door of ['pickup', 'delivered', 'cash'] as const) {
    it.each(['absent', 'distinct'] as const)(`${door} admits at most five concurrent wrong guesses with %s transport keys`, async (keys) => {
      const f = await fixture(door);
      const held = await holdOrder(f.order.id);
      const pending = Array.from({ length: 7 }, (_, i) => f.request(String(200000 + i), keys === 'distinct' ? `l07-guess-${nanoid(12)}` : undefined));
      try { await waitForOrderWaiters(7); } finally { held.release(); await held.transaction; }
      const results = await Promise.all(pending);
      expect(results.every((r) => r.status === 400), JSON.stringify(results)).toBe(true);
      const row = await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
      expect(door === 'pickup' ? row.pickupCodeAttempts : row.ridePinAttempts).toBe(5);
      expect(row.status).toBe(f.order.status);
      expect(await app.prisma.earning.count({ where: { orderId: f.order.id } })).toBe(0);
    });
    it(`${door} refuses a correct guess queued after the fifth wrong attempt`, async () => {
      const f = await fixture(door);
      for (let i = 0; i < 4; i++) expect((await f.request(String(300000 + i))).status).toBe(400);
      // PostgreSQL does not promise FIFO for every tuple/transaction waiter.
      // Hold the actual fifth verifier after its increment and before commit,
      // then observe the correct verifier waiting behind THAT transaction.
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const original = OrderService.prototype.stageCanonicalOrderTransition;
      vi.spyOn(OrderService.prototype, 'stageCanonicalOrderTransition').mockImplementation(async function (this: OrderService, tx, input) {
        const result = await original.call(this, tx, input);
        if (input.orderId === f.order.id && 'handoverFailure' in result && result.handoverFailure.code !== 'MAX_ATTEMPTS') {
          entered(); await gate;
        }
        return result;
      });
      const wrong = f.request('300004');
      await waiting;
      const correct = f.request('135790');
      try { await waitForOrderWaiters(1); } finally { release(); }
      expect((await wrong).status).toBe(400);
      expect(await correct).toMatchObject({ status: 400, code: 'MAX_ATTEMPTS' });
      const row = await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
      expect(row.status).toBe(f.order.status);
      expect(row.paymentStatus).toBe(f.order.paymentStatus);
      expect(await app.prisma.earning.count({ where: { orderId: f.order.id } })).toBe(0);
    });
    it(`${door} commits concurrent correct proofs once and safely replays the result`, async () => {
      const f = await fixture(door, door === 'pickup' ? 0 : 500);
      const held = await holdOrder(f.order.id);
      const keys = [nanoid(16), nanoid(16), nanoid(16)];
      const pending = keys.map((key) => f.request('135790', key));
      try { await waitForOrderWaiters(3); } finally { held.release(); await held.transaction; }
      expect(await Promise.all(pending)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ status: 200 })));
      expect(await f.request('135790', keys[0])).toMatchObject({ status: 200 });
      // Once completed, a transport retry does not compare or consume again.
      expect(await f.request('000000')).toMatchObject({ status: 200 });
      const row = await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: row.id, status: row.status } })).toBe(1);
      expect(await app.prisma.orderOutbox.count({ where: { orderId: row.id, kind: HANDOVER_NOTICE_KIND } })).toBe(1);
      expect(door === 'pickup' ? row.pickupCodeAttempts : row.ridePinAttempts).toBe(door === 'pickup' ? 1 : 0);
      const earnings = await app.prisma.earning.findMany({ where: { orderId: row.id } });
      expect(earnings).toHaveLength(door === 'pickup' ? 0 : 1);
      if (door !== 'pickup') {
        expect(Number(earnings[0]!.amount)).toBeGreaterThan(0);
        expect(row.paymentStatus).toBe('CAPTURED');
      }
    });
    it(`${door} cannot complete after a cancellation wins the order lock`, async () => {
      const f = await fixture(door);
      const held = await holdOrder(f.order.id, (tx) => tx.order.update({ where: { id: f.order.id }, data: { status: 'CANCELLED' } }));
      const response = f.request('135790');
      try { await waitForOrderWaiters(1); } finally { held.release(); await held.transaction; }
      expect((await response).status).toBe(409);
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('CANCELLED');
      expect(await app.prisma.earning.count({ where: { orderId: f.order.id } })).toBe(0);
      expect(await app.prisma.orderOutbox.count({ where: { orderId: f.order.id } })).toBe(0);
    });
    if (door !== 'pickup') it(`${door} cannot use a replaced rider's proof authority`, async () => {
      const f = await fixture(door);
      const replacement = await fixture(door);
      const held = await holdOrder(f.order.id, (tx) => tx.order.update({ where: { id: f.order.id }, data: { riderId: replacement.actor.rider!.id } }));
      const response = f.request('135790');
      try { await waitForOrderWaiters(1); } finally { held.release(); await held.transaction; }
      expect((await response).status).toBe(409);
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ARRIVED');
      expect(await app.prisma.earning.count({ where: { orderId: f.order.id } })).toBe(0);
    });
    it(`${door} retries a failed customer push without repeating terminal facts`, async () => {
      const f = await fixture(door);
      expect(await f.request('135790')).toMatchObject({ status: 200 });
      const row = await app.prisma.orderOutbox.findFirstOrThrow({ where: { orderId: f.order.id, kind: HANDOVER_NOTICE_KIND } });
      await app.prisma.deviceToken.create({ data: { userId: f.customer.id, token: `ExpoPushToken[synthetic-${nanoid(8)}]`, platform: 'ios' } });
      const push = vi.fn().mockRejectedValueOnce(new Error('synthetic provider outage')).mockResolvedValue({ sent: 1 });
      const publisher = new NotificationService(app.prisma, io as never, { push: { sendPush: push } } as never);
      const now = new Date(Date.now() + 600_000);
      expect(await drainHandoverNotices({ prisma: app.prisma, notifications: publisher, now: () => now }, { orderId: f.order.id })).toEqual({ delivered: 0, pending: 1 });
      expect((await app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: row.id } })).processedAt).toBeNull();
      expect(await drainHandoverNotices({ prisma: app.prisma, notifications: publisher, now: () => new Date(now.getTime() + 600_000) }, { orderId: f.order.id })).toEqual({ delivered: 1, pending: 0 });
      expect(push).toHaveBeenCalledTimes(2);
      expect(await app.prisma.notification.count({ where: { dedupeKey: row.dedupeKey } })).toBe(1);
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: f.order.id, status: door === 'pickup' ? 'COMPLETED' : 'DELIVERED' } })).toBe(1);
    });
    it(`${door} accepts a correct proof while the budget remains`, async () => {
      const f = await fixture(door);
      expect(await f.request('135790')).toMatchObject({ status: 200 });
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe(door === 'pickup' ? 'COMPLETED' : 'DELIVERED');
    });
  }
});
