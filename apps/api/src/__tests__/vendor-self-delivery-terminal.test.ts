import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { DispatchService, makeDispatchService, reconcileStuckDispatch } from '../modules/dispatch/dispatch.service';
import { scanStrugglingDeliveries } from '../modules/dispatch/supply-watch.service';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';

// ---------------------------------------------------------------------------
// [F-0026] A vendor-self-delivery order must have a terminal state.
//
// FUL-004b lets a vendor fulfil a DELIVERY order with its own courier: at
// accept (or ready) the mode resolves to VENDOR_DELIVERY and NO platform rider
// is dispatched. That half worked. The other half did not exist — nothing could
// ever close the order:
//
//   • the vendor could not: `complete-pickup` hard-requires fulfillment PICKUP
//   • a rider could not:    every rider route requires order.riderId === rider
//
// so the order sat in READY_FOR_PICKUP forever. Three subsystems then treated
// it as rider work in perpetuity: the dispatch reconciler re-enqueued it every
// two minutes, the rider open-jobs board advertised it, and the struggling-
// delivery scan pushed the customer "no rider found — switch to pickup?" while
// the vendor's own driver was en route. It also counted against the vendor's
// kitchen capacity forever.
//
// This suite pins BOTH halves: the exit exists, and the three rider-side
// subsystems leave self-delivered orders alone.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';
let riderToken = '';
let riderId = '';
let riderUserId = '';

async function makeOrder(
  mode: 'VENDOR_DELIVERY' | 'PLATFORM_RIDER' | null,
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP',
  readyAt?: Date,
) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SD-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY',
      fulfillmentMode: mode,
      customerId,
      vendorId,
      status,
      deliveryAddress: '5 Water St',
      deliveryLat: 6.81,
      deliveryLng: -58.16,
      subtotalBase: 2000,
      subtotalMarkup: 0,
      subtotalCustomer: 2000,
      deliveryFee: 600,
      totalAmount: 2600,
      paymentMethod: 'CASH',
      ...(readyAt && { readyAt }),
    },
  });
  orderIds.push(order.id);
  return order;
}

/** Stop exactly one canonical transition after its route pre-read but before
 * the Order row lock. Tests can then commit the competing authority choice and
 * prove that the locked-row implementation, not the stale route object, wins. */
function pauseNextTransition() {
  const original = OrderService.prototype.transitionOrderAtomically;
  let markEntered!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const spy = vi.spyOn(OrderService.prototype, 'transitionOrderAtomically').mockImplementationOnce(async function (this: OrderService, input) {
    markEntered();
    await released;
    return original.call(this, input);
  });
  return { entered, resume, restore: () => spy.mockRestore() };
}

const vendorPut = (url: string, body: unknown = {}) =>
  app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: body as Record<string, unknown> });

async function releaseTestRider(orderId: string) {
  await app.prisma.$transaction([
    app.prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', riderId: null } }),
    app.prisma.rider.update({
      where: { id: riderId },
      data: { currentOrderId: null, isAvailable: true, committedFloat: 0 },
    }),
  ]);
}

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  const base = 592_140_000_000 + Math.floor(Math.random() * 600_000_000);

  // Vendor owner + a self-delivery-capable vendor.
  const vu = await app.prisma.user.create({
    data: { phone: `+${base + 1}`, firstName: 'Self', lastName: 'Vendor', roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(vu.id);
  vendorToken = app.jwt.sign({ userId: vu.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: vu.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'sd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: vu.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Self Delivery Diner', slug: `sdd-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920090601', addressLine1: '2 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true, selfDeliveryEnabled: true },
  });
  vendorId = vendor.id;

  // Customer.
  const cu = await app.prisma.user.create({
    data: { phone: `+${base + 2}`, firstName: 'Sd', lastName: 'Customer', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cu.id);
  customerId = cu.id;

  // A rider, to prove the open-jobs board excludes self-delivered orders.
  const ru = await app.prisma.user.create({
    data: { phone: `+${base + 3}`, firstName: 'Sd', lastName: 'Rider', roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(ru.id);
  riderToken = app.jwt.sign({ userId: ru.id, role: 'MOVER', jti: nanoid(8) });
  const riderSession = await app.prisma.session.create({ data: { userId: ru.id, token: riderToken, refreshToken: nanoid(48), deviceId: 'sdr', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  // Online, located at the vendor — the board requires both, and filters by a
  // 15 km radius, so the control order must actually be visible to this rider.
  const rider = await app.prisma.rider.create({
    data: {
      userId: ru.id,
      riderType: 'BOTH',
      vehicleType: 'MOTORCYCLE',
      isOnline: true,
      isAvailable: true,
      currentLat: 6.8,
      currentLng: -58.15,
      lastLocationUpdate: new Date(),
      locationSessionId: riderSession.id,
      // The conflict tests below must reach the assignment boundary rather
      // than stopping at the unrelated CASH-float gate.
      floatLimit: 1_000_000,
    },
  });
  riderId = rider.id;
  riderUserId = ru.id;
});

afterAll(async () => {
  await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[F-0026] the self-delivery lane has a terminal', () => {
  it('runs the complete vendor-owned order journey from acceptance through delivery', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'PENDING');

    for (const [path, expected] of [
      ['accept', 'ACCEPTED'],
      ['preparing', 'PREPARING'],
      ['ready', 'READY_FOR_PICKUP'],
      ['delivered', 'DELIVERED'],
    ] as const) {
      const response = await vendorPut(`/api/v1/vendor/orders/${order.id}/${path}`);
      expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
      expect(response.json().data.status).toBe(expected);
    }

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.fulfillmentMode).toBe('VENDOR_DELIVERY');
    expect(after.riderId).toBeNull();
    expect(after.status).toBe('DELIVERED');
    expect((await app.prisma.orderStatusLog.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      select: { status: true },
    })).map((row) => row.status)).toEqual([
      'ACCEPTED',
      'PREPARING',
      'READY_FOR_PICKUP',
      'DELIVERED',
    ]);
    expect(await app.prisma.notification.count({
      where: { userId: customerId, data: { path: ['orderId'], equals: order.id } },
    })).toBeGreaterThanOrEqual(1);
  });

  it('the vendor can mark its own delivery DELIVERED from READY_FOR_PICKUP', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');

    const res = await vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('DELIVERED');
    expect(after.deliveredAt).not.toBeNull();
  });

  it('the transition is recorded in the status log — the timeline is reconstructable', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    await vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);

    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'DELIVERED' } });
    expect(log).not.toBeNull();
  });

  it('a PLATFORM_RIDER order cannot be closed this way — that is the rider’s lane', async () => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');

    const res = await vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_SELF_DELIVERY');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('READY_FOR_PICKUP'); // untouched
  });

  it('it cannot be closed before the food is ready', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'PREPARING');

    const res = await vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);
    expect(res.statusCode).toBe(400);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('PREPARING');
  });

  it('double-tap is safe — the second call does not re-fire the transition', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const first = await vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);
    expect(first.statusCode).toBe(200);

    const second = await vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);
    expect(second.statusCode).toBeGreaterThanOrEqual(400);

    const logs = await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'DELIVERED' } });
    expect(logs).toBe(1);
  });
});

describe('[F-0026] rider-side subsystems leave self-delivered orders alone', () => {
  it('the dispatch reconciler does not re-enqueue a self-delivered order', async () => {
    const selfOrder = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const riderOrder = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');

    const enqueued: string[] = [];
    // stuckMinutes -1 → the cutoff sits a minute in the FUTURE, so both
    // fixtures qualify deterministically (with 0, an order created in the
    // same millisecond as the cutoff flaked out of `updatedAt < now`) and the
    // ONLY thing keeping the self-delivered order out is the fulfilmentMode
    // filter.
    await reconcileStuckDispatch(app.prisma, app.redis, async (id) => { enqueued.push(id); }, -1);

    expect(enqueued).not.toContain(selfOrder.id);
    expect(enqueued).toContain(riderOrder.id); // control: the filter is not just excluding everything
  });

  it('the rider open-jobs board does not advertise a self-delivered order', async () => {
    const selfOrder = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const riderOrder = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');

    const res = await app.inject({ method: 'GET', url: '/api/v1/rider/orders/available', headers: { authorization: `Bearer ${riderToken}` } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((o) => o.id);

    expect(ids).not.toContain(selfOrder.id);
    expect(ids).toContain(riderOrder.id); // control
  });

  // The mode is only resolved at accept/ready, so a freshly-placed order has
  // fulfillmentMode NULL. Prisma's `{ not: 'VENDOR_DELIVERY' }` compiles to SQL
  // `!= 'VENDOR_DELIVERY'`, which is NULL — not true — for those rows, so the
  // naive filter silently excluded exactly the orders the reconciler exists to
  // rescue. Caught by dispatch-reconcile.test.ts during the blast-radius run;
  // pinned here too so the NULL case is defended by this suite directly.
  it('an order whose mode is not resolved yet (NULL) is still treated as rider work', async () => {
    const unresolved = await app.prisma.order.create({
      data: {
        orderNumber: `SDN-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        fulfillment: 'DELIVERY',
        // fulfillmentMode deliberately omitted → NULL
        customerId,
        vendorId,
        status: 'READY_FOR_PICKUP',
        deliveryAddress: '5 Water St',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 2000,
        subtotalMarkup: 0,
        subtotalCustomer: 2000,
        deliveryFee: 600,
        totalAmount: 2600,
        paymentMethod: 'CASH',
      },
    });
    orderIds.push(unresolved.id);

    const enqueued: string[] = [];
    await reconcileStuckDispatch(app.prisma, app.redis, async (id) => { enqueued.push(id); }, 0);
    expect(enqueued).toContain(unresolved.id);

    const board = await app.inject({ method: 'GET', url: '/api/v1/rider/orders/available', headers: { authorization: `Bearer ${riderToken}` } });
    expect((board.json().data as Array<{ id: string }>).map((o) => o.id)).toContain(unresolved.id);
  });

  it('the struggling-delivery scan does not tell the customer "no rider found"', async () => {
    const past = new Date(Date.now() - 60 * 60_000);
    const selfOrder = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP', past);

    const notifications = new NotificationService(app.prisma, app.io);
    await scanStrugglingDeliveries(app.prisma, notifications, 0);

    const nagged = await app.prisma.notification.findFirst({
      where: { userId: customerId, data: { path: ['orderId'], equals: selfOrder.id } },
      select: { id: true },
    });
    expect(nagged).toBeNull();
  });
});

describe('[LAUNCH-SD-01] exactly one delivery authority owns an order', () => {
  const riderAccept = (orderId: string) => app.inject({
    method: 'POST',
    url: `/api/v1/rider/orders/${orderId}/accept`,
    headers: { authorization: `Bearer ${riderToken}`, 'content-type': 'application/json' },
    payload: {},
  });

  it('a Swift rider cannot claim an order already committed to vendor self-delivery', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');

    const response = await riderAccept(order.id);

    expect(response.statusCode).toBe(409);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.fulfillmentMode).toBe('VENDOR_DELIVERY');
    expect(after.riderId).toBeNull();
    expect(after.status).toBe('READY_FOR_PICKUP');
  });

  it('a vendor cannot switch to self-delivery after a Swift rider owns the order', async () => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');
    const accepted = await riderAccept(order.id);
    expect(accepted.statusCode).toBe(200);

    const response = await vendorPut(`/api/v1/vendor/orders/${order.id}/fulfillment-mode`, {
      mode: 'VENDOR_DELIVERY',
    });

    expect(response.statusCode).toBe(409);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.fulfillmentMode).toBe('PLATFORM_RIDER');
    expect(after.riderId).toBe(riderId);
    expect(after.status).toBe('RIDER_ASSIGNED');
    await releaseTestRider(order.id);
  });

  it('a simultaneous rider claim and vendor-delivery choice has exactly one winner', async () => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');

    const [claim, selfDelivery] = await Promise.all([
      riderAccept(order.id),
      vendorPut(`/api/v1/vendor/orders/${order.id}/fulfillment-mode`, { mode: 'VENDOR_DELIVERY' }),
    ]);

    expect([claim.statusCode, selfDelivery.statusCode].sort()).toEqual([200, 409]);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const riderWon = after.status === 'RIDER_ASSIGNED'
      && after.riderId === riderId
      && after.fulfillmentMode === 'PLATFORM_RIDER';
    const vendorWon = after.status === 'READY_FOR_PICKUP'
      && after.riderId === null
      && after.fulfillmentMode === 'VENDOR_DELIVERY';
    expect(Number(riderWon) + Number(vendorWon)).toBe(1);

    if (riderWon) await releaseTestRider(order.id);
  });

  it('choosing vendor delivery retires the live rider offer and search journal', async () => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');
    const attempt = 'self-delivery-choice';
    await app.redis.set(`dispatch:offer:${order.id}`, `${riderId}:${attempt}`, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${riderId}`, `${order.id}:${attempt}`, 'EX', 40);
    await app.prisma.dispatchSearch.create({
      data: {
        subjectId: order.id,
        subjectType: 'ORDER',
        status: 'SEARCHING',
        vertical: 'DELIVERY',
        radiusKm: 3,
      },
    });

    const response = await vendorPut(`/api/v1/vendor/orders/${order.id}/fulfillment-mode`, {
      mode: 'VENDOR_DELIVERY',
    });

    expect(response.statusCode).toBe(200);
    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${riderId}`)).toBeNull();
    const search = await app.prisma.dispatchSearch.findFirstOrThrow({ where: { subjectId: order.id } });
    expect(search.status).toBe('CANCELLED');
    expect(search.resolution).toBe('VENDOR_DELIVERY');
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: order.id } });
  });

  it('a stale offer acceptance after vendor delivery is neutral, not a rider decline', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const attempt = 'stale-self-delivery';
    await app.redis.set(`dispatch:offer:${order.id}`, `${riderId}:${attempt}`, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${riderId}`, `${order.id}:${attempt}`, 'EX', 40);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/offers/accept',
      headers: { authorization: `Bearer ${riderToken}`, 'content-type': 'application/json' },
      payload: { orderId: order.id, offerAttemptId: attempt },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VENDOR_DELIVERY_SELECTED');
    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${riderId}`)).toBeNull();
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, riderId)).toBe(0);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.riderId).toBeNull();
    expect(after.status).toBe('READY_FOR_PICKUP');
  });

  it('a stale offer timeout after vendor delivery is neutral, not a rider expiry', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const attempt = 'stale-timeout-self-delivery';
    await app.redis.set(`dispatch:offer:${order.id}`, `${riderId}:${attempt}`, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${riderId}`, `${order.id}:${attempt}`, 'EX', 40);

    await makeDispatchService(app).handleOfferTimeout(order.id, riderId, attempt);

    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${riderId}`)).toBeNull();
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, riderId)).toBe(0);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.riderId).toBeNull();
    expect(after.status).toBe('READY_FOR_PICKUP');
  });
});

describe('[DA-01/02/03] locked delivery authority survives adversarial timing', () => {
  it('accept preserves a platform-rider choice committed after the route pre-read', async () => {
    const order = await makeOrder(null, 'PENDING');
    const barrier = pauseNextTransition();

    try {
      const accepting = vendorPut(`/api/v1/vendor/orders/${order.id}/accept`);
      await barrier.entered;
      await app.prisma.order.update({
        where: { id: order.id },
        data: { fulfillmentMode: 'PLATFORM_RIDER', fulfillmentModeVersion: { increment: 1 } },
      });
      barrier.resume();

      const response = await accepting;
      expect(response.statusCode).toBe(200);
      const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('ACCEPTED');
      expect(after.fulfillmentMode).toBe('PLATFORM_RIDER');
      expect(after.fulfillmentModeVersion).toBe(1);
    } finally {
      barrier.resume();
      barrier.restore();
    }
  });

  it('ready preserves a vendor-delivery choice committed after the route pre-read', async () => {
    const order = await makeOrder(null, 'PREPARING');
    const barrier = pauseNextTransition();

    try {
      const readying = vendorPut(`/api/v1/vendor/orders/${order.id}/ready`);
      await barrier.entered;
      await app.prisma.order.update({
        where: { id: order.id },
        data: { fulfillmentMode: 'VENDOR_DELIVERY', fulfillmentModeVersion: { increment: 1 } },
      });
      barrier.resume();

      const response = await readying;
      expect(response.statusCode).toBe(200);
      const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('READY_FOR_PICKUP');
      expect(after.fulfillmentMode).toBe('VENDOR_DELIVERY');
      expect(after.fulfillmentModeVersion).toBe(1);
    } finally {
      barrier.resume();
      barrier.restore();
    }
  });

  it('vendor-delivered rechecks custody on the locked row and loses to a platform switch', async () => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const barrier = pauseNextTransition();

    try {
      const delivering = vendorPut(`/api/v1/vendor/orders/${order.id}/delivered`);
      await barrier.entered;
      await app.prisma.order.update({
        where: { id: order.id },
        data: { fulfillmentMode: 'PLATFORM_RIDER', fulfillmentModeVersion: { increment: 1 } },
      });
      barrier.resume();

      const response = await delivering;
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DELIVERY_AUTHORITY_CHANGED');
      const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('READY_FOR_PICKUP');
      expect(after.fulfillmentMode).toBe('PLATFORM_RIDER');
      expect(await app.prisma.orderStatusLog.count({
        where: { orderId: order.id, status: 'DELIVERED' },
      })).toBe(0);
    } finally {
      barrier.resume();
      barrier.restore();
    }
  });

  it('a delayed vendor cleanup cannot erase a newer rider-search generation', async () => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');
    await app.prisma.order.update({
      where: { id: order.id },
      data: { fulfillmentModeVersion: 2 },
    });
    const oldSearch = await app.prisma.dispatchSearch.create({
      data: {
        subjectId: order.id,
        subjectType: 'ORDER',
        status: 'SEARCHING',
        vertical: 'DELIVERY',
        radiusKm: 3,
        deliveryAuthorityVersion: 1,
      },
    });
    const currentSearch = await app.prisma.dispatchSearch.create({
      data: {
        subjectId: order.id,
        subjectType: 'ORDER',
        status: 'SEARCHING',
        vertical: 'DELIVERY',
        radiusKm: 3,
        deliveryAuthorityVersion: 2,
      },
    });
    const currentAttempt = 'current-platform-offer~fv2';
    const currentDeclined = `dispatch:declined:${order.id}:fv2`;
    const currentRound = `dispatch:round:${order.id}:fv2`;
    const currentExhaust = `dispatch:exhausts:${order.id}:fv2`;
    const dispatch = makeDispatchService(app);
    expect(await dispatch.prepareForPlatformDelivery(order.id, 2)).toBe(true);
    await app.redis.set(`dispatch:offer:${order.id}`, `${riderId}:${currentAttempt}`, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${riderId}`, `${order.id}:${currentAttempt}`, 'EX', 40);
    await app.redis.sadd(currentDeclined, 'already-declined-rider');
    await app.redis.set(currentRound, '2', 'EX', 3600);
    await app.redis.set(currentExhaust, '3', 'EX', 3600);

    try {
      await dispatch.retireForVendorDelivery(order.id, 1);
      // A retried same-mode command is also idempotent for search memory.
      expect(await dispatch.prepareForPlatformDelivery(order.id, 2)).toBe(true);

      expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBe(`${riderId}:${currentAttempt}`);
      expect(await app.redis.get(`dispatch:mover-offer:${riderId}`)).toBe(`${order.id}:${currentAttempt}`);
      expect(await app.redis.smembers(currentDeclined)).toEqual(['already-declined-rider']);
      expect(await app.redis.get(currentRound)).toBe('2');
      expect(await app.redis.get(currentExhaust)).toBe('3');
      expect((await app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: oldSearch.id } })).status).toBe('CANCELLED');
      expect((await app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: currentSearch.id } })).status).toBe('SEARCHING');
    } finally {
      await app.redis.del(
        `dispatch:offer:${order.id}`,
        `dispatch:mover-offer:${riderId}`,
        currentDeclined,
        currentRound,
        currentExhaust,
        `dispatch:generation-init:${order.id}:fv2`,
      );
    }
  });

  it.each([
    { label: 'authority lookup', suppliedVersion: false },
    { label: 'final repair lookup', suppliedVersion: true },
  ])('keeps committed vendor custody successful when the $label fails', async ({ suppliedVersion }) => {
    const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
    const dispatch = makeDispatchService(app);
    const read = vi.spyOn(app.prisma.order, 'findUnique').mockRejectedValueOnce(new Error('simulated database read outage'));

    try {
      await expect(dispatch.retireForVendorDelivery(
        order.id,
        suppliedVersion ? order.fulfillmentModeVersion : undefined,
      )).resolves.toBeUndefined();
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentMode).toBe('VENDOR_DELIVERY');
    } finally {
      read.mockRestore();
    }
  });

  it.each(['generation initialization', 'queue enqueue'] as const)(
    'returns the committed platform choice when immediate $label fails',
    async (failure) => {
      const order = await makeOrder('VENDOR_DELIVERY', 'READY_FOR_PICKUP');
      const prepare = failure === 'generation initialization'
        ? vi.spyOn(DispatchService.prototype, 'prepareForPlatformDelivery').mockRejectedValueOnce(new Error('simulated Redis outage'))
        : vi.spyOn(DispatchService.prototype, 'prepareForPlatformDelivery').mockResolvedValueOnce(true);
      const priorQueue = (app as any).dispatchQueue;
      if (failure === 'queue enqueue') {
        (app as any).dispatchQueue = { add: vi.fn().mockRejectedValueOnce(new Error('simulated queue outage')) };
      }

      try {
        const response = await vendorPut(`/api/v1/vendor/orders/${order.id}/fulfillment-mode`, {
          mode: 'PLATFORM_RIDER',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          success: true,
          data: { orderId: order.id, fulfillmentMode: 'PLATFORM_RIDER' },
        });
        const committed = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(committed.fulfillmentMode).toBe('PLATFORM_RIDER');
        expect(committed.fulfillmentModeVersion).toBe(order.fulfillmentModeVersion + 1);
      } finally {
        prepare.mockRestore();
        (app as any).dispatchQueue = priorQueue;
      }
    },
  );

  it.each([
    { shape: 'marked fv0', staleAttempt: 'before-switch-marked~fv0', echoAttempt: true },
    { shape: 'marked fv0 / old client', staleAttempt: 'before-switch-marked-old~fv0', echoAttempt: false },
    { shape: 'unmarked rollout', staleAttempt: 'before-switch-unmarked', echoAttempt: true },
    { shape: 'unmarked rollout / old client', staleAttempt: 'before-switch-unmarked-old', echoAttempt: false },
    { shape: 'bare pre-attempt value', staleAttempt: undefined, echoAttempt: false },
  ])(
    'a $shape offer cannot claim fv2 after Redis consumption',
    async ({ shape, staleAttempt, echoAttempt }) => {
      const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');
      const staleForward = staleAttempt ? `${riderId}:${staleAttempt}` : riderId;
      const staleReverse = staleAttempt ? `${order.id}:${staleAttempt}` : order.id;
      await app.redis.set(`dispatch:offer:${order.id}`, staleForward, 'EX', 40);
      await app.redis.set(`dispatch:mover-offer:${riderId}`, staleReverse, 'EX', 40);

      const dispatch = makeDispatchService(app);
      const internal = dispatch as any;
      const originalRemove = internal.removeOfferIfOwned.bind(dispatch);
      let entered!: () => void;
      let resume!: () => void;
      const consumed = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { resume = resolve; });
      const removeSpy = vi.spyOn(internal, 'removeOfferIfOwned').mockImplementationOnce(async (...args: any[]) => {
        const removed = await originalRemove(...args);
        entered();
        await released;
        return removed;
      });

      try {
        const accepting = dispatch.acceptOffer(
          order.id,
          riderUserId,
          undefined,
          echoAttempt ? staleAttempt : undefined,
        ).then(
          (value) => ({ value, error: null as unknown }),
          (error: unknown) => ({ value: null, error }),
        );
        await consumed;

        const vendor = await vendorPut(`/api/v1/vendor/orders/${order.id}/fulfillment-mode`, {
          mode: 'VENDOR_DELIVERY',
        });
        expect(vendor.statusCode).toBe(200);
        const platform = await vendorPut(`/api/v1/vendor/orders/${order.id}/fulfillment-mode`, {
          mode: 'PLATFORM_RIDER',
        });
        expect(platform.statusCode).toBe(200);

        // Tests run without a BullMQ worker. Install exactly the fv2 card that
        // the queued dispatch job would own in production.
        const currentAttempt = `current-after-switch-${shape.replaceAll(' ', '-')}~fv2`;
        await app.redis.set(`dispatch:offer:${order.id}`, `${riderId}:${currentAttempt}`, 'EX', 40);
        await app.redis.set(`dispatch:mover-offer:${riderId}`, `${order.id}:${currentAttempt}`, 'EX', 40);
        const currentOffer = await app.redis.get(`dispatch:offer:${order.id}`);
        expect(currentOffer).toMatch(new RegExp(`^${riderId}:.+~fv2$`));
        resume();

        const outcome = await accepting;
        expect(outcome.value).toBeNull();
        expect(outcome.error).toMatchObject({ code: 'OFFER_EXPIRED' });
        const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(after.fulfillmentMode).toBe('PLATFORM_RIDER');
        expect(after.fulfillmentModeVersion).toBe(2);
        expect(after.riderId).toBeNull();
        expect(after.status).toBe('READY_FOR_PICKUP');
        expect(await app.prisma.orderStatusLog.count({
          where: { orderId: order.id, status: 'RIDER_ASSIGNED' },
        })).toBe(0);
        expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBe(currentOffer);
      } finally {
        resume();
        removeSpy.mockRestore();
        await app.redis.del(
          `dispatch:offer:${order.id}`,
          `dispatch:mover-offer:${riderId}`,
          `dispatch:declined:${order.id}:fv2`,
          `dispatch:round:${order.id}:fv2`,
          `dispatch:exhausts:${order.id}:fv2`,
          `dispatch:rescue-incentive:${order.id}:fv2`,
          `dispatch:generation-init:${order.id}:fv2`,
        );
      }
    },
  );

  it.each([
    { shape: 'unmarked rollout with echo', attempt: 'pre-rollout-uuid', echo: true },
    { shape: 'unmarked rollout with old client', attempt: 'pre-rollout-old-client', echo: false },
    { shape: 'bare pre-attempt value', attempt: undefined, echo: false },
  ])('still accepts a $shape while the order is genuinely generation zero', async ({ attempt, echo }) => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');
    const forward = attempt ? `${riderId}:${attempt}` : riderId;
    const reverse = attempt ? `${order.id}:${attempt}` : order.id;
    await app.redis.set(`dispatch:offer:${order.id}`, forward, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${riderId}`, reverse, 'EX', 40);

    try {
      const claimed = await makeDispatchService(app).acceptOffer(
        order.id,
        riderUserId,
        undefined,
        echo ? attempt : undefined,
      );
      expect(claimed.riderId).toBe(riderId);
      expect(claimed.fulfillmentModeVersion).toBe(0);
      expect(claimed.status).toBe('RIDER_ASSIGNED');
    } finally {
      await releaseTestRider(order.id);
      await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:mover-offer:${riderId}`);
    }
  });

  it('a legacy client without an echoed attempt cannot claim a stale authority generation', async () => {
    const order = await makeOrder('PLATFORM_RIDER', 'READY_FOR_PICKUP');
    await app.prisma.order.update({
      where: { id: order.id },
      data: { fulfillmentModeVersion: 2 },
    });
    const staleAttempt = 'pre-switch-card~fv1';
    await app.redis.set(`dispatch:offer:${order.id}`, `${riderId}:${staleAttempt}`, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${riderId}`, `${order.id}:${staleAttempt}`, 'EX', 40);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rider/offers/accept',
        headers: { authorization: `Bearer ${riderToken}`, 'content-type': 'application/json' },
        // Deliberately omit offerAttemptId: this is an older app build.
        payload: { orderId: order.id },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('OFFER_EXPIRED');
      const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.riderId).toBeNull();
      expect(after.status).toBe('READY_FOR_PICKUP');
      expect(await app.redis.get(`dispatch:offer:${order.id}`)).not.toBe(`${riderId}:${staleAttempt}`);
    } finally {
      await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:mover-offer:${riderId}`);
    }
  });
});
