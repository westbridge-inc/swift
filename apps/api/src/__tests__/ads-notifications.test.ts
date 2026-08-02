import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { AdCheckoutService } from '../modules/ads/checkout.service';
import { BookingService } from '../modules/ads/booking.service';
import { CreativeService } from '../modules/ads/creative.service';
import { AdStatsService } from '../modules/ads/stats.service';
import { AdsCronService } from '../modules/ads/cron.service';

// Ads §16 notifications — the four rows that were missing: the advertiser-side
// payment receipt, the reservation-expiring warning feed, the review-SLA-at-
// risk feed, and the Monday weekly report (whose numbers MUST come from the
// same rollups the dashboard reads — weekTotals — so the email can never
// disagree with the stats screen).

let app: FastifyInstance;
const userIds: string[] = [];
const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
let seq = 0;
const phoneBase = 592_830_000_000 + Math.floor(Math.random() * 160_000_000);

const WEEK1 = new Date('2026-10-05T00:00:00Z'); // Monday
const WEEK2 = new Date('2026-10-12T00:00:00Z'); // Monday

async function makeOwnerUser() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Own', lastName: `U${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  return user;
}

/** Advertiser (w/ a real OWNER member) + placement + campaign. */
async function seedCampaign(opts: { status?: 'PENDING_PAYMENT' | 'LIVE' } = {}) {
  const owner = await makeOwnerUser();
  const a = await app.prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000003', createdByUserId: owner.id, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: owner.id, role: 'OWNER' } });
  const p = await app.prisma.adPlacement.create({ data: { key: `n-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 7000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await app.prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: `Camp ${nanoid(4)}`, cities: ['*'], startWeek: WEEK1, endWeek: WEEK1, status: opts.status ?? 'PENDING_PAYMENT' } });
  campaignIds.push(c.id);
  return { owner, advertiser: a, placement: p, campaign: c };
}

const notificationsFor = (userId: string, kind: string) =>
  app.prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: kind } } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.adStatsDaily.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adCreative.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adInvoice.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await app.prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await app.prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§16 payment receipt (advertiser side)', () => {
  it('markPaid sends the owner a receipt, not just the admin ping', async () => {
    const { owner, advertiser, campaign, placement } = await seedCampaign();
    await app.prisma.adBooking.create({ data: { campaignId: campaign.id, placementId: placement.id, city: '*', weekStart: WEEK1, amount: 7000, status: 'RESERVED', reservedUntil: new Date(Date.now() + 20 * 60_000) } });
    const invoice = await app.prisma.adInvoice.create({ data: { advertiserId: advertiser.id, campaignId: campaign.id, number: `ADS-TEST-${nanoid(8)}`, amount: 7000, status: 'UNPAID', provider: 'MOCK' } });

    const checkout = new AdCheckoutService(app.prisma, app.io);
    await checkout.markPaid(invoice.id, { providerRef: nanoid(10) });

    const receipts = await notificationsFor(owner.id, 'ad_invoice_receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.title).toContain(invoice.number);
    // Idempotent replay must NOT double the receipt.
    await checkout.markPaid(invoice.id, { providerRef: nanoid(10) });
    expect(await notificationsFor(owner.id, 'ad_invoice_receipt')).toHaveLength(1);
  });
});

describe('§16 reservation-expiring feed', () => {
  it('returns one row per campaign with the soonest deadline, only inside the window', async () => {
    const now = new Date();
    const { campaign, placement, advertiser } = await seedCampaign();
    const in3 = new Date(now.getTime() + 3 * 60_000);
    const in4 = new Date(now.getTime() + 4 * 60_000);
    await app.prisma.adBooking.createMany({
      data: [
        { campaignId: campaign.id, placementId: placement.id, city: '*', weekStart: WEEK1, amount: 7000, status: 'RESERVED', reservedUntil: in4 },
        { campaignId: campaign.id, placementId: placement.id, city: 'GT', weekStart: WEEK1, amount: 7000, status: 'RESERVED', reservedUntil: in3 },
      ],
    });
    // Outside the window (20 min) and already expired — both excluded.
    const other = await seedCampaign();
    await app.prisma.adBooking.createMany({
      data: [
        { campaignId: other.campaign.id, placementId: other.placement.id, city: '*', weekStart: WEEK1, amount: 7000, status: 'RESERVED', reservedUntil: new Date(now.getTime() + 20 * 60_000) },
        { campaignId: other.campaign.id, placementId: other.placement.id, city: 'GT', weekStart: WEEK1, amount: 7000, status: 'RESERVED', reservedUntil: new Date(now.getTime() - 60_000) },
      ],
    });

    const feed = await new BookingService(app.prisma).expiringSoon(5, now);
    const mine = feed.filter((f) => f.campaignId === campaign.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.advertiserId).toBe(advertiser.id);
    expect(mine[0]!.reservedUntil.getTime()).toBe(in3.getTime()); // soonest, not per-booking
    expect(feed.some((f) => f.campaignId === other.campaign.id)).toBe(false);
  });
});

describe('§16 review-SLA-at-risk feed', () => {
  it('flags reviewable creatives past 75% of the SLA, ignores fresh and unreviewable ones', async () => {
    const now = new Date();
    const { campaign } = await seedCampaign({ status: 'LIVE' });
    const old = new Date(now.getTime() - 19 * 3_600_000); // 19h > 0.75×24h
    const fresh = new Date(now.getTime() - 10 * 3_600_000);
    const atRisk = await app.prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'IMAGE', fileUrl: 'x', status: 'PENDING', transcodeStatus: 'READY', createdAt: old } });
    await app.prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'IMAGE', fileUrl: 'x', status: 'PENDING', transcodeStatus: 'READY', createdAt: fresh } });
    await app.prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'VIDEO', fileUrl: 'x', status: 'PENDING', transcodeStatus: 'QUEUED', createdAt: old } });

    const flagged = await new CreativeService(app.prisma, app.io).reviewSlaAtRisk(24, now);
    const mine = flagged.filter((f) => f.campaignId === campaign.id);
    expect(mine.map((f) => f.id)).toEqual([atRisk.id]); // old+READY only
  });
});

describe('§16 weekly report — same numbers as the dashboard', () => {
  it('weekTotals sums exactly the booked week from the rollups', async () => {
    const { campaign } = await seedCampaign({ status: 'LIVE' });
    const creativeId = (await app.prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'IMAGE', fileUrl: 'x', status: 'APPROVED', transcodeStatus: 'READY' } })).id;
    await app.prisma.adStatsDaily.createMany({
      data: [
        { campaignId: campaign.id, creativeId, day: WEEK1, city: '*', impressions: 100, viewableImpressions: 80, clicks: 10, videoStarts: 0, videoCompletes: 0, spend: 1000 },
        { campaignId: campaign.id, creativeId, day: new Date('2026-10-08T00:00:00Z'), city: '*', impressions: 50, viewableImpressions: 40, clicks: 5, videoStarts: 0, videoCompletes: 0, spend: 1000 },
        // Next week's row must NOT bleed into week 1 totals.
        { campaignId: campaign.id, creativeId, day: WEEK2, city: '*', impressions: 999, viewableImpressions: 999, clicks: 99, videoStarts: 0, videoCompletes: 0, spend: 9999 },
      ],
    });
    const t = await new AdStatsService(app.prisma).weekTotals(campaign.id, WEEK1);
    expect(t.impressions).toBe(150);
    expect(t.viewableImpressions).toBe(120);
    expect(t.clicks).toBe(15);
    expect(t.ctr).toBe(0.1);
    expect(t.spend).toBe(2000);
  });

  it('weeklyReport digests last week to the owners of campaigns that ran', async () => {
    const { owner, campaign, placement } = await seedCampaign({ status: 'LIVE' });
    await app.prisma.adBooking.create({ data: { campaignId: campaign.id, placementId: placement.id, city: '*', weekStart: WEEK1, amount: 7000, status: 'CONFIRMED' } });
    const creativeId = (await app.prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'IMAGE', fileUrl: 'x', status: 'APPROVED', transcodeStatus: 'READY' } })).id;
    await app.prisma.adStatsDaily.create({ data: { campaignId: campaign.id, creativeId, day: new Date('2026-10-07T00:00:00Z'), city: '*', impressions: 200, viewableImpressions: 150, clicks: 20, videoStarts: 0, videoCompletes: 0, spend: 3000 } });

    // A campaign whose booking was a DIFFERENT week gets no report.
    const silent = await seedCampaign({ status: 'LIVE' });
    await app.prisma.adBooking.create({ data: { campaignId: silent.campaign.id, placementId: silent.placement.id, city: '*', weekStart: WEEK2, amount: 7000, status: 'CONFIRMED' } });

    // Wednesday after WEEK2's Monday → "last week" = WEEK1 (Guyana TZ).
    const res = await new AdsCronService(app.prisma, app.io).weeklyReport(new Date('2026-10-14T13:00:00Z'));
    expect(res.campaigns).toBeGreaterThanOrEqual(1);

    const reports = await notificationsFor(owner.id, 'ad_weekly_report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toContain('150'); // viewable impressions
    expect(reports[0]!.body).toContain('20'); // clicks
    expect(await notificationsFor(silent.owner.id, 'ad_weekly_report')).toHaveLength(0);
  });
});
