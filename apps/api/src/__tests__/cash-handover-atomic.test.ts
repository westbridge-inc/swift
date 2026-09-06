import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { CashRulesService, type CashHandoverObserver } from '../modules/cash/cash-rules.service';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [M-24 · S0] Cash handover terminal facts are ONE generation.
//
// Before: the paid path wrote CAPTURED, then DELIVERED, then the earnings,
// then the promotion, as separate statements; the failed path wrote FAILED,
// then the payment status, then the strike, then a NOTIFICATION, then the
// claim. A failure after any await left the facts split — most severely an
// order terminal FAILED and a customer struck with no guarantee claim for the
// rider, and the terminal retry refused. These cases inject a failure inside
// the generation and require all-or-nothing, a coherent retry, and that a
// notification can never stand between the money and the claim.
// ---------------------------------------------------------------------------

const GPS = { lat: 7.2, lng: -58.6 };
const PHONE_PREFIX = '+59200134';
let app: FastifyInstance;
let orders: OrderService;
let cash: CashRulesService;
let notifications: NotificationService;
let vendorId: string;
const createdUserIds: string[] = [];
let seq = 0;

/** The failpoint: armed once, it throws inside the handover's transaction. */
let armed: 'paid' | 'failed' | null = null;
const observer: CashHandoverObserver = {
  afterTerminalFacts: async (stage) => {
    if (armed !== stage) return;
    armed = null;
    throw new Error(`failpoint: the process died inside the ${stage} generation`);
  },
};

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderRows = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riders.map((r) => r.id) } }] }, select: { id: true } });
  const oids = orderRows.map((o) => o.id);
  await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.strike.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { orderId: { in: oids } } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Atomic', lastName: `Cash${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L1', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  return { userId: user.id };
}

async function makeRider() {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await app.prisma.rider.create({
    data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('cash-atomic'), currentLat: GPS.lat, currentLng: GPS.lng },
  });
  return { ...u, riderId: rider.id };
}

let doorSeq = 0;
/** Every order gets its OWN door (the guardrails flag repeated claims at one
 *  address — collusion_address — and that is a real rule, not this test's
 *  subject), and the handover is stamped exactly at it. */
async function makeAtDoorOrder(customerId: string, riderId: string, amount = 2000, status: OrderStatus = 'ARRIVED') {
  doorSeq += 1;
  const door = { lat: GPS.lat + doorSeq * 0.01, lng: GPS.lng - doorSeq * 0.01 };
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `ATM-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, riderId, status,
      deliveryAddress: `${doorSeq} Atomic Street`, deliveryLat: door.lat, deliveryLng: door.lng,
      pickupLat: GPS.lat, pickupLng: GPS.lng, pickupAddress: 'Vendor corner',
      subtotalBase: amount, subtotalMarkup: 0, subtotalCustomer: amount, deliveryFee: 500, totalAmount: amount,
      paymentMethod: 'CASH',
    },
  });
  // [DOC-1 §31.4 · P31-1] The claim's evidence bundle cites the pickup and the cart.
  await app.prisma.orderStatusLog.create({
    data: { orderId: order.id, status: 'PICKED_UP', changedBy: riderId, note: 'fixture pickup', createdAt: new Date(Date.now() - 40 * 60_000) },
  });
  const item = await app.prisma.item.findFirst({ where: { vendorId }, select: { id: true } })
    ?? await app.prisma.item.create({ data: { vendorId, categoryId: (await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } })).id, name: 'Plate', basePrice: amount } as never, select: { id: true } });
  await app.prisma.orderItem.create({ data: { orderId: order.id, itemId: item.id, name: 'Plate', quantity: 1, basePrice: amount, markedUpPrice: amount, markupAmount: 0, totalBase: amount, totalMarkup: 0, totalCustomer: amount, selectedOptions: {} } as never });
  if (status === 'ARRIVED') await arriveAtDoor(order.id, riderId, door);
  return { ...order, door };
}

/** [AF-MOB-001] A REAL at-door order carries an arrival: the status-log row the
 *  transition writes, and a rider standing where they say they are. These
 *  fixtures used to create `status: 'ARRIVED'` with neither, which the no-show
 *  policy correctly refuses — a mover who never arrived cannot report a no-show.
 *  Arranging the precondition properly is not weakening the test; it is the
 *  difference between an order that arrived and one that merely says so. */
async function arriveAtDoor(orderId: string, riderId: string, door: { lat: number; lng: number }, minutesAgo = 10) {
  await app.prisma.orderStatusLog.create({
    data: { orderId, status: 'ARRIVED', changedBy: riderId, note: 'fixture arrival', createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
  await app.prisma.rider.update({
    where: { id: riderId },
    data: { currentLat: door.lat, currentLng: door.lng, lastLocationUpdate: new Date() },
  });
}

const facts = async (orderId: string, customerId: string) => {
  const o = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return {
    status: o.status,
    payment: o.paymentStatus,
    strikes: await app.prisma.strike.count({ where: { orderId, userId: customerId } }),
    claims: await app.prisma.reimbursementClaim.count({ where: { orderId } }),
    earnings: await app.prisma.earning.count({ where: { orderId } }),
  };
};

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
  await app.ready();
  await purge();
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orders = new OrderService(app.prisma, ioStub);
  notifications = new NotificationService(app.prisma, ioStub);
  cash = new CashRulesService(app.prisma, notifications, orders, observer);
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: 'Atomic Corner', slug: `atomic-corner-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}99`,
      addressLine1: '1 Atomic Corner', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: GPS.lat, longitude: GPS.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await purge();
  await app.close();
});

describe('the failed handover is one generation', () => {
  it('a crash inside the generation leaves NOTHING: no FAILED, no payment status, no strike, no claim — and the retry writes all four once', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    armed = 'failed';
    await expect(cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl: 'storage://t/door.jpg' })).rejects.toThrow('failpoint');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'ARRIVED', payment: 'PENDING', strikes: 0, claims: 0, earnings: 0 });

    const retry = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl: 'storage://t/door.jpg' });
    expect(retry.claim?.status).toBe('AUTO_APPROVED');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, earnings: 0 });
    // The notices left after the commit: the customer's strike notice and the rider's claim notice, once each.
    expect(await app.prisma.notification.count({ where: { userId: customer.userId, data: { path: ['kind'], equals: 'strike' } } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: rider.userId, data: { path: ['kind'], equals: 'claim' } } })).toBe(1);
  });

  it('a notification failure can no longer stand between the money and the claim', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    const spy = vi.spyOn(notifications, 'send').mockRejectedValue(new Error('push provider down'));
    try {
      const res = await cash.handover(order.id, rider.userId, { outcome: 'refused', gps: order.door, photoUrl: 'storage://t/door.jpg' });
      expect(res.claim?.status, JSON.stringify(res.claim?.flags)).toBe('AUTO_APPROVED');
      expect(await facts(order.id, customer.userId)).toEqual({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, earnings: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it('a terminal retry of the rider’s own finished handover answers the same coherent facts — no second strike, no second claim', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    const first = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl: 'storage://t/door.jpg' });
    const again = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl: 'storage://t/door.jpg' });
    expect(again.claim?.id).toBe(first.claim?.id);
    expect(again.order.status).toBe('FAILED');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, earnings: 0 });
  });
});

describe('the paid handover is one generation', () => {
  it('a crash inside the generation leaves the order at the door with nothing captured and no earnings — and the retry delivers, captures and pays out once', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    armed = 'paid';
    await expect(cash.handover(order.id, rider.userId, { outcome: 'paid', gps: order.door })).rejects.toThrow('failpoint');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'ARRIVED', payment: 'PENDING', strikes: 0, claims: 0, earnings: 0 });

    const retry = await cash.handover(order.id, rider.userId, { outcome: 'paid', gps: order.door });
    expect(retry.order.status).toBe('DELIVERED');
    const after = await facts(order.id, customer.userId);
    expect({ status: after.status, payment: after.payment, strikes: after.strikes, claims: after.claims }).toEqual({ status: 'DELIVERED', payment: 'CAPTURED', strikes: 0, claims: 0 });
    expect(after.earnings).toBeGreaterThanOrEqual(1);

    const again = await cash.handover(order.id, rider.userId, { outcome: 'paid', gps: order.door });
    expect(again.order.status).toBe('DELIVERED');
    expect((await facts(order.id, customer.userId)).earnings).toBe(after.earnings);
  });
});
