import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';

// ---------------------------------------------------------------------------
// Earner demand reads (dashboard plan Phase A): REAL waiting work, privacy
// structural — taxi pickups rounded ~300 m with zero customer fields;
// delivery demand grouped by store. Remote corner, away from every suite.
// ---------------------------------------------------------------------------

const SPOT = { lat: 7.91, lng: -59.33 };
const FAR = { lat: 8.4, lng: -59.9 };

let app: FastifyInstance;
let driverToken: string;
let riderToken: string;
const userIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
let driverId: string;
let riderId: string;
let ownerId: string;
let customerId: string;
const marker = nanoid(6).toLowerCase();

async function makeUser(roles: string[], activeRole: string) {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59261${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'De', lastName: 'Mand',
      roles: roles as never[], activeRole: activeRole as never,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: u.id, token, refreshToken: nanoid(48),
      deviceId: 'demand-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  return { user: u, token };
}

function taxiRequest(at: { lat: number; lng: number }, minutesAgo = 1) {
  return app.prisma.order.create({
    data: {
      orderNumber: `DMD-${nanoid(8)}`,
      orderType: 'TAXI' as never,
      customerId,
      status: 'PENDING' as never,
      pickupLat: at.lat, pickupLng: at.lng,
      pickupAddress: 'x', deliveryAddress: 'y',
      deliveryLat: at.lat + 0.03, deliveryLng: at.lng,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH' as never,
      placedAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
}

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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customerId = customer.user.id;

  const d = await makeUser(['MOVER'], 'MOVER');
  driverToken = d.token;
  const driver = await app.prisma.driver.create({
    data: {
      userId: d.user.id,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `DM${nanoid(5)}`,
      driverLicenseUrl: '/uploads/t.jpg', vehicleInsuranceUrl: '/uploads/t.jpg',
      currentLat: SPOT.lat, currentLng: SPOT.lng,
    },
  });
  driverId = driver.id;

  const r = await makeUser(['MOVER'], 'MOVER');
  riderToken = r.token;
  const rider = await app.prisma.rider.create({
    data: {
      userId: r.user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      currentLat: SPOT.lat, currentLng: SPOT.lng,
    },
  });
  riderId = rider.id;

  const v = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: v.user.id } });
  ownerId = owner.id;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Demand Kitchen ${marker}`,
      slug: `demand-${marker}`,
      vendorType: 'RESTAURANT',
      phone: '+5926999444',
      addressLine1: '4 Demand Drive', city: 'Georgetown', region: 'Demerara',
      latitude: SPOT.lat + 0.004, longitude: SPOT.lng,
      status: 'ACTIVE', isVerified: true,
    },
  });
  vendorIds.push(vendor.id);

  // Taxi demand field: two fresh nearby, one far, one stale.
  for (const o of [
    await taxiRequest({ lat: SPOT.lat + 0.002, lng: SPOT.lng }),
    await taxiRequest({ lat: SPOT.lat - 0.003, lng: SPOT.lng + 0.002 }),
    await taxiRequest(FAR),
    await taxiRequest({ lat: SPOT.lat, lng: SPOT.lng + 0.001 }, 20),
  ]) orderIds.push(o.id);
  await app.prisma.supplyWatch.create({
    data: { customerId, pool: 'DRIVER', lat: SPOT.lat + 0.001, lng: SPOT.lng, expiresAt: new Date(Date.now() + 3600_000) },
  });

  // Delivery demand at the store: 2 READY + 1 PREPARING unassigned, 1 held, 1 taken.
  const mkDelivery = (status: string, extra: Record<string, unknown> = {}) =>
    app.prisma.order.create({
      data: {
        orderNumber: `DMD-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY' as never,
        customerId,
        vendorId: vendor.id,
        status: status as never,
        fulfillment: 'DELIVERY' as never,
        deliveryAddress: 'x', deliveryLat: SPOT.lat + 0.01, deliveryLng: SPOT.lng,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
        deliveryFee: 500, totalAmount: 2500,
        paymentMethod: 'CASH' as never,
        ...extra,
      },
    });
  for (const o of [
    await mkDelivery('READY_FOR_PICKUP'),
    await mkDelivery('READY_FOR_PICKUP'),
    await mkDelivery('PREPARING'),
    await mkDelivery('READY_FOR_PICKUP', { holdExpiresAt: new Date(Date.now() + 3600_000) }),
    await mkDelivery('READY_FOR_PICKUP', { riderId }),
  ]) orderIds.push(o.id);
});

afterAll(async () => {
  await app.prisma.supplyWatch.deleteMany({ where: { customerId: { in: userIds } } });
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (vendorIds.length > 0) await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (ownerId) await app.prisma.vendorOwner.deleteMany({ where: { id: ownerId } });
  if (riderId) await app.prisma.rider.deleteMany({ where: { id: riderId } });
  if (driverId) await app.prisma.driver.deleteMany({ where: { id: driverId } });
  if (userIds.length > 0) {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('driver demand', () => {
  it('counts fresh nearby requests + watchers; far and stale stay out; zero customer fields', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/driver/demand?lat=${SPOT.lat}&lng=${SPOT.lng}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.waiting).toBe(2);
    expect(d.watchers).toBe(1);
    expect(d.points).toHaveLength(2);
    expect(d.clusters.reduce((s: number, c: { count: number }) => s + c.count, 0)).toBe(2);
    // Privacy: rounded to the 0.003° grid, and no PII keys anywhere.
    for (const p of d.points) {
      expect(Math.abs(p.lat / 0.003 - Math.round(p.lat / 0.003))).toBeLessThan(1e-6);
    }
    expect(res.body).not.toContain('phone');
    expect(res.body).not.toContain('firstName');
    expect(res.body).not.toContain('orderNumber');
  });

  it('is driver-scoped: a rider token gets no taxi demand read', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/driver/demand?lat=${SPOT.lat}&lng=${SPOT.lng}`,
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('rider demand', () => {
  it('groups unassigned deliveries by store: READY vs SOON, fees summed; held and taken invisible', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rider/demand?lat=${SPOT.lat}&lng=${SPOT.lng}`,
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.ready).toBe(2);
    expect(d.soon).toBe(1);
    const store = d.stores.find((s: { name: string }) => s.name.includes(marker));
    expect(store).toBeTruthy();
    expect(store.ready).toBe(2);
    expect(store.soon).toBe(1);
    expect(store.feesWaiting).toBe(1500); // 3 × $500 — held + taken excluded
    expect(res.body).not.toContain('phone');
    expect(res.body).not.toContain('deliveryAddress');
  });
});
