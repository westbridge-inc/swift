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
import { issueSyntheticHandoverPhoto, syntheticMoverSession } from './helpers/handover-proof';
import { retainedPhonePrefix } from './helpers/retained-evidence';

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
//
// [SAFE-B] The failed generation now also writes the immutable filing, and a
// strike or an auto-approval follows only its complete evidence (the fix the
// rider's own session persisted at the door, the photo the server issued), so
// these fixtures file exactly that. Filings, proofs, claims and strikes are
// retained evidence: nothing here deletes them, the users live in a phone
// namespace unique to the run, and every door is one no retained strike holds.
// ---------------------------------------------------------------------------

const GPS = { lat: 7.2, lng: -58.6 };
/** [SAFE-B · retained history] A phone namespace no other suite uses or purges, unique to the run. */
const PHONE_PREFIX = retainedPhonePrefix('03');
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

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Atomic', lastName: `Cash${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L1', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  return { userId: user.id };
}

async function makeRider() {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  // [SAFE-B] The rider signs in; that session owns the location stream the filing reads.
  const sessionId = await syntheticMoverSession(app.prisma, u.userId, 'cash-atomic');
  const rider = await app.prisma.rider.create({
    data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: sessionId, currentLat: GPS.lat, currentLng: GPS.lng },
  });
  return { ...u, riderId: rider.id, sessionId };
}

/** The server issues the door photo for this rider's order, exactly as the upload route does. */
const issuedPhoto = async (orderId: string, riderUserId: string) =>
  (await issueSyntheticHandoverPhoto(app.prisma, { orderId, actorId: riderUserId, role: 'RIDER' })).url;

let doorSeq = 0;
const RUN_DOOR_BASE = { lat: GPS.lat + Math.floor(Math.random() * 400) * 0.0005, lng: GPS.lng - Math.floor(Math.random() * 400) * 0.0005 };
/** Every order gets its OWN door (the guardrails flag repeated claims at one
 *  address — collusion_address — and that is a real rule, not this test's
 *  subject), and the handover is stamped exactly at it. [SAFE-B] A door is used
 *  only if no retained strike (an earlier run's) sits at its address key. */
async function makeAtDoorOrder(customerId: string, riderId: string, amount = 2000, status: OrderStatus = 'ARRIVED') {
  let door = { lat: 0, lng: 0 };
  for (;;) {
    doorSeq += 1;
    door = { lat: Number((RUN_DOOR_BASE.lat + doorSeq * 0.0011).toFixed(4)), lng: Number((RUN_DOOR_BASE.lng - doorSeq * 0.0011).toFixed(4)) };
    if (await app.prisma.strike.count({ where: { addressKey: `geo:${door.lat.toFixed(4)}:${door.lng.toFixed(4)}` } }) === 0) break;
  }
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
    // [SAFE-B] The filing is a fact of the same generation.
    filings: await app.prisma.cashHandoverEvidence.count({ where: { orderId } }),
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
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orders = new OrderService(app.prisma, ioStub);
  notifications = new NotificationService(app.prisma, ioStub);
  cash = new CashRulesService(app.prisma, notifications, orders, observer);
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: 'Atomic Corner', slug: `atomic-corner-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}999`,
      addressLine1: '1 Atomic Corner', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: GPS.lat, longitude: GPS.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  // [SAFE-B · retained history] Filings, issued proofs, claims and strikes are evidence, kept with every row
  // they reference. Only scaffolding is touched, in one transaction: the retained riders go offline and the
  // store is closed, so no other suite is offered them. Nothing is swallowed and nothing half-commits.
  try {
    await app.prisma.$transaction(async (tx) => {
      await tx.rider.updateMany({ where: { userId: { in: createdUserIds } }, data: { isOnline: false, isAvailable: false } });
      if (vendorId) await tx.vendor.updateMany({ where: { id: vendorId }, data: { status: 'CLOSED', acceptingOrders: false, isCurrentlyOpen: false } });
    });
  } finally {
    await app.close();
  }
});

describe('the failed handover is one generation', () => {
  it('a crash inside the generation leaves NOTHING: no FAILED, no payment status, no strike, no claim — and the retry writes all four once', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    const photoUrl = await issuedPhoto(order.id, rider.userId);
    armed = 'failed';
    await expect(cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl, sessionId: rider.sessionId })).rejects.toThrow('failpoint');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'ARRIVED', payment: 'PENDING', strikes: 0, claims: 0, earnings: 0, filings: 0 });

    const retry = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl, sessionId: rider.sessionId });
    expect(retry.claim?.status).toBe('AUTO_APPROVED');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, earnings: 0, filings: 1 });
    // The notices left after the commit: the customer's outcome notice and the rider's claim notice, once each.
    expect(await app.prisma.notification.count({ where: { userId: customer.userId, data: { path: ['kind'], equals: 'handover_review' } } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: rider.userId, data: { path: ['kind'], equals: 'claim' } } })).toBe(1);
  });

  it('a notification failure can no longer stand between the money and the claim', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    const spy = vi.spyOn(notifications, 'send').mockRejectedValue(new Error('push provider down'));
    try {
      const res = await cash.handover(order.id, rider.userId, { outcome: 'refused', gps: order.door, photoUrl: await issuedPhoto(order.id, rider.userId), sessionId: rider.sessionId });
      expect(res.claim?.status, JSON.stringify(res.claim?.flags)).toBe('AUTO_APPROVED');
      expect(await facts(order.id, customer.userId)).toEqual({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, earnings: 0, filings: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('a terminal retry of the rider’s own finished handover answers the same coherent facts — no second strike, no second claim', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    const photoUrl = await issuedPhoto(order.id, rider.userId);
    const first = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl, sessionId: rider.sessionId });
    expect(first.claim?.status).toBe('AUTO_APPROVED');
    const again = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: order.door, photoUrl, sessionId: rider.sessionId });
    expect(again.claim?.id).toBe(first.claim?.id);
    expect(again.order.status).toBe('FAILED');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'FAILED', payment: 'FAILED', strikes: 1, claims: 1, earnings: 0, filings: 1 });
  });
});

describe('the paid handover is one generation', () => {
  it('a crash inside the generation leaves the order at the door with nothing captured and no earnings — and the retry delivers, captures and pays out once', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeAtDoorOrder(customer.userId, rider.riderId);
    armed = 'paid';
    await expect(cash.handover(order.id, rider.userId, { outcome: 'paid', gps: order.door })).rejects.toThrow('failpoint');
    expect(await facts(order.id, customer.userId)).toEqual({ status: 'ARRIVED', payment: 'PENDING', strikes: 0, claims: 0, earnings: 0, filings: 0 });

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
