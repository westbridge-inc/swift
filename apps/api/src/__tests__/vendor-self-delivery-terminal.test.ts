import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { reconcileStuckDispatch } from '../modules/dispatch/dispatch.service';
import { scanStrugglingDeliveries } from '../modules/dispatch/supply-watch.service';
import { NotificationService } from '../modules/notification/notification.service';

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

async function makeOrder(mode: 'VENDOR_DELIVERY' | 'PLATFORM_RIDER', status: 'PREPARING' | 'READY_FOR_PICKUP', readyAt?: Date) {
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

const vendorPut = (url: string, body: unknown = {}) =>
  app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: body as Record<string, unknown> });

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
  await app.prisma.session.create({ data: { userId: ru.id, token: riderToken, refreshToken: nanoid(48), deviceId: 'sdr', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  // Online, located at the vendor — the board requires both, and filters by a
  // 15 km radius, so the control order must actually be visible to this rider.
  const rider = await app.prisma.rider.create({
    data: { userId: ru.id, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', isOnline: true, isAvailable: true, currentLat: 6.8, currentLng: -58.15 },
  });
  riderId = rider.id;
});

afterAll(async () => {
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
    // stuckMinutes 0 → every order older than "now" qualifies, so the ONLY
    // thing keeping the self-delivered order out is the fulfilmentMode filter.
    await reconcileStuckDispatch(app.prisma, app.redis, async (id) => { enqueued.push(id); }, 0);

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
