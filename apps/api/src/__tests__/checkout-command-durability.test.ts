import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Queue } from 'bullmq';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { OrderService } from '../modules/order/order.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { checkoutOutboxId, checkoutOutboxDedupeKey, drainCheckoutOutbox } from '../modules/order/checkout-outbox';

// ---------------------------------------------------------------------------
// [M-11 · S0] Checkout database commit, response and dispatch work are ONE
// command.
//
// Before: the order committed, then the route awaited two fallible queue
// publications, then stored the replay result in Redis best-effort, then
// answered. A queue outage after the commit answered a 500 for an order that
// exists and dropped the auto-cancel; the generic idempotency helper released
// the key on that throw, so a same-key retry placed a SECOND order; a lost
// Redis write turned a legitimate replay into "empty cart". These cases
// inject a failure at every post-commit boundary and require: the answer is
// the order, the tail is published exactly once (later if need be), and a
// same-key retry returns the same order ids — from the database.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let orderQueue: Queue;
let notificationQueue: Queue;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_610_000_000 + Math.floor(Math.random() * 300_000_000);
let vendorId: string;
let itemId: string;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Durable', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'durable', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Durable', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
  return { userId: user.id, token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string, headers: Record<string, string> = {}) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers } });
}

async function fillCart(c: { token: string; addressId: string }) {
  await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
  await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
}

const checkout = (c: { token: string }, key: string, body: Record<string, unknown> = { paymentMethod: 'CASH' }) =>
  inject('POST', '/api/v1/customer/checkout', body, c.token, { 'idempotency-key': key });

const outboxRows = (orderId: string) => app.prisma.orderOutbox.findMany({ where: { orderId }, orderBy: { kind: 'asc' } });
const ordersOf = (userId: string) => app.prisma.order.count({ where: { customerId: userId } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  const connection = app.redis.duplicate() as unknown as import('bullmq').ConnectionOptions;
  orderQueue = new Queue(`order-durability-${nanoid(6)}`, { connection });
  notificationQueue = new Queue(`notif-durability-${nanoid(6)}`, { connection });
  app.decorate('queues', { orderQueue, notificationQueue } as never);
  await app.ready();

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Durable', lastName: 'Vend', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Durable Diner', slug: `durable-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 901}`, addressLine1: '1 D St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Durable Plate', basePrice: 2000, isAvailable: true } });
  itemId = item.id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await orderQueue.obliterate({ force: true }).catch(() => {});
  await notificationQueue.obliterate({ force: true }).catch(() => {});
  await orderQueue.close();
  await notificationQueue.close();
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: createdUserIds } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the tail is written with the order and published exactly once', () => {
  it('a checkout leaves two outbox rows for its order, drained immediately: both jobs on their queues under the row ids, with the right delays', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const res = await checkout(c, `dur-${nanoid(10)}`);
    expect(res.statusCode, res.body).toBe(200);
    const orderId = res.json().data.orders[0].id as string;
    const rows = await outboxRows(orderId);
    expect(rows.map((r) => r.kind)).toEqual(['auto-cancel', 'vendor-alert-escalate']);
    expect(rows.every((r) => r.processedAt !== null)).toBe(true);
    const cancel = await orderQueue.getJob(checkoutOutboxId(checkoutOutboxDedupeKey(orderId, 'auto-cancel')));
    const alert = await notificationQueue.getJob(checkoutOutboxId(checkoutOutboxDedupeKey(orderId, 'vendor-alert-escalate')));
    expect(cancel?.name).toBe('auto-cancel');
    expect(cancel?.data).toEqual({ orderId });
    expect(alert?.name).toBe('vendor-alert-escalate');
    expect(alert?.data).toEqual({ orderId, level: 0 });
    expect(cancel!.opts.delay).toBeGreaterThan(0);
  });

  it('a queue outage after the commit: the customer still gets the order (200), the tail waits in the outbox, and the next drain publishes it once', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const spy = vi.spyOn(orderQueue, 'add').mockRejectedValueOnce(new Error('redis: connection lost'));
    try {
      const res = await checkout(c, `dur-${nanoid(10)}`);
      expect(res.statusCode, res.body).toBe(200); // not the 500 the old code answered for an order that existed
      const orderId = res.json().data.orders[0].id as string;
      const rows = await outboxRows(orderId);
      const cancel = rows.find((r) => r.kind === 'auto-cancel')!;
      expect(cancel.processedAt).toBeNull();
      expect(cancel.lastError).toContain('connection lost');
      expect(cancel.claimedAt).toBeNull(); // the claim was released for the sweep
      expect((await orderQueue.getJob(cancel.id))).toBeUndefined();
      // The sweep (here, a second drain once the row's backoff has lapsed).
      await app.prisma.orderOutbox.update({ where: { id: cancel.id }, data: { availableAt: new Date() } });
      const swept = await drainCheckoutOutbox({ prisma: app.prisma, queues: { orderQueue, notificationQueue }, log: app.log }, { orderIds: [orderId] });
      expect(swept.processed).toBe(1);
      expect((await orderQueue.getJob(cancel.id))?.name).toBe('auto-cancel');
      expect((await app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: cancel.id } })).processedAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('two drainers racing over the same rows publish each job once', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const spy = vi.spyOn(orderQueue, 'add').mockRejectedValueOnce(new Error('outage'));
    const res = await checkout(c, `dur-${nanoid(10)}`);
    spy.mockRestore();
    const orderId = res.json().data.orders[0].id as string;
    await app.prisma.orderOutbox.updateMany({ where: { orderId }, data: { availableAt: new Date(), claimedAt: null } });
    const rt = { prisma: app.prisma, queues: { orderQueue, notificationQueue }, log: app.log };
    const [a, b] = await Promise.all([drainCheckoutOutbox(rt, { orderIds: [orderId] }), drainCheckoutOutbox(rt, { orderIds: [orderId] })]);
    expect(a.processed + b.processed).toBeLessThanOrEqual(2);
    const cancelId = checkoutOutboxId(checkoutOutboxDedupeKey(orderId, 'auto-cancel'));
    const counts = await orderQueue.getJobCounts('delayed', 'waiting', 'active', 'completed');
    expect((await orderQueue.getJob(cancelId))?.name).toBe('auto-cancel');
    expect((counts['delayed'] ?? 0) + (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['completed'] ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('the result is written with the order and replayed from the database', () => {
  it('a same-key retry after Redis forgot returns the SAME order ids and places nothing new', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const key = `dur-${nanoid(10)}`;
    const first = await checkout(c, key);
    expect(first.statusCode, first.body).toBe(200);
    const orderId = first.json().data.orders[0].id as string;
    await app.redis.del(`checkout:idem:${c.userId}:${key}`); // the cache is gone; the old code would place again
    await fillCart(c); // the cart is full again, as a retrying client's would be
    const again = await checkout(c, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().data.orders[0].id).toBe(orderId);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('a same-key request with a DIFFERENT body is refused, never answered with the first order', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const key = `dur-${nanoid(10)}`;
    const seed = await checkout(c, key);
    expect(seed.statusCode, seed.body).toBe(200);
    await app.redis.del(`checkout:idem:${c.userId}:${key}`);
    await fillCart(c);
    const other = await checkout(c, key, { paymentMethod: 'CASH', deliveryInstructions: 'ring twice' });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('the receipt and the outbox rows commit WITH the order or not at all: a failure before the commit leaves no order, no receipt, no tail — and the key is free for a clean retry', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const key = `dur-${nanoid(10)}`;
    const orders = new OrderService(app.prisma, app.io);
    await expect(orders.checkout({
      userId: c.userId, paymentMethod: 'CASH', idempotency: { key, requestHash: 'h' },
      afterDurableTail: async () => { throw new Error('the process died before the commit'); },
    })).rejects.toThrow('died before the commit');
    expect(await ordersOf(c.userId)).toBe(0);
    expect(await app.prisma.checkoutReceipt.count({ where: { userId: c.userId } })).toBe(0);
    expect(await app.prisma.orderOutbox.count({ where: { orderId: { in: (await app.prisma.order.findMany({ where: { customerId: c.userId }, select: { id: true } })).map((o) => o.id) } } })).toBe(0);
    // Nothing partial survived, so the same key places cleanly now.
    const retry = await checkout(c, key);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await ordersOf(c.userId)).toBe(1);
    expect(await app.prisma.checkoutReceipt.count({ where: { userId: c.userId, idempotencyKey: key } })).toBe(1);
  });
});

describe('[M-12] the command key is claimed only for a valid, canonical request', () => {
  it('a malformed request never consumes the key: an invalid payment method is 400, the key stays free, and the corrected same-key request places immediately', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const key = `dur-${nanoid(10)}`;
    const bad = await checkout(c, key, { paymentMethod: 'CARD' });
    expect(bad.statusCode).toBe(400);
    expect(await app.redis.get(`checkout:idem:${c.userId}:${key}`)).toBeNull(); // not IN_FLIGHT for a day
    expect(await app.prisma.checkoutReceipt.count({ where: { userId: c.userId, idempotencyKey: key } })).toBe(0);
    const good = await checkout(c, key);
    expect(good.statusCode, good.body).toBe(200); // not the 409 a stranded claim answered
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it('a malformed timestamp is refused, not silently accepted through two false comparisons', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const key = `dur-${nanoid(10)}`;
    const res = await checkout(c, key, { paymentMethod: 'CASH', scheduledFor: 'tomorrow-ish' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('valid ISO 8601');
    expect(await ordersOf(c.userId)).toBe(0);
    expect(await app.redis.get(`checkout:idem:${c.userId}:${key}`)).toBeNull();
  });

  it('two spellings of the same instant are the same request: the second is a replay, not a refusal', async () => {
    const c = await makeCustomer();
    await fillCart(c);
    const key = `dur-${nanoid(10)}`;
    const slot = new Date(Date.now() + 2 * 86_400_000);
    slot.setUTCMilliseconds(0);
    const first = await checkout(c, key, { paymentMethod: 'CASH', scheduledFor: slot.toISOString() });
    expect(first.statusCode, first.body).toBe(200);
    await app.redis.del(`checkout:idem:${c.userId}:${key}`);
    await fillCart(c);
    const spelledDifferently = slot.toISOString().replace('.000Z', '+00:00');
    const again = await checkout(c, key, { paymentMethod: 'CASH', scheduledFor: spelledDifferently });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(await ordersOf(c.userId)).toBe(1);
  });
});
