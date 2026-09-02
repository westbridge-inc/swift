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
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { dispatchTrigger, requestedDispatchTrigger, _resetPredictiveWarning } from '../modules/dispatch/dispatch-trigger';
import {
  bucketOf, percentile, splitOutliers, summarise, computePrepStats, predictReady, shadowPredictAtAccept,
  prepShadowReport, gradeShadow, verticalKey, AGGREGATE_BUCKET, DEFAULT_PREP_SECONDS, MIN_GRADED, OUTLIER_FLOOR_SECONDS,
} from '../modules/prep/prep-time';

// ---------------------------------------------------------------------------
// [ALG-03 / FMC-01 Movement 12] The prep-time learner, shadow only.
//
// Graded: buckets are Guyana time; percentiles are nearest-rank; an
// unattended order is counted and never averaged in; the fallback tiers are
// real learned numbers in the documented order and the last two are honest
// about having no distribution; live load and basket size adjust; the shadow
// row rides the ONE accept seam; the grade reports median error and p80
// coverage and cannot pass on a handful of samples; PREDICTIVE resolves to
// ON_ACCEPT out loud until a person promotes it.
// ---------------------------------------------------------------------------

describe('the pure pieces', () => {
  it('a bucket is the day-of-week and hour in America/Guyana (UTC−4), never the server clock', () => {
    // 03:30Z Sunday 30 Aug 2026 is 23:30 SATURDAY in Georgetown.
    expect(bucketOf(new Date('2026-08-30T03:30:00Z'))).toEqual({ dayOfWeek: 6, hourBucket: 23 });
    // 04:30Z is 00:30 Sunday.
    expect(bucketOf(new Date('2026-08-30T04:30:00Z'))).toEqual({ dayOfWeek: 0, hourBucket: 0 });
    // Monday noon local.
    expect(bucketOf(new Date('2026-08-31T16:05:00Z'))).toEqual({ dayOfWeek: 1, hourBucket: 12 });
  });

  it('nearest-rank percentiles', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile(ten, 0.8)).toBe(8);
    expect(percentile(ten, 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.5)).toBe(7);
  });

  it('an unattended order is an outlier — counted, never averaged in (R-12.1.2)', () => {
    const tenMinutes = Array.from({ length: 10 }, () => 600);
    // 4× the median is 40 min, the floor is 90 min: 50 min stays, 4 h goes.
    expect(splitOutliers([...tenMinutes, 3000]).outliers).toEqual([]);
    expect(splitOutliers([...tenMinutes, 4 * 3600]).outliers).toEqual([4 * 3600]);
    expect(splitOutliers([0, -5, 600]).kept).toEqual([600]);
    const s = summarise([...tenMinutes.map((x) => ({ seconds: x, items: 2 })), { seconds: 4 * 3600, items: 9 }]);
    expect(s).toMatchObject({ n: 10, outliers: 1, p50: 600, p80: 600, medianItems: 2 });
    expect(OUTLIER_FLOOR_SECONDS).toBe(90 * 60);
  });

  it('the dials ship at the documented values', () => {
    expect(ALGO_DEFAULTS['prep.minBucketSamples']).toBe(20);
    expect(ALGO_DEFAULTS['prep.minVendorSamples']).toBe(8);
    expect(ALGO_DEFAULTS['prep.gateMaeMinutes']).toBe(4);
    expect(ALGO_DEFAULTS['prep.gateCoverage']).toBe(0.8);
    expect(MIN_GRADED).toBe(30);
    expect(DEFAULT_PREP_SECONDS).toBe(30 * 60);
  });
});

describe('PREDICTIVE dispatch resolves honestly until the learner is promoted', () => {
  it('ON_ACCEPT, out loud, while the request is remembered', () => {
    const before = process.env['DISPATCH_TRIGGER'];
    _resetPredictiveWarning();
    process.env['DISPATCH_TRIGGER'] = 'PREDICTIVE';
    expect(requestedDispatchTrigger()).toBe('PREDICTIVE');
    expect(dispatchTrigger()).toBe('ON_ACCEPT');
    process.env['DISPATCH_TRIGGER'] = 'ON_READY';
    expect(dispatchTrigger()).toBe('ON_READY');
    if (before === undefined) delete process.env['DISPATCH_TRIGGER'];
    else process.env['DISPATCH_TRIGGER'] = before;
  });

  it('the shadow prediction rides the ONE accept seam in order.service', () => {
    const src = readFileSync(path.join(__dirname, '..', 'modules', 'order', 'order.service.ts'), 'utf8');
    const accepted = src.slice(src.indexOf("      case 'ACCEPTED':"), src.indexOf("      case 'PREPARING':"));
    expect(accepted).toContain('void shadowPredictAtAccept(this.prisma, orderId);');
  });
});

describe('learn → predict → shadow → grade, against the database', () => {
  const PHONE_PREFIX = '+59200666';
  const DAY = 24 * 60 * 60 * 1000;
  // Monday 12:xx Georgetown = 16:xx Z. Every learned sample sits in this bucket.
  const MONDAY_NOON_Z = new Date('2026-08-24T16:10:00Z');
  let app: FastifyInstance;
  let customerId: string;
  let adminToken: string;
  const vendorIds: string[] = [];
  let seq = 0;

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const vendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: vos.map((v) => v.id) } }, select: { id: true } });
    const orders = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-03', subjectId: { in: [...orders.map((o) => o.id), 'platform'] } } });
    await app.prisma.vendorPrepStat.deleteMany({ where: { OR: [{ vendorId: { in: vendors.map((v) => v.id) } }, { vendorId: { startsWith: 'vertical:' } }] } });
    await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendors.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  async function makeVendor(vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'SERVICE', estimatedPrepTime: number) {
    seq += 1;
    const owner = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Prep', lastName: `Owner${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
    });
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: `Prep Vendor ${seq}`, slug: `prep-vendor-${nanoid(6)}`, vendorType, phone: `${PHONE_PREFIX}9${seq}`,
        addressLine1: '1 Prep St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE', acceptingOrders: true, isVerified: true, estimatedPrepTime,
      },
    });
    vendorIds.push(vendor.id);
    return vendor.id;
  }

  async function makeOrder(opts: { vendorId: string; status: string; acceptedAt?: Date | null; readyAt?: Date | null; items?: number }) {
    return app.prisma.order.create({
      data: {
        orderNumber: `PREP-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId: opts.vendorId, status: opts.status as any,
        fulfillment: 'DELIVERY', pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
        acceptedAt: opts.acceptedAt ?? null, readyAt: opts.readyAt ?? null,
        ...(opts.items ? { items: { create: { itemId: `dish-${nanoid(6)}`, name: 'Dish', quantity: opts.items, basePrice: 1000, markedUpPrice: 1000, markupAmount: 0, totalBase: 1000 * opts.items, totalMarkup: 0, totalCustomer: 1000 * opts.items } } } : {}),
      },
    });
  }

  /** `n` completed orders for `vendorId`, accepted in the Monday-noon bucket, each ready after `prepSeconds[i]`. */
  async function seedCompleted(vendorId: string, prepSeconds: number[], at = MONDAY_NOON_Z) {
    for (const s of prepSeconds) {
      await makeOrder({ vendorId, status: 'DELIVERED', acceptedAt: at, readyAt: new Date(at.getTime() + s * 1000) });
    }
  }

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });

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
    const customer = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}00`, firstName: 'Prep', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() },
    });
    customerId = customer.id;
    const admin = await app.prisma.user.create({
      data: { phone: `${PHONE_PREFIX}98`, firstName: 'Prep', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } } },
    });
    adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: admin.id, token: adminToken, refreshToken: nanoid(40), deviceId: 'prep', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  });

  afterAll(async () => {
    await purge();
    await app.close();
  });

  let busy: string;      // 25 samples in the Monday-noon bucket: ~10 min prep, one 4 h outlier
  let quiet: string;     // 3 samples: below every learned threshold
  let declared: string;  // nothing learned, declares 45 min
  let silent: string;    // nothing learned, declares nothing (0)

  it('learns per bucket, per vendor and per vertical from the same samples; counts the outlier; prunes what the window no longer holds', async () => {
    busy = await makeVendor('RESTAURANT', 25);
    quiet = await makeVendor('RESTAURANT', 20);
    declared = await makeVendor('SERVICE', 45);
    silent = await makeVendor('SUPERMARKET', 0);
    await seedCompleted(busy, [...Array.from({ length: 25 }, (_, i) => 540 + i * 5), 4 * 3600]);
    await seedCompleted(quiet, [900, 960, 1020]);
    // The learner runs at a FROZEN clock, so the stale row must be stale
    // relative to THAT clock, not the wall clock: pruning deletes rows whose
    // lastComputedAt precedes the run's start, and a row stamped from
    // Date.now() is newer than a frozen past `now` from the day after the
    // test was written — it survived every prune and the assertion below
    // went red on its own, one day later. Same frozen instant, minus two days.
    const now = new Date('2026-08-30T12:00:00Z');
    // A stale row from a previous window that no sample supports any more.
    await app.prisma.vendorPrepStat.create({
      data: { vendorId: busy, dayOfWeek: 3, hourBucket: 9, sampleCount: 40, p50Seconds: 1, p80Seconds: 1, p95Seconds: 1, lastComputedAt: new Date(now.getTime() - 2 * DAY) },
    });

    const r = await computePrepStats(app.prisma, now);
    expect(r.orders).toBeGreaterThanOrEqual(29);
    expect(r.pruned).toBeGreaterThanOrEqual(1);

    const bucket = await app.prisma.vendorPrepStat.findUniqueOrThrow({ where: { tenantId_vendorId_dayOfWeek_hourBucket: { tenantId: 'swift-default', vendorId: busy, dayOfWeek: 1, hourBucket: 12 } } });
    expect(bucket).toMatchObject({ scope: 'BUCKET', sampleCount: 25, outlierCount: 1 });
    expect(bucket.p50Seconds).toBeGreaterThanOrEqual(600);
    expect(bucket.p50Seconds).toBeLessThan(660);
    expect(bucket.p80Seconds).toBeGreaterThan(bucket.p50Seconds);
    const vendorAll = await app.prisma.vendorPrepStat.findUniqueOrThrow({ where: { tenantId_vendorId_dayOfWeek_hourBucket: { tenantId: 'swift-default', vendorId: busy, dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET } } });
    expect(vendorAll).toMatchObject({ scope: 'VENDOR', sampleCount: 25 });
    const vertical = await app.prisma.vendorPrepStat.findUniqueOrThrow({ where: { tenantId_vendorId_dayOfWeek_hourBucket: { tenantId: 'swift-default', vendorId: verticalKey('RESTAURANT'), dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET } } });
    expect(vertical.scope).toBe('VERTICAL');
    expect(vertical.sampleCount).toBeGreaterThanOrEqual(28);
    expect(await app.prisma.vendorPrepStat.findFirst({ where: { vendorId: busy, dayOfWeek: 3, hourBucket: 9 } })).toBeNull();
  });

  it('predicts from the documented tiers, in order, and says which one', async () => {
    const inBucket = await predictReady(app.prisma, { vendorId: busy, vendorType: 'RESTAURANT', declaredMinutes: 25, at: MONDAY_NOON_Z, itemCount: 1 });
    expect(inBucket.tier).toBe('BUCKET');
    expect(inBucket.sampleCount).toBe(25);
    expect(inBucket.p80Seconds).toBeGreaterThan(inBucket.p50Seconds);

    // Same vendor, a Thursday evening nobody has data for: the vendor overall.
    const offHours = await predictReady(app.prisma, { vendorId: busy, vendorType: 'RESTAURANT', declaredMinutes: 25, at: new Date('2026-08-27T23:00:00Z'), itemCount: 1 });
    expect(offHours.tier).toBe('VENDOR');
    const vendorRow = await app.prisma.vendorPrepStat.findUniqueOrThrow({ where: { tenantId_vendorId_dayOfWeek_hourBucket: { tenantId: 'swift-default', vendorId: busy, dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET } } });
    expect(offHours.baseP50Seconds).toBe(vendorRow.p50Seconds); // the label AND the numbers are that row's

    // Three samples is below the vendor threshold: the vertical speaks.
    const thin = await predictReady(app.prisma, { vendorId: quiet, vendorType: 'RESTAURANT', declaredMinutes: 20, at: MONDAY_NOON_Z, itemCount: 1 });
    expect(thin.tier).toBe('VERTICAL');
    const verticalRow = await app.prisma.vendorPrepStat.findUniqueOrThrow({ where: { tenantId_vendorId_dayOfWeek_hourBucket: { tenantId: 'swift-default', vendorId: verticalKey('RESTAURANT'), dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET } } });
    expect(thin.baseP50Seconds).toBe(verticalRow.p50Seconds);
    expect(verticalRow.p50Seconds).not.toBe(vendorRow.p50Seconds); // the two tiers are distinguishable by their numbers

    // Nothing learned for SERVICE: the vendor's own word, with an honest p80.
    const word = await predictReady(app.prisma, { vendorId: declared, vendorType: 'SERVICE', declaredMinutes: 45, at: MONDAY_NOON_Z, itemCount: 1 });
    expect(word).toMatchObject({ tier: 'DECLARED', p50Seconds: 45 * 60, p80Seconds: Math.round(45 * 60 * 1.25), sampleCount: 0, basketSeconds: 0 });

    // Nothing at all: the platform default, and it says so.
    const none = await predictReady(app.prisma, { vendorId: silent, vendorType: 'SUPERMARKET', declaredMinutes: null, at: MONDAY_NOON_Z, itemCount: 1 });
    expect(none).toMatchObject({ tier: 'DEFAULT', p50Seconds: DEFAULT_PREP_SECONDS });
  });

  it('a bigger basket and a busy kitchen push the estimate out — by the dials, from a learned base only', async () => {
    const base = await predictReady(app.prisma, { vendorId: busy, vendorType: 'RESTAURANT', declaredMinutes: 25, at: MONDAY_NOON_Z, itemCount: 1 });
    const big = await predictReady(app.prisma, { vendorId: busy, vendorType: 'RESTAURANT', declaredMinutes: 25, at: MONDAY_NOON_Z, itemCount: 4 });
    expect(big.basketSeconds).toBe(3 * ALGO_DEFAULTS['prep.perItemSeconds']);
    expect(big.p50Seconds - base.p50Seconds).toBe(big.basketSeconds);

    const a = await makeOrder({ vendorId: busy, status: 'ACCEPTED', acceptedAt: new Date() });
    const b = await makeOrder({ vendorId: busy, status: 'PREPARING', acceptedAt: new Date() });
    const loaded = await predictReady(app.prisma, { vendorId: busy, vendorType: 'RESTAURANT', declaredMinutes: 25, at: MONDAY_NOON_Z, itemCount: 1, excludeOrderId: a.id });
    expect(loaded.liveLoad).toBe(1); // b only — a is the order being predicted
    expect(loaded.loadSeconds).toBe(ALGO_DEFAULTS['prep.queueSeconds']);
    await app.prisma.order.deleteMany({ where: { id: { in: [a.id, b.id] } } });

    // A declared tier carries no median basket, so no basket adjustment is invented for it.
    const word = await predictReady(app.prisma, { vendorId: declared, vendorType: 'SERVICE', declaredMinutes: 45, at: MONDAY_NOON_Z, itemCount: 6 });
    expect(word.basketSeconds).toBe(0);
  });

  it('the shadow row beside an accept carries the prediction and the sentence — and changes nothing about the order', async () => {
    const order = await makeOrder({ vendorId: busy, status: 'ACCEPTED', acceptedAt: MONDAY_NOON_Z, items: 2 });
    const before = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    await shadowPredictAtAccept(app.prisma, order.id);
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-03', subjectId: order.id } });
    expect(row).toMatchObject({ shadow: true, outcome: 'PREDICTED', subjectType: 'ORDER' });
    const inputs = row!.inputs as Record<string, unknown>;
    expect(inputs['tier']).toBe('BUCKET');
    expect(inputs['itemCount']).toBe(2);
    expect(inputs['acceptedAt']).toBe(MONDAY_NOON_Z.toISOString());
    expect(row!.sentence).toMatch(/^Ready in about \d+ min, \d+ at the outside — from this vendor at this hour \(25 samples\), \d+ already in the kitchen\.$/);
    expect(row!.sentence.length).toBeLessThanOrEqual(240);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toEqual(before);
    // A taxi never gets one.
    const taxi = await app.prisma.order.create({ data: { ...({} as object), orderNumber: `PREP-T-${nanoid(6)}`, orderType: 'TAXI', customerId, vendorId: busy, status: 'ACCEPTED', fulfillment: 'DELIVERY', pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16, subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0, totalAmount: 0, paymentMethod: 'CASH', acceptedAt: MONDAY_NOON_Z } });
    await shadowPredictAtAccept(app.prisma, taxi.id);
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-03', subjectId: taxi.id } })).toBe(0);
  });

  it('the grade measures median error and p80 coverage against what happened, per tier, and cannot pass on a handful', async () => {
    // Three predictions of 600s/800s: actual 660 (1 min off, inside p80), 720 (2 min, inside), 1500 (15 min, outside).
    const actuals = [660, 720, 1500];
    for (const actual of actuals) {
      const o = await makeOrder({ vendorId: busy, status: 'DELIVERED', acceptedAt: MONDAY_NOON_Z, readyAt: new Date(MONDAY_NOON_Z.getTime() + actual * 1000) });
      await app.prisma.algoDecision.create({
        data: { algo: 'ALG-03', subjectType: 'ORDER', subjectId: o.id, outcome: 'PREDICTED', shadow: true, sentence: 'seed', inputs: { p50Seconds: 600, p80Seconds: 800, tier: 'BUCKET', acceptedAt: MONDAY_NOON_Z.toISOString() } },
      });
    }
    // The shadow row from the previous test has no readyAt yet: predicted, not graded.
    const report = await prepShadowReport(app.prisma, 14);
    expect(report.graded).toBe(3);
    expect(report.predicted).toBeGreaterThanOrEqual(4);
    expect(report.medianAbsErrorMinutes).toBe(2);
    expect(report.p80Coverage).toBe(0.67);
    expect(report.byTier['BUCKET']).toMatchObject({ graded: 3, medianAbsErrorMinutes: 2 });
    expect(report.gate).toMatchObject({ maeMinutes: 4, coverage: 0.8, minGraded: MIN_GRADED, maeOk: true, coverageOk: false, enoughGraded: false, passes: false });

    const graded = await gradeShadow(app.prisma);
    expect(graded.gate.passes).toBe(false);
    const gateRow = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-03', subjectId: 'platform' }, orderBy: { createdAt: 'desc' } });
    expect(gateRow).toMatchObject({ shadow: true, outcome: 'GATE_NOT_YET' });
    expect(gateRow!.sentence).toMatch(/^Over 14 days, 3 graded predictions: median error 2 min, p80 covered 67% — gate not yet \(≤ 4 min, ≥ 80%, n ≥ 30\)\.$/);
  });

  it('the admin reads the report and the learner\'s footprint', async () => {
    const res = await get('/api/v1/admin/algo/prep-time/shadow-report?days=14');
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.graded).toBe(3);
    expect(data.gate.passes).toBe(false);
    expect(data.stats.buckets).toBeGreaterThanOrEqual(1);
    expect(data.stats.verticals).toBeGreaterThanOrEqual(1);
    expect(typeof data.stats.lastComputedAt).toBe('string');
  });
});
