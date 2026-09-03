import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// [REPORT-070 F-02] notifyAdmins is spied through a partial module mock so one
// case can make the ops page reach NOBODY; everything else in the module is real.
vi.mock('../modules/notification/notification.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/notification/notification.service')>();
  return { ...mod, notifyAdmins: vi.fn(mod.notifyAdmins) };
});
// [hold v3 · N-02] recordDecision is spied the same way so one case can make
// the decision write FAIL inside the claim transaction.
vi.mock('../modules/algo/decisions', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/algo/decisions')>();
  return { ...mod, recordDecision: vi.fn(mod.recordDecision) };
});
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
import { NotificationService, notifyAdmins } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { recordDecision } from '../modules/algo/decisions';
import { ConflictError } from '../utils/errors';
import {
  foodAge, foodAgeLimitMinutes, retireTooOldOrder, settleTooOldOrder, sweepFoodAge, releaseFoodAgeHold, grantRescueIncentive, rescueIncentiveGyd, incentiveKey, isCapturedMmg, SWEEP_PAGE,
  FOOD_TOO_OLD_REASON, FOOD_TOO_OLD_PAID_HELD_OUTCOME,
} from '../modules/dispatch/rescue';
import { ALGO_DEFAULTS, invalidateAlgoConfig } from '../modules/algo/algo-config';
import { explainEarning } from '../utils/explain-earning';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite quiets the WHOLE rider pool between cases (an unscoped Rider.updateMany) so no leftover rider takes a dispatch — a stated, reviewable capability.
grantSuiteCapability('unscoped-mutation');

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
  for (const o of oids) await app.redis.del(...dispatchKeys(o), `ops_page:food_too_old:${o}`, `ops_page:food_too_old_paid:${o}`);
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

async function makeOrder(opts: { orderType?: OrderType; status?: OrderStatus; readyAgoMin?: number | null; paymentMethod?: 'CASH' | 'MOBILE_MONEY'; paymentStatus?: 'PENDING' | 'CAPTURED'; riderId?: string; fulfillment?: 'DELIVERY' | 'PICKUP'; fulfillmentMode?: 'PLATFORM_RIDER' | 'VENDOR_DELIVERY'; heldAgoMin?: number } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `RSC-${nanoid(8)}`, orderType: opts.orderType ?? 'FOOD_DELIVERY', customerId, vendorId,
      status: opts.status ?? 'READY_FOR_PICKUP', fulfillment: opts.fulfillment ?? 'DELIVERY',
      ...(opts.fulfillmentMode ? { fulfillmentMode: opts.fulfillmentMode } : {}),
      ...(opts.heldAgoMin != null ? { foodAgeHeldAt: new Date(Date.now() - opts.heldAgoMin * MIN) } : {}),
      ...(opts.readyAgoMin == null ? {} : { readyAt: new Date(Date.now() - opts.readyAgoMin * MIN) }),
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
      pickupAddress: 'Store', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng, deliveryAddress: 'Home', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: opts.paymentMethod ?? 'CASH',
      ...(opts.paymentStatus ? { paymentStatus: opts.paymentStatus } : {}),
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
const orderService = () => new OrderService(app.prisma, app.io);
const TENANT_X = 'tenant-rescue-x';

async function setAlgoFor(tenantId: string, key: string, value: unknown) {
  const latest = await app.prisma.algoConfig.findFirst({ where: { tenantId, key }, orderBy: { version: 'desc' } });
  await app.prisma.algoConfig.create({ data: { tenantId, key, value: value as never, version: (latest?.version ?? 0) + 1, updatedBy: UPDATED_BY } });
  invalidateAlgoConfig();
}

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
  // [hold v3 · N-11] "ops paged" is proved against THIS admin, not whatever the CI seed happens to hold.
  await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}92`, firstName: 'Rescue', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date() } });
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
  await app.prisma.tenant.deleteMany({ where: { id: TENANT_X } }).catch(() => {});
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

describe('[TA-S0-001] paid MMG money is never cancelled by the system', () => {
  const vendorInclude = { vendor: { select: { name: true, owner: { select: { userId: true } } } } } as const;

  it('the predicate: captured money on the MMG rail, and nothing else', () => {
    expect(isCapturedMmg({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' })).toBe(true);
    expect(isCapturedMmg({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })).toBe(false);
    expect(isCapturedMmg({ paymentMethod: 'CASH', paymentStatus: 'CAPTURED' })).toBe(false);
  });

  it('inside dispatch: a captured MMG order past the cutoff is HELD for a person — not cancelled, the truth told, ops paged', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    const cap = captureEmits();
    try {
      // The loop still stops: too old is too old. But nothing is cancelled.
      expect(await dispatch.dispatchOrder(order.id)).toEqual({ exhausted: true });
      expect(cap.emits.find((e) => e.event === 'order:status_changed')).toBeUndefined();
    } finally {
      cap.restore();
    }

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: after.status, riderId: after.riderId, cancelledAt: after.cancelledAt, cancelledBy: after.cancelledBy, paymentStatus: after.paymentStatus })
      .toEqual({ status: 'READY_FOR_PICKUP', riderId: null, cancelledAt: null, cancelledBy: null, paymentStatus: 'CAPTURED' });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } })).toBe(0);

    // The log says why it was NOT cancelled, in words.
    const logRow = await app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
    expect(logRow?.changedBy).toBe('system');
    expect(logRow?.note).toContain('already paid by MMG');
    expect(logRow?.note).toContain('HELD for review, not cancelled');
    expect(logRow?.status).toBe('READY_FOR_PICKUP'); // the true state, never a guess

    // The decision row names the held outcome — never the cancel outcome.
    const rows = await app.prisma.algoDecision.findMany({ where: { algo: 'ALG-06', subjectType: 'ORDER', subjectId: order.id } });
    expect(rows.map((r) => r.outcome)).toEqual([FOOD_TOO_OLD_PAID_HELD_OUTCOME]);
    expect(rows[0]?.shadow).toBe(false);
    expect(rows[0]?.inputs).toMatchObject({ ageMinutes: 60, limitMinutes: 45, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    expect(rows[0]?.sentence.length).toBeLessThanOrEqual(240);

    // Customer: already paid, a person is on it, the store refunds directly — never "cancelled", never "Swift refunds".
    const toCustomer = await app.prisma.notification.findFirst({ where: { userId: customerId, dedupeKey: `food-too-old-paid:customer:${order.id}` } });
    expect(toCustomer?.body).toContain('already paid the store by MMG');
    expect(toCustomer?.body).toContain('NOT cancelled automatically');
    expect(toCustomer?.body).toContain('flagged for review by Swift');
    expect(toCustomer?.body).toContain('the store refunds you directly');
    // [REPORT-070 F-13] Nobody has acknowledged anything: no claim of a person already on it, no Swift refund.
    expect(toCustomer?.body).not.toMatch(/sorting|handling|a person at Swift is|sent to Swift|Swift (will )?refund/i);
    expect(await app.prisma.notification.count({ where: { userId: customerId, dedupeKey: `food-too-old:customer:${order.id}` } })).toBe(0);
    // Store: not cancelled, keep it, a person is handling it.
    const toVendor = await app.prisma.notification.findFirst({ where: { userId: vendorOwnerUserId, dedupeKey: `food-too-old-paid:vendor:${order.id}` } });
    expect(toVendor?.title).toBe('No rider found — the customer has already paid');
    expect(toVendor?.body).toContain('NOT cancelled');
    expect(toVendor?.body).toContain('flagged for a Swift operator');
    expect(toVendor?.body).toContain('you refund the customer directly');
    expect(toVendor?.body).not.toMatch(/sorting|handling|a person at Swift is/i);
    // The hold is a COLUMN, and it is set.
    expect(after.foodAgeHeldAt).not.toBeNull();
    // Ops: paged once on the paid-hold key, never on the cancel key.
    expect(await app.redis.get(`ops_page:food_too_old_paid:${order.id}`)).toBe('1');
    expect(await app.redis.exists(`ops_page:food_too_old:${order.id}`)).toBe(0);
  });

  it('the sweep holds it too, and holding is idempotent: a second tick writes no second row, page or notice', async () => {
    const order = await makeOrder({ orderType: 'GROCERY_DELIVERY', readyAgoMin: 100, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    const first = await sweepFoodAge(deps());
    expect(first.held).toContain(order.id);
    expect(first.retired).not.toContain(order.id);
    const second = await sweepFoodAge(deps());
    expect(second.held).toContain(order.id);
    expect(second.retired).not.toContain(order.id);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: after.status, riderId: after.riderId }).toEqual({ status: 'READY_FOR_PICKUP', riderId: null });
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: customerId, dedupeKey: `food-too-old-paid:customer:${order.id}` } })).toBe(1);
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, changedBy: 'system' } })).toBe(1);
  });

  it('the guard is in the CAS, not the snapshot: money captured after the caller read the order is respected', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' });
    // The caller's view: still unpaid.
    const snapshot = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: vendorInclude });
    expect(snapshot.paymentStatus).toBe('PENDING');
    // Then the store's capture lands between that read and the cutoff's write.
    await app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    expect(await settleTooOldOrder(deps(), snapshot, 60, 45)).toBe('HELD_PAID');
    expect(await retireTooOldOrder(deps(), snapshot, 60, 45)).toBe(false);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: after.status, cancelledAt: after.cancelledAt, paymentStatus: after.paymentStatus })
      .toEqual({ status: 'READY_FOR_PICKUP', cancelledAt: null, paymentStatus: 'CAPTURED' });
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id, outcome: FOOD_TOO_OLD_PAID_HELD_OUTCOME } })).toBe(1);
  });

  it('an UNPAID MMG order is still retired — cancellation is the only exit from money nobody has paid', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' });
    const full = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: vendorInclude });
    expect(await settleTooOldOrder(deps(), full, 60, 45)).toBe('RETIRED');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: after.status, reason: after.cancellationReason }).toEqual({ status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON });
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id, outcome: FOOD_TOO_OLD_PAID_HELD_OUTCOME } })).toBe(0);
  });

  it('a rider who claimed it in the meantime is neither retired nor held — UNTOUCHED', async () => {
    const rider = await makeRider();
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
    const order = await makeOrder({ readyAgoMin: 120, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', riderId: rider.riderId });
    const full = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: vendorInclude });
    expect(await settleTooOldOrder(deps(), full, 120, 45)).toBe('UNTOUCHED');
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id } })).toBe(0);
    expect(await app.prisma.notification.count({ where: { userId: customerId, dedupeKey: `food-too-old-paid:customer:${order.id}` } })).toBe(0);
  });
});

describe('[TA-S0-001 hold v2 — REPORT-070] the hold is durable, enforceable and honest', () => {
  const vendorInclude = { vendor: { select: { name: true, owner: { select: { userId: true } } } } } as const;
  const full = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id }, include: vendorInclude });
  const customerNotices = (id: string) => app.prisma.notification.count({ where: { userId: customerId, dedupeKey: { in: [`food-too-old:customer:${id}`, `food-too-old-paid:customer:${id}`] } } });

  it('[F-06] a pickup order and a store-delivered order are never "no rider found": the sweep and the CAS leave them alone', async () => {
    const pickup = await makeOrder({ readyAgoMin: 120, fulfillment: 'PICKUP' });
    const selfDelivered = await makeOrder({ readyAgoMin: 120, fulfillmentMode: 'VENDOR_DELIVERY' });
    const paidPickup = await makeOrder({ readyAgoMin: 120, fulfillment: 'PICKUP', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    const r = await sweepFoodAge(deps());
    for (const o of [pickup, selfDelivered, paidPickup]) {
      expect(r.retired).not.toContain(o.id);
      expect(r.held).not.toContain(o.id);
      expect(await settleTooOldOrder(deps(), await full(o.id), 120, 45)).toBe('UNTOUCHED');
      const after = await app.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      expect({ status: after.status, held: after.foodAgeHeldAt }).toEqual({ status: 'READY_FOR_PICKUP', held: null });
      expect(await customerNotices(o.id)).toBe(0);
    }
  });

  it('[F-03] a held order is fenced everywhere: the offer keys are cleared, the dispatch loop leaves it, the assignment seam refuses it', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    await app.redis.set(`dispatch:offer:${order.id}`, 'a-card-still-on-a-phone');
    expect(await settleTooOldOrder(deps(), await full(order.id), 60, 45)).toBe('HELD_PAID');
    expect(await app.redis.exists(`dispatch:offer:${order.id}`)).toBe(0);

    const rider = await makeRider();
    try {
      expect(await dispatch.dispatchOrder(order.id)).toEqual({});
      await expect(
        app.prisma.$transaction((tx) => orderService().stageDirectRiderAssignment(tx, {
          orderId: order.id, riderId: rider.riderId, changedBy: rider.userId, moverUserId: rider.userId, note: 'hold fence test',
        })),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
    }
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ riderId: after.riderId, status: after.status }).toEqual({ riderId: null, status: 'READY_FOR_PICKUP' });
    expect(after.foodAgeHeldAt).not.toBeNull();
  });

  it('[F-01] overlapping hold attempts have ONE winner: one decision row, one log note, one notice each', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    const row = await full(order.id);
    const outcomes = await Promise.all([settleTooOldOrder(deps(), row, 60, 45), settleTooOldOrder(deps(), row, 60, 45), settleTooOldOrder(deps(), row, 60, 45)]);
    expect(outcomes).toEqual(['HELD_PAID', 'HELD_PAID', 'HELD_PAID']);
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: order.id } })).toBe(1);
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, changedBy: 'system' } })).toBe(1);
    expect(await customerNotices(order.id)).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: vendorOwnerUserId, dedupeKey: `food-too-old-paid:vendor:${order.id}` } })).toBe(1);
  });

  it('[F-02] an ops page that reaches NOBODY is a failed page: the claim is released, and the next tick pages again', async () => {
    vi.mocked(notifyAdmins).mockResolvedValueOnce(0);
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    expect(await settleTooOldOrder(deps(), await full(order.id), 60, 45)).toBe('HELD_PAID');
    expect(await app.redis.exists(`ops_page:food_too_old_paid:${order.id}`)).toBe(0); // released, not "done"
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).foodAgeHeldAt).not.toBeNull(); // the hold itself stands

    const again = await sweepFoodAge(deps());
    expect(again.held).toContain(order.id);
    expect(await app.redis.get(`ops_page:food_too_old_paid:${order.id}`)).toBe('1');
    const pagesForOrder = vi.mocked(notifyAdmins).mock.calls.filter((c) => (c[2]?.data as Record<string, unknown> | undefined)?.['orderId'] === order.id);
    expect(pagesForOrder.length).toBeGreaterThanOrEqual(2);
  });

  it('[F-01] a crash after the claim is repaired on the next tick: the notices and the page are delivered then', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAgoMin: 5 }); // claimed, nothing delivered
    expect(await customerNotices(order.id)).toBe(0);
    const r = await sweepFoodAge(deps());
    expect(r.held).toContain(order.id);
    expect(r.retired).not.toContain(order.id);
    expect(await customerNotices(order.id)).toBe(1);
    expect(await app.redis.get(`ops_page:food_too_old_paid:${order.id}`)).toBe('1');
    // And a second tick adds nothing.
    await sweepFoodAge(deps());
    expect(await customerNotices(order.id)).toBe(1);
  });

  it('[F-04] held rows do not occupy the retire page: an unpaid too-old order behind three holds is still retired this tick', async () => {
    for (let i = 0; i < 3; i += 1) await makeOrder({ readyAgoMin: 300, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAgoMin: 1 });
    const unpaid = await makeOrder({ readyAgoMin: 200 });
    const r = await sweepFoodAge(deps());
    expect(r.retired).toContain(unpaid.id);
  });

  it('[F-05] the cutoff is the ORDER tenant’s own dial', async () => {
    await app.prisma.tenant.upsert({ where: { id: TENANT_X }, create: { id: TENANT_X, name: 'Rescue Tenant X', slug: TENANT_X }, update: {} });
    await setAlgoFor(TENANT_X, 'rescue.foodAgeMaxMinutes', { FOOD_DELIVERY: 9999, GROCERY_DELIVERY: 9999 });
    expect(await foodAgeLimitMinutes(app.prisma, 'FOOD_DELIVERY', TENANT_X)).toBe(9999);
    expect(await foodAgeLimitMinutes(app.prisma, 'FOOD_DELIVERY', 'swift-default')).toBe(45);
  });

  it('[F-03] releaseFoodAgeHold is an operator’s decision: it clears the hold once, logs who, and reopens the page', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    await settleTooOldOrder(deps(), await full(order.id), 60, 45);
    expect(await releaseFoodAgeHold(deps(), { orderId: order.id, tenantId: 'swift-default', byUserId: 'ops-user-1' })).toBe('RELEASED');
    expect(await releaseFoodAgeHold(deps(), { orderId: order.id, tenantId: 'swift-default', byUserId: 'ops-user-1' })).toBe('NOT_HELD');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.foodAgeHeldAt).toBeNull();
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, changedBy: 'ops-user-1' } })).toBe(1);
    expect(await app.redis.exists(`ops_page:food_too_old_paid:${order.id}`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('[TA-S0-001 hold v3 — the review of #991] a two-way door with a durable record', () => {
  const vendorInclude = { vendor: { select: { name: true, owner: { select: { userId: true } } } } } as const;
  const full = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id }, include: vendorInclude });
  const audit = async (id: string) => ({
    decisions: await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: id, outcome: FOOD_TOO_OLD_PAID_HELD_OUTCOME } }),
    notes: await app.prisma.orderStatusLog.count({ where: { orderId: id, changedBy: 'system', note: { startsWith: 'Food-age cutoff:' } } }),
  });

  it('[N-02] the claim and its record are one transaction: a refused decision write rolls the hold back, and the next tick lands all three', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    vi.mocked(recordDecision).mockImplementationOnce(async () => { throw new Error('decision store refused the write'); });
    await expect(settleTooOldOrder(deps(), await full(order.id), 60, 45)).rejects.toThrow('decision store refused');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.foodAgeHeldAt).toBeNull(); // no hold without its record
    expect(await audit(order.id)).toEqual({ decisions: 0, notes: 0 });

    expect(await settleTooOldOrder(deps(), await full(order.id), 60, 45)).toBe('HELD_PAID');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).foodAgeHeldAt).not.toBeNull();
    expect(await audit(order.id)).toEqual({ decisions: 1, notes: 1 });
  });

  it('[N-02] the sweep repairs a hold that has no record (a pre-v3 hold), idempotently', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAgoMin: 3 });
    expect(await audit(order.id)).toEqual({ decisions: 0, notes: 0 });
    await sweepFoodAge(deps());
    expect(await audit(order.id)).toEqual({ decisions: 1, notes: 1 });
    await sweepFoodAge(deps());
    expect(await audit(order.id)).toEqual({ decisions: 1, notes: 1 });
  });

  it('[N-07] the holds pass walks past its page across ticks: five holds, a page of two, every one served', async () => {
    const ids: string[] = [];
    for (let i = 5; i >= 1; i -= 1) ids.push((await makeOrder({ readyAgoMin: 90, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAgoMin: i })).id);
    const saved = SWEEP_PAGE.holds;
    SWEEP_PAGE.holds = 2;
    try {
      // Other cases in this file leave holds behind too, so the walk is driven
      // until the cursor wraps: every hold in the set has been visited once.
      await app.redis.del('rescue:cursor:holds');
      let ticks = 0;
      do {
        await sweepFoodAge(deps());
        ticks += 1;
      } while ((await app.redis.exists('rescue:cursor:holds')) === 1 && ticks < 60);
      expect(ticks).toBeGreaterThan(2); // the page really was smaller than the set
    } finally {
      SWEEP_PAGE.holds = saved;
      await app.redis.del('rescue:cursor:holds');
    }
    for (const id of ids) {
      expect(await app.prisma.notification.count({ where: { userId: customerId, dedupeKey: `food-too-old-paid:customer:${id}` } })).toBe(1);
    }
  });

  it('[N-01/N-12] release is a durable "deliver anyway": the waiver is recorded, the sweep leaves the order alone, and the claim refuses it', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    expect(await settleTooOldOrder(deps(), await full(order.id), 60, 45)).toBe('HELD_PAID');
    expect(await releaseFoodAgeHold(deps(), { orderId: order.id, tenantId: 'swift-default', byUserId: 'ops-user-2' })).toBe('RELEASED');
    const released = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ held: released.foodAgeHeldAt, waivedBy: released.foodAgeWaivedBy }).toEqual({ held: null, waivedBy: 'ops-user-2' });
    expect(released.foodAgeWaivedAt).not.toBeNull();
    // Still 60 minutes old, still riderless — and no longer the cutoff's business.
    const swept = await sweepFoodAge(deps());
    expect(swept.held).not.toContain(order.id);
    expect(swept.retired).not.toContain(order.id);
    expect(await settleTooOldOrder(deps(), await full(order.id), 60, 45)).toBe('UNTOUCHED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).foodAgeHeldAt).toBeNull();
  });

  it('[N-12] release binds tenant and lifecycle: another tenant sees nothing to release; a rider on the order makes it unreleasable', async () => {
    const order = await makeOrder({ readyAgoMin: 60, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' });
    expect(await settleTooOldOrder(deps(), await full(order.id), 60, 45)).toBe('HELD_PAID');
    expect(await releaseFoodAgeHold(deps(), { orderId: order.id, tenantId: 'tenant-somewhere-else', byUserId: 'ops-user-3' })).toBe('NOT_HELD');
    const rider = await makeRider();
    try {
      await app.prisma.order.update({ where: { id: order.id }, data: { riderId: rider.riderId } });
      expect(await releaseFoodAgeHold(deps(), { orderId: order.id, tenantId: 'swift-default', byUserId: 'ops-user-3' })).toBe('NOT_RELEASABLE');
    } finally {
      await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null } });
      await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
    }
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).foodAgeHeldAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('[ALG-06 ①] the escalating re-offer — Swift’s own money', () => {
  it('nothing at the shipped 0, nothing before the configured cascade, the amount from it on', async () => {
    expect(await rescueIncentiveGyd(app.prisma, 5, 'swift-default')).toBe(0);
    await setAlgo('rescue.incentiveGyd', 500);
    expect(await rescueIncentiveGyd(app.prisma, 1, 'swift-default')).toBe(0);
    expect(await rescueIncentiveGyd(app.prisma, 2, 'swift-default')).toBe(500);
    expect(await rescueIncentiveGyd(app.prisma, 3, 'swift-default')).toBe(500);
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
