import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { startOfDayGY } from '../utils/time-gy';
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
  const session = await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'freeing-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, sessionId: session.id };
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
      ...(opts.online ? { locationSessionId: owned.sessionId } : {}),
      ...(opts.lastLocationUpdate
        ? { lastLocationUpdate: opts.lastLocationUpdate }
        : opts.online
          ? { lastLocationUpdate: new Date() }
          : {}),
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
      ...(opts.online ? { locationSessionId: owned.sessionId } : {}),
      ...(opts.lastLocationUpdate
        ? { lastLocationUpdate: opts.lastLocationUpdate }
        : opts.online
          ? { lastLocationUpdate: new Date() }
          : {}),
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
  it('atomically releases a direct assignment that commits after cancellation starts', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider({ online: true });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED');

    let assignmentStaged!: () => void;
    let resumeAssignment!: () => void;
    let cancellationRead!: () => void;
    const atAssignmentStage = new Promise<void>((resolve) => { assignmentStaged = resolve; });
    const releaseAssignment = new Promise<void>((resolve) => { resumeAssignment = resolve; });
    const atCancellationRead = new Promise<void>((resolve) => { cancellationRead = resolve; });

    const originalStage = OrderService.prototype.stageDirectRiderAssignment;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageDirectRiderAssignment')
      .mockImplementationOnce(async function (
        this: OrderService,
        tx,
        input,
      ) {
        const staged = await originalStage.call(this, tx, input);
        // The direct-accept transaction now owns Order + Rider + float, but is
        // deliberately uncommitted so cancelOrder's first read sees the old,
        // unassigned row — the exact stale-read production interleaving.
        assignmentStaged();
        await releaseAssignment;
        return staged;
      });

    // Signal only the customer-owned cancellation preview. The board-grab's
    // own preflight findFirst has already completed before assignmentStaged.
    type RaceFindFirst = (args: {
      where?: { id?: string; customerId?: string };
      [key: string]: unknown;
    }) => Promise<unknown>;
    const orderDelegate = app.prisma.order as unknown as { findFirst: RaceFindFirst };
    const originalFindFirst = orderDelegate.findFirst.bind(orderDelegate);
    const findSpy = vi.spyOn(orderDelegate, 'findFirst').mockImplementation(async (args) => {
      const found = await originalFindFirst(args);
      const where = args?.where as { id?: string; customerId?: string } | undefined;
      if (where?.id === order.id && where.customerId === customer.userId) cancellationRead();
      return found;
    });

    let acceptResponse;
    let cancellationResult;
    try {
      const acceptPending = inject('POST', `/api/v1/rider/orders/${order.id}/accept`, {}, rider.token);
      await atAssignmentStage;

      const cancellationPending = orderService.cancelOrder(order.id, customer.userId, 'changed my mind');
      await atCancellationRead;
      // Old behavior now used the stale riderId=null snapshot after its status
      // CAS and leaked both the committed float and busy Rider pointer. The new
      // transaction waits, re-reads the committed assignment, and releases it.
      resumeAssignment();
      [acceptResponse, cancellationResult] = await Promise.all([acceptPending, cancellationPending]);
    } finally {
      resumeAssignment();
      findSpy.mockRestore();
      stageSpy.mockRestore();
    }

    expect(acceptResponse!.statusCode).toBe(200);
    expect(cancellationResult).toMatchObject({ message: 'Order cancelled' });

    const [cancelled, freed, statusLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, riderId: true },
      }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: rider.riderId },
        select: { isAvailable: true, currentOrderId: true, committedFloat: true },
      }),
      app.prisma.orderStatusLog.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
        select: { status: true },
      }),
    ]);
    expect(cancelled).toEqual({ status: 'CANCELLED', riderId: rider.riderId });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
    expect(Number(freed.committedFloat)).toBe(0);
    expect(statusLogs.map((entry) => entry.status)).toEqual(['RIDER_ASSIGNED', 'CANCELLED']);
  });

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
    // [M-29] A cash fare is earned when the money is recorded: the fare
    // outcome captured it. (Without the capture the writer mints nothing —
    // taxi-cash-outcome.test.ts grades that.)
    await app.prisma.order.update({ where: { id: ride.id }, data: { paymentStatus: 'CAPTURED' } });

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
    expect(offered!.split(':')[0]).toBe(rider.riderId); // value is `<mover>:<attemptId>` [F-014-04]
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

    // Each re-sweep fires >=45s later in production; the [F-014-06]
    // single-flight lock (10s) dedups only a concurrent burst. Model the
    // elapsed delay explicitly so this compressed-time test stays honest.
    await app.redis.del(`dispatch:exhaust-lock:${order.id}`);
    const second = await dispatch.dispatchOrder(order.id);
    expect(second.exhausted).toBe(true);
    expect(redispatches).toHaveLength(2);

    // The 3rd exhaustion is TERMINAL — no further cascade, final notices sent.
    await app.redis.del(`dispatch:exhaust-lock:${order.id}`);
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

  it('delivery watchdog: a dark rider BEFORE pickup is released — order re-opens, float returns, redispatch queued [danger #32]', async () => {
    const { recoverStrandedDeliveries } = await import('../modules/dispatch/delivery-watchdog');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000), committedFloat: 2000 });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 2000 });
    await app.prisma.order.update({ where: { id: order.id }, data: { readyAt: new Date() } });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: order.id } });

    const enqueued: string[] = [];
    const result = await recoverStrandedDeliveries(app.prisma, app.redis, app.io, async (id) => { enqueued.push(id); });
    expect(result.recovered).toContain(order.id);

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('READY_FOR_PICKUP'); // honest kitchen stage restored
    expect(fresh.riderId).toBeNull();
    const freshRider = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freshRider.currentOrderId).toBeNull();
    expect(Number(freshRider.committedFloat)).toBe(0); // CASH float released with the assignment
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, rider.riderId)).toBe(1); // dark rider excluded from re-cascade
    expect(enqueued).toContain(order.id);
    await app.redis.del(`dispatch:declined:${order.id}`);
  });

  it('delivery watchdog: a dark rider WITH the goods is never auto-released — ops paged, customer told [danger #32]', async () => {
    const { recoverStrandedDeliveries } = await import('../modules/dispatch/delivery-watchdog');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000), committedFloat: 2000 });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PICKED_UP', { riderId: rider.riderId, subtotalBase: 2000 });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: order.id } });

    const result = await recoverStrandedDeliveries(app.prisma, app.redis, app.io, async () => {});
    expect(result.flagged).toContain(order.id);

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('PICKED_UP'); // custody preserved — goods are with the rider
    expect(fresh.riderId).toBe(rider.riderId);
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } })).committedFloat)).toBe(2000); // float stays: cash was fronted
    const notice = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: 'Your rider lost signal' },
    });
    expect(notice).not.toBeNull();
    await app.redis.del(`ops_page:delivery_rider_dropped:${order.id}`);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: null, committedFloat: 0 } });
  });

  it('delivery watchdog: a lingering pointer on a terminal order is healed, nothing else touched [danger #32]', async () => {
    const { recoverStrandedDeliveries } = await import('../modules/dispatch/delivery-watchdog');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000) });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'DELIVERED', { riderId: rider.riderId });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: order.id } });

    const result = await recoverStrandedDeliveries(app.prisma, app.redis, app.io, async () => {});
    expect(result.recovered).not.toContain(order.id);
    expect(result.flagged).not.toContain(order.id);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } })).currentOrderId).toBeNull();
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERED');
  });

  it('the sweep fully clears IDLE stale supply and catches null-timestamp rows [E23 / danger #20]', async () => {
    // A mover who went online but NEVER sent a fix used to evade the `lt`
    // cutoff forever; and the old sweep left isAvailable + locationSessionId
    // behind — half-cleared supply every later path had to distrust.
    const neverFixed = await makeRider({ online: true });
    await app.prisma.rider.update({
      where: { id: neverFixed.riderId },
      data: { lastLocationUpdate: null, locationSessionId: 'ghost-session', isAvailable: true },
    });
    const staleIdle = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000) });
    await app.prisma.rider.update({
      where: { id: staleIdle.riderId },
      data: { locationSessionId: 'stale-session', isAvailable: true },
    });
    // A mover mid-JOB keeps their location session — trip recovery owns that
    // custody; only the online flag drops.
    const staleBusy = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000) });
    await app.prisma.rider.update({
      where: { id: staleBusy.riderId },
      data: { locationSessionId: 'busy-session', currentOrderId: 'order-ghost', isAvailable: false },
    });

    await sweepStaleMovers(app.prisma);

    const never = await app.prisma.rider.findUniqueOrThrow({ where: { id: neverFixed.riderId } });
    expect(never.isOnline).toBe(false);
    expect(never.isAvailable).toBe(false);
    expect(never.locationSessionId).toBeNull();
    const idle = await app.prisma.rider.findUniqueOrThrow({ where: { id: staleIdle.riderId } });
    expect(idle.isOnline).toBe(false);
    expect(idle.isAvailable).toBe(false);
    expect(idle.locationSessionId).toBeNull();
    const busy = await app.prisma.rider.findUniqueOrThrow({ where: { id: staleBusy.riderId } });
    expect(busy.isOnline).toBe(false);
    expect(busy.locationSessionId).toBe('busy-session'); // custody preserved
    await app.prisma.rider.update({ where: { id: staleBusy.riderId }, data: { currentOrderId: null } });
  });

  it('closes the online-hours session of a rider it forces offline [SWIFT-143]', async () => {
    const rider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000) });
    // An open online session that began ~1h ago.
    await app.redis.set(`rider:online_since:${rider.riderId}`, String(Date.now() - 60 * 60_000));

    await sweepStaleMovers(app.prisma, undefined, app.redis);

    // Pre-fix the marker lingered → the stats endpoint counted a phantom open
    // session forever. Now it's cleared and the elapsed time is banked.
    expect(await app.redis.get(`rider:online_since:${rider.riderId}`)).toBeNull();
    const dayKey = `rider:online_ms:${rider.riderId}:${startOfDayGY().toISOString().slice(0, 10)}`;
    expect(Number(await app.redis.get(dayKey))).toBeGreaterThanOrEqual(59 * 60_000);
    await app.redis.del(dayKey);
  });
});

// ---------------------------------------------------------------------------
// [B2 under stacking] A rider may hold more than one live leg since #899, and
// `currentOrderId` is only the PRIMARY. The watchdog used to rescue that one
// order and stop, leaving a stacked sibling assigned to a rider nobody could
// reach — the exact condition the watchdog exists for, on the other leg.
// ---------------------------------------------------------------------------
describe('delivery watchdog under stacking: every leg, one pointer rule', () => {
  it('a dark rider with TWO pre-custody CASH legs: both re-open, both floats return, pointer nulls', async () => {
    const { recoverStrandedDeliveries } = await import('../modules/dispatch/delivery-watchdog');
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const c2 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    // Float committed for BOTH legs at claim time: 1500 + 2500.
    const rider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000), committedFloat: 4000 });
    const a = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 1500 });
    const b = await makeOrder(c2.userId, vendor.vendorId, 'RIDER_EN_ROUTE_PICKUP', { riderId: rider.riderId, subtotalBase: 2500 });
    await app.prisma.order.update({ where: { id: a.id }, data: { readyAt: new Date() } });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: a.id } });

    const enqueued: string[] = [];
    const result = await recoverStrandedDeliveries(app.prisma, app.redis, app.io, async (id) => { enqueued.push(id); });
    expect(result.recovered).toEqual(expect.arrayContaining([a.id, b.id]));

    // The sibling the old sweep never saw is re-opened too.
    const freshB = await app.prisma.order.findUniqueOrThrow({ where: { id: b.id } });
    expect(freshB.status).toBe('ACCEPTED');
    expect(freshB.riderId).toBeNull();
    expect(enqueued).toEqual(expect.arrayContaining([a.id, b.id]));

    const freshRider = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freshRider.currentOrderId).toBeNull();
    expect(freshRider.isAvailable).toBe(false); // gone dark is not free supply
    // MONEY: each rescued leg releases ITS OWN float, at the rescue site.
    expect(Number(freshRider.committedFloat)).toBe(0);
    for (const id of [a.id, b.id]) await app.redis.del(`dispatch:declined:${id}`);
  });

  it('leg A pre-custody + leg B WITH the goods: A re-opens, B is flagged and kept, pointer re-points to B', async () => {
    const { recoverStrandedDeliveries } = await import('../modules/dispatch/delivery-watchdog');
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const c2 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, lastLocationUpdate: new Date(Date.now() - 25 * 60_000), committedFloat: 4000 });
    const a = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 1500 });
    const b = await makeOrder(c2.userId, vendor.vendorId, 'PICKED_UP', { riderId: rider.riderId, subtotalBase: 2500 });
    // The PRIMARY points at A — the leg that will be rescued. The old sweep
    // would have nulled the pointer under B.
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: a.id } });

    const result = await recoverStrandedDeliveries(app.prisma, app.redis, app.io, async () => {});
    expect(result.recovered).toContain(a.id);
    expect(result.flagged).toContain(b.id);

    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: a.id } })).riderId).toBeNull();
    const freshB = await app.prisma.order.findUniqueOrThrow({ where: { id: b.id } });
    expect(freshB.status).toBe('PICKED_UP'); // custody preserved
    expect(freshB.riderId).toBe(rider.riderId);

    const freshRider = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freshRider.currentOrderId, 'the primary re-points to the leg still held').toBe(b.id);
    expect(freshRider.isAvailable).toBe(false);
    // Only A's float returns; B's cash was fronted and stays committed.
    expect(Number(freshRider.committedFloat)).toBe(2500);
    await app.redis.del(`dispatch:declined:${a.id}`);
    await app.redis.del(`ops_page:delivery_rider_dropped:${b.id}`);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: null, committedFloat: 0 } });
  });

  it('the rider is quarantined BEFORE any leg is rescued — no window for a fresh leg to bind', async () => {
    // Each rescue frees headroom. If the rider were only marked unavailable
    // after the last rescue, a cascade round in between could bind a new leg
    // to a rider about to be marked dark. The source order is the guarantee.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.join(__dirname, '..', 'modules', 'dispatch', 'delivery-watchdog.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Between the end of the empty-legs branch and the rescue loop there must
    // be a settle to 'offline'. (The empty-legs branch has its own; anchoring
    // AFTER it is what makes this pin unfakeable.)
    const emptyBranch = src.indexOf('legs.length === 0');
    const emptyBranchEnd = src.indexOf('continue;', emptyBranch);
    const rescueLoop = src.indexOf('for (const leg of legs)');
    expect(emptyBranch).toBeGreaterThan(-1);
    expect(rescueLoop).toBeGreaterThan(emptyBranchEnd);
    const between = src.slice(emptyBranchEnd, rescueLoop);
    expect(between, 'quarantine must sit between the empty-legs branch and the rescue loop').toContain("availability: 'offline'");
  });

  it('a quarantined rider (online, unavailable, room to spare) cannot reserve a leg', async () => {
    // isAvailable now MEANS "room for another leg", so the reserve must demand
    // it. Without this, a GPS-dark rider whose app is still awake could
    // board-grab straight through the quarantine window.
    const { reserveRiderLeg } = await import('../modules/dispatch/concurrency-policy');
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, available: false });
    const order = await makeOrder(c1.userId, vendor.vendorId, 'READY_FOR_PICKUP', { riderId: rider.riderId });
    const ok = await app.prisma.$transaction((tx) => reserveRiderLeg(tx, rider.riderId, order.id, 2));
    expect(ok).toBe(false);
    // And the same rider, available, reserves fine.
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isAvailable: true } });
    const ok2 = await app.prisma.$transaction((tx) => reserveRiderLeg(tx, rider.riderId, order.id, 2));
    expect(ok2).toBe(true);
  });

  it('settleRiderLegs is the one pointer rule: next live leg by acceptedAt, else null', async () => {
    const { settleRiderLegs } = await import('../modules/dispatch/concurrency-policy');
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true });
    const later = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId });
    const earlier = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId });
    await app.prisma.order.update({ where: { id: earlier.id }, data: { acceptedAt: new Date(Date.now() - 60_000) } });
    await app.prisma.order.update({ where: { id: later.id }, data: { acceptedAt: new Date() } });

    const settled = await app.prisma.$transaction((tx) => settleRiderLegs(tx, rider.riderId, { prisma: app.prisma }));
    expect(settled.primaryLegId).toBe(earlier.id);
    expect(settled.legsLeft).toBe(2);

    // Excluding the earlier leg (as a completion does) moves the primary on.
    const moved = await app.prisma.$transaction((tx) => settleRiderLegs(tx, rider.riderId, { prisma: app.prisma, excludeOrderId: earlier.id }));
    expect(moved.primaryLegId).toBe(later.id);

    // `offline` pins availability false whatever the room.
    await app.prisma.order.updateMany({ where: { riderId: rider.riderId }, data: { status: 'DELIVERED' } });
    const empty = await app.prisma.$transaction((tx) => settleRiderLegs(tx, rider.riderId, { availability: 'offline' }));
    expect(empty.primaryLegId).toBeNull();
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } })).isAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [B2 under stacking] Session revocation decides custody on EVERY leg.
//
// Logging out is a security action that may never be refused, so the policy
// is stage-aware per leg: goods still at the store are released and made
// dispatchable; goods with the rider are preserved and paged. Deciding on the
// primary pointer alone released the primary and left a stacked sibling
// assigned to a rider who had just logged out — or released a pre-pickup
// primary while a second leg's goods were already in the rider's hands.
// ---------------------------------------------------------------------------
describe('session revocation under stacking: custody on every leg', () => {
  async function revoke(userId: string, sessionId: string | null) {
    const { retireMoverSessionAuthorityInTransaction } = await import('../modules/mover-authority');
    return app.prisma.$transaction(async (tx) => {
      // The caller MUST hold the User row lock; the auth service does.
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
      return retireMoverSessionAuthorityInTransaction(tx, userId, sessionId);
    });
  }

  it('two pre-pickup CASH legs: both released for re-dispatch, both floats back, rider offline with no pointer', async () => {
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const c2 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, committedFloat: 4000 });
    const a = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 1500 });
    const b = await makeOrder(c2.userId, vendor.vendorId, 'RIDER_EN_ROUTE_PICKUP', { riderId: rider.riderId, subtotalBase: 2500 });
    await app.prisma.order.update({ where: { id: a.id }, data: { readyAt: new Date() } });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: a.id } });

    const cleanup = await revoke(rider.userId, rider.sessionId);
    expect(cleanup.riderId).toBe(rider.riderId);
    expect(cleanup.orders.map((o) => [o.orderId, o.action]).sort()).toEqual([[a.id, 'REDISPATCH'], [b.id, 'REDISPATCH']].sort());

    const freshB = await app.prisma.order.findUniqueOrThrow({ where: { id: b.id } });
    expect(freshB.riderId).toBeNull();
    expect(freshB.status).toBe('ACCEPTED');
    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(r.isOnline).toBe(false);
    expect(r.isAvailable).toBe(false);
    expect(r.locationSessionId).toBeNull();
    expect(r.currentOrderId).toBeNull();
    expect(Number(r.committedFloat)).toBe(0);
  });

  it('leg A pre-pickup + leg B WITH the goods: A released, B preserved and paged, pointer re-points to B', async () => {
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const c2 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, committedFloat: 4000 });
    const c3 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const a = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 1500 });
    const b = await makeOrder(c2.userId, vendor.vendorId, 'PICKED_UP', { riderId: rider.riderId, subtotalBase: 2500 });
    // A third, pre-pickup leg accepted AFTER the in-custody one: the decision
    // must keep going past an ESCALATE, not stop at it.
    const c = await makeOrder(c3.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 0 });
    await app.prisma.order.update({ where: { id: a.id }, data: { acceptedAt: new Date(Date.now() - 3 * 60_000) } });
    await app.prisma.order.update({ where: { id: b.id }, data: { acceptedAt: new Date(Date.now() - 2 * 60_000) } });
    await app.prisma.order.update({ where: { id: c.id }, data: { acceptedAt: new Date(Date.now() - 1 * 60_000) } });
    // The PRIMARY points at the pre-pickup leg. The old decision would have
    // released A "safely" and said nothing about the goods in hand for B.
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: a.id } });

    const cleanup = await revoke(rider.userId, rider.sessionId);
    const actions = Object.fromEntries(cleanup.orders.map((o) => [o.orderId, o.action]));
    expect(actions[a.id]).toBe('REDISPATCH');
    expect(actions[b.id], 'goods in hand on a NON-primary leg must page').toBe('ESCALATE');
    expect(actions[c.id], 'a leg after the escalated one is still decided').toBe('REDISPATCH');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: c.id } })).riderId).toBeNull();

    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: a.id } })).riderId).toBeNull();
    const freshB = await app.prisma.order.findUniqueOrThrow({ where: { id: b.id } });
    expect(freshB.status).toBe('PICKED_UP');
    expect(freshB.riderId).toBe(rider.riderId);
    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(r.currentOrderId, 'the primary follows the leg still held').toBe(b.id);
    expect(r.isOnline).toBe(false);
    expect(Number(r.committedFloat), "only A's float returns; B's cash was fronted").toBe(2500);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: null, committedFloat: 0 } });
  });

  it('a revocation for a session that does not own the supply touches nothing', async () => {
    const c1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const vendor = await makeVendor();
    const rider = await makeRider({ online: true, committedFloat: 1500 });
    const a = await makeOrder(c1.userId, vendor.vendorId, 'RIDER_ASSIGNED', { riderId: rider.riderId, subtotalBase: 1500 });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: a.id } });

    const cleanup = await revoke(rider.userId, 'some-other-session');
    expect(cleanup.riderId).toBeNull();
    expect(cleanup.orders).toEqual([]);
    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(r.isOnline).toBe(true);
    expect(r.currentOrderId).toBe(a.id);
    expect(Number(r.committedFloat)).toBe(1500);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: null, committedFloat: 0, isOnline: false } });
  });
});
