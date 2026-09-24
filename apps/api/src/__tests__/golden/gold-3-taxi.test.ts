import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { ridesRoutes } from '../../modules/rides/rides.routes';
import { driverRoutes } from '../../modules/driver/driver.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { FareService } from '../../modules/rides/fare.service';
import { scanRideQueue } from '../../modules/rides/queue.service';
import { makeDispatchService } from '../../modules/dispatch/dispatch.service';
import { NotificationService } from '../../modules/notification/notification.service';
import { ACCESS_COOKIE, resetBrowserOriginsForTests } from '../../modules/auth/browser-session';
import { recordDispatchQueue } from '../helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// GOLD-3 · TAXI-01..05 — the taxi journey, end to end through the REAL mounted
// rides + driver (+ admin, for the claim) routes as real sessions, asserted
// on durable rows:
//
//   TAXI-01  no supply → the queue waits honestly; the worker's scan
//            auto-requests through the real core when a driver comes online.
//            An L2 customer books at exactly the quoted fare and the online
//            driver is offered the ride; an L1 customer is refused; a second
//            live request is refused.
//   TAXI-02  accept → en-route → arrived, one durable transition each, the
//            arrival written beside the driver's own fix; strangers refused;
//            two drivers racing = one winner; a pre-pickup driver cancel frees
//            the driver, rotates the PIN and another driver takes the ride.
//   TAXI-03  PIN: wrong PIN refused with the budget left, the right PIN
//            verifies, the bare complete is refused, "fare collected" closes
//            it in one commit and replays; two simultaneous fare taps pay once;
//            five wrong PINs lock even the right PIN until a cancel rotates it.
//   TAXI-04  a fare outcome without GPS is refused; no-show fails the ride,
//            strikes the passenger and auto-approves the driver's guarantee
//            claim in one commit, the replay answers the same claim, and the
//            driver cannot settle it. The settlement itself — an admin paying
//            it from the funded reserve through the real two-person approval —
//            is G3-F1 below.
//   TAXI-05  a verified browser-cookie session cannot book or queue (#1271);
//            the mobile bearer keeps booking, whatever client label it sends.
//
//   G3-F1    an admin sees and settles a DRIVER's guarantee claim (fixed by
//            #1293: the admin claim scope now includes the tenant's drivers).
//
// Dispatch runs through the suite's acknowledged route→worker double
// (helpers/dispatch-queue.ts); the queue scan is the worker's own function.
// Fixture range: +5920333nnn (this file only). Zones: georgetown-central →
// georgetown-south, whose seeded fixed fare is 2000 GYD.
//
// NOT asserted here (reported with probes, no contract yet): G3-F4 the taxi
// assignment notice is the delivery copy ("Rider On The Way!", RIDER_ASSIGNED),
// and a direct accept sends "Driver Found!" beside it; G3-F5 a driver's pre-pickup cancel
// re-offers the ride to that same driver; G3-F6 a fare-collected retry under a
// NEW idempotency key re-sends "Ride Complete". E19 (no arrival location gate)
// has no agreed contract — the arrival assertions here hold either way.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920333';
const FIXTURE = 'gold3-taxi-fixture';
const CENTRAL = { lat: 6.81213, lng: -58.15482 };
const SOUTH = { lat: 6.75517, lng: -58.15532 };
// Each no-show gets its own door: a second customer's strike at the same door
// within 90 days is (rightly) a collusion flag that sends a claim to review.
const NOSHOW_DOOR = { lat: 6.76321, lng: -58.16147 };
const G3F1_DOOR = { lat: 6.74418, lng: -58.14271 };
const SEEDED_ZONE_FARE = 2000;
const WEB_ORIGIN = 'https://web.gold3.example';

let app: FastifyInstance;
let jobs: ReturnType<typeof recordDispatchQueue>;
let seq = 0;
const drivers: Array<{ driverId: string; token: string }> = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; firstName: string; phone: string };

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { trustLevel?: 'L1' | 'L2'; admin?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone,
      firstName,
      lastName: `Taxi${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: opts.trustLevel ?? 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `taxi-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, firstName, phone };
}

/** A taxi driver whose every go-online gate is met (hire-class insurance and
 *  an active subscription — onboarding is its own journey), brought online
 *  through the REAL go-online route at `fix`. */
async function makeDriver(firstName: string, fix: { lat: number; lng: number }) {
  const u = await makeUser(firstName, ['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2020,
      vehicleColor: 'Silver',
      licensePlate: `G3T-${seq}`,
      driverLicenseUrl: 'storage://gold3/dl.jpg',
      vehicleInsuranceUrl: 'storage://gold3/ins.jpg',
      documentsVerified: true,
    },
  }));
  await sys(() => app.prisma.verificationDocument.create({
    data: {
      userId: u.userId, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: 'storage://gold3/ins.jpg', status: 'APPROVED',
      coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true, consentAt: new Date(), privacyNoticeVersion: 'v1',
    },
  }));
  await sys(() => app.prisma.subscription.create({
    data: {
      driverId: driver.id, type: 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 12_000,
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
    },
  }));
  drivers.push({ driverId: driver.id, token: u.token });
  const go = await call('POST', '/api/v1/driver/go-online', u.token, { latitude: fix.lat, longitude: fix.lng });
  expect(go.statusCode, go.body).toBe(200);
  return { ...u, driverId: driver.id, plate: `G3T-${seq}` };
}

/** Retire this file's free supply through the real route after each test. */
async function retireSupply() {
  for (const d of drivers) {
    const row = await sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } }));
    if (!row.isOnline || row.currentRideId) continue;
    const off = await call('POST', '/api/v1/driver/go-offline', d.token);
    expect(off.statusCode, off.body).toBe(200);
  }
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const driverRow = (id: string) => sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id } }));
const logs = async (orderId: string) => (await sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })));
const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;

const TRIP = {
  pickup: CENTRAL,
  dropoff: SOUTH,
  pickupAddress: '12 Main Street, Georgetown',
  dropoffAddress: '4 South Road, Georgetown',
};

async function requestRide(customer: Actor, dropoff = SOUTH) {
  const res = await call('POST', '/api/v1/rides/request', customer.token, { ...TRIP, dropoff });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.ride as { id: string; ridePin: string; fare: number; status: string; fareSource: string; orderNumber: string };
}

/** Request → the driver takes the card → en-route → arrived (→ PIN → start). */
async function rideTo(customer: Actor, driver: { token: string; driverId: string }, stage: 'ARRIVED' | 'IN_PROGRESS', dropoff = SOUTH) {
  const ride = await requestRide(customer, dropoff);
  expect((await app.redis.get(offerKey(ride.id)))!.split(':')[0]).toBe(driver.driverId);
  const accept = await call('POST', '/api/v1/driver/offers/accept', driver.token, { orderId: ride.id });
  expect(accept.statusCode, accept.body).toBe(200);
  for (const slug of ['en-route', 'arrived']) {
    const step = await call('PUT', `/api/v1/driver/rides/${ride.id}/${slug}`, driver.token, {});
    expect(step.statusCode, step.body).toBe(200);
  }
  if (stage === 'IN_PROGRESS') {
    const pin = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin });
    expect(pin.statusCode, pin.body).toBe(200);
    const start = await call('PUT', `/api/v1/driver/rides/${ride.id}/start`, driver.token, {});
    expect(start.statusCode, start.body).toBe(200);
  }
  return ride;
}

// ── Admin: every money step takes two people (ADM-005) and a reason (ADM-006) ──
const REASON = { 'x-swift-reason': 'GOLD-3 golden journey: settling a verified no-show guarantee claim' };

function adminInject(options: InjectOptions & { token: string }) {
  const { token, headers, ...rest } = options;
  return app.inject({ ...rest, headers: { ...(headers as Record<string, string> | undefined), ...REASON, authorization: `Bearer ${token}` } });
}

/** The real dual-control path: the request comes back 202 with an approval
 *  id; a second capable admin approves it; the request is re-issued with it. */
async function withApproval(requester: Actor, approver: Actor, options: InjectOptions) {
  const ask = await adminInject({ ...options, token: requester.token });
  expect(ask.statusCode, ask.body).toBe(202);
  expect(ask.json().error.code).toBe('APPROVAL_REQUIRED');
  const approvalId = ask.json().error.details.approvalId as string;
  const self = await adminInject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: requester.token, payload: { approve: true } });
  expect(self.statusCode).toBe(403);
  const decided = await adminInject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: approver.token, payload: { approve: true, note: 'Checked against the claim bundle' } });
  expect(decided.statusCode, decided.body).toBe(200);
  expect(decided.json().data).toEqual({ id: approvalId, status: 'APPROVED' });
  const done = await adminInject({ ...options, token: requester.token, headers: { ...(options.headers as Record<string, string> | undefined), 'x-swift-approval': approvalId } });
  return { res: done, approvalId };
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const driverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    const claimIds = (await app.prisma.reimbursementClaim.findMany({
      where: { OR: [{ orderId: { in: orderIds } }, { driverId: { in: driverIds } }, { customerId: { in: ids } }] },
      select: { id: true },
    })).map((c) => c.id);
    await app.prisma.rlpReserveEntry.deleteMany({ where: { OR: [{ claimId: { in: claimIds } }, { createdById: { in: ids } }] } });
    await app.prisma.reimbursementClaim.deleteMany({ where: { id: { in: claimIds } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...driverIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { driverId: { in: driverIds } }] } });
    await app.prisma.strike.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    if (claimIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'claimId' IN (${Prisma.join(claimIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.supplyWatch.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.subscription.deleteMany({ where: { driverId: { in: driverIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...driverIds, ...orderIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(/[:]/).some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  jobs = recordDispatchQueue(app, true);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

afterEach(async () => {
  await retireSupply();
});

describe('GOLD-3 · TAXI-01 — ride request + queue', () => {
  // First in the file, before any driver of this file is on the map: the
  // queue's supply counts are the honest counts of the whole tenant.
  it('no supply: the queue waits honestly; the worker scan auto-requests once a driver comes online, and the driver takes it', async () => {
    const customer = await makeUser('Quinn', ['CUSTOMER'], 'CUSTOMER');
    // A live WAITING entry here is another file's residue, not a GOLD-3
    // failure — so the failure names it: the entry, its customer and the phone
    // block that identifies the file that owns it.
    const foreignWaiting = await sys(async () => {
      const entries = await app.prisma.rideQueueEntry.findMany({ where: { status: 'WAITING', expiresAt: { gt: new Date() } }, select: { id: true, customerId: true, expiresAt: true } });
      const owners = await app.prisma.user.findMany({ where: { id: { in: entries.map((e) => e.customerId) } }, select: { id: true, phone: true } });
      return entries.map((e) => ({ ...e, phone: owners.find((u) => u.id === e.customerId)?.phone ?? null }));
    });
    expect(foreignWaiting, 'no other file may leave a WAITING queue entry behind (residue of the file that owns that phone block)').toEqual([]);

    const join = await call('POST', '/api/v1/rides/queue/join', customer.token, TRIP);
    expect(join.statusCode, join.body).toBe(201);
    const entryId = join.json().data.id as string;
    expect(join.json().data).toMatchObject({ id: entryId, position: 1, suppliersOnline: 0, suppliersBusy: 0 });
    const entry = await sys(() => app.prisma.rideQueueEntry.findUniqueOrThrow({ where: { id: entryId } }));
    expect({ status: entry.status, customer: entry.customerId, pickupLat: entry.pickupLat, dropoffLat: entry.dropoffLat, matched: entry.matchedOrderId })
      .toEqual({ status: 'WAITING', customer: customer.userId, pickupLat: CENTRAL.lat, dropoffLat: SOUTH.lat, matched: null });
    const live = await call('GET', '/api/v1/rides/queue', customer.token);
    expect(live.json().data).toMatchObject({ id: entryId, position: 1, suppliersOnline: 0 });

    // The worker's supply-watch-scan runs this exact function. With no supply
    // it requests nothing — the entry keeps its place.
    const scan = () => scanRideQueue({ prisma: app.prisma }, new FareService(app.prisma), makeDispatchService(app), new NotificationService(app.prisma, app.io));
    expect(await scan()).toEqual({ expired: 0, matched: 0 });
    expect((await sys(() => app.prisma.rideQueueEntry.findUniqueOrThrow({ where: { id: entryId } }))).status).toBe('WAITING');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);

    // A driver comes online nearby; the next scan claims the head and requests
    // through the real request core.
    const driver = await makeDriver('Dara', { lat: 6.8104, lng: -58.1552 });
    expect(await scan()).toEqual({ expired: 0, matched: 1 });
    const matched = await sys(() => app.prisma.rideQueueEntry.findUniqueOrThrow({ where: { id: entryId } }));
    expect(matched.status).toBe('MATCHED');
    const order = await orderRow(matched.matchedOrderId!);
    expect({ type: order.orderType, status: order.status, customer: order.customerId, pickupLat: order.pickupLat, dropLat: order.deliveryLat, fare: Number(order.taxiFareTotal) })
      .toEqual({ type: 'TAXI', status: 'PENDING', customer: customer.userId, pickupLat: CENTRAL.lat, dropLat: SOUTH.lat, fare: SEEDED_ZONE_FARE });
    expect((await app.redis.get(offerKey(order.id)))!.split(':')[0]).toBe(driver.driverId);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId }, select: { title: true, data: true } }));
    expect(told).toEqual([{ title: 'A driver freed up — your ride is requested', data: { kind: 'ride_queue_matched', orderId: order.id, audience: 'customer' } }]);
    expect((await call('GET', '/api/v1/rides/queue', customer.token)).json().data).toBeNull();

    // Once only: a second scan requests nothing more.
    expect(await scan()).toEqual({ expired: 0, matched: 0 });
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(1);

    const accept = await call('POST', '/api/v1/driver/offers/accept', driver.token, { orderId: order.id });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data.status).toBe('DRIVER_ASSIGNED');
    const active = await call('GET', '/api/v1/rides/active', customer.token);
    expect(active.json().data).toMatchObject({ id: order.id, status: 'DRIVER_ASSIGNED', driver: { licensePlate: driver.plate, user: { firstName: 'Dara' } } });
  });

  it('an L2 customer books at exactly the quoted fare; the online driver is offered it; a second live request is refused', async () => {
    const customer = await makeUser('Lara', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Omar', { lat: 6.8105, lng: -58.1551 });

    const est = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: CENTRAL, dropoff: SOUTH });
    expect(est.statusCode).toBe(200);
    const economy = (est.json().data.tiers as Array<{ rideClass: string; fare: number }>).find((t) => t.rideClass === 'ECONOMY')!;
    expect(economy.fare).toBe(SEEDED_ZONE_FARE);

    const jobsBefore = jobs.length;
    const ride = await requestRide(customer);
    expect({ fare: ride.fare, source: ride.fareSource, status: ride.status }).toEqual({ fare: economy.fare, source: 'zone_table', status: 'PENDING' });
    expect(ride.ridePin).toMatch(/^\d{6}$/);

    const order = await orderRow(ride.id);
    expect({
      type: order.orderType, status: order.status, customer: order.customerId, driver: order.driverId,
      total: Number(order.totalAmount), fare: Number(order.taxiFareTotal), method: order.paymentMethod, pin: order.ridePin,
    }).toEqual({ type: 'TAXI', status: 'PENDING', customer: customer.userId, driver: null, total: economy.fare, fare: economy.fare, method: 'CASH', pin: ride.ridePin });
    expect((await logs(ride.id)).map((l) => [l.status, l.note])).toEqual([['PENDING', `Ride requested — fixed fare $${economy.fare}`]]);

    // The route enqueued the dispatch; the worker's pass offered the ONE online
    // driver and armed that card's timeout.
    expect(jobs.slice(jobsBefore).map((j) => ({ name: j.name, orderId: j.data.orderId, riderId: j.data.riderId ?? null })))
      .toEqual([
        { name: 'dispatch-order', orderId: ride.id, riderId: null },
        { name: 'offer-timeout', orderId: ride.id, riderId: driver.driverId },
      ]);
    expect((await app.redis.get(offerKey(ride.id)))!.split(':')[0]).toBe(driver.driverId);
    const card = await call('GET', '/api/v1/driver/offers/current', driver.token);
    expect(card.json().data.offer.orderId).toBe(ride.id);
    expect(await sys(() => app.prisma.alertDelivery.count({ where: { kind: 'MOVER_OFFER', subjectId: ride.id, recipientId: driver.userId } }))).toBe(1);

    // One live ride per passenger.
    const second = await call('POST', '/api/v1/rides/request', customer.token, TRIP);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('RIDE_IN_PROGRESS');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(1);
  });

  it('an L1 customer is refused on request and on queue join, and nothing is written', async () => {
    const l1 = await makeUser('Leo', ['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L1' });
    const req = await call('POST', '/api/v1/rides/request', l1.token, TRIP);
    expect(req.statusCode).toBe(403);
    expect(req.json().error.code).toBe('ID_VERIFICATION_REQUIRED');
    const join = await call('POST', '/api/v1/rides/queue/join', l1.token, TRIP);
    expect(join.statusCode).toBe(403);
    expect(join.json().error.code).toBe('ID_VERIFICATION_REQUIRED');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: l1.userId } }))).toBe(0);
    expect(await sys(() => app.prisma.rideQueueEntry.count({ where: { customerId: l1.userId } }))).toBe(0);
  });
});

describe('GOLD-3 · TAXI-02 — accept → en-route → arrived', () => {
  it('each step is one durable transition; the arrival is written beside the driver\'s own fix; strangers are refused', async () => {
    const customer = await makeUser('Pia', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Deo', CENTRAL);
    const ride = await requestRide(customer);

    const accept = await call('POST', '/api/v1/driver/offers/accept', driver.token, { orderId: ride.id });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data).toEqual({ orderId: ride.id, status: 'DRIVER_ASSIGNED', orderNumber: ride.orderNumber });
    const assigned = await orderRow(ride.id);
    expect({ status: assigned.status, driver: assigned.driverId }).toEqual({ status: 'DRIVER_ASSIGNED', driver: driver.driverId });
    expect(assigned.acceptedAt).not.toBeNull();
    expect({ available: (await driverRow(driver.driverId)).isAvailable, pointer: (await driverRow(driver.driverId)).currentRideId })
      .toEqual({ available: false, pointer: ride.id });
    // The passenger heard about THIS ride, naming their driver.
    const heard = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId }, select: { body: true, data: true } }));
    expect(heard).toHaveLength(1);
    expect((heard[0]!.data as { orderId?: string }).orderId).toBe(ride.id);
    expect(heard[0]!.body).toContain('Deo');

    const enRoute = await call('PUT', `/api/v1/driver/rides/${ride.id}/en-route`, driver.token, {});
    expect(enRoute.statusCode, enRoute.body).toBe(200);
    expect(enRoute.json().data.status).toBe('DRIVER_EN_ROUTE');
    // The driver's view never carries the passenger's PIN [F-0011].
    expect(enRoute.json().data).not.toHaveProperty('ridePin');

    const before = Date.now();
    const arrived = await call('PUT', `/api/v1/driver/rides/${ride.id}/arrived`, driver.token, {});
    const after = Date.now();
    expect(arrived.statusCode, arrived.body).toBe(200);
    expect(arrived.json().data.status).toBe('DRIVER_ARRIVED');
    expect(arrived.json().data).not.toHaveProperty('ridePin');
    const atPickup = await orderRow(ride.id);
    expect(atPickup.status).toBe('DRIVER_ARRIVED');
    expect(atPickup.driverArrivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(atPickup.driverArrivedAt!.getTime()).toBeLessThanOrEqual(after);

    const trail = await logs(ride.id);
    expect(trail.map((l) => l.status)).toEqual(['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED']);
    // The claim "I have arrived" is written down beside the platform's own
    // record of where the driver was — never a position the client sent.
    expect(trail[3]!.note).toBe('Driver reported arriving at the pickup point — gps:6.81213,-58.15482, 0m from the pickup point');
    expect(trail[3]!.changedBy).toBe(driver.userId);
    const titles = (await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId }, orderBy: { createdAt: 'asc' }, select: { title: true } }))).map((n) => n.title);
    expect(titles.slice(1)).toEqual(['Driver En Route', 'Driver Arrived']);

    // Strangers: another online driver can neither take nor move this ride.
    const thief = await makeDriver('Tomas', { lat: 6.8102, lng: -58.1551 });
    const steal = await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, thief.token, {});
    expect(steal.statusCode).toBe(409);
    expect(steal.json().error.code).toBe('ALREADY_TAKEN');
    const move = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, thief.token, { pin: ride.ridePin });
    expect(move.statusCode).toBe(404);
    // …and the driver cannot repeat a step.
    const twice = await call('PUT', `/api/v1/driver/rides/${ride.id}/arrived`, driver.token, {});
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.code).toBe('INVALID_STATUS');
    const still = await orderRow(ride.id);
    expect({ status: still.status, driver: still.driverId, verified: still.ridePinVerified, attempts: still.ridePinAttempts })
      .toEqual({ status: 'DRIVER_ARRIVED', driver: driver.driverId, verified: false, attempts: 0 });
    expect((await logs(ride.id)).map((l) => l.status)).toEqual(['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED']);
    expect((await driverRow(thief.driverId)).currentRideId).toBeNull();
  });

  it('two drivers racing the same ride: exactly one winner; the loser is refused and stays free', async () => {
    const customer = await makeUser('Ria', ['CUSTOMER'], 'CUSTOMER');
    const a = await makeDriver('Ada', { lat: 6.81223, lng: -58.15482 });
    const b = await makeDriver('Bo', { lat: 6.81243, lng: -58.15482 });
    const ride = await requestRide(customer);

    const [ra, rb] = await Promise.all([
      call('POST', `/api/v1/driver/rides/${ride.id}/accept`, a.token, {}),
      call('POST', `/api/v1/driver/rides/${ride.id}/accept`, b.token, {}),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(loser.json().error.code).toBe('ALREADY_TAKEN');
    const winner = ra.statusCode === 200 ? a : b;
    const other = winner === a ? b : a;

    const order = await orderRow(ride.id);
    expect({ status: order.status, driver: order.driverId }).toEqual({ status: 'DRIVER_ASSIGNED', driver: winner.driverId });
    expect((await logs(ride.id)).filter((l) => l.status === 'DRIVER_ASSIGNED')).toHaveLength(1);
    expect({ pointer: (await driverRow(winner.driverId)).currentRideId, available: (await driverRow(winner.driverId)).isAvailable })
      .toEqual({ pointer: ride.id, available: false });
    expect({ pointer: (await driverRow(other.driverId)).currentRideId, available: (await driverRow(other.driverId)).isAvailable })
      .toEqual({ pointer: null, available: true });
    // The live card the dispatch pass had issued is retired with the claim.
    expect(await app.redis.get(offerKey(ride.id))).toBeNull();
  });

  it('a driver who cancels before pickup is freed, the ride returns to PENDING with a fresh PIN, the passenger is told, and another driver takes it', async () => {
    const customer = await makeUser('Sam', ['CUSTOMER'], 'CUSTOMER');
    // Fola is at the pickup; Sid is ~400 m away.
    const first = await makeDriver('Fola', { lat: 6.81223, lng: -58.15482 });
    const second = await makeDriver('Sid', { lat: 6.81513, lng: -58.15282 });
    const ride = await requestRide(customer);
    expect((await app.redis.get(offerKey(ride.id)))!.split(':')[0]).toBe(first.driverId);
    const accept = await call('POST', '/api/v1/driver/offers/accept', first.token, { orderId: ride.id });
    expect(accept.statusCode, accept.body).toBe(200);

    const jobsBefore = jobs.length;
    const cancel = await call('POST', `/api/v1/driver/rides/${ride.id}/cancel`, first.token, { reason: 'vehicle broke down' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().data).toEqual({ orderId: ride.id, status: 'PENDING', reDispatched: true });

    const released = await orderRow(ride.id);
    expect({ status: released.status, driver: released.driverId, acceptedAt: released.acceptedAt, verified: released.ridePinVerified, attempts: released.ridePinAttempts })
      .toEqual({ status: 'PENDING', driver: null, acceptedAt: null, verified: false, attempts: 0 });
    expect(released.ridePin).toMatch(/^\d{6}$/);
    expect(released.ridePin).not.toBe(ride.ridePin);
    const freed = await driverRow(first.driverId);
    expect({ pointer: freed.currentRideId, available: freed.isAvailable, cancellationRate: freed.cancellationRate })
      .toEqual({ pointer: null, available: true, cancellationRate: 20 });
    const trail = await logs(ride.id);
    expect(trail.map((l) => [l.status, l.note])).toContainEqual(['PENDING', 'Driver cancelled: vehicle broke down']);
    expect(await sys(() => app.prisma.notification.count({ where: { userId: customer.userId, title: 'Finding you another driver' } }))).toBe(1);
    // The ride went straight back to dispatch.
    expect(jobs.slice(jobsBefore)[0]).toMatchObject({ name: 'dispatch-order', data: { orderId: ride.id } });
    expect(await app.redis.get(offerKey(ride.id))).not.toBeNull();

    // Another driver takes the ride.
    const take = await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, second.token, {});
    expect(take.statusCode, take.body).toBe(200);
    const retaken = await orderRow(ride.id);
    expect({ status: retaken.status, driver: retaken.driverId }).toEqual({ status: 'DRIVER_ASSIGNED', driver: second.driverId });
    expect(await app.redis.get(offerKey(ride.id))).toBeNull();
    const stale = await call('POST', '/api/v1/driver/offers/accept', first.token, { orderId: ride.id });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('OFFER_EXPIRED');
    // The passenger's live card shows the NEW driver, with the NEW pin to share.
    const active = await call('GET', '/api/v1/rides/active', customer.token);
    expect(active.json().data).toMatchObject({ id: ride.id, ridePin: released.ridePin, driver: { licensePlate: second.plate } });
  });
});

describe('GOLD-3 · TAXI-03 — PIN verify → start → complete', () => {
  it('wrong PIN refused with the budget left; the right PIN verifies; start; the bare complete is refused; "fare collected" closes it in one commit and replays', async () => {
    const customer = await makeUser('Tia', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Kwame', CENTRAL);
    const ride = await rideTo(customer, driver, 'ARRIVED');

    const early = await call('PUT', `/api/v1/driver/rides/${ride.id}/start`, driver.token, {});
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('PIN_REQUIRED');

    const wrong = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin === '000000' ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toMatchObject({ code: 'INVALID_PIN', message: 'Incorrect PIN. 4 attempt(s) remaining.' });
    expect((await orderRow(ride.id)).ridePinAttempts).toBe(1);

    const verified = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.ridePinVerified).toBe(true);
    expect(verified.json().data).not.toHaveProperty('ridePin');
    const custody = await orderRow(ride.id);
    expect({ verified: custody.ridePinVerified, attempts: custody.ridePinAttempts, status: custody.status }).toEqual({ verified: true, attempts: 2, status: 'DRIVER_ARRIVED' });
    expect(custody.ridePinVerifiedAt).not.toBeNull();
    const again = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('ALREADY_VERIFIED');

    const start = await call('PUT', `/api/v1/driver/rides/${ride.id}/start`, driver.token, {});
    expect(start.statusCode, start.body).toBe(200);
    expect(start.json().data.status).toBe('RIDE_IN_PROGRESS');
    expect((await orderRow(ride.id)).pickedUpAt).not.toBeNull();

    // The golden rule: a cash ride never completes on the bare tap.
    const bare = await call('PUT', `/api/v1/driver/rides/${ride.id}/complete`, driver.token, {});
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error.code).toBe('PAYMENT_NOT_CAPTURED');
    const aboard = await orderRow(ride.id);
    expect({ status: aboard.status, payment: aboard.paymentStatus }).toEqual({ status: 'RIDE_IN_PROGRESS', payment: 'PENDING' });

    const key = `gold3-fare-${nanoid(10)}`;
    const paid = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'paid', gps: SOUTH }, { 'idempotency-key': key });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toEqual({ success: true, replayed: false, data: { orderId: ride.id, status: 'DELIVERED', actualDuration: expect.any(Number), claim: null } });

    const [order, row, fares, trail] = await Promise.all([
      orderRow(ride.id),
      driverRow(driver.driverId),
      sys(() => app.prisma.earning.findMany({ where: { orderId: ride.id } })),
      logs(ride.id),
    ]);
    expect({ status: order.status, payment: order.paymentStatus }).toEqual({ status: 'DELIVERED', payment: 'CAPTURED' });
    expect(order.deliveredAt).not.toBeNull();
    expect(order.actualDeliveryTime).toBe(paid.json().data.actualDuration);
    expect(fares.map((e) => ({ type: e.type, amount: Number(e.amount), driver: e.driverId }))).toEqual([{ type: 'TAXI_FARE', amount: SEEDED_ZONE_FARE, driver: driver.driverId }]);
    expect({ available: row.isAvailable, pointer: row.currentRideId, rides: row.totalRides }).toEqual({ available: true, pointer: null, rides: 1 });
    expect(trail.filter((l) => l.status === 'DELIVERED').map((l) => l.note)).toEqual(['fare collected — gps:6.75517,-58.15532']);

    // A lost response retried with the same key replays the recorded answer.
    const replay = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'paid', gps: SOUTH }, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...paid.json(), replayed: true });
    expect(await sys(() => app.prisma.earning.count({ where: { orderId: ride.id } }))).toBe(1);
    expect((await logs(ride.id)).filter((l) => l.status === 'DELIVERED')).toHaveLength(1);
    expect(await sys(() => app.prisma.notification.count({ where: { userId: customer.userId, title: 'Ride Complete' } }))).toBe(1);
  });

  it('two simultaneous "fare collected" taps pay the ride exactly once', async () => {
    const customer = await makeUser('Uma', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Vik', CENTRAL);
    const ride = await rideTo(customer, driver, 'IN_PROGRESS');

    const tap = (key: string) => call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'paid', gps: SOUTH }, { 'idempotency-key': key });
    const results = await Promise.all([tap(`gold3-tap-a-${nanoid(8)}`), tap(`gold3-tap-b-${nanoid(8)}`)]);
    // Each tap either carries the one committed fact or is a clean conflict —
    // never a second completion, never a server error.
    for (const r of results) {
      if (r.statusCode === 200) expect(r.json().data).toMatchObject({ orderId: ride.id, status: 'DELIVERED', claim: null });
      else {
        expect(r.statusCode).toBe(409);
        expect(r.json().error.code).toBe('INVALID_STATUS');
      }
    }
    expect(results.some((r) => r.statusCode === 200)).toBe(true);

    const [order, row, fares, delivered] = await Promise.all([
      orderRow(ride.id),
      driverRow(driver.driverId),
      sys(() => app.prisma.earning.findMany({ where: { orderId: ride.id } })),
      sys(() => app.prisma.orderStatusLog.count({ where: { orderId: ride.id, status: 'DELIVERED' } })),
    ]);
    expect({ status: order.status, payment: order.paymentStatus }).toEqual({ status: 'DELIVERED', payment: 'CAPTURED' });
    expect(fares.map((e) => ({ type: e.type, amount: Number(e.amount) }))).toEqual([{ type: 'TAXI_FARE', amount: SEEDED_ZONE_FARE }]);
    expect(delivered).toBe(1);
    expect({ rides: row.totalRides, pointer: row.currentRideId, available: row.isAvailable }).toEqual({ rides: 1, pointer: null, available: true });
  });

  it('five wrong PINs lock the code — even the right PIN is then refused — until a pre-custody cancel rotates it with a zeroed budget', async () => {
    const customer = await makeUser('Wren', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Xavi', CENTRAL);
    const ride = await rideTo(customer, driver, 'ARRIVED');
    const wrongPin = ride.ridePin === '000000' ? '111111' : '000000';

    for (let left = 4; left >= 0; left -= 1) {
      const wrong = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: wrongPin });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toMatchObject({ code: 'INVALID_PIN', message: `Incorrect PIN. ${left} attempt(s) remaining.` });
    }
    const locked = await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driver.token, { pin: ride.ridePin });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');
    const start = await call('PUT', `/api/v1/driver/rides/${ride.id}/start`, driver.token, {});
    expect(start.statusCode).toBe(400);
    expect(start.json().error.code).toBe('PIN_REQUIRED');
    const lockedRow = await orderRow(ride.id);
    expect({ attempts: lockedRow.ridePinAttempts, verified: lockedRow.ridePinVerified, status: lockedRow.status, pin: lockedRow.ridePin })
      .toEqual({ attempts: 5, verified: false, status: 'DRIVER_ARRIVED', pin: ride.ridePin });

    const cancel = await call('POST', `/api/v1/driver/rides/${ride.id}/cancel`, driver.token, { reason: 'pin locked out' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const after = await orderRow(ride.id);
    expect({ status: after.status, driver: after.driverId, attempts: after.ridePinAttempts, verified: after.ridePinVerified })
      .toEqual({ status: 'PENDING', driver: null, attempts: 0, verified: false });
    expect(after.ridePin).toMatch(/^\d{6}$/);
    expect(after.ridePin).not.toBe(ride.ridePin);
    // The passenger's card carries the fresh PIN to share with the next driver.
    expect((await call('GET', '/api/v1/rides/active', customer.token)).json().data).toMatchObject({ id: ride.id, status: 'PENDING', ridePin: after.ridePin });
  });
});

describe('GOLD-3 · TAXI-04 — cash / no-show outcome → guarantee claim → settlement', () => {
  it('a fare outcome without GPS is refused cleanly; a stranger and the passenger cannot record it; the ride is untouched', async () => {
    const customer = await makeUser('Yara', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Zed', CENTRAL);
    const ride = await rideTo(customer, driver, 'IN_PROGRESS');
    const stranger = await makeDriver('Ines', { lat: 6.8103, lng: -58.1552 });

    const noGps = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'paid' });
    expect(noGps.statusCode).toBe(400);
    expect(noGps.json().error.code).toBe('VALIDATION_ERROR');
    const foreign = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, stranger.token, { outcome: 'no_show', gps: SOUTH });
    expect(foreign.statusCode).toBe(404);
    const passenger = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, customer.token, { outcome: 'paid', gps: SOUTH });
    expect(passenger.statusCode).toBe(403);

    const order = await orderRow(ride.id);
    expect({ status: order.status, payment: order.paymentStatus }).toEqual({ status: 'RIDE_IN_PROGRESS', payment: 'PENDING' });
    expect(await sys(() => app.prisma.earning.count({ where: { orderId: ride.id } }))).toBe(0);
    expect(await sys(() => app.prisma.reimbursementClaim.count({ where: { orderId: ride.id } }))).toBe(0);
    expect(await sys(() => app.prisma.strike.count({ where: { orderId: ride.id } }))).toBe(0);
  });

  it('no-show: FAILED + strike + auto-approved claim + freed driver in one commit; the replay answers the same claim; the driver cannot settle it', async () => {
    const customer = await makeUser('Abi', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Bram', CENTRAL);
    const ride = await rideTo(customer, driver, 'IN_PROGRESS', NOSHOW_DOOR);

    const gone = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'no_show', gps: NOSHOW_DOOR });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json().data).toMatchObject({ orderId: ride.id, status: 'FAILED', claim: { amount: SEEDED_ZONE_FARE, status: 'AUTO_APPROVED', flags: [] } });
    const claimId = gone.json().data.claim.id as string;

    const [order, claim, strikes, row, earnings, failedLogs] = await Promise.all([
      orderRow(ride.id),
      sys(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claimId } })),
      sys(() => app.prisma.strike.findMany({ where: { orderId: ride.id } })),
      driverRow(driver.driverId),
      sys(() => app.prisma.earning.count({ where: { orderId: ride.id } })),
      sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId: ride.id, status: 'FAILED' } })),
    ]);
    expect({ status: order.status, payment: order.paymentStatus }).toEqual({ status: 'FAILED', payment: 'FAILED' });
    expect({ order: claim.orderId, driver: claim.driverId, rider: claim.riderId, customer: claim.customerId, reason: claim.reason, gps: [claim.gpsLat, claim.gpsLng], amount: Number(claim.amount), status: claim.status, complete: claim.evidenceComplete })
      .toEqual({ order: ride.id, driver: driver.driverId, rider: null, customer: customer.userId, reason: 'no_show', gps: [NOSHOW_DOOR.lat, NOSHOW_DOOR.lng], amount: SEEDED_ZONE_FARE, status: 'AUTO_APPROVED', complete: true });
    expect(strikes.map((s) => ({ user: s.userId, reason: s.reason, phone: s.phone }))).toEqual([{ user: customer.userId, reason: 'failed_payment_no_show', phone: customer.phone }]);
    expect({ available: row.isAvailable, pointer: row.currentRideId }).toEqual({ available: true, pointer: null });
    expect(earnings).toBe(0);
    expect(failedLogs.map((l) => l.note)).toEqual(['no_show — gps:6.76321,-58.16147']);

    const replay = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'no_show', gps: NOSHOW_DOOR });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.claim.id).toBe(claimId);
    expect(await sys(() => app.prisma.reimbursementClaim.count({ where: { orderId: ride.id } }))).toBe(1);
    expect(await sys(() => app.prisma.strike.count({ where: { orderId: ride.id } }))).toBe(1);
    expect(await sys(() => app.prisma.orderStatusLog.count({ where: { orderId: ride.id, status: 'FAILED' } }))).toBe(1);

    // The money is an admin's to move, never the claimant's.
    const driverPays = await call('PUT', `/api/v1/admin/cash-rules/claims/${claimId}/paid`, driver.token, { reference: 'GOLD3DRV0001', amount: String(SEEDED_ZONE_FARE) }, REASON);
    expect(driverPays.statusCode).toBe(403);
    expect((await sys(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claimId } }))).status).toBe('AUTO_APPROVED');
  });
});

// G3-F1 (NEW — found by this lane; proposed as the next ledger id, S1): a taxi
// driver's guarantee claim can never be settled. admin.routes.ts scopes
// ReimbursementClaim with `riderId IN (the tenant's riders)` (the childScope
// at ~:536); a TAXI claim carries driverId and a NULL riderId, and SQL IN never
// matches NULL — so the claim is absent from the admin queue, and approve,
// reject and paid all answer 404 (paid only after burning a two-person
// approval). This asserts the CORRECT behaviour. Everything the body relies on
// is proven in beforeAll (the claim exists AUTO_APPROVED; both admin sessions
// authenticate), so the ONLY thing that can fail first on main is the
// visibility assertion — the defect. #1293 fixed it ("driver claims in the
// admin queue"): on the combined code the whole settlement passes, so this is
// a plain `it` now.
describe('GOLD-3 · TAXI-04 — [G3-F1] an admin settles the driver\'s no-show claim', () => {
  let claimId = '';
  let admin: Actor;
  let approver: Actor;
  let driverUserId = '';

  beforeAll(async () => {
    const customer = await makeUser('Cai', ['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver('Dayo', CENTRAL);
    driverUserId = driver.userId;
    admin = await makeUser('Ama', ['ADMIN'], 'ADMIN', { admin: true });
    approver = await makeUser('Ekow', ['SUPER_ADMIN'], 'SUPER_ADMIN', { admin: true });
    const ride = await rideTo(customer, driver, 'IN_PROGRESS', G3F1_DOOR);
    const gone = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driver.token, { outcome: 'no_show', gps: G3F1_DOOR });
    expect(gone.statusCode, gone.body).toBe(200);
    claimId = gone.json().data.claim.id as string;
    const claim = await sys(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claimId } }));
    expect({ status: claim.status, complete: claim.evidenceComplete, driver: claim.driverId }).toEqual({ status: 'AUTO_APPROVED', complete: true, driver: driver.driverId });
    for (const who of [admin, approver]) {
      const queue = await adminInject({ method: 'GET', url: '/api/v1/admin/cash-rules/claims?status=AUTO_APPROVED&limit=100', token: who.token });
      expect(queue.statusCode, queue.body).toBe(200);
    }
  });

  it('[G3-F1] the claim is in the admin queue and a two-person payout settles it from the funded reserve, once', async () => {
    const queue = await adminInject({ method: 'GET', url: '/api/v1/admin/cash-rules/claims?status=AUTO_APPROVED&limit=100', token: admin.token });
    expect((queue.json().data as Array<{ id: string }>).map((c) => c.id)).toContain(claimId);

    const fund = await withApproval(admin, approver, {
      method: 'POST',
      url: '/api/v1/admin/cash-rules/rlp/reserve/adjust',
      payload: { countryCode: 'GY', amount: SEEDED_ZONE_FARE, note: 'GOLD-3 fixture: fund one taxi no-show guarantee' },
    });
    expect(fund.res.statusCode, fund.res.body).toBe(200);

    const reference = `GOLD3PAY${nanoid(10).replace(/[^A-Za-z0-9]/g, '0').toUpperCase()}`;
    const pay = await withApproval(admin, approver, {
      method: 'PUT',
      url: `/api/v1/admin/cash-rules/claims/${claimId}/paid`,
      payload: { reference, amount: String(SEEDED_ZONE_FARE) },
    });
    expect(pay.res.statusCode, pay.res.body).toBe(200);
    expect(pay.res.json().data.status).toBe('PAID');

    const [paid, draw, told] = await Promise.all([
      sys(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claimId } })),
      sys(() => app.prisma.rlpReserveEntry.findMany({ where: { claimId } })),
      sys(() => app.prisma.notification.findMany({ where: { userId: driverUserId, title: 'Guarantee paid' } })),
    ]);
    expect({ status: paid.status, paidAmount: Number(paid.paidAmount), paidBy: paid.paidById, ref: paid.paymentRef })
      .toEqual({ status: 'PAID', paidAmount: SEEDED_ZONE_FARE, paidBy: admin.userId, ref: reference });
    expect(draw.map((e) => ({ kind: e.kind, amount: Number(e.amount) }))).toEqual([{ kind: 'PAYOUT', amount: -SEEDED_ZONE_FARE }]);
    expect(told).toHaveLength(1);
    // The spent approval cannot be spent again.
    const reuse = await adminInject({ method: 'PUT', url: `/api/v1/admin/cash-rules/claims/${claimId}/paid`, token: admin.token, payload: { reference, amount: String(SEEDED_ZONE_FARE) }, headers: { 'x-swift-approval': pay.approvalId } });
    expect(reuse.statusCode).toBe(403);
    expect(await sys(() => app.prisma.rlpReserveEntry.count({ where: { claimId } }))).toBe(1);
  });
});

describe('GOLD-3 · TAXI-05 — web taxi booking disabled (#1271); mobile keeps booking', () => {
  beforeAll(() => {
    // A browser cookie is honoured only from an allowed origin: name one.
    vi.stubEnv('CORS_ORIGIN', WEB_ORIGIN);
    resetBrowserOriginsForTests();
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    resetBrowserOriginsForTests();
  });

  const browser = (token: string, origin = WEB_ORIGIN) => ({ cookie: `${ACCESS_COOKIE}=${token}`, origin, 'x-swift-client': 'web' });

  it('a verified browser session cannot book or queue, yet still reads its rides; the mobile bearer books whatever label it sends', async () => {
    const customer = await makeUser('Webb', ['CUSTOMER'], 'CUSTOMER');

    // The cookie IS a working credential: the read succeeds…
    const read = await call('GET', '/api/v1/rides/active', undefined, undefined, browser(customer.token));
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toBeNull();
    // …but creation from a browser is refused.
    const book = await call('POST', '/api/v1/rides/request', undefined, TRIP, browser(customer.token));
    expect(book.statusCode).toBe(403);
    expect(book.json().error.code).toBe('TAXI_MOBILE_APP_REQUIRED');
    const queue = await call('POST', '/api/v1/rides/queue/join', undefined, TRIP, browser(customer.token));
    expect(queue.statusCode).toBe(403);
    expect(queue.json().error.code).toBe('TAXI_MOBILE_APP_REQUIRED');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);
    expect(await sys(() => app.prisma.rideQueueEntry.count({ where: { customerId: customer.userId } }))).toBe(0);

    // A cookie without the allowed origin, or without the client header, is no credential at all.
    const foreignOrigin = await call('POST', '/api/v1/rides/request', undefined, TRIP, browser(customer.token, 'https://untrusted.example'));
    expect(foreignOrigin.statusCode).toBe(401);
    const noClient = await call('POST', '/api/v1/rides/request', undefined, TRIP, { cookie: `${ACCESS_COOKIE}=${customer.token}`, origin: WEB_ORIGIN });
    expect(noClient.statusCode).toBe(401);
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);

    // The mobile app's bearer books — a client-name header proves nothing either way.
    const mobile = await call('POST', '/api/v1/rides/request', customer.token, TRIP, { 'x-swift-client': 'web' });
    expect(mobile.statusCode, mobile.body).toBe(201);
    const rideId = mobile.json().data.ride.id as string;
    expect(await sys(() => app.prisma.order.findMany({ where: { customerId: customer.userId }, select: { id: true, orderType: true } })))
      .toEqual([{ id: rideId, orderType: 'TAXI' }]);
    // The website can still show that ride (with its "open the app" notice).
    const shown = await call('GET', '/api/v1/rides/active', undefined, undefined, browser(customer.token));
    expect(shown.statusCode).toBe(200);
    expect(shown.json().data.id).toBe(rideId);
  });
});
