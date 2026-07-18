import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { OrderService } from '../modules/order/order.service';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Post-delivery tipping (deferred pre-launch tranche): a customer can tip a
// completed order; it becomes an AVAILABLE TIP earning for the mover (100%
// theirs). Guards: completed only, once, within 7 days, own order.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_850_000_000 + Math.floor(Math.random() * 100_000_000);
let riderId: string;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Tip', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'tip', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

async function makeOrder(customerId: string, status: OrderStatus, opts: { tipAmount?: number; deliveredAt?: Date } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `TIP-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, riderId, status, fulfillment: 'DELIVERY',
      pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
      tipAmount: opts.tipAmount ?? 0, ...(opts.deliveredAt ? { deliveredAt: opts.deliveredAt } : {}),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function inject(url: string, payload: unknown, token: string) {
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

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
  await app.ready();

  const moverUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Tip', lastName: 'Rider', roles: ['MOVER'], activeRole: 'MOVER', isPhoneVerified: true } });
  createdUserIds.push(moverUser.id);
  const rider = await app.prisma.rider.create({ data: { userId: moverUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderId = rider.id;
});

afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (riderId) await app.prisma.rider.deleteMany({ where: { id: riderId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('post-delivery tip', () => {
  it('adds a tip to a delivered order → AVAILABLE TIP earning for the rider', async () => {
    const c = await makeCustomer();
    const order = await makeOrder(c.userId, 'DELIVERED', { deliveredAt: new Date() });
    const res = await inject(`/api/v1/customer/orders/${order.id}/tip`, { amount: 500 }, c.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.tipAmount).toBe(500);

    const earning = await app.prisma.earning.findFirst({ where: { orderId: order.id, type: 'TIP' } });
    expect(earning).not.toBeNull();
    expect(Number(earning!.amount)).toBe(500);
    expect(earning!.status).toBe('AVAILABLE');
    expect(earning!.riderId).toBe(riderId);
  });

  it('rejects a second tip on the same order', async () => {
    const c = await makeCustomer();
    const order = await makeOrder(c.userId, 'DELIVERED', { deliveredAt: new Date() });
    expect((await inject(`/api/v1/customer/orders/${order.id}/tip`, { amount: 300 }, c.token)).statusCode).toBe(200);
    expect((await inject(`/api/v1/customer/orders/${order.id}/tip`, { amount: 300 }, c.token)).statusCode).toBe(409);
  });

  it('rejects tipping an order that isn’t delivered', async () => {
    const c = await makeCustomer();
    const order = await makeOrder(c.userId, 'PREPARING');
    expect((await inject(`/api/v1/customer/orders/${order.id}/tip`, { amount: 300 }, c.token)).statusCode).toBe(400);
  });

  it('rejects tipping outside the 7-day window', async () => {
    const c = await makeCustomer();
    const order = await makeOrder(c.userId, 'DELIVERED', { deliveredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
    expect((await inject(`/api/v1/customer/orders/${order.id}/tip`, { amount: 300 }, c.token)).statusCode).toBe(400);
  });

  it('a stranger cannot tip someone else’s order', async () => {
    const owner = await makeCustomer();
    const stranger = await makeCustomer();
    const order = await makeOrder(owner.userId, 'DELIVERED', { deliveredAt: new Date() });
    expect((await inject(`/api/v1/customer/orders/${order.id}/tip`, { amount: 300 }, stranger.token)).statusCode).toBe(404);
  });

  it('createEarnings is idempotent — two concurrent completions pay the mover once', async () => {
    const c = await makeCustomer();
    const order = await makeOrder(c.userId, 'DELIVERED', { tipAmount: 300, deliveredAt: new Date() });
    const orders = new OrderService(app.prisma, app.io);

    // The courier/driver "complete" write is not a CAS, so two concurrent
    // completions of the same order can both reach createEarnings. The
    // @@unique([orderId,type]) + skipDuplicates must make it a no-op the 2nd time.
    await Promise.all([orders.createEarnings(order.id), orders.createEarnings(order.id)]);

    const earnings = await app.prisma.earning.findMany({ where: { orderId: order.id } });
    expect(earnings).toHaveLength(2); // fee + tip — never 4
    const byType = Object.fromEntries(earnings.map((e) => [e.type, Number(e.amount)]));
    expect(byType).toEqual({ DELIVERY_FEE: 500, TIP: 300 });
  });
});
