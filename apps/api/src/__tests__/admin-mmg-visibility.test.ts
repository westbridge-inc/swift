import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, OrderType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { OrderService } from '../modules/order/order.service';
import { FloatService } from '../modules/dispatch/float.service';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// MMG Phase 4 — admin sees the money story without touching money: the
// MMG-vs-cash mix, delivery-fee cash-ledger rows + per-status totals, and
// how many delivered MMG orders were never confirmed by the vendor.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
let vendorId: string;
let riderId: string;

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  return server;
}

let seq = 0;
async function makeUser(roles: ('CUSTOMER' | 'VENDOR_OWNER' | 'MOVER')[], activeRole: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200751${String(seq).padStart(2, '0')}`,
      firstName: 'AdminVis', lastName: `U${seq}`,
      roles: roles as any, activeRole: activeRole as any, isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeOrder(opts: { payment: 'CASH' | 'MOBILE_MONEY'; captured?: boolean; customerId: string }) {
  return app.prisma.order.create({
    data: {
      orderNumber: `AVIS-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
      customerId: opts.customerId, vendorId, riderId, status: 'DELIVERED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: 1300,
      paymentMethod: opts.payment,
      paymentStatus: opts.captured ? 'CAPTURED' : 'PENDING',
    },
  });
}

type TaxiCustodyFixture = {
  status: 'DRIVER_ARRIVED' | 'RIDE_IN_PROGRESS';
  ridePinVerified: boolean;
  ridePinVerifiedAt: Date | null;
};

async function makeTaxiCustodyOrder(fixture: TaxiCustodyFixture) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: mover.id,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2020,
      vehicleColor: 'Silver',
      licensePlate: `ARF-${nanoid(6)}`,
      driverLicenseUrl: 'storage://test/admin-refund-license',
      vehicleInsuranceUrl: 'storage://test/admin-refund-insurance',
      isOnline: true,
      locationSessionId: syntheticLocationOwner('admin-mmg'),
      isAvailable: false,
    },
  });
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `AVIS-TAXI-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId: customer.id,
      driverId: driver.id,
      status: fixture.status,
      pickupAddress: 'Custody pickup',
      pickupLat: 6.8,
      pickupLng: -58.15,
      deliveryAddress: 'Custody dropoff',
      deliveryLat: 6.81,
      deliveryLng: -58.16,
      subtotalBase: 1500,
      subtotalMarkup: 0,
      subtotalCustomer: 1500,
      deliveryFee: 0,
      totalAmount: 1500,
      taxiFareTotal: 1500,
      paymentMethod: 'CASH',
      ridePinVerified: fixture.ridePinVerified,
      ridePinVerifiedAt: fixture.ridePinVerifiedAt,
    },
  });
  await app.prisma.driver.update({
    where: { id: driver.id },
    data: { currentRideId: order.id },
  });
  return { order, driver };
}

async function makePickedUpOrder(orderType: Extract<OrderType, 'FOOD_DELIVERY' | 'COURIER'>) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: mover.id,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      isOnline: true,
      locationSessionId: syntheticLocationOwner('admin-mmg'),
      isAvailable: false,
    },
  });
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `AVIS-CUSTODY-${nanoid(8)}`,
      orderType,
      customerId: customer.id,
      ...(orderType === 'FOOD_DELIVERY' ? { vendorId } : {}),
      riderId: rider.id,
      status: 'PICKED_UP',
      pickupAddress: 'Parcel pickup',
      pickupLat: 6.8,
      pickupLng: -58.15,
      deliveryAddress: 'Parcel dropoff',
      deliveryLat: 6.81,
      deliveryLng: -58.16,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 300,
      totalAmount: 1300,
      paymentMethod: 'CASH',
    },
  });
  await app.prisma.rider.update({
    where: { id: rider.id },
    data: { currentOrderId: order.id },
  });
  return { order, rider };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'AdminVis Diner', slug: `adminvis-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920075100', addressLine1: '5 Deal St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE',
    },
  });
  vendorId = vendor.id;
  const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({ data: { userId: mover.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderId = rider.id;

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  // Two MMG orders (one confirmed, one the vendor never confirmed) + one cash.
  const mmgConfirmed = await makeOrder({ payment: 'MOBILE_MONEY', captured: true, customerId: customer.id });
  await makeOrder({ payment: 'MOBILE_MONEY', captured: false, customerId: customer.id });
  await makeOrder({ payment: 'CASH', captured: true, customerId: customer.id });
  // Ledger rows in two states.
  await app.prisma.deliveryCashSettlement.create({
    data: { orderId: mmgConfirmed.id, riderId, vendorId, amount: 300, status: 'OWED' },
  });
});

afterAll(async () => {
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { vendorId } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

function get(url: string, token = adminToken) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('GET /admin/finance/cash-settlements', () => {
  it('lists ledger rows with order/vendor/rider context + per-status totals', async () => {
    const res = await get('/api/v1/admin/finance/cash-settlements?limit=50');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const mine = body.data.find((r: any) => r.vendor?.id === vendorId);
    expect(mine).toBeTruthy();
    expect(mine.amount).toBe(300);
    expect(mine.status).toBe('OWED');
    expect(mine.orderNumber).toMatch(/^AVIS-/);
    expect(mine.rider?.name).toContain('AdminVis');
    expect(body.summary.OWED.count).toBeGreaterThanOrEqual(1);
    expect(body.summary.OWED.total).toBeGreaterThanOrEqual(300);
  });

  it('filters by status', async () => {
    const res = await get('/api/v1/admin/finance/cash-settlements?status=SETTLED&limit=50');
    expect(res.statusCode).toBe(200);
    for (const r of res.json().data) expect(r.status).toBe('SETTLED');
  });

  it('rejects a non-admin', async () => {
    // The CUSTOMER user created in beforeAll (seq 3).
    const outsider = await loginWithOtp(app, '+5920075103');
    const token = outsider.json().data.tokens.accessToken;
    const res = await get('/api/v1/admin/finance/cash-settlements', token);
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('PUT /admin/orders/:id/cancel — journal close [SWIFT-095]', () => {
  it('[A-14] records the refund as OWED — not as done — while writing both canonical audits', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-RF-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, status: 'ACCEPTED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
      },
    });
    const response = await app.inject({
      method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'cash refund approved', refund: true },
    });
    expect(response.statusCode).toBe(200);
    // [A-14] This used to assert `{ status: 'REFUNDED', refunded: true }`. That
    // terminal was written off a click, with no amount, actor or evidence that
    // the store had handed anything back — a claim about somebody else's cash
    // drawer. The cancellation is now a cancellation, and the refund is an
    // obligation until it is settled against evidence.
    expect(response.json().data).toMatchObject({ status: 'CANCELLED', refundOwed: '1300' });
    const cancelled = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(Number(cancelled.refundOwedAmount)).toBe(1300);
    expect(cancelled.refundSettledAt).toBeNull();
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } })).toBe(1);
    // The two canonical audits this test exists for are unchanged.
    expect(await app.prisma.auditLog.count({ where: { action: 'CANCEL_ORDER', entityId: order.id } })).toBe(1);
    await purgeAuditLogs(app.prisma, { entityId: order.id }, 'test-cleanup:admin-mmg-visibility');
  });

  it('cancelling an unattested-MMG order tells the STORE it may hold the payment [REPORT-012 F-012-04]', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-MMG-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, status: 'ACCEPTED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300,
        paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING',
      },
    });
    const response = await app.inject({
      method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'vendor unreachable', refund: false },
    });
    expect(response.statusCode).toBe(200);
    // Customer guidance names the direct-refund rail…
    const customerNote = await app.prisma.notification.findFirst({
      where: { userId: customer.id, body: { contains: 'the store refunds you directly' } },
    });
    expect(customerNote).not.toBeNull();
    // …and the STORE gets the durable liability notice through the same seam
    // as customer cancel, auto-cancel, and the ops agent. Before F-012-04 an
    // admin terminal told only the customer.
    const storeNote = await app.prisma.notification.findFirst({
      where: {
        title: 'Cancelled order may hold an MMG payment',
        body: { contains: order.orderNumber },
      },
    });
    expect(storeNote).not.toBeNull();
    await purgeAuditLogs(app.prisma, { entityId: order.id }, 'test-cleanup:admin-mmg-visibility');
  });

  it.each([
    {
      signal: 'boolean-only PIN evidence',
      fixture: { status: 'DRIVER_ARRIVED', ridePinVerified: true, ridePinVerifiedAt: null },
    },
    {
      signal: 'timestamp-only PIN evidence',
      fixture: { status: 'DRIVER_ARRIVED', ridePinVerified: false, ridePinVerifiedAt: new Date('2026-08-08T12:00:00Z') },
    },
    {
      signal: 'RIDE_IN_PROGRESS status',
      fixture: { status: 'RIDE_IN_PROGRESS', ridePinVerified: false, ridePinVerifiedAt: null },
    },
  ] satisfies Array<{ signal: string; fixture: TaxiCustodyFixture }>)('refuses admin refund and generic REFUNDED terminalization for taxi custody: $signal', async ({ fixture }) => {
    const routeFixture = await makeTaxiCustodyOrder(fixture);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/orders/${routeFixture.order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'unsafe custody refund attempt', refund: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_STATUS');

    const [routeOrder, routeDriver, routeLogs, routeAudits] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: routeFixture.order.id },
        select: { status: true, driverId: true, ridePinVerified: true, ridePinVerifiedAt: true },
      }),
      app.prisma.driver.findUniqueOrThrow({
        where: { id: routeFixture.driver.id },
        select: { isAvailable: true, currentRideId: true },
      }),
      app.prisma.orderStatusLog.count({ where: { orderId: routeFixture.order.id, status: 'REFUNDED' } }),
      app.prisma.auditLog.count({ where: { action: 'CANCEL_ORDER', entityId: routeFixture.order.id } }),
    ]);
    expect(routeOrder).toEqual({
      status: fixture.status,
      driverId: routeFixture.driver.id,
      ridePinVerified: fixture.ridePinVerified,
      ridePinVerifiedAt: fixture.ridePinVerifiedAt,
    });
    expect(routeDriver).toEqual({ isAvailable: false, currentRideId: routeFixture.order.id });
    expect(routeLogs).toBe(0);
    expect(routeAudits).toBe(0);

    // A future generic/ops caller cannot recreate the bypass by supplying a
    // custom allowedFrom list. The same locked canonical seam rejects it.
    const serviceFixture = await makeTaxiCustodyOrder(fixture);
    await expect(new OrderService(app.prisma, app.io).transitionOrderAtomically({
      orderId: serviceFixture.order.id,
      target: 'REFUNDED',
      allowedFrom: [fixture.status],
      changedBy: null,
      note: 'adversarial generic refund terminalization',
      cancellation: { by: null, reason: 'adversarial generic refund terminalization' },
      releaseStaleMoverPointer: true,
    })).rejects.toMatchObject({ code: 'PASSENGER_IN_CUSTODY' });

    const [serviceOrder, serviceDriver, serviceLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: serviceFixture.order.id },
        select: { status: true, driverId: true },
      }),
      app.prisma.driver.findUniqueOrThrow({
        where: { id: serviceFixture.driver.id },
        select: { isAvailable: true, currentRideId: true },
      }),
      app.prisma.orderStatusLog.count({ where: { orderId: serviceFixture.order.id, status: 'REFUNDED' } }),
    ]);
    expect(serviceOrder).toEqual({ status: fixture.status, driverId: serviceFixture.driver.id });
    expect(serviceDriver).toEqual({ isAvailable: false, currentRideId: serviceFixture.order.id });
    expect(serviceLogs).toBe(0);
  });

  it('also refuses ordinary admin cancellation with timestamp-only taxi custody', async () => {
    const fixture = await makeTaxiCustodyOrder({
      status: 'DRIVER_ARRIVED',
      ridePinVerified: false,
      ridePinVerifiedAt: new Date('2026-08-08T12:30:00Z'),
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/orders/${fixture.order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'unsafe custody cancellation attempt', refund: false },
    });
    expect(response.statusCode).toBe(400);

    const [order, driver] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: fixture.order.id },
        select: { status: true, driverId: true, ridePinVerifiedAt: true },
      }),
      app.prisma.driver.findUniqueOrThrow({
        where: { id: fixture.driver.id },
        select: { isAvailable: true, currentRideId: true },
      }),
    ]);
    expect(order).toEqual({
      status: 'DRIVER_ARRIVED',
      driverId: fixture.driver.id,
      ridePinVerifiedAt: new Date('2026-08-08T12:30:00Z'),
    });
    expect(driver).toEqual({ isAvailable: false, currentRideId: fixture.order.id });
  });

  it.each([
    { orderType: 'FOOD_DELIVERY', refund: false, target: 'CANCELLED' },
    { orderType: 'COURIER', refund: true, target: 'REFUNDED' },
  ] satisfies Array<{
    orderType: Extract<OrderType, 'FOOD_DELIVERY' | 'COURIER'>;
    refund: boolean;
    target: Extract<OrderStatus, 'CANCELLED' | 'REFUNDED'>;
  }>)('keeps a picked-up $orderType assignment intact on admin $target', async ({ orderType, refund, target }) => {
    const fixture = await makePickedUpOrder(orderType);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/orders/${fixture.order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'unsafe post-pickup terminalization attempt', refund },
    });
    expect(response.statusCode).toBe(400);

    const [order, rider, logs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: fixture.order.id },
        select: { status: true, riderId: true },
      }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: fixture.rider.id },
        select: { isAvailable: true, currentOrderId: true },
      }),
      app.prisma.orderStatusLog.count({ where: { orderId: fixture.order.id, status: target } }),
    ]);
    expect(order).toEqual({ status: 'PICKED_UP', riderId: fixture.rider.id });
    expect(rider).toEqual({ isAvailable: false, currentOrderId: fixture.order.id });
    expect(logs).toBe(0);
  });

  it('allows a completed taxi trip to enter the financial REFUNDED state', async () => {
    const fixture = await makeTaxiCustodyOrder({
      status: 'RIDE_IN_PROGRESS',
      ridePinVerified: true,
      ridePinVerifiedAt: new Date('2026-08-08T13:00:00Z'),
    });
    await app.prisma.order.update({
      where: { id: fixture.order.id },
      data: { status: 'DELIVERED', deliveredAt: new Date('2026-08-08T13:30:00Z') },
    });
    await app.prisma.driver.update({
      where: { id: fixture.driver.id },
      data: { isAvailable: true, currentRideId: null },
    });

    const refunded = await new OrderService(app.prisma, app.io)
      .updateStatus(fixture.order.id, 'REFUNDED', 'financial-refund-test', 'post-trip refund');
    expect(refunded.status).toBe('REFUNDED');
    expect(await app.prisma.driver.findUniqueOrThrow({
      where: { id: fixture.driver.id },
      select: { isAvailable: true, currentRideId: true },
    })).toEqual({ isAvailable: true, currentRideId: null });
  });

  it('keeps a newer cash job pointer and float committed when refunding an older delivery', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const assignedRider = await app.prisma.rider.create({
      data: {
        userId: mover.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        isOnline: true,
        locationSessionId: syntheticLocationOwner('admin-mmg'),
        isAvailable: true,
        floatLimit: 100_000,
      },
    });
    const oldOrder = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-OLD-RF-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, riderId: assignedRider.id, status: 'DELIVERED',
        deliveryAddress: 'old destination', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH', deliveredAt: new Date(),
      },
    });
    const newOrder = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-NEW-CASH-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, riderId: assignedRider.id, status: 'RIDER_ASSIGNED',
        deliveryAddress: 'new destination', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 2400, subtotalMarkup: 0, subtotalCustomer: 2400,
        deliveryFee: 400, totalAmount: 2800, paymentMethod: 'CASH', acceptedAt: new Date(),
      },
    });
    await app.prisma.$transaction(async (tx) => {
      expect(await new FloatService(tx).commit(tx, assignedRider.id, 2400)).toBe(true);
      await tx.rider.update({
        where: { id: assignedRider.id },
        data: { isAvailable: false, currentOrderId: newOrder.id },
      });
    });
    const staleSearch = await app.prisma.dispatchSearch.create({
      data: {
        vertical: 'DELIVERY', subjectId: oldOrder.id, status: 'SEARCHING',
        radiusKm: 5,
      },
    });

    try {
      const refunded = await new OrderService(app.prisma, app.io)
        .updateStatus(oldOrder.id, 'REFUNDED', 'financial-refund-test', 'refund after delivery');
      expect(refunded.status).toBe('REFUNDED');

      const [rider, search] = await Promise.all([
        app.prisma.rider.findUniqueOrThrow({
          where: { id: assignedRider.id },
          select: { isAvailable: true, currentOrderId: true, committedFloat: true },
        }),
        app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: staleSearch.id } }),
      ]);
      expect(rider.isAvailable).toBe(false);
      expect(rider.currentOrderId).toBe(newOrder.id);
      expect(Number(rider.committedFloat)).toBe(2400);
      expect(search.status).toBe('SEARCHING');
    } finally {
      await app.prisma.dispatchSearch.deleteMany({ where: { id: staleSearch.id } });
    }
  });

  it('re-reads a direct assignment that commits while admin cancellation is waiting', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const assignedRider = await app.prisma.rider.create({
      data: {
        userId: mover.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        isOnline: true,
        locationSessionId: syntheticLocationOwner('admin-mmg'),
        isAvailable: true,
        floatLimit: 100_000,
      },
    });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-R-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, status: 'ACCEPTED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
      },
    });

    let assignmentStaged!: () => void;
    let resumeAssignment!: () => void;
    let adminTransitionStarted!: () => void;
    const atAssignmentStage = new Promise<void>((resolve) => { assignmentStaged = resolve; });
    const releaseAssignment = new Promise<void>((resolve) => { resumeAssignment = resolve; });
    const atAdminTransition = new Promise<void>((resolve) => { adminTransitionStarted = resolve; });
    const orders = new OrderService(app.prisma, app.io);

    const assignmentPending = app.prisma.$transaction(async (tx) => {
      expect(await new FloatService(tx).commit(tx, assignedRider.id, 1000)).toBe(true);
      const staged = await orders.stageDirectRiderAssignment(tx, {
        orderId: order.id,
        riderId: assignedRider.id,
        changedBy: mover.id,
        moverUserId: mover.id,
        note: 'deterministic direct assignment race',
      });
      assignmentStaged();
      await releaseAssignment;
      return staged;
    });
    await atAssignmentStage;

    const originalTerminalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const terminalSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        adminTransitionStarted();
        return originalTerminalStage.call(this, tx, input);
      });
    let cancellation;
    try {
      const cancelPending = app.inject({
        method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        payload: { reason: 'ops override during assignment' },
      });
      await atAdminTransition;
      resumeAssignment();
      [, cancellation] = await Promise.all([assignmentPending, cancelPending]);
    } finally {
      resumeAssignment();
      terminalSpy.mockRestore();
    }
    expect(cancellation!.statusCode).toBe(200);

    const [afterOrder, afterRider, logs, action] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: assignedRider.id },
        select: { isAvailable: true, currentOrderId: true, committedFloat: true },
      }),
      app.prisma.orderStatusLog.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
        select: { status: true },
      }),
      app.prisma.auditLog.findFirst({ where: { action: 'CANCEL_ORDER', entityId: order.id } }),
    ]);
    expect(afterOrder).toEqual({ status: 'CANCELLED', riderId: assignedRider.id });
    expect(afterRider.isAvailable).toBe(true);
    expect(afterRider.currentOrderId).toBeNull();
    expect(Number(afterRider.committedFloat)).toBe(0);
    expect(logs.map((entry) => entry.status)).toEqual(['RIDER_ASSIGNED', 'CANCELLED']);
    expect((action!.changes as Record<string, unknown>)['previousStatus']).toBe('RIDER_ASSIGNED');
    await purgeAuditLogs(app.prisma, { entityId: order.id }, 'test-cleanup:admin-mmg-visibility');
  });

  it('rolls back admin status, search, float, mover, and both canonical audits on a fault', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const assignedRider = await app.prisma.rider.create({
      data: {
        userId: mover.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        isAvailable: false,
        floatLimit: 100_000,
        committedFloat: 1000,
      },
    });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-F-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, riderId: assignedRider.id, status: 'RIDER_ASSIGNED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
      },
    });
    await app.prisma.rider.update({
      where: { id: assignedRider.id },
      data: { currentOrderId: order.id },
    });
    const search = await app.prisma.dispatchSearch.create({
      data: { vertical: 'DELIVERY', subjectId: order.id, status: 'SEARCHING', radiusKm: 5 },
    });

    const originalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        await originalStage.call(this, tx, input);
        throw new Error('forced admin-cancel pre-commit abort');
      });
    let response;
    try {
      response = await app.inject({
        method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        payload: { reason: 'ops fault injection' },
      });
    } finally {
      stageSpy.mockRestore();
    }
    expect(response!.statusCode).toBe(500);

    const [afterOrder, afterRider, afterSearch, statusAudit, adminAudit] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: assignedRider.id },
        select: { isAvailable: true, currentOrderId: true, committedFloat: true },
      }),
      app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: search.id }, select: { status: true } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } }),
      app.prisma.auditLog.count({ where: { action: 'CANCEL_ORDER', entityId: order.id } }),
    ]);
    expect(afterOrder.status).toBe('RIDER_ASSIGNED');
    expect(afterRider.isAvailable).toBe(false);
    expect(afterRider.currentOrderId).toBe(order.id);
    expect(Number(afterRider.committedFloat)).toBe(1000);
    expect(afterSearch.status).toBe('SEARCHING');
    expect(statusAudit).toBe(0);
    expect(adminAudit).toBe(0);

    await app.prisma.dispatchSearch.delete({ where: { id: search.id } });
    await purgeAuditLogs(app.prisma, { entityId: order.id }, 'test-cleanup:admin-mmg-visibility');
  });

  it('closes an open dispatch search instead of leaving it SEARCHING forever', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-C-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, status: 'ACCEPTED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
      },
    });
    // As if the order were mid-dispatch when the admin cancels it.
    const search = await app.prisma.dispatchSearch.create({
      data: { vertical: 'DELIVERY', subjectId: order.id, status: 'SEARCHING', radiusKm: 5 },
    });

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'ops override' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    // RED before SWIFT-095: the search journal stayed SEARCHING — a ghost on the ops board.
    const after = await app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(after.status).toBe('CANCELLED');
    const action = await app.prisma.auditLog.findFirst({
      where: { action: 'CANCEL_ORDER', entityId: order.id },
    });
    expect(action).not.toBeNull();
    expect((action!.changes as Record<string, unknown>)['previousStatus']).toBe('ACCEPTED');

    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: order.id } });
    await purgeAuditLogs(app.prisma, { entityId: order.id }, 'test-cleanup:admin-mmg-visibility');
  });
});

describe('GET /admin/finance/payment-mix', () => {
  it('splits completed orders by payment method and counts unconfirmed MMG', async () => {
    const res = await get('/api/v1/admin/finance/payment-mix');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    const mmg = data.byMethod.find((m: any) => m.method === 'MOBILE_MONEY');
    const cash = data.byMethod.find((m: any) => m.method === 'CASH');
    expect(mmg.count).toBeGreaterThanOrEqual(2);
    expect(cash.count).toBeGreaterThanOrEqual(1);
    // The MMG order the vendor never confirmed shows up as follow-up work.
    expect(data.mmgUnconfirmed).toBeGreaterThanOrEqual(1);
  });
});
