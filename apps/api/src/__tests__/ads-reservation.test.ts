import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { BookingService, SlotUnavailableError } from '../modules/ads/booking.service';
import { seedAdPlacements } from '../modules/ads/placement.seed';

// Ads Phase 2 — inventory & booking engine (ads-platform spec §7). The
// headline is §7.4: N parallel checkouts against a capacity-1 week yield
// EXACTLY ONE reservation. This concurrency proof is a merge gate.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const svc = new BookingService(prisma);

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const MON = new Date('2026-08-03T00:00:00Z'); // Monday
const MON2 = new Date('2026-08-10T00:00:00Z');

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.$disconnect();
});

async function makeAdvertiser() {
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  return a;
}
async function makePlacement(capacity: number) {
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: capacity } });
  placementIds.push(p.id);
  return p;
}
async function makeCampaign(advertiserId: string, placementId: string, startWeek = MON, endWeek = MON) {
  const c = await prisma.adCampaign.create({ data: { advertiserId, placementId, name: 'C', cities: ['*'], startWeek, endWeek, status: 'DRAFT' } });
  campaignIds.push(c.id);
  return c;
}

describe('§7.3 reservation', () => {
  it('books every week×city, copies the price onto each booking, and totals correctly', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement(6);
    const c = await makeCampaign(a.id, p.id, MON, MON2); // 2 weeks
    const res = await svc.reserve(c.id);
    expect(res.bookings).toBe(2);
    expect(res.total).toBe(5000 * 2 * 1);
    const books = await prisma.adBooking.findMany({ where: { campaignId: c.id } });
    expect(books).toHaveLength(2);
    expect(books.every((b) => Number(b.amount) === 5000 && b.status === 'RESERVED')).toBe(true);
    // inventory decremented (booked=1 on each of the 2 weeks).
    const inv = await prisma.adInventoryWeek.findMany({ where: { placementId: p.id } });
    expect(inv.every((i) => i.booked === 1)).toBe(true);
  });

  it('all-or-nothing: one taken week rolls the WHOLE booking back and names the failed slot', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement(1);
    // Fill week 2 with a first campaign.
    const first = await makeCampaign(a.id, p.id, MON2, MON2);
    await svc.reserve(first.id);
    // Second campaign wants weeks 1+2 — week 2 is full, so NOTHING should book.
    const second = await makeCampaign(a.id, p.id, MON, MON2);
    await expect(svc.reserve(second.id)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(await prisma.adBooking.count({ where: { campaignId: second.id } })).toBe(0); // rolled back
    // week 1 must NOT have been left incremented by the rolled-back txn.
    const w1 = await prisma.adInventoryWeek.findUniqueOrThrow({ where: { placementId_city_weekStart: { placementId: p.id, city: '*', weekStart: MON } } });
    expect(w1.booked).toBe(0);
  });
});

describe('§7.4 concurrency proof (MERGE GATE)', () => {
  it('10 parallel checkouts against a capacity-1 week → exactly 1 RESERVED, 9 SLOT_UNAVAILABLE, booked=1', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement(1);
    const campaigns = await Promise.all(Array.from({ length: 10 }, () => makeCampaign(a.id, p.id, MON, MON)));

    const results = await Promise.allSettled(campaigns.map((c) => svc.reserve(c.id)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const slotUnavailable = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'SLOT_UNAVAILABLE');

    expect(fulfilled).toHaveLength(1); // exactly one winner
    expect(slotUnavailable).toHaveLength(9); // nine clean SLOT_UNAVAILABLE — no other error type
    const inv = await prisma.adInventoryWeek.findUniqueOrThrow({ where: { placementId_city_weekStart: { placementId: p.id, city: '*', weekStart: MON } } });
    expect(inv.booked).toBe(1); // the invariant: never oversold
    expect(await prisma.adBooking.count({ where: { placementId: p.id, weekStart: MON, status: 'RESERVED' } })).toBe(1);
  });
});

describe('§7.3 expiry release', () => {
  it('an expired RESERVED hold is released and gives the slot back — idempotently', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement(1);
    const c = await makeCampaign(a.id, p.id, MON, MON);
    await svc.reserve(c.id, { reservationMinutes: 20 });
    // Force the hold into the past.
    await prisma.adBooking.updateMany({ where: { campaignId: c.id }, data: { reservedUntil: new Date(Date.now() - 60_000) } });

    const r1 = await svc.releaseExpired();
    expect(r1.released).toBe(1);
    expect((await prisma.adBooking.findFirstOrThrow({ where: { campaignId: c.id } })).status).toBe('RELEASED');
    expect((await prisma.adInventoryWeek.findUniqueOrThrow({ where: { placementId_city_weekStart: { placementId: p.id, city: '*', weekStart: MON } } })).booked).toBe(0);
    // The slot is bookable again by another campaign.
    const c2 = await makeCampaign(a.id, p.id, MON, MON);
    await expect(svc.reserve(c2.id)).resolves.toMatchObject({ bookings: 1 });
    // Idempotent: a second sweep releases nothing (the RELEASED row is terminal).
    expect((await svc.releaseExpired()).released).toBe(0);
  });
});

describe('§7.2 availability', () => {
  it('lazily materialises inventory rows and reports available = capacity − booked', async () => {
    const a = await makeAdvertiser();
    const p = await makePlacement(6);
    const c = await makeCampaign(a.id, p.id, MON, MON);
    await svc.reserve(c.id); // books 1 of 6 on week 1

    const avail = await svc.availability(p.id, '*', MON, MON2); // 2 weeks
    expect(avail).toHaveLength(2);
    expect(avail[0]).toMatchObject({ weekStart: '2026-08-03', capacity: 6, booked: 1, available: 5, price: 5000 });
    expect(avail[1]).toMatchObject({ weekStart: '2026-08-10', capacity: 6, booked: 0, available: 6 });
  });
});

describe('placement seed', () => {
  it('seeds the three home placements idempotently', async () => {
    const tenant = `t-${nanoid(6)}`;
    const first = await seedAdPlacements(prisma, tenant);
    expect(first).toBe(3);
    const again = await seedAdPlacements(prisma, tenant); // idempotent
    expect(again).toBe(0);
    const seeded = await prisma.adPlacement.findMany({ where: { tenantId: tenant } });
    placementIds.push(...seeded.map((s) => s.id));
    expect(seeded.map((s) => s.key).sort()).toEqual(['home_ad_bar', 'home_hero_video', 'home_top_card']);
    expect(seeded.find((s) => s.key === 'home_hero_video')?.tier).toBe(1);
    await prisma.adsSettings.deleteMany({ where: { tenantId: tenant } });
  });
});
