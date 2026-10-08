import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Queue } from 'bullmq';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Food/shop scheduling is off at launch. Refuse before cart writes or claiming a checkout key.
let app: FastifyInstance;
let orderQueue: Queue;
let notificationQueue: Queue;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_610_000_000 + Math.floor(Math.random() * 300_000_000);
let vendorId: string;
let itemId: string;

async function makeCustomer(phone?: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: phone ?? `+${phoneBase + seq}`, firstName: 'Schedule', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'schedule', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Schedule', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
  return { userId: user.id, token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload: unknown, token: string, headers: Record<string, string> = {}) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers } });
}

async function fillCart(c: { token: string; addressId: string }) {
  await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
  await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
}

const checkout = (c: { token: string }, key: string, body: Record<string, unknown> = { paymentMethod: 'CASH' }) =>
  inject('POST', '/api/v1/customer/checkout', body, c.token, { 'idempotency-key': key });

const ordersOf = (userId: string) => app.prisma.order.count({ where: { customerId: userId } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
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

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Schedule', lastName: 'Vend', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Schedule Diner', slug: `schedule-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 901}`, addressLine1: '1 D St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Schedule Plate', basePrice: 2000, isAvailable: true } });
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


afterEach(() => vi.unstubAllEnvs());
const later = () => new Date(Date.now() + 2 * 86_400_000).toISOString();
const snapshot = (userId: string) => app.prisma.cart.findUnique({ where: { customerId: userId }, include: { items: { orderBy: { id: 'asc' } } } });

describe('food/shop scheduled orders are unavailable until explicitly enabled', () => {
  it.each([undefined, 'false', '1', 'TRUE', 'mistyped'])('switch %s refuses before any checkout effect', async (setting) => {
    vi.stubEnv('SCHEDULED_ORDERS_ENABLED', setting);
    const c = await makeCustomer(); await fillCart(c);
    const before = await snapshot(c.userId);
    const key = `schedule-${nanoid(10)}`;
    const res = await checkout(c, key, { scheduledFor: later(), paymentMethod: 'CASH' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SCHEDULED_ORDERS_UNAVAILABLE', message: 'Scheduled orders are not available yet. Place your order when you are ready.' });
    expect(await ordersOf(c.userId)).toBe(0);
    expect(await app.prisma.checkoutReceipt.count({ where: { userId: c.userId } })).toBe(0);
    expect(await app.redis.get(`checkout:idem:${c.userId}:${key}`)).toBeNull();
    expect(await snapshot(c.userId)).toEqual(before);
    // The same key is immediately usable for an ordinary order.
    const now = await checkout(c, key);
    expect(now.statusCode, now.body).toBe(200);
    expect(await ordersOf(c.userId)).toBe(1);
  });

  it.each(['RESTAURANT', 'SUPERMARKET', 'STORE'] as const)('%s carts cannot schedule', async (vendorType) => {
    vi.stubEnv('SCHEDULED_ORDERS_ENABLED', undefined);
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { vendorType } });
    const c = await makeCustomer(); await fillCart(c);
    const res = await checkout(c, `schedule-${nanoid(10)}`, { scheduledFor: later() });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SCHEDULED_ORDERS_UNAVAILABLE');
    expect(await ordersOf(c.userId)).toBe(0);
  });

  it.each([null, '', false, {}, 'tomorrow-ish'])('a supplied schedule %j is not silently stripped or treated as an immediate order', async (scheduledFor) => {
    vi.stubEnv('SCHEDULED_ORDERS_ENABLED', undefined);
    const c = await makeCustomer(); await fillCart(c);
    const res = await checkout(c, `schedule-${nanoid(10)}`, { scheduledFor });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SCHEDULED_ORDERS_UNAVAILABLE');
    expect(await ordersOf(c.userId)).toBe(0);
  });

  it('the explicit server switch preserves timestamp validation and the scheduled checkout path', async () => {
    vi.stubEnv('SCHEDULED_ORDERS_ENABLED', 'true');
    const c = await makeCustomer(); await fillCart(c);
    const key = `schedule-${nanoid(10)}`;
    const bad = await checkout(c, key, { scheduledFor: 'tomorrow-ish' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('valid ISO 8601');
    const scheduledFor = later();
    const good = await checkout(c, key, { scheduledFor });
    expect(good.statusCode, good.body).toBe(200);
    expect((await app.prisma.order.findFirstOrThrow({ where: { customerId: c.userId } })).scheduledFor?.toISOString()).toBe(scheduledFor);
  });
});

describe('cart mutations do not discard an unavailable schedule and apply something else', () => {
  it.each(['add', 'quantity', 'remove', 'clear', 'address', 'tip', 'promo'] as const)('%s refuses without changing the cart', async (edge) => {
    vi.stubEnv('SCHEDULED_ORDERS_ENABLED', undefined);
    const c = await makeCustomer(); await fillCart(c);
    const before = (await snapshot(c.userId))!;
    expect(before.items).toHaveLength(1);
    const edges = {
      add: ['POST', '/cart/items', { vendorId, itemId, quantity: 2 }],
      quantity: ['PUT', `/cart/items/${before.items[0]!.id}`, { quantity: 2 }],
      remove: ['DELETE', `/cart/items/${before.items[0]!.id}`, {}],
      clear: ['DELETE', '/cart', {}],
      address: ['PUT', '/cart/address', { addressId: c.addressId }],
      tip: ['PUT', '/cart/tip', { amount: 500 }],
      promo: ['DELETE', '/cart/promo', {}],
    } as const;
    const [method, url, payload] = edges[edge];
    const res = await inject(method, `/api/v1/customer${url}`, { ...payload, scheduledFor: later() }, c.token);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SCHEDULED_ORDERS_UNAVAILABLE');
    expect(await snapshot(c.userId)).toEqual(before);
    expect(await ordersOf(c.userId)).toBe(0);
  });
});
