import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService, reconcileMissingEarnings } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { CashRulesService, TAXI_FARE_OUTCOME_ENFORCED_AT, type CashHandoverObserver } from '../modules/cash/cash-rules.service';
import { taxiDeliveredUnpaidGauge } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [M-29 · S0] A cash fare is earned when the money is recorded — never on the
// driver's completion tap alone.
//
// Before: a ride was born CASH / PENDING, the driver's "complete" went straight
// to DELIVERED, and the canonical transition minted the TAXI_FARE earning with
// no payment gate at all. A passenger who refused to pay, or left, produced a
// delivered ride, an earned fare, no strike and no guarantee claim. Now the
// ride's completion IS its fare outcome on the same rail the rider's handover
// at the door uses: 'paid' captures and completes in one commit; 'refused' /
// 'no_show' fail it with GPS evidence, strike the passenger and open the
// driver's claim; the terminal authority refuses DELIVERED for a cash ride
// with no captured fare from any caller; the reconciler never mints one.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200177';
const PICKUP = { lat: 6.81, lng: -58.155 };
const DROP = { lat: 6.755, lng: -58.155 };
const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let orders: OrderService;
let notifications: NotificationService;
let seq = 0;
let plate = 0;

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const drivers = await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const rows = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { driverId: { in: drivers.map((d) => d.id) } }] }, select: { id: true } });
  const oids = rows.map((o) => o.id);
  await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.strike.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.driver.updateMany({ where: { userId: { in: ids } }, data: { currentRideId: null } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Fare', lastName: `Outcome${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'm29', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, sessionId: session.id };
}

async function makeDriver() {
  const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  plate += 1;
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
      licensePlate: `HM29-${plate}`, driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      documentsVerified: true, isOnline: true, isAvailable: false, cancellationRate: 50,
      currentLat: DROP.lat, currentLng: DROP.lng, lastLocationUpdate: new Date(), locationSessionId: u.sessionId,
    },
  });
  return { ...u, driverId: driver.id };
}

let doorSeq = 0;
/** A cash ride with the passenger aboard, at its own destination (the
 *  guardrails flag repeated claims at one address — a real rule, not this
 *  suite's subject). */
async function makeRideInProgress(customerId: string, driverId: string, extra: Record<string, unknown> = {}) {
  doorSeq += 1;
  const drop = { lat: DROP.lat + doorSeq * 0.01, lng: DROP.lng - doorSeq * 0.01 };
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `M29-${nanoid(8)}`, orderType: 'TAXI', customerId, driverId, status: 'RIDE_IN_PROGRESS',
      pickupAddress: 'Pickup corner', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: `${doorSeq} Destination Street`, deliveryLat: drop.lat, deliveryLng: drop.lng,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0,
      taxiFareTotal: 2000, totalAmount: 2000, paymentMethod: 'CASH',
      pickedUpAt: new Date(Date.now() - 12 * 60_000), taxiDuration: 10,
      ...extra,
    },
  });
  await app.prisma.driver.update({ where: { id: driverId }, data: { currentRideId: order.id, isAvailable: false } });
  return { ...order, drop };
}

const facts = async (orderId: string, customerId: string, driverId: string) => {
  const o = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const d = await app.prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
  return {
    status: o.status,
    payment: o.paymentStatus,
    duration: o.actualDeliveryTime,
    strikes: await app.prisma.strike.count({ where: { orderId, userId: customerId } }),
    claims: await app.prisma.reimbursementClaim.count({ where: { orderId } }),
    fares: await app.prisma.earning.count({ where: { orderId, type: 'TAXI_FARE' } }),
    driver: { available: d.isAvailable, pointer: d.currentRideId, rides: d.totalRides, rate: d.cancellationRate },
  };
};

const driverCall = (method: 'POST' | 'PUT', token: string, id: string, leg: string, payload?: unknown) => app.inject({
  method, url: `/api/v1/driver/rides/${id}/${leg}`,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  orders = new OrderService(app.prisma, app.io);
  notifications = new NotificationService(app.prisma, app.io);
  await purge();
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('[M-29] the completion tap alone', () => {
  it('does not complete a cash ride: 409 PAYMENT_NOT_CAPTURED, nothing minted, nothing moved', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    const tap = await driverCall('PUT', driver.token, ride.id, 'complete', {});
    expect(tap.statusCode).toBe(409);
    expect(tap.json().error?.code ?? tap.json().code).toBe('PAYMENT_NOT_CAPTURED');
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({
      status: 'RIDE_IN_PROGRESS', payment: 'PENDING', fares: 0, strikes: 0, claims: 0,
      driver: { available: false, pointer: ride.id, rides: 0 },
    });
  });

  it('is refused by the terminal authority itself, not only the route: DELIVERED without a captured fare rolls back from any caller', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    await expect(orders.transitionOrderAtomically({
      orderId: ride.id, target: 'DELIVERED', allowedFrom: ['RIDE_IN_PROGRESS'], changedBy: driver.userId, note: 'a caller that skipped the fare step',
    })).rejects.toMatchObject({ code: 'PAYMENT_NOT_CAPTURED' });
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({
      status: 'RIDE_IN_PROGRESS', payment: 'PENDING', fares: 0, duration: null,
      driver: { available: false, pointer: ride.id, rides: 0, rate: 50 },
    });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: ride.id, status: 'DELIVERED' } })).toBe(0);
  });
});

describe('[M-29] the fare outcome at the destination — one rail with the door', () => {
  it('paid: DELIVERED, fare CAPTURED, TAXI_FARE earned once, driver released and rehabilitated — one commit; the repeat answers the same facts', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    const paid = await driverCall('POST', driver.token, ride.id, 'handover', { outcome: 'paid', gps: ride.drop });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().data).toMatchObject({ orderId: ride.id, status: 'DELIVERED', claim: null });
    expect(paid.json().data.actualDuration).toBeGreaterThanOrEqual(12);
    const after = await facts(ride.id, passenger.userId, driver.driverId);
    expect(after).toMatchObject({
      status: 'DELIVERED', payment: 'CAPTURED', fares: 1, strikes: 0, claims: 0,
      driver: { available: true, pointer: null, rides: 1 },
    });
    expect(after.driver.rate).toBeCloseTo(40, 1); // 50 × 0.8 — a completer recovers
    const fare = await app.prisma.earning.findFirstOrThrow({ where: { orderId: ride.id, type: 'TAXI_FARE' } });
    expect({ driverId: fare.driverId, amount: Number(fare.amount), status: fare.status }).toEqual({ driverId: driver.driverId, amount: 2000, status: 'AVAILABLE' });
    // A lost response / double tap: the same facts, nothing paid twice.
    const again = await driverCall('POST', driver.token, ride.id, 'handover', { outcome: 'paid', gps: ride.drop });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.status).toBe('DELIVERED');
    expect((await facts(ride.id, passenger.userId, driver.driverId)).fares).toBe(1);
    expect((await driverCall('PUT', driver.token, ride.id, 'complete', {})).statusCode).toBe(400); // already complete
  });

  it('refused: FAILED, payment FAILED, a strike on the passenger, the driver’s guarantee claim with the GPS evidence, driver released — one commit; the repeat answers the same claim', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    const refused = await driverCall('POST', driver.token, ride.id, 'handover', { outcome: 'refused', gps: ride.drop });
    expect(refused.statusCode).toBe(200);
    expect(refused.json().data.status).toBe('FAILED');
    expect(refused.json().data.claim).toMatchObject({ amount: 2000, status: 'AUTO_APPROVED', flags: [] });
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({
      status: 'FAILED', payment: 'FAILED', fares: 0, strikes: 1, claims: 1,
      driver: { available: true, pointer: null, rides: 0 },
    });
    const claim = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { orderId: ride.id } });
    expect({ driverId: claim.driverId, riderId: claim.riderId, customerId: claim.customerId, reason: claim.reason, gps: [claim.gpsLat, claim.gpsLng] })
      .toEqual({ driverId: driver.driverId, riderId: null, customerId: passenger.userId, reason: 'refused', gps: [ride.drop.lat, ride.drop.lng] });
    const strike = await app.prisma.strike.findFirstOrThrow({ where: { orderId: ride.id } });
    expect(strike.reason).toBe('failed_payment_refused');
    // Notices leave after the commit: the passenger's strike notice, the driver's claim notice.
    expect(await app.prisma.notification.count({ where: { userId: passenger.userId, title: 'Unpaid fare recorded' } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: driver.userId, title: 'Guarantee approved' } })).toBe(1);
    const again = await driverCall('POST', driver.token, ride.id, 'handover', { outcome: 'refused', gps: ride.drop });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.claim.id).toBe(claim.id);
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({ strikes: 1, claims: 1, fares: 0 });
  });

  it('left without paying (no_show): the same shape, its own reason', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    const gone = await driverCall('POST', driver.token, ride.id, 'handover', { outcome: 'no_show', gps: ride.drop });
    expect(gone.statusCode).toBe(200);
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({ status: 'FAILED', payment: 'FAILED', fares: 0, strikes: 1, claims: 1 });
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { orderId: ride.id } })).reason).toBe('no_show');
    expect((await app.prisma.strike.findFirstOrThrow({ where: { orderId: ride.id } })).reason).toBe('failed_payment_no_show');
  });

  it('the guardrails key on the driver: a second unpaid ride against the same passenger is flagged for review, not auto-paid', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const first = await makeRideInProgress(passenger.userId, driver.driverId);
    expect((await driverCall('POST', driver.token, first.id, 'handover', { outcome: 'refused', gps: first.drop })).json().data.claim.status).toBe('AUTO_APPROVED');
    const second = await makeRideInProgress(passenger.userId, driver.driverId);
    const claim = (await driverCall('POST', driver.token, second.id, 'handover', { outcome: 'refused', gps: second.drop })).json().data.claim;
    expect(claim.status).toBe('PENDING_REVIEW');
    expect(claim.flags).toContain('collusion_pair');
  });

  it('a crash inside the paid generation leaves nothing captured and no fare; the retry completes once', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    let armed = true;
    const observer: CashHandoverObserver = { afterTerminalFacts: async () => { if (armed) { armed = false; throw new Error('failpoint: the process died inside the paid generation'); } } };
    const cash = new CashRulesService(app.prisma, notifications, orders, observer);
    await expect(cash.handover(ride.id, driver.userId, { outcome: 'paid', gps: ride.drop })).rejects.toThrow(/failpoint/);
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({
      status: 'RIDE_IN_PROGRESS', payment: 'PENDING', fares: 0, duration: null, driver: { available: false, pointer: ride.id, rides: 0 },
    });
    const retry = await driverCall('POST', driver.token, ride.id, 'handover', { outcome: 'paid', gps: ride.drop });
    expect(retry.statusCode).toBe(200);
    expect(await facts(ride.id, passenger.userId, driver.driverId)).toMatchObject({ status: 'DELIVERED', payment: 'CAPTURED', fares: 1, driver: { available: true, pointer: null, rides: 1 } });
  });

  it('a claim names exactly one mover — the database refuses both or neither', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await makeRideInProgress(passenger.userId, driver.driverId);
    const base = { orderId: ride.id, customerId: passenger.userId, amount: 2000, reason: 'refused', gpsLat: ride.drop.lat, gpsLng: ride.drop.lng, flags: [] as string[] };
    await expect(app.prisma.reimbursementClaim.create({ data: { ...base, riderId: 'rider_x', driverId: driver.driverId } })).rejects.toThrow();
    await expect(app.prisma.reimbursementClaim.create({ data: { ...base, riderId: null, driverId: null } })).rejects.toThrow();
  });
});

describe('[M-29 · operations] the reconciler and the review set', () => {
  it('never mints a fare for a cash ride delivered without a captured fare, and reports the review set — legacy apart from since-enforced', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    // Delivered an hour ago with no fare outcome: after the enforcement instant, so a bypass.
    const bypass = await makeRideInProgress(passenger.userId, driver.driverId, { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 60 * 60_000) });
    // Delivered before the fare outcome existed: legacy, reviewed by a person, never minted here.
    const legacy = await makeRideInProgress(passenger.userId, driver.driverId, { status: 'DELIVERED', deliveredAt: new Date(TAXI_FARE_OUTCOME_ENFORCED_AT.getTime() - DAY) });
    await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: null, isAvailable: true } });
    const result = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(result.healed).not.toContain(bypass.id);
    expect(result.healed).not.toContain(legacy.id);
    expect(await app.prisma.earning.count({ where: { orderId: { in: [bypass.id, legacy.id] } } })).toBe(0);
    expect(result.taxiUnpaidDelivered.total).toBeGreaterThanOrEqual(2);
    expect(result.taxiUnpaidDelivered.sinceEnforced).toBeGreaterThanOrEqual(1);
    expect(result.taxiUnpaidDelivered.total).toBeGreaterThan(result.taxiUnpaidDelivered.sinceEnforced);
    const gauge = await taxiDeliveredUnpaidGauge.get();
    const measure = (m: string) => gauge.values.find((v) => v.labels['measure'] === m)?.value;
    expect(measure('total')).toBe(result.taxiUnpaidDelivered.total);
    expect(measure('since_enforced')).toBe(result.taxiUnpaidDelivered.sinceEnforced);
    // The writer itself refuses too: a direct call mints nothing for an unpaid cash ride.
    expect(await orders.createEarnings(bypass.id, app.prisma, false)).toEqual([]);
    expect(await app.prisma.earning.count({ where: { orderId: bypass.id } })).toBe(0);
  });
});
