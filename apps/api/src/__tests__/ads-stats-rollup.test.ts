import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AdStatsService } from '../modules/ads/stats.service';

// Ads Phase 5 — stats rollup (spec §12.3). The RECONCILIATION test is a merge
// gate: seed N raw AdEvents → run the rollup → the dashboard numbers exactly
// match the raw counts. And the rollup is idempotent — re-running a day never
// doubles.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const stats = new AdStatsService(prisma);

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const DAY = new Date('2026-09-14T00:00:00Z'); // a Monday (also the booked week)

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.adEvent.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adStatsDaily.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.$disconnect();
});

async function makeCampaign() {
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 7000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: 'C', cities: ['*'], startWeek: DAY, endWeek: DAY, status: 'LIVE' } });
  campaignIds.push(c.id);
  const creativeId = (await prisma.adCreative.create({ data: { campaignId: c.id, kind: 'IMAGE', fileUrl: 'x', status: 'APPROVED', transcodeStatus: 'READY' } })).id;
  await prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: DAY, amount: 7000, status: 'CONFIRMED' } });
  return { campaign: c, creativeId };
}

async function seedEvent(campaignId: string, creativeId: string, type: string, at: Date) {
  await prisma.adEvent.create({ data: { campaignId, creativeId, placementKey: 'home_ad_bar', eventType: type as never, sessionId: nanoid(6), occurredAt: at, tokenHash: nanoid(16), receivedAt: at } });
}

describe('§12.3 rollup reconciliation (MERGE GATE)', () => {
  it('rolled-up dashboard numbers exactly equal the raw event counts', async () => {
    const { campaign, creativeId } = await makeCampaign();
    const at = new Date('2026-09-14T10:00:00Z');
    // Seed a known mix: 5 impressions, 3 viewable, 2 clicks, 4 video starts, 1 complete.
    for (let i = 0; i < 5; i += 1) await seedEvent(campaign.id, creativeId, 'IMPRESSION', at);
    for (let i = 0; i < 3; i += 1) await seedEvent(campaign.id, creativeId, 'VIEWABLE_IMPRESSION', at);
    for (let i = 0; i < 2; i += 1) await seedEvent(campaign.id, creativeId, 'CLICK', at);
    for (let i = 0; i < 4; i += 1) await seedEvent(campaign.id, creativeId, 'VIDEO_START', at);
    await seedEvent(campaign.id, creativeId, 'VIDEO_COMPLETE', at);

    const { rows } = await stats.rollupDay(DAY);
    expect(rows).toBe(1);

    const s = await stats.campaignStats(campaign.id);
    expect(s.totals.impressions).toBe(5);
    expect(s.totals.viewableImpressions).toBe(3);
    expect(s.totals.clicks).toBe(2);
    expect(s.totals.videoStarts).toBe(4);
    expect(s.totals.videoCompletes).toBe(1);
    expect(s.totals.ctr).toBe(0.4); // 2/5
    expect(s.totals.completionRate).toBe(0.25); // 1/4
    // Recognized spend = weeklyPrice/7 for the day = 7000/7 = 1000.
    expect(s.totals.spend).toBe(1000);
    expect(s.series[0]!.day).toBe('2026-09-14');
  });

  it('is idempotent — re-running the day recomputes, never doubles', async () => {
    const { campaign, creativeId } = await makeCampaign();
    const at = new Date('2026-09-14T11:00:00Z');
    for (let i = 0; i < 4; i += 1) await seedEvent(campaign.id, creativeId, 'IMPRESSION', at);

    await stats.rollupDay(DAY);
    await stats.rollupDay(DAY); // run twice
    const s = await stats.campaignStats(campaign.id);
    expect(s.totals.impressions).toBe(4); // NOT 8

    // A late event then re-rollup reflects the new truth.
    await seedEvent(campaign.id, creativeId, 'IMPRESSION', at);
    await stats.rollupDay(DAY);
    expect((await stats.campaignStats(campaign.id)).totals.impressions).toBe(5);
  });
});
