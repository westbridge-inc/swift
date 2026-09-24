import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [E19] Taxi arrival is driver-reported: the route must refuse a status claim
// the server-side location stream cannot support, and the passenger — the one
// party who can see the car — must hold the one-tap override that keeps a
// driver with a broken fix from ever being stranded.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Disjoint from every other suite's fixed numbers and random windows: no
// generator or literal in apps/*/src produces 592_020_000_000..592_027_999_999.
const phoneBase = 592_020_000_000 + Math.floor(Math.random() * 8_000_000);

/** The Georgetown anchor the evidence unit tests already use. */
const PICKUP = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Gate',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'arrival-gate-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeDriver(opts: { lat?: number | null; lng?: number | null; at?: Date | null } = {}) {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2018,
      vehicleColor: 'Silver',
      licensePlate: `E19 ${seq}789`,
      driverLicenseUrl: 'x',
      vehicleInsuranceUrl: 'x',
      currentLat: opts.lat ?? null,
      currentLng: opts.lng ?? null,
      lastLocationUpdate: opts.at ?? null,
    },
  });
  return { ...owned, driverId: driver.id };
}

/** A taxi ride in DRIVER_EN_ROUTE at a named pickup point. */
async function makeRide(driverId: string, customerId: string, pickup: { lat: number; lng: number }) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `E19-${nanoid(10)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'DRIVER_EN_ROUTE',
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      deliveryAddress: 'dropoff',
      deliveryLat: 6.8143,
      deliveryLng: -58.1443,
      subtotalBase: 1500,
      subtotalMarkup: 0,
      subtotalCustomer: 1500,
      deliveryFee: 0,
      totalAmount: 1500,
      paymentMethod: 'CASH',
      ridePin: `${100000 + seq}`,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function put(url: string, payload: unknown, token: string) {
  return app.inject({
    method: 'PUT',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

function post(url: string, payload: unknown, token: string) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

let customer: { userId: string; token: string };
let otherCustomer: { userId: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  otherCustomer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  const ids = createdUserIds;
  if (ids.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.orderStatusLog.deleteMany({
      where: { OR: [{ orderId: { in: createdOrderIds } }, { changedBy: { in: ids } }] },
    });
    await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await app.close();
});

describe('[E19] the driver-arrival gate refuses a claim the location stream cannot support', () => {
  it('a declaration from across town is refused and leaves the order untouched', async () => {
    const driver = await makeDriver({ lat: 6.87, lng: -58.1551 }); // ~7.6 km away, fresh
    const ride = await makeRide(driver.driverId, customer.userId, PICKUP);

    const res = await put(`/api/v1/driver/rides/${ride.id}/arrived`, {}, driver.token);

    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe('ARRIVAL_NOT_VERIFIED');
    expect(err.details.verdict).toBe('far');
    expect(err.details.allowPassengerConfirm).toBe(true);
    expect(typeof err.details.distanceM).toBe('number');

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_EN_ROUTE');
    expect(order.driverArrivedAt).toBeNull();
    const logs = await app.prisma.orderStatusLog.findMany({ where: { orderId: ride.id, status: 'DRIVER_ARRIVED' } });
    expect(logs).toHaveLength(0);
  });

  it('a fix that is too old is refused as stale, not credited', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const driver = await makeDriver({ lat: PICKUP.lat, lng: PICKUP.lng, at: stale });
    const ride = await makeRide(driver.driverId, customer.userId, PICKUP);

    const res = await put(`/api/v1/driver/rides/${ride.id}/arrived`, {}, driver.token);

    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe('ARRIVAL_NOT_VERIFIED');
    expect(err.details.verdict).toBe('stale');
    expect(err.details.fixAgeMs).toBeGreaterThan(120_000);
    expect(err.details.allowPassengerConfirm).toBe(true);

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_EN_ROUTE');
    expect(order.driverArrivedAt).toBeNull();
  });

  it('a driver with no fix on record is refused with the passenger escape, never stranded silently', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, PICKUP);

    const res = await put(`/api/v1/driver/rides/${ride.id}/arrived`, {}, driver.token);

    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe('ARRIVAL_NOT_VERIFIED');
    expect(err.details.verdict).toBe('no-fix');
    expect(err.details.allowPassengerConfirm).toBe(true);
    expect(err.message).toContain('Ask the passenger to confirm your arrival');

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_EN_ROUTE');
    expect(order.driverArrivedAt).toBeNull();
  });

  it('a fresh fix at the door still passes, and the clock + evidence are written', async () => {
    const driver = await makeDriver({ lat: 6.8016, lng: -58.1553, at: new Date() }); // ~40 m, fresh
    const ride = await makeRide(driver.driverId, customer.userId, PICKUP);

    const res = await put(`/api/v1/driver/rides/${ride.id}/arrived`, {}, driver.token);

    expect(res.statusCode).toBe(200);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_ARRIVED');
    expect(order.driverArrivedAt).not.toBeNull();
    const log = await app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: ride.id, status: 'DRIVER_ARRIVED' },
    });
    expect(log.note).toMatch(/\d+m from the pickup point/);
  });
});

describe('[E19] the passenger confirm is the one-tap override, and it is owner-gated', () => {
  it('the ride owner confirms arrival for a driver who is far away', async () => {
    const driver = await makeDriver({ lat: 6.87, lng: -58.1551 });
    const ride = await makeRide(driver.driverId, customer.userId, PICKUP);

    const res = await post(`/api/v1/rides/${ride.id}/confirm-driver-arrival`, {}, customer.token);

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DRIVER_ARRIVED');
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_ARRIVED');
    expect(order.driverArrivedAt).not.toBeNull();
    const log = await app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: ride.id, status: 'DRIVER_ARRIVED' },
    });
    expect(log.note).toContain('passenger');
  });

  it('a different customer cannot start another ride\'s waiting clock', async () => {
    const driver = await makeDriver({ lat: 6.87, lng: -58.1551 });
    const ride = await makeRide(driver.driverId, customer.userId, PICKUP);

    const res = await post(`/api/v1/rides/${ride.id}/confirm-driver-arrival`, {}, otherCustomer.token);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATUS');
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_EN_ROUTE');
    expect(order.driverArrivedAt).toBeNull();
    const logs = await app.prisma.orderStatusLog.findMany({ where: { orderId: ride.id, status: 'DRIVER_ARRIVED' } });
    expect(logs).toHaveLength(0);
  });
});
