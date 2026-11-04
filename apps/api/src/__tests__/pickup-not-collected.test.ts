// [BUG-HUNT-2 G20] A pickup the store marked ready and nobody came for stayed open for ever: the customer could not cancel
// it, the store could not reject it, and the only way off the board was a false "picked up". Through the real routes on a
// real database: from 24 hours the store records "Not collected", a true record. A cash order closes with no money moved; a
// paid MMG one goes to support, whose close records the refund the store owes. The customer may cancel a cash one from 24 hours.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { liveWorkWhere } from '../modules/user/account.service';
import { testPhone } from './helpers/fixture-ids';
import { OrderService } from '../modules/order/order.service';
import {
  NOT_COLLECTED_CASE_SUBJECT, NOT_COLLECTED_REASON, openNotCollectedCase,
} from '../modules/order/pickup-not-collected';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Actor = { userId: string; token: string };

let app: FastifyInstance;
let customer: Actor;
let storeOwner: Actor;
let otherOwner: Actor;
let vendorId: string;
let otherVendorId: string;
const userIds: string[] = [];
const vendorIds: string[] = [];
const orderIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole): Promise<Actor> {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Pat', lastName: 'Pickup', roles, activeRole: active, isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pickup', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function store(owner: Actor): Promise<string> {
  const row = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: row.id, name: `Corner Shop ${nanoid(4)}`, slug: `pickup-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Pickup Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorIds.push(vendor.id);
  return vendor.id;
}

/** A READY pickup the store marked ready `readyAgoMs` back. */
async function readyPickup(readyAgoMs: number, over: Record<string, unknown> = {}) {
  const readyAt = new Date(Date.now() - readyAgoMs);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `PNC-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId: customer.userId, vendorId,
    status: 'READY_FOR_PICKUP', placedAt: new Date(readyAt.getTime() - HOUR), acceptedAt: new Date(readyAt.getTime() - 50 * 60_000), readyAt,
    deliveryAddress: 'pickup', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0,
    totalAmount: 1000, paymentMethod: 'CASH', ...over,
  } as never });
  orderIds.push(order.id);
  return order;
}

const paidMmg = () => ({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgAttestedAmount: 1000, mmgAttestedRef: `REF${nanoid(10)}` });

function call(method: 'GET' | 'POST' | 'PUT', url: string, as: Actor, payload?: unknown) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const notCollected = (id: string, as: Actor = storeOwner) => call('PUT', `/api/v1/vendor/orders/${id}/not-collected`, as, {});
const storeView = async (id: string) => (await call('GET', `/api/v1/vendor/orders/${id}`, storeOwner)).json().data;
const customerView = async (id: string) => (await call('GET', `/api/v1/customer/orders/${id}`, customer)).json().data;
const cancel = (id: string) => call('POST', `/api/v1/customer/orders/${id}/cancel`, customer, {});
const noticesFor = (userId: string, orderId: string) => app.prisma.notification.findMany({ where: { userId, data: { path: ['orderId'], equals: orderId } } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  vi.stubEnv('LIFECYCLE_V2', '1');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  customer = await actor(['CUSTOMER'], 'CUSTOMER');
  storeOwner = await actor(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  otherOwner = await actor(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorId = await store(storeOwner);
  otherVendorId = await store(otherOwner);
});

afterAll(async () => {
  await app.prisma.supportTicket.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  vi.unstubAllEnvs();
});

describe('[G20] the store records Not collected from 24 hours', () => {
  it('before 24 hours the store has no such door, and is told when it opens', async () => {
    const order = await readyPickup(23 * HOUR);
    expect((await storeView(order.id)).notCollected).toEqual({ allowed: false, goesToSupport: false });
    const res = await notCollected(order.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NOT_COLLECTED_TOO_EARLY');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('READY_FOR_PICKUP');
  });

  it('a cash pickup closes as a true record: no money moved, no strike, the customer told, and their account is free again', async () => {
    const order = await readyPickup(DAY + HOUR);
    expect(await app.prisma.order.count({ where: { ...liveWorkWhere(customer.userId).orders, id: order.id } })).toBe(1);
    expect((await storeView(order.id)).notCollected).toEqual({ allowed: true, goesToSupport: false });
    const res = await notCollected(order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: order.id, status: 'CANCELLED' });
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { statusHistory: true } });
    expect(row).toMatchObject({ status: 'CANCELLED', cancellationReason: NOT_COLLECTED_REASON, cancelledBy: storeOwner.userId, paymentStatus: order.paymentStatus, refundOwedAt: null, refundOwedAmount: null });
    expect(String(row.totalAmount)).toBe(String(order.totalAmount));
    expect(row.statusHistory.filter((log) => log.status === 'CANCELLED').map((log) => log.note)).toEqual([NOT_COLLECTED_REASON]);
    expect(await app.prisma.strike.count({ where: { orderId: order.id } })).toBe(0);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
    const told = await noticesFor(customer.userId, order.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Pickup not collected' });
    expect(told[0]!.body).toContain(order.orderNumber);
    expect(told[0]!.body).toContain('No money moved');
    expect(await app.prisma.order.count({ where: { ...liveWorkWhere(customer.userId).orders, id: order.id } })).toBe(0);
  });

  it('a second tap after a lost reply gets the same answer, and the customer is told once', async () => {
    const order = await readyPickup(DAY + HOUR);
    expect((await notCollected(order.id)).statusCode).toBe(200);
    const again = await notCollected(order.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ id: order.id, status: 'CANCELLED' });
    expect(await noticesFor(customer.userId, order.id)).toHaveLength(1);
  });

  it('a pickup booked for a later time is counted from that time, never before it', async () => {
    const order = await readyPickup(DAY + HOUR, { scheduledFor: new Date(Date.now() + HOUR) });
    expect((await storeView(order.id)).notCollected.allowed).toBe(false);
    expect((await notCollected(order.id)).statusCode).toBe(409);
  });

  it('only a pickup, only ready, only the store\'s own', async () => {
    const delivery = await readyPickup(3 * DAY, { fulfillment: 'DELIVERY' });
    expect((await storeView(delivery.id)).notCollected).toBeUndefined();
    const refused = await notCollected(delivery.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('NOT_COLLECTED_NOT_OPEN');

    const preparing = await readyPickup(3 * DAY, { status: 'PREPARING', readyAt: null });
    expect((await notCollected(preparing.id)).statusCode).toBe(409);

    const mine = await readyPickup(3 * DAY);
    expect((await notCollected(mine.id, otherOwner)).statusCode).toBe(404);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('READY_FOR_PICKUP');
    expect(otherVendorId).not.toBe(vendorId);
  });
});

describe('[G20] the locked row decides', () => {
  it('a change that commits between the read and the lock wins, and nothing is written', async () => {
    const order = await readyPickup(DAY + HOUR);
    const real = OrderService.prototype.transitionOrderAtomically;
    const spy = vi.spyOn(OrderService.prototype, 'transitionOrderAtomically').mockImplementationOnce(async function (this: OrderService, input) {
      await app.prisma.order.update({ where: { id: order.id }, data: { scheduledFor: new Date(Date.now() + HOUR) } });
      return real.call(this, input);
    });
    const res = await notCollected(order.id);
    spy.mockRestore();
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NOT_COLLECTED_TOO_EARLY');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('READY_FOR_PICKUP');
  });

  it('the case judges the locked row too', async () => {
    const order = await readyPickup(23 * HOUR, paidMmg());
    await expect(openNotCollectedCase(app.prisma, order.id, storeOwner.userId, new Date())).rejects.toMatchObject({ code: 'NOT_COLLECTED_TOO_EARLY' });
    expect(await app.prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('[G20] a paid MMG pickup goes to support, the G08 path', () => {
  it('the order stays open, one case opens however often the store taps, and nothing about the money changes', async () => {
    const order = await readyPickup(DAY + HOUR, paidMmg());
    expect((await storeView(order.id)).notCollected).toEqual({ allowed: true, goesToSupport: true });
    const first = await notCollected(order.id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toMatchObject({ id: order.id, status: 'READY_FOR_PICKUP', sentToSupport: true });
    expect((await notCollected(order.id)).statusCode).toBe(200);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row).toMatchObject({ status: 'READY_FOR_PICKUP', paymentStatus: 'CLAIMED', cancelledAt: null, cancellationReason: null });
    const cases = await app.prisma.supportTicket.findMany({ where: { orderId: order.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ userId: storeOwner.userId, category: 'PAYMENT', subject: NOT_COLLECTED_CASE_SUBJECT });
    expect(await app.prisma.mmgRefundObligation.count({ where: { orderId: order.id } })).toBe(0);
    expect(await noticesFor(customer.userId, order.id)).toHaveLength(0);
  });

  it('too early is too early for a paid one too', async () => {
    const order = await readyPickup(23 * HOUR, paidMmg());
    expect((await notCollected(order.id)).statusCode).toBe(409);
    expect(await app.prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('[G20] the customer can cancel a cash one from 24 hours', () => {
  it('at 23 hours it is refused, at 24 hours the screen offers it and the cancel closes it free', async () => {
    const early = await readyPickup(23 * HOUR);
    expect((await customerView(early.id)).canCancel).toBe(false);
    expect((await cancel(early.id)).statusCode).toBe(409);

    const order = await readyPickup(DAY + HOUR);
    const view = await customerView(order.id);
    expect(view.canCancel).toBe(true);
    expect(view.cancelUnavailable).toBeNull();
    expect(view.cancellationMessage).toBe('Your pickup has been waiting over a day, so it is very late. You can cancel it for free.');
    const res = await cancel(order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data ?? res.json()).toMatchObject({ cancellationFee: 0 });
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED', cancelledBy: customer.userId });
  });

  it('the store is told, so it does not keep the order for someone who has cancelled', async () => {
    const order = await readyPickup(DAY + HOUR);
    expect((await cancel(order.id)).statusCode).toBe(200);
    const told = await noticesFor(storeOwner.userId, order.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Pickup cancelled by the customer' });
    expect(told[0]!.body).toContain(order.orderNumber);
  });

  it('a paid MMG one is not the customer\'s to cancel at any age', async () => {
    const order = await readyPickup(3 * DAY, paidMmg());
    expect((await customerView(order.id)).canCancel).toBe(false);
    expect((await cancel(order.id)).statusCode).toBe(409);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('READY_FOR_PICKUP');
  });
});
