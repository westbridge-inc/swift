import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService } from '../modules/notification/notification.service';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { estimateDeliveryMinutes } from '../utils/distance';
import { AGGREGATE_BUCKET, bucketOf } from '../modules/prep/prep-time';
import {
  promiseWindow, promiseView, promiseAtCheckout, revisePromise, noteLiveEta, computeEtaPads, etaReport, weeklyEtaCalibration,
  WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN, SLIP_GATE_SECONDS,
} from '../modules/eta/promise';

// ---------------------------------------------------------------------------
// [ALG-12 / FMC §12.2] The promise the customer is given.
//
// Graded: the range sits on five-minute marks (R-12.2.1); the promise is the
// documented sum, padded by a pad LEARNED from Swift's own lateness to hit the
// target rate; it is written at creation from the one checkout seam; it is
// revised only for a slip, only out loud, with the reason recorded (L8) and
// the customer told before they check (R-12.2.3); a live ETA can revise it
// once per gate window and only from a leg that is actually heading to the
// customer; the weekly report measures what was kept.
// ---------------------------------------------------------------------------

describe('the range the customer sees', () => {
  it('sits on five-minute marks around the promise: start rounded down, end rounded up', () => {
    const w = promiseWindow(new Date('2026-08-30T23:42:00Z'));
    expect(w.start.toISOString()).toBe('2026-08-30T23:35:00.000Z'); // 23:37 → 23:35
    expect(w.end.toISOString()).toBe('2026-08-30T23:55:00.000Z');   // 23:52 → 23:55
    expect(WINDOW_BEFORE_MIN).toBe(5);
    expect(WINDOW_AFTER_MIN).toBe(10);
  });

  it('the view is null without a promise and carries the revision state when there is one', () => {
    expect(promiseView({ promisedAt: null })).toBeNull();
    const v = promiseView({ promisedAt: new Date('2026-08-30T23:42:00Z'), promiseRevisedAt: null, promiseRevisionReason: null, promiseRevisions: 0 });
    expect(v).toEqual({ at: '2026-08-30T23:42:00.000Z', windowStart: '2026-08-30T23:35:00.000Z', windowEnd: '2026-08-30T23:55:00.000Z', revisedAt: null, revisionReason: null, revisions: 0 });
  });

  it('the dials ship at the documented values', () => {
    expect(ALGO_DEFAULTS['eta.targetOnTime']).toBe(0.85);
    expect(ALGO_DEFAULTS['eta.slipNotifySeconds']).toBe(300);
    expect(ALGO_DEFAULTS['eta.defaultPadSeconds']).toBe(300);
  });

  it('checkout writes the promise from the one seam, and every read hands out the view', () => {
    const svc = readFileSync(path.join(__dirname, '..', 'modules', 'order', 'order.service.ts'), 'utf8');
    expect(svc).toContain('await promiseAtCheckout(this.prisma, {');
    expect(svc).toContain("promisedAt: promise.promisedAt, promiseBaseSeconds: promise.baseSeconds, promisePadSeconds: promise.padSeconds");
    expect(svc).not.toMatch(/estimateDeliveryMinutes\(plan\.distanceKm\) \+ \(plan\.vendor\.estimatedPrepTime \|\| 30\)/);
    const cust = readFileSync(path.join(__dirname, '..', 'modules', 'user', 'customer.routes.ts'), 'utf8');
    expect(cust).toContain('promise: promiseView(order),');
    expect(cust).toContain('activeOrder: activeOrder ? { ...activeOrder, promise: promiseView(activeOrder) } : activeOrder,');
    const rider = readFileSync(path.join(__dirname, '..', 'modules', 'rider', 'rider.routes.ts'), 'utf8');
    expect(rider).toContain('void noteLiveEta(');
  });
});

describe('the promise, the pad, the revision, the report — against the database', () => {
  const PHONE_PREFIX = '+59200667';
  const DAY = 24 * 60 * 60 * 1000;
  const PLACED = new Date('2026-08-24T16:10:00Z'); // Monday noon in Georgetown
  let app: FastifyInstance;
  let customerId: string;
  let vendorId: string;
  let adminToken: string;
  let notifications: NotificationService;

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const orders = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-12', subjectId: { in: [...orders.map((o) => o.id), 'platform'] } } });
    await app.prisma.etaPadStat.deleteMany({ where: { vertical: { in: ['FOOD_DELIVERY', 'GROCERY_DELIVERY'] } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    for (const o of orders) await app.redis.del(`eta:slip:${o.id}`);
    await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  async function makeOrder(opts: { status: string; placedAt: Date; deliveredAt?: Date | null; promisedAt?: Date | null; promiseBaseSeconds?: number | null; orderType?: 'FOOD_DELIVERY' | 'GROCERY_DELIVERY' }) {
    return app.prisma.order.create({
      data: {
        orderNumber: `ETA-${nanoid(8)}`, orderType: opts.orderType ?? 'FOOD_DELIVERY', customerId, vendorId, status: opts.status as any,
        fulfillment: 'DELIVERY', pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
        placedAt: opts.placedAt, deliveredAt: opts.deliveredAt ?? null, promisedAt: opts.promisedAt ?? null, promiseBaseSeconds: opts.promiseBaseSeconds ?? null,
      },
    });
  }

  const deps = () => ({ prisma: app.prisma, io: app.io, redis: app.redis, notifications });

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
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });
    await app.ready();
    await purge();
    notifications = new NotificationService(app.prisma, app.io);
    const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}00`, firstName: 'Eta', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    customerId = customer.id;
    const ownerUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}01`, firstName: 'Eta', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    vendorId = (await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Eta Diner', slug: `eta-diner-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}90`,
        addressLine1: '1 Eta St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE', acceptingOrders: true, isVerified: true, estimatedPrepTime: 25,
      },
    })).id;
    const admin = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}98`, firstName: 'Eta', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } } } });
    adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: admin.id, token: adminToken, refreshToken: nanoid(40), deviceId: 'eta', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  });

  afterAll(async () => {
    await purge();
    await app.close();
  });

  it('with nothing learned, the promise is the documented sum on the declared prep time, plus the default pad — every part named', async () => {
    const p = await promiseAtCheckout(app.prisma, { tenantId: 'swift-default', orderType: 'FOOD_DELIVERY', vendorId, vendorType: 'RESTAURANT', declaredMinutes: 25, distanceKm: 2, itemCount: 1, placedAt: PLACED });
    const prepP80 = Math.round(25 * 60 * 1.25);
    const toCustomer = estimateDeliveryMinutes(2) * 60;
    expect(p.parts).toEqual({ prepP80Seconds: prepP80, prepTier: 'DECLARED', riderToStoreSeconds: 420, serviceSeconds: 180, toCustomerSeconds: toCustomer, padSeconds: 300, padSource: 'DEFAULT' });
    expect(p.baseSeconds).toBe(prepP80 + 420 + 180 + toCustomer);
    expect(p.padSeconds).toBe(300);
    expect(p.promisedAt.getTime()).toBe(PLACED.getTime() + (p.baseSeconds + 300) * 1000);
  });

  it('the pad is learned from Swift\'s own lateness — the target percentile of (actual − unpadded) per vertical-hour — and then used', async () => {
    // Ten delivered orders, base 3000 s, lateness −300…+900: the 85th nearest rank is 600.
    const lateness = [-300, -120, 0, 60, 120, 180, 240, 300, 600, 900];
    for (const late of lateness) {
      await makeOrder({ status: 'DELIVERED', placedAt: PLACED, deliveredAt: new Date(PLACED.getTime() + (3000 + late) * 1000), promiseBaseSeconds: 3000, promisedAt: new Date(PLACED.getTime() + 3300 * 1000) });
    }
    const r = await computeEtaPads(app.prisma, new Date('2026-08-30T12:00:00Z'));
    expect(r.orders).toBeGreaterThanOrEqual(10);
    const { hourBucket } = bucketOf(PLACED);
    const hour = await app.prisma.etaPadStat.findUniqueOrThrow({ where: { tenantId_vertical_hourBucket: { tenantId: 'swift-default', vertical: 'FOOD_DELIVERY', hourBucket } } });
    expect(hour).toMatchObject({ sampleCount: 10, padSeconds: 600, onTimeRate: 0.3 });
    const overall = await app.prisma.etaPadStat.findUniqueOrThrow({ where: { tenantId_vertical_hourBucket: { tenantId: 'swift-default', vertical: 'FOOD_DELIVERY', hourBucket: AGGREGATE_BUCKET } } });
    expect(overall.padSeconds).toBe(600);

    const p = await promiseAtCheckout(app.prisma, { tenantId: 'swift-default', orderType: 'FOOD_DELIVERY', vendorId, vendorType: 'RESTAURANT', declaredMinutes: 25, distanceKm: 2, itemCount: 1, placedAt: PLACED });
    expect(p.parts.padSource).toBe('HOUR');
    expect(p.padSeconds).toBe(600);
    // A grocery order in the same hour has no pad of its own yet: the default, and it says so.
    const g = await promiseAtCheckout(app.prisma, { tenantId: 'swift-default', orderType: 'GROCERY_DELIVERY', vendorId, vendorType: 'SUPERMARKET', declaredMinutes: 25, distanceKm: 2, itemCount: 1, placedAt: PLACED });
    expect(g.parts.padSource).toBe('DEFAULT');
    // Off-hours for food: the vertical overall.
    const off = await promiseAtCheckout(app.prisma, { tenantId: 'swift-default', orderType: 'FOOD_DELIVERY', vendorId, vendorType: 'RESTAURANT', declaredMinutes: 25, distanceKm: 2, itemCount: 1, placedAt: new Date('2026-08-27T23:00:00Z') });
    expect(off.parts.padSource).toBe('VERTICAL');
  });

  it('a revision happens only for a slip, and then out loud: the order, the row with the reason, the customer told with the new range', async () => {
    const promisedAt = new Date(Date.now() + 20 * 60_000);
    const order = await makeOrder({ status: 'EN_ROUTE_DELIVERY', placedAt: new Date(), promisedAt, promiseBaseSeconds: 900 });
    // Earlier than promised: nothing moves.
    expect((await revisePromise(deps(), { orderId: order.id, newPromisedAt: new Date(promisedAt.getTime() - 5 * 60_000), reason: 'x', source: 'OPS' })).revised).toBe(false);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).promiseRevisions).toBe(0);

    const later = new Date(promisedAt.getTime() + 12 * 60_000);
    const r = await revisePromise(deps(), { orderId: order.id, newPromisedAt: later, reason: 'the kitchen is running behind', source: 'VENDOR' });
    expect(r).toEqual({ revised: true, minutesLate: 12 });
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.promisedAt?.toISOString()).toBe(later.toISOString());
    expect(after.promiseRevisions).toBe(1);
    expect(after.promiseRevisionReason).toBe('the kitchen is running behind');
    expect(after.promiseRevisedAt).not.toBeNull();
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-12', subjectId: order.id } });
    expect(row?.outcome).toBe('REVISED');
    expect(row?.shadow).toBe(false);
    expect((row!.inputs as Record<string, unknown>)['reason']).toBe('the kitchen is running behind');
    expect(row!.sentence).toMatch(/^The promise moved 12 min later, to between .+ and .+: the kitchen is running behind\.$/);
    const notice = await app.prisma.notification.findFirst({ where: { userId: customerId, title: 'Running about 12 min late — sorry' } });
    expect(notice).not.toBeNull();
    expect(notice!.body).toMatch(/now arrives between .+ and .+\. We’ll keep you posted\.$/);
    expect((notice!.data as Record<string, unknown>)['orderId']).toBe(order.id);
    expect((notice!.data as Record<string, unknown>)['kind']).toBeUndefined(); // routes by orderId to the tracking screen
  });

  it('a live ETA past the promise by the threshold revises it once per gate window; a leg still heading to the store never does', async () => {
    const promisedAt = new Date(Date.now() + 10 * 60_000);
    const order = await makeOrder({ status: 'EN_ROUTE_DELIVERY', placedAt: new Date(), promisedAt, promiseBaseSeconds: 600 });
    // 3 min past: under the 5-min threshold.
    expect((await noteLiveEta(deps(), { orderId: order.id, status: 'EN_ROUTE_DELIVERY', etaMinutes: 13, basis: 'direct' })).revised).toBe(false);
    // The rider is still on the way to the STORE: that ETA is not to the customer.
    expect((await noteLiveEta(deps(), { orderId: order.id, status: 'RIDER_EN_ROUTE_PICKUP', etaMinutes: 40, basis: 'direct' })).revised).toBe(false);
    // A chained leg's ETA is the other delivery's problem first.
    expect((await noteLiveEta(deps(), { orderId: order.id, status: 'EN_ROUTE_DELIVERY', etaMinutes: 40, basis: 'after_current' })).revised).toBe(false);
    // 18 min past: revised, told.
    expect((await noteLiveEta(deps(), { orderId: order.id, status: 'EN_ROUTE_DELIVERY', etaMinutes: 28, basis: 'direct' })).revised).toBe(true);
    const once = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(once.promiseRevisions).toBe(1);
    expect(once.promiseRevisionReason).toMatch(/live ETA runs 18 min past the promise/);
    // Another slip inside the gate window: not again.
    expect((await noteLiveEta(deps(), { orderId: order.id, status: 'EN_ROUTE_DELIVERY', etaMinutes: 45, basis: 'direct' })).revised).toBe(false);
    expect(await app.redis.ttl(`eta:slip:${order.id}`)).toBeGreaterThan(SLIP_GATE_SECONDS - 60);
  });

  it('the weekly report measures what was kept, per vertical, and writes the founder\'s row', async () => {
    // The ten seeded deliveries were promised at base + 300; lateness ≤ 300 s kept the promise: 8 of 10.
    const report = await etaReport(app.prisma, 28, new Date('2026-08-30T12:00:00Z'));
    expect(report.delivered).toBe(10);
    expect(report.realisedOnTimeRate).toBe(0.8);
    expect(report.byVertical['FOOD_DELIVERY']).toEqual({ delivered: 10, onTimeRate: 0.8 });
    expect(report.target).toBe(0.85);
    expect(report.pads.length).toBeGreaterThanOrEqual(2);

    const weekly = await weeklyEtaCalibration(app.prisma, new Date('2026-08-30T12:00:00Z'));
    expect(weekly.learned.rows).toBeGreaterThanOrEqual(2);
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-12', subjectId: 'platform' }, orderBy: { createdAt: 'desc' } });
    expect(row).toMatchObject({ shadow: true, outcome: 'BELOW_TARGET' });
    expect(row!.sentence).toMatch(/^Over 28 days, 10 promises kept 80% of the time against a 85% target; 0% were revised out loud\.$/);

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/algo/eta/report?days=28', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.realisedOnTimeRate).toBe(0.8);
  });
});
