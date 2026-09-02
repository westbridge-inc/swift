import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AdCheckoutService } from '../modules/ads/checkout.service';
import { BookingService } from '../modules/ads/booking.service';
import { AdsRefundService } from '../modules/ads/refund.service';
import { scanAdCheckout } from '../modules/ads/checkout-scan';

// ---------------------------------------------------------------------------
// [R045-ADS-04 · 05 · 06] The ad checkout aggregate.
//
// The register's red tests: concurrent checkout and markPaid with the same
// and different provider references yield one invoice and one transition; a
// barrier race between expiry and payment confirmation never produces a
// hybrid — the result is paid with confirmed inventory, or expired with the
// campaign back in DRAFT and its invoice VOID, and a late external capture
// becomes a durable refund obligation; a failed campaign update after a
// reservation rolls the reservation back.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const checkout = new AdCheckoutService(prisma, io);
const booking = new BookingService(prisma);
const refunds = new AdsRefundService(prisma, io);
const advertiserIds: string[] = []; const placementIds: string[] = []; const campaignIds: string[] = [];
const MON = new Date('2026-11-02T00:00:00Z');

beforeAll(async () => { await prisma.$connect(); delete process.env['AD_CHECKOUT_KILL']; delete process.env['AD_PAYMENT_CONFIRM_MANUAL_ONLY']; });
afterAll(async () => {
  // The refund outbox, intents and items are IMMUTABLE by trigger (deletes are refused) and they RESTRICT
  // their invoice, booking and campaign — so the ads-money fixtures stay in place; every id is unique per run.
  await prisma.adsAuditLog.deleteMany({ where: { OR: [{ entityId: { in: campaignIds } }, { entityType: 'AdInvoice', entity: undefined }] } }).catch(() => {});
  await prisma.$disconnect();
});

async function scaffold(status: 'DRAFT' | 'PENDING_PAYMENT' = 'DRAFT') {
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', status: 'APPROVED', createdByUserId: 'test' } });
  advertiserIds.push(a.id);
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: `C ${nanoid(4)}`, cities: ['*'], startWeek: MON, endWeek: MON, status } });
  campaignIds.push(c.id);
  return { advertiser: a, placement: p, campaign: c };
}
const invoicesOf = (campaignId: string) => prisma.adInvoice.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
const bookingsOf = (campaignId: string) => prisma.adBooking.findMany({ where: { campaignId } });
const campaignOf = (id: string) => prisma.adCampaign.findUniqueOrThrow({ where: { id } });

describe('[R045-ADS-04] one campaign, one active invoice, one provider reference', () => {
  it('ten concurrent checkouts on one draft yield one invoice, one reservation and one PENDING_PAYMENT', async () => {
    const { campaign } = await scaffold();
    const results = await Promise.all(Array.from({ length: 10 }, () => checkout.checkout(campaign.id, 'MOCK')));
    const ids = new Set(results.map((r) => r.invoice.id));
    expect(ids.size).toBe(1);
    expect(await invoicesOf(campaign.id)).toHaveLength(1);
    expect((await invoicesOf(campaign.id))[0]!.status).toBe('UNPAID');
    expect(await bookingsOf(campaign.id)).toHaveLength(1);
    expect((await campaignOf(campaign.id)).status).toBe('PENDING_PAYMENT');
    expect((await prisma.adInventoryWeek.findFirstOrThrow({ where: { placementId: campaign.placementId, weekStart: MON } })).booked).toBe(1);
  });
  it('a second checkout WAITS for the first (the campaign lock), then finds its invoice — never a second booking or invoice', async () => {
    const { campaign } = await scaffold();
    const bookingSvc = (checkout as unknown as { booking: BookingService }).booking;
    let firstCommittedAt = 0;
    bookingSvc.observer = { afterLock: async () => { await new Promise((r) => setTimeout(r, 400)); firstCommittedAt = Date.now(); } };
    try {
      const first = checkout.checkout(campaign.id, 'MOCK');
      await new Promise((r) => setTimeout(r, 50));
      bookingSvc.observer = {}; // the second checkout must not sleep — it must WAIT on the lock
      const second = checkout.checkout(campaign.id, 'MOCK');
      const [a, b] = await Promise.all([first, second.then((r) => ({ ...r, finishedAt: Date.now() }))]);
      expect(b.finishedAt).toBeGreaterThanOrEqual(firstCommittedAt);
      expect(b.invoice.id).toBe(a.invoice.id);
    } finally {
      bookingSvc.observer = {};
    }
    expect(await bookingsOf(campaign.id)).toHaveLength(1);
    expect(await invoicesOf(campaign.id)).toHaveLength(1);
  });
  it('the database refuses a second open invoice for one campaign and a reused provider reference', async () => {
    const { campaign, advertiser } = await scaffold();
    const { invoice } = await checkout.checkout(campaign.id, 'MOCK');
    await expect(prisma.adInvoice.create({ data: { advertiserId: advertiser.id, campaignId: campaign.id, number: `ADS-2026-${nanoid(6)}`, amount: 5000, currency: 'GYD', status: 'UNPAID' } })).rejects.toThrow(/ad_invoices_one_unpaid_per_campaign_key|Unique constraint/);
    await prisma.adInvoice.update({ where: { id: invoice.id }, data: { providerRef: `PR-${campaign.id}` } });
    const other = await scaffold();
    const second = await checkout.checkout(other.campaign.id, 'MOCK');
    await expect(prisma.adInvoice.update({ where: { id: second.invoice.id }, data: { providerRef: `PR-${campaign.id}` } })).rejects.toThrow(/ad_invoices_providerRef_unique_key|Unique constraint/);
  });
  it('ten concurrent settlements with the same reference make one transition; a different invoice with that reference is refused; a replay returns the paid invoice', async () => {
    const { campaign } = await scaffold();
    const { invoice } = await checkout.checkout(campaign.id, 'MOCK');
    const ref = `MMG-${nanoid(8)}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => checkout.markPaid(invoice.id, { providerRef: ref })));
    expect(results.every((r) => r.status === 'PAID')).toBe(true);
    expect(await prisma.adsAuditLog.count({ where: { entityId: invoice.id, action: 'INVOICE_MARK_PAID' } })).toBe(1);
    expect((await bookingsOf(campaign.id)).map((b) => b.status)).toEqual(['CONFIRMED']);
    expect((await campaignOf(campaign.id)).status).toBe('PENDING_REVIEW');
    const replay = await checkout.markPaid(invoice.id, { providerRef: 'another-ref' });
    expect(replay.providerRef).toBe(ref); // the invoice is settled once, under its first reference
    const other = await scaffold();
    const second = await checkout.checkout(other.campaign.id, 'MOCK');
    await expect(checkout.markPaid(second.invoice.id, { providerRef: ref })).rejects.toThrow(/already settled another invoice/);
    expect((await invoicesOf(other.campaign.id))[0]!.status).toBe('UNPAID');
  });
});

describe('[R045-ADS-05] the barrier race between expiry and confirmation never produces a hybrid', () => {
  async function expiredHold() {
    const { campaign, advertiser, placement } = await scaffold();
    const { invoice } = await checkout.checkout(campaign.id, 'MOCK', 20);
    await prisma.adBooking.updateMany({ where: { campaignId: campaign.id }, data: { reservedUntil: new Date(Date.now() - 60_000) } });
    return { campaign, advertiser, placement, invoice };
  }
  it('confirmation holds the lock while expiry contends: paid with confirmed inventory, nothing voided', async () => {
    const { campaign, invoice } = await expiredHold();
    let sweep: Promise<{ released: number; voided: number }> | null = null;
    checkout.observer = {
      afterLock: async () => {
        sweep = booking.releaseExpired(new Date()); // blocks on the campaign lock until we commit
        await new Promise((r) => setTimeout(r, 300));
      },
    };
    try {
      const paid = await checkout.markPaid(invoice.id, { providerRef: `MMG-${nanoid(6)}` });
      expect(paid.status).toBe('PAID');
    } finally {
      checkout.observer = {};
    }
    const swept = await sweep!;
    expect(swept.voided).toBe(0);
    expect((await bookingsOf(campaign.id)).map((b) => b.status)).toEqual(['CONFIRMED']);
    expect((await campaignOf(campaign.id)).status).toBe('PENDING_REVIEW');
    expect((await invoicesOf(campaign.id))[0]!.status).toBe('PAID');
  });
  it('expiry wins: the campaign is DRAFT and the invoice VOID; the late capture then records the money and stages a full refund obligation — never a paid campaign with no inventory', async () => {
    const { campaign, invoice, placement } = await expiredHold();
    const swept = await booking.releaseExpired(new Date());
    expect(swept.voided).toBeGreaterThanOrEqual(1);
    expect((await campaignOf(campaign.id)).status).toBe('DRAFT');
    expect((await invoicesOf(campaign.id))[0]!.status).toBe('VOID');
    expect((await bookingsOf(campaign.id)).map((b) => b.status)).toEqual(['RELEASED']);
    expect((await prisma.adInventoryWeek.findFirstOrThrow({ where: { placementId: placement.id, weekStart: MON } })).booked).toBe(0);
    // the money arrives anyway
    const late = await checkout.markPaid(invoice.id, { providerRef: `MMG-${nanoid(6)}` });
    expect(late.status).toBe('PAID');
    const after = await campaignOf(campaign.id);
    expect(after.status).toBe('DRAFT');
    expect(after.statusReason).toContain('refund staged');
    expect((await bookingsOf(campaign.id)).map((b) => b.status)).toEqual(['RELEASED']); // inventory stays released
    const intent = await prisma.adRefundIntent.findFirstOrThrow({ where: { campaignId: campaign.id }, include: { items: true, outbox: true } });
    expect(intent).toMatchObject({ reason: 'LATE_CAPTURE', status: 'PENDING', amountMinor: 500000n, invoiceId: invoice.id });
    expect(intent.items).toHaveLength(1);
    expect(intent.outbox).not.toBeNull();
    // a replayed capture is the same obligation
    await checkout.markPaid(invoice.id, { providerRef: `MMG-${nanoid(6)}` });
    expect(await prisma.adRefundIntent.count({ where: { campaignId: campaign.id } })).toBe(1);
    // executed: the full amount is owed back, nothing is flipped, the invoice shows it
    await refunds.executeNow(intent.id);
    expect((await prisma.adRefundIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('MANUAL_REQUIRED');
    expect(Number((await invoicesOf(campaign.id))[0]!.refundedAmount)).toBe(5000);
    expect((await scanAdCheckout(prisma)).paidWithoutInventory.some((p) => p.campaignId === campaign.id)).toBe(false); // DRAFT is not a paid, serving campaign
  });
});

describe('[R045-ADS-06] the reservation and the campaign status are one write', () => {
  it('a failed campaign update after the reservation rolls the reservation back — no RESERVED inventory on a DRAFT', async () => {
    const { campaign, placement } = await scaffold();
    await expect(booking.reserveAndHold(campaign.id, { within: async () => { throw new Error('second write failed'); } })).rejects.toThrow('second write failed');
    expect(await bookingsOf(campaign.id)).toHaveLength(0);
    expect((await campaignOf(campaign.id)).status).toBe('DRAFT');
    expect((await prisma.adInventoryWeek.findFirstOrThrow({ where: { placementId: placement.id, weekStart: MON } })).booked).toBe(0);
    const ok = await booking.reserveAndHold(campaign.id, {});
    expect(ok.bookings).toBe(1);
    expect((await campaignOf(campaign.id)).status).toBe('PENDING_PAYMENT');
  });
  it('the reserve route no longer splits the two writes (source pin)', () => {
    const src = readFileSync(path.join(__dirname, '..', 'modules/ads/ads.routes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain('booking.reserveAndHold(campaign.id');
    expect(src).not.toContain('booking.reserve(campaign.id');
  });
});

describe('operations: rollback switches and the scan', () => {
  it('checkout unavailable rather than ambiguous; confirmation routed to manual review', async () => {
    const { campaign } = await scaffold();
    process.env['AD_CHECKOUT_KILL'] = '1';
    try {
      await expect(checkout.checkout(campaign.id, 'MOCK')).rejects.toThrow(/paused/);
      expect(await bookingsOf(campaign.id)).toHaveLength(0);
    } finally { delete process.env['AD_CHECKOUT_KILL']; }
    const { invoice } = await checkout.checkout(campaign.id, 'MOCK');
    process.env['AD_PAYMENT_CONFIRM_MANUAL_ONLY'] = '1';
    try {
      await expect(checkout.markPaid(invoice.id, { providerRef: 'hook' })).rejects.toThrow(/confirms this invoice by hand/);
      expect((await invoicesOf(campaign.id))[0]!.status).toBe('UNPAID');
      const paid = await checkout.markPaid(invoice.id, { adminUserId: 'admin', manualReference: 'bank ref' });
      expect(paid.status).toBe('PAID');
    } finally { delete process.env['AD_PAYMENT_CONFIRM_MANUAL_ONLY']; }
  });
  it('the scan names a paid campaign with no confirmed inventory and a campaign with two active invoices', async () => {
    const { campaign, advertiser } = await scaffold('PENDING_PAYMENT');
    await prisma.adInvoice.create({ data: { advertiserId: advertiser.id, campaignId: campaign.id, number: `ADS-2026-${nanoid(6)}`, amount: 5000, currency: 'GYD', status: 'PAID', paidAt: new Date() } });
    await prisma.adInvoice.create({ data: { advertiserId: advertiser.id, campaignId: campaign.id, number: `ADS-2026-${nanoid(6)}`, amount: 5000, currency: 'GYD', status: 'PAID', paidAt: new Date() } });
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'SCHEDULED' } });
    const scan = await scanAdCheckout(prisma);
    expect(scan.paidWithoutInventory.some((p) => p.campaignId === campaign.id)).toBe(true);
    expect(scan.duplicateActiveInvoices.find((d) => d.campaignId === campaign.id)?.invoices).toBe(2);
  });
});
