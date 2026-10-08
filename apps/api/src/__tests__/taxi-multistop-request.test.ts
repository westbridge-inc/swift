import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant, runWithTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { OrderService } from '../modules/order/order.service';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { currentMoverDocuments } from './helpers/current-mover-documents';
import { pinLegacyGuyanaTaxiCard } from './helpers/legacy-taxi-card';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 3/8] The request and the reads, through the real routes,
// the real fare engine and the real dispatch.
//
//  - Switched off (TAXI_MAX_STOPS unset, the default): a ride without stops is
//    requested, answered and read exactly as today (pinned), and a ride with
//    stops is refused before anything is written.
//  - Switched on: a ride with 1..3 stops is created at the server's own
//    whole-route fare (the passenger's quoted fare is checked, never used),
//    its stops stored in the passenger's order; a bad itinerary is refused
//    with nothing written; the Idempotency-Key works the checkout way.
//  - The passenger's ride, the driver's board, the live offer card, the card
//    rebuilt after an app restart and the driver's active ride all show the
//    stops in order; nobody of another operator sees any of it.
//  - The order can never be DELIVERED while a stop is still open.
//
// Bartica (no fare zone, no other suite's fixtures). Phone prefix +5923431
// (grepped: unused elsewhere).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = '+5923431';
const FIXTURE = 'taxi-multistop-request';

const PICKUP = { lat: 6.406, lng: -58.623 };
const DEST = { lat: 6.418, lng: -58.63 };
const S1 = { lat: 6.412, lng: -58.618, address: 'Bartica Stelling' };
const S2 = { lat: 6.4, lng: -58.61, address: 'Second Avenue' };
const S3 = { lat: 6.395, lng: -58.625, address: 'Bartica Hospital' };
const PICKUP_ADDRESS = 'Bartica Police Station';
const DROPOFF_ADDRESS = 'Bartica Airstrip';
// Two fare zones of this file's own near Anna Regina (created in beforeAll, never
// the seed's: the seeded fixed fares can change), with a fixed fare from North to
// South; and Port of Spain (abroad).
const ZONE_NORTH = { lat: 7.255, lng: -58.5 };
const ZONE_NORTH_STOP = { lat: 7.262, lng: -58.505, address: 'Anna Regina Market' }; // also in North
const ZONE_SOUTH = { lat: 7.21, lng: -58.5 };
const OUTSIDE_ZONES = { lat: 7.235, lng: -58.45, address: 'Coast road' };
const box = (west: number, south: number, east: number, north: number) =>
  ({ type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
const zoneIds: { north: string; south: string } = { north: '', south: '' };
const PORT_OF_SPAIN = { lat: 10.6596, lng: -61.5089, address: 'Port of Spain' };

/** Today's request answer for PICKUP → DEST, byte for byte, as unmodified main
 *  writes it (recorded on main d2608e97 before this change; the ids, the
 *  order number and the PIN are the only values that vary). Priced on the
 *  legacy Guyana taxi card, which this suite pins (pinLegacyGuyanaTaxiCard):
 *  the pin is about the request's shape, not about the October fare. */
const PINNED_SINGLE_LEG_ANSWER = '{"success":true,"data":{"ride":{"id":"<ID>","orderNumber":"<NUMBER>","status":"PENDING","fare":1700,"rideClass":"ECONOMY","currencyCode":"GYD","fareSource":"formula","distanceKm":2,"durationMin":5,"ridePin":"<PIN>","pickupAddress":"Bartica Police Station","dropoffAddress":"Bartica Airstrip"},"message":"Looking for a driver near you…"}}';

/** The keys of an open-board item and of the two offer cards today (main). */
const BOARD_ITEM_KEYS = ['id', 'orderNumber', 'pickupLat', 'pickupLng', 'dropoffLat', 'dropoffLng', 'passengerCount', 'estimatedDistance', 'estimatedDuration', 'fareTotal', 'fareSurge', 'distanceToPickup', 'etaToPickup', 'customer', 'createdAt'];
const LIVE_OFFER_KEYS = ['orderId', 'offerAttemptId', 'orderNumber', 'isExpress', 'expiresInSeconds', 'etaMinutes', 'rescueIncentiveGyd', 'paymentMethod', 'customerTrust', 'itemCount', 'estLoad', 'cashMath'];
const RECOVERED_OFFER_KEYS = ['orderId', 'offerAttemptId', 'orderNumber', 'vendorName', 'isExpress', 'paymentMethod', 'expiresInSeconds', 'itemCount', 'estLoad', 'customerTrust', 'deliveryFee', 'tipAmount', 'taxiFareTotal', 'pickupAddress', 'deliveryAddress', 'etaMinutes', 'rescueIncentiveGyd', 'cashMath'];
const STOP_KEYS = ['stops', 'stopCount', 'nextStopSequence'];

let app: FastifyInstance;
let osrmApp: FastifyInstance;
/** A second instance standing in for the server after a restart; closed last. */
let restarted: FastifyInstance | null = null;
let restoreTaxiCard: () => Promise<void> = async () => {};
let seq = 0;
const tenantIds: string[] = [];
const emitted: { room: string; event: string; payload: unknown }[] = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type DriverActor = Actor & { driverId: string };
type Point = { lat: number; lng: number };
type Stop = Point & { address: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`,
      firstName: 'Stops',
      lastName: `U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      ...extra,
    } as never,
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `stops-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

const makeCustomer = (extra: Record<string, unknown> = {}) => makeUser(['CUSTOMER'], 'CUSTOMER', extra);

/** An online, free, freshly located taxi driver who owns their GO session. */
async function makeDriver(at: Point, extra: Record<string, unknown> = {}): Promise<DriverActor> {
  const u = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER', extra);
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'White',
      licensePlate: `HS ${4000 + seq}`, driverLicenseUrl: 'storage://stops/dl.jpg', vehicleInsuranceUrl: 'storage://stops/ins.jpg',
      vehiclePhotoUrl: 'https://cdn.test/allion.jpg', documentsVerified: true,
      isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(),
      averageRating: 4.9, acceptanceRate: 90,
    } as never,
  }));
  // [#1405] Taking work re-checks the driver's current approved documents,
  // HIRE-class insurance included, as for every taxi suite's driver.
  await sys(() => currentMoverDocuments(app.prisma, u.userId, 'CAR', true));
  return { ...u, driverId: driver.id };
}

function call(on: FastifyInstance, method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return on.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** The trip of every case: PICKUP → (stops) → DEST, Economy, one passenger. */
function trip(stops?: unknown, extra: Record<string, unknown> = {}) {
  return {
    pickup: PICKUP, dropoff: DEST, pickupAddress: PICKUP_ADDRESS, dropoffAddress: DROPOFF_ADDRESS,
    passengerCount: 1, rideClass: 'ECONOMY',
    ...(stops !== undefined ? { stops } : {}),
    ...extra,
  };
}

const requestRide = (token: string, payload: unknown, key?: string, on: FastifyInstance = app) =>
  call(on, 'POST', '/api/v1/rides/request', token, payload, key ? { 'idempotency-key': key } : {});

/** The whole-route quote the passenger is shown for an itinerary. */
async function quote(token: string, stops: readonly Stop[], rideClass = 'ECONOMY', from: Point = PICKUP, to: Point = DEST) {
  const res = await call(app, 'POST', '/api/v1/rides/estimate', token, { pickup: from, dropoff: to, stops });
  expect(res.statusCode, res.body).toBe(200);
  const data = res.json().data as {
    tiers: { rideClass: string; fare: number }[]; distanceKm: number; durationMin: number; billableKm: number; routeSource: string;
    legs: { from: string; to: string; meters: number; seconds: number | null }[];
  };
  return { ...data, fare: data.tiers.find((t) => t.rideClass === rideClass)!.fare };
}

/** Everything a request could have written for this customer. */
async function writesOf(customer: Actor) {
  return sys(async () => {
    const orders = await app.prisma.order.findMany({ where: { customerId: customer.userId }, select: { id: true } });
    return {
      orders: orders.length,
      stops: await app.prisma.taxiTripStop.count({ where: { order: { customerId: customer.userId } } }),
      receipts: await app.prisma.checkoutReceipt.count({ where: { userId: customer.userId } }),
    };
  });
}
const NOTHING = { orders: 0, stops: 0, receipts: 0 };

/** The ride row and its stops, read as the system (no tenant bound). */
const rideRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({
  where: { id },
  include: { taxiStops: { orderBy: { sequence: 'asc' } } },
}));

/** The ride's live Redis claim, for the idempotency cases. */
const claimKeysOf = async (userId: string) => app.redis.keys(`*idem:${userId}:*`);

async function buildApp(): Promise<FastifyInstance> {
  const built = Fastify({ logger: false });
  registerErrorHandler(built);
  registerEmptyJsonBodyParser(built);
  // As app.ts: a fresh tenant store per request, before auth binds the caller's tenant.
  built.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await built.register(prismaPlugin);
  await built.register(redisPlugin);
  await built.register(authPlugin);
  await built.register(socketPlugin);
  // The route-to-worker hop runs at once; offer timeouts are recorded, never run.
  recordDispatchQueue(built, true);
  await built.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await built.register(driverRoutes, { prefix: '/api/v1/driver' });
  await built.ready();
  return built;
}

async function purgeFixtures(on: FastifyInstance) {
  await runWithoutTenant(async () => {
    const users = await on.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const driverIds = (await on.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const orderIds = (await on.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await on.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await on.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...driverIds] } } });
    await on.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    if (orderIds.length > 0) {
      await on.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await on.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await on.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: ids } } });
    await on.prisma.supplyWatch.deleteMany({ where: { customerId: { in: ids } } });
    await on.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await on.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await on.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await on.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await on.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await on.prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (tenantIds.length > 0) await on.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    for (const id of [...ids, ...driverIds, ...orderIds]) {
      const keys = [...await on.redis.keys(`dispatch:*${id}*`), ...await on.redis.keys(`*idem:${id}:*`)];
      if (keys.length > 0) await on.redis.del(...keys);
    }
  }, FIXTURE);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  delete process.env['MAPS_PROVIDER'];
  delete process.env['OSRM_URL'];
  delete process.env['DISPATCH_AVAILABILITY'];
  app = await buildApp();
  process.env['MAPS_PROVIDER'] = 'osrm';
  process.env['OSRM_URL'] = 'http://osrm.test';
  try {
    osrmApp = await buildApp();
  } finally {
    delete process.env['MAPS_PROVIDER'];
    delete process.env['OSRM_URL'];
  }
  restoreTaxiCard = await pinLegacyGuyanaTaxiCard(app.prisma);
  await purgeFixtures(app);
  // This file's own fare zones and their fixed fare (the zone model is tenant
  // scoped: written as the system, owned by the default tenant in GY).
  await sys(async () => {
    await app.prisma.zone.deleteMany({ where: { name: { startsWith: `${FIXTURE} ` } } });
    const north = await app.prisma.zone.create({ data: { name: `${FIXTURE} north`, boundary: box(-58.52, 7.245, -58.48, 7.27) as never, tenantId: 'swift-default', countryCode: 'GY' } });
    const south = await app.prisma.zone.create({ data: { name: `${FIXTURE} south`, boundary: box(-58.52, 7.19, -58.48, 7.225) as never, tenantId: 'swift-default', countryCode: 'GY' } });
    await app.prisma.zoneFare.create({ data: { fromZoneId: north.id, toZoneId: south.id, fare: 2000 } });
    zoneIds.north = north.id;
    zoneIds.south = south.id;
  });
  // Record every room emission: the offer card's event and room are the driver app's contract.
  const realTo = app.io.to.bind(app.io);
  (app.io as { to: (room: string) => unknown }).to = (room: string) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ room, event, payload });
      return realTo(room).emit(event, payload);
    },
  });
});

afterAll(async () => {
  await restoreTaxiCard();
  await purgeFixtures(app);
  // Deleting the zones cascades their fare.
  await sys(() => app.prisma.zone.deleteMany({ where: { name: { startsWith: `${FIXTURE} ` } } }));
  if (restarted) await restarted.close();
  await osrmApp.close();
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ===========================================================================
describe('switched off (TAXI_MAX_STOPS unset, the default): inert', () => {
  it('a ride without stops is requested exactly as today: the answer pinned byte for byte, nothing stop-shaped written', async () => {
    for (const noStops of [undefined, null, []]) {
      const customer = await makeCustomer();
      const res = await requestRide(customer.token, trip(noStops));
      expect(res.statusCode, res.body).toBe(201);
      const ride = res.json().data.ride as { id: string; orderNumber: string; ridePin: string };
      const body = res.body.replace(ride.id, '<ID>').replace(ride.orderNumber, '<NUMBER>').replace(`"ridePin":"${ride.ridePin}"`, '"ridePin":"<PIN>"');
      expect(body, JSON.stringify(noStops)).toBe(PINNED_SINGLE_LEG_ANSWER);
      const row = await rideRow(ride.id);
      expect({ count: row.taxiStopCount, stops: row.taxiStops.length }).toEqual({ count: null, stops: 0 });
    }
  });

  it('a ride with stops is refused, 409 MULTI_STOP_UNAVAILABLE, before a stop is looked at; nothing is written and no key is held', async () => {
    for (const stops of [[S1], [S1, S2, S3], [{ lat: 999, lng: 999, address: '' }]]) {
      const customer = await makeCustomer();
      const res = await requestRide(customer.token, trip(stops, { expectedFare: 2800 }), `off-${nanoid(10)}`);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'MULTI_STOP_UNAVAILABLE', details: { maxStops: 0, stopCount: stops.length } });
      expect(await writesOf(customer)).toEqual(NOTHING);
      expect(await claimKeysOf(customer.userId)).toEqual([]);
    }
  });

  it('the queue refuses stops the same way (409 MULTI_STOP_UNAVAILABLE) and holds no entry', async () => {
    const customer = await makeCustomer();
    const res = await call(app, 'POST', '/api/v1/rides/queue/join', customer.token, trip([S1]));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'MULTI_STOP_UNAVAILABLE', details: { maxStops: 0, stopCount: 1 } });
    expect(await sys(() => app.prisma.rideQueueEntry.count({ where: { customerId: customer.userId } }))).toBe(0);
  });

  it('GET /rides/capabilities tells the app how many stops it may offer: 0 while off, the configured number when on', async () => {
    const customer = await makeCustomer();
    const read = async () => {
      const res = await call(app, 'GET', '/api/v1/rides/capabilities', customer.token);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    expect(await read()).toEqual({ success: true, data: { maxStops: 0 } });
    for (const [flag, maxStops] of [['0', 0], ['garbage', 0], ['1', 1], ['3', 3], ['9', 3]] as const) {
      vi.stubEnv('TAXI_MAX_STOPS', flag);
      expect(await read(), flag).toEqual({ success: true, data: { maxStops } });
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/rides/capabilities' })).statusCode).toBe(401);
  });
});

describe('a ride without stops is the same ride with the switch on', () => {
  it('the same answer and the same row, whatever TAXI_MAX_STOPS says', async () => {
    const answers: string[] = [];
    const rows: unknown[] = [];
    for (const flag of ['', '3']) {
      vi.stubEnv('TAXI_MAX_STOPS', flag);
      const customer = await makeCustomer();
      const res = await requestRide(customer.token, trip());
      expect(res.statusCode, res.body).toBe(201);
      const ride = res.json().data.ride as { id: string; orderNumber: string; ridePin: string };
      answers.push(res.body.replace(ride.id, '<ID>').replace(ride.orderNumber, '<NUMBER>').replace(`"ridePin":"${ride.ridePin}"`, '"ridePin":"<PIN>"'));
      const row = await rideRow(ride.id);
      rows.push({
        fare: Number(row.taxiFareTotal), total: Number(row.totalAmount), km: Number(row.billableKm), distance: row.taxiDistance,
        minutes: row.taxiDuration, source: row.billableKmSource, stopCount: row.taxiStopCount, stops: row.taxiStops.length,
        to: [row.deliveryLat, row.deliveryLng, row.taxiDropoffAddress],
      });
    }
    expect(answers).toEqual([PINNED_SINGLE_LEG_ANSWER, PINNED_SINGLE_LEG_ANSWER]);
    expect(rows[1]).toEqual(rows[0]);
  });
});

// ===========================================================================
describe('switched on (TAXI_MAX_STOPS=3): a ride with stops', () => {
  it('two stops: created at the server\'s whole-route fare, the stops stored in the passenger\'s order with their legs, and the answer carries them', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1, S2]);
    const res = await requestRide(customer.token, trip([S1, S2], { expectedFare: q.fare }));
    expect(res.statusCode, res.body).toBe(201);
    const ride = res.json().data.ride;
    expect(Object.keys(res.json().data)).toEqual(['ride', 'message']);
    expect(Object.keys(ride)).toEqual(['id', 'orderNumber', 'status', 'fare', 'rideClass', 'currencyCode', 'fareSource', 'distanceKm', 'durationMin', 'ridePin', 'pickupAddress', 'dropoffAddress', 'stopCount', 'stops']);
    expect(ride).toMatchObject({
      status: 'PENDING', fare: q.fare, rideClass: 'ECONOMY', currencyCode: 'GYD', fareSource: 'formula',
      distanceKm: q.distanceKm, durationMin: q.durationMin, pickupAddress: PICKUP_ADDRESS, dropoffAddress: DROPOFF_ADDRESS, stopCount: 2,
    });
    expect(ride.stops).toEqual([
      { sequence: 1, address: S1.address, lat: S1.lat, lng: S1.lng },
      { sequence: 2, address: S2.address, lat: S2.lat, lng: S2.lng },
    ]);

    const row = await rideRow(ride.id);
    expect({
      fare: Number(row.taxiFareTotal), total: Number(row.totalAmount), customer: Number(row.subtotalCustomer), km: Number(row.billableKm),
      distance: row.taxiDistance, minutes: row.taxiDuration, source: row.billableKmSource, count: row.taxiStopCount,
      to: [row.deliveryLat, row.deliveryLng, row.taxiDropoffAddress, row.deliveryAddress],
    }).toEqual({
      fare: q.fare, total: q.fare, customer: q.fare, km: q.billableKm, distance: q.distanceKm, minutes: q.durationMin, source: q.routeSource, count: 2,
      to: [DEST.lat, DEST.lng, DROPOFF_ADDRESS, DROPOFF_ADDRESS],
    });
    expect(row.taxiStops.map((s) => ({
      tenantId: s.tenantId, sequence: s.sequence, lat: s.lat, lng: s.lng, address: s.address, legMeters: s.legMeters, legSeconds: s.legSeconds, status: s.status,
    }))).toEqual([
      { tenantId: row.tenantId, sequence: 1, lat: S1.lat, lng: S1.lng, address: S1.address, legMeters: q.legs[0]!.meters, legSeconds: null, status: 'PENDING' },
      { tenantId: row.tenantId, sequence: 2, lat: S2.lat, lng: S2.lng, address: S2.address, legMeters: q.legs[1]!.meters, legSeconds: null, status: 'PENDING' },
    ]);
    const log = await sys(() => app.prisma.orderStatusLog.findFirstOrThrow({ where: { orderId: ride.id, status: 'PENDING' } }));
    expect(log.note).toBe(`Ride requested — fixed fare $${q.fare}, 2 stops`);
  });

  it('three stops on Comfort: the tier\'s whole-route fare, one trip (the base fare once), stops 1..3 in order', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1, S2, S3], 'COMFORT');
    const res = await requestRide(customer.token, trip([S1, S2, S3], { rideClass: 'COMFORT', expectedFare: q.fare }));
    expect(res.statusCode, res.body).toBe(201);
    const row = await rideRow(res.json().data.ride.id);
    expect({ fare: Number(row.taxiFareTotal), cls: row.rideClass, count: row.taxiStopCount }).toEqual({ fare: q.fare, cls: 'COMFORT', count: 3 });
    expect(row.taxiStops.map((s) => [s.sequence, s.address])).toEqual([[1, S1.address], [2, S2.address], [3, S3.address]]);
    // One trip over the whole road, not four: priced leg by leg it would carry the base fare four times.
    const legByLeg = await Promise.all(([[PICKUP, S1], [S1, S2], [S2, S3], [S3, DEST]] as const).map(async ([a, b]) => {
      const r = await call(app, 'POST', '/api/v1/rides/estimate', customer.token, { pickup: { lat: a.lat, lng: a.lng }, dropoff: { lat: b.lat, lng: b.lng } });
      return (r.json().data.tiers as { rideClass: string; fare: number }[]).find((t) => t.rideClass === 'COMFORT')!.fare;
    }));
    expect(q.fare).toBeLessThan(legByLeg.reduce((a, b) => a + b, 0));
  });

  it('the configured maximum binds: TAXI_MAX_STOPS=2 refuses a third stop (400 TOO_MANY_STOPS), nothing written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '2');
    const customer = await makeCustomer();
    const res = await requestRide(customer.token, trip([S1, S2, S3], { expectedFare: 5000 }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'TOO_MANY_STOPS', details: { maxStops: 2, stopCount: 3 } });
    expect(await writesOf(customer)).toEqual(NOTHING);
  });

  it('invalid itineraries are refused, named, with nothing written: four stops, a repeated point, a zero-length leg, abroad, zone-priced, malformed', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const cases: Array<[string, Record<string, unknown>, number, string, Record<string, unknown>?]> = [
      ['four stops', trip([S1, S2, S3, { ...S1, address: 'Again' }]), 400, 'TOO_MANY_STOPS', { maxStops: 3, stopCount: 4 }],
      ['the same stop twice in a row', trip([S1, { ...S1, address: 'Bartica Stelling again' }]), 400, 'STOP_TOO_CLOSE', { stopSequence: 2, from: 'STOP_1', to: 'STOP_2', distanceMeters: 0, minMeters: 50 }],
      ['a stop at the pickup (a zero-length first leg)', trip([{ ...PICKUP, address: 'Right here' }]), 400, 'STOP_TOO_CLOSE', { stopSequence: 1, from: 'PICKUP', to: 'STOP_1', distanceMeters: 0 }],
      ['a stop at the destination (a zero-length last leg)', trip([S1, { ...DEST, address: 'The airstrip' }]), 400, 'STOP_TOO_CLOSE', { stopSequence: 2, from: 'STOP_2', to: 'DESTINATION', distanceMeters: 0 }],
      ['a stop 20 m from the one before it', trip([S1, { lat: S1.lat + 20 / 111_195, lng: S1.lng, address: 'Next door' }]), 400, 'STOP_TOO_CLOSE', { stopSequence: 2, from: 'STOP_1', to: 'STOP_2' }],
      ['a stop abroad', trip([S1, PORT_OF_SPAIN]), 400, 'STOP_OUT_OF_MARKET', { place: 'STOP_2' }],
      ['a zone-priced leg', { ...trip([ZONE_NORTH_STOP]), pickup: ZONE_NORTH, dropoff: ZONE_SOUTH }, 409, 'MULTI_STOP_ZONE_PRICED', { from: 'STOP_1', to: 'DESTINATION', fromZoneId: zoneIds.north, toZoneId: zoneIds.south }],
      ['a zone-priced direct pair, stepped around by a stop outside every zone', { ...trip([OUTSIDE_ZONES]), pickup: ZONE_NORTH, dropoff: ZONE_SOUTH }, 409, 'MULTI_STOP_ZONE_PRICED', { from: 'PICKUP', to: 'DESTINATION', fromZoneId: zoneIds.north, toZoneId: zoneIds.south }],
      ['a stop with no address', trip([{ lat: S1.lat, lng: S1.lng }]), 400, 'VALIDATION_ERROR'],
      ['a stop off the globe', trip([{ ...S1, lat: 91 }]), 400, 'VALIDATION_ERROR'],
      ['stops that are not a list', trip('Bartica Stelling'), 400, 'VALIDATION_ERROR'],
    ];
    for (const [name, body, status, code, details] of cases) {
      const customer = await makeCustomer();
      const res = await requestRide(customer.token, { ...body, expectedFare: 3000 }, `bad-${nanoid(10)}`);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(status);
      expect(res.json().error.code, name).toBe(code);
      if (details) expect(res.json().error.details, name).toMatchObject(details);
      expect(await writesOf(customer), name).toEqual(NOTHING);
      expect(await claimKeysOf(customer.userId), name).toEqual([]);
    }
  });

  it('a ride with stops carries the fare it was quoted: missing → 400 EXPECTED_FARE_REQUIRED, any other number → 409 FARE_CHANGED with the server\'s fare; nothing written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1]);
    const missing = await requestRide(customer.token, trip([S1]));
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'EXPECTED_FARE_REQUIRED', details: { stopCount: 1 } });
    for (const expectedFare of [q.fare - 100, q.fare + 100, 0]) {
      const res = await requestRide(customer.token, trip([S1], { expectedFare }));
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'FARE_CHANGED', details: { expectedFare, fare: q.fare, rideClass: 'ECONOMY', currencyCode: 'GYD' } });
    }
    const notWhole = await requestRide(customer.token, trip([S1], { expectedFare: q.fare + 0.5 }));
    expect([notWhole.statusCode, notWhole.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(await writesOf(customer)).toEqual(NOTHING);
  });

  it('the quoted-fare check comes before the account gates: it is the request\'s own fault, judged before anything is read', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const noSelfie = await makeCustomer({ selfieCapturedAt: null });
    const res = await requestRide(noSelfie.token, trip([S1]));
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'EXPECTED_FARE_REQUIRED']);
    // With the fare it reaches the gate it always reached.
    const gated = await requestRide(noSelfie.token, trip([S1], { expectedFare: 2000 }));
    expect([gated.statusCode, gated.json().error.code]).toEqual([403, 'SELFIE_REQUIRED']);
  });

  it('the routing engine down: 503 ROUTE_UNAVAILABLE, never a guessed fare, nothing written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const customer = await makeCustomer();
    const res = await requestRide(customer.token, trip([S1], { expectedFare: 2000 }), undefined, osrmApp);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'ROUTE_UNAVAILABLE', details: { stopCount: 1 } });
    expect(await writesOf(customer)).toEqual(NOTHING);
  });

  it('the queue holds no trip with stops: 409 MULTI_STOP_QUEUE_UNSUPPORTED, no entry; without stops it joins as today', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const refused = await call(app, 'POST', '/api/v1/rides/queue/join', customer.token, trip([S1]));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'MULTI_STOP_QUEUE_UNSUPPORTED', details: { stopCount: 1 } });
    expect(await sys(() => app.prisma.rideQueueEntry.count({ where: { customerId: customer.userId } }))).toBe(0);
    for (const noStops of [undefined, null, []]) {
      const joined = await call(app, 'POST', '/api/v1/rides/queue/join', customer.token, trip(noStops));
      expect(joined.statusCode, joined.body).toBe(201);
    }
    await call(app, 'POST', '/api/v1/rides/queue/leave', customer.token, {});
  });
});

// ===========================================================================
describe('the Idempotency-Key, the checkout way', () => {
  it('same key, same request: ONE ride; the replay is the first answer field for field (201, replayed), with the ride\'s PIN', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1, S2]);
    const key = `ride-${nanoid(12)}`;
    const first = await requestRide(customer.token, trip([S1, S2], { expectedFare: q.fare }), key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).not.toHaveProperty('replayed');
    const again = await requestRide(customer.token, trip([S1, S2], { expectedFare: q.fare }), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toEqual({ ...first.json(), replayed: true });
    expect(await writesOf(customer)).toEqual({ orders: 1, stops: 2, receipts: 1 });
    // The receipt holds the answer, never the PIN.
    const receipt = await sys(() => app.prisma.checkoutReceipt.findFirstOrThrow({ where: { userId: customer.userId } }));
    expect(JSON.stringify(receipt.result)).not.toContain(first.json().data.ride.ridePin);
    expect(receipt.orderIds).toEqual([first.json().data.ride.id]);
  });

  it('same key, a different request: 422 IDEMPOTENCY_KEY_REUSED, never the first ride\'s answer, nothing new written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1]);
    const key = `ride-${nanoid(12)}`;
    expect((await requestRide(customer.token, trip([S1], { expectedFare: q.fare }), key)).statusCode).toBe(201);
    const q2 = await quote(customer.token, [S2]);
    const other = await requestRide(customer.token, trip([S2], { expectedFare: q2.fare }), key);
    expect(other.statusCode, other.body).toBe(422);
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await writesOf(customer)).toEqual({ orders: 1, stops: 1, receipts: 1 });
  });

  it('a refused attempt releases its key: after FARE_CHANGED the corrected request under the SAME key books once', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1]);
    const key = `ride-${nanoid(12)}`;
    const stale = await requestRide(customer.token, trip([S1], { expectedFare: q.fare - 100 }), key);
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'FARE_CHANGED']);
    expect(await claimKeysOf(customer.userId)).toEqual([]);
    const corrected = await requestRide(customer.token, trip([S1], { expectedFare: q.fare }), key);
    expect(corrected.statusCode, corrected.body).toBe(201);
    expect(await writesOf(customer)).toEqual({ orders: 1, stops: 1, receipts: 1 });
  });

  it('a key already in flight: 409 DUPLICATE_REQUEST and nothing written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1]);
    const key = `ride-${nanoid(12)}`;
    const { rideRequestClaimKey } = await import('../modules/rides/rides.service');
    await app.redis.set(rideRequestClaimKey(customer.userId, key), `IN_FLIGHT:${nanoid(8)}`, 'EX', 60);
    const res = await requestRide(customer.token, trip([S1], { expectedFare: q.fare }), key);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_REQUEST');
    expect(await writesOf(customer)).toEqual(NOTHING);
    await app.redis.del(rideRequestClaimKey(customer.userId, key));
  });

  it('Redis forgot: the durable receipt still answers the replay, and even after the ride ended the key never books a second one', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1]);
    const key = `ride-${nanoid(12)}`;
    const body = trip([S1], { expectedFare: q.fare });
    const first = await requestRide(customer.token, body, key);
    expect(first.statusCode, first.body).toBe(201);
    const { rideRequestClaimKey } = await import('../modules/rides/rides.service');
    await app.redis.del(rideRequestClaimKey(customer.userId, key));
    const replay = await requestRide(customer.token, body, key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    // The ride ends (cancelled), so one-live-ride no longer stands in the way: the receipt alone does.
    expect((await call(app, 'POST', `/api/v1/rides/${first.json().data.ride.id}/cancel`, customer.token, {})).statusCode).toBe(200);
    await app.redis.del(rideRequestClaimKey(customer.userId, key));
    const late = await requestRide(customer.token, body, key);
    expect(late.statusCode, late.body).toBe(201);
    expect(late.json().data.ride.id).toBe(first.json().data.ride.id);
    expect(late.json().replayed).toBe(true);
    expect(await writesOf(customer)).toEqual({ orders: 1, stops: 1, receipts: 1 });
  });

  it('a ride without stops honours the key the same way, and a ride without a key keeps today\'s answer', async () => {
    const customer = await makeCustomer();
    const key = `ride-${nanoid(12)}`;
    const first = await requestRide(customer.token, trip(), key);
    expect(first.statusCode, first.body).toBe(201);
    const again = await requestRide(customer.token, trip(), key);
    expect(again.json()).toEqual({ ...first.json(), replayed: true });
    // Without a key, the live ride answers exactly as it always has.
    const unkeyed = await requestRide(customer.token, trip());
    expect([unkeyed.statusCode, unkeyed.json().error.code]).toEqual([409, 'RIDE_IN_PROGRESS']);
    expect(await writesOf(customer)).toEqual({ orders: 1, stops: 0, receipts: 1 });
  });
});

// ===========================================================================
describe('the reads carry the stops, in order', () => {
  it('the offer card, the card rebuilt after an app restart, the board, both live rides — and a ride without stops gains no key anywhere', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const driver = await makeDriver(PICKUP);
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1, S2, S3]);
    emitted.length = 0;
    const res = await requestRide(customer.token, trip([S1, S2, S3], { expectedFare: q.fare }), `read-${nanoid(10)}`);
    expect(res.statusCode, res.body).toBe(201);
    const rideId = res.json().data.ride.id as string;
    const preview = [
      { sequence: 1, address: S1.address, lat: S1.lat, lng: S1.lng },
      { sequence: 2, address: S2.address, lat: S2.lat, lng: S2.lng },
      { sequence: 3, address: S3.address, lat: S3.lat, lng: S3.lng },
    ];

    // The live card (socket), as the app receives it.
    const live = emitted.filter((e) => e.event === 'dispatch:offer' && e.room === `user:${driver.userId}`).at(-1);
    expect(live, 'the nearest driver was offered the ride').toBeTruthy();
    const card = JSON.parse(JSON.stringify(live!.payload));
    expect(card).toMatchObject({ orderId: rideId, stopCount: 3, stops: preview });
    expect(Object.keys(card)).toEqual([...LIVE_OFFER_KEYS, 'stopCount', 'stops']);

    // The card rebuilt after the app died: the same stops.
    const recovered = await call(app, 'GET', '/api/v1/driver/offers/current', driver.token);
    expect(recovered.statusCode, recovered.body).toBe(200);
    const offer = recovered.json().data.offer;
    expect(offer).toMatchObject({ orderId: rideId, offerAttemptId: card.offerAttemptId, stopCount: 3, stops: preview });
    expect(Object.keys(offer)).toEqual([...RECOVERED_OFFER_KEYS, 'stopCount', 'stops']);
    // A server restart loses nothing either: a fresh instance (its own dispatch
    // service, its own Redis connection) rebuilds the same card from the ride.
    restarted = await buildApp();
    const afterRestart = await call(restarted, 'GET', '/api/v1/driver/offers/current', driver.token);
    expect(afterRestart.json().data.offer).toMatchObject({ orderId: rideId, offerAttemptId: card.offerAttemptId, stopCount: 3, stops: preview });

    // The open board.
    const board = await call(app, 'GET', '/api/v1/driver/rides/available', driver.token);
    const item = (board.json().data as { id: string }[]).find((r) => r.id === rideId);
    const coarseStops = [S1, S2, S3].map((s, i) => ({ sequence: i + 1, lat: Math.round(s.lat / 0.003) * 0.003, lng: Math.round(s.lng / 0.003) * 0.003 }));
    expect(item).toMatchObject({ stopCount: 3, stops: coarseStops, dropoffLat: Math.round(DEST.lat / 0.003) * 0.003, dropoffLng: Math.round(DEST.lng / 0.003) * 0.003, fareTotal: q.fare });
    expect(item).not.toHaveProperty('pickupAddress');
    expect(item).not.toHaveProperty('dropoffAddress');
    expect(Object.keys((item as { customer: object }).customer)).toEqual(['displayRating']);
    expect(Object.keys(item!)).toEqual([...BOARD_ITEM_KEYS, 'stopCount', 'stops']);

    // Accepted from the card.
    const accept = await call(app, 'POST', '/api/v1/driver/offers/accept', driver.token, { orderId: rideId, offerAttemptId: card.offerAttemptId });
    expect(accept.statusCode, accept.body).toBe(200);

    const progress = [S1, S2, S3].map((s, i) => ({
      sequence: i + 1, address: s.address, lat: s.lat, lng: s.lng, status: 'PENDING',
      legMeters: q.legs[i]!.meters, legSeconds: null, arrivedAt: null, departedAt: null, skippedAt: null, skipReason: null,
    }));
    const riderActive = await call(app, 'GET', '/api/v1/rides/active', customer.token);
    expect(riderActive.json().data).toMatchObject({ id: rideId, status: 'DRIVER_ASSIGNED', taxiStopCount: 3, nextStopSequence: 1, stops: progress });
    const riderOne = await call(app, 'GET', `/api/v1/rides/${rideId}`, customer.token);
    expect(riderOne.json().data).toMatchObject({ id: rideId, taxiStopCount: 3, nextStopSequence: 1, stops: progress });
    const driverActive = await call(app, 'GET', '/api/v1/driver/rides/active', driver.token);
    expect(driverActive.json().data).toMatchObject({ id: rideId, taxiStopCount: 3, nextStopSequence: 1, stops: progress });
    expect(driverActive.json().data).not.toHaveProperty('ridePin');
    for (const stop of riderActive.json().data.stops as Record<string, unknown>[]) {
      expect(Object.keys(stop)).toEqual(['sequence', 'address', 'lat', 'lng', 'status', 'legMeters', 'legSeconds', 'arrivedAt', 'departedAt', 'skippedAt', 'skipReason']);
    }

    // As the ride moves, the next stop moves with it (the stop endpoints are part 4; the rows move here).
    const at = new Date();
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 1 }, data: { status: 'DEPARTED', arrivedAt: at, departedAt: at } }));
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 2 }, data: { status: 'ARRIVED', arrivedAt: at } }));
    const moving = (await call(app, 'GET', '/api/v1/rides/active', customer.token)).json().data;
    expect(moving.nextStopSequence).toBe(2);
    expect(moving.stops.map((s: { status: string }) => s.status)).toEqual(['DEPARTED', 'ARRIVED', 'PENDING']);
    expect((await call(app, 'GET', '/api/v1/driver/rides/active', driver.token)).json().data.nextStopSequence).toBe(2);
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 2 }, data: { status: 'DEPARTED', departedAt: at } }));
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 3 }, data: { status: 'SKIPPED', skippedAt: at, skipReason: 'Road closed' } }));
    const done = (await call(app, 'GET', `/api/v1/rides/${rideId}`, customer.token)).json().data;
    expect(done.nextStopSequence).toBeNull();
    expect(done.stops[2]).toMatchObject({ status: 'SKIPPED', skipReason: 'Road closed' });

    // The same driver, a ride WITHOUT stops: no stop key on any surface.
    await sys(() => app.prisma.order.update({ where: { id: rideId }, data: { status: 'CANCELLED', cancelledAt: new Date() } }));
    await sys(() => app.prisma.driver.update({ where: { id: driver.driverId }, data: { isAvailable: true, currentRideId: null } }));
    const plainCustomer = await makeCustomer();
    emitted.length = 0;
    const plain = await requestRide(plainCustomer.token, trip());
    expect(plain.statusCode, plain.body).toBe(201);
    const plainId = plain.json().data.ride.id as string;
    const plainLive = emitted.filter((e) => e.event === 'dispatch:offer' && e.room === `user:${driver.userId}`).at(-1);
    const plainCard = JSON.parse(JSON.stringify(plainLive!.payload));
    expect(Object.keys(plainCard)).toEqual(LIVE_OFFER_KEYS);
    const plainOffer = (await call(app, 'GET', '/api/v1/driver/offers/current', driver.token)).json().data.offer;
    expect(Object.keys(plainOffer)).toEqual(RECOVERED_OFFER_KEYS);
    const plainItem = ((await call(app, 'GET', '/api/v1/driver/rides/available', driver.token)).json().data as { id: string }[]).find((r) => r.id === plainId);
    expect(Object.keys(plainItem!)).toEqual(BOARD_ITEM_KEYS);
    expect((await call(app, 'POST', '/api/v1/driver/offers/accept', driver.token, { orderId: plainId, offerAttemptId: plainCard.offerAttemptId })).statusCode).toBe(200);
    for (const payload of [
      (await call(app, 'GET', '/api/v1/rides/active', plainCustomer.token)).json().data,
      (await call(app, 'GET', `/api/v1/rides/${plainId}`, plainCustomer.token)).json().data,
      (await call(app, 'GET', '/api/v1/driver/rides/active', driver.token)).json().data,
    ]) {
      expect(payload.id).toBe(plainId);
      expect(payload.taxiStopCount).toBeNull();
      for (const key of STOP_KEYS) expect(payload).not.toHaveProperty(key);
    }
    await sys(() => app.prisma.order.update({ where: { id: plainId }, data: { status: 'CANCELLED', cancelledAt: new Date() } }));
    await sys(() => app.prisma.driver.update({ where: { id: driver.driverId }, data: { isOnline: false, isAvailable: false, currentRideId: null } }));
  });
});

// ===========================================================================
describe('the order is never DELIVERED while a stop is open', () => {
  it('"Fare collected" with an open stop: 409 STOPS_REMAINING naming the next stop, nothing written; the generic transition refuses too; once every stop is done it completes', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const driver = await makeDriver(PICKUP);
    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1, S2]);
    emitted.length = 0;
    const res = await requestRide(customer.token, trip([S1, S2], { expectedFare: q.fare }));
    expect(res.statusCode, res.body).toBe(201);
    const rideId = res.json().data.ride.id as string;
    const pin = res.json().data.ride.ridePin as string;
    expect((await call(app, 'POST', `/api/v1/driver/rides/${rideId}/accept`, driver.token, {})).statusCode).toBe(200);
    for (const leg of ['en-route', 'arrived']) {
      const r = await call(app, 'PUT', `/api/v1/driver/rides/${rideId}/${leg}`, driver.token, {});
      expect(r.statusCode, `${leg}: ${r.body}`).toBe(200);
    }
    expect((await call(app, 'PUT', `/api/v1/driver/rides/${rideId}/verify-pin`, driver.token, { pin })).statusCode).toBe(200);
    expect((await call(app, 'PUT', `/api/v1/driver/rides/${rideId}/start`, driver.token, {})).statusCode).toBe(200);

    const paid = () => call(app, 'POST', `/api/v1/driver/rides/${rideId}/handover`, driver.token, { outcome: 'paid', gps: DEST });
    const before = await paid();
    expect(before.statusCode, before.body).toBe(409);
    expect(before.json().error).toMatchObject({ code: 'STOPS_REMAINING', details: { nextStopSequence: 1 } });
    const still = await rideRow(rideId);
    expect({ status: still.status, pay: still.paymentStatus }).toEqual({ status: 'RIDE_IN_PROGRESS', pay: 'PENDING' });
    expect(await sys(() => app.prisma.earning.count({ where: { orderId: rideId } }))).toBe(0);
    expect((await sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }))).currentRideId).toBe(rideId);

    // Any caller of the canonical transition, not only the driver's route.
    const orders = new OrderService(app.prisma, app.io, undefined, undefined, app.redis);
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 1 }, data: { status: 'DEPARTED', departedAt: new Date() } }));
    await expect(sys(() => orders.updateStatus(rideId, 'DELIVERED', driver.userId, 'generic close')))
      .rejects.toMatchObject({ statusCode: 409, code: 'STOPS_REMAINING', details: { nextStopSequence: 2 } });
    expect((await rideRow(rideId)).status).toBe('RIDE_IN_PROGRESS');

    // An ARRIVED stop is still open (the passenger may be out of the car).
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 2 }, data: { status: 'ARRIVED', arrivedAt: new Date() } }));
    expect((await paid()).json().error).toMatchObject({ code: 'STOPS_REMAINING', details: { nextStopSequence: 2 } });

    // Every stop resolved (departed or skipped): the fare outcome completes the ride as it always has.
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 2 }, data: { status: 'SKIPPED', skippedAt: new Date(), skipReason: 'Passenger changed plans' } }));
    const after = await paid();
    expect(after.statusCode, after.body).toBe(200);
    const closed = await rideRow(rideId);
    expect({ status: closed.status, pay: closed.paymentStatus, fare: Number(closed.taxiFareTotal) }).toEqual({ status: 'DELIVERED', pay: 'CAPTURED', fare: q.fare });
    await sys(() => app.prisma.driver.update({ where: { id: driver.driverId }, data: { isOnline: false, isAvailable: false } }));
  });
});

// ===========================================================================
describe('another operator\'s people never see a ride\'s stops', () => {
  it('another tenant\'s customer cannot read it, another tenant\'s driver never sees or takes it, and its own tenant\'s stops carry its tenant', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const other = await sys(() => app.prisma.tenant.create({ data: { name: 'Stops Other Operator', slug: `stops-other-${nanoid(6).toLowerCase()}`, isActive: false } }));
    tenantIds.push(other.id);
    const foreignDriver = await makeDriver(PICKUP, { tenantId: other.id });
    const foreignCustomer = await makeCustomer({ tenantId: other.id });

    const customer = await makeCustomer();
    const q = await quote(customer.token, [S1, S2]);
    const res = await requestRide(customer.token, trip([S1, S2], { expectedFare: q.fare }));
    expect(res.statusCode, res.body).toBe(201);
    const rideId = res.json().data.ride.id as string;

    const read = await call(app, 'GET', `/api/v1/rides/${rideId}`, foreignCustomer.token);
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain(S1.address);
    const board = await call(app, 'GET', '/api/v1/driver/rides/available', foreignDriver.token);
    expect(board.statusCode).toBe(200);
    expect(board.body).not.toContain(rideId);
    expect(board.body).not.toContain(S1.address);
    const take = await call(app, 'POST', `/api/v1/driver/rides/${rideId}/accept`, foreignDriver.token, {});
    expect(take.statusCode).toBe(404);
    expect((await call(app, 'GET', '/api/v1/driver/offers/current', foreignDriver.token)).json().data.offer).toBeNull();

    // The stop read itself is walled: under the other tenant it finds nothing.
    const { loadTaxiStops } = await import('../modules/rides/taxi-stops-read');
    expect((await runWithTenant(other.id, () => loadTaxiStops(app.prisma, [rideId]))).size).toBe(0);
    expect((await runWithTenant('swift-default', () => loadTaxiStops(app.prisma, [rideId]))).get(rideId)?.length).toBe(2);

    // A ride booked inside the other operator is that operator's, stops and all.
    const fq = await quote(foreignCustomer.token, [S1]);
    const foreignRide = await requestRide(foreignCustomer.token, trip([S1], { expectedFare: fq.fare }));
    expect(foreignRide.statusCode, foreignRide.body).toBe(201);
    const foreignRow = await rideRow(foreignRide.json().data.ride.id);
    expect(foreignRow.tenantId).toBe(other.id);
    expect(foreignRow.taxiStops.map((s) => s.tenantId)).toEqual([other.id]);
    expect((await call(app, 'GET', `/api/v1/rides/${foreignRow.id}`, customer.token)).statusCode).toBe(404);
    await sys(() => app.prisma.driver.update({ where: { id: foreignDriver.driverId }, data: { isOnline: false, isAvailable: false } }));
  });
});
