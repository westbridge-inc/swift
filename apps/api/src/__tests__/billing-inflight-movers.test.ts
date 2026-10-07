import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { cleanupBillingClocks, cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';

// BILLING-INFLIGHT, movers (owner ruling 1 Oct ~22:10: a suspended partner
// finishes accepted work; only NEW work is blocked until it pays). A weekly-fee
// suspension takes a rider or driver offline (billing suspendAccessRows). That
// must stop new offers and accepts, and must never strand the delivery or ride
// they already hold. The suspension here is the real one: three failed weekly
// charges run through the billing engine, not a hand-written status.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PICKUP = { lat: 6.8013, lng: -58.1551 };
// Disjoint window: 592_009_700_000..592_009_799_999 (this file only).
const phoneBase = 592_009_700_000 + Math.floor(Math.random() * 90_000);

let app: FastifyInstance;
let billing: BillingService;
let vendorId = '';
let seq = 0;
const userIds: string[] = [];
const orderIds: string[] = [];
const subIds: string[] = [];

async function userWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Inflight', lastName: `M${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `inflight-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, sessionId: session.id };
}

/** A CASH weekly fee with nothing prepaid, due `due`: every charge fails. */
async function brokeSubscription(owner: { riderId: string } | { driverId: string }, due: Date) {
  const sub = await app.prisma.subscription.create({
    data: {
      ...owner, type: 'riderId' in owner ? 'DELIVERY_RIDER' : 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 6000, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 0 } },
    },
  });
  subIds.push(sub.id);
  return sub.id;
}

/** Three failed charges over 50 hours: the engine's own suspension. */
async function suspendByBilling(subId: string, due: Date) {
  await billing.runBillingCycle(due);
  await billing.runBillingCycle(new Date(due.getTime() + 25 * HOUR));
  await billing.runBillingCycle(new Date(due.getTime() + 50 * HOUR));
  expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status).toBe('SUSPENDED');
}

const send = (method: 'PUT' | 'POST', url: string, token: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method, url, payload, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  const vendor = await app.prisma.vendor.findFirst({ select: { id: true } });
  if (!vendor) throw new Error('no vendor in the test database (seed first)');
  vendorId = vendor.id;
});

afterAll(async () => {
  // order_status_logs is append-only: deleting the parent orders cascades them.
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  // [#1393] A mover's fee authority and its sources go with the payer: clocks
  // first, then the people (riders/drivers with them), then the orphaned subscriptions.
  await cleanupPayerBillingClocks(app.prisma, userIds);
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.close();
});

describe('BILLING-INFLIGHT — a fee-suspended mover finishes the job they hold, and takes no new one', () => {
  it('a rider suspended mid-delivery walks the whole leg to the door; new orders are refused', async () => {
    const r = await userWithSession(['RIDER', 'CUSTOMER'], 'RIDER');
    const rider = await app.prisma.rider.create({
      data: {
        userId: r.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
        isOnline: true, isAvailable: false, currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(), locationSessionId: r.sessionId,
      },
    });
    const customer = await userWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `INFM-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customer.userId, vendorId, riderId: rider.id,
        status: 'RIDER_ASSIGNED', deliveryAddress: '1 Inflight St', deliveryLat: PICKUP.lat, deliveryLng: PICKUP.lng,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
        paymentMethod: 'CASH', paymentStatus: 'CAPTURED',
      },
    });
    orderIds.push(order.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: order.id } });

    const due = new Date(Date.now() - 3 * DAY);
    const subId = await brokeSubscription({ riderId: rider.id }, due);
    await suspendByBilling(subId, due);
    // The suspension really took the rider offline.
    const off = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(off.isOnline).toBe(false);

    for (const slug of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived']) {
      const res = await send('PUT', `/api/v1/rider/orders/${order.id}/${slug}`, r.token);
      expect(res.statusCode, `${slug}: ${res.body}`).toBe(200);
    }
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ARRIVED');

    // NEW work stays blocked: no accept while offline (go-online's own refusal of
    // an unpaid fee is pinned in operate-gate-unification.test.ts).
    const another = await app.prisma.order.create({
      data: {
        orderNumber: `INFM-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customer.userId, vendorId,
        status: 'READY_FOR_PICKUP', deliveryAddress: '2 Inflight St', deliveryLat: PICKUP.lat, deliveryLng: PICKUP.lng,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });
    orderIds.push(another.id);
    const accept = await send('POST', `/api/v1/rider/orders/${another.id}/accept`, r.token);
    expect(accept.statusCode).toBe(400);
    expect(accept.json().error.code).toBe('OFFLINE');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: another.id } })).riderId).toBeNull();
  });

  it('a driver suspended mid-ride arrives, verifies the PIN and starts the trip; new rides are refused', async () => {
    const d = await userWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
    const driver = await app.prisma.driver.create({
      data: {
        userId: d.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
        licensePlate: `INF ${seq}42`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
        isOnline: true, isAvailable: false, locationSessionId: d.sessionId,
        currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
      },
    });
    const customer = await userWithSession(['CUSTOMER'], 'CUSTOMER');
    const pin = `${200000 + seq}`;
    const ride = await app.prisma.order.create({
      data: {
        orderNumber: `INFR-${nanoid(8)}`, orderType: 'TAXI', customerId: customer.userId, driverId: driver.id,
        status: 'DRIVER_EN_ROUTE', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        deliveryAddress: 'dropoff', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500,
        paymentMethod: 'CASH', ridePin: pin,
      },
    });
    orderIds.push(ride.id);
    await app.prisma.driver.update({ where: { id: driver.id }, data: { currentRideId: ride.id } });

    const due = new Date(Date.now() - 3 * DAY);
    const subId = await brokeSubscription({ driverId: driver.id }, due);
    await suspendByBilling(subId, due);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).isOnline).toBe(false);
    // The fix the arrival gate reads is fresh and at the pickup.
    await app.prisma.driver.update({ where: { id: driver.id }, data: { currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date() } });

    const arrived = await send('PUT', `/api/v1/driver/rides/${ride.id}/arrived`, d.token);
    expect(arrived.statusCode, arrived.body).toBe(200);
    const verified = await send('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, d.token, { pin });
    expect(verified.statusCode, verified.body).toBe(200);
    const started = await send('PUT', `/api/v1/driver/rides/${ride.id}/start`, d.token);
    expect(started.statusCode, started.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } })).status).toBe('RIDE_IN_PROGRESS');

    // NEW work stays blocked.
    const other = await userWithSession(['CUSTOMER'], 'CUSTOMER');
    const next = await app.prisma.order.create({
      data: {
        orderNumber: `INFR-${nanoid(8)}`, orderType: 'TAXI', customerId: other.userId,
        status: 'PENDING', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        deliveryAddress: 'dropoff', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });
    orderIds.push(next.id);
    const accept = await send('POST', `/api/v1/driver/rides/${next.id}/accept`, d.token);
    expect(accept.statusCode).toBe(400);
    expect(accept.json().error.code).toBe('OFFLINE');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: next.id } })).driverId).toBeNull();
  });
});
