import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { currentMoverDocuments } from './helpers/current-mover-documents';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [TAXI route line · MAPS-CHECK G1] GET /driver/rides/:id/route: the road the
// driver follows through the ride's own points, for the driver's map only.
//
//  - Only the ride's own driver, only while the ride is live (404 otherwise;
//    403 for someone who is not a driver).
//  - The points: the pickup, each stop not skipped in the passenger's order,
//    then the destination. A ride without stops: the pickup and the destination.
//  - With the routing engine (OSRM): ONE route call through those points with
//    the road's geometry, answered as source 'road' and the road's own points.
//  - Without an engine, or when it fails or answers something that is not a
//    line: source 'straight' and the points themselves, so the app keeps its
//    straight heading line exactly as before. Never an error for that.
//
// The interior near Iwokrama (no fare zone, no other suite's fixtures).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = retainedPhonePrefix('44');
const FIXTURE = 'taxi-route-line';

const PICKUP = { lat: 4.4, lng: -58.6 };
const DEST = { lat: 4.412, lng: -58.607 };
const S1 = { lat: 4.406, lng: -58.595, address: 'Iwokrama Field Station' };
const S2 = { lat: 4.394, lng: -58.587, address: 'Fairview Landing' };
const OSRM = 'http://osrm.route-line.test';

/** A road through the itinerary as OSRM's geojson gives it: [lng, lat] pairs. */
const ROAD: [number, number][] = [
  [-58.6, 4.4], [-58.5981234567, 4.4012345678], [-58.595, 4.406], [-58.5912, 4.4001], [-58.587, 4.394], [-58.5999, 4.4071], [-58.607, 4.412],
];

let app: FastifyInstance;
let seq = 0;

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type DriverActor = Actor & { driverId: string };
type Stop = { lat: number; lng: number; address: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Roadline',
      lastName: `U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    } as never,
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `roadline-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

const makeCustomer = () => makeUser(['CUSTOMER'], 'CUSTOMER');

async function makeDriver(): Promise<DriverActor> {
  const u = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'White',
      licensePlate: `HR ${6000 + seq}`, driverLicenseUrl: 'storage://roadline/dl.jpg', vehicleInsuranceUrl: 'storage://roadline/ins.jpg',
      vehiclePhotoUrl: 'https://cdn.test/allion.jpg', documentsVerified: true,
      isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
      averageRating: 4.9, acceptanceRate: 90, taxiStopsCapable: true,
    } as never,
  }));
  await sys(() => currentMoverDocuments(app.prisma, u.userId, 'CAR', true));
  return { ...u, driverId: driver.id };
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Booked (with the quoted whole-route fare when it has stops), taken by
 *  `driver` and driven to the trip. Booked on the straight-line provider: the
 *  engine is switched on per case, for the route read only. */
async function rideOf(driver: DriverActor, customer: Actor, stops: readonly Stop[], start = true): Promise<string> {
  let expectedFare: number | undefined;
  if (stops.length > 0) {
    const q = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST, stops });
    expect(q.statusCode, q.body).toBe(200);
    expectedFare = (q.json().data.tiers as { rideClass: string; fare: number }[]).find((t) => t.rideClass === 'ECONOMY')!.fare;
  }
  const res = await call('POST', '/api/v1/rides/request', customer.token, {
    pickup: PICKUP, dropoff: DEST, pickupAddress: 'Iwokrama River Lodge', dropoffAddress: 'Iwokrama Airstrip',
    passengerCount: 1, rideClass: 'ECONOMY', ...(stops.length > 0 ? { stops, expectedFare } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  const ride = res.json().data.ride as { id: string; ridePin: string };
  expect((await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, driver.token, {})).statusCode).toBe(200);
  if (!start) return ride.id;
  for (const leg of ['en-route', 'arrived']) {
    const r = await call('PUT', `/api/v1/driver/rides/${ride.id}/${leg}`, driver.token, {});
    expect(r.statusCode, `${leg}: ${r.body}`).toBe(200);
  }
  expect((await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin })).statusCode).toBe(200);
  expect((await call('PUT', `/api/v1/driver/rides/${ride.id}/start`, driver.token, {})).statusCode).toBe(200);
  return ride.id;
}

const routeOf = (actor: Actor, rideId: string) => call('GET', `/api/v1/driver/rides/${rideId}/route`, actor.token);
const pts = (...ps: { lat: number; lng: number }[]) => ps.map(({ lat, lng }) => ({ lat, lng }));

/** OSRM switched on for the route read, answering `body` (or failing), and
 *  every URL it was asked recorded. */
function osrm(answer: () => Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubEnv('MAPS_PROVIDER', 'osrm');
  vi.stubEnv('OSRM_URL', OSRM);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => { urls.push(String(url)); return answer(); }));
  return urls;
}
const osrmLine = (coordinates: unknown) => async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 4100, duration: 600, geometry: { type: 'LineString', coordinates } }] }));

async function buildApp(): Promise<FastifyInstance> {
  const built = Fastify({ logger: false });
  registerErrorHandler(built);
  registerEmptyJsonBodyParser(built);
  built.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await built.register(prismaPlugin);
  await built.register(redisPlugin);
  await built.register(authPlugin);
  await built.register(socketPlugin);
  recordDispatchQueue(built, true);
  await built.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await built.register(driverRoutes, { prefix: '/api/v1/driver' });
  await built.ready();
  return built;
}

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const driverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const allOids = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { orderIds: allOids });
      const oids = without(allOids, kept.orderIds);
      const goneIds = without(ids, kept.userIds);
      await tx.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: allOids } }, { recipientId: { in: ids } }] } });
      await tx.algoDecision.deleteMany({ where: { subjectId: { in: [...allOids, ...driverIds] } } });
      await tx.dispatchSearch.deleteMany({ where: { subjectId: { in: allOids } } });
      if (allOids.length > 0) await tx.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(allOids)})`;
      await tx.notification.deleteMany({ where: { userId: { in: ids } } });
      await tx.earning.deleteMany({ where: { orderId: { in: oids } } });
      await tx.checkoutReceipt.deleteMany({ where: { userId: { in: goneIds } } });
      await tx.driver.updateMany({ where: { userId: { in: ids } }, data: { currentRideId: null } });
      await tx.order.deleteMany({ where: { id: { in: oids } } });
      await tx.subscription.deleteMany({ where: { driverId: { in: driverIds } } });
      await tx.session.deleteMany({ where: { userId: { in: ids } } });
      await tx.driver.deleteMany({ where: { userId: { in: goneIds } } });
      await tx.customer.deleteMany({ where: { userId: { in: goneIds } } });
      await tx.user.deleteMany({ where: { id: { in: goneIds } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
    for (const id of [...ids, ...driverIds, ...allOids]) {
      const keys = [...await app.redis.keys(`dispatch:*${id}*`), ...await app.redis.keys(`*idem:${id}:*`)];
      if (keys.length > 0) await app.redis.del(...keys);
    }
  }, FIXTURE);
}

/** Every driver of this suite off the road (so the next case's dispatch is its own). */
const allOffline = () => sys(async () => {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  await app.prisma.driver.updateMany({ where: { userId: { in: users.map((u) => u.id) } }, data: { isOnline: false, isAvailable: false } });
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  delete process.env['MAPS_PROVIDER'];
  delete process.env['OSRM_URL'];
  delete process.env['DISPATCH_AVAILABILITY'];
  app = await buildApp();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await allOffline();
});

describe('who may read a ride’s road line', () => {
  it('only the ride’s own driver, only while the ride is live: another driver and an unknown ride 404, a passenger 403, a finished ride 404', async () => {
    const driver = await makeDriver();
    const customer = await makeCustomer();
    const rideId = await rideOf(driver, customer, []);
    expect((await routeOf(driver, rideId)).statusCode).toBe(200);

    const stranger = await makeDriver();
    const other = await routeOf(stranger, rideId);
    expect(other.statusCode, other.body).toBe(404);
    const passenger = await routeOf(customer, rideId);
    expect(passenger.statusCode, passenger.body).toBe(403);
    expect((await routeOf(driver, 'cl0000000000000000000000x')).statusCode).toBe(404);

    const paid = await call('POST', `/api/v1/driver/rides/${rideId}/handover`, driver.token, { outcome: 'paid', gps: DEST });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await routeOf(driver, rideId)).statusCode, 'a finished ride has no line to follow').toBe(404);
  });
});

describe('without a routing engine: the ride’s own points, as before', () => {
  it('a ride without stops: the pickup then the destination, source straight', async () => {
    const driver = await makeDriver();
    const rideId = await rideOf(driver, await makeCustomer(), [], false);
    const res = await routeOf(driver, rideId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ source: 'straight', points: pts(PICKUP, DEST) });
  });

  it('a ride with stops: the pickup, each stop in the passenger’s order, the destination; a skipped stop drops out of the line', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const driver = await makeDriver();
    const rideId = await rideOf(driver, await makeCustomer(), [S1, S2]);
    expect((await routeOf(driver, rideId)).json().data).toEqual({ source: 'straight', points: pts(PICKUP, S1, S2, DEST) });
    const skip = await call('POST', `/api/v1/driver/rides/${rideId}/stops/1/skip`, driver.token, { reason: 'Road flooded at the landing' });
    expect(skip.statusCode, skip.body).toBe(200);
    expect((await routeOf(driver, rideId)).json().data).toEqual({ source: 'straight', points: pts(PICKUP, S2, DEST) });
  });
});

describe('with the routing engine: the road itself', () => {
  it('ONE route call through pickup; stops; destination with the road’s geometry, answered as the road’s own points (5 decimals)', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const driver = await makeDriver();
    const rideId = await rideOf(driver, await makeCustomer(), [S1, S2]);
    const urls = osrm(osrmLine(ROAD));
    const res = await routeOf(driver, rideId);
    expect(res.statusCode, res.body).toBe(200);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`${OSRM}/route/v1/driving/-58.6,4.4;-58.595,4.406;-58.587,4.394;-58.607,4.412?overview=simplified&geometries=geojson`);
    expect(res.json().data).toEqual({
      source: 'road',
      points: ROAD.map(([lng, lat]) => ({ lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 })),
    });
  });

  it.each([
    ['the engine cannot be reached', async () => { throw new Error('unreachable'); }],
    ['the engine answers an error status', async () => new Response('busy', { status: 503 })],
    ['the engine finds no route', async () => new Response(JSON.stringify({ code: 'NoRoute', routes: [] }))],
    ['the answer is not JSON', async () => new Response('<html>')],
    ['the route has no geometry', async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 10 }] }))],
    // REVIEW-G #2016 S4-1: only an 'Ok' answer is a road, even when another code arrives with a usable geometry.
    ['the engine says it is not Ok but still sends a line', async () => new Response(JSON.stringify({ code: 'InvalidQuery', routes: [{ distance: 4100, duration: 600, geometry: { type: 'LineString', coordinates: [[-58.6, 4.4], [-58.59, 4.41]] } }] }))],
    ['a point is not a number', osrmLine([[-58.6, 4.4], ['-58.6', 4.41]])],
    ['a point is not finite', osrmLine([[-58.6, 4.4], [null, 4.41]])],
    ['a point is off the globe', osrmLine([[-58.6, 4.4], [-58.6, 91]])],
    ['a single point is no line', osrmLine([[-58.6, 4.4]])],
    ['more points than a map line needs', osrmLine(Array.from({ length: 5001 }, (_, i) => [-58.6 + i * 1e-6, 4.4]))],
  ])('%s: the straight points instead, never an error', async (_name, answer) => {
    const driver = await makeDriver();
    const rideId = await rideOf(driver, await makeCustomer(), [], false);
    osrm(answer as () => Promise<Response>);
    const res = await routeOf(driver, rideId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ source: 'straight', points: pts(PICKUP, DEST) });
  });
});
