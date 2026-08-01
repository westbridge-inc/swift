import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { AdsCronService } from '../modules/ads/cron.service';
import { AdsRefundService } from '../modules/ads/refund.service';
import { weekStartInstant } from '../modules/ads/ads-weeks';

// Ads Phase 3b — lifecycle crons + refund execution (spec §6.1/§8.4). Proves
// the time-driven transitions (auto-cancel unapproved → cancel+refund, week
// start → live, week end → completed) and that the refund executor applies the
// pure calculator's plan to real bookings/inventory/invoice.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const cron = new AdsCronService(prisma, io);
const refunds = new AdsRefundService(prisma, io);

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const invoiceIds: string[] = [];

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.adInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await prisma.adCreative.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adsAuditLog.deleteMany({ where: { entityId: { in: campaignIds } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.$disconnect();
});

async function scaffold(opts: { status: string; startWeek: Date; endWeek?: Date }) {
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: 'C', cities: ['*'], startWeek: opts.startWeek, endWeek: opts.endWeek ?? opts.startWeek, status: opts.status as never } });
  campaignIds.push(c.id);
  return { advertiser: a, placement: p, campaign: c };
}
async function bookAndConfirm(campaignId: string, placementId: string, weekStart: Date) {
  await prisma.adInventoryWeek.upsert({ where: { placementId_city_weekStart: { placementId, city: '*', weekStart } }, create: { placementId, city: '*', weekStart, capacity: 6, booked: 1 }, update: { booked: { increment: 1 } } });
  return prisma.adBooking.create({ data: { campaignId, placementId, city: '*', weekStart, amount: 5000, status: 'CONFIRMED' } });
}

// Fixed reference "now" — a Wednesday well into the future so week arithmetic
// is unambiguous. WK_PAST started before now; WK_FUTURE is far ahead.
const NOW = new Date('2026-09-16T12:00:00Z'); // Wed
const WK_THIS = new Date('2026-09-14T00:00:00Z'); // the Monday of NOW's week
const WK_PAST = new Date('2026-09-07T00:00:00Z'); // a prior Monday
const WK_FUTURE = new Date('2026-10-05T00:00:00Z'); // weeks ahead

describe('§6.1 week_start / week_end crons', () => {
  it('activates a SCHEDULED campaign whose week has arrived, and completes a LIVE one whose window passed', async () => {
    const sched = await scaffold({ status: 'SCHEDULED', startWeek: WK_THIS });
    const done = await scaffold({ status: 'LIVE', startWeek: WK_PAST, endWeek: WK_PAST });
    const notYet = await scaffold({ status: 'SCHEDULED', startWeek: WK_FUTURE });

    const res = await cron.tick(NOW);
    expect(res.activated).toBeGreaterThanOrEqual(1);
    expect(res.completed).toBeGreaterThanOrEqual(1);
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: sched.campaign.id } })).status).toBe('LIVE');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: done.campaign.id } })).status).toBe('COMPLETED');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: notYet.campaign.id } })).status).toBe('SCHEDULED'); // future — untouched
  });
});

describe('§6.1 auto_cancel_unapproved + §8.4 row 1 refund', () => {
  it('cancels an unapproved campaign past its go-live cutoff and refunds 100%, freeing the slot', async () => {
    // startWeek far enough ahead that "now" is past (startWeek − 24h)? No — we
    // want NOW to be AFTER the cutoff. Put startWeek just after NOW so the
    // cutoff (startWeek − 24h) is already behind us.
    const startWeek = new Date(weekStartInstant(WK_THIS).getTime()); // Monday of NOW's week — cutoff was ~25h before NOW
    const { campaign, placement } = await scaffold({ status: 'PENDING_REVIEW', startWeek: WK_THIS });
    const inv = await prisma.adsSettings.upsert({ where: { tenantId: 'swift-default' }, create: { tenantId: 'swift-default' }, update: {} });
    void inv; void startWeek;
    const booking = await bookAndConfirm(campaign.id, placement.id, WK_THIS);
    const invoice = await prisma.adInvoice.create({ data: { advertiserId: campaign.advertiserId, campaignId: campaign.id, number: `ADS-2026-${nanoid(6)}`, amount: 5000, currency: 'GYD', status: 'PAID', paidAt: new Date() } });
    invoiceIds.push(invoice.id);

    const cancelled = await cron.autoCancelUnapproved(NOW);
    expect(cancelled).toBeGreaterThanOrEqual(1);
    const c = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(c.status).toBe('CANCELLED');
    // 100% refund: booking REFUNDED, slot freed, invoice fully refunded.
    expect((await prisma.adBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('REFUNDED');
    expect((await prisma.adInventoryWeek.findUniqueOrThrow({ where: { placementId_city_weekStart: { placementId: placement.id, city: '*', weekStart: WK_THIS } } })).booked).toBe(0);
    const inv2 = await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(inv2.status).toBe('REFUNDED');
    expect(Number(inv2.refundedAmount)).toBe(5000);
  });

  it('leaves a fully-approved PENDING_REVIEW campaign for the approval hook (does not auto-cancel it)', async () => {
    const { campaign } = await scaffold({ status: 'PENDING_REVIEW', startWeek: WK_THIS });
    await prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'IMAGE', fileUrl: 'x', status: 'APPROVED', transcodeStatus: 'READY' } });
    await cron.autoCancelUnapproved(NOW);
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PENDING_REVIEW'); // not cancelled
  });
});

describe('§8.4 refund execution — advertiser cancel', () => {
  it('refunds future weeks (100% ≥7d) and NOT the current live week', async () => {
    const { campaign, placement } = await scaffold({ status: 'LIVE', startWeek: WK_THIS, endWeek: WK_FUTURE });
    const liveBooking = await bookAndConfirm(campaign.id, placement.id, WK_THIS); // current week
    const futureBooking = await bookAndConfirm(campaign.id, placement.id, WK_FUTURE); // ≥7d ahead
    const invoice = await prisma.adInvoice.create({ data: { advertiserId: campaign.advertiserId, campaignId: campaign.id, number: `ADS-2026-${nanoid(6)}`, amount: 10000, currency: 'GYD', status: 'PAID', paidAt: new Date() } });
    invoiceIds.push(invoice.id);

    const res = await refunds.execute(campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: NOW, cancelFullRefundDays: 7 });
    expect(res.refundedTotal).toBe(5000); // only the future week
    expect(res.releasedSlots).toBe(1);
    expect((await prisma.adBooking.findUniqueOrThrow({ where: { id: futureBooking.id } })).status).toBe('REFUNDED');
    expect((await prisma.adBooking.findUniqueOrThrow({ where: { id: liveBooking.id } })).status).toBe('CONFIRMED'); // current week: 0%, untouched
    const inv2 = await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(inv2.status).toBe('PARTIALLY_REFUNDED');
    expect(Number(inv2.refundedAmount)).toBe(5000);
  });
});
