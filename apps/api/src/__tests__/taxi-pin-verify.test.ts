import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Taxi ride PIN gate. The customer reads a 6-digit PIN to the driver; the
// driver must enter it before the ride can start — proof the right passenger
// got in the right car. Failure paths: wrong PIN burns an attempt, five wrong
// attempts locks it, and the ride cannot start until the PIN is verified.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const phoneBase = 592_120_000_000 + Math.floor(Math.random() * 800_000_000);

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'PinTest',
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
      deviceId: 'pin-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeDriver() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2018,
      vehicleColor: 'Silver',
      licensePlate: `HB ${seq}234`,
      driverLicenseUrl: 'x',
      vehicleInsuranceUrl: 'x',
    },
  });
  return { ...owned, driverId: driver.id };
}

/** A TAXI order assigned to the driver, sitting at DRIVER_ARRIVED with a
 *  known PIN — the exact moment the verify-pin gate matters. */
async function makeArrivedRide(driverId: string, customerId: string, pin: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `PIN-${nanoid(10)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'DRIVER_ARRIVED',
      deliveryAddress: 'dropoff',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 1500,
      subtotalMarkup: 0,
      subtotalCustomer: 1500,
      deliveryFee: 0,
      totalAmount: 1500,
      paymentMethod: 'CASH',
      ridePin: pin,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function inject(method: 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

let customer: { userId: string; token: string };

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
  await app.ready();

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdUserIds.length) {
    await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Taxi PIN verification — PUT /driver/rides/:id/verify-pin', () => {
  it('a wrong PIN is rejected, burns an attempt, and reports the count', async () => {
    const driver = await makeDriver();
    const ride = await makeArrivedRide(driver.driverId, customer.userId, '135790');

    const res = await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '000000' }, driver.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PIN');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinAttempts).toBe(1);
    expect(after.ridePinVerified).toBe(false);
  });

  it('the correct PIN verifies the ride', async () => {
    const driver = await makeDriver();
    const ride = await makeArrivedRide(driver.driverId, customer.userId, '246801');

    const res = await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '246801' }, driver.token);
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinVerified).toBe(true);
    expect(after.ridePinVerifiedAt).not.toBeNull();
  });

  it('the ride cannot start until the PIN is verified', async () => {
    const driver = await makeDriver();
    const ride = await makeArrivedRide(driver.driverId, customer.userId, '112233');

    const early = await inject('PUT', `/api/v1/driver/rides/${ride.id}/start`, {}, driver.token);
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('PIN_REQUIRED');

    await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '112233' }, driver.token);
    const ok = await inject('PUT', `/api/v1/driver/rides/${ride.id}/start`, {}, driver.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.status).toBe('RIDE_IN_PROGRESS');
  });

  it('locks out after five wrong attempts', async () => {
    const driver = await makeDriver();
    const ride = await makeArrivedRide(driver.driverId, customer.userId, '999888');

    for (let i = 0; i < 5; i++) {
      const r = await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '000000' }, driver.token);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_PIN');
    }
    // Sixth attempt — even with the CORRECT pin — is locked out.
    const locked = await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '999888' }, driver.token);
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinVerified).toBe(false);
  });

  it("a driver cannot verify another driver's ride", async () => {
    const driverA = await makeDriver();
    const driverB = await makeDriver();
    const ride = await makeArrivedRide(driverA.driverId, customer.userId, '555444');

    const res = await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '555444' }, driverB.token);
    expect([403, 404]).toContain(res.statusCode);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinVerified).toBe(false);
  });
});

describe('Taxi ride completion — single-winner under concurrency [SWIFT-AUD-D2-01]', () => {
  it('two concurrent completes: one wins, one 409, driver totalRides +1 exactly once', async () => {
    const driver = await makeDriver();
    const ride = await makeArrivedRide(driver.driverId, customer.userId, '654321');
    await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '654321' }, driver.token);
    const started = await inject('PUT', `/api/v1/driver/rides/${ride.id}/start`, {}, driver.token);
    expect(started.json().data.status).toBe('RIDE_IN_PROGRESS');
    // In the real flow the driver is on this ride (set at claim); the guarded
    // free + totalRides increment key off currentRideId.
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: ride.id, totalRides: 0 } });

    const results = await Promise.allSettled([
      inject('PUT', `/api/v1/driver/rides/${ride.id}/complete`, {}, driver.token),
      inject('PUT', `/api/v1/driver/rides/${ride.id}/complete`, {}, driver.token),
    ]);
    const codes = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : 0));
    // Exactly one winner; the loser is rejected (409 from the CAS, or 400 from
    // the pre-check if it serialized) — never a second success.
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c >= 400)).toHaveLength(1);

    const d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.totalRides).toBe(1); // incremented once, not twice
  });
});
