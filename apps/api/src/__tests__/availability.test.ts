import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';

// ---------------------------------------------------------------------------
// Availability (spec §1/§2.1): the read derives from the SAME candidate query
// dispatch pings with; the taxi hard pre-check refuses a search that cannot
// succeed. Flag off = byte-identical behavior.
// ---------------------------------------------------------------------------

// A remote spot far from every other test's field (and the seeded city).
const SPOT = { lat: 7.72, lng: -59.31 };

let app: FastifyInstance;
let token: string;
const userIds: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];

async function makeDriver(latOffset: number) {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59259${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Avail', lastName: 'Driver',
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(u.id);
  const d = await app.prisma.driver.create({
    data: {
      userId: u.id,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `AV${nanoid(5)}`,
      driverLicenseUrl: '/uploads/t.jpg', vehicleInsuranceUrl: '/uploads/t.jpg',
      isOnline: true, isAvailable: true, documentsVerified: true,
      rideClass: 'ECONOMY' as never,
      currentLat: SPOT.lat + latOffset, currentLng: SPOT.lng,
    },
  });
  driverIds.push(d.id);
  return d;
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
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();

  const me = await app.prisma.user.create({
    data: {
      phone: `+59258${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Ava', lastName: 'Rider',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2' as never,
      customer: { create: {} },
    },
  });
  userIds.push(me.id);
  token = app.jwt.sign({ userId: me.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: me.id, token, refreshToken: nanoid(48),
      deviceId: 'avail-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
});

afterAll(async () => {
  delete process.env['DISPATCH_AVAILABILITY'];
  // Delete by customer, not by captured id — response-shape drift must not orphan rows.
  if (userIds.length > 0) await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  if (driverIds.length > 0) await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  if (userIds.length > 0) {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

const availability = () =>
  app.inject({
    method: 'GET',
    url: `/api/v1/rides/availability?lat=${SPOT.lat}&lng=${SPOT.lng}`,
    headers: { authorization: `Bearer ${token}` },
  });

const requestRide = () =>
  app.inject({
    method: 'POST',
    url: '/api/v1/rides/request',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {
      pickup: SPOT,
      dropoff: { lat: SPOT.lat + 0.02, lng: SPOT.lng },
      pickupAddress: 'Remote Pier, Nowhere',
      dropoffAddress: 'Far Landing, Nowhere',
      passengerCount: 1,
      rideClass: 'ECONOMY',
    },
  });

describe('GET /rides/availability', () => {
  it('NONE with an empty field, LOW at one driver, GOOD at three — with a nearest ETA', async () => {
    let res = await availability();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.level).toBe('NONE');

    await makeDriver(0.004);
    await app.redis.del(`avail:DRIVER:${SPOT.lat.toFixed(2)}:${SPOT.lng.toFixed(2)}`);
    res = await availability();
    expect(res.json().data.level).toBe('LOW');
    expect(res.json().data.nearestEtaMinutes).toBeGreaterThanOrEqual(1);

    await makeDriver(0.006);
    await makeDriver(-0.005);
    await app.redis.del(`avail:DRIVER:${SPOT.lat.toFixed(2)}:${SPOT.lng.toFixed(2)}`);
    res = await availability();
    expect(res.json().data.level).toBe('GOOD');
  });

  it('caches: an immediately-repeated read does not see field changes for ~10s', async () => {
    const first = await availability();
    await app.prisma.driver.updateMany({ where: { id: { in: driverIds } }, data: { isOnline: false } });
    const cachedRead = await availability();
    expect(cachedRead.json().data.level).toBe(first.json().data.level); // still cached
    await app.redis.del(`avail:DRIVER:${SPOT.lat.toFixed(2)}:${SPOT.lng.toFixed(2)}`);
    const fresh = await availability();
    expect(fresh.json().data.level).toBe('NONE'); // truth after cache clears
  });
});

describe('taxi hard pre-check (flag-gated)', () => {
  it('blocks only when the market forbids try-anyway; spec default lets the request through', async () => {
    // Field is empty (drivers parked offline by the cache test).
    // Market forbids requesting into a dead zone → honest 409 with the copy.
    process.env['DISPATCH_AVAILABILITY'] = '1';
    process.env['TAXI_ALLOW_REQUEST_ON_NONE'] = '0';
    const blocked = await requestRide();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('NO_DRIVERS_NEARBY');
    expect(blocked.json().error.message).toContain('the moment one comes online');

    // Try-anyway is the spec DEFAULT (§2.1): flag on, config unset → proceed
    // (some drivers come online mid-search).
    delete process.env['TAXI_ALLOW_REQUEST_ON_NONE'];
    const tryAnyway = await requestRide();
    expect([200, 201]).toContain(tryAnyway.statusCode);
    const tried = tryAnyway.json().data?.order ?? tryAnyway.json().data;
    if (tried?.id) orderIds.push(tried.id);

    // One live ride per customer — clear every active taxi order so the
    // flag-off leg can request (response shape varies; sweep by customer).
    const cleared = await app.prisma.order.updateMany({
      where: { customerId: { in: userIds }, orderType: 'TAXI', status: { notIn: ['CANCELLED', 'COMPLETED'] } },
      data: { status: 'CANCELLED' },
    });
    expect(cleared.count).toBeGreaterThanOrEqual(1);

    delete process.env['DISPATCH_AVAILABILITY'];
    const allowed = await requestRide();
    expect([200, 201]).toContain(allowed.statusCode);
    const order = allowed.json().data?.order ?? allowed.json().data;
    if (order?.id) orderIds.push(order.id);
  });
});
