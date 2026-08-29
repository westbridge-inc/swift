import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// Delivery→pickup conversion (availability spec §4.2): the ONE additive
// transition. Only while unassigned; rider money (fee + tip) comes off;
// a rider claiming mid-race wins.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let customerId: string;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorId: string;
let riderId: string;

async function makeOrder(opts: { riderAssigned?: boolean } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CVT-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId,
      vendorId,
      ...(opts.riderAssigned ? { riderId } : {}),
      status: 'PREPARING' as never,
      fulfillment: 'DELIVERY' as never,
      deliveryAddress: '7 Conversion Close', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 4000, subtotalMarkup: 0, subtotalCustomer: 4000,
      deliveryFee: 600, tipAmount: 300, totalAmount: 4900,
      paymentMethod: 'CASH' as never,
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const me = await app.prisma.user.create({
    data: {
      phone: `+59253${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Con', lastName: 'Vert',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  customerId = me.id;
  userIds.push(me.id);
  token = app.jwt.sign({ userId: me.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: me.id, token, refreshToken: nanoid(48),
      deviceId: 'cvt-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } });
  vendorId = vendor.id;

  const riderUser = await app.prisma.user.create({
    data: {
      phone: `+59252${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Busy', lastName: 'Rider',
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(riderUser.id);
  const rider = await app.prisma.rider.create({
    data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  riderId = rider.id;
});

afterAll(async () => {
  delete process.env['DISPATCH_EXHAUSTION'];
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  if (userIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

const convert = (id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/customer/orders/${id}/convert-to-pickup`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {},
  });

describe('POST /orders/:id/convert-to-pickup', () => {
  it('is invisible with the flag off', async () => {
    delete process.env['DISPATCH_EXHAUSTION'];
    const order = await makeOrder();
    const res = await convert(order.id);
    expect(res.statusCode).toBe(404);
  });

  it('converts an unassigned delivery: fee + tip come off, pickup code issued', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeOrder();
    const res = await convert(order.id);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.fulfillment).toBe('PICKUP');
    expect(String(d.pickupCode)).toMatch(/^\d{6}$/);
    expect(Number(d.deliveryFee)).toBe(0);
    expect(Number(d.tipAmount)).toBe(0);
    expect(Number(d.totalAmount)).toBe(4000); // 4900 − 600 fee − 300 tip

    const log = await app.prisma.orderStatusLog.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.note).toContain('switched to pickup');
  });

  it('refuses once a rider owns the order — the race is honest', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeOrder({ riderAssigned: true });
    const res = await convert(order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RIDER_ALREADY_ASSIGNED');

    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.fulfillment).toBe('DELIVERY');
    expect(Number(untouched.totalAmount)).toBe(4900);
  });
});

describe('conversion and rider claims are mutually exclusive on one locked money generation [REPORT-006 F-006-03/06]', () => {
  it('a concurrent goods decrement composes — the conversion write is additive, never a stale absolute total', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    // A picking refund shrinks the goods while the customer converts. Both
    // writers are atomic decrements on the locked row, so the arithmetic
    // composes in EITHER commit order: 4900 − 600 (goods) − 900 (fee+tip).
    // The old absolute-total write could resurrect the preview total and
    // silently erase the picking adjustment.
    for (let round = 0; round < 3; round += 1) {
      const order = await makeOrder();
      const [res] = await Promise.all([
        convert(order.id),
        app.prisma.order.updateMany({
          where: { id: order.id },
          data: { subtotalBase: { decrement: 600 }, subtotalCustomer: { decrement: 600 }, totalAmount: { decrement: 600 } },
        }),
      ]);
      expect(res.statusCode).toBe(200);
      const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(fresh.totalAmount)).toBe(3400);
      expect(Number(fresh.subtotalBase)).toBe(3400);
    }
  });

  it('cancel-then-convert: a dead order cannot convert (status bound under the lock)', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeOrder();
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { reason: 'nvm' },
    });
    expect(cancel.statusCode).toBe(200);
    const res = await convert(order.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_STATUS');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.fulfillment).toBe('DELIVERY');
    expect(fresh.pickupCode).toBeNull();
  });

  it('convert racing a fare-undercut board claim: exactly one wins and totals never fall below the goods', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const { OrderService } = await import('../modules/order/order.service');
    const orders = new OrderService(app.prisma, app.io);
    const moverUserId = (await app.prisma.rider.findUniqueOrThrow({ where: { id: riderId }, select: { userId: true } })).userId;
    for (let round = 0; round < 4; round += 1) {
      await app.prisma.rider.update({
        where: { id: riderId },
        data: { isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('convert'), currentOrderId: null },
      });
      const order = await makeOrder();
      const claim = app.prisma
        .$transaction(async (tx) => orders.stageDirectRiderAssignment(tx, {
          orderId: order.id, riderId, changedBy: moverUserId, moverUserId, requestedFee: 100, note: 'race',
        }))
        .then(() => 'claimed' as const)
        .catch(() => 'refused' as const);
      const [conv, claimOutcome] = await Promise.all([convert(order.id), claim]);
      const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      // THE F-006-03 invariants: no rider ever owns a PICKUP order, and the
      // total never drops below the goods subtotal (the reported corruption
      // was PICKUP + RIDER_ASSIGNED at 3,760 on 4,000 of goods).
      expect(fresh.fulfillment === 'PICKUP' && fresh.riderId !== null).toBe(false);
      expect(Number(fresh.totalAmount)).toBeGreaterThanOrEqual(Number(fresh.subtotalBase));
      if (fresh.fulfillment === 'PICKUP') {
        expect(conv.statusCode).toBe(200);
        expect(claimOutcome).toBe('refused');
        expect(Number(fresh.totalAmount)).toBe(4000);
        expect(fresh.riderId).toBeNull();
      } else {
        expect(claimOutcome).toBe('claimed');
        expect(conv.statusCode).toBe(409);
        expect(fresh.riderId).toBe(riderId);
        // Fee clamped from the LOCKED row: market 600, floor 360 → 4900 − 240.
        expect(Number(fresh.totalAmount)).toBe(4660);
        expect(fresh.status).toBe('RIDER_ASSIGNED');
      }
    }
  });
});
