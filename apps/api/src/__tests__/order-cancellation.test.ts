import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { autoCancelUnresponsiveOrder, autoCompleteDeliveredOrder } from '../jobs/queue';
import { OrderService } from '../modules/order/order.service';
import { FloatService } from '../modules/dispatch/float.service';

// ---------------------------------------------------------------------------
// Cancellation & rejection lifecycle — the failure paths of an order, hit over
// HTTP (not just the state machine in isolation). Who can kill an order, from
// which states, what it costs, and what it puts back: rider freed, stock
// restocked, slot released. Money-touching, so failure-first.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;

// Per-run random base keeps phones from colliding with other test files or
// leftovers from a prior interrupted run (parallel vitest, shared dev DB).
const phoneBase = 592_100_000_000 + Math.floor(Math.random() * 800_000_000);
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Cancel',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'cancel-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor() {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Cancel Vendor ${seq}`,
      slug: `cancel-vendor-${nanoid(10).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+5920006${String(seq).padStart(3, '0')}`,
      addressLine1: '1 Cancel Court',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  const category = await app.prisma.category.create({
    data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 },
  });
  return { ...owned, vendorId: vendor.id, categoryId: category.id };
}

/** An order in a given state, optionally with an assigned rider and a
 *  stock-tracked line item. placedAtMinutesAgo backdates it past the free
 *  cancellation window. */
async function makeOrder(
  customerId: string,
  vendorId: string,
  status: OrderStatus,
  opts: { riderId?: string; itemId?: string; qty?: number; placedAtMinutesAgo?: number } = {},
) {
  const placedAt = new Date(Date.now() - (opts.placedAtMinutesAgo ?? 0) * 60_000);
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CX-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status,
      placedAt,
      deliveryAddress: 'cancel-matrix',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 0,
      totalAmount: 1000,
      paymentMethod: 'CASH',
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
    },
  });
  if (opts.itemId) {
    await app.prisma.orderItem.create({
      data: {
        orderId: order.id,
        itemId: opts.itemId,
        name: 'Tracked Plate',
        quantity: opts.qty ?? 1,
        basePrice: 1000,
        markedUpPrice: 1000,
        markupAmount: 0,
        totalBase: 1000,
        totalMarkup: 0,
        totalCustomer: 1000,
      },
    });
  }
  createdOrderIds.push(order.id);
  return order;
}

async function makeRider() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: owned.userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      isAvailable: false,
    },
  });
  return { ...owned, riderId: rider.id };
}

async function makeTaxiDriver() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2020,
      vehicleColor: 'Silver',
      licensePlate: `CUST-${nanoid(6)}`,
      driverLicenseUrl: 'storage://test/license',
      vehicleInsuranceUrl: 'storage://test/insurance',
      isOnline: true,
      isAvailable: false,
    },
  });
  return { ...owned, driverId: driver.id };
}

async function makeVerifiedArrivedTaxi(customerId: string, driverId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CX-TAXI-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'DRIVER_ARRIVED',
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
      ridePinVerified: true,
      ridePinVerifiedAt: new Date(),
    },
  });
  createdOrderIds.push(order.id);
  await app.prisma.driver.update({ where: { id: driverId }, data: { currentRideId: order.id } });
  return order;
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

let customer: { userId: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  // OrderItem + OrderStatusLog both cascade on order delete (the latter is
  // append-only — an explicit delete would hit the immutability guard).
  await app.prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Vendor rejects an order — PUT /vendor/orders/:id/reject', () => {
  it('rejects a PENDING order into CANCELLED with a status-log entry', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING');

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'Out of stock' }, vendor.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('CANCELLED');

    const log = await app.prisma.orderStatusLog.findFirst({
      where: { orderId: order.id, status: 'CANCELLED' },
    });
    expect(log).not.toBeNull();
    expect(log!.note).toBe('Out of stock');
  });

  it('SWIFT-024: notifies the customer, with the reason', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING');

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'Kitchen closed' }, vendor.token);
    expect(res.statusCode).toBe(200);

    // RED before SWIFT-024: reject only emitted a socket event, so a customer
    // whose app was closed got no persisted notification at all.
    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, type: 'ORDER_UPDATE', data: { path: ['orderId'], equals: order.id } },
    });
    expect(note).not.toBeNull();
    expect(note!.body).toContain('declined');
    expect(note!.body).toContain('Kitchen closed');
  });

  it('rejecting an ACCEPTED order frees the assigned rider', async () => {
    const vendor = await makeVendor();
    const rider = await makeRider();
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: 'placeholder' },
    });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { riderId: rider.riderId });

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, {}, vendor.token);
    expect(res.statusCode).toBe(200);

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
  });

  it('restocks tracked stock AND releases the CASH rider’s committed float on reject', async () => {
    const vendor = await makeVendor();
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.vendorId, categoryId: vendor.categoryId, name: 'Tracked Plate', basePrice: 1000, stockQuantity: 4, isAvailable: true },
    });
    const rider = await makeRider();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { riderId: rider.riderId, itemId: item.id, qty: 2 });
    // Rider is mid-job on this CASH order: float committed for the vendor-cash.
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { floatLimit: 100_000, committedFloat: 1000, currentOrderId: order.id, isAvailable: false },
    });
    // Checkout decremented the shelf 4 → 2.
    await app.prisma.item.update({ where: { id: item.id }, data: { stockQuantity: 2 } });

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, { reason: '86ed' }, vendor.token);
    expect(res.statusCode).toBe(200);

    const freshItem = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(freshItem.stockQuantity).toBe(4); // the 2 units go back on the shelf

    const freshRider = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(Number(freshRider.committedFloat)).toBe(0); // float released (was leaking → rider frozen out of CASH offers)
    expect(freshRider.currentOrderId).toBeNull();
    expect(freshRider.isAvailable).toBe(true);
  });

  it('rolls back reject status, stock, search, float, mover, and audit on a pre-commit fault', async () => {
    const vendor = await makeVendor();
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.vendorId, categoryId: vendor.categoryId, name: 'Fault Plate', basePrice: 1000, stockQuantity: 2, isAvailable: true },
    });
    const rider = await makeRider();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', {
      riderId: rider.riderId,
      itemId: item.id,
      qty: 2,
    });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { floatLimit: 100_000, committedFloat: 1000, currentOrderId: order.id, isAvailable: false },
    });
    const search = await app.prisma.dispatchSearch.create({
      data: { vertical: 'DELIVERY', subjectId: order.id, status: 'SEARCHING', radiusKm: 5 },
    });

    const originalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        await originalStage.call(this, tx, input);
        throw new Error('forced vendor-reject pre-commit abort');
      });
    let response;
    try {
      response = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'fault' }, vendor.token);
    } finally {
      stageSpy.mockRestore();
    }
    expect(response!.statusCode).toBe(500);

    const [afterOrder, afterItem, afterRider, afterSearch, auditCount] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }),
      app.prisma.item.findUniqueOrThrow({ where: { id: item.id }, select: { stockQuantity: true } }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: rider.riderId },
        select: { isAvailable: true, currentOrderId: true, committedFloat: true },
      }),
      app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: search.id }, select: { status: true } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } }),
    ]);
    expect(afterOrder.status).toBe('ACCEPTED');
    expect(afterItem.stockQuantity).toBe(2);
    expect(afterRider.isAvailable).toBe(false);
    expect(afterRider.currentOrderId).toBe(order.id);
    expect(Number(afterRider.committedFloat)).toBe(1000);
    expect(afterSearch.status).toBe('SEARCHING');
    expect(auditCount).toBe(0);
    await app.prisma.dispatchSearch.delete({ where: { id: search.id } });
  });

  it('loses cleanly when a direct assignment commits while vendor reject is waiting', async () => {
    const vendor = await makeVendor();
    const rider = await makeRider();
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isOnline: true, isAvailable: true, floatLimit: 100_000, committedFloat: 0 },
    });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED');

    let assignmentStaged!: () => void;
    let resumeAssignment!: () => void;
    let rejectTransitionStarted!: () => void;
    const atAssignmentStage = new Promise<void>((resolve) => { assignmentStaged = resolve; });
    const releaseAssignment = new Promise<void>((resolve) => { resumeAssignment = resolve; });
    const atRejectTransition = new Promise<void>((resolve) => { rejectTransitionStarted = resolve; });
    const orders = new OrderService(app.prisma, app.io);

    const assignmentPending = app.prisma.$transaction(async (tx) => {
      expect(await new FloatService(tx).commit(tx, rider.riderId, 1000)).toBe(true);
      const staged = await orders.stageDirectRiderAssignment(tx, {
        orderId: order.id,
        riderId: rider.riderId,
        changedBy: rider.userId,
        moverUserId: rider.userId,
        note: 'deterministic vendor race',
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
        rejectTransitionStarted();
        return originalTerminalStage.call(this, tx, input);
      });
    let rejection;
    try {
      const rejectPending = inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'too late' }, vendor.token);
      await atRejectTransition;
      resumeAssignment();
      [, rejection] = await Promise.all([assignmentPending, rejectPending]);
    } finally {
      resumeAssignment();
      terminalSpy.mockRestore();
    }
    expect(rejection!.statusCode).toBe(400);
    expect(rejection!.json().error.code).toBe('INVALID_STATUS');

    const [afterOrder, afterRider, cancelledLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: rider.riderId },
        select: { isAvailable: true, currentOrderId: true, committedFloat: true },
      }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } }),
    ]);
    expect(afterOrder).toEqual({ status: 'RIDER_ASSIGNED', riderId: rider.riderId });
    expect(afterRider.isAvailable).toBe(false);
    expect(afterRider.currentOrderId).toBe(order.id);
    expect(Number(afterRider.committedFloat)).toBe(1000);
    expect(cancelledLogs).toBe(0);
  });

  it('two concurrent rejects: exactly one wins, stock restocked once (no phantom stock)', async () => {
    const vendor = await makeVendor();
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.vendorId, categoryId: vendor.categoryId, name: 'Race Plate', basePrice: 1000, stockQuantity: 5, isAvailable: true },
    });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING', { itemId: item.id, qty: 3 });
    await app.prisma.item.update({ where: { id: item.id }, data: { stockQuantity: 2 } }); // post-checkout

    const [a, b] = await Promise.allSettled([
      inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, {}, vendor.token),
      inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, {}, vendor.token),
    ]);
    const codes = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.statusCode : 0)).sort();
    expect(codes).toEqual([200, 400]); // one wins, the loser 400s — not a second restock

    const freshItem = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(freshItem.stockQuantity).toBe(5); // 3 restored EXACTLY once (a double-restock would read 8)
  });

  it('refuses to reject once the order is READY_FOR_PICKUP (goods already made)', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'READY_FOR_PICKUP');

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, {}, vendor.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_STATUS');

    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.status).toBe('READY_FOR_PICKUP');
  });

  it("a vendor cannot reject another vendor's order", async () => {
    const vendorA = await makeVendor();
    const vendorB = await makeVendor();
    const order = await makeOrder(customer.userId, vendorA.vendorId, 'PENDING');

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, {}, vendorB.token);
    expect([403, 404]).toContain(res.statusCode);

    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.status).toBe('PENDING');
  });
});

describe('Customer cancels an order — POST /customer/orders/:id/cancel', () => {
  it('is free within 5 minutes while still PENDING', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING', { placedAtMinutesAgo: 1 });

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, { reason: 'changed my mind' }, customer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cancellationFee).toBe(0);

    const cancelled = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('charges the cancellation fee once the vendor has accepted', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { placedAtMinutesAgo: 1 });

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, {}, customer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cancellationFee).toBe(500);
  });

  it('charges the fee even while PENDING once the free window has passed', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING', { placedAtMinutesAgo: 10 });

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, {}, customer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cancellationFee).toBe(500);
  });

  it('cannot cancel once the order is in transit', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PICKED_UP');

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, {}, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IN_TRANSIT');

    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.status).toBe('PICKED_UP');
  });

  it('cannot cancel a taxi after PIN handoff while status is still DRIVER_ARRIVED', async () => {
    const driver = await makeTaxiDriver();
    const order = await makeVerifiedArrivedTaxi(customer.userId, driver.driverId);

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, {}, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IN_TRANSIT');
    await expect(
      new OrderService(app.prisma, app.io).updateStatus(order.id, 'CANCELLED', 'agent'),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    const [untouched, profile] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } }),
    ]);
    expect({ status: untouched.status, driverId: untouched.driverId, verified: untouched.ridePinVerified })
      .toEqual({ status: 'DRIVER_ARRIVED', driverId: driver.driverId, verified: true });
    expect(profile.currentRideId).toBe(order.id);
  });

  it('restocks a tracked item and frees the rider on cancellation', async () => {
    const vendor = await makeVendor();
    const rider = await makeRider();
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.vendorId, categoryId: vendor.categoryId, name: 'Tracked Plate', basePrice: 1000, stockQuantity: 4 },
    });
    // Decrement to mimic what checkout did when the order was placed.
    await app.prisma.item.update({ where: { id: item.id }, data: { stockQuantity: 2 } });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', {
      riderId: rider.riderId,
      itemId: item.id,
      qty: 2,
      placedAtMinutesAgo: 1,
    });

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, {}, customer.token);
    expect(res.statusCode).toBe(200);

    const restocked = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(restocked.stockQuantity).toBe(4); // 2 back on the shelf

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);

    await app.prisma.item.delete({ where: { id: item.id } });
  });

  it("cannot cancel another customer's order", async () => {
    const vendor = await makeVendor();
    const other = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING', { placedAtMinutesAgo: 1 });

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, {}, other.token);
    expect(res.statusCode).toBe(404); // scoped to customerId — not even visible

    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.status).toBe('PENDING');
  });
});

describe('Vendor-no-response auto-cancel [SWIFT-021]', () => {
  const ctx = () => ({ prisma: app.prisma, io: app.io, redis: app.redis, log: app.log });

  it('cancels a PENDING order the vendor never accepted — notifies the customer, exempt from risk', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING');

    // RED before SWIFT-021: nothing produced the auto-cancel job, so this order
    // hung in PENDING forever.
    const did = await autoCancelUnresponsiveOrder(ctx(), order.id);
    expect(did).toBe(true);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('CANCELLED');
    // Risk-exempt: the customer didn't cancel, so cancelledBy must NOT be them
    // (the risk query only counts cancels where cancelledBy === the customer).
    expect(after.cancelledBy).toBeNull();

    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, type: 'ORDER_UPDATE', data: { path: ['orderId'], equals: order.id } },
    });
    expect(note).not.toBeNull();
    expect(note!.body).toMatch(/didn.t respond|no response|in time/i);

    const statusLog = await app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: order.id, status: 'CANCELLED' },
    });
    expect(statusLog.changedBy).toBeNull();
    expect(statusLog.note).toBe('Auto-cancelled: vendor did not respond');
  });

  it('does NOT cancel an order still within its hold window', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING');
    await app.prisma.order.update({ where: { id: order.id }, data: { holdExpiresAt: new Date(Date.now() + 5 * 60_000) } });

    const did = await autoCancelUnresponsiveOrder(ctx(), order.id);
    expect(did).toBe(false); // still held — the vendor hasn't even seen it yet
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
  });

  it('does NOT cancel an order the vendor already accepted', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED');
    const did = await autoCancelUnresponsiveOrder(ctx(), order.id);
    expect(did).toBe(false);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');
  });

  it('serializes concurrent worker deliveries: one cancel, one restock, one status record', async () => {
    const vendor = await makeVendor();
    const item = await app.prisma.item.create({
      data: {
        vendorId: vendor.vendorId,
        categoryId: vendor.categoryId,
        name: 'Auto-cancel Race Plate',
        basePrice: 1000,
        stockQuantity: 2,
        isAvailable: true,
      },
    });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING', {
      itemId: item.id,
      qty: 2,
    });
    await app.prisma.item.update({ where: { id: item.id }, data: { stockQuantity: 0 } });

    const results = await Promise.all([
      autoCancelUnresponsiveOrder(ctx(), order.id),
      autoCancelUnresponsiveOrder(ctx(), order.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const [afterOrder, afterItem, cancelledLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }),
      app.prisma.item.findUniqueOrThrow({ where: { id: item.id }, select: { stockQuantity: true } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } }),
    ]);
    expect(afterOrder.status).toBe('CANCELLED');
    expect(afterItem.stockQuantity).toBe(2);
    expect(cancelledLogs).toBe(1);
  });

  it('rolls back auto-cancel status, stock, search, and evidence on a pre-commit fault', async () => {
    const vendor = await makeVendor();
    const item = await app.prisma.item.create({
      data: {
        vendorId: vendor.vendorId,
        categoryId: vendor.categoryId,
        name: 'Auto-cancel Fault Plate',
        basePrice: 1000,
        stockQuantity: 2,
        isAvailable: true,
      },
    });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING', {
      itemId: item.id,
      qty: 2,
    });
    // Checkout reserved both units before the worker was scheduled.
    await app.prisma.item.update({ where: { id: item.id }, data: { stockQuantity: 0 } });
    const search = await app.prisma.dispatchSearch.create({
      data: { vertical: 'DELIVERY', subjectId: order.id, status: 'SEARCHING', radiusKm: 5 },
    });

    const originalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        await originalStage.call(this, tx, input);
        throw new Error('forced auto-cancel pre-commit abort');
      });
    try {
      await expect(autoCancelUnresponsiveOrder(ctx(), order.id)).rejects.toThrow('forced auto-cancel pre-commit abort');
    } finally {
      stageSpy.mockRestore();
    }

    const [afterOrder, afterItem, afterSearch, cancelledLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }),
      app.prisma.item.findUniqueOrThrow({ where: { id: item.id }, select: { stockQuantity: true } }),
      app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: search.id }, select: { status: true } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } }),
    ]);
    expect(afterOrder.status).toBe('PENDING');
    expect(afterItem.stockQuantity).toBe(0);
    expect(afterSearch.status).toBe('SEARCHING');
    expect(cancelledLogs).toBe(0);
    await app.prisma.dispatchSearch.delete({ where: { id: search.id } });
  });
});

describe('Delivery-window auto-complete uses the canonical transaction', () => {
  const ctx = () => ({ prisma: app.prisma, io: app.io, redis: app.redis, log: app.log });

  it('rolls back status and evidence on a staged fault, then retries once idempotently', async () => {
    const vendor = await makeVendor();
    const order = await makeOrder(customer.userId, vendor.vendorId, 'DELIVERED');

    const originalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        await originalStage.call(this, tx, input);
        throw new Error('forced auto-complete pre-commit abort');
      });
    try {
      await expect(autoCompleteDeliveredOrder(ctx(), order.id))
        .rejects.toThrow('forced auto-complete pre-commit abort');
    } finally {
      stageSpy.mockRestore();
    }

    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERED');
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'COMPLETED' } })).toBe(0);

    expect(await autoCompleteDeliveredOrder(ctx(), order.id)).toBe(true);
    expect(await autoCompleteDeliveredOrder(ctx(), order.id)).toBe(false);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('COMPLETED');
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'COMPLETED' } })).toBe(1);
  });
});
