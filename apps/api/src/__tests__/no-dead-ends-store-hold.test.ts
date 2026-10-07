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

// [NO-DEAD-ENDS · owner, 6 Oct] A store that cannot work orders is told why
// and what still works. Every hold used to answer "Your store is not active
// and cannot work orders. Reopen it from Account." — and there is no reopen
// control anywhere: a fee hold clears when the fee is credited, a suspension
// Swift placed only Swift lifts.
//
// Requests are build 9's exact shapes: PUT /vendor/orders/:id/accept with no
// body, PUT .../preparing with no body, PUT .../reject {reason}. The 403
// VENDOR_SUSPENDED contract build 9 branches on is unchanged; what it shows
// (`error.message`, verbatim in its toast) now names the hold and the door.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';
let subId = '';
const DAY = 86_400_000;
const OLD_DEAD_POINTER = 'Reopen it from Account';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const base = 592_046_800_000 + Math.floor(Math.random() * 90_000);
  const owner = await app.prisma.user.create({
    data: { phone: `+${base}`, firstName: 'Hold', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(owner.id);
  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'h', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Hold Diner', slug: `hold-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${base + 1}`, addressLine1: '4 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
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
    data: { phone: `+${base + 2}`, firstName: 'Hold', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
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
      orderNumber: `HLD-${nanoid(8)}`,
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

/** Build 9: `api.put('/vendor/orders/:id/<step>')` — no body. */
const build9Put = (orderId: string, step: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${orderId}/${step}`, headers: { authorization: `Bearer ${vendorToken}` } });
const build9Reject = (orderId: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${orderId}/reject`, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: { reason: 'Kitchen closed' } });

async function setStore(status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED', suspensionSource: string | null) {
  if (suspensionSource === 'BILLING') {
    await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'SUSPENDED', suspendedAt: new Date(), currentPeriodEnd: new Date(Date.now() - DAY) } });
  } else {
    await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'ACTIVE', suspendedAt: null, currentPeriodEnd: new Date(Date.now() + 6 * DAY) } });
  }
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { status, acceptingOrders: status === 'ACTIVE', suspensionSource } });
}

describe('a held store is told which hold it is under and what still works', () => {
  it('fee hold: accepting is refused with "pay the fee, finish accepted orders, or decline" — and both doors work', async () => {
    const waiting = await makeOrder('PENDING');
    const accepted = await makeOrder('ACCEPTED');
    await setStore('SUSPENDED', 'BILLING');

    const res = await build9Put(waiting.id, 'accept');
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('VENDOR_SUSPENDED');
    const shown: string = res.json().error.message;
    expect(shown).not.toContain(OLD_DEAD_POINTER);
    expect(shown).toMatch(/weekly fee/i);
    expect(shown).toMatch(/finish the orders you already accepted/i);
    expect(shown).toMatch(/decline/i);
    expect(res.json().error.details).toEqual({ hold: 'FEE_UNPAID', nextStep: 'PAY_WEEKLY_FEE', canDecline: true, canFinishAccepted: true });

    // What the message promises is true: the accepted order moves, the waiting one can be declined.
    expect((await build9Put(accepted.id, 'preparing')).statusCode).toBe(200);
    expect((await build9Reject(waiting.id)).statusCode).toBe(200);
  });

  it('suspended by Swift: names Swift and the support door, never "Reopen it from Account"', async () => {
    const accepted = await makeOrder('ACCEPTED');
    const waiting = await makeOrder('PENDING');
    await setStore('SUSPENDED', 'ADMIN');

    const res = await build9Put(accepted.id, 'preparing');
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('VENDOR_SUSPENDED');
    const shown: string = res.json().error.message;
    expect(shown).not.toContain(OLD_DEAD_POINTER);
    expect(shown).toMatch(/Swift has suspended this store/);
    expect(shown).toMatch(/Get Help/);
    expect(res.json().error.details).toMatchObject({ hold: 'SUSPENDED_BY_SWIFT', nextStep: 'CONTACT_SUPPORT', canFinishAccepted: false });
    expect((await build9Reject(waiting.id)).statusCode).toBe(200);
  });

  it('owner account closed (wind-down): says so', async () => {
    const accepted = await makeOrder('ACCEPTED');
    await setStore('SUSPENDED', 'WIND_DOWN');

    const res = await build9Put(accepted.id, 'preparing');
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.message).toMatch(/owner’s Swift account was closed/);
    expect(res.json().error.details.hold).toBe('OWNER_ACCOUNT_CLOSED');
  });

  it('a suspension with no recorded source, and a closed store, each get a door too', async () => {
    const accepted = await makeOrder('ACCEPTED');
    await setStore('SUSPENDED', null);
    const suspended = await build9Put(accepted.id, 'preparing');
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json().error.message).not.toContain(OLD_DEAD_POINTER);
    expect(suspended.json().error.details).toMatchObject({ hold: 'SUSPENDED', nextStep: 'CONTACT_SUPPORT' });

    await setStore('CLOSED', null);
    const closed = await build9Put(accepted.id, 'preparing');
    expect(closed.statusCode).toBe(403);
    expect(closed.json().error.code).toBe('VENDOR_SUSPENDED');
    expect(closed.json().error.message).toMatch(/This store is closed/);
    expect(closed.json().error.details.hold).toBe('CLOSED');
    await setStore('ACTIVE', null);
  });
});
