import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { createRideRequest, type RideRequestApp } from '../modules/rides/rides.service';
import { scanRideQueue } from '../modules/rides/queue.service';
import { FareService } from '../modules/rides/fare.service';
import { makeDispatchService } from '../modules/dispatch/dispatch.service';
import { NotificationService } from '../modules/notification/notification.service';
import { pinLegacyGuyanaTaxiCard } from './helpers/legacy-taxi-card';
import { formatMoney } from '../utils/currency-amount';

// ---------------------------------------------------------------------------
// The 5.5B ride queue [rides spec]: a supply gap is a service. Failure paths
// first (gates mirror the request route), then the lifecycle: join → derived
// position → scan auto-requests the head through the REAL request core when
// supply appears → TTL expiry pushes once. The request path itself is pinned
// by taxi-characterization.test.ts — these tests may not weaken it.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const phoneBase = 592_140_000_000 + Math.floor(Math.random() * 800_000_000);

// Two pickup areas far apart so per-area budgets are exercised honestly.
const GT = { lat: 6.8013, lng: -58.1553 };       // Georgetown
const LINDEN = { lat: 6.0011, lng: -58.3079 };   // ~90 km away

function twoPartyBarrier() {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await released;
  };
}

let app: FastifyInstance;
const userIds: string[] = [];
const createdTenantIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Queue',
      lastName: `U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    } as never,
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'queue-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, sessionId: session.id };
}

async function makeDriver(at = GT, tenantId?: string) {
  const owned = await makeUserWithSession(
    ['MOVER', 'CUSTOMER'],
    'MOVER',
    tenantId ? { tenantId } : {},
  );
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2019, vehicleColor: 'Silver',
      licensePlate: `HQ 10${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isAvailable: true, isOnline: true, currentLat: at.lat, currentLng: at.lng,
      lastLocationUpdate: new Date(), locationSessionId: owned.sessionId,
    } as never,
  });
  return { ...owned, driverId: driver.id };
}

const join = (token: string, overrides: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/rides/queue/join',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {
      pickup: GT,
      dropoff: { lat: 6.8143, lng: -58.1443 },
      pickupAddress: 'Stabroek Market',
      dropoffAddress: 'Camp Street',
      rideClass: 'ECONOMY',
      passengerCount: 1,
      ...overrides,
    },
  });

const getQueue = (token: string) =>
  app.inject({ method: 'GET', url: '/api/v1/rides/queue', headers: { authorization: `Bearer ${token}` } });

function scanDeps() {
  const dispatch = makeDispatchService(app);
  return {
    fare: new FareService(app.prisma),
    dispatch,
    notifications: new NotificationService(app.prisma, app.io),
  };
}

const runScan = () => runWithoutTenant(async () => {
  const { fare, dispatch, notifications } = scanDeps();
  return scanRideQueue({ prisma: app.prisma }, fare, dispatch, notifications);
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['RIDE_QUEUE_DISABLED'];

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    if (userIds.length) {
      await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: userIds } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
      await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (createdTenantIds.length) {
      await app.prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
  });
  await app.close();
});

describe('queue gates (mirror the request path — failure first)', () => {
  it('rejects an L1 customer exactly like the request route', async () => {
    const l1 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L1' });
    const res = await join(l1.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ID_VERIFICATION_REQUIRED');
  });

  // [Owner ruling 16 Oct 2026 — CUSTOMERS TAKE NO PHOTOS] The queue mirrors the request path, which
  // no longer asks a customer for a photo: an L2 customer with no signup selfie joins like any other
  // (the ID on file is the only identity gate, the L1 case above).
  it('admits a customer with no signup selfie (customers take no photos), never SELFIE_REQUIRED', async () => {
    const noSelfie = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', { selfieCapturedAt: null });
    const res = await join(noSelfie.token);
    expect(res.json().error?.code).not.toBe('SELFIE_REQUIRED');
    expect(res.statusCode).toBe(201);
    // Cleanup: leave, so later position and scan assertions start from an empty queue.
    await app.prisma.rideQueueEntry.updateMany({ where: { customerId: noSelfie.userId }, data: { status: 'LEFT' } });
  });

  it('rejects joining with a ride already active', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.order.create({
      data: {
        orderNumber: `Q-ACT-${seq}`, orderType: 'TAXI', customerId: c.userId, status: 'DRIVER_EN_ROUTE',
        pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng,
        deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1000, subtotalMarkup: 0,
        subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      } as never,
    });
    const res = await join(c.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RIDE_IN_PROGRESS');
  });
});

describe('join / position / leave', () => {
  it('joins with derived position, second customer queues behind, re-join replaces, leave is idempotent', async () => {
    const a = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const b = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const ra = await join(a.token);
    expect(ra.statusCode).toBe(201);
    expect(ra.json().data.position).toBe(1);
    expect(ra.json().data.suppliersOnline).toBeTypeOf('number');

    const rb = await join(b.token);
    expect(rb.json().data.position).toBe(2);

    // Re-join replaces (newest trip wins) — position resets to the back.
    const ra2 = await join(a.token, { dropoffAddress: 'Giftland Mall' });
    expect(ra2.json().data.position).toBe(2);
    const stillOne = await app.prisma.rideQueueEntry.count({ where: { customerId: a.userId, status: 'WAITING' } });
    expect(stillOne).toBe(1);

    // GET reflects the live entry; leave empties it; a second leave is a no-op.
    const g = await getQueue(a.token);
    expect(g.json().data.position).toBe(2);
    const leave = await app.inject({
      method: 'POST', url: '/api/v1/rides/queue/leave',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, payload: {},
    });
    expect(leave.statusCode).toBe(200);
    const g2 = await getQueue(a.token);
    expect(g2.json().data).toBeNull();
    const leaveAgain = await app.inject({
      method: 'POST', url: '/api/v1/rides/queue/leave',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, payload: {},
    });
    expect(leaveAgain.statusCode).toBe(200);

    // Cleanup B's entry so later scans aren't polluted.
    await app.prisma.rideQueueEntry.updateMany({ where: { customerId: b.userId }, data: { status: 'LEFT' } });
  });

  it('GET /rides/supply returns honest counts with the availability bucket', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rides/supply?lat=${GT.lat}&lng=${GT.lng}`,
      headers: { authorization: `Bearer ${c.token}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.online).toBeTypeOf('number');
    expect(d.busy).toBeTypeOf('number');
    expect(['GOOD', 'LOW', 'NONE']).toContain(d.level);
  });
});

describe('the scan', () => {
  it('[REVIEW-G #2022 S4-3] supply for a queued ride is a car that can take THAT ride: its class and its party', async () => {
    const ANNA = { lat: 7.264, lng: -58.5013 }; // Anna Regina: a field no other test uses
    const dropoff = { lat: 7.274, lng: -58.5113 };
    // 1) A COMFORT ride; the only car near is an ECONOMY car (never offered a COMFORT ride).
    const comfort = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const { tenantId } = await app.prisma.user.findUniqueOrThrow({ where: { id: comfort.userId }, select: { tenantId: true } });
    const area = () => runWithoutTenant(() => scanDeps().dispatch.getAvailability('DRIVER', ANNA, 0, tenantId));
    const economyCar = await makeDriver(ANNA);
    expect((await join(comfort.token, { pickup: ANNA, pickupAddress: 'Anna Regina market', dropoff, rideClass: 'COMFORT' })).statusCode).toBe(201);
    expect((await area()).level).not.toBe('NONE'); // precondition: that car IS area supply
    await runScan();
    expect((await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: comfort.userId } })).status).toBe('WAITING');
    expect(await app.prisma.order.count({ where: { customerId: comfort.userId, orderType: 'TAXI' } })).toBe(0);
    // Control: a COMFORT car arrives -> the same entry is requested.
    const comfortCar = await makeDriver(ANNA);
    await app.prisma.driver.update({ where: { id: comfortCar.driverId }, data: { rideClass: 'COMFORT' } as never });
    await runScan();
    expect((await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: comfort.userId } })).status).toBe('MATCHED');
    await app.prisma.order.updateMany({ where: { customerId: comfort.userId }, data: { status: 'CANCELLED' } });
    await app.prisma.driver.updateMany({ where: { id: { in: [economyCar.driverId, comfortCar.driverId] } }, data: { isOnline: false, isAvailable: false } });

    // 2) A party of 4; the only car near seats 3.
    const party = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const small = await makeDriver(ANNA);
    await app.prisma.driver.update({ where: { id: small.driverId }, data: { vehicleCapacity: 3 } });
    expect((await join(party.token, { pickup: ANNA, pickupAddress: 'Anna Regina market', dropoff, passengerCount: 4 })).statusCode).toBe(201);
    expect((await area()).level).not.toBe('NONE');
    await runScan();
    expect((await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: party.userId } })).status).toBe('WAITING');
    // Control: a car that seats 4 -> requested.
    const four = await makeDriver(ANNA);
    await runScan();
    expect((await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: party.userId } })).status).toBe('MATCHED');
    await app.prisma.order.updateMany({ where: { customerId: party.userId }, data: { status: 'CANCELLED' } });
    await app.prisma.driver.updateMany({ where: { id: { in: [small.driverId, four.driverId] } }, data: { isOnline: false, isAvailable: false } });
  });

  it('contains FIFO, supply, worker dispatch, and created orders within each tenant', async () => {
    const spot = { lat: 5.22, lng: -59.31 }; // isolated from every other fixture
    const otherTenant = await app.prisma.tenant.create({
      data: { name: 'Queue Other Operator', slug: `queue-other-${nanoid(6).toLowerCase()}` },
    });
    createdTenantIds.push(otherTenant.id);

    const foreignDriver = await runWithoutTenant(async () => makeDriver(spot, otherTenant.id));
    const localCustomer = await runWithoutTenant(async () => makeUserWithSession(['CUSTOMER'], 'CUSTOMER'));
    const foreignCustomer = await runWithoutTenant(async () => makeUserWithSession(
      ['CUSTOMER'],
      'CUSTOMER',
      { tenantId: otherTenant.id },
    ));
    const trip = {
      pickup: spot,
      pickupAddress: 'Tenant Boundary Pickup',
      dropoff: { lat: spot.lat + 0.02, lng: spot.lng + 0.02 },
      dropoffAddress: 'Tenant Boundary Dropoff',
    };

    // The only nearby driver belongs to the foreign operator. The default
    // customer sees neither that supply nor the foreign customer's FIFO row.
    const localJoin = await join(localCustomer.token, trip);
    expect(localJoin.statusCode).toBe(201);
    expect(localJoin.json().data).toMatchObject({ position: 1, suppliersOnline: 0 });

    const foreignJoin = await join(foreignCustomer.token, trip);
    expect(foreignJoin.statusCode).toBe(201);
    expect(foreignJoin.json().data).toMatchObject({ position: 1, suppliersOnline: 1 });

    const before = await runWithoutTenant(async () => Promise.all([
      app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: localCustomer.userId } }),
      app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: foreignCustomer.userId } }),
    ]));
    expect(before.map((entry) => entry.tenantId)).toEqual(['swift-default', otherTenant.id]);

    const scanned = await runScan();
    expect(scanned.matched).toBe(1);

    const [localEntry, foreignEntry] = await runWithoutTenant(async () => Promise.all([
      app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: localCustomer.userId } }),
      app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: foreignCustomer.userId } }),
    ]));
    expect(localEntry.status).toBe('WAITING');
    expect(localEntry.matchedOrderId).toBeNull();
    expect(foreignEntry.status).toBe('MATCHED');
    expect(foreignEntry.matchedOrderId).toBeTruthy();

    const foreignOrder = await runWithoutTenant(async () => app.prisma.order.findUniqueOrThrow({
      where: { id: foreignEntry.matchedOrderId! },
    }));
    expect(foreignOrder.tenantId).toBe(otherTenant.id);
    expect(foreignOrder.customerId).toBe(foreignCustomer.userId);
    await expect(runWithoutTenant(async () => scanDeps().dispatch.dispatchOrder(
      foreignOrder.id,
      'swift-default',
    ))).rejects.toMatchObject({ code: 'DISPATCH_TENANT_MISMATCH' });
    expect(await runWithoutTenant(async () => app.prisma.order.count({
      where: { customerId: localCustomer.userId },
    }))).toBe(0);

    await runWithoutTenant(async () => {
      await app.prisma.rideQueueEntry.updateMany({
        where: { id: localEntry.id, tenantId: 'swift-default' },
        data: { status: 'LEFT' },
      });
      await app.prisma.order.update({
        where: { id: foreignOrder.id },
        data: { status: 'CANCELLED' },
      });
      await app.prisma.driver.update({
        where: { id: foreignDriver.driverId },
        data: { isOnline: false, isAvailable: false },
      });
      await app.redis.del(
        `dispatch:offer:${foreignOrder.id}`,
        `dispatch:mover-offer:${foreignDriver.driverId}`,
        `dispatch:round:${foreignOrder.id}`,
        `dispatch:declined:${foreignOrder.id}`,
      );
    });
  });

  it('leaves entries WAITING when no drivers are near their pickup', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await join(c.token, { pickup: LINDEN, pickupAddress: 'Linden Market' });
    expect(res.statusCode).toBe(201);

    const before = await runScan();
    const entry = await app.prisma.rideQueueEntry.findFirst({ where: { customerId: c.userId } });
    expect(entry?.status).toBe('WAITING');
    expect(before.matched).toBe(0);

    await app.prisma.rideQueueEntry.updateMany({ where: { customerId: c.userId }, data: { status: 'LEFT' } });
  });

  // [TAXI-FLOW 22 Oct 2026] The owner booked and drove with ONE account: he
  // joined the queue in customer mode, switched to driver and went online, and
  // the scan counted HIS OWN car as supply — it auto-created a ride that
  // dispatch (which never offers a ride to its booker) could never fill, and
  // the phone said "Finding you a driver" for half an hour.
  it('never counts the queued customer’s OWN driver profile as supply', async () => {
    const FIELD = { lat: 5.1751, lng: -59.4802 }; // Kaieteur: a field no other suite uses
    const dual = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'CUSTOMER');
    // 1) Customer mode, nobody online: they join the queue.
    const joined = await join(dual.token, { pickup: FIELD, pickupAddress: 'Kaieteur airstrip', dropoff: { lat: 5.1851, lng: -59.4902 } });
    expect(joined.statusCode).toBe(201);
    // 2) The same account switches to driver mode and goes online right at
    //    the pickup — exactly what makeDriver's real drivers look like
    //    (activeRole MOVER, fresh fix, bound location session).
    await app.prisma.user.update({ where: { id: dual.userId }, data: { activeRole: 'MOVER' } });
    const own = await app.prisma.driver.create({
      data: {
        userId: dual.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2019, vehicleColor: 'Silver',
        licensePlate: `HQ 20${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
        isAvailable: true, isOnline: true, currentLat: FIELD.lat, currentLng: FIELD.lng,
        lastLocationUpdate: new Date(), locationSessionId: dual.sessionId,
      } as never,
    });
    // Precondition (keeps the test honest): that car IS live supply to anyone
    // else — the anonymous area read counts it.
    const { tenantId } = await app.prisma.user.findUniqueOrThrow({ where: { id: dual.userId }, select: { tenantId: true } });
    const area = await runWithoutTenant(() => scanDeps().dispatch.getAvailability('DRIVER', FIELD, 0, tenantId));
    expect(area.level).not.toBe('NONE');

    const result = await runScan();
    const entry = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: dual.userId } });
    expect(entry.status).toBe('WAITING');
    expect(entry.matchedOrderId).toBeNull();
    expect(await app.prisma.order.count({ where: { customerId: dual.userId, orderType: 'TAXI' } })).toBe(0);
    expect(result.matched).toBe(0);

    // Control: a DIFFERENT driver in the same field is real supply — the same
    // entry is auto-requested on the next scan, so only the booker was excluded.
    await makeDriver(FIELD);
    const next = await runScan();
    expect(next.matched).toBe(1);
    const matched = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: dual.userId } });
    expect(matched.status).toBe('MATCHED');

    // The waiting ride tells the phone its search state (additive keys on
    // GET /rides/active): nothing came back empty yet, and when the slow lane
    // would release it — placement + TAXI_WAIT_LIMIT_MIN (30 by default).
    const ride = await app.prisma.order.findUniqueOrThrow({ where: { id: matched.matchedOrderId! } });
    const activeOf = async () => (await app.inject({
      method: 'GET', url: '/api/v1/rides/active', headers: { authorization: `Bearer ${dual.token}` },
    })).json().data;
    const waiting = await activeOf();
    expect(waiting.id).toBe(ride.id);
    expect(waiting.noDriverFound).toBe(false);
    expect(Date.parse(waiting.searchReleaseAt) - ride.placedAt.getTime()).toBe(30 * 60_000);
    // A search came back empty: the phone may stop showing a bare spinner.
    await app.prisma.dispatchSearch.create({
      data: { vertical: 'TAXI', subjectType: 'ORDER', subjectId: ride.id, status: 'EXHAUSTED', wave: 3, radiusKm: 15, exhaustedAt: new Date(), resolution: 'RETRIED' },
    });
    expect((await activeOf()).noDriverFound).toBe(true);
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: ride.id } });
    await app.prisma.order.updateMany({ where: { customerId: dual.userId }, data: { status: 'CANCELLED' } });
    await app.prisma.driver.update({ where: { id: own.id }, data: { isOnline: false, isAvailable: false } });
  });

  it('[REVIEW-F S3-1] the no-driver fact counts only searches since the latest driver took the ride; a held MMG ride promises no release time', async () => {
    // A waiting ride, made the real way (queue -> scan -> request core).
    const BARTICA = { lat: 6.4067, lng: -58.6214 }; // a field no other test uses
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const d = await makeDriver(BARTICA);
    expect((await join(c.token, { pickup: BARTICA, pickupAddress: 'Bartica stelling', dropoff: { lat: 6.4167, lng: -58.6314 } })).statusCode).toBe(201);
    await runScan();
    const entry = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId } });
    expect(entry.status).toBe('MATCHED');
    await app.prisma.driver.update({ where: { id: d.driverId }, data: { isOnline: false, isAvailable: false } });
    const ride = await app.prisma.order.findUniqueOrThrow({ where: { id: entry.matchedOrderId! } });
    expect(ride.status).toBe('PENDING');
    expect(ride.driverId).toBeNull();
    const active = async () => (await app.inject({
      method: 'GET', url: '/api/v1/rides/active', headers: { authorization: `Bearer ${c.token}` },
    })).json().data;
    const cancelFacts = (r: any) => ({
      canCancel: r.canCancel, freeCancellationExpiresAt: r.freeCancellationExpiresAt,
      cancellationMessage: r.cancellationMessage, cancelUnavailable: r.cancelUnavailable,
    });
    const at = (msAfterPlacement: number) => new Date(ride.placedAt.getTime() + msAfterPlacement);
    const exhausted = (startedAt: Date, resolution: string | null) => app.prisma.dispatchSearch.create({
      data: { vertical: 'TAXI', subjectType: 'ORDER', subjectId: ride.id, status: 'EXHAUSTED', wave: 3, radiusKm: 15, startedAt, exhaustedAt: new Date(startedAt.getTime() + 20_000), resolution },
    });

    // (c) control: two empty searches (a re-sweep RETRIED the first), never
    // assigned -> the honest card stays up (no flicker between re-sweeps).
    await exhausted(at(1_000), 'RETRIED');
    await exhausted(at(61_000), null);
    // Any other status record (here a later PENDING note) is not a driver
    // taking the ride: it moves no boundary.
    await app.prisma.orderStatusLog.create({ data: { orderId: ride.id, status: 'PENDING', changedBy: 'system', note: 'test: not an assignment', createdAt: at(90_000) } });
    const before = await active();
    expect(before.noDriverFound).toBe(true);
    // A search that STARTED before the driver took the ride and ended empty
    // after (exhaustedAt 130 s) belongs to the old search, not the new one.
    await exhausted(at(110_000), 'RETRIED');

    // (a) A driver then TOOK the ride (the claim's append-only record) and
    // dropped it (back to PENDING, no driver). The old empty searches say
    // nothing about the search now running for a new driver.
    await app.prisma.orderStatusLog.create({ data: { orderId: ride.id, status: 'DRIVER_ASSIGNED', changedBy: 'test-driver', note: 'Mover accepted the job', createdAt: at(120_000) } });
    await app.prisma.orderStatusLog.create({ data: { orderId: ride.id, status: 'PENDING', changedBy: 'test-driver', note: 'Driver cancelled: test', createdAt: at(180_000) } });
    const rematching = await active();
    expect(rematching.noDriverFound).toBe(false);
    // (d) the cancel verdict (a fee rule) is NOT this fact: unchanged.
    expect(cancelFacts(rematching)).toEqual(cancelFacts(before));

    // (b) The re-dispatch's own search comes back empty -> the card again.
    await exhausted(at(181_000), null);
    expect((await active()).noDriverFound).toBe(true);

    // (e) [REVIEW-G #2030 S4-1] A SECOND driver takes it and drops it: the
    // boundary is the LATEST claim, so that 181 s empty search no longer
    // counts (an earliest-claim rule would still count it)...
    await app.prisma.orderStatusLog.create({ data: { orderId: ride.id, status: 'DRIVER_ASSIGNED', changedBy: 'test-driver-2', note: 'Mover accepted the job', createdAt: at(240_000) } });
    await app.prisma.orderStatusLog.create({ data: { orderId: ride.id, status: 'PENDING', changedBy: 'test-driver-2', note: 'Driver cancelled: test', createdAt: at(300_000) } });
    expect((await active()).noDriverFound).toBe(false);
    // ...until the search after that comes back empty.
    await exhausted(at(301_000), null);
    expect((await active()).noDriverFound).toBe(true);

    // [REVIEW-F S4-3] A ride recorded as paid by MMG is HELD for a person at
    // the wait limit, never released on its own: no release time is promised.
    expect(typeof (await active()).searchReleaseAt).toBe('string');
    await app.prisma.order.update({ where: { id: ride.id }, data: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' } as never });
    const held = await active();
    expect(held.id).toBe(ride.id);
    expect(held.searchReleaseAt ?? null).toBeNull();
    expect(held.noDriverFound).toBe(true);

    // Cleanup: back to the unpaid cash ride it was (a paid-MMG cancel needs a
    // refund obligation, rightly refused by the database).
    await app.prisma.order.update({ where: { id: ride.id }, data: { paymentMethod: ride.paymentMethod, paymentStatus: ride.paymentStatus } as never });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: ride.id } });
    await app.prisma.order.updateMany({ where: { customerId: c.userId }, data: { status: 'CANCELLED' } });
  });

  it('[REVIEW-G S4-2] the supply FOR a customer also leaves out a driver they blocked (the same pair rule dispatch applies)', async () => {
    const LETHEM = { lat: 3.3803, lng: -59.7968 }; // a field no other test uses
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const only = await makeDriver(LETHEM);
    const { tenantId } = await app.prisma.user.findUniqueOrThrow({ where: { id: c.userId }, select: { tenantId: true } });
    const block = await app.prisma.userBlock.create({ data: { tenantId, blockerId: c.userId, blockedId: only.userId, reason: 'test' } });
    expect((await join(c.token, { pickup: LETHEM, pickupAddress: 'Lethem market', dropoff: { lat: 3.3903, lng: -59.8068 } })).statusCode).toBe(201);
    // Precondition: that car IS supply to anyone else.
    const area = await runWithoutTenant(() => scanDeps().dispatch.getAvailability('DRIVER', LETHEM, 0, tenantId));
    expect(area.level).not.toBe('NONE');
    // The only car near is one this customer blocked: no ride nobody can fill.
    await runScan();
    const waiting = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId } });
    expect(waiting.status).toBe('WAITING');
    expect(await app.prisma.order.count({ where: { customerId: c.userId, orderType: 'TAXI' } })).toBe(0);
    // Control: the block lifted, the same entry is auto-requested.
    await app.prisma.userBlock.update({ where: { id: block.id }, data: { unblockedAt: new Date() } });
    await runScan();
    const matched = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId } });
    expect(matched.status).toBe('MATCHED');
    await app.prisma.userBlock.deleteMany({ where: { id: block.id } });
    await app.prisma.order.updateMany({ where: { customerId: c.userId }, data: { status: 'CANCELLED' } });
    await app.prisma.driver.update({ where: { id: only.driverId }, data: { isOnline: false, isAvailable: false } });
  });

  it('auto-requests the FIFO head through the REAL request core when a driver frees up', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await makeDriver(GT); // one free driver in Georgetown

    const joined = await join(c.token);
    expect(joined.statusCode).toBe(201);

    const result = await runScan();
    expect(result.matched).toBe(1);

    const entry = await app.prisma.rideQueueEntry.findFirst({ where: { customerId: c.userId } });
    expect(entry?.status).toBe('MATCHED');
    expect(entry?.matchedOrderId).toBeTruthy();

    // The ride is REAL — created through the same core the route uses.
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: entry!.matchedOrderId! } });
    expect(order.orderType).toBe('TAXI');
    expect(order.status).toBe('PENDING');
    expect(order.pickupAddress).toBe('Stabroek Market');
    expect(order.taxiDropoffAddress).toBe('Camp Street');
    expect(Number(order.taxiFareTotal)).toBeGreaterThan(0);
    expect(order.ridePin).toMatch(/^\d{6}$/);

    // The customer was told, with the deep-link payload.
    const note = await app.prisma.notification.findFirst({
      where: { userId: c.userId, data: { path: ['kind'], equals: 'ride_queue_matched' } },
    });
    expect(note).toBeTruthy();

    // A second scan is idempotent — the entry is already MATCHED.
    const again = await runScan();
    expect(again.matched).toBe(0);

    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  });

  it('marks the entry LEFT when the customer already got their own ride meanwhile', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await join(c.token);
    // They hail a ride themselves before the scan fires.
    await app.prisma.order.create({
      data: {
        orderNumber: `Q-SELF-${seq}`, orderType: 'TAXI', customerId: c.userId, status: 'PENDING',
        pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng,
        deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1000, subtotalMarkup: 0,
        subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      } as never,
    });

    await runScan();
    const entry = await app.prisma.rideQueueEntry.findFirst({
      where: { customerId: c.userId }, orderBy: { createdAt: 'desc' },
    });
    expect(entry?.status).toBe('LEFT');
    await app.prisma.order.updateMany({ where: { customerId: c.userId }, data: { status: 'CANCELLED' } });
  });

  it('serializes a queue auto-hail racing a manual hail into one active ride', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const queued = await join(c.token);
    expect(queued.statusCode).toBe(201);
    // [PRICE-LOCK · row 448] The entry keeps the fare at the join; the racing
    // quote below answers that same fare, so only the race is under test.
    const kept = Number((await app.prisma.rideQueueEntry.findFirstOrThrow({
      where: { customerId: c.userId, status: 'WAITING' },
    })).quotedFare);

    // Both callers must finish the real pre-flight active-order read before
    // either can enter creation. This is an arrival barrier, not a sleep: on
    // the unfixed source both transactions then commit distinct TAXI rows.
    const atFareBarrier = twoPartyBarrier();
    const racingFare = {
      estimateTiers: vi.fn(async () => {
        await atFareBarrier();
        return {
          tiers: [{ rideClass: 'ECONOMY', fare: kept, capacity: 4, source: 'formula' }],
          currencyCode: 'GYD',
          distanceKm: 4,
          durationMin: 12,
          billableKm: 4,
          routeSource: 'haversine',
        };
      }),
    } as unknown as FareService;
    const dispatch = {
      getAvailability: vi.fn(async () => ({ level: 'GOOD', nearestEtaMinutes: 2 })),
      dispatchOrder: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof makeDispatchService>;
    const notifications = {
      send: vi.fn(async () => undefined),
    } as unknown as NotificationService;
    const dispatchAdd = vi.fn(async () => undefined);
    const requestApp = {
      prisma: app.prisma,
      dispatchQueue: { add: dispatchAdd },
    } as unknown as RideRequestApp;
    const trip = {
      pickup: GT,
      dropoff: { lat: 6.8143, lng: -58.1443 },
      pickupAddress: 'Stabroek Market',
      dropoffAddress: 'Camp Street',
      rideClass: 'ECONOMY' as const,
      passengerCount: 1,
    };

    // Remove the unique display number as an accidental race arbiter. Each
    // creation receives a distinct deterministic suffix while persistence,
    // customer locking and active-order reads remain real PostgreSQL calls.
    const random = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1).mockReturnValueOnce(0.1).mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.8).mockReturnValueOnce(0.8).mockReturnValueOnce(0.8);
    let scanResult: PromiseSettledResult<{ expired: number; matched: number }>;
    let manualResult: PromiseSettledResult<Awaited<ReturnType<typeof createRideRequest>>>;
    try {
      [scanResult, manualResult] = await runWithoutTenant(async () => Promise.allSettled([
        scanRideQueue(requestApp, racingFare, dispatch, notifications, 1),
        createRideRequest(requestApp, racingFare, dispatch, c.userId, trip),
      ]));
    } finally {
      random.mockRestore();
    }

    expect(scanResult.status).toBe('fulfilled');
    const active = await runWithoutTenant(async () => app.prisma.order.findMany({
      where: {
        customerId: c.userId,
        orderType: 'TAXI',
        status: { in: ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'] },
      },
      select: { id: true },
    }));
    expect(active).toHaveLength(1);
    expect(await runWithoutTenant(async () => app.prisma.orderStatusLog.count({
      where: { orderId: active[0]!.id, status: 'PENDING' },
    }))).toBe(1);
    expect(dispatchAdd).toHaveBeenCalledTimes(1);

    const entry = await runWithoutTenant(async () => app.prisma.rideQueueEntry.findFirstOrThrow({
      where: { customerId: c.userId },
      orderBy: { createdAt: 'desc' },
    }));
    if (manualResult.status === 'rejected') {
      expect(manualResult.reason).toMatchObject({ code: 'RIDE_IN_PROGRESS' });
      expect(scanResult).toMatchObject({ status: 'fulfilled', value: { matched: 1 } });
      expect(entry).toMatchObject({ status: 'MATCHED', matchedOrderId: active[0]!.id });
    } else {
      expect(scanResult).toMatchObject({ status: 'fulfilled', value: { matched: 0 } });
      expect(entry).toMatchObject({ status: 'LEFT', matchedOrderId: null });
      expect(manualResult.value.order.id).toBe(active[0]!.id);
    }

    await runWithoutTenant(async () => {
      await app.prisma.rideQueueEntry.updateMany({
        where: { customerId: c.userId },
        data: { status: 'LEFT' },
      });
      await app.prisma.order.updateMany({
        where: { customerId: c.userId },
        data: { status: 'CANCELLED' },
      });
    });
  });

  it('expires a stale entry once, with ONE re-request push carrying the trip', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await join(c.token);
    await app.prisma.rideQueueEntry.updateMany({
      where: { customerId: c.userId, status: 'WAITING' },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const first = await runScan();
    expect(first.expired).toBe(1);
    const entry = await app.prisma.rideQueueEntry.findFirst({ where: { customerId: c.userId } });
    expect(entry?.status).toBe('EXPIRED');

    const pushes = await app.prisma.notification.findMany({
      where: { userId: c.userId, data: { path: ['kind'], equals: 'ride_queue_expired' } },
    });
    expect(pushes.length).toBe(1);
    expect((pushes[0]!.data as { dropoff?: { address?: string } }).dropoff?.address).toBe('Camp Street');

    // Second scan: nothing left to expire, no second push.
    const second = await runScan();
    expect(second.expired).toBe(0);
    const pushesAfter = await app.prisma.notification.count({
      where: { userId: c.userId, data: { path: ['kind'], equals: 'ride_queue_expired' } },
    });
    expect(pushesAfter).toBe(1);
  });

  it('honors the kill switch', async () => {
    process.env['RIDE_QUEUE_DISABLED'] = '1';
    const res = await runScan();
    expect(res).toEqual({ expired: 0, matched: 0 });
    delete process.env['RIDE_QUEUE_DISABLED'];
  });
});

// [PRICE-LOCK · row 448 · owner: the price shown is the price charged] The queue books a
// ride up to RIDE_QUEUE_TTL_MIN after the passenger looked. With the fare they
// were shown (expectedFare at join), the entry keeps it and the scan books only
// at it; a fare that moved by then is never charged — nothing is booked, the
// entry ends, and the passenger is asked again with the trip one tap away. An
// app from before the lock sends no fare and is queued and booked as before.
describe('[PRICE-LOCK] a queued ride is booked only at the fare the passenger was shown', () => {
  const CAMP = { lat: 6.8143, lng: -58.1443 };
  async function shownFare(token: string) {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rides/estimate',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { pickup: GT, dropoff: CAMP },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data.tiers as { rideClass: string; fare: number }[]).find((t) => t.rideClass === 'ECONOMY')!.fare;
  }
  /** Only this passenger waits, so the scan's per-area budget is theirs. */
  const aloneInLine = (userId: string) => app.prisma.rideQueueEntry.updateMany({
    where: { customerId: { in: userIds.filter((id) => id !== userId) }, status: 'WAITING' },
    data: { status: 'LEFT' },
  });

  it('joining with the fare on screen keeps it, and the scan books the ride at exactly that fare', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const fare = await shownFare(c.token);
    const joined = await join(c.token, { expectedFare: fare });
    expect(joined.statusCode, joined.body).toBe(201);
    const entry = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId, status: 'WAITING' } });
    expect(Number(entry.quotedFare)).toBe(fare);

    await aloneInLine(c.userId);
    await makeDriver(GT);
    expect((await runScan()).matched).toBe(1);
    const matched = await app.prisma.rideQueueEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(matched.status).toBe('MATCHED');
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: matched.matchedOrderId! } });
    expect([Number(order.taxiFareTotal), Number(order.totalAmount)]).toEqual([fare, fare]);
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  });

  it('a fare that already moved is refused at the join with the fare now, and nothing is queued', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const fare = await shownFare(c.token);
    const res = await join(c.token, { expectedFare: fare + 100 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'FARE_CHANGED', details: { expectedFare: fare + 100, fare, rideClass: 'ECONOMY' } });
    expect(await app.prisma.rideQueueEntry.count({ where: { customerId: c.userId } })).toBe(0);
  });

  it('a fare that moves while they wait is never charged: nothing is booked, the entry ends, and they are asked again with the new fare', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const fare = await shownFare(c.token);
    expect((await join(c.token, { expectedFare: fare })).statusCode).toBe(201);
    // The market's card changes while they wait.
    const restore = await pinLegacyGuyanaTaxiCard(app.prisma);
    try {
      const fareNow = await shownFare(c.token);
      expect(fareNow).not.toBe(fare);
      await aloneInLine(c.userId);
      await makeDriver(GT);
      expect((await runScan()).matched).toBe(0);
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
      const entry = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId } });
      expect([entry.status, entry.matchedOrderId]).toEqual(['EXPIRED', null]);
      // The row records that they were told, like every other ended entry.
      expect(entry.expiredNotifiedAt).not.toBeNull();
      const note = await app.prisma.notification.findFirstOrThrow({
        where: { userId: c.userId, data: { path: ['kind'], equals: 'ride_queue_expired' } },
      });
      expect(note.title).toBe('The fare to Camp Street changed');
      const gyd = (n: number) => formatMoney(n, 'GYD', { code: true, whole: true });
      expect(note.body).toContain(`the fare is now ${gyd(fareNow)}, not the ${gyd(fare)} you joined at`);
      expect(note.body).toContain('Nothing was booked');
      // The next scan leaves it alone: one question, never a second.
      await runScan();
      expect(await app.prisma.notification.count({ where: { userId: c.userId, data: { path: ['kind'], equals: 'ride_queue_expired' } } })).toBe(1);
    } finally {
      await restore();
    }
  });

  // Every store build today joins without the fare: the entry keeps the fare of
  // the join (the one their screen was quoted), so the wait never moves it.
  it('an app from before the lock sends no fare: the entry keeps the fare at the join, and the scan books at exactly that fare', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const fare = await shownFare(c.token);
    expect((await join(c.token)).statusCode).toBe(201);
    const entry = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId, status: 'WAITING' } });
    expect(Number(entry.quotedFare)).toBe(fare);
    await aloneInLine(c.userId);
    await makeDriver(GT);
    expect((await runScan()).matched).toBe(1);
    const order = await app.prisma.order.findFirstOrThrow({ where: { customerId: c.userId } });
    expect(Number(order.taxiFareTotal)).toBe(fare);
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  });

  it('an app from before the lock: a fare that moves while they wait is never charged either', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const fare = await shownFare(c.token);
    expect((await join(c.token)).statusCode).toBe(201);
    const restore = await pinLegacyGuyanaTaxiCard(app.prisma);
    try {
      const fareNow = await shownFare(c.token);
      expect(fareNow).not.toBe(fare);
      await aloneInLine(c.userId);
      await makeDriver(GT);
      expect((await runScan()).matched).toBe(0);
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
      const entry = await app.prisma.rideQueueEntry.findFirstOrThrow({ where: { customerId: c.userId } });
      expect([entry.status, entry.matchedOrderId]).toEqual(['EXPIRED', null]);
      const note = await app.prisma.notification.findFirstOrThrow({
        where: { userId: c.userId, data: { path: ['kind'], equals: 'ride_queue_expired' } },
      });
      const gyd = (n: number) => formatMoney(n, 'GYD', { code: true, whole: true });
      expect(note.body).toContain(`the fare is now ${gyd(fareNow)}, not the ${gyd(fare)} you joined at`);
    } finally {
      await restore();
    }
  });

  it('an entry from before the migration has no fare: booked at the scan-time fare as before', async () => {
    const c = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const fare = await shownFare(c.token);
    expect((await join(c.token)).statusCode).toBe(201);
    await app.prisma.rideQueueEntry.updateMany({ where: { customerId: c.userId, status: 'WAITING' }, data: { quotedFare: null } });
    await aloneInLine(c.userId);
    await makeDriver(GT);
    expect((await runScan()).matched).toBe(1);
    const order = await app.prisma.order.findFirstOrThrow({ where: { customerId: c.userId } });
    expect(Number(order.taxiFareTotal)).toBe(fare);
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  });
});
