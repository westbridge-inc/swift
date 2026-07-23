import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { DispatchService, sweepStaleMovers } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// Terminal transitions must FREE THE MOVER — found live in the 2026-07-12
// dispatch audit: a cash handover (the only completion path in a cash-only
// V1) left the rider isAvailable=false with currentOrderId pointing at the
// delivered order, invisible to dispatch forever. Same family: cancelOrder
// leaked committed float and never freed an assigned taxi driver, taxi
// earnings read the wrong column ($0 for every ride), a vendor's prep
// buttons 400'd the moment a rider accepted, exhausted dispatch had no
// retry, and ghost movers (dead GPS) were never swept offline.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PICKUP = { lat: 6.8, lng: -58.15 };

let app: FastifyInstance;
let orderService: OrderService;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;

// Per-run random base keeps phones from colliding with other test files or
// leftovers from a prior interrupted run (parallel vitest, shared dev DB).
const phoneBase = 592_200_000_000 + Math.floor(Math.random() * 700_000_000);

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Freeing',
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
      deviceId: 'freeing-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor() {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Freeing Vendor ${seq}`,
      slug: `freeing-vendor-${nanoid(10).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 900 + seq}`,
      addressLine1: '1 Freeing Way',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: PICKUP.lat,
      longitude: PICKUP.lng,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  return { ...owned, vendorId: vendor.id };
}

async function makeRider(opts: { online?: boolean; available?: boolean; lastLocationUpdate?: Date; committedFloat?: number; at?: { lat: number; lng: number } } = {}) {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: owned.userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      floatLimit: 100_000,
      committedFloat: opts.committedFloat ?? 0,
      isOnline: opts.online ?? false,
      isAvailable: opts.available ?? true,
      currentLat: (opts.at ?? PICKUP).lat,
      currentLng: (opts.at ?? PICKUP).lng,
      ...(opts.lastLocationUpdate ? { lastLocationUpdate: opts.lastLocationUpdate } : {}),
    },
  });
  return { ...owned, riderId: rider.id };
}

async function makeDriver(opts: { online?: boolean; lastLocationUpdate?: Date; at?: { lat: number; lng: number } } = {}) {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2018,
      vehicleColor: 'Silver',
      licensePlate: `FR ${seq}11`,
      driverLicenseUrl: 'x',
      vehicleInsuranceUrl: 'x',
      documentsVerified: true,
      isOnline: opts.online ?? false,
      isAvailable: true,
      currentLat: (opts.at ?? PICKUP).lat,
      currentLng: (opts.at ?? PICKUP).lng,
      ...(opts.lastLocationUpdate ? { lastLocationUpdate: opts.lastLocationUpdate } : {}),
    },
  });
  return { ...owned, driverId: driver.id };
}

async function makeOrder(
  customerId: string,
  vendorId: string | null,
  status: OrderStatus,
  opts: {
    riderId?: string;
    driverId?: string;
    orderType?: 'FOOD_DELIVERY' | 'TAXI';
    taxiFareTotal?: number;
    subtotalBase?: number;
    at?: { lat: number; lng: number };
  } = {},
) {
  const at = opts.at ?? PICKUP;
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `FR-${nanoid(10)}`,
      orderType: opts.orderType ?? 'FOOD_DELIVERY',
      customerId,
      ...(vendorId ? { vendorId } : {}),
      status,
      fulfillment: 'DELIVERY',
      pickupAddress: 'Vendor HQ',
      pickupLat: at.lat,
      pickupLng: at.lng,
      deliveryAddress: 'Customer door',
      deliveryLat: at.lat + 0.01,
      deliveryLng: at.lng + 0.01,
      subtotalBase: opts.subtotalBase ?? 1000,
      subtotalMarkup: 0,
      subtotalCustomer: opts.subtotalBase ?? 1000,
      deliveryFee: opts.orderType === 'TAXI' ? 0 : 500,
      totalAmount: opts.taxiFareTotal ?? (opts.subtotalBase ?? 1000) + 500,
      paymentMethod: 'CASH',
      ...(opts.taxiFareTotal != null ? { taxiFareTotal: opts.taxiFareTotal } : {}),
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
      ...(opts.driverId ? { driverId: opts.driverId } : {}),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  orderService = new OrderService(app.prisma, app.io);
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

// ---------------------------------------------------------------------------
// 1. The cash handover frees the rider (the live-found production blocker)
// ---------------------------------------------------------------------------
describe('handover frees the rider', () => {
  it('paid handover: rider is freed, counted, and float released', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider({ committedFloat: 1000 });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ARRIVED', { riderId: rider.riderId });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: order.id },
    });

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'paid',
      gps: { lat: PICKUP.lat + 0.01, lng: PICKUP.lng + 0.01 },
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
    expect(freed.totalDeliveries).toBe(1);
    expect(Number(freed.committedFloat)).toBe(0);
  });

  it('failed handover (no_show): order FAILS, rider freed, float released, no delivery counted', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider({ committedFloat: 1000 });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ARRIVED', { riderId: rider.riderId });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: order.id },
    });

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'no_show',
      gps: { lat: PICKUP.lat + 0.01, lng: PICKUP.lng + 0.01 },
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('FAILED');

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
    expect(freed.totalDeliveries).toBe(0);
    expect(Number(freed.committedFloat)).toBe(0);
  });

  it('freeing is guarded: a rider already on a NEW job is not clobbered', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const oldOrder = await makeOrder(customer.userId, vendor.vendorId, 'ARRIVED', { riderId: rider.riderId });
    // Rider somehow already points at a different, newer job.
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: 'a-newer-job' },
    });

    await orderService.updateStatus(oldOrder.id, 'DELIVERED', rider.userId, 'late terminal');

    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(after.currentOrderId).toBe('a-newer-job'); // untouched
    expect(after.isAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. cancelOrder: float release + driver freeing (paths that skip updateStatus)
// ---------------------------------------------------------------------------
describe('cancelOrder frees movers and float', () => {
  it('customer cancel after rider assignment releases the committed float', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider({ committedFloat: 1000 });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: order.id },
    });

    await orderService.cancelOrder(order.id, customer.userId, 'changed my mind');

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
    expect(Number(freed.committedFloat)).toBe(0);
  });

  it('taxi cancel after driver assignment frees the driver', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeOrder(customer.userId, null, 'DRIVER_ASSIGNED', {
      orderType: 'TAXI',
      driverId: driver.driverId,
      taxiFareTotal: 2300,
    });
    await app.prisma.driver.update({
      where: { id: driver.driverId },
      data: { isAvailable: false, currentRideId: ride.id },
    });

    await orderService.cancelOrder(ride.id, customer.userId, 'no longer needed');

    const freed = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentRideId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Taxi earnings: the driver keeps the WHOLE fare (zero-commission model)
// ---------------------------------------------------------------------------
describe('taxi earnings', () => {
  it('credits taxiFareTotal, not the (zero) deliveryFee', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeOrder(customer.userId, null, 'DELIVERED', {
      orderType: 'TAXI',
      driverId: driver.driverId,
      taxiFareTotal: 2300,
    });

    await orderService.createEarnings(ride.id);

    const earning = await app.prisma.earning.findFirst({
      where: { orderId: ride.id, type: 'TAXI_FARE' },
    });
    expect(earning).not.toBeNull();
    expect(Number(earning!.amount)).toBe(2300);
  });
});

// ---------------------------------------------------------------------------
// 4. Vendor prep progress while a rider owns the status lane
// ---------------------------------------------------------------------------
describe('vendor prep signal with rider assigned', () => {
  it('preparing + ready work via timestamps without touching the courier status', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId });

    const prep = await inject('PUT', `/api/v1/vendor/orders/${order.id}/preparing`, {}, vendor.token);
    expect(prep.statusCode).toBe(200);

    let row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('RIDER_ASSIGNED'); // courier lane untouched
    expect(row.preparingAt).not.toBeNull();
    expect(row.readyAt).toBeNull();

    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, {}, vendor.token);
    expect(ready.statusCode).toBe(200);

    row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('RIDER_ASSIGNED');
    expect(row.readyAt).not.toBeNull();

    // The rider at the counter is told the bag is ready.
    const note = await app.prisma.notification.findFirst({
      where: { userId: rider.userId, title: 'Order ready for pickup' },
    });
    expect(note).not.toBeNull();

    // Double-tap is idempotent, not an error.
    const again = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, {}, vendor.token);
    expect(again.statusCode).toBe(200);
  });

  it('ready during courier states backfills preparingAt when the kitchen skipped it', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'RIDER_EN_ROUTE_PICKUP', { riderId: rider.riderId });

    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, {}, vendor.token);
    expect(ready.statusCode).toBe(200);

    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.preparingAt).not.toBeNull();
    expect(row.readyAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Vendor retry-dispatch — the "hold it and retry" the notification promises
// ---------------------------------------------------------------------------
describe('vendor retry-dispatch', () => {
  // Own patch of map: dispatch tests ranking real geo-candidates must not see
  // riders parked at the shared PICKUP point by other blocks (or other files).
  const RETRY_AT = { lat: 7.51, lng: -59.51 };

  it('re-runs the search and lands an offer on an online rider', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider({ online: true, at: RETRY_AT });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { at: RETRY_AT });
    // Simulate a previous exhausted cascade: rider had declined.
    await app.redis.sadd(`dispatch:declined:${order.id}`, rider.riderId);
    await app.redis.set(`dispatch:round:${order.id}`, '2');

    const res = await inject('POST', `/api/v1/vendor/orders/${order.id}/retry-dispatch`, {}, vendor.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.searching).toBe(true);

    // The retry cleared the decline memory and offered this rider again.
    const offered = await app.redis.get(`dispatch:offer:${order.id}`);
    expect(offered).toBe(rider.riderId);
    await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:declined:${order.id}`, `dispatch:round:${order.id}`);
  });

  it('409s once a rider is assigned', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId });

    const res = await inject('POST', `/api/v1/vendor/orders/${order.id}/retry-dispatch`, {}, vendor.token);
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 6. Exhaustion auto-retry — one scheduled re-sweep, then the honest notices
// ---------------------------------------------------------------------------
describe('dispatch exhaustion auto-retry', () => {
  // An empty patch of map — no mover fixture is ever placed here.
  const EXHAUST_AT = { lat: 7.61, lng: -59.61 };

  it('retries up to the cap (default 3), then sends the final notices [SWIFT-065]', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    // No riders online anywhere near this order.
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { at: EXHAUST_AT });

    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    const dispatch = new DispatchService(
      app.prisma,
      app.redis,
      app.io,
      new HaversineMapsProvider(),
      async () => {},
      async (orderId, delayMs) => {
        redispatches.push({ orderId, delayMs });
        return true;
      },
    );

    // Attempts 1 and 2 (< EXHAUST_CAP=3) each schedule one more re-sweep.
    const first = await dispatch.dispatchOrder(order.id);
    expect(first.exhausted).toBe(true);
    expect(redispatches).toHaveLength(1);
    const retrying = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, data: { path: ['kind'], equals: 'dispatch_retrying' } },
    });
    expect(retrying).not.toBeNull();

    const second = await dispatch.dispatchOrder(order.id);
    expect(second.exhausted).toBe(true);
    expect(redispatches).toHaveLength(2);

    // The 3rd exhaustion is TERMINAL — no further cascade, final notices sent.
    const third = await dispatch.dispatchOrder(order.id);
    expect(third.exhausted).toBe(true);
    expect(redispatches).toHaveLength(2); // capped — never an unbounded loop
    const final = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, data: { path: ['kind'], equals: 'dispatch_exhausted' } },
    });
    expect(final).not.toBeNull();
    // The terminal marker persists well past the old 1h TTL (no hourly re-cascade).
    expect(await app.redis.ttl(`dispatch:exhausts:${order.id}`)).toBeGreaterThan(3600);
    await app.redis.del(`dispatch:exhausts:${order.id}`);
  });

  it('without a scheduler (tests, degraded boot) exhaustion is immediately final', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { at: EXHAUST_AT });

    const dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider());
    const res = await dispatch.dispatchOrder(order.id);
    expect(res.exhausted).toBe(true);
    const final = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, data: { path: ['kind'], equals: 'dispatch_exhausted' } },
    });
    expect(final).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Driver decline endpoint (was rider-only; taxi decline now advances the cascade)
// ---------------------------------------------------------------------------
describe('driver offer decline', () => {
  const DECLINE_AT = { lat: 7.71, lng: -59.71 };

  it('clears the live offer, remembers the decline, and cascades on', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver({ online: true, at: DECLINE_AT });
    const ride = await makeOrder(customer.userId, null, 'PENDING', { orderType: 'TAXI', taxiFareTotal: 2300, at: DECLINE_AT });

    const dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider());
    const offered = await dispatch.dispatchOrder(ride.id);
    expect(offered.offered).toBe(driver.driverId);

    const res = await inject('POST', '/api/v1/driver/offers/decline', { orderId: ride.id }, driver.token);
    expect(res.statusCode).toBe(200);

    const offerKey = await app.redis.get(`dispatch:offer:${ride.id}`);
    expect(offerKey).toBeNull(); // this driver's offer is gone (cascade exhausted — no other drivers)
    const declined = await app.redis.smembers(`dispatch:declined:${ride.id}`);
    expect(declined).toContain(driver.driverId);
    await app.redis.del(`dispatch:declined:${ride.id}`, `dispatch:round:${ride.id}`, `dispatch:exhausts:${ride.id}`);
  });
});

// ---------------------------------------------------------------------------
// 8. Ghost-mover sweep — dead GPS means offline, not "eats offers forever"
// ---------------------------------------------------------------------------
describe('sweepStaleMovers', () => {
  it('forces offline movers whose GPS is stale and leaves fresh ones alone', async () => {
    const staleRider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000) });
    const freshRider = await makeRider({ online: true, lastLocationUpdate: new Date() });
    const staleDriver = await makeDriver({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000) });

    const swept = await sweepStaleMovers(app.prisma);
    expect(swept.riders).toBeGreaterThanOrEqual(1);
    expect(swept.drivers).toBeGreaterThanOrEqual(1);

    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: staleRider.riderId } })).isOnline).toBe(false);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: freshRider.riderId } })).isOnline).toBe(true);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: staleDriver.driverId } })).isOnline).toBe(false);
  });
});
