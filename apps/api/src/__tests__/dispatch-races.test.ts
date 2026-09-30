import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import courierRoutes from '../modules/courier/courier.routes';
import {
  DispatchService,
  makeDispatchService,
  classifyClaimRefusal,
  claimRefusalMarksTheMover,
} from '../modules/dispatch/dispatch.service';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { retireTooOldOrder } from '../modules/dispatch/rescue';
import { LIVE_ORDER_STATUSES } from '../modules/order/order-status';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { AppError } from '../utils/errors';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { dispatchWithdrawnCardKey } from '../modules/dispatch/dispatch-generation-keys';

// ---------------------------------------------------------------------------
// [DISPATCH 1/3] EXACTLY ONE WINNER — proven by racing it.
//
// Owner, 09-24: "if nearby drivers get pinged and one accepts, it stops ringing
// and the others can't accept; make sure nothing bugs here and 2 taxis never go
// to one customer." Plan: swift-coordination/DISPATCH-HARDENING-PLAN-20260924.md.
//
// Every assigning path takes the mover's users row, then the orders row, then
// compare-and-sets the order and the mover. None of that had ever been raced
// through HTTP. This suite does, against the real Postgres and Redis:
//
//   * genuinely parallel requests (Promise.all over app.inject), each race run
//     LOOPS times with fresh people, because one lucky interleaving proves
//     nothing;
//   * a CONTROLLED interleaving wherever timing decides the outcome — one
//     party is held at a named point (the pattern from
//     vendor-self-delivery-terminal.test.ts) while the other finishes, so the
//     losing order of events is exercised every run, not by chance;
//   * the database belt: two partial unique indexes (migration
//     20260925000200_dispatch_single_winner) that refuse a second live ride for
//     one driver and a second live taxi for one customer whatever writes them,
//     and a pin that holds their SQL status list to LIVE_ORDER_STATUSES.
//
// Fixtures: phones +5920771nnnn (no other file uses the block), Lethem, far
// from every other suite, so only this file's movers are ever candidates.
// ---------------------------------------------------------------------------

const LOOPS = 25;
const PHONE_PREFIX = '+5920771';
const FIXTURE = 'dispatch-races-fixture';
const SPOT = { lat: 3.3803, lng: -59.7968 }; // Lethem
const DROP = { lat: 3.3953, lng: -59.7818 };
const DAY = 24 * 60 * 60 * 1000;
const MIGRATION = join(__dirname, '../../prisma/migrations/20260925000200_dispatch_single_winner/migration.sql');
const INDEXES = { driver: 'orders_one_live_taxi_per_driver_key', customer: 'orders_one_live_taxi_per_customer_key' } as const;

let app: FastifyInstance;
let jobs: ReturnType<typeof recordDispatchQueue>;
let dispatch: DispatchService;
let seq = 0;
let vendorId = '';
let capacityRestore: number | null = null;
const userIds: string[] = [];
const driverIds: string[] = [];
const riderIds: string[] = [];
const tenantIds: string[] = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type DriverActor = Actor & { driverId: string };
type RiderActor = Actor & { riderId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`,
      firstName: 'Race',
      lastName: `R${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `race-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

const makeCustomer = () => makeUser(['CUSTOMER'], 'CUSTOMER');

/** A point `meters` north of the spot: nearer is offered first. */
const near = (meters: number) => ({ lat: SPOT.lat + meters / 111_000, lng: SPOT.lng });

/** An online, free, freshly located taxi driver who owns their GO session. */
async function makeDriver(at = SPOT): Promise<DriverActor> {
  const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
      licensePlate: `RACE-${seq}`, driverLicenseUrl: 'storage://race/dl.jpg', vehicleInsuranceUrl: 'storage://race/ins.jpg',
      documentsVerified: true,
      isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(),
      acceptanceRate: 50,
    },
  }));
  driverIds.push(driver.id);
  return { ...u, driverId: driver.id };
}

/** An online, free, freshly located delivery rider with float to spare. */
async function makeRider(at = SPOT): Promise<RiderActor> {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(),
      acceptanceRate: 50,
    },
  }));
  riderIds.push(rider.id);
  return { ...u, riderId: rider.id };
}

/** A hailed taxi waiting for a driver, exactly as the request path writes it. */
function makeTaxi(customer: Actor, at = SPOT) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RACE-T-${nanoid(10)}`, orderType: 'TAXI', customerId: customer.userId, status: 'PENDING',
      pickupAddress: 'Lethem market', pickupLat: at.lat, pickupLng: at.lng,
      deliveryAddress: 'Lethem airstrip', deliveryLat: DROP.lat, deliveryLng: DROP.lng,
      taxiPickupAddress: 'Lethem market', taxiDropoffAddress: 'Lethem airstrip',
      taxiPassengerCount: 1, rideClass: 'ECONOMY', taxiFareTotal: 1500,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500,
      paymentMethod: 'CASH', ridePin: '482915',
    },
  }));
}

/** A cash food order ready at the kitchen, waiting for a rider. */
function makeDelivery(customer: Actor, dropOffset = 0) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RACE-D-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId: customer.userId, vendorId, status: 'READY_FOR_PICKUP',
      pickupAddress: 'Race Kitchen', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Lethem homes', deliveryLat: SPOT.lat + 0.004 + dropOffset, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, paymentMethod: 'CASH',
    },
  }));
}

/** A sender's parcel waiting at the pickup for a courier rider. */
function makeCourier(sender: Actor) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RACE-C-${nanoid(10)}`, orderType: 'COURIER', fulfillment: 'DELIVERY',
      customerId: sender.userId, status: 'READY_FOR_PICKUP',
      pickupAddress: 'Lethem post office', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Lethem school', deliveryLat: SPOT.lat + 0.006, deliveryLng: SPOT.lng + 0.002,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH', courierPayer: 'SENDER', courierPackageSize: 'SMALL', courierTrackingToken: nanoid(16),
    },
  }));
}

function call(method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
  });
}

const acceptCard = (mover: Actor, pool: 'driver' | 'rider', orderId: string, offerAttemptId?: string) =>
  call('POST', `/api/v1/${pool}/offers/accept`, mover.token, { orderId, ...(offerAttemptId ? { offerAttemptId } : {}) });
const grabRide = (driver: Actor, orderId: string) => call('POST', `/api/v1/driver/rides/${orderId}/accept`, driver.token, {});
const grabOrder = (rider: Actor, orderId: string) => call('POST', `/api/v1/rider/orders/${orderId}/accept`, rider.token, {});

/** The live card for an order: whose it is, and which generation. */
async function offerOf(orderId: string): Promise<{ moverId: string; attemptId: string } | null> {
  const raw = await app.redis.get(`dispatch:offer:${orderId}`);
  if (!raw) return null;
  const i = raw.indexOf(':');
  return { moverId: raw.slice(0, i), attemptId: raw.slice(i + 1) };
}

async function offer(orderId: string, expected: string) {
  const live = await offerOf(orderId);
  expect(live?.moverId, `the card for ${orderId} went to the wrong mover`).toBe(expected);
  return live!;
}

const declined = (orderId: string) => app.redis.smembers(`dispatch:declined:${orderId}`);
const expiryLogged = async (moverId: string, orderId: string, attemptId: string) =>
  (await app.redis.zrange(`dispatch:offer-expiries:${moverId}`, 0, -1)).includes(`${orderId}:${attemptId}`);
const cardsScheduledFor = (orderId: string, moverId: string) =>
  jobs.filter((j) => j.name === 'offer-timeout' && j.data.orderId === orderId && j.data.riderId === moverId).length;
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const driverRow = (id: string) => sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id } }));
const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id } }));
const assignmentsOf = (orderId: string, status: 'DRIVER_ASSIGNED' | 'RIDER_ASSIGNED') =>
  sys(() => app.prisma.orderStatusLog.count({ where: { orderId, status } }));

/** Every mover this file made goes offline, so the next race sees only its own. */
async function park() {
  await sys(() => app.prisma.driver.updateMany({
    where: { id: { in: driverIds }, isOnline: true },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  }));
  await sys(() => app.prisma.rider.updateMany({
    where: { id: { in: riderIds }, isOnline: true },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  }));
}

/** Hold the NEXT call of `method` at its door until released, then run it for
 *  real. The held party is parked at a named point while the other side of the
 *  race runs to completion: the losing interleaving, every time. */
type Methods = Record<string, (...args: unknown[]) => unknown>;

function holdNext(target: object, method: string) {
  const host = target as Methods;
  const original = host[method]!;
  let markEntered!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  let result: unknown;
  const spy = vi.spyOn(host, method).mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
    markEntered();
    await released;
    result = await original.apply(this, args);
    return result;
  });
  /** What the held call returned once it ran: the service-level answer. */
  return { entered, release: () => resume(), restore: () => spy.mockRestore(), result: () => result };
}

/** Hold EVERY call of `method` at its door until `expected` callers are waiting
 *  there together (or `maxWaitMs` passes), then let them all go at once, and
 *  report how many were waiting when the door opened. A lock taken before the
 *  door keeps all but one caller from ever reaching it while the first waits. */
function releaseTogether(target: object, method: string, expected: number, maxWaitMs: number) {
  const host = target as Methods;
  const original = host[method]!;
  let arrived = 0;
  let waitingWhenOpened: number | null = null;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const release = () => { waitingWhenOpened ??= arrived; open(); };
  const timer = setTimeout(release, maxWaitMs);
  const spy = vi.spyOn(host, method).mockImplementation(async function (this: unknown, ...args: unknown[]) {
    arrived += 1;
    if (arrived >= expected) release();
    await gate;
    return original.apply(this, args);
  });
  return { waitingWhenOpened: () => waitingWhenOpened, restore: () => { clearTimeout(timer); spy.mockRestore(); } };
}

/** The whole single-winner law for one taxi, read from the database and Redis. */
async function expectOneTaxiWinner(orderId: string, winner: DriverActor, losers: DriverActor[]) {
  const row = await orderRow(orderId);
  expect({ status: row.status, driver: row.driverId }).toEqual({ status: 'DRIVER_ASSIGNED', driver: winner.driverId });
  expect(await assignmentsOf(orderId, 'DRIVER_ASSIGNED'), 'exactly one assignment is written').toBe(1);
  const won = await driverRow(winner.driverId);
  expect({ pointer: won.currentRideId, available: won.isAvailable }).toEqual({ pointer: orderId, available: false });
  // The winner's acceptance moved once: 50 -> 60 on the EMA.
  expect(won.acceptanceRate).toBeCloseTo(60, 6);
  for (const loser of losers) {
    const lost = await driverRow(loser.driverId);
    expect({ pointer: lost.currentRideId, available: lost.isAvailable }, 'the loser stays free').toEqual({ pointer: null, available: true });
    expect(await declined(orderId), '[B1] losing a race is not a decline').not.toContain(loser.driverId);
  }
  expect(await app.redis.get(`dispatch:offer:${orderId}`), 'no card rings on after the ride is taken').toBeNull();
  expect(await sys(() => app.prisma.order.count({
    where: { orderType: 'TAXI', driverId: winner.driverId, status: { in: LIVE_ORDER_STATUSES } },
  }))).toBe(1);
}

async function expectOneDeliveryWinner(orderId: string, winner: RiderActor, losers: RiderActor[]) {
  const row = await orderRow(orderId);
  expect({ status: row.status, rider: row.riderId }).toEqual({ status: 'RIDER_ASSIGNED', rider: winner.riderId });
  expect(await assignmentsOf(orderId, 'RIDER_ASSIGNED'), 'exactly one assignment is written').toBe(1);
  const won = await riderRow(winner.riderId);
  expect({ pointer: won.currentOrderId, float: Number(won.committedFloat) }).toEqual({ pointer: orderId, float: 2000 });
  for (const loser of losers) {
    const lost = await riderRow(loser.riderId);
    expect({ pointer: lost.currentOrderId, available: lost.isAvailable, float: Number(lost.committedFloat) }, 'the loser stays free')
      .toEqual({ pointer: null, available: true, float: 0 });
    expect(await declined(orderId), '[B1] losing a race is not a decline').not.toContain(loser.riderId);
  }
  expect(await app.redis.get(`dispatch:offer:${orderId}`), 'no card rings on after the order is taken').toBeNull();
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const moverDriverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const moverRiderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { driverId: { in: moverDriverIds } }, { riderId: { in: moverRiderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...moverDriverIds, ...moverRiderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.supplyWatch.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: moverDriverIds } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: moverRiderIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (tenantIds.length > 0) await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await purgeRedis([...ids, ...moverDriverIds, ...moverRiderIds, ...orderIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'MATCH', 'dispatch:*', 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

/** Stacking capacity is AlgoConfig (clamped 1..3; the seeded founder value is
 *  3). Pin it for a capacity race and, after the file, put back whatever was
 *  there: with no row at all, the code default 1 is what was in force. */
async function pinRiderCapacity(value: number, updatedBy = 'dispatch-races:pin') {
  const latest = await sys(() => app.prisma.algoConfig.findFirst({
    where: { tenantId: 'swift-default', key: 'stacking.riderCapacity' },
    orderBy: { version: 'desc' },
  }));
  capacityRestore ??= latest ? Number(latest.value) : 1;
  await sys(() => app.prisma.algoConfig.create({
    data: { tenantId: 'swift-default', key: 'stacking.riderCapacity', value, version: (latest?.version ?? 0) + 1, updatedBy },
  }));
  invalidateAlgoConfig();
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // Route -> worker hops are recorded, never run: every dispatch pass and every
  // timeout in this file is driven by the test, at the moment the race needs it.
  jobs = recordDispatchQueue(app);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  dispatch = makeDispatchService(app);
  await purgeFixtures();

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  vendorId = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Race Kitchen', slug: `race-kitchen-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5920771999',
        addressLine1: '1 Market St', city: 'Lethem', region: 'Upper Takutu-Upper Essequibo',
        latitude: SPOT.lat, longitude: SPOT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    return vendor.id;
  });
}, 120_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await park();
});

afterAll(async () => {
  if (capacityRestore !== null) await pinRiderCapacity(capacityRestore, 'dispatch-races:unpin');
  await purgeFixtures();
  await app.close();
}, 120_000);

// ---------------------------------------------------------------------------

describe('[DISPATCH 1/3] the database itself refuses a second winner', () => {
  it('both index predicates are exactly LIVE_ORDER_STATUSES — in the migration file AND in the installed indexes', async () => {
    const live = [...LIVE_ORDER_STATUSES].sort();
    // The migration text, comments stripped: its prose quotes status lists too.
    const sql = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const created = [...sql.matchAll(/CREATE UNIQUE INDEX "([^"]+)"[\s\S]*?"status" IN \(([^)]*)\)/g)];
    expect(created.map((m) => m[1]).sort()).toEqual([INDEXES.customer, INDEXES.driver]);
    for (const m of created) {
      expect([...m[2]!.matchAll(/'([A-Z_]+)'/g)].map((q) => q[1]).sort(), `${m[1]} in the migration`).toEqual(live);
    }
    // Every status list in the executable SQL, the pre-check guard's included.
    const lists = [...sql.matchAll(/"status" IN \(([^)]*)\)/g)];
    expect(lists, 'two index predicates and the two pre-check counts').toHaveLength(4);
    for (const m of lists) expect([...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((q) => q[1]).sort()).toEqual(live);
    // What the database actually enforces, as PostgreSQL reports it back.
    const installed = await sys(() => app.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'orders' AND indexname IN (${INDEXES.driver}, ${INDEXES.customer})
      ORDER BY indexname`);
    expect(installed.map((i) => i.indexname)).toEqual([INDEXES.customer, INDEXES.driver]);
    for (const { indexname, indexdef } of installed) {
      expect(indexdef).toMatch(/^CREATE UNIQUE INDEX /);
      expect(indexdef).toContain(`("${indexname === INDEXES.driver ? 'driverId' : 'customerId'}")`);
      expect(indexdef).toContain(`"orderType" = 'TAXI'::"OrderType"`);
      expect([...indexdef.matchAll(/'([A-Z_]+)'::"OrderStatus"/g)].map((q) => q[1]).sort(), `${indexname} as installed`).toEqual(live);
    }
  });

  it('a driver cannot hold two live rides, whoever writes them — a finished ride and unassigned requests never collide', async () => {
    const driver = await makeDriver(near(5000));
    const [c1, c2, c3, c4] = [await makeCustomer(), await makeCustomer(), await makeCustomer(), await makeCustomer()];
    const first = await makeTaxi(c1);
    await sys(() => app.prisma.order.update({ where: { id: first.id }, data: { driverId: driver.driverId, status: 'DRIVER_EN_ROUTE' } }));
    const second = await makeTaxi(c2);
    await expect(sys(() => app.prisma.order.update({ where: { id: second.id }, data: { driverId: driver.driverId, status: 'DRIVER_ASSIGNED' } })))
      .rejects.toThrow(/Unique constraint failed on the fields: \(`driverId`\)/);
    // A finished ride is history, not custody: the driver may take the next one.
    await sys(() => app.prisma.order.update({ where: { id: first.id }, data: { status: 'COMPLETED' } }));
    await sys(() => app.prisma.order.update({ where: { id: second.id }, data: { driverId: driver.driverId, status: 'DRIVER_ASSIGNED' } }));
    // Unassigned requests carry no driver and never meet in the index.
    await makeTaxi(c3);
    await makeTaxi(c4);
  });

  it('a customer cannot hold two live taxis, whoever writes them — a finished one and a live delivery never collide', async () => {
    const customer = await makeCustomer();
    const first = await makeTaxi(customer);
    await expect(makeTaxi(customer)).rejects.toThrow(/Unique constraint failed on the fields: \(`customerId`\)/);
    await makeDelivery(customer); // food is not a taxi
    await sys(() => app.prisma.order.update({ where: { id: first.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } }));
    await makeTaxi(customer); // the next ride, once the first is over
  });

  it('when a stale driver pointer says "free", the claim still meets the index — and the driver hears DRIVER_BUSY, not a raw constraint error', async () => {
    // The pointer lies (a writer that skipped it): the driver row says free
    // while the driver holds a live ride. The mover-reservation CAS would pass;
    // only the index stands between this driver and a second ride.
    const driver = await makeDriver();
    const held = await makeTaxi(await makeCustomer());
    await sys(() => app.prisma.order.update({ where: { id: held.id }, data: { driverId: driver.driverId, status: 'DRIVER_ASSIGNED' } }));
    const next = await makeTaxi(await makeCustomer(), near(100));
    const res = await grabRide(driver, next.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('DRIVER_BUSY');
    const untouched = await orderRow(next.id);
    expect({ status: untouched.status, driver: untouched.driverId }).toEqual({ status: 'PENDING', driver: null });
  });

  it('a live ride left under another tenant still blocks a second request — answered RIDE_IN_PROGRESS, as the check answers', async () => {
    const customer = await makeCustomer();
    const other = await sys(() => app.prisma.tenant.create({ data: { name: 'Race Operator', slug: `race-${nanoid(8).toLowerCase()}`, isActive: false } }));
    tenantIds.push(other.id);
    const stranded = await makeTaxi(customer);
    await sys(() => app.prisma.order.update({ where: { id: stranded.id }, data: { tenantId: other.id } }));
    const res = await call('POST', '/api/v1/rides/request', customer.token, {
      pickup: SPOT, dropoff: DROP, pickupAddress: 'Lethem market', dropoffAddress: 'Lethem airstrip',
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('RIDE_IN_PROGRESS');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId, orderType: 'TAXI' } }))).toBe(1);
  });
});

describe('[DISPATCH 1/3] two movers, one job: exactly one winner', () => {
  it(`taxi: two pinged drivers tap accept at the same instant, ${LOOPS}×: the live card wins, the lapsed card hears it expired`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const first = await makeDriver(SPOT);
      const second = await makeDriver(near(300));
      const ride = await makeTaxi(customer);
      expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(first.driverId);
      const lapsed = await offer(ride.id, first.driverId);
      // The first card runs out; the cascade pings the next driver.
      await dispatch.handleOfferTimeout(ride.id, first.driverId, lapsed.attemptId);
      const current = await offer(ride.id, second.driverId);

      const [a, b] = await Promise.all([
        acceptCard(first, 'driver', ride.id, i % 2 === 0 ? lapsed.attemptId : current.attemptId),
        acceptCard(second, 'driver', ride.id, current.attemptId),
      ]);
      expect(b.statusCode, b.body).toBe(200);
      expect(a.statusCode, a.body).toBe(409);
      // Their own card ran out: an expiry, never "another driver took it".
      expect(a.json().error.code).toBe('OFFER_EXPIRED');
      await expectOneTaxiWinner(ride.id, second, [first]);
      await park();
    }
  }, 180_000);

  it(`delivery: two pinged riders tap accept at the same instant, ${LOOPS}×: one winner, one clear 409`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const first = await makeRider(SPOT);
      const second = await makeRider(near(300));
      const order = await makeDelivery(customer);
      expect((await dispatch.dispatchOrder(order.id)).offered).toBe(first.riderId);
      const lapsed = await offer(order.id, first.riderId);
      await dispatch.handleOfferTimeout(order.id, first.riderId, lapsed.attemptId);
      const current = await offer(order.id, second.riderId);

      const [a, b] = await Promise.all([
        acceptCard(first, 'rider', order.id, i % 2 === 0 ? lapsed.attemptId : current.attemptId),
        acceptCard(second, 'rider', order.id, current.attemptId),
      ]);
      expect(b.statusCode, b.body).toBe(200);
      expect(a.statusCode, a.body).toBe(409);
      expect(a.json().error.code).toBe('OFFER_EXPIRED');
      await expectOneDeliveryWinner(order.id, second, [first]);
      await park();
    }
  }, 180_000);

  it(`taxi: the offered driver taps accept as another driver grabs the ride off the board, ${LOOPS}×: one winner`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const carded = await makeDriver(SPOT);
      const grabber = await makeDriver(near(400));
      const ride = await makeTaxi(customer);
      expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
      const card = await offer(ride.id, carded.driverId);

      const [viaCard, viaBoard] = await Promise.all([
        acceptCard(carded, 'driver', ride.id, card.attemptId),
        grabRide(grabber, ride.id),
      ]);
      expect([viaCard.statusCode, viaBoard.statusCode].sort(), `${viaCard.body} / ${viaBoard.body}`).toEqual([200, 409]);
      if (viaCard.statusCode === 409) {
        expect(viaCard.json().error).toMatchObject({ code: 'OFFER_TAKEN', message: 'Another driver took this ride.' });
      } else {
        expect(viaBoard.json().error.code).toBe('ALREADY_TAKEN');
      }
      const winner = viaCard.statusCode === 200 ? carded : grabber;
      await expectOneTaxiWinner(ride.id, winner, [winner === carded ? grabber : carded]);
      await park();
    }
  }, 180_000);

  it(`delivery: the offered rider taps accept as another rider grabs the order off the board, ${LOOPS}×: one winner`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const carded = await makeRider(SPOT);
      const grabber = await makeRider(near(400));
      const order = await makeDelivery(customer);
      expect((await dispatch.dispatchOrder(order.id)).offered).toBe(carded.riderId);
      const card = await offer(order.id, carded.riderId);

      const [viaCard, viaBoard] = await Promise.all([
        acceptCard(carded, 'rider', order.id, card.attemptId),
        grabOrder(grabber, order.id),
      ]);
      expect([viaCard.statusCode, viaBoard.statusCode].sort(), `${viaCard.body} / ${viaBoard.body}`).toEqual([200, 409]);
      if (viaCard.statusCode === 409) {
        expect(viaCard.json().error).toMatchObject({ code: 'OFFER_TAKEN', message: 'Another rider took this order.' });
      } else {
        expect(viaBoard.json().error.code).toBe('CONFLICT');
      }
      const winner = viaCard.statusCode === 200 ? carded : grabber;
      await expectOneDeliveryWinner(order.id, winner, [winner === carded ? grabber : carded]);
      await park();
    }
  }, 180_000);

  it('controlled, taxi: the board grab commits while the card holder is between taking the card and claiming — one winner, and the loser is not marked', async () => {
    const customer = await makeCustomer();
    const carded = await makeDriver(SPOT);
    const grabber = await makeDriver(near(400));
    const ride = await makeTaxi(customer);
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    expect(card.moverId).toBe(carded.driverId);

    const hold = holdNext(DispatchService.prototype, 'claimOrder');
    const viaCard = acceptCard(carded, 'driver', ride.id, card.attemptId);
    await hold.entered; // the card is consumed; the claim has not run
    const viaBoard = await grabRide(grabber, ride.id);
    expect(viaBoard.statusCode, viaBoard.body).toBe(200);
    hold.release();
    const lost = await viaCard;
    expect(lost.statusCode, lost.body).toBe(409);
    expect(lost.json().error).toMatchObject({ code: 'OFFER_TAKEN', message: 'Another driver took this ride.' });
    await expectOneTaxiWinner(ride.id, grabber, [carded]);
    expect((await driverRow(carded.driverId)).acceptanceRate, 'a lost race costs no acceptance').toBe(50);

    // [B1] Why the marker mattered: the winner gives the ride back, and the
    // driver who merely lost the race is the one it goes to.
    const giveBack = await call('POST', `/api/v1/driver/rides/${ride.id}/cancel`, grabber.token, { reason: 'flat tyre' });
    expect(giveBack.statusCode, giveBack.body).toBe(200);
    expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
  });

  it('controlled, delivery: the board grab commits while the card holder is between taking the card and claiming — one winner, and the loser is not marked', async () => {
    const customer = await makeCustomer();
    const carded = await makeRider(SPOT);
    const grabber = await makeRider(near(400));
    const order = await makeDelivery(customer);
    const card = await offer(order.id, (await dispatch.dispatchOrder(order.id)).offered!);
    expect(card.moverId).toBe(carded.riderId);

    const hold = holdNext(DispatchService.prototype, 'claimOrder');
    const viaCard = acceptCard(carded, 'rider', order.id, card.attemptId);
    await hold.entered;
    const viaBoard = await grabOrder(grabber, order.id);
    expect(viaBoard.statusCode, viaBoard.body).toBe(200);
    hold.release();
    const lost = await viaCard;
    expect(lost.statusCode, lost.body).toBe(409);
    expect(lost.json().error).toMatchObject({ code: 'OFFER_TAKEN', message: 'Another rider took this order.' });
    await expectOneDeliveryWinner(order.id, grabber, [carded]);
    expect((await riderRow(carded.riderId)).acceptanceRate, 'a lost race costs no acceptance').toBe(50);

    const handBack = await call('POST', `/api/v1/rider/orders/${order.id}/handback`, grabber.token, { reason: 'bike trouble' });
    expect(handBack.statusCode, handBack.body).toBe(200);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(carded.riderId);
  });

  it('a board grab never takes an order a rider already holds, even when its status still reads open', async () => {
    // Every writer moves the status to RIDER_ASSIGNED with the rider, so the
    // status predicate refuses first in practice; this row is the one shape
    // where the seam's own "no rider yet" predicate is the only guard left.
    const holder = await makeRider(SPOT);
    const grabber = await makeRider(near(400));
    const order = await makeDelivery(await makeCustomer());
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { riderId: holder.riderId } }));
    const orderService = new OrderService(app.prisma, app.io);
    await expect(sys(() => app.prisma.$transaction((tx) => orderService.stageDirectRiderAssignment(tx, {
      orderId: order.id, riderId: grabber.riderId, changedBy: grabber.userId, moverUserId: grabber.userId,
    })))).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect((await orderRow(order.id)).riderId).toBe(holder.riderId);
    expect((await riderRow(grabber.riderId)).currentOrderId).toBeNull();
  });
});

describe('[DISPATCH 1/3] accept against the clock and against the customer', () => {
  it(`taxi: the offered driver accepts at the instant the card times out, ${LOOPS}×: exactly one owner`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const carded = await makeDriver(SPOT);
      const next = await makeDriver(near(400));
      const ride = await makeTaxi(customer);
      expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
      const card = await offer(ride.id, carded.driverId);

      const [accept] = await Promise.all([
        acceptCard(carded, 'driver', ride.id, card.attemptId),
        dispatch.handleOfferTimeout(ride.id, carded.driverId, card.attemptId),
      ]);
      const row = await orderRow(ride.id);
      const timedOut = await expiryLogged(carded.driverId, ride.id, card.attemptId);
      if (accept.statusCode === 200) {
        // The accept owned the card: the timeout found nothing to expire, and
        // nobody else was ever asked.
        expect(timedOut, 'an accepted card never also expires').toBe(false);
        expect(cardsScheduledFor(ride.id, next.driverId), 'no second owner was ever offered the ride').toBe(0);
        await expectOneTaxiWinner(ride.id, carded, [next]);
      } else {
        // The timeout owned the card: an honest expiry, and the ride moved on.
        expect(accept.statusCode, accept.body).toBe(409);
        expect(accept.json().error.code).toBe('OFFER_EXPIRED');
        expect(timedOut).toBe(true);
        expect({ status: row.status, driver: row.driverId }).toEqual({ status: 'PENDING', driver: null });
        expect(await assignmentsOf(ride.id, 'DRIVER_ASSIGNED')).toBe(0);
        expect((await offerOf(ride.id))?.moverId).toBe(next.driverId);
      }
      await park();
    }
  }, 180_000);

  it('controlled: the card times out while the accept is between taking the card and claiming — the accept alone owns it', async () => {
    const carded = await makeDriver(SPOT);
    const next = await makeDriver(near(400));
    const ride = await makeTaxi(await makeCustomer());
    expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
    const card = await offer(ride.id, carded.driverId);

    const hold = holdNext(DispatchService.prototype, 'claimOrder');
    const accepting = acceptCard(carded, 'driver', ride.id, card.attemptId);
    await hold.entered;
    await dispatch.handleOfferTimeout(ride.id, carded.driverId, card.attemptId);
    expect(await offerOf(ride.id), 'the timeout found no card to expire, so nobody was re-offered').toBeNull();
    hold.release();
    const res = await accepting;
    expect(res.statusCode, res.body).toBe(200);
    expect(await expiryLogged(carded.driverId, ride.id, card.attemptId)).toBe(false);
    expect(cardsScheduledFor(ride.id, next.driverId)).toBe(0);
    await expectOneTaxiWinner(ride.id, carded, [next]);
  });

  it('controlled: a late timeout from an EARLIER card generation fires as the driver accepts the live one — it touches nothing', async () => {
    const carded = await makeDriver(SPOT);
    const next = await makeDriver(near(400));
    const ride = await makeTaxi(await makeCustomer());
    expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
    const earlier = await offer(ride.id, carded.driverId);
    // The first pair lapsed in Redis before its timeout job ran (a slow queue):
    // the keys are gone, the job is not. The next pass re-offers the same driver.
    await app.redis.del(`dispatch:offer:${ride.id}`, `dispatch:mover-offer:${carded.driverId}`);
    expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
    const live = await offer(ride.id, carded.driverId);
    expect(live.attemptId).not.toBe(earlier.attemptId);

    const hold = holdNext(DispatchService.prototype, 'removeOfferIfOwned');
    const accepting = acceptCard(carded, 'driver', ride.id, live.attemptId);
    await hold.entered; // about to consume the live card
    await dispatch.handleOfferTimeout(ride.id, carded.driverId, earlier.attemptId);
    expect(await offerOf(ride.id), 'a stale generation cannot consume the live card').toEqual({ moverId: carded.driverId, attemptId: live.attemptId });
    hold.release();
    const res = await accepting;
    expect(res.statusCode, res.body).toBe(200);
    expect(cardsScheduledFor(ride.id, next.driverId)).toBe(0);
    await expectOneTaxiWinner(ride.id, carded, [next]);
  });

  it(`taxi: the offered driver accepts at the instant the customer cancels, ${LOOPS}×: one clean outcome, never an assigned-and-cancelled ride`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const carded = await makeDriver(SPOT);
      const ride = await makeTaxi(customer);
      expect((await dispatch.dispatchOrder(ride.id)).offered).toBe(carded.driverId);
      const card = await offer(ride.id, carded.driverId);

      const [accept, cancel] = await Promise.all([
        acceptCard(carded, 'driver', ride.id, card.attemptId),
        call('POST', `/api/v1/rides/${ride.id}/cancel`, customer.token, {}),
      ]);
      // A ride nobody has boarded is always the customer's to cancel.
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect((await orderRow(ride.id)).status).toBe('CANCELLED');
      const d = await driverRow(carded.driverId);
      expect({ pointer: d.currentRideId, available: d.isAvailable }, 'never assigned to a cancelled ride').toEqual({ pointer: null, available: true });
      if (accept.statusCode === 200) {
        expect(await assignmentsOf(ride.id, 'DRIVER_ASSIGNED'), 'accepted first, then cancelled and released').toBe(1);
      } else {
        expect(accept.statusCode, accept.body).toBe(409);
        // The honest reason, never "another mover took this job".
        expect(accept.json().error).toMatchObject({ code: 'ORDER_CANCELLED', message: 'The customer cancelled this request.' });
        expect(await assignmentsOf(ride.id, 'DRIVER_ASSIGNED')).toBe(0);
        expect(d.acceptanceRate).toBe(50);
      }
      expect(await app.redis.get(`dispatch:offer:${ride.id}`), 'no card rings on for a cancelled ride').toBeNull();
      expect(await app.redis.get(`dispatch:mover-offer:${carded.driverId}`)).toBeNull();
      expect(await declined(ride.id)).not.toContain(carded.driverId);
      await park();
    }
  }, 180_000);

  it('controlled: the customer cancels while the accept is between taking the card and claiming — the driver hears ORDER_CANCELLED', async () => {
    const customer = await makeCustomer();
    const carded = await makeDriver(SPOT);
    const ride = await makeTaxi(customer);
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);

    const hold = holdNext(DispatchService.prototype, 'claimOrder');
    const accepting = acceptCard(carded, 'driver', ride.id, card.attemptId);
    await hold.entered;
    const cancel = await call('POST', `/api/v1/rides/${ride.id}/cancel`, customer.token, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    hold.release();
    const res = await accepting;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ORDER_CANCELLED', message: 'The customer cancelled this request.' });
    const d = await driverRow(carded.driverId);
    expect({ pointer: d.currentRideId, available: d.isAvailable, rate: d.acceptanceRate }).toEqual({ pointer: null, available: true, rate: 50 });
    expect(await declined(ride.id)).not.toContain(carded.driverId);
    // And off the board: a cancelled ride is answered as cancelled there too.
    const grabber = await makeDriver(near(400));
    const late = await grabRide(grabber, ride.id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('ORDER_CANCELLED');
  });

  it('[B4] taxi: a customer cancel withdraws the live card — the driver cannot take it and is free for the next ride at once', async () => {
    const customer = await makeCustomer();
    const carded = await makeDriver(SPOT);
    const ride = await makeTaxi(customer);
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    expect(card.moverId).toBe(carded.driverId);

    const cancel = await call('POST', `/api/v1/rides/${ride.id}/cancel`, customer.token, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await app.redis.get(`dispatch:offer:${ride.id}`), 'the card is withdrawn with the cancel').toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${carded.driverId}`)).toBeNull();
    const current = await call('GET', '/api/v1/driver/offers/current', carded.token);
    expect(current.json().data.offer).toBeNull();
    const late = await acceptCard(carded, 'driver', ride.id, card.attemptId);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatchObject({ code: 'ORDER_CANCELLED', message: 'The customer cancelled this request.' });

    // Nothing of the dead card holds the driver back: the next ride rings now.
    const nextRide = await makeTaxi(await makeCustomer());
    expect((await dispatch.dispatchOrder(nextRide.id)).offered).toBe(carded.driverId);
  });

  it('[B4] delivery: a customer order cancel withdraws the live card the same way', async () => {
    const customer = await makeCustomer();
    const carded = await makeRider(SPOT);
    const order = await makeDelivery(customer);
    const card = await offer(order.id, (await dispatch.dispatchOrder(order.id)).offered!);
    expect(card.moverId).toBe(carded.riderId);

    const cancel = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${carded.riderId}`)).toBeNull();
    const late = await acceptCard(carded, 'rider', order.id, card.attemptId);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('ORDER_CANCELLED');

    const nextOrder = await makeDelivery(await makeCustomer());
    expect((await dispatch.dispatchOrder(nextOrder.id)).offered).toBe(carded.riderId);
  });
});

describe('[DISPATCH 1/3 · B4] every cancellation withdraws the card — through the one point', () => {
  it('courier: the sender cancels a parcel whose card is ringing — the card and the rider pointer go at once', async () => {
    const sender = await makeCustomer();
    const carded = await makeRider(SPOT);
    const parcel = await makeCourier(sender);
    const card = await offer(parcel.id, (await dispatch.dispatchOrder(parcel.id)).offered!);
    expect(card.moverId).toBe(carded.riderId);

    const cancel = await call('POST', `/api/v1/courier/order/${parcel.id}/cancel`, sender.token, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await orderRow(parcel.id)).status).toBe('CANCELLED');
    expect(await app.redis.get(`dispatch:offer:${parcel.id}`), 'the card went with the cancel').toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${carded.riderId}`), 'and the rider pointer').toBeNull();
    expect((await call('GET', '/api/v1/rider/offers/current', carded.token)).json().data.offer).toBeNull();
    const late = await acceptCard(carded, 'rider', parcel.id, card.attemptId);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('ORDER_CANCELLED');
    // Free for the next job at once, not after the dead card's countdown.
    const next = await makeCourier(await makeCustomer());
    expect((await dispatch.dispatchOrder(next.id)).offered).toBe(carded.riderId);
  });

  it('the canonical seam: an operational cancel withdraws the card; a transition that keeps the order live leaves it ringing', async () => {
    const seam = new OrderService(app.prisma, app.io, undefined, undefined, app.redis);
    const carded = await makeRider(SPOT);
    // Dispatched on accept, still in the kitchen: moving to READY keeps the job
    // open, so the rider card must survive it.
    const cooking = await makeDelivery(await makeCustomer());
    await sys(() => app.prisma.order.update({ where: { id: cooking.id }, data: { status: 'PREPARING' } }));
    const card = await offer(cooking.id, (await dispatch.dispatchOrder(cooking.id)).offered!);
    await sys(() => seam.transitionOrderAtomically({
      orderId: cooking.id, target: 'READY_FOR_PICKUP', allowedFrom: ['PREPARING'], changedBy: 'race-kitchen', note: 'Ready',
    }));
    expect(await offerOf(cooking.id), 'still open: the card keeps ringing').toEqual({ moverId: carded.riderId, attemptId: card.attemptId });

    // The same order cancelled through the seam (the shape of an admin, vendor
    // or no-response cancel): the card and the pointer go with the commit.
    await sys(() => seam.transitionOrderAtomically({
      orderId: cooking.id, target: 'CANCELLED', allowedFrom: ['READY_FOR_PICKUP'], changedBy: 'race-ops',
      note: 'Cancelled by ops', cancellation: { by: 'race-ops', reason: 'Cancelled by ops' }, releaseStaleMoverPointer: true,
    }));
    expect(await app.redis.get(`dispatch:offer:${cooking.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${carded.riderId}`)).toBeNull();
    const next = await makeDelivery(await makeCustomer());
    expect((await dispatch.dispatchOrder(next.id)).offered).toBe(carded.riderId);
  });

  it('the food-age cutoff: the system cancel withdraws the card as a pair — the rider pointer no longer outlives it', async () => {
    const carded = await makeRider(SPOT);
    const cold = await makeDelivery(await makeCustomer());
    const card = await offer(cold.id, (await dispatch.dispatchOrder(cold.id)).offered!);
    expect(card.moverId).toBe(carded.riderId);
    // The card is ringing when the rescue sweep finds the food has gone cold.
    await sys(() => app.prisma.order.update({ where: { id: cold.id }, data: { readyAt: new Date(Date.now() - 90 * 60_000) } }));
    const row = await sys(() => app.prisma.order.findUniqueOrThrow({
      where: { id: cold.id },
      select: {
        id: true, orderNumber: true, customerId: true, tenantId: true, orderType: true, status: true, paymentMethod: true,
        paymentStatus: true, fulfillmentModeVersion: true, readyAt: true, vendor: { select: { name: true, owner: { select: { userId: true } } } },
      },
    }));
    const retired = await sys(() => retireTooOldOrder(
      { prisma: app.prisma, redis: app.redis, io: app.io, notifications: new NotificationService(app.prisma, app.io) },
      row, 90, 45,
    ));
    expect(retired).toBe(true);
    expect((await orderRow(cold.id)).status).toBe('CANCELLED');
    expect(await app.redis.get(`dispatch:offer:${cold.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${carded.riderId}`), 'the pointer went with the card').toBeNull();
    const next = await makeDelivery(await makeCustomer());
    expect((await dispatch.dispatchOrder(next.id)).offered).toBe(carded.riderId);
  });
});

describe('[DISPATCH 1/3 · AX299 F2] a withdrawn card leaves the screen, and never costs the next one', () => {
  // Withdrawing the card at the cancel frees the mover at once, so the next
  // offer can ring a second later. An app never told the first card went kept
  // it on top until its deadline; the new card queued behind it, was marked
  // seen on arrival and could lapse hidden, charged as an ignored offer. The
  // app is now told which card went; and, whatever the app does, an offer sent
  // while a withdrawn card could still be on screen is never charged.

  /** Every socket emit, recorded on its way to the real server. */
  function recordEmits() {
    const emits: Array<{ room: string; event: string; payload: unknown }> = [];
    const realTo = app.io.to.bind(app.io);
    const spy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => {
      const target = realTo(room);
      return new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === 'emit') {
            return (event: string, ...args: unknown[]) => {
              emits.push({ room, event, payload: args[0] });
              return (t.emit as (...a: unknown[]) => boolean)(event, ...args);
            };
          }
          const value = Reflect.get(t, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
        },
      });
    }) as never);
    return { withdrawals: () => emits.filter((e) => e.event === 'dispatch:offer_withdrawn'), restore: () => spy.mockRestore() };
  }

  it('taxi and delivery: a customer cancel tells the mover\'s app exactly which card went — order and attempt', async () => {
    await park();
    const taxiCustomer = await makeCustomer();
    const driver = await makeDriver(SPOT);
    const ride = await makeTaxi(taxiCustomer);
    const rideCard = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    const shopper = await makeCustomer();
    const rider = await makeRider(SPOT);
    const order = await makeDelivery(shopper);
    const orderCard = await offer(order.id, (await dispatch.dispatchOrder(order.id)).offered!);
    expect([rideCard.moverId, orderCard.moverId]).toEqual([driver.driverId, rider.riderId]);

    const tap = recordEmits();
    try {
      expect((await call('POST', `/api/v1/rides/${ride.id}/cancel`, taxiCustomer.token, {})).statusCode).toBe(200);
      expect((await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, shopper.token, {})).statusCode).toBe(200);
    } finally {
      tap.restore();
    }
    expect(tap.withdrawals()).toEqual([
      { room: `user:${driver.userId}`, event: 'dispatch:offer_withdrawn', payload: { orderId: ride.id, offerAttemptId: rideCard.attemptId, reason: 'ORDER_CANCELLED' } },
      { room: `user:${rider.userId}`, event: 'dispatch:offer_withdrawn', payload: { orderId: order.id, offerAttemptId: orderCard.attemptId, reason: 'ORDER_CANCELLED' } },
    ]);
  });

  it('an offer sent while a withdrawn card could still be on screen never earns an expiry penalty; once that card would have run out, a lapsed card costs what it always did', async () => {
    await park();
    const carded = await makeDriver(SPOT);
    const customer = await makeCustomer();
    const first = await makeTaxi(customer);
    const a = await offer(first.id, (await dispatch.dispatchOrder(first.id)).offered!);
    expect((await call('POST', '/api/v1/driver/offers/seen', carded.token, { orderId: first.id, offerAttemptId: a.attemptId })).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/rides/${first.id}/cancel`, customer.token, {})).statusCode).toBe(200);
    const rate = async () => Number((await driverRow(carded.driverId)).acceptanceRate);
    const before = await rate();

    // The freed driver is offered B at once. An app still showing A marks B
    // seen as it queues behind it; B lapses unanswered.
    const second = await makeTaxi(await makeCustomer());
    const b = await offer(second.id, (await dispatch.dispatchOrder(second.id)).offered!);
    expect(b.moverId).toBe(carded.driverId);
    expect((await call('POST', '/api/v1/driver/offers/seen', carded.token, { orderId: second.id, offerAttemptId: b.attemptId })).statusCode).toBe(200);
    await dispatch.handleOfferTimeout(second.id, carded.driverId, b.attemptId);
    expect(await rate(), 'B was sent while the withdrawn card A could still be on the screen').toBe(before);
    // The expiry itself is still recorded, and the card is gone: only the charge is spared.
    expect(await expiryLogged(carded.driverId, second.id, b.attemptId)).toBe(true);
    expect((await offerOf(second.id))?.attemptId).not.toBe(b.attemptId);

    // As if A's countdown had run out: a card seen and ignored costs again.
    await app.redis.set(dispatchWithdrawnCardKey(carded.driverId), String(Date.now() - 60_000), 'PX', 60_000);
    const third = await makeTaxi(await makeCustomer());
    const c = await offer(third.id, (await dispatch.dispatchOrder(third.id)).offered!);
    expect(c.moverId).toBe(carded.driverId);
    expect((await call('POST', '/api/v1/driver/offers/seen', carded.token, { orderId: third.id, offerAttemptId: c.attemptId })).statusCode).toBe(200);
    await dispatch.handleOfferTimeout(third.id, carded.driverId, c.attemptId);
    expect(await rate()).toBeLessThan(before);
  });

  it('the same when the mover goes offline holding that next card: the released card is not charged either', async () => {
    await park();
    const carded = await makeDriver(SPOT);
    const customer = await makeCustomer();
    const first = await makeTaxi(customer);
    const a = await offer(first.id, (await dispatch.dispatchOrder(first.id)).offered!);
    expect((await call('POST', '/api/v1/driver/offers/seen', carded.token, { orderId: first.id, offerAttemptId: a.attemptId })).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/rides/${first.id}/cancel`, customer.token, {})).statusCode).toBe(200);
    const before = Number((await driverRow(carded.driverId)).acceptanceRate);

    const second = await makeTaxi(await makeCustomer());
    const b = await offer(second.id, (await dispatch.dispatchOrder(second.id)).offered!);
    expect(b.moverId).toBe(carded.driverId);
    expect((await call('POST', '/api/v1/driver/offers/seen', carded.token, { orderId: second.id, offerAttemptId: b.attemptId })).statusCode).toBe(200);
    await dispatch.releaseHeldOffer(carded.driverId);
    expect((await offerOf(second.id))?.attemptId, 'the released card is gone').not.toBe(b.attemptId);
    expect(Number((await driverRow(carded.driverId)).acceptanceRate), 'B was sent while A could still be on the screen').toBe(before);
  });
});

describe('[DISPATCH 1/3] one mover, one customer: never two at once', () => {
  it(`taxi: one driver takes two rides at the same instant, ${LOOPS}×: at most one`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const driver = await makeDriver(SPOT);
      const r1 = await makeTaxi(await makeCustomer());
      const r2 = await makeTaxi(await makeCustomer(), near(200));
      // Half the loops race the offer card against the board; half, two board grabs.
      const viaCard = i % 2 === 0;
      if (viaCard) expect((await dispatch.dispatchOrder(r1.id)).offered).toBe(driver.driverId);
      const card = viaCard ? await offer(r1.id, driver.driverId) : null;
      const results = await Promise.all([
        card ? acceptCard(driver, 'driver', r1.id, card.attemptId) : grabRide(driver, r1.id),
        grabRide(driver, r2.id),
      ]);
      const wins = results.filter((r) => r.statusCode === 200);
      expect(wins, results.map((r) => r.body).join(' / ')).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        // Refused as a busy driver — through the reservation or the index, never a raw error.
        expect([`409:DRIVER_BUSY`, `400:UNAVAILABLE`]).toContain(`${r.statusCode}:${r.json().error.code}`);
      }
      const live = await sys(() => app.prisma.order.findMany({
        where: { driverId: driver.driverId, orderType: 'TAXI', status: { in: LIVE_ORDER_STATUSES } },
        select: { id: true },
      }));
      expect(live).toHaveLength(1);
      expect((await driverRow(driver.driverId)).currentRideId).toBe(live[0]!.id);
      await park();
    }
  }, 180_000);

  it(`delivery: at stacking capacity 2 one rider grabs three orders at the same instant, ${LOOPS}×: at most two`, async () => {
    await pinRiderCapacity(2);
    for (let i = 0; i < LOOPS; i += 1) {
      const rider = await makeRider(SPOT);
      const orders = [await makeDelivery(await makeCustomer()), await makeDelivery(await makeCustomer(), 0.001), await makeDelivery(await makeCustomer(), 0.002)];
      const results = await Promise.all(orders.map((o) => grabOrder(rider, o.id)));
      const wins = results.filter((r) => r.statusCode === 200).length;
      expect(wins, results.map((r) => r.body).join(' / ')).toBeLessThanOrEqual(2);
      expect(wins).toBeGreaterThanOrEqual(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) expect(r.statusCode, r.body).toBe(409);
      const legs = await sys(() => app.prisma.order.count({ where: { riderId: rider.riderId, status: { in: LIVE_ORDER_STATUSES } } }));
      expect(legs).toBe(wins);
      expect(Number((await riderRow(rider.riderId)).committedFloat), 'float is committed once per leg held').toBe(2000 * wins);
      await park();
    }
  }, 180_000);

  it('controlled: the users-row lock lets ONE grab into the claim at a time — three grabs never reach its door together', async () => {
    await pinRiderCapacity(2);
    const rider = await makeRider(SPOT);
    const orders = [await makeDelivery(await makeCustomer()), await makeDelivery(await makeCustomer(), 0.001), await makeDelivery(await makeCustomer(), 0.002)];
    // A door just inside the claim transaction, AFTER the users row is locked.
    // With the lock, the first grab waits at the door while holding it, so the
    // other two can only queue on the lock: one caller at the door when it
    // opens. Without the lock, all three are at the door together, each about
    // to count this rider's legs before the others commit.
    const door = releaseTogether(OrderService.prototype, 'stageDirectRiderAssignment', 3, 750);
    const results = await Promise.all(orders.map((o) => grabOrder(rider, o.id)));
    door.restore();
    expect(door.waitingWhenOpened(), 'grabs inside the claim transaction at once').toBe(1);
    const wins = results.filter((r) => r.statusCode === 200).length;
    expect(wins, results.map((r) => r.body).join(' / ')).toBe(2);
    for (const r of results.filter((x) => x.statusCode !== 200)) expect(r.statusCode, r.body).toBe(409);
    expect(await sys(() => app.prisma.order.count({ where: { riderId: rider.riderId, status: { in: LIVE_ORDER_STATUSES } } }))).toBe(2);
  });

  it(`delivery: at capacity 2 the offer-accept door holds too — three claims for one rider at the same instant, ${LOOPS}×: at most two`, async () => {
    await pinRiderCapacity(2);
    for (let i = 0; i < LOOPS; i += 1) {
      const rider = await makeRider(SPOT);
      const orders = [await makeDelivery(await makeCustomer()), await makeDelivery(await makeCustomer(), 0.001), await makeDelivery(await makeCustomer(), 0.002)];
      const results = await Promise.allSettled(orders.map((o) => dispatch.claimOrder(o.id, rider.riderId, 'RIDER')));
      const wins = results.filter((r) => r.status === 'fulfilled').length;
      expect(wins).toBeLessThanOrEqual(2);
      for (const r of results) {
        if (r.status === 'rejected') expect(['DRIVER_BUSY', 'STACK_INELIGIBLE']).toContain((r.reason as AppError).code);
      }
      expect(await sys(() => app.prisma.order.count({ where: { riderId: rider.riderId, status: { in: LIVE_ORDER_STATUSES } } }))).toBe(wins);
      await park();
    }
  }, 180_000);

  it(`taxi: one customer sends three ride requests at the same instant, ${LOOPS}×: exactly one ride exists`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const customer = await makeCustomer();
      const results = await Promise.all([0, 1, 2].map(() => call('POST', '/api/v1/rides/request', customer.token, {
        pickup: SPOT, dropoff: DROP, pickupAddress: 'Lethem market', dropoffAddress: 'Lethem airstrip',
      })));
      expect(results.filter((r) => r.statusCode === 201), results.map((r) => r.body).join(' / ')).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 201)) {
        expect(`${r.statusCode}:${r.json().error.code}`).toBe('409:RIDE_IN_PROGRESS');
      }
      expect(await sys(() => app.prisma.order.count({
        where: { customerId: customer.userId, orderType: 'TAXI', status: { in: LIVE_ORDER_STATUSES } },
      }))).toBe(1);
    }
  }, 180_000);
});

describe('[DISPATCH 1/3] after the race: retries, give-backs and the words movers see', () => {
  it('[B3] the winner asking again — a lost response, a second tap — is answered with the same assignment', async () => {
    const carded = await makeDriver(SPOT);
    const ride = await makeTaxi(await makeCustomer());
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    const won = await acceptCard(carded, 'driver', ride.id, card.attemptId);
    expect(won.statusCode, won.body).toBe(200);
    for (const again of [
      await acceptCard(carded, 'driver', ride.id, card.attemptId), // the retry of the same request
      await acceptCard(carded, 'driver', ride.id), // an older client with no attempt id
    ]) {
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().data).toEqual(won.json().data);
    }
    // One assignment, and the acceptance counted once.
    await expectOneTaxiWinner(ride.id, carded, []);
  });

  it(`[B3] the winner double-taps at the same instant, ${LOOPS}×: one assignment, and the twin tap is never told another driver took the ride`, async () => {
    for (let i = 0; i < LOOPS; i += 1) {
      const carded = await makeDriver(SPOT);
      const ride = await makeTaxi(await makeCustomer());
      const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
      const taps = await Promise.all([
        acceptCard(carded, 'driver', ride.id, card.attemptId),
        acceptCard(carded, 'driver', ride.id, card.attemptId),
      ]);
      expect(taps.some((t) => t.statusCode === 200), taps.map((t) => t.body).join(' / ')).toBe(true);
      for (const t of taps.filter((x) => x.statusCode !== 200)) {
        // A tap that raced its twin before the claim committed may only say the
        // card was spent — never that another driver has the ride.
        expect(`${t.statusCode}:${t.json().error.code}`).toBe('409:OFFER_EXPIRED');
      }
      await expectOneTaxiWinner(ride.id, carded, []);
      await park();
    }
  }, 180_000);

  // [AX299 F1] The retry's answer is read under the lock that decided it. The
  // retry is held at the door of the read that builds its answer while the
  // other side runs; a cancel or a give-back must either wait for that answer
  // or come first and be told. Never a 200 carrying a cancelled ride, a
  // released one, or another driver's.
  const settledWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), ms); })]);

  it('[B3 · AX299 F1] controlled: the customer cancels while the winner\'s retry is being answered — the answer is a ride they hold, never a cancelled one', async () => {
    const customer = await makeCustomer();
    const carded = await makeDriver(SPOT);
    const ride = await makeTaxi(customer);
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    const won = await acceptCard(carded, 'driver', ride.id, card.attemptId);
    expect(won.statusCode, won.body).toBe(200);

    const hold = holdNext(DispatchService.prototype, 'committedAssignment');
    try {
      const retrying = acceptCard(carded, 'driver', ride.id, card.attemptId);
      await hold.entered;
      const cancelling = call('POST', `/api/v1/rides/${ride.id}/cancel`, customer.token, {});
      const cancelledInTheGap = await settledWithin(cancelling, 1_500);
      hold.release();
      const [retry, cancel] = await Promise.all([retrying, cancelling]);
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().data.status).toBe('DRIVER_ASSIGNED');
      // The route answers orderId, status and number; whose ride it is, is in
      // the row the service built the answer from.
      const built = hold.result() as { status: string; driverId: string | null };
      expect({ status: built.status, driverId: built.driverId }).toEqual({ status: 'DRIVER_ASSIGNED', driverId: carded.driverId });
      expect(cancelledInTheGap, 'the cancel waits for the answer the retry is building under the lock').toBe(false);
    } finally {
      hold.restore();
    }
    // The cancel then lands after the answer: one order of events, both true.
    expect((await orderRow(ride.id)).status).toBe('CANCELLED');
  });

  it('[B3 · AX299 F1] controlled: the ride is given back and another driver takes it while the retry is being answered — never another driver\'s ride', async () => {
    const carded = await makeDriver(SPOT);
    const next = await makeDriver(near(300));
    const ride = await makeTaxi(await makeCustomer());
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    expect(card.moverId).toBe(carded.driverId);
    const won = await acceptCard(carded, 'driver', ride.id, card.attemptId);
    expect(won.statusCode, won.body).toBe(200);

    const hold = holdNext(DispatchService.prototype, 'committedAssignment');
    try {
      const retrying = acceptCard(carded, 'driver', ride.id, card.attemptId);
      await hold.entered;
      const reassigning = (async () => {
        const giveBack = await call('POST', `/api/v1/driver/rides/${ride.id}/cancel`, carded.token, { reason: 'Vehicle broke down' });
        const grab = await grabRide(next, ride.id);
        return { giveBack, grab };
      })();
      const reassignedInTheGap = await settledWithin(reassigning, 1_500);
      hold.release();
      const [retry, { giveBack, grab }] = await Promise.all([retrying, reassigning]);
      expect(giveBack.statusCode, giveBack.body).toBe(200);
      expect(grab.statusCode, grab.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().data.status).toBe('DRIVER_ASSIGNED');
      const built = hold.result() as { status: string; driverId: string | null };
      expect({ status: built.status, driverId: built.driverId }, 'the answer is the ride this driver holds, not the next driver\'s').toEqual({ status: 'DRIVER_ASSIGNED', driverId: carded.driverId });
      expect(reassignedInTheGap, 'the give-back waits for the answer the retry is building under the lock').toBe(false);
    } finally {
      hold.restore();
    }
    expect((await orderRow(ride.id)).driverId).toBe(next.driverId);
  });

  it('[B2] a driver who gives back an accepted ride is not offered it again — the next driver is, and alone they are not', async () => {
    const quitter = await makeDriver(SPOT);
    const next = await makeDriver(near(400));
    const ride = await makeTaxi(await makeCustomer());
    const card = await offer(ride.id, (await dispatch.dispatchOrder(ride.id)).offered!);
    expect(card.moverId).toBe(quitter.driverId);
    expect((await acceptCard(quitter, 'driver', ride.id, card.attemptId)).statusCode).toBe(200);
    const giveBack = await call('POST', `/api/v1/driver/rides/${ride.id}/cancel`, quitter.token, { reason: 'vehicle broke down' });
    expect(giveBack.statusCode, giveBack.body).toBe(200);
    // The worker job the cancel enqueued: the quitter is still the nearest
    // driver, and is never offered the ride they just gave up.
    expect((await dispatch.dispatchOrder(ride.id)).offered, 'the re-dispatch skips the driver who gave it up').toBe(next.driverId);
    expect(await declined(ride.id)).toContain(quitter.driverId);
    await park();

    const alone = await makeDriver(SPOT);
    const solo = await makeTaxi(await makeCustomer());
    const soloCard = await offer(solo.id, (await dispatch.dispatchOrder(solo.id)).offered!);
    expect((await acceptCard(alone, 'driver', solo.id, soloCard.attemptId)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/driver/rides/${solo.id}/cancel`, alone.token, { reason: 'wrong way' })).statusCode).toBe(200);
    expect((await dispatch.dispatchOrder(solo.id)).offered, 'the only driver left is the one who gave it up').toBeUndefined();
    expect(await offerOf(solo.id)).toBeNull();
  });

  it('[B1] classifies a claim refusal by typed outcome, and only mover-ineligibility marks the mover', () => {
    const table: Array<[unknown, string, boolean]> = [
      [new AppError(409, 'ORDER_NOT_READY', 'x'), 'order-held', false],
      [new AppError(409, 'ORDER_HELD', 'x'), 'order-held', false],
      [new AppError(409, 'MMG_CLAIM_MISMATCH', 'x'), 'order-held', false],
      [new AppError(409, 'MMG_PAYMENT_PENDING', 'x'), 'order-held', false],
      // Beaten to it, or cancelled under them: they did not decline.
      [new AppError(409, 'ALREADY_TAKEN', 'x'), 'lost-race', false],
      [new AppError(409, 'OFFER_TAKEN', 'x'), 'lost-race', false],
      [new AppError(409, 'ORDER_CANCELLED', 'x'), 'lost-race', false],
      [new AppError(409, 'MOVER_INACTIVE', 'x'), 'mover-ineligible', true],
      [new AppError(409, 'CAPACITY_EXCEEDED', 'x'), 'mover-ineligible', true],
      [new AppError(409, 'DRIVER_BUSY', 'x'), 'mover-ineligible', true],
      [new AppError(409, 'FLOAT_EXCEEDED', 'x'), 'mover-ineligible', true],
      [new AppError(409, 'STACK_INELIGIBLE', 'x'), 'mover-ineligible', true],
      [new AppError(409, 'SELF_OWN_ORDER', 'x'), 'mover-ineligible', true],
      // A database fault or a new code: never charged to a mover.
      [new Error('connection reset'), 'unknown', false],
      [new AppError(500, 'SOMETHING_NEW', 'x'), 'unknown', false],
    ];
    for (const [error, outcome, marks] of table) {
      const name = error instanceof AppError ? error.code : 'plain Error';
      expect(classifyClaimRefusal(error), name).toBe(outcome);
      expect(claimRefusalMarksTheMover(classifyClaimRefusal(error)), name).toBe(marks);
    }
  });
});
