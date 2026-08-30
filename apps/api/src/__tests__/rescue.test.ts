import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UserRole, OrderType, OrderStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { NotificationService } from '../modules/notification/notification.service';
import {
  foodAge, retireTooOldOrder, sweepFoodAge, grantRescueIncentive, rescueIncentiveGyd, incentiveKey, FOOD_TOO_OLD_REASON,
} from '../modules/dispatch/rescue';
import { ALGO_DEFAULTS, invalidateAlgoConfig } from '../modules/algo/algo-config';
import { explainEarning } from '../utils/explain-earning';

// ---------------------------------------------------------------------------
// [ALG-06] Rescue: the food-age cutoff and the escalating re-offer, against
// the real dispatch loop, Redis and the database.
//
//   ② An order ready longer than its vertical's cutoff with no rider is too
//      old to deliver: dispatch stops re-offering, the SYSTEM cancels it with
//      a reason that marks nobody, the customer and the store are told what is
//      true for their rail, and the row says why. A younger order is offered
//      as today. COURIER has no cutoff.
//   ① From the second cascade an offer carries Swift's OWN money; the payable
//      exists only once the rider has durably claimed the job, once per order.
//      Ships at 0 — the founder sets the amount.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200669';
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
const PICKUP = { lat: 6.8, lng: -58.15 };
const UPDATED_BY = 'rescue.test';

let app: FastifyInstance;
let dispatch: DispatchService;
let customerId: string;
let vendorId: string;
let vendorOwnerUserId: string;
const userIds: string[] = [];
const riderIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;

const dispatchKeys = (orderId: string) => [
  `dispatch:offer:${orderId}`, `dispatch:declined:${orderId}`, `dispatch:exhausts:${orderId}`, `dispatch:round:${orderId}`, incentiveKey(orderId),
];

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  for (const o of oids) await app.redis.del(...dispatchKeys(o), `ops_page:food_too_old:${o}`);
  await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-06', subjectId: { in: [...oids, ...riders.map((r) => r.id)] } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Rescue', lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'rescue', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000,
      isOnline: true, isAvailable: true, locationSessionId: session.id,
      currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(), averageRating: 5, acceptanceRate: 100, currentOrderId: null,
    },
  });
  riderIds.push(rider.id);
  return { riderId: rider.id, userId: user.id };
}

async function makeOrder(opts: { orderType?: OrderType; status?: OrderStatus; readyAgoMin?: number | null; paymentMethod?: 'CASH' | 'MOBILE_MONEY'; riderId?: string } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `RSC-${nanoid(8)}`, orderType: opts.orderType ?? 'FOOD_DELIVERY', customerId, vendorId,
      status: opts.status ?? 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
      ...(opts.readyAgoMin == null ? {} : { readyAt: new Date(Date.now() - opts.readyAgoMin * MIN) }),
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
      pickupAddress: 'Store', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng, deliveryAddress: 'Home', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: opts.paymentMethod ?? 'CASH',
    },
  });
  orderIds.push(order.id);
  return order;
}

async function setAlgo(key: string, value: unknown) {
  const latest = await app.prisma.algoConfig.findFirst({ where: { tenantId: 'swift-default', key }, orderBy: { version: 'desc' } });
  await app.prisma.algoConfig.create({ data: { tenantId: 'swift-default', key, value: value as never, version: (latest?.version ?? 0) + 1, updatedBy: UPDATED_BY } });
  invalidateAlgoConfig();
}

const deps = () => ({ prisma: app.prisma, redis: app.redis, io: app.io, notifications: new NotificationService(app.prisma, app.io) });

/** Every `io.to(room).emit(event, payload)` the code under test makes, in order. */
function captureEmits() {
  const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  const original = app.io.to.bind(app.io);
  const spy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
    emit(event: string, payload: Record<string, unknown>) {
      emits.push({ room, event, payload });
      return original(room).emit(event, payload);
    },
  })) as never);
  return { emits, restore: () => spy.mockRestore() };
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
  await app.ready();
  await purge();
  await app.prisma.algoConfig.deleteMany({ where: { updatedBy: UPDATED_BY } });
  invalidateAlgoConfig();
  // Only this file's riders may be candidates (files run sequentially).
  await app.prisma.rider.updateMany({ data: { isOnline: false, isAvailable: false } });
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});

  const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}90`, firstName: 'Rescue', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  customerId = customer.id;
  userIds.push(customer.id);
  const ownerUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}91`, firstName: 'Rescue', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  vendorOwnerUserId = ownerUser.id;
  userIds.push(ownerUser.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  vendorId = (await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Rescue Kitchen', slug: `rescue-kitchen-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}92`,
      addressLine1: '1 Rescue St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  })).id;
});

afterAll(async () => {
  await app.prisma.algoConfig.deleteMany({ where: { updatedBy: UPDATED_BY } });
  invalidateAlgoConfig();
  await purge();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('[ALG-06 ②] food age — the pure rule', () => {
  it('measures from readyAt against the vertical limit; no readyAt or no limit means never too old', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    const ready = (min: number) => ({ readyAt: new Date(now.getTime() - min * MIN) });
    expect(foodAge(ready(50), 45, now)).toEqual({ tooOld: true, ageMinutes: 50 });
    expect(foodAge(ready(20), 45, now)).toEqual({ tooOld: false, ageMinutes: 20 });
    // Exactly at the limit is still deliverable — past it is not.
    expect(foodAge(ready(45), 45, now).tooOld).toBe(false);
    expect(foodAge(ready(46), 45, now).tooOld).toBe(true);
    expect(foodAge({ readyAt: null }, 45, now)).toEqual({ tooOld: false, ageMinutes: null });
    expect(foodAge(ready(500), null, now)).toEqual({ tooOld: false, ageMinutes: null });
  });

  it('ships 45 min for FOOD, 90 for GROCERY, no cutoff for COURIER; the incentive ships at 0', () => {
    expect(ALGO_DEFAULTS['rescue.foodAgeMaxMinutes']).toEqual({ FOOD_DELIVERY: 45, GROCERY_DELIVERY: 90 });
    expect(ALGO_DEFAULTS['rescue.incentiveGyd']).toBe(0);
    expect(ALGO_DEFAULTS['rescue.incentiveFromCascade']).toBe(2);
  });
});

describe('[ALG-06 ②] the cutoff inside dispatch', () => {
  it('a READY food order 50 minutes old with no rider is retired by the system, marking nobody', async () => {
    const order = await makeOrder({ readyAgoMin: 50 });
    await app.redis.set(`dispatch:round:${order.id}`, '2');
    const cap = captureEmits();
    try {
      expect(await dispatch.dispatchOrder(order.id)).toEqual({ exhausted: true });
    } finally {
      cap.restore();
    }

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: after.status, riderId: after.riderId, cancelledBy: after.cancelledBy, reason: after.cancellationReason })
      .toEqual({ status: 'CANCELLED', riderId: null, cancelledBy: 'system', reason: FOOD_TOO_OLD_REASON });
    expect(after.cancelledAt).not.toBeNull();

    // The log says why, in words.
    const logRow = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'CANCELLED' } });
    expect(logRow?.changedBy).toBe('system');
    expect(logRow?.note).toContain('Food-age cutoff');
    expect(logRow?.note).toContain('Nobody is marked');

    // The decision row.
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-06', subjectType: 'ORDER', subjectId: order.id } });
    expect(row?.outcome).toBe('FOOD_TOO_OLD');
    expect(row?.shadow).toBe(false);
    expect(row?.inputs).toMatchObject({ ageMinutes: 50, limitMinutes: 45, orderType: 'FOOD_DELIVERY' });
    expect(row?.sentence.length).toBeLessThanOrEqual(240);

    // Nobody is marked: no strike for the customer, no rider to rate.
    expect(await app.prisma.strike.count({ where: { userId: customerId, orderId: order.id } })).toBe(0);

    // The customer and the store are told; CASH ⇒ nothing to pay, and the copy never names a signal.
    const toCustomer = await app.prisma.notification.findFirst({ where: { userId: customerId, dedupeKey: `food-too-old:customer:${order.id}` } });
    expect(toCustomer?.body).toContain('Nothing to pay.');
    expect(toCustomer?.body).not.toMatch(/fraud|suspect|flag|payout/i);
    const toVendor = await app.prisma.notification.findFirst({ where: { userId: vendorOwnerUserId, dedupeKey: `food-too-old:vendor:${order.id}` } });
    expect(toVendor?.title).toBe('Order cancelled — too old to deliver');

    // The cascade's keys are gone; no offer was ever made.
    for (const k of dispatchKeys(order.id)) expect(await app.redis.exists(k)).toBe(0);
    expect(await app.redis.get(`ops_page:food_too_old:${order.id}`)).toBe('1');
  });

  it('an MMG order tells the customer the store refunds — Swift never holds their money', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY' });
    expect(await dispatch.dispatchOrder(order.id)).toEqual({ exhausted: true });
    const toCustomer = await app.prisma.notification.findFirst({ where: { userId: customerId, dedupeKey: `food-too-old:customer:${order.id}` } });
    expect(toCustomer?.body).toContain('the store refunds you');
    expect(toCustomer?.body).not.toMatch(/Swift (will )?refund/i);
  });

  it('a 20-minute-old order is not retired: the loop goes on and offers it', async () => {
    const rider = await makeRider();
    const order = await makeOrder({ readyAgoMin: 20 });
    const cap = captureEmits();
    try {
      expect(await dispatch.dispatchOrder(order.id)).toEqual({ offered: rider.riderId });
      const offer = cap.emits.find((e) => e.event === 'dispatch:offer');
      expect(offer?.payload['orderId']).toBe(order.id);
      // No incentive on a first cascade at the shipped 0.
      expect(offer?.payload['rescueIncentiveGyd']).toBeNull();
    } finally {
      cap.restore();
    }
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('READY_FOR_PICKUP');
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id } })).toBe(0);
    expect(await app.redis.exists(incentiveKey(order.id))).toBe(0);
    await app.redis.del(`dispatch:offer:${order.id}`);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
  });

  it('an ACCEPTED order that is not ready yet has no age — the clock starts at readyAt', async () => {
    const order = await makeOrder({ status: 'ACCEPTED', readyAgoMin: null });
    // No candidate online ⇒ the loop exhausts honestly instead of retiring.
    const r = await dispatch.dispatchOrder(order.id);
    expect(r.offered).toBeUndefined();
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('ACCEPTED');
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id } })).toBe(0);
  });

  it('retire is a CAS: a rider who claimed it in the meantime keeps it', async () => {
    const rider = await makeRider();
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
    const order = await makeOrder({ readyAgoMin: 120, riderId: rider.riderId });
    const full = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { vendor: { select: { name: true, owner: { select: { userId: true } } } } } });
    expect(await retireTooOldOrder(deps(), full, 120, 45)).toBe(false);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: after.status, riderId: after.riderId }).toEqual({ status: 'READY_FOR_PICKUP', riderId: rider.riderId });
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id } })).toBe(0);
  });

  it('the watchdog sweep: grocery past 90 min is retired, 60 min kept, COURIER never', async () => {
    const old = await makeOrder({ orderType: 'GROCERY_DELIVERY', readyAgoMin: 100 });
    const fresh = await makeOrder({ orderType: 'GROCERY_DELIVERY', readyAgoMin: 60 });
    const courier = await makeOrder({ orderType: 'COURIER', readyAgoMin: 400 });
    const r = await sweepFoodAge(deps());
    expect(r.retired).toContain(old.id);
    expect(r.retired).not.toContain(fresh.id);
    expect(r.retired).not.toContain(courier.id);
    const [a, b, c] = await Promise.all([old, fresh, courier].map((o) => app.prisma.order.findUniqueOrThrow({ where: { id: o.id } })));
    expect([a!.status, b!.status, c!.status]).toEqual(['CANCELLED', 'READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
    expect(a!.cancellationReason).toBe(FOOD_TOO_OLD_REASON);
    // Idempotent: a second sweep finds nothing of ours.
    const again = await sweepFoodAge(deps());
    expect(again.retired).not.toContain(old.id);
  });
});

// ---------------------------------------------------------------------------

describe('[ALG-06 ①] the escalating re-offer — Swift’s own money', () => {
  it('nothing at the shipped 0, nothing before the configured cascade, the amount from it on', async () => {
    expect(await rescueIncentiveGyd(app.prisma, 5)).toBe(0);
    await setAlgo('rescue.incentiveGyd', 500);
    expect(await rescueIncentiveGyd(app.prisma, 1)).toBe(0);
    expect(await rescueIncentiveGyd(app.prisma, 2)).toBe(500);
    expect(await rescueIncentiveGyd(app.prisma, 3)).toBe(500);
  });

  it('a second-cascade offer carries the incentive; accepting it creates the payable once, after the durable claim', async () => {
    await setAlgo('rescue.incentiveGyd', 500);
    const rider = await makeRider();
    const order = await makeOrder({ readyAgoMin: 10 });
    // One exhausted attempt behind it ⇒ this search is cascade 2.
    await app.redis.set(`dispatch:exhausts:${order.id}`, '1', 'EX', 600);

    const cap = captureEmits();
    try {
      expect(await dispatch.dispatchOrder(order.id)).toEqual({ offered: rider.riderId });
      const offer = cap.emits.find((e) => e.event === 'dispatch:offer');
      expect(offer?.payload['rescueIncentiveGyd']).toBe(500);
    } finally {
      cap.restore();
    }
    expect(JSON.parse((await app.redis.get(incentiveKey(order.id))) ?? 'null')).toEqual({ amountGyd: 500, cascade: 2 });
    // Nothing is owed until the job is durably claimed.
    expect(await app.prisma.earning.count({ where: { orderId: order.id, type: 'RESCUE_INCENTIVE' } })).toBe(0);
    // A card rebuilt after an app death is the SAME card: the bonus rides recovery too.
    expect((await dispatch.currentOfferFor(rider.riderId))?.rescueIncentiveGyd).toBe(500);

    const accepted = await dispatch.acceptOffer(order.id, rider.userId);
    expect({ status: accepted.status, riderId: accepted.riderId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: rider.riderId });

    const earning = await app.prisma.earning.findUnique({ where: { orderId_type: { orderId: order.id, type: 'RESCUE_INCENTIVE' } } });
    expect(earning).toMatchObject({ riderId: rider.riderId, status: 'PENDING' });
    expect(Number(earning?.amount)).toBe(500);
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-06', subjectType: 'RIDER', subjectId: rider.riderId, outcome: 'INCENTIVE_GRANTED' } });
    expect(row?.inputs).toMatchObject({ orderId: order.id, amountGyd: 500, cascade: 2, source: 'PLATFORM' });
    expect(row?.sentence).toContain('Swift’s own money');
    expect(await app.redis.exists(incentiveKey(order.id))).toBe(0);

    // Once per order: a replay grants nothing more.
    expect(await grantRescueIncentive(app.prisma, { orderId: order.id, riderId: rider.riderId, amountGyd: 500, cascade: 2 })).toBe(false);
    expect(await app.prisma.earning.count({ where: { orderId: order.id, type: 'RESCUE_INCENTIVE' } })).toBe(1);

    // The order's own money is untouched: the customer's total and the store's share did not move.
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(after.totalAmount)).toBe(2500);
    expect(Number(after.deliveryFee)).toBe(500);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
  });

  it('a first-cascade offer carries nothing even with an amount set; accepting it creates no payable', async () => {
    await setAlgo('rescue.incentiveGyd', 500);
    const rider = await makeRider();
    const order = await makeOrder({ readyAgoMin: 10 });
    const cap = captureEmits();
    try {
      expect(await dispatch.dispatchOrder(order.id)).toEqual({ offered: rider.riderId });
      expect(cap.emits.find((e) => e.event === 'dispatch:offer')?.payload['rescueIncentiveGyd']).toBeNull();
    } finally {
      cap.restore();
    }
    expect(await app.redis.exists(incentiveKey(order.id))).toBe(0);
    await dispatch.acceptOffer(order.id, rider.userId);
    expect(await app.prisma.earning.count({ where: { orderId: order.id, type: 'RESCUE_INCENTIVE' } })).toBe(0);
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
  });

  it('the earning explains itself as Swift’s money, never the customer’s or the store’s', () => {
    const s = explainEarning({ type: 'RESCUE_INCENTIVE', amount: 500 }, { orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH' });
    expect(s).toContain('GY$500');
    expect(s).toContain('Swift pays this, not the customer or the store');
    expect(s).not.toMatch(/payout/i);
  });
});

// ---------------------------------------------------------------------------

describe('[ALG-06] source pins — the hook sits where the law says', () => {
  const service = readFileSync(path.join(__dirname, '../modules/dispatch/dispatch.service.ts'), 'utf8');
  const rescue = readFileSync(path.join(__dirname, '../modules/dispatch/rescue.ts'), 'utf8');
  const queue = readFileSync(path.join(__dirname, '../jobs/queue.ts'), 'utf8');

  it('the cutoff runs before the live-offer check, inside dispatchOrder, for the RIDER pool only', () => {
    const start = service.indexOf('async dispatchOrder(');
    const cutoff = service.indexOf("if (pool === 'RIDER' && order.readyAt) {", start);
    const liveOffer = service.indexOf('// One live offer at a time', start);
    expect(start).toBeGreaterThan(0);
    expect(cutoff).toBeGreaterThan(start);
    expect(liveOffer).toBeGreaterThan(cutoff);
    expect(service.slice(cutoff, liveOffer)).toContain('return { exhausted: true };');
  });

  it('the payable is settled after the durable claim, never before, and never load-bearing for it', () => {
    const start = service.indexOf('async acceptOffer(');
    const claim = service.indexOf('const claimed = await this.claimOrder(', start);
    const settle = service.indexOf("if (pool === 'RIDER') await this.settleRescueIncentive(orderId, mover.id);", start);
    const ret = service.indexOf('return claimed;', start);
    expect(claim).toBeGreaterThan(start);
    expect(settle).toBeGreaterThan(claim);
    expect(ret).toBeGreaterThan(settle);
    const settleBody = service.slice(service.indexOf('private async settleRescueIncentive('));
    expect(settleBody.slice(0, settleBody.indexOf('\n  }\n'))).toContain('catch (err)');
  });

  it("rescue's key formats mirror the dispatch service's, and the incentive rides the offer payload", () => {
    for (const prefix of ['dispatch:offer:${', 'dispatch:declined:${', 'dispatch:exhausts:${', 'dispatch:round:${']) {
      expect(rescue).toContain(prefix);
      expect(service).toContain(prefix);
    }
    const emit = service.indexOf("emit('dispatch:offer', {");
    expect(service.slice(emit, emit + 4000)).toContain('rescueIncentiveGyd: rescueGyd > 0 ? rescueGyd : null,');
  });

  it('the stranded-delivery watchdog tick runs the food-age sweep', () => {
    expect(queue).toContain('sweepFoodAge(');
  });

  it('the incentive is Swift’s own money on the earning rail: its own type, PENDING, never order money', () => {
    expect(rescue).toContain("type: 'RESCUE_INCENTIVE'");
    expect(rescue).toContain("status: 'PENDING'");
    expect(rescue).not.toMatch(/totalAmount|deliveryFee|subtotal/);
  });
});
