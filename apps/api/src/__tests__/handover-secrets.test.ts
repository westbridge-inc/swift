import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [F-0011] Invariant I6 — a verifier must never RECEIVE the code it verifies.
//
// Swift's handover proof is a short code the CUSTOMER holds and the
// counterparty enters: the taxi ride PIN (the driver verifies it), the delivery
// PIN (the rider verifies it), the pickup code (the vendor verifies it). If the
// verifier can read the value out of their own API response, the check proves
// nothing — a driver can start a ride with nobody in the car, and a rider can
// close a delivery that never happened.
//
// That is exactly what shipped: `claimOrder` and six driver endpoints returned
// the full order row, and `GET /rider/orders/active` returned `ridePin` as an
// explicitly named field.
//
// THIS TEST ASSERTS ON THE SERIALIZED RESPONSE BODY, not on a service return
// value. The defect lived in serialization, so a service-level assertion would
// have passed straight through it.
//
// Every fixture below sets a REAL code. A fixture with `ridePin: null`
// serializes to nothing and would pass with the bug fully present.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const phoneBase = 592_130_000_000 + Math.floor(Math.random() * 700_000_000);

/** The values that must never reach a verifier, in any response, ever. */
const FORBIDDEN_KEYS = ['ridePin', 'pickupCode', 'pickupCodeAttempts'];

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;

/** Assert against the raw serialized payload — the bug was in serialization. */
function assertNoHandoverSecrets(payload: string, route: string) {
  for (const key of FORBIDDEN_KEYS) {
    expect(payload.includes(`"${key}"`), `${route} leaked ${key} to the party that verifies it`).toBe(false);
  }
}

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Secrets',
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
      deviceId: 'secrets-test',
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
      licensePlate: `HS ${seq}789`,
      driverLicenseUrl: 'x',
      vehicleInsuranceUrl: 'x',
    },
  });
  return { ...owned, driverId: driver.id };
}

async function makeRider() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: { userId: owned.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  return { ...owned, riderId: rider.id };
}

/** A taxi ride in a given state, always carrying a REAL PIN. */
async function makeRide(driverId: string, customerId: string, status: 'DRIVER_ASSIGNED' | 'DRIVER_EN_ROUTE' | 'DRIVER_ARRIVED' | 'RIDE_IN_PROGRESS', pin: string, ridePinVerified = false) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SEC-${nanoid(10)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status,
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
      ridePinVerified,
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

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdUserIds.length) {
    await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[F-0011] the taxi driver never receives the ride PIN they verify', () => {
  it('PUT /rides/:id/en-route does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_ASSIGNED', '111222');

    const res = await put(`/api/v1/driver/rides/${ride.id}/en-route`, {}, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/en-route');
    // The PIN is still on the row — it was withheld, not destroyed.
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.ridePin).toBe('111222');
  });

  it('PUT /rides/:id/arrived does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_EN_ROUTE', '222333');

    const res = await put(`/api/v1/driver/rides/${ride.id}/arrived`, {}, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/arrived');
  });

  it('PUT /rides/:id/verify-pin does not echo the PIN back on success', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_ARRIVED', '333444');

    const res = await put(`/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '333444' }, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/verify-pin');
  });

  it('PUT /rides/:id/start does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_ARRIVED', '444555', true);

    const res = await put(`/api/v1/driver/rides/${ride.id}/start`, {}, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/start');
  });

  it('PUT /rides/:id/complete does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'RIDE_IN_PROGRESS', '555666', true);
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: ride.id } });

    // [M-29] The bare tap is refused for a cash ride (the fare outcome
    // completes it) — and the refusal carries no secret either.
    const res = await put(`/api/v1/driver/rides/${ride.id}/complete`, {}, driver.token);
    expect(res.statusCode).toBe(409);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/complete');
  });

  it('POST /rides/:id/handover — the fare outcome that completes the ride — does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'RIDE_IN_PROGRESS', '555777', true);
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: ride.id } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/rides/${ride.id}/handover`,
      headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
      payload: { outcome: 'paid', gps: { lat: 6.755, lng: -58.155 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data?.status).toBe('DELIVERED');
    assertNoHandoverSecrets(res.payload, 'POST /driver/rides/:id/handover');
  });

  it('GET /rides/active — the polled endpoint — does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_ARRIVED', '666777');
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: ride.id } });

    const res = await get('/api/v1/driver/rides/active', driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'GET /driver/rides/active');
    // Proves the fixture was live: the route really did return this ride.
    expect(res.json().data?.id).toBe(ride.id);
  });
});

describe('[F-0011] the delivery rider never receives the delivery PIN they verify', () => {
  it('GET /orders/active does not carry the PIN', async () => {
    const rider = await makeRider();
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `SECD-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        riderId: rider.riderId,
        status: 'PICKED_UP',
        deliveryAddress: 'somewhere',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 2000,
        subtotalMarkup: 0,
        subtotalCustomer: 2000,
        deliveryFee: 700,
        totalAmount: 2700,
        paymentMethod: 'CASH',
        ridePin: '777888',
      },
    });
    createdOrderIds.push(order.id);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: order.id } });

    const res = await get('/api/v1/rider/orders/active', rider.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'GET /rider/orders/active');
    expect(res.json().data?.id).toBe(order.id);
  });
});

describe('[F-0011] withholding the code did not break verification (positive controls)', () => {
  it('the correct PIN still verifies the ride', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_ARRIVED', '888999');

    const res = await put(`/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '888999' }, driver.token);
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinVerified).toBe(true);
    expect(after.ridePinVerifiedAt).not.toBeNull();
  });

  it('a wrong PIN is still rejected and still burns an attempt', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, customer.userId, 'DRIVER_ARRIVED', '909090');

    const res = await put(`/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '010101' }, driver.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PIN');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinAttempts).toBe(1);
    expect(after.ridePinVerified).toBe(false);
  });
});
