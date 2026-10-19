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
import { orderSocketFixture } from './helpers/order-socket-fixture';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 4/8] The driver moves the ride through its stops, through
// the real routes, the real dispatch and the real fare outcome
// (CONTRACT.md §6.1, §6.3, §6.4).
//
//  - Only a driver app that declared it can run stops (go-online
//    capabilities ['TAXI_STOPS_V1']) is offered, shown or given a ride with
//    stops; a forged or stale accept answers 409 APP_UPDATE_REQUIRED and
//    writes nothing. A ride without stops goes to every driver, as today.
//  - Arrive, depart and skip: only the ride's own driver, only during the
//    trip, only the next open stop, on the server clock, safe to repeat; the
//    order room hears each change, and the passenger is told of a skip.
//  - The trip ends unpaid at a stop only after the 10-minute grace at an
//    arrived stop (the passenger did not come back); before that, or while
//    heading for a stop, it is refused with nothing written.
//
// The interior near Iwokrama (no fare zone, no other suite's fixtures). The
// phones are retained-evidence numbers (a failed fare's filing is kept).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const MIN = 60_000;
const PHONE_PREFIX = retainedPhonePrefix('43');
const FIXTURE = 'taxi-multistop-driver';

const PICKUP = { lat: 4.4, lng: -58.6 };
const DEST = { lat: 4.412, lng: -58.607 };
const S1 = { lat: 4.406, lng: -58.595, address: 'Iwokrama Field Station' };
const S2 = { lat: 4.394, lng: -58.587, address: 'Fairview Landing' };
const PICKUP_ADDRESS = 'Iwokrama River Lodge';
const DROPOFF_ADDRESS = 'Iwokrama Airstrip';

let app: FastifyInstance;
let seq = 0;
const emitted: { room: string; event: string; payload: unknown }[] = [];
const socketCleanup: Array<() => void> = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type DriverActor = Actor & { driverId: string };
type Point = { lat: number; lng: number };
type Stop = Point & { address: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Itinerary',
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
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `itinerary-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

const makeCustomer = () => makeUser(['CUSTOMER'], 'CUSTOMER');

/** An online, free, freshly located taxi driver who owns their GO session;
 *  `stops` = whether their app declared it can run a ride's stops. */
async function makeDriver(at: Point, stops: boolean): Promise<DriverActor> {
  const u = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'White',
      licensePlate: `HT ${5000 + seq}`, driverLicenseUrl: 'storage://itinerary/dl.jpg', vehicleInsuranceUrl: 'storage://itinerary/ins.jpg',
      vehiclePhotoUrl: 'https://cdn.test/allion.jpg', documentsVerified: true,
      isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(),
      averageRating: 4.9, acceptanceRate: 90, taxiStopsCapable: stops,
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

const trip = (stops: readonly Stop[], expectedFare?: number) => ({
  pickup: PICKUP, dropoff: DEST, pickupAddress: PICKUP_ADDRESS, dropoffAddress: DROPOFF_ADDRESS,
  passengerCount: 1, rideClass: 'ECONOMY',
  ...(stops.length > 0 ? { stops, expectedFare } : {}),
});

/** Books a ride (with its quoted whole-route fare when it has stops). */
async function book(customer: Actor, stops: readonly Stop[]) {
  let fare: number | undefined;
  if (stops.length > 0) {
    const q = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST, stops });
    expect(q.statusCode, q.body).toBe(200);
    fare = (q.json().data.tiers as { rideClass: string; fare: number }[]).find((t) => t.rideClass === 'ECONOMY')!.fare;
  }
  const res = await call('POST', '/api/v1/rides/request', customer.token, trip(stops, fare));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.ride as { id: string; ridePin: string };
}

/** The ride taken by `driver` and driven to the trip (the passenger aboard). */
async function startedRide(driver: DriverActor, customer: Actor, stops: readonly Stop[]) {
  const ride = await book(customer, stops);
  const accept = await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, driver.token, {});
  expect(accept.statusCode, accept.body).toBe(200);
  for (const leg of ['en-route', 'arrived']) {
    const r = await call('PUT', `/api/v1/driver/rides/${ride.id}/${leg}`, driver.token, {});
    expect(r.statusCode, `${leg}: ${r.body}`).toBe(200);
  }
  expect((await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin })).statusCode).toBe(200);
  const order = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ride.id }, select: { id: true, customerId: true, tenantId: true } }));
  socketCleanup.push(orderSocketFixture(app.io, order, (event, payload) => { emitted.push({ room: `order:${order.id}`, event, payload }); }));
  return ride.id;
}

const start = async (driver: DriverActor, rideId: string) => {
  const r = await call('PUT', `/api/v1/driver/rides/${rideId}/start`, driver.token, {});
  expect(r.statusCode, r.body).toBe(200);
};

const stopAction = (driver: Actor, rideId: string, sequence: number | string, action: 'arrived' | 'depart' | 'skip', body?: unknown) =>
  call(action === 'skip' ? 'POST' : 'PUT', `/api/v1/driver/rides/${rideId}/stops/${sequence}/${action}`, driver.token, body ?? {});

const stopRows = (orderId: string) => sys(() => app.prisma.taxiTripStop.findMany({ where: { orderId }, orderBy: { sequence: 'asc' } }));
const rideRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const stopEvents = (orderId: string) => emitted.filter((e) => e.room === `order:${orderId}` && e.event === 'ride:stop_changed').map((e) => e.payload);

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
      // [SAFE-B · retained history] A failed fare's filing keeps its ride and the
      // people it names; the rest goes, and what stays is taken out of service.
      const kept = await retainedCohort(tx, { orderIds: allOids });
      const oids = without(allOids, kept.orderIds);
      const goneIds = without(ids, kept.userIds);
      await tx.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: allOids } }, { recipientId: { in: ids } }] } });
      await tx.algoDecision.deleteMany({ where: { subjectId: { in: [...allOids, ...driverIds] } } });
      await tx.dispatchSearch.deleteMany({ where: { subjectId: { in: allOids } } });
      if (allOids.length > 0) await tx.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(allOids)})`;
      await tx.notification.deleteMany({ where: { userId: { in: ids } } });
      await tx.reimbursementClaim.deleteMany({ where: { orderId: { in: oids } } });
      await tx.strike.deleteMany({ where: { orderId: { in: oids } } });
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
  // Record every room emission made through io.to (the offer card's event and room).
  const realTo = app.io.to.bind(app.io);
  (app.io as { to: (room: string) => unknown }).to = (room: string) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ room, event, payload });
      return realTo(room).emit(event, payload);
    },
  });
});

afterAll(async () => {
  for (const dispose of socketCleanup) dispose();
  await purgeFixtures();
  await app.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await allOffline();
});

// ===========================================================================
describe('the app says what it can run, on every go-online', () => {
  it('capabilities [TAXI_STOPS_V1] marks the driver able to run stops; an older app going online clears it; a malformed list is nothing declared, never a refusal', async () => {
    const d = await makeDriver(PICKUP, false);
    await sys(() => app.prisma.subscription.create({
      data: {
        driverId: d.driverId, type: 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 12000,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
      },
    }));
    const goOnline = async (body: Record<string, unknown>) => {
      await sys(() => app.prisma.driver.update({ where: { id: d.driverId }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
      const res = await call('POST', '/api/v1/driver/go-online', d.token, { latitude: PICKUP.lat, longitude: PICKUP.lng, ...body });
      expect(res.statusCode, res.body).toBe(200);
      const row = await sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId }, select: { isOnline: true, taxiStopsCapable: true } }));
      expect(row.isOnline).toBe(true);
      return row.taxiStopsCapable;
    };
    expect(await goOnline({ capabilities: ['TAXI_STOPS_V1'] })).toBe(true);
    expect(await goOnline({}), 'an app from before the stops').toBe(false);
    expect(await goOnline({ capabilities: ['SOMETHING_ELSE', 'TAXI_STOPS_V1'] })).toBe(true);
    expect(await goOnline({ capabilities: 'TAXI_STOPS_V1' }), 'not a list').toBe(false);
    expect(await goOnline({ capabilities: [42] }), 'not strings').toBe(false);
  });
});

// ===========================================================================
describe('a ride with stops goes only to an app that can run them', () => {
  it('the live offer skips a nearer driver whose app cannot run stops and goes to one whose app can; the board shows it only to that app; a ride without stops still goes to the nearest', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const older = await makeDriver({ lat: PICKUP.lat + 0.001, lng: PICKUP.lng }, false);
    const newer = await makeDriver({ lat: PICKUP.lat + 0.01, lng: PICKUP.lng }, true);
    const customer = await makeCustomer();
    emitted.length = 0;
    const ride = await book(customer, [S1, S2]);
    const offersTo = (d: Actor, id: string) => emitted.filter((e) => e.event === 'dispatch:offer' && e.room === `user:${d.userId}`
      && (e.payload as { orderId?: string }).orderId === id);
    expect(offersTo(newer, ride.id), 'the driver whose app runs stops is offered the ride').toHaveLength(1);
    expect(offersTo(older, ride.id), 'the nearer, older app is never offered it').toHaveLength(0);
    const boardOf = async (d: Actor) => ((await call('GET', '/api/v1/driver/rides/available', d.token)).json().data as { id: string }[]).map((r) => r.id);
    expect(await boardOf(newer)).toContain(ride.id);
    expect(await boardOf(older)).not.toContain(ride.id);

    // The same two drivers, a ride without stops: the nearest is offered it, as today.
    const plainCustomer = await makeCustomer();
    emitted.length = 0;
    const plain = await book(plainCustomer, []);
    expect(offersTo(older, plain.id)).toHaveLength(1);
    expect(await boardOf(older)).toContain(plain.id);
  });

  it('a forged or stale accept from an app that cannot run stops: 409 APP_UPDATE_REQUIRED, and nothing is written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const older = await makeDriver(PICKUP, false);
    const customer = await makeCustomer();
    const ride = await book(customer, [S1]);
    const res = await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, older.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('APP_UPDATE_REQUIRED');
    const row = await rideRow(ride.id);
    expect({ status: row.status, driverId: row.driverId }).toEqual({ status: 'PENDING', driverId: null });
    const driver = await sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id: older.driverId }, select: { isAvailable: true, currentRideId: true } }));
    expect(driver).toEqual({ isAvailable: true, currentRideId: null });
    // Once the app can (it went online again with the capability), the same accept takes it.
    await sys(() => app.prisma.driver.update({ where: { id: older.driverId }, data: { taxiStopsCapable: true } }));
    const again = await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, older.token, {});
    expect(again.statusCode, again.body).toBe(200);
    expect((await rideRow(ride.id)).driverId).toBe(older.driverId);
  });
});

// ===========================================================================
describe('the driver moves the ride through its stops', () => {
  it('only during the trip, only the ride\'s own driver, only the next open stop; arrive → depart → skip on the server clock, each told to the order room, repeats safe, the passenger told of a skip', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const driver = await makeDriver(PICKUP, true);
    const stranger = await makeDriver({ lat: PICKUP.lat - 0.05, lng: PICKUP.lng }, true);
    const customer = await makeCustomer();
    const rideId = await startedRide(driver, customer, [S1, S2]);

    // The passenger is not aboard yet (DRIVER_ARRIVED): no stop moves.
    const early = await stopAction(driver, rideId, 1, 'arrived');
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.code).toBe('INVALID_STATUS');
    await start(driver, rideId);

    // Shape and ownership.
    expect((await stopAction(driver, rideId, 4, 'arrived')).statusCode, 'a stop number past the cap is malformed').toBe(400);
    const missing = await stopAction(driver, rideId, 3, 'arrived');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code: 'STOP_NOT_FOUND', details: { sequence: 3 } });
    expect((await stopAction(stranger, rideId, 1, 'arrived')).statusCode, 'another driver').toBe(404);
    // The passenger's order, and the stop law.
    const outOfOrder = await stopAction(driver, rideId, 2, 'arrived');
    expect(outOfOrder.statusCode).toBe(409);
    expect(outOfOrder.json().error).toMatchObject({ code: 'STOP_OUT_OF_ORDER', details: { sequence: 2, nextStopSequence: 1 } });
    const leaveFirst = await stopAction(driver, rideId, 1, 'depart');
    expect(leaveFirst.statusCode).toBe(409);
    expect(leaveFirst.json().error.code).toBe('STOP_NOT_ARRIVED');
    expect((await stopRows(rideId)).map((s) => s.status), 'nothing refused was written').toEqual(['PENDING', 'PENDING']);
    expect(stopEvents(rideId)).toEqual([]);

    // Arrive at stop 1: the server's clock, the evidence note, the grace clock.
    // The car is at the stop (a fresh fix ~40 m away): the arrival is verified.
    await sys(() => app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentLat: S1.lat + 0.0003, currentLng: S1.lng, lastLocationUpdate: new Date() } }));
    const before = Date.now();
    const arrive = await stopAction(driver, rideId, 1, 'arrived');
    expect(arrive.statusCode, arrive.body).toBe(200);
    const a = arrive.json();
    expect(a.replayed).toBe(false);
    expect(a.data).toMatchObject({ orderId: rideId, nextStopSequence: 1, stop: { sequence: 1, status: 'ARRIVED', address: S1.address } });
    const arrivedAt = new Date(a.data.stop.arrivedAt).getTime();
    expect(arrivedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(a.data.stopWait).toEqual({ sequence: 1, arrivedAt: a.data.stop.arrivedAt, noShowAvailableAt: new Date(arrivedAt + 10 * MIN).toISOString() });
    const [row1] = await stopRows(rideId);
    expect(row1!.actedBy).toBe(driver.userId);
    expect(row1!.evidenceNote).toMatch(/^Driver reported arriving at stop 1 — .* \d+m away, fix \d+s old$/);
    expect(row1!.arrivalVerified, 'a fresh fix within 300 m of the stop').toBe(true);
    expect(stopEvents(rideId)).toEqual([{ orderId: rideId, sequence: 1, status: 'ARRIVED', nextStopSequence: 1 }]);
    // The driver's active ride carries the same grace clock.
    const active = (await call('GET', '/api/v1/driver/rides/active', driver.token)).json().data;
    expect(active.stopWait).toEqual(a.data.stopWait);

    // A repeated tap: answered as it is, nothing written, nothing announced.
    const repeat = await stopAction(driver, rideId, 1, 'arrived');
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({ replayed: true, data: { stop: { status: 'ARRIVED', arrivedAt: a.data.stop.arrivedAt } } });
    expect(stopEvents(rideId)).toHaveLength(1);

    // Depart: the next stop is 2, no grace clock while driving.
    const depart = await stopAction(driver, rideId, 1, 'depart');
    expect(depart.statusCode, depart.body).toBe(200);
    expect(depart.json().data).toMatchObject({ nextStopSequence: 2, stopWait: null, stop: { status: 'DEPARTED' } });
    expect(depart.json().data.stop.departedAt).not.toBeNull();
    expect((await stopAction(driver, rideId, 1, 'arrived')).json().replayed, 'a late arrival tap on a left stop').toBe(true);
    const reopen = await stopAction(driver, rideId, 1, 'skip', { reason: 'Passenger changed plans' });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error.code).toBe('STOP_ALREADY_RESOLVED');
    expect((await call('GET', '/api/v1/driver/rides/active', driver.token)).json().data).toMatchObject({ nextStopSequence: 2, stopWait: null });

    // Skip stop 2: a reason is required, the passenger is told it, the destination is next.
    expect((await stopAction(driver, rideId, 2, 'skip', {})).statusCode, 'no reason').toBe(400);
    // The reason is sent to the passenger word for word: never a phone number, a link or abuse.
    const contact = await stopAction(driver, rideId, 2, 'skip', { reason: 'Call me on 600 1234 instead' });
    expect(contact.statusCode).toBe(400);
    expect(contact.json().error).toMatchObject({ code: 'SKIP_REASON_REFUSED', details: { reason: 'PHONE' } });
    expect((await stopRows(rideId)).map((s) => s.status), 'a refused reason writes nothing').toEqual(['DEPARTED', 'PENDING']);
    const skip = await stopAction(driver, rideId, 2, 'skip', { reason: 'Road flooded at the landing' });
    expect(skip.statusCode, skip.body).toBe(200);
    expect(skip.json().data).toMatchObject({ nextStopSequence: null, stopWait: null, stop: { sequence: 2, status: 'SKIPPED', skipReason: 'Road flooded at the landing' } });
    expect(stopEvents(rideId)).toEqual([
      { orderId: rideId, sequence: 1, status: 'ARRIVED', nextStopSequence: 1 },
      { orderId: rideId, sequence: 1, status: 'DEPARTED', nextStopSequence: 2 },
      { orderId: rideId, sequence: 2, status: 'SKIPPED', nextStopSequence: null },
    ]);
    const notice = await sys(() => app.prisma.notification.findFirst({ where: { userId: customer.userId, title: 'Stop 2 skipped' } }));
    expect(notice?.body).toContain('Road flooded at the landing');
    expect((await stopRows(rideId)).map((s) => s.status)).toEqual(['DEPARTED', 'SKIPPED']);
    // The passenger's ride shows the same.
    expect((await call('GET', '/api/v1/rides/active', customer.token)).json().data).toMatchObject({ nextStopSequence: null });

    // Every stop done: "Fare collected" completes the ride as it always has.
    const paid = await call('POST', `/api/v1/driver/rides/${rideId}/handover`, driver.token, { outcome: 'paid', gps: DEST });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await rideRow(rideId)).status).toBe('DELIVERED');
    // After the trip no stop moves.
    const late = await stopAction(driver, rideId, 2, 'arrived');
    expect(late.statusCode, late.body).toBe(409);
    expect((await stopRows(rideId)).map((s) => s.status)).toEqual(['DEPARTED', 'SKIPPED']);
    expect(stopEvents(rideId)).toHaveLength(3);
  });
});

// ===========================================================================
describe('the passenger did not come back to the car at a stop', () => {
  it('the trip ends unpaid only after the 10-minute grace at an arrived stop (skipping it does not shorten that); before it, or heading for a stop, or a refusal mid-route, nothing is written', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const driver = await makeDriver(PICKUP, true);
    const customer = await makeCustomer();
    const rideId = await startedRide(driver, customer, [S1]);
    await start(driver, rideId);
    const outcome = (o: 'no_show' | 'refused') => call('POST', `/api/v1/driver/rides/${rideId}/handover`, driver.token, { outcome: o, gps: S1 });
    const filings = () => sys(() => app.prisma.cashHandoverEvidence.count({ where: { orderId: rideId } }));
    const unchanged = async () => {
      const row = await rideRow(rideId);
      expect({ status: row.status, pay: row.paymentStatus }).toEqual({ status: 'RIDE_IN_PROGRESS', pay: 'PENDING' });
      expect(await filings()).toBe(0);
    };

    const heading = await outcome('no_show');
    expect(heading.statusCode, heading.body).toBe(409);
    expect(heading.json().error).toMatchObject({ code: 'STOPS_REMAINING', details: { nextStopSequence: 1 } });
    await unchanged();

    const arrive = await stopAction(driver, rideId, 1, 'arrived');
    expect(arrive.statusCode, arrive.body).toBe(200);
    // [option A] The car's fix is at the pickup, ~0.9 km from the stop: the arrival is
    // recorded (never refused) but not verified, so its wait is never charged.
    const [unverified] = await stopRows(rideId);
    expect(unverified!.arrivalVerified).toBe(false);
    expect(unverified!.evidenceNote).toMatch(/ — not verified, so this wait is not charged$/);
    const retryAt = arrive.json().data.stopWait.noShowAvailableAt as string;
    const tooSoon = await outcome('no_show');
    expect(tooSoon.statusCode, tooSoon.body).toBe(409);
    expect(tooSoon.json().error).toMatchObject({ code: 'STOP_WAIT_NOT_ELAPSED', details: { sequence: 1, retryAt } });
    await unchanged();
    const refused = await outcome('refused');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('STOPS_REMAINING');
    await unchanged();

    // Arriving, skipping the stop and reporting the no-show at once does not sidestep the grace.
    const skip = await stopAction(driver, rideId, 1, 'skip', { reason: 'Passenger got out here' });
    expect(skip.statusCode, skip.body).toBe(200);
    const skippedEarly = await outcome('no_show');
    expect(skippedEarly.statusCode, skippedEarly.body).toBe(409);
    expect(skippedEarly.json().error).toMatchObject({ code: 'STOP_WAIT_NOT_ELAPSED', details: { sequence: 1, retryAt } });
    await unchanged();

    // The car has waited the whole grace (its arrival 10 minutes and a second ago).
    await sys(() => app.prisma.taxiTripStop.updateMany({ where: { orderId: rideId, sequence: 1 }, data: { arrivedAt: new Date(Date.now() - 10 * MIN - 1000) } }));
    const ended = await outcome('no_show');
    expect(ended.statusCode, ended.body).toBe(200);
    const row = await rideRow(rideId);
    expect({ status: row.status, pay: row.paymentStatus }).toEqual({ status: 'FAILED', pay: 'FAILED' });
    expect(await filings()).toBe(1);
  });
});
