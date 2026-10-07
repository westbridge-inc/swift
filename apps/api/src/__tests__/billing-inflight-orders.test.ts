import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// BILLING-INFLIGHT (owner ruling 1 Oct ~22:10): "Suspended store: accepted
// orders are completed; new orders are blocked until it pays." A weekly-fee
// suspension (or a lapsed fee grace) must stop NEW work only; an order the
// store already accepted is always finished. Other holds (an admin or safety
// suspension, expired documents) keep their own rules: unchanged here.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';
let subId = '';
const DAY = 86_400_000;

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
  await app.ready();

  const base = 592_009_100_000 + Math.floor(Math.random() * 800_000);
  const owner = await app.prisma.user.create({
    data: { phone: `+${base}`, firstName: 'Inflight', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(owner.id);
  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'i', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Inflight Diner', slug: `inflight-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${base + 1}`, addressLine1: '3 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY),
    },
  });
  subId = sub.id;

  const cust = await app.prisma.user.create({
    data: { phone: `+${base + 2}`, firstName: 'Inflight', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cust.id);
  customerId = cust.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } }).catch(() => undefined);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: subId } });
  await app.prisma.subscription.deleteMany({ where: { id: subId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

async function makeOrder(status: 'PENDING' | 'ACCEPTED') {
  return app.prisma.order.create({
    data: {
      orderNumber: `INF-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId, vendorId,
      status: status as never,
      ...(status === 'ACCEPTED' ? { acceptedAt: new Date() } : {}),
      fulfillment: 'PICKUP' as never,
      pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'Store', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 0, totalAmount: 2000, paymentMethod: 'CASH' as never,
    },
  });
}

const put = (orderId: string, step: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${orderId}/${step}`, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: {} });

async function billingSuspend() {
  // Exactly what billing's suspension writes (billing.service suspendAccessRows).
  await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'SUSPENDED', suspendedAt: new Date(), currentPeriodEnd: new Date(Date.now() - DAY) } });
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' } });
}
/** A lapsed fee grace as the shared clock records it since #1393: the enforcement deadline has passed. */
async function graceLapse() {
  await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'PAST_DUE', isInGracePeriod: true, gracePeriodEnd: new Date(Date.now() - 60_000), billingEnforcementDueAt: new Date(Date.now() - 60_000), currentPeriodEnd: new Date(Date.now() - 3 * DAY) } });
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', acceptingOrders: true, suspensionSource: null } });
}
async function restore() {
  await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'ACTIVE', suspendedAt: null, isInGracePeriod: false, gracePeriodEnd: null, billingEnforcementDueAt: null, currentPeriodEnd: new Date(Date.now() + 6 * DAY) } });
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', acceptingOrders: true, suspensionSource: null } });
}

describe('BILLING-INFLIGHT — a weekly-fee hold blocks new orders, never accepted ones', () => {
  it('a billing-suspended store still finishes an order it accepted before the suspension (preparing, then ready)', async () => {
    await restore();
    const order = await makeOrder('ACCEPTED');
    await billingSuspend();
    const prep = await put(order.id, 'preparing');
    expect(prep.statusCode).toBe(200);
    const ready = await put(order.id, 'ready');
    expect(ready.statusCode).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('READY_FOR_PICKUP');
  });

  it('a store whose fee grace lapsed still finishes an accepted order', async () => {
    await restore();
    const order = await makeOrder('ACCEPTED');
    await graceLapse();
    expect((await put(order.id, 'preparing')).statusCode).toBe(200);
  });

  it('a billing-suspended store is still refused NEW work (accept)', async () => {
    await restore();
    const order = await makeOrder('PENDING');
    await billingSuspend();
    const res = await put(order.id, 'accept');
    expect(res.statusCode).toBe(403);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
  });

  it('a lapsed grace is still refused NEW work (accept)', async () => {
    await restore();
    const order = await makeOrder('PENDING');
    await graceLapse();
    const res = await put(order.id, 'accept');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIPTION_PAST_DUE');
  });

  it('[Fable #1481 S4-1] a suspension with no source (an owner closing their account) is not a billing hold: progress stays refused', async () => {
    await restore();
    const order = await makeOrder('ACCEPTED');
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: null } });
    const res = await put(order.id, 'preparing');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VENDOR_SUSPENDED');
    await restore();
  });

  it('an ADMIN suspension keeps its own rule: progress stays refused (not a billing hold)', async () => {
    await restore();
    const order = await makeOrder('ACCEPTED');
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'ADMIN' } });
    const res = await put(order.id, 'preparing');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VENDOR_SUSPENDED');
    await restore();
  });
});
