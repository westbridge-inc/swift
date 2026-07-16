import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { makeDispatchService } from '../modules/dispatch/dispatch.service';
import { OrderService } from '../modules/order/order.service';

// ---------------------------------------------------------------------------
// Dispatch search journal (availability spec §3): a record BESIDE the state
// machine — SEARCHING on first sweep, candidates appended per offer, ASSIGNED
// on claim, EXHAUSTED honestly, RETRIED on a fresh search, CANCELLED with its
// order. Plus the §2 checkout gate: zero riders → delivery refused (flagged).
// ---------------------------------------------------------------------------

// A corner of the map no other suite uses.
const FIELD = { lat: 7.35, lng: -59.55 };
const EMPTY = { lat: 7.62, lng: -59.91 };

let app: FastifyInstance;
let customerId: string;
const userIds: string[] = [];
const riderIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
let ownerId: string;

async function makeRider(at: { lat: number; lng: number }) {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59257${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Journal', lastName: 'Rider',
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(u.id);
  const r = await app.prisma.rider.create({
    data: {
      userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      isOnline: true, isAvailable: true, documentsVerified: true,
      currentLat: at.lat + 0.003, currentLng: at.lng,
    },
  });
  riderIds.push(r.id);
  return r;
}

async function makeOrder(at: { lat: number; lng: number }) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `JRN-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId,
      status: 'ACCEPTED' as never,
      fulfillment: 'DELIVERY' as never,
      pickupLat: at.lat, pickupLng: at.lng,
      deliveryAddress: '9 Journal Row', deliveryLat: at.lat + 0.01, deliveryLng: at.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 400, totalAmount: 2400,
      paymentMethod: 'MOBILE_MONEY' as never,
    },
  });
  orderIds.push(order.id);
  return order;
}

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
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  registerEmptyJsonBodyParser(app);
  const { customerRoutes } = await import('../modules/user/customer.routes');
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const me = await app.prisma.user.create({
    data: {
      phone: `+59258${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Jour', lastName: 'Nal',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  customerId = me.id;
  userIds.push(me.id);
});

afterAll(async () => {
  delete process.env['DISPATCH_AVAILABILITY'];
  delete process.env['DELIVERY_BLOCK_ON_NONE'];
  await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (vendorIds.length > 0) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: ownerId } });
  }
  if (riderIds.length > 0) await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
  if (userIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

const journalOf = (orderId: string) =>
  app.prisma.dispatchSearch.findMany({ where: { subjectId: orderId }, orderBy: { startedAt: 'asc' } });

describe('search journal (§3)', () => {
  it('SEARCHING with the tried candidate on offer, ASSIGNED on claim', async () => {
    const rider = await makeRider(FIELD);
    const order = await makeOrder(FIELD);
    const dispatch = makeDispatchService(app as never);

    const res = await dispatch.dispatchOrder(order.id);
    expect(res.offered).toBe(rider.id);

    let rows = await journalOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SEARCHING');
    expect(rows[0]!.vertical).toBe('DELIVERY');
    expect(rows[0]!.candidatesTried).toContain(rider.id);

    await dispatch.claimOrder(order.id, rider.id, 'RIDER');
    rows = await journalOf(order.id);
    expect(rows[0]!.status).toBe('ASSIGNED');
    expect(rows[0]!.assignedTo).toBe(rider.id);
    expect(rows[0]!.assignedAt).not.toBeNull();

    // Park the rider so later geometry stays clean.
    await app.prisma.rider.update({ where: { id: rider.id }, data: { isOnline: false, isAvailable: false, currentOrderId: null } });
  });

  it('EXHAUSTED honestly on an empty field; a retry resolves it as RETRIED and opens a fresh search', async () => {
    const order = await makeOrder(EMPTY);
    const dispatch = makeDispatchService(app as never);

    const res = await dispatch.dispatchOrder(order.id);
    expect(res.exhausted).toBe(true);

    let rows = await journalOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('EXHAUSTED');
    expect(rows[0]!.exhaustedAt).not.toBeNull();

    // Supply returns; the vendor taps retry.
    const rider = await makeRider(EMPTY);
    const retry = await dispatch.retryDispatch(order.id);
    expect(retry.offered).toBe(rider.id);

    rows = await journalOf(order.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('EXHAUSTED');
    expect(rows[0]!.resolution).toBe('RETRIED');
    expect(rows[1]!.status).toBe('SEARCHING');
    expect(rows[1]!.candidatesTried).toContain(rider.id);

    await app.prisma.rider.update({ where: { id: rider.id }, data: { isOnline: false, isAvailable: false } });
    await app.redis.del(`dispatch:offer:${order.id}`);
  });

  it('a cancelled order closes its search as CANCELLED', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `JRN-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY' as never,
        customerId,
        status: 'PENDING' as never,
        fulfillment: 'DELIVERY' as never,
        deliveryAddress: 'x', deliveryLat: EMPTY.lat, deliveryLng: EMPTY.lng,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
        paymentMethod: 'CASH' as never,
      },
    });
    orderIds.push(order.id);
    await app.prisma.dispatchSearch.create({
      data: { vertical: 'DELIVERY', subjectId: order.id, status: 'SEARCHING', radiusKm: 5 },
    });

    const orders = new OrderService(app.prisma, app.io);
    await orders.cancelOrder(order.id, customerId, 'changed my mind');

    const rows = await journalOf(order.id);
    expect(rows[0]!.status).toBe('CANCELLED');
    expect(rows[0]!.resolution).toBe('CANCELLED');
  });
});

describe('checkout delivery gate (§2, flag-gated)', () => {
  let itemId: string;
  let cartHeaders: Record<string, string>;

  beforeAll(async () => {
    // Self-contained always-open vendor at the empty corner (no hours rows).
    const owner = await app.prisma.vendorOwner.create({ data: { userId: customerId } });
    ownerId = owner.id;
    const marker = nanoid(6).toLowerCase();
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id,
        name: `Journal Kitchen ${marker}`,
        slug: `journal-${marker}`,
        vendorType: 'RESTAURANT',
        phone: '+5926999777',
        addressLine1: '1 Empty Corner', city: 'Georgetown', region: 'Demerara',
        latitude: EMPTY.lat, longitude: EMPTY.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
        minOrderAmount: 0,
      },
    });
    vendorIds.push(vendor.id);
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.id, categoryId: cat.id, name: `Journal Plate ${marker}`, basePrice: 1200, isAvailable: true },
    });
    itemId = item.id;
    await app.prisma.address.create({
      data: {
        userId: customerId, label: 'Home', addressLine1: '2 Empty Corner', city: 'Georgetown',
        region: 'Demerara', latitude: EMPTY.lat + 0.005, longitude: EMPTY.lng, isDefault: true,
      },
    });

    const token = app.jwt.sign({ userId: customerId, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: {
        userId: customerId, token, refreshToken: nanoid(48),
        deviceId: 'journal-test', deviceType: 'test',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    cartHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  });

  it('zero riders + flags on → honest 409; flag off → the order places', async () => {
    // No riders online near EMPTY (previous test parked them all).
    const add = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items',
      headers: cartHeaders, payload: { vendorId: vendorIds[0], itemId, quantity: 1 },
    });
    expect([200, 201]).toContain(add.statusCode);

    process.env['DISPATCH_AVAILABILITY'] = '1';
    // Fresh supply read — the availability cache may hold another test's view.
    await app.redis.del(`avail:RIDER:${EMPTY.lat.toFixed(2)}:${EMPTY.lng.toFixed(2)}`);
    const blocked = await app.inject({
      method: 'POST', url: '/api/v1/customer/checkout',
      headers: cartHeaders, payload: { paymentMethod: 'CASH' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('DELIVERY_NO_RIDERS');
    expect(blocked.json().error.message).toContain('Pickup instead');

    delete process.env['DISPATCH_AVAILABILITY'];
    const placed = await app.inject({
      method: 'POST', url: '/api/v1/customer/checkout',
      headers: cartHeaders, payload: { paymentMethod: 'CASH' },
    });
    expect(placed.statusCode).toBe(200);
    for (const o of placed.json().data.orders ?? []) orderIds.push(o.id);
  });
});
