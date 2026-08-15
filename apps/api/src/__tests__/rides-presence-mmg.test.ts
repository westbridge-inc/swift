import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';

// ---------------------------------------------------------------------------
// Presence (5.1/6.2): coarse, capped, hailable-only, jittered — never exact,
// never fake. MMG exposure (5.9/Part 7): the driver's pay link is a trip-END
// surface — null until the ride is underway.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const phoneBase = 592_150_000_000 + Math.floor(Math.random() * 800_000_000);
const GT = { lat: 6.8013, lng: -58.1553 };

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Pres', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    } as never,
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pres-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, sessionId: session.id };
}

async function makeDriver(opts: { online?: boolean; available?: boolean; at?: { lat: number; lng: number }; mmg?: string } = {}) {
  const owned = await makeUserWithSession(['MOVER'], 'MOVER');
  const at = opts.at ?? GT;
  const d = await app.prisma.driver.create({
    data: {
      userId: owned.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2018,
      vehicleColor: 'White', licensePlate: `HP 2${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isAvailable: opts.available ?? true, isOnline: opts.online ?? true,
      currentLat: at.lat, currentLng: at.lng,
      lastLocationUpdate: new Date(),
      locationSessionId: owned.sessionId,
      ...(opts.mmg ? { mmgPayUrl: opts.mmg } : {}),
    } as never,
  });
  return { ...owned, driverId: d.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.example.com';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
});

afterAll(async () => {
  if (userIds.length) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('GET /rides/presence', () => {
  it('rejects a missing point and returns coarse, capped, hailable-only cars', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const bad = await app.inject({ method: 'GET', url: '/api/v1/rides/presence', headers: { authorization: `Bearer ${c.token}` } });
    expect(bad.statusCode).toBe(400);

    const free = await makeDriver({ at: { lat: 6.8020, lng: -58.1560 } });
    await makeDriver({ online: false, at: { lat: 6.8021, lng: -58.1561 } }); // offline: invisible
    await makeDriver({ available: false, at: { lat: 6.8022, lng: -58.1562 } }); // on a trip: invisible
    await makeDriver({ at: { lat: 6.0, lng: -58.31 } }); // far away: invisible

    const res = await app.inject({
      method: 'GET', url: `/api/v1/rides/presence?lat=${GT.lat}&lng=${GT.lng}`,
      headers: { authorization: `Bearer ${c.token}` },
    });
    expect(res.statusCode).toBe(200);
    const cars: { lat: number; lng: number }[] = res.json().data.cars;
    expect(cars.length).toBe(1);
    expect(cars.length).toBeLessThanOrEqual(12);
    // No identities in the payload — coordinates only.
    expect(Object.keys(cars[0]!).sort()).toEqual(['lat', 'lng']);

    // Jittered: never the exact stored point, but within ~200m of it.
    const raw = await app.prisma.driver.findUniqueOrThrow({ where: { id: free.driverId } });
    const dMeters = Math.hypot(
      (cars[0]!.lat - Number(raw.currentLat)) * 111_320,
      (cars[0]!.lng - Number(raw.currentLng)) * 111_320 * Math.cos((6.8 * Math.PI) / 180),
    );
    expect(dMeters).toBeGreaterThan(10);
    expect(dMeters).toBeLessThan(200);

    // Deterministic within the time bucket: a refetch doesn't dance.
    const res2 = await app.inject({
      method: 'GET', url: `/api/v1/rides/presence?lat=${GT.lat}&lng=${GT.lng}`,
      headers: { authorization: `Bearer ${c.token}` },
    });
    expect(res2.json().data.cars[0]).toEqual(cars[0]);
  });
});

describe('MMG pay-link exposure (trip-end surface only)', () => {
  it('hides the link before the trip and reveals it in progress and on the receipt', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const d = await makeDriver({ mmg: 'https://pay.example.com/pay/driver-1', available: false });

    const order = await app.prisma.order.create({
      data: {
        orderNumber: `PM-${seq}`, orderType: 'TAXI', customerId: c.userId, driverId: d.driverId,
        status: 'DRIVER_EN_ROUTE',
        pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng,
        deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
        deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      } as never,
    });

    const active = (tok: string) =>
      app.inject({ method: 'GET', url: '/api/v1/rides/active', headers: { authorization: `Bearer ${tok}` } });

    // En route: the link is withheld.
    const before = await active(c.token);
    expect(before.json().data.driver.mmgPayUrl).toBeNull();

    // Underway: the link rides along for the post-trip sheet.
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'RIDE_IN_PROGRESS' } });
    const during = await active(c.token);
    expect(during.json().data.driver.mmgPayUrl).toBe('https://pay.example.com/pay/driver-1');

    // Done: the receipt fetch keeps it; a matching-phase fetch would not.
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    const receipt = await app.inject({
      method: 'GET', url: `/api/v1/rides/${order.id}`, headers: { authorization: `Bearer ${c.token}` },
    });
    expect(receipt.json().data.driver.mmgPayUrl).toBe('https://pay.example.com/pay/driver-1');

    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING', driverId: d.driverId } });
    const matching = await app.inject({
      method: 'GET', url: `/api/v1/rides/${order.id}`, headers: { authorization: `Bearer ${c.token}` },
    });
    expect(matching.json().data.driver.mmgPayUrl).toBeNull();
  });

  it('redacts an unsafe legacy driver link even on an eligible trip-end surface', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const d = await makeDriver({ mmg: 'https://evil.example/pay/legacy', available: false });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `PM-UNSAFE-${seq}`, orderType: 'TAXI', customerId: c.userId, driverId: d.driverId,
        status: 'RIDE_IN_PROGRESS', pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng,
        deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
        deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      } as never,
    });
    const active = await app.inject({
      method: 'GET', url: '/api/v1/rides/active', headers: { authorization: `Bearer ${c.token}` },
    });
    expect(active.json().data.driver.mmgPayUrl).toBeNull();
    await app.prisma.order.delete({ where: { id: order.id } });
  });
});
