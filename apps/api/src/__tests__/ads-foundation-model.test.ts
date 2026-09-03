import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] This suite states the destructive capability it needs; without it the test-mode guard refuses.
grantSuiteCapability('ddl');

// Swift Ads — Phase 1 foundation data model (ads-platform spec §5). Proves the
// schema persists and the invariants the rest of the platform leans on hold at
// the DB: a fresh advertiser is PENDING_REVIEW (lands in the founder's queue),
// the one-booking-per-slot uniqueness that makes the reservation engine safe,
// and the two migration CHECK constraints (booked-in-range, Monday-only weeks).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];

const MON = new Date('2026-08-03T00:00:00Z'); // a Monday
const TUE = new Date('2026-08-04T00:00:00Z'); // a Tuesday

beforeAll(async () => {
  await prisma.$connect();
  // CI preps the test DB with `prisma db push`, which cannot see the raw CHECK
  // constraints (they live in the migration SQL, prod's source of truth,
  // Migration-Replay-verified). Install them idempotently so this suite
  // exercises the real DB backstops under any DB-setup path.
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_inventory_weeks" DROP CONSTRAINT IF EXISTS "ad_inventory_weeks_booked_range"`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_inventory_weeks" ADD CONSTRAINT "ad_inventory_weeks_booked_range" CHECK ("booked" >= 0 AND "booked" <= "capacity")`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_inventory_weeks" DROP CONSTRAINT IF EXISTS "ad_inventory_weeks_monday"`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_inventory_weeks" ADD CONSTRAINT "ad_inventory_weeks_monday" CHECK (EXTRACT(ISODOW FROM "weekStart") = 1)`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_bookings" DROP CONSTRAINT IF EXISTS "ad_bookings_monday"`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_bookings" ADD CONSTRAINT "ad_bookings_monday" CHECK (EXTRACT(ISODOW FROM "weekStart") = 1)`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_campaigns" DROP CONSTRAINT IF EXISTS "ad_campaigns_weeks_monday"`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_weeks_monday" CHECK (EXTRACT(ISODOW FROM "startWeek") = 1 AND EXTRACT(ISODOW FROM "endWeek") = 1)`).catch(() => {});
});

afterAll(async () => {
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.$disconnect();
});

async function makeAdvertiser() {
  const a = await prisma.advertiser.create({
    data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}` },
  });
  advertiserIds.push(a.id);
  return a;
}
async function makePlacement(key = `home_test_${nanoid(6)}`) {
  const p = await prisma.adPlacement.create({
    data: { key, name: 'Test', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 },
  });
  placementIds.push(p.id);
  return p;
}
async function makeCampaign(advertiserId: string, placementId: string) {
  const c = await prisma.adCampaign.create({
    data: { advertiserId, placementId, name: 'Camp', cities: ['*'], startWeek: MON, endWeek: MON },
  });
  campaignIds.push(c.id);
  return c;
}

describe('Advertiser [ads §4/§5]', () => {
  it('a new advertiser is born PENDING_REVIEW with the tenant default — it lands in the founder queue', async () => {
    const a = await makeAdvertiser();
    expect(a.status).toBe('PENDING_REVIEW');
    expect(a.tenantId).toBe('swift-default');
    expect(a.createdAt).toBeInstanceOf(Date);
  });

  it('a member is unique per (advertiser, user) — the same person is not listed twice', async () => {
    const a = await makeAdvertiser();
    const userId = `u-${nanoid(6)}`;
    await prisma.advertiserMember.create({ data: { advertiserId: a.id, userId, role: 'OWNER' } });
    await expect(
      prisma.advertiserMember.create({ data: { advertiserId: a.id, userId, role: 'MANAGER' } }),
    ).rejects.toThrow();
  });
});

describe('AdPlacement [ads §2]', () => {
  it('placement key is unique per tenant — one home_hero_video per tenant', async () => {
    const key = `home_dupe_${nanoid(6)}`;
    await makePlacement(key);
    await expect(makePlacement(key)).rejects.toThrow(); // @@unique([tenantId, key])
  });
});

describe('AdBooking one-slot invariant [ads §7]', () => {
  it('a (campaign, placement, city, week) slot can be booked at most once', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement();
    const c = await makeCampaign(a.id, p.id);
    await prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: MON, amount: 5000, status: 'RESERVED' } });
    await expect(
      prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: MON, amount: 5000, status: 'RESERVED' } }),
    ).rejects.toThrow(); // @@unique([campaignId, placementId, city, weekStart])
  });
});

describe('DB CHECK constraints [ads §5 migration SQL]', () => {
  it('booked can never exceed capacity (the last-line reservation backstop)', async () => {
    const p = await makePlacement();
    await expect(
      prisma.adInventoryWeek.create({ data: { placementId: p.id, city: '*', weekStart: MON, capacity: 6, booked: 7 } }),
    ).rejects.toThrow(); // CHECK booked BETWEEN 0 AND capacity
    // booked within range is fine.
    const ok = await prisma.adInventoryWeek.create({ data: { placementId: p.id, city: '*', weekStart: MON, capacity: 6, booked: 6 } });
    expect(ok.booked).toBe(6);
  });

  it('a non-Monday week is refused by the DB (week math assumes Monday everywhere)', async () => {
    const p = await makePlacement();
    await expect(
      prisma.adInventoryWeek.create({ data: { placementId: p.id, city: '*', weekStart: TUE, capacity: 6, booked: 0 } }),
    ).rejects.toThrow(); // CHECK EXTRACT(ISODOW) = 1
  });

  it('a campaign whose weeks are not Mondays is refused', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement();
    await expect(
      prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: 'Bad', cities: ['*'], startWeek: TUE, endWeek: TUE } }),
    ).rejects.toThrow();
  });
});
