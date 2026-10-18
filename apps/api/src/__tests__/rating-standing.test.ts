import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { RatingService } from '../modules/rating/rating.service';
import { RatingStatsService } from '../modules/rating/rating-stats.service';
import { seedRatingTags } from '../modules/rating/tag-taxonomy.seed';
import { actorStandingView, runActorFold } from '../modules/rating/rating-standing';
import { clearShownRatingCache } from '../modules/rating/rating-groups';
import { displayRating } from '../modules/rating/rating-math';
import { withSuiteCapability } from '../lib/test-target-lock';

// ---------------------------------------------------------------------------
// Movement R — R9: the Standing view. THE law here is RAT-G: everything the
// actor sees is daily-folded — a rating written today is INVISIBLE actor-side
// until the fold stamps it in, while the public surface moves immediately.
// Plus: coaching card appears only at ATTENTION/AT_RISK with the exact line,
// the vendor endpoint serves it, and the item-thumbs Pareto ranks the 👎.
// ---------------------------------------------------------------------------

const DAY = 24 * 3600_000;
let app: FastifyInstance;
let ratings: RatingService;
let stats: RatingStatsService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_750_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Stand', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'stand-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: u.id, token };
}

async function makeVendorWithOwner() {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Stand Vendor ${seq}`, slug: `stand-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Standing Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return { owner, vendor };
}

async function makeOrder(customerId: string, vendorId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `STD-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId, vendorId, status: 'DELIVERED',
      deliveryAddress: 'std', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900,
      deliveryFee: 0, totalAmount: 900, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  ratings = new RatingService(app.prisma);
  stats = new RatingStatsService(app.prisma);
  await seedRatingTags(app.prisma);
}, 30_000);

afterAll(async () => {
  await app.prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: [...createdVendorIds, ...createdUserIds] } } });
  await app.prisma.itemFeedback.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('RAT-G — the daily fold', () => {
  it('a rating written today is public immediately but actor-invisible until the fold', async () => {
    const { owner, vendor } = await makeVendorWithOwner();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    // Yesterday's history: two 5★ with a positive tag (inserted with explicit
    // createdAt, then recomputed into the stat like the engine would).
    for (let i = 0; i < 2; i++) {
      const o = await makeOrder(customer.userId, vendor.id);
      await app.prisma.rating.create({
        data: {
          orderId: o.id, raterId: customer.userId, vendorId: vendor.id,
          type: 'CUSTOMER_TO_VENDOR', score: 5, tags: ['tasty-food'],
          createdAt: new Date(Date.now() - DAY),
        },
      });
    }
    await stats.recompute({ role: 'VENDOR', id: vendor.id });

    // Today's fresh rating goes through the live path (stats update instantly).
    const o3 = await makeOrder(customer.userId, vendor.id);
    await ratings.rate({
      orderId: o3.id, raterId: customer.userId, vendorId: vendor.id,
      type: 'CUSTOMER_TO_VENDOR', score: 1, tags: ['long-wait'],
    });

    // PUBLIC surface counts all three at once…
    const pub = await app.inject({
      method: 'GET', url: `/api/v1/customer/vendors/${vendor.id}`,
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(pub.json().data.ratingCount).toBe(3);

    // …but the ACTOR view is folded: 2 rows, average 5, and NO trace of the
    // 1★ or its tag — this morning's customer cannot be identified.
    const before = await app.inject({
      method: 'GET', url: '/api/v1/vendor/standing',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(before.statusCode).toBe(200);
    const bd = before.json().data;
    expect(bd.folded).toEqual({ count: 2, average: 5 });
    expect(bd.topNegative).toEqual([]);
    expect(bd.topPositive[0]).toMatchObject({ tag: 'tasty-food', count: 2 });
    expect(bd.trend).toHaveLength(13);
    expect(bd.trend.reduce((s: number, w: { count: number }) => s + w.count, 0)).toBe(2);

    // The fold stamps everyone; now the actor view advances.
    // This scheduled operation is deliberately global. The test guard still
    // refuses it until this one invocation receives the explicit capability.
    await expect(runActorFold(app.prisma)).rejects.toMatchObject({ code: 'UNSCOPED_MUTATION_REFUSED' });
    const stamped = await withSuiteCapability('unscoped-mutation', () => runActorFold(app.prisma));
    expect(stamped).toBeGreaterThan(0);
    const after = await app.inject({
      method: 'GET', url: '/api/v1/vendor/standing',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const ad = after.json().data;
    expect(ad.folded.count).toBe(3);
    expect(ad.topNegative[0]).toMatchObject({ tag: 'long-wait', count: 1 });
  });
});

/** Final ratings (past the 7-day edit window) a person received, given in order from `daysAgo`. */
async function rated(rateeId: string, type: 'CUSTOMER_TO_RIDER' | 'RIDER_TO_CUSTOMER', scores: Array<number | [number, string[]]>, daysAgo: number) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const { vendor } = await makeVendorWithOwner();
  for (const [i, entry] of scores.entries()) {
    const [score, tags] = Array.isArray(entry) ? entry : [entry, []];
    const o = await makeOrder(customer.userId, vendor.id);
    const createdAt = new Date(Date.now() - daysAgo * DAY + i * 60_000);
    await app.prisma.rating.create({ data: {
      orderId: o.id, raterId: customer.userId, rateeId, type, score, tags, createdAt, editableUntil: new Date(createdAt.getTime() + 7 * DAY),
    } });
  }
}

describe('coaching card (RAT-D)', () => {
  // TRANSFORMED (COORD 18 Oct, option S): was 3 ratings + a hand-set stat band. A person's band is now computed from
  // whole groups of 5 final ratings (the stat row no longer decides what the mover sees), so the band is reached with
  // real ratings: 20 at a 4.25 mean = ATTENTION, then 10 more 5s = a 4.5 mean = GOOD. Same assertions on the card.
  it('appears only at ATTENTION/AT_RISK, with the exact line per negative tag', async () => {
    const rider = await makeUser(['MOVER'], 'MOVER');
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', [...Array(15).fill(5), ...Array(5).fill([2, ['late']])], 30);
    const view = await actorStandingView(app.prisma, 'RIDER', rider.userId);
    expect(view.standing).toBe('ATTENTION');
    expect(view.coaching).toHaveLength(1);
    expect(view.coaching[0]).toEqual({
      tag: 'late', label: 'Late',
      line: 'Mark yourself arrived as soon as you reach — customers rate the wait, not the ride.',
    });

    // Back to GOOD → the card disappears (no nagging healthy actors).
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', Array(10).fill(5), 20);
    const healthy = await actorStandingView(app.prisma, 'RIDER', rider.userId);
    expect(healthy.standing).toBe('GOOD');
    expect(healthy.coaching).toEqual([]);
  });
});

describe('[COORD 18 Oct, option S] a person sees only whole groups of 5 ratings', () => {
  it('a rider view is built from whole groups of final ratings: figures, trend bars and tags', async () => {
    const rider = await makeUser(['MOVER'], 'MOVER');
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', [5, 1, [4, ['late']], 2, 3, [5, ['late']], 5], 20);
    const view = await actorStandingView(app.prisma, 'RIDER', rider.userId);
    expect(view.groupSize).toBe(5);
    expect(view.folded).toEqual({ count: 5, average: 3 });
    expect(view.trend).toEqual([{ weekStart: new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10), average: 3, count: 5 }]);
    expect({ ratingCount: view.ratingCount, displayRating: view.displayRating, ratingBucket: view.ratingBucket })
      .toEqual({ ratingCount: 5, displayRating: displayRating(5, 15), ratingBucket: '(5)' });
    expect(view.topNegative).toEqual([{ tag: 'late', label: 'Late', count: 1 }]); // the 6th rating's tag is not in a whole group
  });

  it('the difference attack finds nothing: one more rating leaves the view identical; the fifth adds a whole group', async () => {
    const rider = await makeUser(['MOVER'], 'MOVER');
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', [4, 4, 4, 4, 4], 30);
    const before = await actorStandingView(app.prisma, 'RIDER', rider.userId);
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', [[1, ['rude']]], 25); // one passenger's 1 star
    expect(await actorStandingView(app.prisma, 'RIDER', rider.userId)).toEqual(before);
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', [5, 5, 5, 5], 24);
    const after = await actorStandingView(app.prisma, 'RIDER', rider.userId);
    expect(after.trend).toEqual([before.trend[0], { weekStart: new Date(Date.now() - 25 * DAY).toISOString().slice(0, 10), average: 4.2, count: 5 }]);
    expect(after.folded).toEqual({ count: 10, average: 4.1 });
  });

  it('a rating still open to editing is not shown yet', async () => {
    const rider = await makeUser(['MOVER'], 'MOVER');
    await rated(rider.userId, 'CUSTOMER_TO_RIDER', [5, 5, 5, 5, 5], 3); // within the 7-day edit window
    const view = await actorStandingView(app.prisma, 'RIDER', rider.userId);
    expect(view.folded).toEqual({ count: 0, average: null });
    expect(view.trend).toEqual([]);
  });

  it('a customer sees their own star from whole groups only', async () => {
    clearShownRatingCache();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    // An excluded rating (the oldest) never counts: counted, the first group would be 1,5,5,5,5.
    const { vendor } = await makeVendorWithOwner();
    const o0 = await makeOrder(customer.userId, vendor.id);
    await app.prisma.rating.create({ data: { orderId: o0.id, raterId: customer.userId, rateeId: customer.userId, type: 'RIDER_TO_CUSTOMER', score: 1, state: 'EXCLUDED', createdAt: new Date(Date.now() - 40 * DAY), editableUntil: new Date(Date.now() - 33 * DAY) } });
    await rated(customer.userId, 'RIDER_TO_CUSTOMER', [5, 5, 5, 5, 5, 1], 20);
    const res = await app.inject({ method: 'GET', url: '/api/v1/customer/rating', headers: { authorization: `Bearer ${customer.token}` } });
    expect(res.json().data).toEqual({ displayRating: displayRating(5, 25), ratingBucket: '(5)', ratingCount: 5, topRated: false });
  });
});

describe('customer aggregate + item-thumbs Pareto', () => {
  it('GET /customer/rating returns the aggregate face only', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await app.inject({
      method: 'GET', url: '/api/v1/customer/rating',
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ displayRating: null, ratingBucket: '(0)', ratingCount: 0, topRated: false });
  });

  it('GET /vendor/analytics/item-feedback ranks by 👎 (30 days)', async () => {
    const { owner, vendor } = await makeVendorWithOwner();
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains' } });
    const bad = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Fried rice', basePrice: 900 } });
    const fine = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Cook-up', basePrice: 900 } });
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const o = await makeOrder(customer.userId, vendor.id);
    const o2 = await makeOrder(customer.userId, vendor.id);
    await app.prisma.itemFeedback.createMany({
      data: [
        { orderId: o.id, itemId: bad.id, raterUserId: customer.userId, verdict: 'DOWN' },
        { orderId: o2.id, itemId: bad.id, raterUserId: customer.userId, verdict: 'DOWN' },
        { orderId: o.id, itemId: fine.id, raterUserId: customer.userId, verdict: 'UP' },
      ],
    });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/analytics/item-feedback',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ name: string; up: number; down: number }>;
    expect(rows[0]).toMatchObject({ name: 'Fried rice', down: 2, up: 0 });
    expect(rows.find((r) => r.name === 'Cook-up')).toMatchObject({ down: 0, up: 1 });
  });
});
