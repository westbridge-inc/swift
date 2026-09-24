import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerTenantHeaderScope } from '../../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';

// ---------------------------------------------------------------------------
// GOLD-2 · RIDE-04 — the door handover: PIN + GPS + outcome (H-3).
//
// The production composition (app.ts: tenant context per request, the empty-
// JSON parser, the vendor-header scope) with the real customer, vendor and
// rider route modules, real sessions and a real database. The rider takes
// each order through the board-grab entrance (POST /rider/orders/:id/accept),
// a production path; the offer cascade is RIDE-02's journey. Durable rows are
// asserted at every step:
//   · the cash door: a stale screen, uncollected cash, a claim without GPS and
//     the wrong people are all refused; the paid outcome captures, delivers
//     and pays the rider in one commit; a lost response is recovered with no
//     second effect (the same key, and a new key)
//   · the failed outcome: an early no-show is refused; a refusal to pay is
//     recorded with GPS evidence, strikes the customer and opens the rider's
//     guarantee claim — once
//   · delivery recovery: two riders race, one wins; the winner hands it back
//     before pickup and the other rider completes it (a handback after pickup
//     is refused)
//   · [MKT-F057 · it.fails] a cash goods delivery needs the customer's PIN
//   · [E04 · it.fails] a stale "ready" cannot land on a cancelled order
// The MMG door (a stale screen, DELIVER_NO_CASH, the dispute block) runs in
// gold-2-mmg.test.ts; the counter pickup code is CUST-05 (GOLD-1).
// ---------------------------------------------------------------------------

// This file's own fixture block (+5920323nnn, 11 characters); phones and the
// crash-recovery purge share this ONE constant.
const PHONE_PREFIX = '+5920323';
const FIXTURE = 'gold2-rides-fixture';
const DAY = 24 * 60 * 60 * 1000;
const DOOR = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Rider = Actor & { riderId: string };
let customer: Actor;
let owner: Actor;
let vendorId: string;
let itemId: string;
const vendorHeaders = () => ({ 'x-vendor-id': vendorId });

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Door${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `g2r-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An onboarded, online rider at the store. The location stream is owned by
 *  the rider's own auth session, as go-online records it (RIDE-01's journey). */
async function makeRider(firstName: string): Promise<Rider> {
  const actor = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: actor.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      isOnline: true, isAvailable: true, currentLat: STORE.lat, currentLng: STORE.lng, lastLocationUpdate: new Date(),
      locationSessionId: actor.sessionId, floatLimit: 100_000,
    },
  }));
  return { ...actor, riderId: rider.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function placeCashOrder(): Promise<{ id: string; total: number; deliveryFee: number }> {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const placed = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `ride04-${nanoid(10)}` });
  expect(placed.statusCode, placed.body).toBe(200);
  const order = placed.json().data.order as { id: string; total: number; deliveryFee: number };
  return { id: order.id, total: order.total, deliveryFee: order.deliveryFee };
}

async function vendorStep(orderId: string, step: 'accept' | 'preparing' | 'ready', expected: string) {
  const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/${step}`, owner.token, undefined, vendorHeaders());
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data.status).toBe(expected);
}

async function riderStep(rider: Rider, orderId: string, step: string, expected: string) {
  const res = await call('PUT', `/api/v1/rider/orders/${orderId}/${step}`, rider.token, {});
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data.status).toBe(expected);
}

/** A ready order taken by `rider` and carried to the customer's door. */
async function orderAtTheDoor(rider: Rider) {
  const order = await placeCashOrder();
  await vendorStep(order.id, 'accept', 'ACCEPTED');
  await vendorStep(order.id, 'preparing', 'PREPARING');
  await vendorStep(order.id, 'ready', 'READY_FOR_PICKUP');
  const grab = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, {});
  expect(grab.statusCode, grab.body).toBe(200);
  expect(grab.json().data.status).toBe('RIDER_ASSIGNED');
  await riderStep(rider, order.id, 'en-route-pickup', 'RIDER_EN_ROUTE_PICKUP');
  await riderStep(rider, order.id, 'arrived-pickup', 'RIDER_ARRIVED_PICKUP');
  await riderStep(rider, order.id, 'picked-up', 'PICKED_UP');
  await riderStep(rider, order.id, 'en-route-delivery', 'EN_ROUTE_DELIVERY');
  // The rider's phone reports the door through the real location route.
  const fix = await call('PUT', '/api/v1/rider/location', rider.token, { latitude: DOOR.lat, longitude: DOOR.lng });
  expect(fix.statusCode, fix.body).toBe(200);
  expect(fix.json().success).toBe(true);
  expect(await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId }, select: { currentLat: true, currentLng: true } })))
    .toEqual({ currentLat: DOOR.lat, currentLng: DOOR.lng });
  return order;
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({
  where: { id }, select: { currentOrderId: true, isAvailable: true, committedFloat: true, totalDeliveries: true },
}));
const earningsOf = (orderId: string) => sys(() => app.prisma.earning.findMany({
  where: { orderId }, select: { riderId: true, type: true, amount: true, status: true }, orderBy: { type: 'asc' },
}));
const statusLog = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({
  where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { status: true, note: true, changedBy: true },
}));
const doorFacts = async (orderId: string) => {
  const row = await orderRow(orderId);
  return { status: row.status, paymentStatus: row.paymentStatus, riderId: row.riderId, deliveredAt: row.deliveredAt };
};

async function activeHandover(rider: Rider) {
  const res = await call('GET', '/api/v1/rider/orders/active', rider.token);
  expect(res.statusCode).toBe(200);
  return res.json().data.handover as { policy: string; rail: string; paymentState: string; custodyState: string; amount: number; version: string; permitted: string; blockReason: string | null };
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.reimbursementClaim.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.strike.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...vendorIds, ...riderIds, ...orderIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Dora', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '44 Door Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: DOOR.lat, longitude: DOOR.lng, isDefault: true },
  }));
  owner = await makeUser('Kwame', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: 'Gold Door Diner', slug: `gold2-door-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: '6 Door Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }));
  vendorId = vendor.id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Door Pepperpot', basePrice: 2200, isAvailable: true } }))).id;
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-2 · RIDE-04 — the cash door', () => {
  it('refuses a stale screen, uncollected cash, a claim without GPS and the wrong people; the paid outcome captures, delivers and pays in one commit; a lost response is recovered with no second effect', async () => {
    const rider = await makeRider('Ade');
    const otherRider = await makeRider('Bo');
    const order = await orderAtTheDoor(rider);
    // One Door Pepperpot plus the delivery leg (inside the included distance).
    expect({ total: order.total, deliveryFee: order.deliveryFee }).toEqual({ total: 2700, deliveryFee: 500 });

    // The screen the rider rendered on the way (EN_ROUTE_DELIVERY).
    const onTheWay = await activeHandover(rider);
    expect(onTheWay).toMatchObject({ rail: 'CASH', paymentState: 'PENDING', custodyState: 'EN_ROUTE_DELIVERY', permitted: 'COLLECT_CASH_THEN_DELIVER', amount: order.total, blockReason: null });

    await riderStep(rider, order.id, 'arrived', 'ARRIVED');
    const arrivedLog = (await statusLog(order.id)).filter((l) => l.status === 'ARRIVED');
    expect(arrivedLog).toHaveLength(1);
    expect(arrivedLog[0]!.note).toMatch(/^Rider reported arriving at the customer — gps:6\.80450,-58\.15530 \(0 m from the dropoff, fix \d+s old\)$/);

    // A screen rendered before the arrival is stale: refresh, never hand over on it.
    const stale = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: onTheWay.version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('HANDOVER_STALE');

    // The fresh screen — and the golden rule: cash is collected, never declared.
    const atTheDoor = await activeHandover(rider);
    expect(atTheDoor.version).not.toBe(onTheWay.version);
    expect(atTheDoor).toMatchObject({ custodyState: 'ARRIVED', permitted: 'COLLECT_CASH_THEN_DELIVER' });
    const declared = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: atTheDoor.version });
    expect(declared.statusCode).toBe(409);
    expect(declared.json().error.code).toBe('PAYMENT_NOT_CAPTURED');

    // A claim with no GPS is not a claim.
    const noGps = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid' });
    expect(noGps.statusCode).toBe(400);
    expect(noGps.json().error.code).toBe('VALIDATION_ERROR');

    // The wrong people cannot record the outcome.
    const notTheirs = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, otherRider.token, { outcome: 'paid', gps: DOOR });
    expect(notTheirs.statusCode).toBe(404);
    const theCustomer = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, customer.token, { outcome: 'paid', gps: DOOR });
    expect(theCustomer.statusCode).toBe(403);
    const theStore = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, owner.token, { outcome: 'paid', gps: DOOR });
    expect(theStore.statusCode).toBe(403);
    expect(await doorFacts(order.id)).toEqual({ status: 'ARRIVED', paymentStatus: 'PENDING', riderId: rider.riderId, deliveredAt: null });
    expect(await earningsOf(order.id)).toEqual([]);

    // Cash in hand: capture, delivery and the rider's pay commit together.
    const key = `ride04-paid-${nanoid(10)}`;
    const handedOverFrom = Date.now();
    const paid = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps: DOOR }, { 'idempotency-key': key });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toEqual({ success: true, data: { orderId: order.id, status: 'DELIVERED', claim: null }, replayed: false });
    const delivered = await doorFacts(order.id);
    expect(delivered).toMatchObject({ status: 'DELIVERED', paymentStatus: 'CAPTURED', riderId: rider.riderId });
    expect(delivered.deliveredAt!.getTime()).toBeGreaterThanOrEqual(handedOverFrom - 1000);
    expect(delivered.deliveredAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const doorLog = (await statusLog(order.id)).filter((l) => l.status === 'DELIVERED');
    expect(doorLog).toEqual([{ status: 'DELIVERED', note: 'payment collected — gps:6.80450,-58.15530', changedBy: rider.userId }]);
    const pay = [{ riderId: rider.riderId, type: 'DELIVERY_FEE', amount: new Prisma.Decimal(order.deliveryFee), status: 'AVAILABLE' }];
    expect(await earningsOf(order.id)).toEqual(pay);
    expect(await riderRow(rider.riderId)).toEqual({ currentOrderId: null, isAvailable: true, committedFloat: new Prisma.Decimal(0), totalDeliveries: 1 });

    // Delivery recovery: the response was lost and the phone retries.
    const sameKey = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps: DOOR }, { 'idempotency-key': key });
    expect(sameKey.statusCode).toBe(200);
    expect(sameKey.json()).toEqual({ success: true, data: { orderId: order.id, status: 'DELIVERED', claim: null }, replayed: true });
    const newKey = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps: DOOR }, { 'idempotency-key': `ride04-retry-${nanoid(10)}` });
    expect(newKey.statusCode).toBe(200);
    expect(newKey.json().data).toEqual({ orderId: order.id, status: 'DELIVERED', claim: null });
    expect(await earningsOf(order.id)).toEqual(pay);
    expect((await statusLog(order.id)).filter((l) => l.status === 'DELIVERED')).toHaveLength(1);
    expect((await riderRow(rider.riderId)).totalDeliveries).toBe(1);
  });

  it('a customer who will not pay: an early no-show is refused; the refusal is recorded with GPS evidence, strikes the customer and opens the rider’s guarantee claim — once', async () => {
    const rider = await makeRider('Cleo');
    const order = await orderAtTheDoor(rider);
    await riderStep(rider, order.id, 'arrived', 'ARRIVED');

    // The customer still has time to come to the door.
    const early = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'no_show', gps: DOOR });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('NO_SHOW_TOO_EARLY');
    expect(await doorFacts(order.id)).toMatchObject({ status: 'ARRIVED', paymentStatus: 'PENDING' });
    expect(await sys(() => app.prisma.strike.count({ where: { orderId: order.id } }))).toBe(0);

    const refused = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'refused', gps: DOOR }, { 'idempotency-key': `ride04-ref-${nanoid(10)}` });
    expect(refused.statusCode, refused.body).toBe(200);
    const claim = refused.json().data.claim as { id: string; status: string; amount: number; flags: unknown };
    expect(refused.json().data).toMatchObject({ orderId: order.id, status: 'FAILED' });
    // The rider is made whole for the store's cash they fronted; with no door
    // photo the claim waits for a person instead of paying out on its own.
    expect({ status: claim.status, amount: claim.amount, flags: claim.flags }).toEqual({ status: 'PENDING_REVIEW', amount: 2200, flags: ['evidence_incomplete'] });

    expect(await doorFacts(order.id)).toMatchObject({ status: 'FAILED', paymentStatus: 'FAILED', deliveredAt: null });
    const failedLog = (await statusLog(order.id)).filter((l) => l.status === 'FAILED');
    expect(failedLog).toEqual([{ status: 'FAILED', note: 'refused — gps:6.80450,-58.15530', changedBy: rider.userId }]);
    const strikes = await sys(() => app.prisma.strike.findMany({ where: { orderId: order.id }, select: { userId: true, reason: true } }));
    expect(strikes).toEqual([{ userId: customer.userId, reason: 'failed_payment_refused' }]);
    const claims = await sys(() => app.prisma.reimbursementClaim.findMany({ where: { orderId: order.id } }));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ id: claim.id, riderId: rider.riderId, status: claim.status });
    expect(Number(claims[0]!.amount)).toBe(claim.amount);
    const notice = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId, data: { path: ['orderId'], equals: order.id }, title: 'Failed delivery recorded' } }));
    expect(notice).toHaveLength(1);
    expect(await riderRow(rider.riderId)).toMatchObject({ currentOrderId: null, isAvailable: true, committedFloat: new Prisma.Decimal(0) });

    // A retried outcome answers the facts already written: one claim, one strike.
    const retried = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'refused', gps: DOOR }, { 'idempotency-key': `ride04-ref2-${nanoid(10)}` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().data.claim.id).toBe(claim.id);
    expect(await sys(() => app.prisma.reimbursementClaim.count({ where: { orderId: order.id } }))).toBe(1);
    expect(await sys(() => app.prisma.strike.count({ where: { orderId: order.id } }))).toBe(1);
    // A failed door can never be turned into a paid one afterwards.
    const lateCash = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps: DOOR });
    expect(lateCash.statusCode).toBe(409);
    expect(await doorFacts(order.id)).toMatchObject({ status: 'FAILED', paymentStatus: 'FAILED' });
    expect(await earningsOf(order.id)).toEqual([]);
  });
});

describe('GOLD-2 · RIDE-04 — delivery recovery', () => {
  it('two riders race one ready order and exactly one wins; the winner hands it back before pickup and the other rider completes it', async () => {
    const [ria, ben] = [await makeRider('Ria'), await makeRider('Ben')];
    const order = await placeCashOrder();
    await vendorStep(order.id, 'accept', 'ACCEPTED');
    await vendorStep(order.id, 'preparing', 'PREPARING');
    await vendorStep(order.id, 'ready', 'READY_FOR_PICKUP');

    const grab = (r: Rider) => call('POST', `/api/v1/rider/orders/${order.id}/accept`, r.token, {});
    const [ra, rb] = await Promise.all([grab(ria), grab(ben)]);
    expect([ra.statusCode, rb.statusCode].sort(), `${ra.body} | ${rb.body}`).toEqual([200, 409]);
    const [winner, loser, loserRes] = ra.statusCode === 200 ? [ria, ben, rb] : [ben, ria, ra];
    expect(loserRes.json().error.code).toBe('CONFLICT');
    expect(await doorFacts(order.id)).toMatchObject({ status: 'RIDER_ASSIGNED', riderId: winner.riderId });
    expect((await statusLog(order.id)).filter((l) => l.status === 'RIDER_ASSIGNED')).toHaveLength(1);
    // The winner holds the leg and has fronted the store's cash for it.
    expect(await riderRow(winner.riderId)).toMatchObject({ currentOrderId: order.id, committedFloat: new Prisma.Decimal(2200) });
    expect(await riderRow(loser.riderId)).toEqual({ currentOrderId: null, isAvailable: true, committedFloat: new Prisma.Decimal(0), totalDeliveries: 0 });

    // Before custody the winner may give the job back; the order returns to
    // its own honest stage and the customer is told.
    const handback = await call('POST', `/api/v1/rider/orders/${order.id}/handback`, winner.token, { reason: 'Flat tyre on the way' });
    expect(handback.statusCode, handback.body).toBe(200);
    expect(handback.json().data).toEqual({ orderId: order.id, status: 'READY_FOR_PICKUP' });
    expect(await doorFacts(order.id)).toMatchObject({ status: 'READY_FOR_PICKUP', riderId: null });
    expect((await statusLog(order.id)).filter((l) => l.note === 'Rider handback: Flat tyre on the way').map((l) => [l.status, l.changedBy])).toEqual([['READY_FOR_PICKUP', winner.userId]]);
    expect(await riderRow(winner.riderId)).toMatchObject({ currentOrderId: null, isAvailable: true, committedFloat: new Prisma.Decimal(0) });
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId, data: { path: ['orderId'], equals: order.id }, title: 'Finding you another rider' } }));
    expect(told).toHaveLength(1);

    // The other rider completes it; once the bag is theirs it cannot be handed back.
    const retake = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, loser.token, {});
    expect(retake.statusCode, retake.body).toBe(200);
    await riderStep(loser, order.id, 'en-route-pickup', 'RIDER_EN_ROUTE_PICKUP');
    await riderStep(loser, order.id, 'arrived-pickup', 'RIDER_ARRIVED_PICKUP');
    await riderStep(loser, order.id, 'picked-up', 'PICKED_UP');
    const tooLate = await call('POST', `/api/v1/rider/orders/${order.id}/handback`, loser.token, { reason: 'Changed my mind' });
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().error.code).toBe('CUSTODY');
    await riderStep(loser, order.id, 'en-route-delivery', 'EN_ROUTE_DELIVERY');
    await riderStep(loser, order.id, 'arrived', 'ARRIVED');
    const paid = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, loser.token, { outcome: 'paid', gps: DOOR });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(await doorFacts(order.id)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'CAPTURED', riderId: loser.riderId });
    // Paid once, to the rider who carried it.
    expect(await earningsOf(order.id)).toEqual([{ riderId: loser.riderId, type: 'DELIVERY_FEE', amount: new Prisma.Decimal(order.deliveryFee), status: 'AVAILABLE' }]);
    expect(await riderRow(winner.riderId)).toMatchObject({ totalDeliveries: 0 });
    expect(await riderRow(loser.riderId)).toMatchObject({ totalDeliveries: 1, currentOrderId: null, isAvailable: true });
  });
});

// ---------------------------------------------------------------------------
// MKT-F057 (master-spec register, S0; not yet in the pilot ledger): goods
// delivery orders never get a delivery PIN — only a taxi ride mints one
// (rides.service.ts:208) — so the cash door (cash-rules.service.ts:228, the paid branch at :303)
// captures and completes on the rider's word plus GPS alone. §4.6.1 calls for
// a mandatory cash PIN at the door. This pins the minimal contract any fix
// must meet: a paid handover that carries no PIN is refused and changes
// nothing. The order is at the door in beforeAll, so the it.fails can only
// "pass" on the handover's answer. Flip to `it(...)` when the PIN lands.
// ---------------------------------------------------------------------------
describe('GOLD-2 · RIDE-04 — [MKT-F057] the cash door needs the customer’s PIN', () => {
  let rider: Rider;
  let orderId: string;

  beforeAll(async () => {
    rider = await makeRider('Pim');
    orderId = (await orderAtTheDoor(rider)).id;
    await riderStep(rider, orderId, 'arrived', 'ARRIVED');
    const row = await orderRow(orderId);
    expect({ status: row.status, paymentMethod: row.paymentMethod, paymentStatus: row.paymentStatus }).toEqual({ status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'PENDING' });
  });

  it.fails('[MKT-F057] a paid handover without the customer’s PIN is refused and changes nothing', async () => {
    const noPin = await call('POST', `/api/v1/rider/orders/${orderId}/handover`, rider.token, { outcome: 'paid', gps: DOOR });
    expect(noPin.statusCode).toBeGreaterThanOrEqual(400);
    expect(noPin.statusCode).toBeLessThan(500);
    expect(await doorFacts(orderId)).toMatchObject({ status: 'ARRIVED', paymentStatus: 'PENDING', deliveredAt: null });
    expect(await earningsOf(orderId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E04 (S1): the kitchen's "ready" can race a cancellation on the rider-owned
// status lane. vendor.routes.ts recordPrepProgress (:1560-1604) reads the
// order, then writes readyAt with an unconditional update (:1578), appends a
// status row and pushes "Order ready for pickup" to the assigned rider (:1599)
// — none of it under the order lock the cancellation takes. #1266 left it as is.
//
// The race is forced in beforeAll: the vendor's readyAt write is held at the
// client seam until the customer's cancellation has committed (the rider is
// freed), then released. On main the stale ready answers 200, stamps readyAt
// on the CANCELLED order, writes a "ready" row AFTER the CANCELLED row, and
// pushes the freed rider. The it.fails checks only those outcomes. Flip to
// `it(...)` when prep progress takes the order lock and rechecks. A fix that
// moves the write onto the transaction client never reaches this seam, so
// beforeAll then fails loudly ("never reached the seam") instead of letting
// the it.fails pass unforced: re-point the seam, or flip, in that change.
// ---------------------------------------------------------------------------
describe('GOLD-2 · RIDE-04 — [E04] a stale "ready" cannot land on a cancelled order', () => {
  let rider: Rider;
  let orderId: string;
  let ready: LightMyRequestResponse;

  beforeAll(async () => {
    rider = await makeRider('Eli');
    orderId = (await placeCashOrder()).id;
    await vendorStep(orderId, 'accept', 'ACCEPTED');
    const grab = await call('POST', `/api/v1/rider/orders/${orderId}/accept`, rider.token, {});
    expect(grab.statusCode, grab.body).toBe(200);
    expect(await doorFacts(orderId)).toMatchObject({ status: 'RIDER_ASSIGNED', riderId: rider.riderId });
    expect((await orderRow(orderId)).readyAt).toBeNull();

    // Hold ONLY the vendor's readyAt write; every other update passes through.
    let atSeam!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { atSeam = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delegate = app.prisma.order;
    const realUpdate = delegate.update.bind(delegate);
    const spy = vi.spyOn(delegate, 'update').mockImplementation((async (args: { data?: Record<string, unknown> }) => {
      if (args?.data && 'readyAt' in args.data) {
        atSeam();
        await gate;
      }
      return realUpdate(args as Parameters<typeof realUpdate>[0]);
    }) as never);
    try {
      const pending = call('PUT', `/api/v1/vendor/orders/${orderId}/ready`, owner.token, undefined, vendorHeaders());
      await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error('the ready write never reached the seam')), 10_000))]);
      const cancelled = await call('POST', `/api/v1/customer/orders/${orderId}/cancel`, customer.token, { reason: 'Plans changed' });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(await doorFacts(orderId)).toMatchObject({ status: 'CANCELLED' });
      expect(await riderRow(rider.riderId)).toMatchObject({ currentOrderId: null, isAvailable: true });
      release();
      ready = await pending;
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it.fails('[E04] the ready that lost the race is refused: no readyAt, no "ready" row after the cancellation, no push to the freed rider', async () => {
    expect(ready.statusCode).toBeGreaterThanOrEqual(400);
    expect(ready.statusCode).toBeLessThan(500);
    expect((await orderRow(orderId)).readyAt).toBeNull();
    const log = await statusLog(orderId);
    expect(log[log.length - 1]!.status).toBe('CANCELLED');
    const pushed = await sys(() => app.prisma.notification.count({ where: { userId: rider.userId, data: { path: ['kind'], equals: 'prep_ready' } } }));
    expect(pushed).toBe(0);
  });
});
