import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { FareService } from '../modules/rides/fare.service';
import { DispatchService, recoverStrandedTaxiRides } from '../modules/dispatch/dispatch.service';
import { OrderService } from '../modules/order/order.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { pointInPolygon } from '../utils/geo';
import { transitionUserRoleAuthority } from '../modules/mover-authority';
import { AuthService } from '../modules/auth/auth.service';

// ---------------------------------------------------------------------------
// taxi on the same mover pool and dispatch engine. Hardest paths:
// zone-boundary addresses and fare-table gaps falling back to the formula.
// The fare is deterministic and shown BEFORE any driver sees the request.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Inside the seeded zones (georgetown-central: lat 6.78-6.83 / lng -58.18..-58.13;
// georgetown-south: lat 6.73-6.78)
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };
const NOWHERE = { lat: 6.95, lng: -58.4 }; // outside every zone

let app: FastifyInstance;
let fare: FareService;
let dispatch: DispatchService;

const createdUserIds: string[] = [];

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200122' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { driver: { userId: { in: ids } } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 20;
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200122${String(seq).padStart(2, '0')}`,
      firstName: 'Taxi',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      // Rides require L2 (master plan §5, L2-before-first-ride)
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step9', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, sessionId: session.id };
}

async function makeDriverDeviceSession(userId: string, deviceId: string) {
  const token = app.jwt.sign({ userId, role: 'DRIVER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId,
      token,
      refreshToken: nanoid(48),
      deviceId,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { token, sessionId: session.id };
}

async function makeDriver(opts: { lat?: number; lng?: number } = {}) {
  const u = await makeUserWithSession(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: `HC-${seq}`,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      documentsVerified: true,
      isOnline: true, isAvailable: true,
      currentLat: opts.lat ?? CENTRAL.lat, currentLng: opts.lng ?? CENTRAL.lng,
      lastLocationUpdate: new Date(),
      locationSessionId: u.sessionId,
    },
  });
  return { ...u, driverId: driver.id };
}

async function makeDriverEligibleForGo(driver: { userId: string; driverId: string }) {
  await app.prisma.driver.update({
    where: { id: driver.driverId },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  });
  await app.prisma.verificationDocument.create({
    data: {
      userId: driver.userId,
      role: 'MOVER',
      docType: 'vehicle_insurance',
      fileUrl: 'storage://t/ins.jpg',
      status: 'APPROVED',
      coverageClass: 'HIRE',
      hireClassConfirmed: true,
      plateCrossChecked: true,
      consentAt: new Date(),
      privacyNoticeVersion: 'v1',
    },
  });
  await app.prisma.subscription.create({
    data: {
      driverId: driver.driverId,
      type: 'TAXI_DRIVER',
      status: 'ACTIVE',
      weeklyRate: 12000,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 7 * DAY),
      nextBillingDate: new Date(Date.now() + 7 * DAY),
    },
  });
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
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  fare = new FareService(app.prisma);
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});

  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Zone resolution — boundary addresses', () => {
  const central = { type: 'Polygon', coordinates: [[[-58.18, 6.78], [-58.13, 6.78], [-58.13, 6.83], [-58.18, 6.83], [-58.18, 6.78]]] };

  it('a point just inside the boundary is in; just outside is out', () => {
    expect(pointInPolygon({ lat: 6.7801, lng: -58.155 }, central)).toBe(true);
    expect(pointInPolygon({ lat: 6.7799, lng: -58.155 }, central)).toBe(false);
    expect(pointInPolygon({ lat: 6.8299, lng: -58.1301 }, central)).toBe(true);
    expect(pointInPolygon({ lat: 6.8301, lng: -58.13 }, central)).toBe(false);
  });
});

describe('Fare engine — table first, formula fallback, deterministic', () => {
  it('uses the zone-to-zone table when both ends resolve', async () => {
    const estimate = await fare.estimate(CENTRAL, SOUTH, 'GY');
    expect(estimate.source).toBe('zone_table');
    expect(estimate.fare).toBe(2000); // seeded fixed fare
    expect(estimate.currencyCode).toBe('GYD');
  });

  it('falls back to the config formula on table gaps', async () => {
    // south -> south: both ends zoned but no row for that pair
    const estimate = await fare.estimate(SOUTH, { lat: 6.76, lng: -58.14 }, 'GY');
    expect(estimate.source).toBe('formula');
    expect(estimate.fare % 100).toBe(0); // cash-friendly rounding
    expect(estimate.fare).toBeGreaterThanOrEqual(1500); // minimum
  });

  it('falls back when an end is outside every zone, and enforces the minimum', async () => {
    const short = await fare.estimate(NOWHERE, { lat: 6.951, lng: -58.401 }, 'GY');
    expect(short.source).toBe('formula');
    expect(short.fare).toBe(1500); // tiny hop -> minimum fare

    const sameTwice = await fare.estimate(NOWHERE, { lat: 6.951, lng: -58.401 }, 'GY');
    expect(sameTwice.fare).toBe(short.fare); // deterministic
  });
});

describe('Ride request — fare shown first, dispatch shared, PIN issued', () => {
  it('the estimate equals the order total to the dollar', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();

    const est = await inject('POST', '/api/v1/rides/estimate', { pickup: CENTRAL, dropoff: SOUTH }, customer.token);
    expect(est.statusCode).toBe(200);
    // /estimate now returns tiered fares; a default request books Economy (×1.0).
    const quotedFare = est.json().data.tiers.find((t: any) => t.rideClass === 'ECONOMY').fare;

    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL,
      dropoff: SOUTH,
      pickupAddress: '12 Main Street, Georgetown',
      dropoffAddress: '4 South Road, Georgetown',
    }, customer.token);
    expect(res.statusCode).toBe(201);
    const ride = res.json().data.ride;

    expect(ride.fare).toBe(quotedFare);
    expect(ride.fareSource).toBe('zone_table');
    expect(ride.ridePin).toMatch(/^\d{6}$/);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(Number(db.totalAmount)).toBe(quotedFare);
    expect(Number(db.taxiFareTotal)).toBe(quotedFare);
    expect(db.orderType).toBe('TAXI');

    // Dispatch went to the DRIVER pool — the offer is live for our driver
    const offer = await app.redis.get(`dispatch:offer:${ride.id}`);
    expect(offer).toBe(driver.driverId);

    // Driver accepts through the shared atomic claim
    const accept = await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    expect(accept.statusCode).toBe(200);
    const assigned = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(assigned.status).toBe('DRIVER_ASSIGNED');
    expect(assigned.driverId).toBe(driver.driverId);

    // Passenger sees driver identity + vehicle + plate
    const active = await inject('GET', '/api/v1/rides/active', undefined, customer.token);
    expect(active.json().data.driver.licensePlate).toContain('HC-');
  });

  it('two drivers racing the same ride: exactly one wins (shared CAS, no fork)', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const d1 = await makeDriver();
    const d2 = await makeDriver();

    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'A street somewhere', dropoffAddress: 'B street somewhere',
    }, customer.token);
    const rideId = res.json().data.ride.id;

    const results = await Promise.allSettled([
      dispatch.claimOrder(rideId, d1.driverId, 'DRIVER'),
      dispatch.claimOrder(rideId, d2.driverId, 'DRIVER'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { driverId: true, status: true } });
    expect(db.status).toBe('DRIVER_ASSIGNED');
    expect([d1.driverId, d2.driverId]).toContain(db.driverId);
  });

  it('commits the server-clamped direct fare with assignment, or rolls both back on abort', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await app.prisma.order.create({
      data: {
        orderNumber: `TFA-${nanoid(8)}`,
        orderType: 'TAXI',
        customerId: customer.userId,
        status: 'PENDING',
        pickupAddress: 'Atomic Fare A',
        pickupLat: CENTRAL.lat,
        pickupLng: CENTRAL.lng,
        deliveryAddress: 'Atomic Fare B',
        deliveryLat: SOUTH.lat,
        deliveryLng: SOUTH.lng,
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        deliveryFee: 0,
        taxiFareTotal: 2000,
        totalAmount: 2000,
        paymentMethod: 'CASH',
      },
    });

    const originalTransaction = app.prisma.$transaction.bind(app.prisma);
    let staged: { status: string; driverId: string | null; fare: number; logs: number } | null = null;
    const transaction = vi.spyOn(app.prisma, '$transaction').mockImplementationOnce((async (
      callback: (tx: Parameters<Parameters<typeof app.prisma.$transaction>[0]>[0]) => Promise<unknown>,
      options?: Parameters<typeof app.prisma.$transaction>[1],
    ) => originalTransaction(async (tx) => {
      await callback(tx as Parameters<Parameters<typeof app.prisma.$transaction>[0]>[0]);
      const row = await tx.order.findUniqueOrThrow({ where: { id: ride.id } });
      staged = {
        status: row.status,
        driverId: row.driverId,
        fare: Number(row.taxiFareTotal),
        logs: await tx.orderStatusLog.count({ where: { orderId: ride.id, status: 'DRIVER_ASSIGNED' } }),
      };
      throw new Error('forced direct-fare transaction abort');
    }, options)) as never);
    try {
      await expect(dispatch.claimOrder(ride.id, driver.driverId, 'DRIVER', { requestedFare: 1200 }))
        .rejects.toThrow('forced direct-fare transaction abort');
    } finally {
      transaction.mockRestore();
    }

    expect(staged).toEqual({ status: 'DRIVER_ASSIGNED', driverId: driver.driverId, fare: 1200, logs: 1 });
    const [rolledBackRide, rolledBackDriver, rolledBackLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }),
      app.prisma.orderStatusLog.count({ where: { orderId: ride.id, status: 'DRIVER_ASSIGNED' } }),
    ]);
    expect({ status: rolledBackRide.status, driverId: rolledBackRide.driverId, fare: Number(rolledBackRide.taxiFareTotal) })
      .toEqual({ status: 'PENDING', driverId: null, fare: 2000 });
    expect({ available: rolledBackDriver.isAvailable, pointer: rolledBackDriver.currentRideId })
      .toEqual({ available: true, pointer: null });
    expect(rolledBackLogs).toBe(0);

    const committed = await dispatch.claimOrder(ride.id, driver.driverId, 'DRIVER', { requestedFare: 1200 });
    expect({ status: committed.status, driverId: committed.driverId, fare: Number(committed.taxiFareTotal) })
      .toEqual({ status: 'DRIVER_ASSIGNED', driverId: driver.driverId, fare: 1200 });
    const durable = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect({ fare: Number(durable.taxiFareTotal), total: Number(durable.totalAmount) })
      .toEqual({ fare: 1200, total: 1200 });
  });

  it('ratings record both ways after completion', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();

    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'Rating Street 1', dropoffAddress: 'Rating Street 2',
    }, customer.token);
    const rideId = res.json().data.ride.id;

    await dispatch.claimOrder(rideId, driver.driverId, 'DRIVER');
    // Fast-forward the ride to completion through the locked chain
    await app.prisma.order.update({ where: { id: rideId }, data: { status: 'DELIVERED', deliveredAt: new Date() } });

    const rate = await inject('POST', `/api/v1/driver/rides/${rideId}/rate-customer`, { score: 5, comment: 'Great passenger' }, driver.token);
    expect(rate.statusCode).toBe(200);

    const again = await inject('POST', `/api/v1/driver/rides/${rideId}/rate-customer`, { score: 1 }, driver.token);
    expect(again.statusCode).toBe(409);

    const stored = await app.prisma.rating.findFirst({ where: { orderId: rideId, type: 'DRIVER_TO_CUSTOMER' } });
    expect(stored?.score).toBe(5);
  });

  it('one active ride per customer', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await makeDriver();

    const first = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'Once Street 1', dropoffAddress: 'Once Street 2',
    }, customer.token);
    expect(first.statusCode).toBe(201);

    const second = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'Twice Street 1', dropoffAddress: 'Twice Street 2',
    }, customer.token);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('RIDE_IN_PROGRESS');
  });

  it('driver cancels an accepted ride: freed + un-trapped, ride re-opens to PENDING', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: '12 Main Street, Georgetown', dropoffAddress: '4 South Road, Georgetown',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    let d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.currentRideId).toBe(ride.id); // trapped

    const cancel = await inject('POST', `/api/v1/driver/rides/${ride.id}/cancel`, { reason: 'Vehicle broke down' }, driver.token);
    expect(cancel.statusCode).toBe(200);

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('PENDING'); // re-dispatchable, rider not stranded
    expect(order.driverId).toBeNull();
    d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.currentRideId).toBeNull();
    expect(d.isAvailable).toBe(true); // un-trapped
    // previously impossible — go-offline was hard-blocked while trapped
    const offline = await inject('POST', '/api/v1/driver/go-offline', {}, driver.token);
    expect(offline.statusCode).toBe(200);
  });

  it('passenger cancel after match pushes the assigned driver to stop', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: '12 Main Street, Georgetown', dropoffAddress: '4 South Road, Georgetown',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    // Advance to en route — the driver is physically heading to the pickup, app
    // likely backgrounded. The socket room only reaches a foregrounded subscriber.
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DRIVER_EN_ROUTE' } });

    const orders = new OrderService(app.prisma, app.io);
    await orders.cancelOrder(ride.id, customer.userId, 'Changed my mind');

    const d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.currentRideId).toBeNull();
    expect(d.isAvailable).toBe(true); // freed either way

    // RED before the fix: the driver was freed but got NO push, so a
    // backgrounded driver kept driving to a pickup the rider had abandoned.
    const notif = await app.prisma.notification.findFirst({
      where: { userId: driver.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif).not.toBeNull();
    expect(notif?.body.toLowerCase()).toContain('cancel');
    expect(notif?.data).toMatchObject({ orderId: ride.id });
  });

  it('driver go-offline while holding a ride offer releases it (no 20s zombie offer)', async () => {
    // Isolate the pool: earlier tests leave drivers online at CENTRAL, so park
    // them all — otherwise the offer could rank a leftover driver above ours.
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: '12 Main Street, Georgetown', dropoffAddress: '4 South Road, Georgetown',
    }, customer.token);
    const ride = res.json().data.ride;
    // Offer is live for our (sole) driver, not yet accepted.
    expect(await app.redis.get(`dispatch:offer:${ride.id}`)).toBe(driver.driverId);
    const before = (await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } })).acceptanceRate;

    const off = await inject('POST', '/api/v1/driver/go-offline', {}, driver.token);
    expect(off.statusCode).toBe(200);

    // RED before the fix: the offer clung to the offline driver until timeout.
    // Sole driver now declined -> cascade widens -> exhausts -> offer key cleared.
    expect(await app.redis.get(`dispatch:offer:${ride.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${driver.driverId}`)).toBeNull();
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(after.isOnline).toBe(false);
    expect(after.acceptanceRate).toBeLessThan(before); // the quit-mid-offer is scored
  });

  it('driver cannot cancel once the trip is in progress (passenger aboard)', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: '12 Main Street, Georgetown', dropoffAddress: '4 South Road, Georgetown',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'RIDE_IN_PROGRESS' } });
    const cancel = await inject('POST', `/api/v1/driver/rides/${ride.id}/cancel`, { reason: 'changed mind' }, driver.token);
    expect(cancel.statusCode).toBe(400);
  });

  it('driver cannot cancel in the verified-PIN window before start is tapped', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'Verified pickup', dropoffAddress: 'Verified dropoff',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    const verifiedAt = new Date();
    await app.prisma.order.update({
      where: { id: ride.id },
      data: { status: 'DRIVER_ARRIVED', ridePinVerified: true, ridePinVerifiedAt: verifiedAt },
    });

    const cancel = await inject('POST', `/api/v1/driver/rides/${ride.id}/cancel`, { reason: 'changed mind' }, driver.token);
    expect(cancel.statusCode).toBe(400);
    expect(cancel.json().error.code).toBe('INVALID_STATUS');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect({ status: after.status, driverId: after.driverId, verified: after.ridePinVerified })
      .toEqual({ status: 'DRIVER_ARRIVED', driverId: driver.driverId, verified: true });
  });
});

describe('Stranded-taxi watchdog — driver goes GPS-dark after accepting', () => {
  const STALE = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago — past the 15-min window

  it('recovers a PRE-PICKUP ride: re-opens to PENDING, frees the driver, re-dispatches, tells the rider', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Watchdog A', dropoffAddress: 'Watchdog B',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    // Driver is en route, then the phone goes dark: currentRideId still set, GPS silent.
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DRIVER_EN_ROUTE' } });
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: STALE } });

    const enqueued: string[] = [];
    const out = await recoverStrandedTaxiRides(app.prisma, app.redis, app.io, async (id) => { enqueued.push(id); });

    // RED before this fix: no sweep touched this ride — it hung in DRIVER_EN_ROUTE
    // forever with a frozen map and the rider unable to re-book.
    expect(out.recovered).toContain(ride.id);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('PENDING');
    expect(order.driverId).toBeNull();
    const d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.currentRideId).toBeNull(); // un-trapped
    expect(enqueued).toContain(ride.id); // re-dispatch enqueued
    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, data: { path: ['orderId'], equals: ride.id } },
      orderBy: { createdAt: 'desc' },
    });
    expect(note?.title).toContain('another driver');

    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: null } });
  });

  it('a pre-custody release rotates the PIN and zeroes the attempt budget — a burned budget never traps the next driver [REPORT-014 F-014-12]', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const first = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Pin A', dropoffAddress: 'Pin B',
    }, customer.token);
    const ride = res.json().data.ride;
    const originalPin = (await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id }, select: { ridePin: true } })).ridePin;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, first.token);
    // The first driver burns the entire PIN budget at ARRIVED, then cancels
    // (still pre-custody — no passenger aboard).
    await inject('PUT', `/api/v1/driver/rides/${ride.id}/en-route`, {}, first.token).catch(() => {});
    await inject('PUT', `/api/v1/driver/rides/${ride.id}/arrived`, {}, first.token).catch(() => {});
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DRIVER_ARRIVED', ridePinAttempts: 5 } });
    const cancel = await inject('POST', `/api/v1/driver/rides/${ride.id}/cancel`, { reason: 'malicious budget burn' }, first.token);
    expect(cancel.statusCode).toBe(200);

    const afterRelease = await app.prisma.order.findUniqueOrThrow({
      where: { id: ride.id },
      select: { status: true, ridePin: true, ridePinAttempts: true, ridePinVerified: true },
    });
    expect(afterRelease.status).toBe('PENDING');
    expect(afterRelease.ridePinAttempts).toBe(0); // fresh budget for the next driver
    expect(afterRelease.ridePin).not.toBe(originalPin); // rotated — the burned PIN is dead
    expect(afterRelease.ridePinVerified).toBe(false);

    // The next driver has a real, usable window: the rotated PIN verifies.
    const second = await makeDriver();
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, second.token);
    await inject('PUT', `/api/v1/driver/rides/${ride.id}/en-route`, {}, second.token).catch(() => {});
    await inject('PUT', `/api/v1/driver/rides/${ride.id}/arrived`, {}, second.token).catch(() => {});
    const verify = await inject('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: afterRelease.ridePin }, second.token);
    expect(verify.statusCode).toBe(200); // NOT locked out by the first driver's burn
    await app.prisma.driver.update({ where: { id: second.driverId }, data: { lastLocationUpdate: null, currentRideId: null } });
  });

  it('recovers a ride whose driver has a NULL location timestamp, not just a stale one [REPORT-014 F-014-11]', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Null-TS A', dropoffAddress: 'Null-TS B',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DRIVER_ASSIGNED' } });
    // The driver NEVER sent a fix (or the sweep cleared it): lastLocationUpdate
    // is NULL, currentRideId is set. The old watchdog query (`lt cutoff` only)
    // skipped this shape, so the ride hung forever.
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: null, currentRideId: ride.id } });

    const enqueued: string[] = [];
    const out = await recoverStrandedTaxiRides(app.prisma, app.redis, app.io, async (id) => { enqueued.push(id); });

    expect(out.recovered).toContain(ride.id);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('PENDING');
    expect(order.driverId).toBeNull();
    const d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.currentRideId).toBeNull();
    expect(enqueued).toContain(ride.id);
  });

  it('NEVER auto-cancels an IN-PROGRESS ride: passenger aboard → ride kept, ops paged, rider warned', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Aboard A', dropoffAddress: 'Aboard B',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    // Passenger is physically in the car when the driver's signal drops.
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'RIDE_IN_PROGRESS' } });
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: STALE } });
    await app.redis.del(`ops_page:taxi_driver_dropped:${ride.id}`);

    const enqueued: string[] = [];
    const out = await recoverStrandedTaxiRides(app.prisma, app.redis, app.io, async (id) => { enqueued.push(id); });

    expect(out.flagged).toContain(ride.id);
    expect(out.recovered).not.toContain(ride.id);
    // The ride is UNTOUCHED — you never strand a passenger by auto-cancelling.
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('RIDE_IN_PROGRESS');
    const d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(d.currentRideId).toBe(ride.id); // never silently cleared
    expect(enqueued).not.toContain(ride.id); // no re-dispatch
    // Ops paged (dedup key claimed) + customer warned honestly.
    expect(await app.redis.get(`ops_page:taxi_driver_dropped:${ride.id}`)).toBe('1');
    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: 'Your driver lost signal' },
    });
    expect(note).not.toBeNull();

    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: null, currentRideId: null } });
  });

  it('treats a verified PIN at DRIVER_ARRIVED as custody and never recycles the ride', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Verified A', dropoffAddress: 'Verified B',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    await app.prisma.order.update({
      where: { id: ride.id },
      data: { status: 'DRIVER_ARRIVED', ridePinVerified: true, ridePinVerifiedAt: new Date() },
    });
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: STALE } });
    await app.redis.del(`ops_page:taxi_driver_dropped:${ride.id}`);

    const enqueued: string[] = [];
    const out = await recoverStrandedTaxiRides(app.prisma, app.redis, app.io, async (id) => { enqueued.push(id); });

    expect(out.flagged).toContain(ride.id);
    expect(out.recovered).not.toContain(ride.id);
    const [order, profile] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }),
    ]);
    expect({ status: order.status, driverId: order.driverId, verified: order.ridePinVerified })
      .toEqual({ status: 'DRIVER_ARRIVED', driverId: driver.driverId, verified: true });
    expect(profile.currentRideId).toBe(ride.id);
    expect(enqueued).not.toContain(ride.id);

    await app.redis.del(`ops_page:taxi_driver_dropped:${ride.id}`);
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: null, currentRideId: null } });
  });

  it('leaves a driver with a FRESH fix alone (only GPS-dark rides are swept)', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Fresh A', dropoffAddress: 'Fresh B',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DRIVER_EN_ROUTE' } });
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: new Date() } }); // fresh

    const out = await recoverStrandedTaxiRides(app.prisma, app.redis, app.io, async () => {});
    expect(out.recovered).not.toContain(ride.id);
    expect(out.flagged).not.toContain(ride.id);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(order.status).toBe('DRIVER_EN_ROUTE'); // untouched

    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { lastLocationUpdate: null, currentRideId: null } });
  });
});

describe('Taxi dispatch S3 — self-exclusion + supply-watch hygiene', () => {
  it('excludes an online driver whose location authority has no owning session', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const driver = await makeDriver({ lat: CENTRAL.lat, lng: CENTRAL.lng });
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { locationSessionId: null } });

    const candidates = await dispatch.findCandidates(`ownerless-driver-${nanoid(6)}`, CENTRAL, 5, 'DRIVER');
    expect(candidates.map((candidate) => candidate.riderId)).not.toContain(driver.driverId);
    await expect((dispatch as unknown as {
      canReceiveOffer(pool: 'DRIVER', moverId: string): Promise<boolean>;
    }).canReceiveOffer('DRIVER', driver.driverId)).resolves.toBe(false);

    const board = await inject('GET', '/api/v1/driver/rides/available', undefined, driver.token);
    expect(board.statusCode).toBe(200);
    expect(board.json().data).toEqual([]);
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { isOnline: false, isAvailable: false } });
  });

  it('atomically removes an owning driver session from taxi supply on logout', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const driver = await makeDriver({ lat: CENTRAL.lat, lng: CENTRAL.lng });
    await app.prisma.driver.update({
      where: { id: driver.driverId },
      data: { locationSessionId: driver.sessionId },
    });

    const before = await dispatch.findCandidates(
      `logout-before-${nanoid(6)}`,
      CENTRAL,
      5,
      'DRIVER',
    );
    expect(before.map((candidate) => candidate.riderId)).toContain(driver.driverId);

    await new AuthService(app).logout(driver.sessionId, driver.userId);

    const [profile, revokedSession, after] = await Promise.all([
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }),
      app.prisma.session.findUnique({ where: { id: driver.sessionId } }),
      dispatch.findCandidates(`logout-after-${nanoid(6)}`, CENTRAL, 5, 'DRIVER'),
    ]);
    expect({
      locationSessionId: profile.locationSessionId,
      isOnline: profile.isOnline,
      isAvailable: profile.isAvailable,
    }).toEqual({ locationSessionId: null, isOnline: false, isAvailable: false });
    expect(revokedSession).toBeNull();
    expect(after.map((candidate) => candidate.riderId)).not.toContain(driver.driverId);
  });

  it('excludes a suspended Driver and rejects an already-issued taxi claim', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver({ lat: CENTRAL.lat, lng: CENTRAL.lng });
    const requested = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL,
      dropoff: SOUTH,
      pickupAddress: 'Status A',
      dropoffAddress: 'Status B',
    }, customer.token);
    expect(requested.statusCode).toBe(201);
    const rideId = requested.json().data.ride.id as string;

    await app.prisma.user.update({ where: { id: driver.userId }, data: { status: 'SUSPENDED' } });
    const candidates = await dispatch.findCandidates(
      `suspended-${nanoid(6)}`,
      CENTRAL,
      5,
      'DRIVER',
    );
    expect(candidates.map((candidate) => candidate.riderId)).not.toContain(driver.driverId);
    await expect(dispatch.claimOrder(rideId, driver.driverId, 'DRIVER'))
      .rejects.toMatchObject({ code: 'MOVER_INACTIVE' });
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: rideId } });
    expect({ driverId: after.driverId, status: after.status }).toEqual({
      driverId: null,
      status: 'PENDING',
    });
  });

  it('never offers a booking user their OWN ride: findCandidates excludes excludeUserId', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } }); // isolate
    const me = await makeDriver({ lat: CENTRAL.lat, lng: CENTRAL.lng });               // online driver AND a customer
    const other = await makeDriver({ lat: CENTRAL.lat + 0.001, lng: CENTRAL.lng });     // a different online driver

    const cands = await dispatch.findCandidates(`self-${nanoid(6)}`, CENTRAL, 5, 'DRIVER', 0, null, null, null, me.userId);
    const ids = cands.map((c) => (c as { riderId: string }).riderId);
    // RED before self-exclusion: my own driver row was a candidate for my own ride.
    expect(ids).not.toContain(me.driverId);
    expect(ids).toContain(other.driverId); // a different driver is still eligible
  });

  it('hides and rejects a dual-role driver account claiming its own taxi request at HTTP and DB barriers', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const me = await makeDriver({ lat: CENTRAL.lat, lng: CENTRAL.lng });
    const ride = await app.prisma.order.create({
      data: {
        orderNumber: `SELF-${nanoid(8)}`,
        orderType: 'TAXI',
        customerId: me.userId,
        status: 'PENDING',
        pickupAddress: 'Self Taxi A',
        pickupLat: CENTRAL.lat,
        pickupLng: CENTRAL.lng,
        deliveryAddress: 'Self Taxi B',
        deliveryLat: SOUTH.lat,
        deliveryLng: SOUTH.lng,
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        deliveryFee: 0,
        taxiFareTotal: 2000,
        totalAmount: 2000,
        paymentMethod: 'CASH',
      },
    });

    const board = await inject('GET', '/api/v1/driver/rides/available', undefined, me.token);
    expect(board.statusCode).toBe(200);
    expect((board.json().data as Array<{ id: string }>).map((row) => row.id)).not.toContain(ride.id);

    const direct = await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, me.token);
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.code).toBe('SELF_OWN_ORDER');
    await expect(dispatch.claimOrder(ride.id, me.driverId, 'DRIVER')).rejects.toMatchObject({ code: 'SELF_OWN_ORDER' });
    const durable = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect({ status: durable.status, driverId: durable.driverId }).toEqual({ status: 'PENDING', driverId: null });
    await app.prisma.driver.update({ where: { id: me.driverId }, data: { isOnline: false, isAvailable: false } });
  });

  it('requesting a ride clears the customer’s pending supply watch (no stale "drivers are back")', async () => {
    await app.prisma.driver.updateMany({ data: { isOnline: false, isAvailable: false } });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await makeDriver({ lat: CENTRAL.lat, lng: CENTRAL.lng }); // a driver online so the request is accepted
    // The customer had set a watch earlier, when drivers were absent.
    await app.prisma.supplyWatch.create({
      data: { customerId: customer.userId, pool: 'DRIVER', lat: CENTRAL.lat, lng: CENTRAL.lng, expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Watch A', dropoffAddress: 'Watch B',
    }, customer.token);
    expect(res.statusCode).toBe(201);

    // RED before the fix: the watch survived, so the 2-min supply scan would push
    // "Drivers are back!" while the customer is already in a ride.
    const watch = await app.prisma.supplyWatch.findFirst({ where: { customerId: customer.userId, notifiedAt: null } });
    expect(watch).toBeNull();

    await app.prisma.supplyWatch.deleteMany({ where: { customerId: customer.userId } });
  });
});

describe('Taxi live-operation gate (hire-class insurance)', () => {
  async function setInsurance(userId: string, coverageClass: 'HIRE' | 'PRIVATE', hireClassConfirmed: boolean) {
    await app.prisma.verificationDocument.create({
      data: {
        userId,
        role: 'MOVER',
        docType: 'vehicle_insurance',
        fileUrl: 'storage://t/ins.jpg',
        status: 'APPROVED',
        coverageClass,
        hireClassConfirmed,
        // A complete admin 5-point review confirms the plate too; the
        // cross-check's own enforcement is covered in verification.test.ts.
        plateCrossChecked: hireClassConfirmed,
        consentAt: new Date(),
        privacyNoticeVersion: 'v1',
      },
    });
  }

  async function offlineDriver() {
    const d = await makeDriver();
    await app.prisma.driver.update({ where: { id: d.driverId }, data: { isOnline: false } });
    return d;
  }

  it('blocks go-online with no hire-class insurance on file', async () => {
    const d = await offlineDriver();
    const res = await inject('POST', '/api/v1/driver/go-online', {}, d.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INSURANCE_HIRE_CLASS_REQUIRED');
  });

  it('blocks go-online when the policy is PRIVATE class', async () => {
    const d = await offlineDriver();
    await setInsurance(d.userId, 'PRIVATE', false);
    const res = await inject('POST', '/api/v1/driver/go-online', {}, d.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INSURANCE_HIRE_CLASS_REQUIRED');
  });

  it('allows go-online with a confirmed HIRE-class policy + active subscription', async () => {
    const d = await offlineDriver();
    await setInsurance(d.userId, 'HIRE', true);
    await app.prisma.subscription.create({
      data: {
        driverId: d.driverId,
        type: 'TAXI_DRIVER',
        status: 'ACTIVE',
        weeklyRate: 12000,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 7 * DAY),
        nextBillingDate: new Date(Date.now() + 7 * DAY),
      },
    });
    const siblingRider = await app.prisma.rider.create({
      data: {
        userId: d.userId,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        documentsVerified: true,
        isOnline: true,
        isAvailable: true,
        currentLat: CENTRAL.lat,
        currentLng: CENTRAL.lng,
        lastLocationUpdate: new Date(),
      },
    });
    const res = await inject('POST', '/api/v1/driver/go-online', {
      latitude: 6.8234,
      longitude: -58.1678,
    }, d.token);
    expect(res.statusCode).toBe(200);
    const located = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(located.currentLat).toBe(6.8234);
    expect(located.currentLng).toBe(-58.1678);
    expect(located.lastLocationUpdate).not.toBeNull();
    const retiredSibling = await app.prisma.rider.findUniqueOrThrow({ where: { id: siblingRider.id } });
    expect({ online: retiredSibling.isOnline, available: retiredSibling.isAvailable }).toEqual({
      online: false,
      available: false,
    });
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('blocks go-online when PAST_DUE and the grace window has ended', async () => {
    const d = await offlineDriver();
    await setInsurance(d.userId, 'HIRE', true);
    await app.prisma.subscription.create({
      data: {
        driverId: d.driverId, type: 'TAXI_DRIVER', status: 'PAST_DUE', weeklyRate: 12000,
        currentPeriodStart: new Date(Date.now() - 8 * DAY), currentPeriodEnd: new Date(Date.now() - DAY),
        nextBillingDate: new Date(Date.now() - DAY),
        gracePeriodEnd: new Date(Date.now() - 60_000), // grace ended a minute ago
      },
    });
    const res = await inject('POST', '/api/v1/driver/go-online', {
      latitude: CENTRAL.lat,
      longitude: CENTRAL.lng,
    }, d.token);
    // RED before the fix: PAST_DUE was allowed regardless of grace, so a lapsed
    // mover kept earning unpaid until the billing sweep flipped SUSPENDED.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIPTION_PAST_DUE');
  });

  it('allows go-online while PAST_DUE but still within the grace window', async () => {
    const d = await offlineDriver();
    await setInsurance(d.userId, 'HIRE', true);
    await app.prisma.subscription.create({
      data: {
        driverId: d.driverId, type: 'TAXI_DRIVER', status: 'PAST_DUE', weeklyRate: 12000,
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(),
        nextBillingDate: new Date(),
        gracePeriodEnd: new Date(Date.now() + 2 * 3600 * 1000), // 2h of grace left
      },
    });
    const res = await inject('POST', '/api/v1/driver/go-online', {
      latitude: CENTRAL.lat,
      longitude: CENTRAL.lng,
    }, d.token);
    expect(res.statusCode).toBe(200);
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('SWIFT-066: a driver mid-ride who re-opens and taps GO is online but NOT available', async () => {
    const d = await offlineDriver();
    await setInsurance(d.userId, 'HIRE', true);
    await app.prisma.subscription.create({
      data: {
        driverId: d.driverId, type: 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 12000,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY),
        nextBillingDate: new Date(Date.now() + 7 * DAY),
      },
    });
    // The driver is mid-ride: currentRideId is set. Re-opening the app and
    // tapping GO must not re-advertise them as free supply.
    await app.prisma.driver.update({ where: { id: d.driverId }, data: { currentRideId: 'ride-in-progress' } });

    const res = await inject('POST', '/api/v1/driver/go-online', {
      latitude: CENTRAL.lat,
      longitude: CENTRAL.lng,
    }, d.token);
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(after.isOnline).toBe(true);
    // RED before SWIFT-066: this was true → dispatch would offer a second ride mid-trip.
    expect(after.isAvailable).toBe(false);
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { isOnline: false, isAvailable: false, currentRideId: null },
    });
  });
});

describe('Driver location authority', () => {
  it('cannot reclaim a legacy null owner after its in-flight session is revoked', async () => {
    const d = await makeDriver({ lat: 6.831, lng: -58.171 });
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { locationSessionId: null },
    });
    await app.redis.del(`driver:location_db_ts:${d.driverId}`);

    let reachedProfileRead!: () => void;
    let resumeProfileRead!: () => void;
    const atProfileRead = new Promise<void>((resolve) => { reachedProfileRead = resolve; });
    const resume = new Promise<void>((resolve) => { resumeProfileRead = resolve; });
    const originalFindUnique = app.prisma.driver.findUnique.bind(app.prisma.driver);
    const profileRead = vi.spyOn(app.prisma.driver, 'findUnique').mockImplementationOnce((async (...args: unknown[]) => {
      const profile = await originalFindUnique(...(args as [Parameters<typeof originalFindUnique>[0]]));
      reachedProfileRead();
      await resume;
      return profile;
    }) as never);

    let staleSample!: Awaited<ReturnType<typeof app.inject>>;
    try {
      const staleSamplePromise = inject('PUT', '/api/v1/driver/location', {
        latitude: 6.99,
        longitude: -58.29,
      }, d.token);
      await atProfileRead;
      await new AuthService(app).logout(d.sessionId, d.userId);
      resumeProfileRead();
      staleSample = await staleSamplePromise;
    } finally {
      resumeProfileRead();
      profileRead.mockRestore();
    }

    expect(staleSample.statusCode).toBe(200);
    expect(staleSample.json().data).toEqual({ accepted: false, reason: 'SESSION_REPLACED' });
    const [after, revoked] = await Promise.all([
      app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } }),
      app.prisma.session.findUnique({ where: { id: d.sessionId } }),
    ]);
    expect(revoked).toBeNull();
    expect(after.locationSessionId).toBeNull();
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.831, lng: -58.171 });
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('rotates GO ownership to the latest device and rejects the replaced session', async () => {
    const d = await makeDriver();
    await makeDriverEligibleForGo(d);
    const secondDevice = await makeDriverDeviceSession(d.userId, 'step9-second-device');

    const firstGo = await inject('POST', '/api/v1/driver/go-online', {
      latitude: 6.801,
      longitude: -58.151,
    }, d.token);
    expect(firstGo.statusCode).toBe(200);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } })).locationSessionId)
      .toBe(d.sessionId);

    const secondGo = await inject('POST', '/api/v1/driver/go-online', {
      latitude: 6.802,
      longitude: -58.152,
    }, secondDevice.token);
    expect(secondGo.statusCode).toBe(200);
    const afterReplacement = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(afterReplacement.locationSessionId).toBe(secondDevice.sessionId);
    expect({ lat: afterReplacement.currentLat, lng: afterReplacement.currentLng })
      .toEqual({ lat: 6.802, lng: -58.152 });

    await app.redis.del(`driver:location_db_ts:${d.driverId}`);
    const replacedSample = await inject('PUT', '/api/v1/driver/location', {
      latitude: 6.91,
      longitude: -58.21,
    }, d.token);
    expect(replacedSample.statusCode).toBe(200);
    expect(replacedSample.json().data).toEqual({ accepted: false, reason: 'SESSION_REPLACED' });
    const afterRejectedSample = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect({ lat: afterRejectedSample.currentLat, lng: afterRejectedSample.currentLng })
      .toEqual({ lat: 6.802, lng: -58.152 });

    const ownerSample = await inject('PUT', '/api/v1/driver/location', {
      latitude: 6.803,
      longitude: -58.153,
    }, secondDevice.token);
    expect(ownerSample.statusCode).toBe(200);
    expect(ownerSample.json()).toEqual({ success: true });
    const afterOwnerSample = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect({ lat: afterOwnerSample.currentLat, lng: afterOwnerSample.currentLng })
      .toEqual({ lat: 6.803, lng: -58.153 });

    const offline = await inject('POST', '/api/v1/driver/go-offline', undefined, secondDevice.token);
    expect(offline.statusCode).toBe(200);
    const afterOffline = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(afterOffline.locationSessionId).toBeNull();
    expect(afterOffline.isOnline).toBe(false);
  });

  it('does not emit an old-device sample when GO rotates during a debounced update', async () => {
    const d = await makeDriver();
    await makeDriverEligibleForGo(d);
    const secondDevice = await makeDriverDeviceSession(d.userId, 'step9-race-winner');
    const firstGo = await inject('POST', '/api/v1/driver/go-online', {
      latitude: 6.841,
      longitude: -58.181,
    }, d.token);
    expect(firstGo.statusCode).toBe(200);

    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const ride = await app.prisma.order.create({
      data: {
        orderNumber: `LOC-RACE-${nanoid(8)}`,
        orderType: 'TAXI',
        customerId: customer.userId,
        driverId: d.driverId,
        status: 'DRIVER_ASSIGNED',
        pickupLat: CENTRAL.lat,
        pickupLng: CENTRAL.lng,
        pickupAddress: 'Race pickup',
        deliveryLat: SOUTH.lat,
        deliveryLng: SOUTH.lng,
        deliveryAddress: 'Race dropoff',
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        deliveryFee: 0,
        totalAmount: 1500,
        paymentMethod: 'CASH',
      },
    });
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { currentRideId: ride.id, isAvailable: false },
    });

    let reachedDebounce!: () => void;
    let resumeDebounce!: () => void;
    const atDebounce = new Promise<void>((resolve) => { reachedDebounce = resolve; });
    const resume = new Promise<void>((resolve) => { resumeDebounce = resolve; });
    const originalRedisGet = app.redis.get.bind(app.redis);
    const redisGet = vi.spyOn(app.redis, 'get').mockImplementationOnce((async (...args: unknown[]) => {
      reachedDebounce();
      await resume;
      return originalRedisGet(...(args as [string]));
    }) as never);
    const emits: Array<{ room: string; event: string }> = [];
    const ioTo = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (event: string) => { emits.push({ room, event }); return true; },
    })) as never);

    let replacement!: Awaited<ReturnType<typeof app.inject>>;
    let oldSample!: Awaited<ReturnType<typeof app.inject>>;
    try {
      const oldSamplePromise = inject('PUT', '/api/v1/driver/location', {
        latitude: 6.99,
        longitude: -58.29,
      }, d.token);
      await atDebounce;

      replacement = await inject('POST', '/api/v1/driver/go-online', {
        latitude: 6.842,
        longitude: -58.182,
      }, secondDevice.token);
      resumeDebounce();
      oldSample = await oldSamplePromise;
    } finally {
      resumeDebounce();
      redisGet.mockRestore();
      ioTo.mockRestore();
    }

    expect(replacement.statusCode).toBe(200);
    expect(oldSample.statusCode).toBe(200);
    expect(oldSample.json().data).toEqual({ accepted: false, reason: 'SESSION_REPLACED' });
    expect(emits).not.toContainEqual({ room: `order:${ride.id}`, event: 'driver:location' });
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(after.locationSessionId).toBe(secondDevice.sessionId);
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.842, lng: -58.182 });
  });

  it('atomically gives a legacy null owner to one device and clears it on role retirement', async () => {
    const d = await makeDriver();
    const secondDevice = await makeDriverDeviceSession(d.userId, 'step9-legacy-contender');
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { locationSessionId: null },
    });
    await app.redis.del(`driver:location_db_ts:${d.driverId}`);

    const samples = [
      { latitude: 6.811, longitude: -58.161 },
      { latitude: 6.812, longitude: -58.162 },
    ];
    const responses = await Promise.all([
      inject('PUT', '/api/v1/driver/location', samples[0], d.token),
      inject('PUT', '/api/v1/driver/location', samples[1], secondDevice.token),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const bodies = responses.map((response) => response.json());
    expect(bodies.filter((body) => body.data?.reason === 'SESSION_REPLACED')).toHaveLength(1);
    expect(bodies.filter((body) => body.data === undefined)).toHaveLength(1);

    const winningIndex = bodies.findIndex((body) => body.data === undefined);
    const expectedSessionIds = [d.sessionId, secondDevice.sessionId];
    const claimed = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(claimed.locationSessionId).toBe(expectedSessionIds[winningIndex]);
    expect({ lat: claimed.currentLat, lng: claimed.currentLng }).toEqual({
      lat: samples[winningIndex]!.latitude,
      lng: samples[winningIndex]!.longitude,
    });

    await transitionUserRoleAuthority(app, d.userId, 'CUSTOMER');
    const retired = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(retired.locationSessionId).toBeNull();
    expect({ online: retired.isOnline, available: retired.isAvailable }).toEqual({
      online: false,
      available: false,
    });
  });

  it('treats a queued offline sample as a no-op', async () => {
    const d = await makeDriver({ lat: 6.8, lng: -58.15 });
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { isOnline: false, isAvailable: false, currentRideId: null },
    });
    await app.redis.del(`driver:location_db_ts:${d.driverId}`);

    const res = await inject('PUT', '/api/v1/driver/location', {
      latitude: 6.91,
      longitude: -58.21,
    }, d.token);

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ accepted: false, reason: 'OFFLINE' });
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.8, lng: -58.15 });
    expect(await app.redis.get(`driver:location_db_ts:${d.driverId}`)).toBeNull();
  });

  it('persists an online sample and preserves tracking for a force-offlined active ride', async () => {
    const online = await makeDriver();
    await app.redis.del(`driver:location_db_ts:${online.driverId}`);
    const onlineRes = await inject('PUT', '/api/v1/driver/location', {
      latitude: 6.82,
      longitude: -58.16,
    }, online.token);
    expect(onlineRes.statusCode).toBe(200);
    await app.prisma.driver.update({
      where: { id: online.driverId },
      data: { isOnline: false, isAvailable: false },
    });

    const active = await makeDriver();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const ride = await app.prisma.order.create({
      data: {
        orderNumber: `LOC-${nanoid(8)}`,
        orderType: 'TAXI',
        customerId: customer.userId,
        driverId: active.driverId,
        status: 'DRIVER_ASSIGNED',
        pickupLat: CENTRAL.lat,
        pickupLng: CENTRAL.lng,
        pickupAddress: 'Location pickup',
        deliveryLat: SOUTH.lat,
        deliveryLng: SOUTH.lng,
        deliveryAddress: 'Location dropoff',
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        deliveryFee: 0,
        totalAmount: 1500,
        paymentMethod: 'CASH',
      },
    });
    await app.prisma.driver.update({
      where: { id: active.driverId },
      data: { isOnline: false, isAvailable: false, currentRideId: ride.id },
    });
    await app.redis.del(`driver:location_db_ts:${active.driverId}`);
    const activeRes = await inject('PUT', '/api/v1/driver/location', {
      latitude: 6.83,
      longitude: -58.17,
    }, active.token);
    expect(activeRes.statusCode).toBe(200);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: active.driverId } });
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.83, lng: -58.17 });
  });
});

describe('Available-rides board — freshness window [SWIFT-064]', () => {
  function taxiRequest(customerId: string, minutesAgo: number) {
    return app.prisma.order.create({
      data: {
        orderNumber: `BRD-${nanoid(8)}`,
        orderType: 'TAXI' as never,
        customerId,
        status: 'PENDING' as never,
        pickupLat: CENTRAL.lat, pickupLng: CENTRAL.lng,
        pickupAddress: 'x', deliveryAddress: 'y',
        deliveryLat: CENTRAL.lat + 0.03, deliveryLng: CENTRAL.lng,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0,
        deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH' as never,
        placedAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
  }

  it('shows a fresh request but hides a stale one (past the demand window)', async () => {
    const cust = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver(); // online + available, in CENTRAL
    const fresh = await taxiRequest(cust.userId, 1);   // 1 min ago — live
    const stale = await taxiRequest(cust.userId, 60);  // 60 min ago — abandoned

    const res = await inject('GET', '/api/v1/driver/rides/available', undefined, driver.token);
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(fresh.id);
    // RED before SWIFT-064: the board returned the oldest-first, so the stale
    // request showed (and could crowd out fresh ones at 20+ backlog).
    expect(ids).not.toContain(stale.id);
  });
});

describe('Driver cancellationRate accountability (was a dead 0.0 field)', () => {
  it('a driver cancel-after-accept raises cancellationRate off zero (EMA toward 100)', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'CR Accept', dropoffAddress: 'CR Drop',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);

    const before = (await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } })).cancellationRate;
    expect(before).toBe(0); // starts at the schema default

    const cancel = await inject('POST', `/api/v1/driver/rides/${ride.id}/cancel`, { reason: 'vehicle broke down' }, driver.token);
    expect(cancel.statusCode).toBe(200);

    const after = (await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } })).cancellationRate;
    // RED before the writer: it stayed a permanent 0.0. Now: 0*0.8 + 20 = 20.
    expect(after).toBeCloseTo(20, 1);
  });

  it('a completed ride decays cancellationRate (EMA toward 0, multiply 0.8)', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    // Seed a prior cancel history so the decay is observable.
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { cancellationRate: 50 } });

    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'CR Done A', dropoffAddress: 'CR Done B',
    }, customer.token);
    const ride = res.json().data.ride;
    await inject('POST', `/api/v1/driver/rides/${ride.id}/accept`, {}, driver.token);
    // Fast-forward to a passenger aboard, then complete through the real route.
    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'RIDE_IN_PROGRESS', pickedUpAt: new Date() } });
    const done = await inject('PUT', `/api/v1/driver/rides/${ride.id}/complete`, {}, driver.token);
    expect(done.statusCode).toBe(200);

    const after = (await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } })).cancellationRate;
    expect(after).toBeCloseTo(40, 1); // 50 * 0.8 — a completer recovers
  });

  it('completion rolls back ride facts, driver release/count/rate, earnings, and log on fault, then retries once', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { cancellationRate: 50 } });
    const requested = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL,
      dropoff: SOUTH,
      pickupAddress: 'Atomic Complete A',
      dropoffAddress: 'Atomic Complete B',
    }, customer.token);
    const rideId = requested.json().data.ride.id as string;
    expect((await inject('POST', `/api/v1/driver/rides/${rideId}/accept`, {}, driver.token)).statusCode).toBe(200);
    await app.prisma.order.update({
      where: { id: rideId },
      data: { status: 'RIDE_IN_PROGRESS', pickedUpAt: new Date(Date.now() - 5 * 60_000) },
    });
    const before = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });

    const originalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        await originalStage.call(this, tx, input);
        throw new Error('forced taxi-complete pre-commit abort');
      });
    try {
      const failed = await inject('PUT', `/api/v1/driver/rides/${rideId}/complete`, {}, driver.token);
      expect(failed.statusCode).toBe(500);
    } finally {
      stageSpy.mockRestore();
    }

    const [failedOrder, failedDriver, failedEarnings, failedLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: rideId } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }),
      app.prisma.earning.count({ where: { orderId: rideId } }),
      app.prisma.orderStatusLog.count({ where: { orderId: rideId, status: 'DELIVERED' } }),
    ]);
    expect({ status: failedOrder.status, deliveredAt: failedOrder.deliveredAt, duration: failedOrder.actualDeliveryTime })
      .toEqual({ status: 'RIDE_IN_PROGRESS', deliveredAt: null, duration: null });
    expect({ available: failedDriver.isAvailable, pointer: failedDriver.currentRideId, rides: failedDriver.totalRides, rate: failedDriver.cancellationRate })
      .toEqual({ available: false, pointer: rideId, rides: before.totalRides, rate: before.cancellationRate });
    expect(failedEarnings).toBe(0);
    expect(failedLogs).toBe(0);

    const retry = await inject('PUT', `/api/v1/driver/rides/${rideId}/complete`, {}, driver.token);
    expect(retry.statusCode).toBe(200);
    const duplicate = await inject('PUT', `/api/v1/driver/rides/${rideId}/complete`, {}, driver.token);
    expect(duplicate.statusCode).toBe(400);
    const [completedOrder, completedDriver, earnings, logs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: rideId } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }),
      app.prisma.earning.count({ where: { orderId: rideId, type: 'TAXI_FARE' } }),
      app.prisma.orderStatusLog.count({ where: { orderId: rideId, status: 'DELIVERED' } }),
    ]);
    expect(completedOrder.status).toBe('DELIVERED');
    expect(completedOrder.actualDeliveryTime).toBeGreaterThanOrEqual(5);
    expect({ available: completedDriver.isAvailable, pointer: completedDriver.currentRideId, rides: completedDriver.totalRides })
      .toEqual({ available: true, pointer: null, rides: before.totalRides + 1 });
    expect(completedDriver.cancellationRate).toBeCloseTo(40, 1);
    expect(earnings).toBe(1);
    expect(logs).toBe(1);
  });
});
