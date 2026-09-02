import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [TA-S0-001 hold v3 · N-01] The operator's door on a held paid order.
//
// #991 made the hold real and enforced — and a one-way door: nothing listed
// held orders, nothing could release one, retry-dispatch answered "done"
// while doing nothing, and the ops page told operators to "release the hold"
// with no control that did so. These cases drive the admin routes that now
// exist, over HTTP, as the seeded SUPER_ADMIN.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200671';
const MIN = 60_000;
let app: FastifyInstance;
let adminToken: string;
let adminUserId: string;
let customerId: string;
let vendorId: string;
const orderIds: string[] = [];
const userIds: string[] = [];

async function purge() {
  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = stale.map((u) => u.id);
  if (!ids.length) return;
  const vendors = await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } });
  const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendors.map((v) => v.id) } }] }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  // Status logs and audit rows are append-only evidence (database triggers);
  // they go with their orders on cascade, never by a direct delete.
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendors.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function heldOrder(opts: { heldAgoMin?: number; riderId?: string } = {}) {
  const now = Date.now();
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `HLD-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId,
      status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED',
      pickupAddress: 'Held Kitchen', pickupLat: 6.81, pickupLng: -58.16,
      deliveryAddress: 'Held Street', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, totalAmount: 3500,
      readyAt: new Date(now - 70 * MIN),
      foodAgeHeldAt: new Date(now - (opts.heldAgoMin ?? 10) * MIN),
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
    },
  });
  orderIds.push(order.id);
  await app.redis.set(`ops_page:food_too_old_paid:${order.id}`, '1', 'EX', 3600);
  return order;
}

const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(payload ? { payload } : {}),
  });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purge();
  const admin = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = admin.json().data.tokens.accessToken;
  adminUserId = admin.json().data.user.id;

  const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}10`, firstName: 'Held', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
  customerId = customer.id; userIds.push(customer.id);
  const owner = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}11`, firstName: 'Held', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(owner.id);
  const vendor = await app.prisma.vendor.create({
    data: {
      name: 'Held Kitchen', slug: `held-kitchen-${nanoid(6)}`, phone: `${PHONE_PREFIX}12`, vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true,
      addressLine1: '1 Held St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
      owner: { create: { userId: owner.id } },
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  for (const id of orderIds) await app.redis.del(`ops_page:food_too_old_paid:${id}`).catch(() => {});
  await purge();
  await app.close();
});

describe('the held-for-review queue', () => {
  it('lists held, riderless, waiting orders oldest-hold-first with how long they have been held', async () => {
    const older = await heldOrder({ heldAgoMin: 30 });
    const newer = await heldOrder({ heldAgoMin: 5 });
    const res = await call('GET', '/orders/held');
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; heldMinutes: number; readyMinutes: number; paymentStatus: string; vendor: { name: string } }>;
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(older.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
    const row = rows.find((r) => r.id === older.id)!;
    expect(row.heldMinutes).toBeGreaterThanOrEqual(29);
    expect(row.readyMinutes).toBeGreaterThanOrEqual(69);
    expect(row.paymentStatus).toBe('CAPTURED');
    expect(row.vendor.name).toBe('Held Kitchen');
  });
});

describe('the release door', () => {
  it('deliver anyway: clears the hold, records the waiver and who decided, audits, reopens the page, and sends the order back to dispatch', async () => {
    const order = await heldOrder();
    const res = await call('POST', `/orders/${order.id}/food-age-hold/release`, { decision: 'DELIVER_ANYWAY' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.released).toBe(true);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ held: after.foodAgeHeldAt, waivedBy: after.foodAgeWaivedBy }).toEqual({ held: null, waivedBy: adminUserId });
    expect(after.foodAgeWaivedAt).not.toBeNull();
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, changedBy: adminUserId } })).toBe(1);
    expect(await app.prisma.auditLog.count({ where: { entityId: order.id, action: 'RELEASE_FOOD_AGE_HOLD' } })).toBe(1);
    expect(await app.redis.exists(`ops_page:food_too_old_paid:${order.id}`)).toBe(0);
    expect(res.json().data.dispatch).toBeDefined(); // dispatch was asked, whatever it found
    // No longer in the queue.
    const list = await call('GET', '/orders/held');
    expect((list.json().data as Array<{ id: string }>).map((r) => r.id)).not.toContain(order.id);
  });

  it('a second release is an honest 409, not a silent success', async () => {
    const order = await heldOrder();
    expect((await call('POST', `/orders/${order.id}/food-age-hold/release`)).statusCode).toBe(200);
    const again = await call('POST', `/orders/${order.id}/food-age-hold/release`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ORDER_NOT_HELD');
  });

  it('an order that already has a rider is not releasable', async () => {
    const riderUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}20`, firstName: 'Held', lastName: 'Rider', roles: ['RIDER', 'CUSTOMER'], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(riderUser.id);
    const rider = await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, isAvailable: false } });
    const order = await heldOrder({ riderId: rider.id });
    try {
      const res = await call('POST', `/orders/${order.id}/food-age-hold/release`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ORDER_NOT_RELEASABLE');
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).foodAgeHeldAt).not.toBeNull();
    } finally {
      await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null } });
      await app.prisma.rider.delete({ where: { id: rider.id } });
    }
  });

  it('closing after a store refund is refused honestly until the refund-obligation rail exists', async () => {
    const order = await heldOrder();
    const res = await call('POST', `/orders/${order.id}/food-age-hold/release`, { decision: 'CLOSE_STORE_REFUNDED' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_AVAILABLE_YET');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).foodAgeHeldAt).not.toBeNull();
  });

  it('an unknown order is a 404', async () => {
    expect((await call('POST', `/orders/does-not-exist/food-age-hold/release`)).statusCode).toBe(404);
  });
});

describe('retry-dispatch on a held order', () => {
  it('answers ORDER_HELD_FOR_REVIEW and names the door, instead of "done" while doing nothing', async () => {
    const order = await heldOrder();
    const res = await call('POST', `/orders/${order.id}/retry-dispatch`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORDER_HELD_FOR_REVIEW');
    expect(res.json().error.message).toContain('food-age-hold/release');
    expect(await app.prisma.auditLog.count({ where: { entityId: order.id, action: 'RETRY_DISPATCH' } })).toBe(0);
  });
});
