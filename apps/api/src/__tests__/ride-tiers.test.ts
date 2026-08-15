import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, RideClass } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  FareService,
  applyClassMultiplier,
  classesAtOrAbove,
  classesAtOrBelow,
  CLASS_CAPACITY,
} from '../modules/rides/fare.service';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// Ride tiers (Economy/Comfort/XL) — deterministic per-tier pricing + vehicle
// matching. Re-introduced WITH a real driver-class assignment (the #112 gap was
// that every driver was STANDARD, so tiers dispatched to nobody). Failure paths
// first: capacity rejection and the dispatch class filter.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const CENTRAL = { lat: 6.81, lng: -58.155 };

let app: FastifyInstance;
let fare: FareService;
let dispatch: DispatchService;
const createdUserIds: string[] = [];

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200202' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { driver: { userId: { in: ids } } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200202${String(seq).padStart(2, '0')}`,
      firstName: 'Tier',
      lastName: `Cust${seq}`,
      roles: ['CUSTOMER'] as UserRole[],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      trustLevel: 'L2', // clear the ID-gate so big XL fares don't 403
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'tiers', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeDriver(rideClass: RideClass) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+59200202${String(seq).padStart(2, '0')}`,
      firstName: 'Tier',
      lastName: `Drv${seq}`,
      roles: ['DRIVER', 'CUSTOMER'] as UserRole[],
      activeRole: 'DRIVER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'DRIVER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'tiers', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.id,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021,
      vehicleColor: 'Silver', licensePlate: `TR-${seq}`,
      rideClass,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      documentsVerified: true, isOnline: true, isAvailable: true,
      currentLat: CENTRAL.lat, currentLng: CENTRAL.lng,
      lastLocationUpdate: new Date(),
      locationSessionId: session.id,
    },
  });
  return { ...u, id: u.id, driverId: driver.id, token };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
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

describe('Pure fare helpers', () => {
  it('Economy (×1.0) leaves the base fare unchanged', () => {
    expect(applyClassMultiplier(2350, 1.0, 1500)).toBe(2350);
  });

  it('scales and 100-rounds higher tiers, honouring the scaled minimum', () => {
    expect(applyClassMultiplier(2000, 1.35, 1500)).toBe(2700); // 2000×1.35 = 2700
    // tiny fare clamps to the scaled minimum: 1500×1.8 = 2700
    expect(applyClassMultiplier(800, 1.8, 1500)).toBe(2700);
  });

  it('classesAtOrAbove encodes "serves all tiers <= it"', () => {
    expect(classesAtOrAbove('ECONOMY')).toEqual(['ECONOMY', 'COMFORT', 'XL', 'GROUP']);
    expect(classesAtOrAbove('COMFORT')).toEqual(['COMFORT', 'XL', 'GROUP']);
    expect(classesAtOrAbove('XL')).toEqual(['XL', 'GROUP']);
    expect(classesAtOrAbove('GROUP')).toEqual(['GROUP']);
  });

  it('XL seats 6, GROUP (minibus) 14, the rest 4', () => {
    expect(CLASS_CAPACITY).toEqual({ ECONOMY: 4, COMFORT: 4, XL: 6, GROUP: 14 });
  });
});

describe('FareService.estimateTiers', () => {
  it('returns four tiers, strictly ascending in fare, GROUP the priciest', async () => {
    const { tiers } = await fare.estimateTiers(CENTRAL, { lat: 6.755, lng: -58.155 }, 'GY');
    expect(tiers.map((t) => t.rideClass)).toEqual(['ECONOMY', 'COMFORT', 'XL', 'GROUP']);
    expect(tiers[0]!.fare).toBeLessThan(tiers[1]!.fare);
    expect(tiers[1]!.fare).toBeLessThan(tiers[2]!.fare);
    expect(tiers[2]!.fare).toBeLessThan(tiers[3]!.fare);
    expect(tiers[3]!.fare).toBeGreaterThan(tiers[0]!.fare * 2); // GROUP ×2.5 economy
  });
});

describe('POST /rides/estimate — tiered shape', () => {
  it('returns { tiers } not a single fare', async () => {
    const { token } = await makeCustomer();
    const res = await inject('POST', '/api/v1/rides/estimate', { pickup: CENTRAL, dropoff: { lat: 6.755, lng: -58.155 } }, token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(Array.isArray(data.tiers)).toBe(true);
    expect(data.tiers).toHaveLength(4);
    expect(data.fare).toBeUndefined();
  });
});

describe('POST /rides/request — capacity guard (failure path)', () => {
  it('rejects 5 passengers on a 4-seat Economy', async () => {
    const { token } = await makeCustomer();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: { lat: 6.755, lng: -58.155 },
      pickupAddress: 'Central GT', dropoffAddress: 'South GT',
      passengerCount: 5, rideClass: 'ECONOMY',
    }, token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TOO_MANY_PASSENGERS');
  });

  it('accepts a 10-passenger group on GROUP but rejects it on XL', async () => {
    const { token } = await makeCustomer();
    const base = {
      pickup: CENTRAL, dropoff: { lat: 6.755, lng: -58.155 },
      pickupAddress: 'Central GT', dropoffAddress: 'South GT', passengerCount: 10,
    };
    const onXl = await inject('POST', '/api/v1/rides/request', { ...base, rideClass: 'XL' }, token);
    expect(onXl.statusCode).toBe(400);
    expect(onXl.json().error.code).toBe('TOO_MANY_PASSENGERS'); // XL seats 6

    await makeDriver('GROUP'); // a minibus to dispatch to
    const onGroup = await inject('POST', '/api/v1/rides/request', { ...base, rideClass: 'GROUP' }, token);
    expect(onGroup.statusCode).toBe(201); // 10 is within GROUP's 14 seats — ride created
  });

  it('persists the chosen tier and its fare on a valid request', async () => {
    await makeDriver('XL'); // someone to dispatch to
    const { token } = await makeCustomer();
    const res = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: { lat: 6.755, lng: -58.155 },
      pickupAddress: 'Central GT', dropoffAddress: 'South GT',
      passengerCount: 5, rideClass: 'XL',
    }, token);
    expect(res.statusCode).toBe(201);
    const ride = res.json().data.ride;
    expect(ride.rideClass).toBe('XL');
    const order = await app.prisma.order.findUnique({ where: { id: ride.id } });
    expect(order?.rideClass).toBe('XL');
    expect(Number(order?.taxiFareTotal)).toBe(ride.fare);
  });
});

describe('Dispatch class filter — an XL request never offers to an Economy car', () => {
  it('excludes a lower-tier driver and includes an eligible one', async () => {
    const economy = await makeDriver('ECONOMY');
    const xl = await makeDriver('XL');

    const xlCandidates = await dispatch.findCandidates(`tier-${nanoid(6)}`, CENTRAL, 5, 'DRIVER', 0, 'XL');
    const xlIds = xlCandidates.map((c) => c.riderId);
    expect(xlIds).toContain(xl.driverId);
    expect(xlIds).not.toContain(economy.driverId);

    // An Economy request can use either (a driver serves all tiers <= its own).
    const econCandidates = await dispatch.findCandidates(`tier-${nanoid(6)}`, CENTRAL, 5, 'DRIVER', 0, 'ECONOMY');
    const econIds = econCandidates.map((c) => c.riderId);
    expect(econIds).toContain(economy.driverId);
    expect(econIds).toContain(xl.driverId);
  });
});

describe('Ride-class gate on the board + accept [SWIFT-063]', () => {
  it('classesAtOrBelow: a driver serves their tier and below', () => {
    expect(classesAtOrBelow('ECONOMY')).toEqual(['ECONOMY']);
    expect(classesAtOrBelow('XL')).toEqual(['ECONOMY', 'COMFORT', 'XL']);
  });

  it('an Economy driver can neither SEE nor CLAIM an XL ride', async () => {
    const xlDriver = await makeDriver('XL'); // supply so the request isn't no-driver-rejected
    const econDriver = await makeDriver('ECONOMY');
    const { token: cust } = await makeCustomer();

    const req = await inject('POST', '/api/v1/rides/request', {
      pickup: CENTRAL, dropoff: { lat: 6.755, lng: -58.155 },
      pickupAddress: 'Central GT', dropoffAddress: 'South GT',
      passengerCount: 5, rideClass: 'XL',
    }, cust);
    expect(req.statusCode).toBe(201);
    const rideId = req.json().data.ride.id;

    // Board: the XL ride is on the XL driver's board, NOT the Economy driver's.
    const econBoard = await inject('GET', '/api/v1/driver/rides/available', undefined, econDriver.token);
    expect(econBoard.json().data.some((r: { id: string }) => r.id === rideId)).toBe(false);
    const xlBoard = await inject('GET', '/api/v1/driver/rides/available', undefined, xlDriver.token);
    expect(xlBoard.json().data.some((r: { id: string }) => r.id === rideId)).toBe(true);

    // Accept: the Economy driver is refused; the ride stays unassigned.
    const econAccept = await inject('POST', `/api/v1/driver/rides/${rideId}/accept`, {}, econDriver.token);
    expect(econAccept.statusCode).toBe(400);
    expect(econAccept.json().error.code).toBe('WRONG_RIDE_CLASS');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: rideId } })).driverId).toBeNull();
  });
});
