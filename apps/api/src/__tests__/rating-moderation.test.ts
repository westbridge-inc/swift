import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { RatingService } from '../modules/rating/rating.service';
import { maskPii, needsProfanityHold, processReviewText } from '../modules/rating/review-scrub';

// ---------------------------------------------------------------------------
// Movement R — RAT-F: the scrub pipeline (PII masked, profanity auto-held),
// report → uphold removes + re-levels + notifies, the S5 exclusion tool, and
// the at-risk FOUNDER queue (R-Law 3: a queue item, never a consequence).
// ---------------------------------------------------------------------------

const DAY = 24 * 3600_000;
let app: FastifyInstance;
let ratings: RatingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Mod', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'mod-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: u.id, token };
}

async function makeRatedOrder(comment: string, score = 2) {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Mod Vendor ${seq}`, slug: `mod-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Queue Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `MOD-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.userId, vendorId: vendor.id, status: 'DELIVERED',
      deliveryAddress: 'mod', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900,
      deliveryFee: 0, totalAmount: 900, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  const rating = await ratings.rate({
    orderId: order.id, raterId: customer.userId, vendorId: vendor.id,
    type: 'CUSTOMER_TO_VENDOR', score, comment,
  });
  return { vendor, customer, order, rating };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "ratings_one_per_context" ON "ratings"("orderId", "raterId", "type")`,
  );
  ratings = new RatingService(app.prisma);
});

afterAll(async () => {
  await app.prisma.ratingReport.deleteMany({ where: { reporterId: { in: createdUserIds } } });
  await app.prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: createdVendorIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the scrub pipeline (pure)', () => {
  it('masks phones, emails and URLs; publication never blocks on masking', () => {
    expect(maskPii('Call me on +592 600 1234 for a deal')).toBe('Call me on [number removed] for a deal');
    expect(maskPii('email me: chef@example.com or visit https://cheap.example')).toBe('email me: [email removed] or visit [link removed]');
    expect(maskPii('Great roti, 10/10 would order again')).toBe('Great roti, 10/10 would order again');
    // edge 9: a review that is 100% phone number masks to nothing meaningful and still publishes
    // Adjacent numbers may collapse into one mask token (the pattern spans spaces so
    // "592 600 1234" can't leak) — the invariant is that no digits survive.
    const allPhones = maskPii('6001234 592-600-1234');
    expect(allPhones).toContain('[number removed]');
    expect(allPhones).not.toMatch(/\d/);
  });

  it('profanity holds — seeded en + local terms, whole-word, case-blind', () => {
    expect(needsProfanityHold('The food was SHIT')).toBe(true);
    expect(needsProfanityHold('real skunt behaviour')).toBe(true);
    expect(needsProfanityHold('the shipment arrived')).toBe(false); // no substring hits
    expect(processReviewText('Lovely bake and saltfish').hold).toBe(false);
  });
});

describe('RAT-F: hold, report, uphold, at-risk', () => {
  it('a profane review is stored MASKED + HELD (stars still count); admin publish clears it', async () => {
    const admin = await makeUser(['ADMIN'], 'ADMIN');
    const { rating, vendor } = await makeRatedOrder('shit service, call +592 600 9999', 1);

    const stored = await app.prisma.rating.findUniqueOrThrow({ where: { id: rating.id } });
    expect(stored.comment).toContain('[number removed]');
    expect(stored.isPublic).toBe(false);
    expect(stored.flagReason).toBe('PROFANITY_HOLD');
    // Stars counted despite the hold:
    const stat = await app.prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(stat.lifetimeCount).toBe(1);

    // The queue lists it; publish clears the hold.
    const q = await app.inject({ method: 'GET', url: '/api/v1/admin/ratings/moderation', headers: { authorization: `Bearer ${admin.token}` } });
    expect((q.json().data.held as Array<{ id: string }>).map((h) => h.id)).toContain(rating.id);
    const pub = await app.inject({
      method: 'POST', url: `/api/v1/admin/ratings/${rating.id}/moderate`,
      headers: { authorization: `Bearer ${admin.token}` }, payload: { action: 'publish' },
    });
    expect(pub.statusCode).toBe(200);
    expect((await app.prisma.rating.findUniqueOrThrow({ where: { id: rating.id } })).isPublic).toBe(true);
  });

  it('report → uphold removes the review, re-levels the subject, notifies the rater; audit rows exist', async () => {
    const admin = await makeUser(['ADMIN'], 'ADMIN');
    const { rating, customer, vendor } = await makeRatedOrder('mediocre at best', 1);
    const reporter = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const report = await app.prisma.ratingReport.create({
      data: { ratingId: rating.id, reporterId: reporter.userId, reason: 'FALSE_CLAIM' },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/rating-reports/${report.id}/resolve`,
      headers: { authorization: `Bearer ${admin.token}` }, payload: { action: 'uphold' },
    });
    expect(res.statusCode).toBe(200);

    const removed = await app.prisma.rating.findUniqueOrThrow({ where: { id: rating.id } });
    expect(removed.state).toBe('REMOVED');
    expect(removed.isPublic).toBe(false);
    // Re-leveled: the 1★ no longer counts.
    const stat = await app.prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(stat.lifetimeCount).toBe(0);
    // Rater told, with the reason category.
    const note = await app.prisma.notification.findFirst({ where: { userId: customer.userId }, orderBy: { createdAt: 'desc' } });
    expect(note?.title).toContain('removed');
    // Double-resolve refuses.
    const again = await app.inject({
      method: 'POST', url: `/api/v1/admin/rating-reports/${report.id}/resolve`,
      headers: { authorization: `Bearer ${admin.token}` }, payload: { action: 'dismiss' },
    });
    expect(again.statusCode).toBe(400);
  });

  it('the at-risk queue lists AT_RISK stats — and nothing else happens to the actor (R-Law 3)', async () => {
    const admin = await makeUser(['ADMIN'], 'ADMIN');
    const vendor = (await makeRatedOrder('fine', 5)).vendor;
    // Force an AT_RISK stat directly (band math is unit-proven elsewhere).
    await app.prisma.actorRatingStat.update({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
      data: { standing: 'AT_RISK', rollingCount: 30, rollingSum: 100, lifetimeCount: 30, lifetimeSum: 100 },
    });
    const q = await app.inject({ method: 'GET', url: '/api/v1/admin/ratings/at-risk', headers: { authorization: `Bearer ${admin.token}` } });
    expect((q.json().data as Array<{ subjectId: string }>).map((r) => r.subjectId)).toContain(vendor.id);
    // R-Law 3: the vendor row itself is untouched — still ACTIVE, still operating.
    const v = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(v.status).toBe('ACTIVE'); // AT_RISK is a founder queue, never an automatic enforcement
  });
});
