import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { RatingService } from '../modules/rating/rating.service';
import { RatingStatsService } from '../modules/rating/rating-stats.service';
import { seedRatingTags } from '../modules/rating/tag-taxonomy.seed';
import { displayRating } from '../modules/rating/rating-math';

// ---------------------------------------------------------------------------
// Movement R — RAT-E (shields move aggregates; excluded rows are kept but
// never counted; S1 fires at birth on a breached kitchen) and RAT-H (the
// reconciliation law: incremental === nightly recompute === direct SQL).
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});
const ratings = new RatingService(prisma);
const stats = new RatingStatsService(prisma);

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_740_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: string[]) {
  seq += 1;
  const u = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Rat', lastName: `U${seq}`,
      roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  return u;
}

async function makeVendor() {
  const owner = await makeUser(['VENDOR_OWNER']);
  const vo = await prisma.vendorOwner.upsert({ where: { userId: owner.id }, create: { userId: owner.id }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Rat Vendor ${seq}`, slug: `rat-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Star Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function makeDeliveredOrder(customerId: string, vendorId: string, over: { acceptedAt?: Date; readyAt?: Date; estimatedPrepTime?: number } = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `RAT-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId, vendorId, status: 'DELIVERED',
      deliveryAddress: 'stars', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      estimatedPrepTime: over.estimatedPrepTime ?? 20,
      acceptedAt: over.acceptedAt ?? null,
      readyAt: over.readyAt ?? null,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  await prisma.$connect();
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "ratings_one_per_context" ON "ratings"("orderId", "raterId", "type")`,
  );
  await seedRatingTags(prisma);
});

afterAll(async () => {
  await prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: [...createdVendorIds, ...createdUserIds] } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe('RAT-H: incremental === recompute === direct SQL', () => {
  it('a scripted run of ratings lands one value three ways', async () => {
    const vendor = await makeVendor();
    const scores = [5, 5, 5, 5, 4, 3, 5, 2, 5, 5]; // 10 ratings, Σ=44
    for (const score of scores) {
      const customer = await makeUser(['CUSTOMER']);
      const order = await makeDeliveredOrder(customer.id, vendor.id);
      await ratings.rate({ orderId: order.id, raterId: customer.id, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score });
    }

    // Leg 1: the incremental path already wrote the stat.
    const incremental = await prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(incremental.lifetimeCount).toBe(10);
    expect(incremental.lifetimeSum).toBe(44);

    // Leg 2: the nightly full recompute lands identical values.
    await stats.recompute({ role: 'VENDOR', id: vendor.id });
    const recomputed = await prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(recomputed.lifetimeCount).toBe(incremental.lifetimeCount);
    expect(recomputed.lifetimeSum).toBe(incremental.lifetimeSum);
    expect(String(recomputed.displayRating)).toBe(String(incremental.displayRating));

    // Leg 3: direct SQL says the same, and the display math matches RAT-C.
    const sql = await prisma.rating.aggregate({
      where: { vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', state: 'ACTIVE' },
      _count: true, _sum: { score: true },
    });
    expect(sql._count).toBe(10);
    expect(sql._sum.score).toBe(44);
    expect(Number(incremental.displayRating)).toBe(displayRating(10, 44));
  });
});

describe('RAT-E: shields', () => {
  it('S1: a late-tagged rider rating on a breached kitchen is born EXCLUDED and never counts', async () => {
    const vendor = await makeVendor();
    const customer = await makeUser(['CUSTOMER']);
    const riderUser = await makeUser(['RIDER']);
    // Kitchen quoted 20min, took 45 — breach ≥ 10min over quote.
    const t0 = new Date(Date.now() - 3 * 3600_000);
    const order = await makeDeliveredOrder(customer.id, vendor.id, {
      acceptedAt: t0, readyAt: new Date(t0.getTime() + 45 * 60_000), estimatedPrepTime: 20,
    });
    await prisma.order.update({ where: { id: order.id }, data: { rider: undefined } });

    const shielded = await ratings.rate({
      orderId: order.id, raterId: customer.id, rateeId: riderUser.id,
      type: 'CUSTOMER_TO_RIDER', score: 2, tags: ['late'],
    });
    expect(shielded.state).toBe('EXCLUDED');
    expect(shielded.stateReason).toBe('SLA_SHIELD');

    // Kept and auditable — but the rider's stat never saw it.
    const stat = await prisma.actorRatingStat.findUnique({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'RIDER', subjectId: riderUser.id } },
    });
    expect(stat?.lifetimeCount ?? 0).toBe(0);

    // The customer's VENDOR rating on the same order stands untouched.
    await ratings.rate({ orderId: order.id, raterId: customer.id, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 4 });
    const vstat = await prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(vstat.lifetimeCount).toBe(1);
  });

  it('S3: a fraud ban excludes every rating by that account and re-levels the subjects', async () => {
    const vendor = await makeVendor();
    const fraudster = await makeUser(['CUSTOMER']);
    for (let i = 0; i < 3; i += 1) {
      const order = await makeDeliveredOrder(fraudster.id, vendor.id);
      await ratings.rate({ orderId: order.id, raterId: fraudster.id, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 });
    }
    let stat = await prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(stat.lifetimeCount).toBe(3);

    const excluded = await stats.excludeRatings({ raterId: fraudster.id }, 'FRAUD_BAN');
    expect(excluded).toBe(3);
    stat = await prisma.actorRatingStat.findUniqueOrThrow({
      where: { tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id } },
    });
    expect(stat.lifetimeCount).toBe(0); // re-leveled
    // Rows kept for audit.
    expect(await prisma.rating.count({ where: { raterId: fraudster.id, state: 'EXCLUDED', stateReason: 'FRAUD_BAN' } })).toBe(3);
  });
});
