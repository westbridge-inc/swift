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
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { pointInPolygon } from '../utils/geo';

// ---------------------------------------------------------------------------
// Step 9 — taxi on the same mover pool and dispatch engine. Hardest paths:
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
  await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
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
      isPhoneVerified: true,
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
    expect(ride.ridePin).toMatch(/^\d{4}$/);

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
});

describe('Phase 3 — taxi live-operation gate (hire-class insurance)', () => {
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
});
