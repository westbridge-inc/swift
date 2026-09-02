import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { AdsCronService } from '../modules/ads/cron.service';
import { AdsLifecycleService } from '../modules/ads/lifecycle.service';
import { AdsRefundService, backfillAdRefundIntents, scanAdRefunds } from '../modules/ads/refund.service';

// ---------------------------------------------------------------------------
// [R045-ADS-01 · 02 · 03 · 08 · 09] The ad refund obligation is durable.
//
// The register's red tests: cancel must create intent / items / outbox in the
// same transaction as the terminal state; a worker retry must yield exactly
// one settlement and reconciliation; a CREDIT policy creates a unique
// liability and its replay is a no-op; the executor on 101 minor units at 50%
// settles exactly 51; an injected refund failure on kill leaves a visible
// pending intent and eventually one settlement; auto-cancel that fails after
// its transition executes the same intent once on rerun.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const refunds = new AdsRefundService(prisma, io);
const lifecycle = new AdsLifecycleService(prisma, io);
const cron = new AdsCronService(prisma, io);

const NOW = new Date('2026-09-16T12:00:00Z'); // Wed
const WK_THIS = new Date('2026-09-14T00:00:00Z');
const WK_FUTURE = new Date('2026-10-05T00:00:00Z');
const advertiserIds: string[] = []; const placementIds: string[] = []; const campaignIds: string[] = []; const invoiceIds: string[] = [];

beforeAll(async () => { await prisma.$connect(); delete process.env['AD_REFUND_EXECUTION_KILL']; });
afterAll(async () => {
  // The refund outbox, intents and items are IMMUTABLE by trigger (deletes are refused) and they RESTRICT
  // their invoice, booking and campaign — so the ads-money fixtures stay in place; every id is unique per run.
  await prisma.adsAuditLog.deleteMany({ where: { entityId: { in: campaignIds } } });
  await prisma.$disconnect();
});

async function scaffold(opts: { status: 'PENDING_REVIEW' | 'SCHEDULED' | 'LIVE' | 'CANCELLED'; startWeek: Date; endWeek?: Date }) {
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', status: 'APPROVED', createdByUserId: 'test' } });
  advertiserIds.push(a.id);
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: `C ${nanoid(4)}`, cities: ['*'], startWeek: opts.startWeek, endWeek: opts.endWeek ?? opts.startWeek, status: opts.status } });
  campaignIds.push(c.id);
  return { advertiser: a, placement: p, campaign: c };
}
async function book(campaignId: string, placementId: string, weekStart: Date, amount: number, status: 'CONFIRMED' | 'REFUNDED' = 'CONFIRMED', city = '*') {
  await prisma.adInventoryWeek.upsert({ where: { placementId_city_weekStart: { placementId, city, weekStart } }, create: { placementId, city, weekStart, capacity: 6, booked: 1 }, update: { booked: { increment: 1 } } });
  return prisma.adBooking.create({ data: { campaignId, placementId, city, weekStart, amount, status } });
}
async function paidInvoice(advertiserId: string, campaignId: string, amount: number) {
  const inv = await prisma.adInvoice.create({ data: { advertiserId, campaignId, number: `ADS-2026-${nanoid(6)}`, amount, currency: 'GYD', status: 'PAID', paidAt: new Date() } });
  invoiceIds.push(inv.id);
  return inv;
}
const intentsFor = (campaignId: string) => prisma.adRefundIntent.findMany({ where: { campaignId }, include: { items: true, outbox: true }, orderBy: { createdAt: 'asc' } });
const readyNow = (campaignId: string) => prisma.adRefundOutbox.updateMany({ where: { refundIntent: { campaignId } }, data: { availableAt: new Date(0), leaseExpiresAt: null } });

describe('the register’s red test: the obligation is one generation with the terminal state', () => {
  it('cancel creates the intent, its items and its outbox row in the SAME transaction; a staging failure leaves the campaign uncancelled and nothing staged', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'SCHEDULED', startWeek: WK_FUTURE });
    await book(campaign.id, placement.id, WK_FUTURE, 5000);
    await paidInvoice(advertiser.id, campaign.id, 5000);
    // the injected staging failure: the transition must roll back with it
    await expect(lifecycle.transition(campaign.id, 'cancel', 'owner', undefined, {
      within: async (tx) => { await refunds.stage(tx, campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: NOW }); throw new Error('boom after staging'); },
    })).rejects.toThrow('boom after staging');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('SCHEDULED');
    expect(await intentsFor(campaign.id)).toHaveLength(0);
    // the real thing
    let staged: { intentId: string; staged: boolean } | null = null;
    await lifecycle.transition(campaign.id, 'cancel', 'owner', undefined, { within: async (tx) => { staged = await refunds.stage(tx, campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: NOW }); } });
    expect(staged).toMatchObject({ staged: true });
    const [intent] = await intentsFor(campaign.id);
    expect(intent).toMatchObject({ status: 'PENDING', reason: 'ADVERTISER_CANCEL', amountMinor: 500000n, currency: 'GYD', payoutRail: 'MANUAL' });
    expect(intent!.items).toHaveLength(1);
    expect(intent!.items[0]).toMatchObject({ kind: 'REFUND', amountMinor: 500000n });
    expect(intent!.outbox).toMatchObject({ processedAt: null, attempts: 0 });
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('CANCELLED');
    // staging the same (campaign, reason, event) again is the same intent
    const again = await prisma.$transaction((tx) => refunds.stage(tx, campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: NOW }));
    expect(again).toMatchObject({ intentId: intent!.id, staged: false });
    expect(await intentsFor(campaign.id)).toHaveLength(1);
  });

  it('a worker retry yields exactly one settlement: the first execution fails and rolls back, the retry executes, a replay changes nothing', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'SCHEDULED', startWeek: WK_FUTURE });
    const booking = await book(campaign.id, placement.id, WK_FUTURE, 5000);
    const invoice = await paidInvoice(advertiser.id, campaign.id, 5000);
    await lifecycle.transition(campaign.id, 'cancel', 'owner', undefined, { within: async (tx) => { await refunds.stage(tx, campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: NOW }); } });
    const [intent] = await intentsFor(campaign.id);
    let failures = 0;
    refunds.observer = { beforeExecute: async () => { failures += 1; throw new Error('provider blip'); } };
    const first = await refunds.drainOutbox({ intentIds: [intent!.id] });
    expect(first).toMatchObject({ processed: 0, failed: 1 });
    expect(failures).toBe(1);
    expect((await prisma.adRefundIntent.findUniqueOrThrow({ where: { id: intent!.id } })).status).toBe('PENDING'); // the transaction rolled back
    expect((await prisma.adBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
    expect((await prisma.adRefundOutbox.findUniqueOrThrow({ where: { refundIntentId: intent!.id } })).lastError).toContain('provider blip');
    refunds.observer = {};
    await readyNow(campaign.id);
    const second = await refunds.drainOutbox({ intentIds: [intent!.id] });
    expect(second).toMatchObject({ processed: 1, failed: 0 });
    const settled = await prisma.adRefundIntent.findUniqueOrThrow({ where: { id: intent!.id }, include: { outbox: true } });
    expect(settled.status).toBe('MANUAL_REQUIRED');
    expect(settled.outbox!.processedAt).not.toBeNull();
    expect((await prisma.adBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('REFUNDED');
    expect(Number((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount)).toBe(5000);
    // replay: the executor and the drain are no-ops
    expect((await refunds.executeIntent(intent!.id)).executed).toBe(false);
    await readyNow(campaign.id);
    expect((await refunds.drainOutbox({ intentIds: [intent!.id] })).processed).toBe(0);
    expect(Number((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount)).toBe(5000);
    expect((await prisma.adsAuditLog.count({ where: { entityId: intent!.id, action: 'REFUND_EXECUTED' } }))).toBe(1);
  });
});

describe('[R045-ADS-02] a CREDIT is a persisted liability applied once', () => {
  it('late approval creates a unique CREDIT item; execution moves the advertiser’s credit balance once; replay is a no-op', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'LIVE', startWeek: WK_THIS });
    const booking = await book(campaign.id, placement.id, WK_THIS, 7000);
    await paidInvoice(advertiser.id, campaign.id, 7000);
    const staged = await prisma.$transaction((tx) => refunds.stage(tx, campaign.id, 'LATE_APPROVAL', 'ops', { now: NOW, missedDaysByBooking: { [booking.id]: 2 } }));
    expect(staged).not.toBeNull();
    const [intent] = await intentsFor(campaign.id);
    expect(intent!.items).toHaveLength(1);
    expect(intent!.items[0]).toMatchObject({ kind: 'CREDIT', bookingId: booking.id });
    expect(intent!.items[0]!.amountMinor).toBe(200000n); // 2 of 7 days of 7,000.00
    await refunds.executeNow(intent!.id);
    const after = await prisma.advertiser.findUniqueOrThrow({ where: { id: advertiser.id } });
    expect(after.creditBalance.toString()).toBe('2000');
    expect(await prisma.adsAuditLog.count({ where: { entityId: intent!.id, action: 'REFUND_EXECUTED' } })).toBe(1); // the execution record IS the applied-once proof
    expect((await prisma.adBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED'); // the ad keeps serving
    await refunds.executeIntent(intent!.id);
    expect((await prisma.advertiser.findUniqueOrThrow({ where: { id: advertiser.id } })).creditBalance.toString()).toBe('2000');
    // a FORCED replay — an operator re-queues the executed intent — applies nothing twice
    await prisma.adRefundIntent.update({ where: { id: intent!.id }, data: { status: 'PENDING' } });
    const forced = await refunds.executeIntent(intent!.id);
    expect(forced).toMatchObject({ executed: true, creditedMinor: 0n });
    expect((await prisma.advertiser.findUniqueOrThrow({ where: { id: advertiser.id } })).creditBalance.toString()).toBe('2000');
    // the same policy staged again is the same liability, not a second one
    const again = await prisma.$transaction((tx) => refunds.stage(tx, campaign.id, 'LATE_APPROVAL', 'ops', { now: NOW, missedDaysByBooking: { [booking.id]: 2 } }));
    expect(again).toMatchObject({ intentId: intent!.id, staged: false });
    expect(await prisma.adRefundItem.count({ where: { campaignId: campaign.id } })).toBe(1);
  });
});

describe('[R045-ADS-03] integer minor units end to end', () => {
  it('101 minor units at 50 percent settle exactly 51 — on the item and on the invoice', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'SCHEDULED', startWeek: WK_FUTURE });
    const b1 = await book(campaign.id, placement.id, WK_FUTURE, 1.01);
    const b2 = await book(campaign.id, placement.id, WK_FUTURE, 1.15, 'CONFIRMED', 'georgetown'); // 1.15 × 100 is 114.99999… in floats; one booking per city and week
    const invoice = await paidInvoice(advertiser.id, campaign.id, 2.16);
    const threeDaysBefore = new Date(WK_FUTURE.getTime() - 3 * 86_400_000);
    await lifecycle.transition(campaign.id, 'cancel', 'owner', undefined, { within: async (tx) => { await refunds.stage(tx, campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: threeDaysBefore, cancelFullRefundDays: 7 }); } });
    const [intent] = await intentsFor(campaign.id);
    const byBooking = new Map(intent!.items.map((i) => [i.bookingId, i.amountMinor]));
    expect(byBooking.get(b1.id)).toBe(51n);  // 101 at 50% → 51 (half up)
    expect(byBooking.get(b2.id)).toBe(58n);  // 115 at 50% → 57.5 → 58 — never 57 from a truncated 114
    expect(intent!.amountMinor).toBe(109n);
    await refunds.executeNow(intent!.id);
    expect((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount.toString()).toBe('1.09');
    // a forced replay moves the invoice nowhere: the bookings are already REFUNDED
    await prisma.adRefundIntent.update({ where: { id: intent!.id }, data: { status: 'PENDING' } });
    expect(await refunds.executeIntent(intent!.id)).toMatchObject({ executed: true, refundedMinor: 0n });
    expect((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount.toString()).toBe('1.09');
  });
});

describe('[R045-ADS-08 · 09] kill and auto-cancel never lose the obligation', () => {
  it('kill with an injected execution failure: the campaign is killed, the intent is visibly pending, and it eventually settles once', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'SCHEDULED', startWeek: WK_FUTURE });
    await book(campaign.id, placement.id, WK_FUTURE, 5000);
    const invoice = await paidInvoice(advertiser.id, campaign.id, 5000);
    refunds.observer = { beforeExecute: async () => { throw new Error('refund service down'); } };
    let staged: { intentId: string } | null = null;
    await lifecycle.transition(campaign.id, 'kill', 'admin', 'policy', { within: async (tx) => { staged = await refunds.stage(tx, campaign.id, 'ADMIN_KILL', 'admin'); } });
    await refunds.executeNow((staged as unknown as { intentId: string }).intentId).catch(() => {});
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('REJECTED');
    const scan = await scanAdRefunds(prisma);
    expect(scan.outstanding.count).toBeGreaterThanOrEqual(1);
    expect((await intentsFor(campaign.id))[0]!.status).toBe('PENDING');
    refunds.observer = {};
    await readyNow(campaign.id);
    await refunds.drainOutbox({ intentIds: [(staged as unknown as { intentId: string }).intentId] }); // this suite's own intent only — other suites drain theirs
    expect((await intentsFor(campaign.id))[0]!.status).toBe('MANUAL_REQUIRED');
    expect(Number((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount)).toBe(5000);
  });
  it('auto-cancel that fails after its transition: rerunning the cron and the worker executes the same intent once', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'PENDING_REVIEW', startWeek: WK_THIS });
    await book(campaign.id, placement.id, WK_THIS, 5000);
    const invoice = await paidInvoice(advertiser.id, campaign.id, 5000);
    const cronRefunds = (cron as unknown as { refunds: AdsRefundService }).refunds;
    cronRefunds.observer = { beforeExecute: async () => { throw new Error('process died'); } };
    expect(await cron.autoCancelUnapproved(NOW, { campaignIds: [campaign.id] })).toBe(1);
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('CANCELLED');
    expect((await intentsFor(campaign.id))[0]!.status).toBe('PENDING');
    cronRefunds.observer = {};
    expect(await cron.autoCancelUnapproved(NOW, { campaignIds: [campaign.id] })).toBe(0); // terminal now — never re-cancelled
    await readyNow(campaign.id);
    await refunds.drainOutbox({ intentIds: (await intentsFor(campaign.id)).map((i) => i.id) });
    const intents = await intentsFor(campaign.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe('MANUAL_REQUIRED');
    expect(Number((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount)).toBe(5000);
  });
});

describe('operations: kill switch, evidence, backfill', () => {
  it('the kill switch stops execution and preserves the intent', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'SCHEDULED', startWeek: WK_FUTURE });
    await book(campaign.id, placement.id, WK_FUTURE, 5000);
    await paidInvoice(advertiser.id, campaign.id, 5000);
    process.env['AD_REFUND_EXECUTION_KILL'] = '1';
    try {
      await lifecycle.transition(campaign.id, 'cancel', 'owner', undefined, { within: async (tx) => { await refunds.stage(tx, campaign.id, 'ADVERTISER_CANCEL', 'owner', { now: NOW }); } });
      const [intent] = await intentsFor(campaign.id);
      expect((await refunds.drainOutbox({ intentIds: [intent!.id] })).processed).toBe(0);
      expect((await intentsFor(campaign.id))[0]!.status).toBe('PENDING');
    } finally {
      delete process.env['AD_REFUND_EXECUTION_KILL'];
    }
  });
  it('the payout reference settles an executed intent; an unexecuted one cannot be settled', async () => {
    const executed = await prisma.adRefundIntent.findFirst({ where: { campaignId: { in: campaignIds }, status: 'MANUAL_REQUIRED' } });
    const pending = await prisma.adRefundIntent.findFirst({ where: { campaignId: { in: campaignIds }, status: 'PENDING' } });
    expect(executed).not.toBeNull(); expect(pending).not.toBeNull();
    const ref = `MMG-${nanoid(8)}`; // a payout reference is unique across intents (partial unique index)
    await expect(refunds.settleManual(pending!.id, ref, 'admin')).rejects.toThrow(/can be settled once it has executed/);
    await refunds.settleManual(executed!.id, ref, 'admin');
    const row = await prisma.adRefundIntent.findUniqueOrThrow({ where: { id: executed!.id } });
    expect(row).toMatchObject({ status: 'SUCCEEDED', manualPayoutRef: ref });
    expect(row.completedAt).not.toBeNull();
    await refunds.settleManual(executed!.id, ref, 'admin'); // idempotent
  });
  it('backfill: a legacy killed paid campaign with no intent is found, listed in a dry run, then recorded as executed-awaiting-evidence — never re-executed', async () => {
    const { campaign, placement, advertiser } = await scaffold({ status: 'CANCELLED', startWeek: WK_FUTURE });
    await book(campaign.id, placement.id, WK_FUTURE, 5000, 'REFUNDED');
    const invoice = await paidInvoice(advertiser.id, campaign.id, 5000);
    await prisma.adInvoice.update({ where: { id: invoice.id }, data: { refundedAmount: 5000, status: 'REFUNDED' } });
    await prisma.adsAuditLog.create({ data: { tenantId: campaign.tenantId, actorUserId: 'admin', action: 'CAMPAIGN_KILL', entityType: 'AdCampaign', entityId: campaign.id } });
    const scan = await scanAdRefunds(prisma);
    expect(scan.terminalWithoutIntent.some((t) => t.campaignId === campaign.id)).toBe(true);
    const dry = await backfillAdRefundIntents(prisma, { dryRun: true, campaignIds: [campaign.id] });
    expect(dry.created).toBe(0);
    expect(dry.candidates.find((c) => c.campaignId === campaign.id)).toMatchObject({ reason: 'ADMIN_KILL', amountMinor: '500000' });
    expect(await intentsFor(campaign.id)).toHaveLength(0);
    const live = await backfillAdRefundIntents(prisma, { dryRun: false, actor: 'admin', campaignIds: [campaign.id] });
    expect(live.created).toBeGreaterThanOrEqual(1);
    const [intent] = await intentsFor(campaign.id);
    expect(intent).toMatchObject({ status: 'MANUAL_REQUIRED', provider: 'LEGACY_BACKFILL', amountMinor: 500000n, reason: 'ADMIN_KILL' });
    expect(intent!.outbox).toBeNull(); // nothing to execute: the legacy executor already moved the money
    expect(Number((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedAmount)).toBe(5000);
    expect((await scanAdRefunds(prisma)).terminalWithoutIntent.some((t) => t.campaignId === campaign.id)).toBe(false);
    expect((await backfillAdRefundIntents(prisma, { dryRun: false, campaignIds: [campaign.id] })).candidates.some((c) => c.campaignId === campaign.id)).toBe(false);
  });
});
