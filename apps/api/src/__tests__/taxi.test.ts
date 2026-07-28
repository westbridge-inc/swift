import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step9', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
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
    },
  });
  return { ...u, driverId: driver.id };
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
    const res = await inject('POST', '/api/v1/driver/go-online', {}, d.token);
    expect(res.statusCode).toBe(200);
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

    const res = await inject('POST', '/api/v1/driver/go-online', {}, d.token);
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(after.isOnline).toBe(true);
    // RED before SWIFT-066: this was true → dispatch would offer a second ride mid-trip.
    expect(after.isAvailable).toBe(false);
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
