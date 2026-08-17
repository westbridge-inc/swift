import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { scanRideQueue } from '../modules/rides/queue.service';
import { FareService } from '../modules/rides/fare.service';
import { makeDispatchService } from '../modules/dispatch/dispatch.service';
import { NotificationService } from '../modules/notification/notification.service';

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

  it('rejects a customer with no signup selfie', async () => {
    const noSelfie = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', { selfieCapturedAt: null });
    const res = await join(noSelfie.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SELFIE_REQUIRED');
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
