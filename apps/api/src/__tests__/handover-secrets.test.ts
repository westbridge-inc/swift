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
import { vendorRoutes } from '../modules/vendor/vendor.routes';
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
const createdVendorIds: string[] = [];
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

/** A passenger of their own for each ride: one customer can hold only one live
 *  taxi (orders_one_live_taxi_per_customer_key), and every ride here is live. */
async function newPassenger() {
  return makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
}

/** A taxi ride in a given state, always carrying a REAL PIN. */
async function makeRide(
  driverId: string,
  customerId: string,
  status: 'DRIVER_ASSIGNED' | 'DRIVER_EN_ROUTE' | 'DRIVER_ARRIVED' | 'RIDE_IN_PROGRESS',
  pin: string,
  ridePinVerified = false,
  pickup: { lat: number; lng: number } | null = null,
) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SEC-${nanoid(10)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status,
      pickupLat: pickup?.lat ?? null,
      pickupLng: pickup?.lng ?? null,
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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await app.prisma.alertDelivery.deleteMany({ where: { subjectId: { in: createdOrderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdVendorIds.length) await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  if (createdUserIds.length) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[F-0011] the taxi driver never receives the ride PIN they verify', () => {
  it('PUT /rides/:id/en-route does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_ASSIGNED', '111222');

    const res = await put(`/api/v1/driver/rides/${ride.id}/en-route`, {}, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/en-route');
    // The PIN is still on the row — it was withheld, not destroyed.
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.ridePin).toBe('111222');
  });

  it('PUT /rides/:id/arrived does not carry the PIN', async () => {
    const driver = await makeDriver();
    // [E19] The arrival gate reads the driver's server-side fix against the
    // ride's pickup point; give this fixture a truthful fresh fix so the
    // assertion below keeps exercising the response, not the gate.
    await app.prisma.driver.update({
      where: { id: driver.driverId },
      data: { currentLat: 6.8013, currentLng: -58.1551, lastLocationUpdate: new Date() },
    });
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_EN_ROUTE', '222333', false, { lat: 6.8013, lng: -58.1551 });

    const res = await put(`/api/v1/driver/rides/${ride.id}/arrived`, {}, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/arrived');
  });

  it('PUT /rides/:id/verify-pin does not echo the PIN back on success', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_ARRIVED', '333444');

    const res = await put(`/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '333444' }, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/verify-pin');
  });

  it('PUT /rides/:id/start does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_ARRIVED', '444555', true);

    const res = await put(`/api/v1/driver/rides/${ride.id}/start`, {}, driver.token);
    expect(res.statusCode).toBe(200);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/start');
  });

  it('PUT /rides/:id/complete does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'RIDE_IN_PROGRESS', '555666', true);
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: ride.id } });

    // [M-29] The bare tap is refused for a cash ride (the fare outcome
    // completes it) — and the refusal carries no secret either.
    const res = await put(`/api/v1/driver/rides/${ride.id}/complete`, {}, driver.token);
    expect(res.statusCode).toBe(409);
    assertNoHandoverSecrets(res.payload, 'PUT /driver/rides/:id/complete');
  });

  it('POST /rides/:id/handover — the fare outcome that completes the ride — does not carry the PIN', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'RIDE_IN_PROGRESS', '555777', true);
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
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_ARRIVED', '666777');
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

  it('[MKT-F057] a goods order with a real door PIN never leaks it on the delivered path', async () => {
    const rider = await makeRider();
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `SECG-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        riderId: rider.riderId,
        status: 'ARRIVED',
        deliveryAddress: 'somewhere',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 2000,
        subtotalMarkup: 0,
        subtotalCustomer: 2000,
        deliveryFee: 700,
        totalAmount: 2700,
        paymentMethod: 'MOBILE_MONEY',
        paymentStatus: 'CAPTURED',
        ridePin: '135790',
      },
    });
    createdOrderIds.push(order.id);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: order.id } });

    // The refusal answers WITHOUT echoing the secret it compared against.
    const wrong = await put(`/api/v1/rider/orders/${order.id}/delivered`, { ridePin: '000001' }, rider.token);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_PIN');
    assertNoHandoverSecrets(wrong.payload, 'PUT /rider/orders/:id/delivered (refusal)');

    // The completion answers without echoing it either.
    const done = await put(`/api/v1/rider/orders/${order.id}/delivered`, { ridePin: '135790' }, rider.token);
    expect(done.statusCode).toBe(200);
    expect(done.json().data?.status).toBe('DELIVERED');
    assertNoHandoverSecrets(done.payload, 'PUT /rider/orders/:id/delivered (success)');
  });
});

describe('[F-0011] withholding the code did not break verification (positive controls)', () => {
  it('the correct PIN still verifies the ride', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_ARRIVED', '888999');

    const res = await put(`/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '888999' }, driver.token);
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinVerified).toBe(true);
    expect(after.ridePinVerifiedAt).not.toBeNull();
  });

  it('a wrong PIN is still rejected and still burns an attempt', async () => {
    const driver = await makeDriver();
    const ride = await makeRide(driver.driverId, (await newPassenger()).userId, 'DRIVER_ARRIVED', '909090');

    const res = await put(`/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: '010101' }, driver.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PIN');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.ridePinAttempts).toBe(1);
    expect(after.ridePinVerified).toBe(false);
  });
});

// [F1 · 28 Oct 2026] The STORE is the pickup-code verifier, and on a delivery
// it hands the goods to the rider who verifies the customer's delivery PIN.
// Kitchen progress recorded while a rider already owns the status lane
// (recordPrepProgress) and the store's decline answered with the full order
// row, so the store could read both codes out of its own tap's response.
describe('[F1] the store never receives the delivery PIN or the pickup code', () => {
  async function makeStore() {
    const owner = await makeUserWithSession(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: ownerRow.id, name: `Secrets Kitchen ${seq}`, slug: `secrets-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
        phone: `+${phoneBase + 500_000 + seq}`, addressLine1: 'Secrets Street', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    createdVendorIds.push(vendor.id);
    return { ...owner, vendorId: vendor.id };
  }

  /** A store order carrying REAL codes (a null code would serialize to nothing and pass with the bug present). */
  async function makeStoreOrder(vendorId: string, data: {
    status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'RIDER_ASSIGNED' | 'RIDER_EN_ROUTE_PICKUP' | 'RIDER_ARRIVED_PICKUP';
    fulfillment: 'DELIVERY' | 'PICKUP';
    riderId?: string;
    preparingAt?: Date;
  }) {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `SECV-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        vendorId,
        status: data.status,
        fulfillment: data.fulfillment,
        ...(data.fulfillment === 'DELIVERY' ? { fulfillmentMode: 'PLATFORM_RIDER' as const } : {}),
        riderId: data.riderId ?? null,
        preparingAt: data.preparingAt ?? null,
        deliveryAddress: 'somewhere',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 2000,
        subtotalMarkup: 0,
        subtotalCustomer: 2000,
        deliveryFee: 700,
        totalAmount: 2700,
        paymentMethod: 'CASH',
        ridePin: '246813',
        pickupCode: '975310',
      },
    });
    createdOrderIds.push(order.id);
    return order;
  }

  const storePut = (store: { token: string; vendorId: string }, url: string, payload: unknown = {}) => app.inject({
    method: 'PUT',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${store.token}`, 'x-vendor-id': store.vendorId },
  });

  it('PUT /vendor/orders/:id/preparing with a rider already assigned does not carry the codes', async () => {
    const store = await makeStore();
    const rider = await makeRider();
    const order = await makeStoreOrder(store.vendorId, { status: 'RIDER_ASSIGNED', fulfillment: 'DELIVERY', riderId: rider.riderId });

    const res = await storePut(store, `/api/v1/vendor/orders/${order.id}/preparing`);
    expect(res.statusCode, res.body).toBe(200);
    // Proves the milestone path ran (not the double-tap answer).
    expect(res.json().data?.preparingAt).toBeTruthy();
    assertNoHandoverSecrets(res.payload, 'PUT /vendor/orders/:id/preparing (rider assigned)');
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.ridePin).toBe('246813');
    expect(row.preparingAt).not.toBeNull();
  });

  it('PUT /vendor/orders/:id/ready with a rider already assigned does not carry the codes', async () => {
    const store = await makeStore();
    const rider = await makeRider();
    const order = await makeStoreOrder(store.vendorId, { status: 'RIDER_EN_ROUTE_PICKUP', fulfillment: 'DELIVERY', riderId: rider.riderId, preparingAt: new Date() });

    const res = await storePut(store, `/api/v1/vendor/orders/${order.id}/ready`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data?.readyAt).toBeTruthy();
    assertNoHandoverSecrets(res.payload, 'PUT /vendor/orders/:id/ready (rider assigned)');
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.readyAt).not.toBeNull();
  });

  it('PUT /vendor/orders/:id/ready, Mark ready backfilling preparing, does not carry the codes', async () => {
    const store = await makeStore();
    const rider = await makeRider();
    const order = await makeStoreOrder(store.vendorId, { status: 'RIDER_ARRIVED_PICKUP', fulfillment: 'DELIVERY', riderId: rider.riderId });

    const res = await storePut(store, `/api/v1/vendor/orders/${order.id}/ready`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data?.readyAt).toBeTruthy();
    assertNoHandoverSecrets(res.payload, 'PUT /vendor/orders/:id/ready (backfill)');
  });

  it('PUT /vendor/orders/:id/reject of a pickup order does not carry the pickup code', async () => {
    const store = await makeStore();
    const order = await makeStoreOrder(store.vendorId, { status: 'PREPARING', fulfillment: 'PICKUP' });

    const res = await storePut(store, `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'Out of stock' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data?.status).toBe('CANCELLED');
    assertNoHandoverSecrets(res.payload, 'PUT /vendor/orders/:id/reject (pickup)');
  });

  it('PUT /vendor/orders/:id/reject of a delivery order does not carry the delivery PIN', async () => {
    const store = await makeStore();
    const order = await makeStoreOrder(store.vendorId, { status: 'ACCEPTED', fulfillment: 'DELIVERY' });

    const res = await storePut(store, `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'Closing early' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data?.status).toBe('CANCELLED');
    // The store screen still gets the customer's first name it shows on the declined card.
    expect(res.json().data?.customer?.firstName).toBe('Secrets');
    assertNoHandoverSecrets(res.payload, 'PUT /vendor/orders/:id/reject (delivery)');
  });
});
