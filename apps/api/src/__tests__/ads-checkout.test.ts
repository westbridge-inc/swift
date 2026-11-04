import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { AdCheckoutService } from '../modules/ads/checkout.service';
import { BookingService } from '../modules/ads/booking.service';

// Ads Phase 2b — checkout & payment (ads-platform spec §8.1/§8.2). Reserve →
// invoice → mark-paid confirms bookings and moves the campaign into review;
// an expired hold voids the invoice and returns the campaign to DRAFT.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const checkout = new AdCheckoutService(prisma, io);
const booking = new BookingService(prisma);

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const invoiceIds: string[] = [];
const userIds: string[] = [];
const MON = new Date('2026-08-03T00:00:00Z');

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  // [R045-ADS] a late capture leaves a durable refund intent that references the invoice
  // The refund outbox, intents and items are IMMUTABLE by trigger (deletes are refused) and they RESTRICT
  // their invoice, booking and campaign — so the ads-money fixtures stay in place; every id is unique per run.
  await prisma.adsAuditLog.deleteMany({ where: { entityId: { in: invoiceIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function makeApprovedAdvertiser() {
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  return a;
}
async function makePlacement() {
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  return p;
}
async function makeDraft(advertiserId: string, placementId: string, week = MON) {
  const c = await prisma.adCampaign.create({ data: { advertiserId, placementId, name: 'C', cities: ['*'], startWeek: week, endWeek: week, status: 'DRAFT' } });
  campaignIds.push(c.id);
  return c;
}

describe('§8.1 checkout', () => {
  it('rejects synthetic providers in production before reserving or invoicing', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(checkout.checkout(c.id, 'MOCK')).rejects.toMatchObject({
        code: 'ADS_PAYMENT_PROVIDER_UNAVAILABLE',
      });
      await expect(checkout.checkout(c.id, 'MMG')).rejects.toMatchObject({
        code: 'ADS_PAYMENT_PROVIDER_UNAVAILABLE',
      });
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('DRAFT');
    expect(await prisma.adBooking.count({ where: { campaignId: c.id } })).toBe(0);
    expect(await prisma.adInvoice.count({ where: { campaignId: c.id } })).toBe(0);
  });

  // [ADS-ON · owner ruling 3 Nov] The server decides how an invoice is paid: in production, MMG's checkout.
  it('in production with the switch off, no invoice is issued and no slot is held', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(checkout.checkout(c.id, 'MANUAL')).rejects.toMatchObject({ code: 'ADS_PAYMENT_PROVIDER_UNAVAILABLE' });
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
    expect(await prisma.adInvoice.count({ where: { campaignId: c.id } })).toBe(0);
    expect(await prisma.adBooking.count({ where: { campaignId: c.id } })).toBe(0);
  });

  it('in production with the switch on, the invoice is MMG\'s whatever a client asks for: the app in the stores asks for MANUAL', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    process.env['ADS_MMG_CHECKOUT'] = '1';
    try {
      const { invoice } = await checkout.checkout(c.id, 'MANUAL');
      invoiceIds.push(invoice.id);
      expect(invoice.provider).toBe('MMG');
      expect(invoice.paymentUrl).toBeNull();
    } finally {
      delete process.env['ADS_MMG_CHECKOUT'];
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('reserves, issues an ADS-{year}-{seq} invoice, and is idempotent per campaign', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);

    const { invoice, reservedUntil } = await checkout.checkout(c.id, 'MOCK');
    invoiceIds.push(invoice.id);
    expect(invoice.number).toMatch(/^ADS-\d{4}-\d{6}$/);
    expect(invoice.status).toBe('UNPAID');
    expect(Number(invoice.amount)).toBe(5000);
    expect(invoice.paymentUrl).toContain('mock://');
    expect(reservedUntil).toBeInstanceOf(Date);
    // Reservation happened: campaign PENDING_PAYMENT, 1 booking RESERVED.
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PENDING_PAYMENT');
    expect(await prisma.adBooking.count({ where: { campaignId: c.id, status: 'RESERVED' } })).toBe(1);

    // Idempotent: a second checkout returns the SAME invoice, no double-book.
    const again = await checkout.checkout(c.id, 'MOCK');
    expect(again.invoice.id).toBe(invoice.id);
    expect(await prisma.adBooking.count({ where: { campaignId: c.id } })).toBe(1);
  });

  it('refuses checkout for a non-approved advertiser', async () => {
    const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'PENDING_REVIEW' } });
    advertiserIds.push(a.id);
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    await expect(checkout.checkout(c.id, 'MOCK')).rejects.toThrow(/approved/i);
  });
});

describe('§8.2 mark-paid', () => {
  it('confirms bookings, moves the campaign to PENDING_REVIEW, and is idempotent', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const { invoice } = await checkout.checkout(c.id, 'MOCK');
    invoiceIds.push(invoice.id);

    const providerRef = `MMG-${nanoid(8)}`;
    const paid = await checkout.markPaid(invoice.id, { providerRef });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PENDING_REVIEW');
    expect(await prisma.adBooking.count({ where: { campaignId: c.id, status: 'CONFIRMED' } })).toBe(1);
    expect(await prisma.adsAuditLog.findFirst({ where: { entityId: invoice.id, action: 'INVOICE_MARK_PAID' } })).not.toBeNull();

    // Idempotent replay (a re-fired webhook): still one PAID invoice, unchanged.
    const replay = await checkout.markPaid(invoice.id, { providerRef });
    expect(replay.status).toBe('PAID');
    expect(replay.paidAt?.getTime()).toBe(paid.paidAt?.getTime());
    // [ADS-ON] Another payment on a paid invoice is real money: it is refused, never answered "already paid".
    await expect(checkout.markPaid(invoice.id, { providerRef: 'a-second-payment' })).rejects.toMatchObject({ code: 'AD_INVOICE_ALREADY_PAID' });
    expect((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).providerRef).toBe(providerRef);
  });

  // [ADS-ON] A clash in the old count-and-retry could never retry: Postgres had aborted the transaction.
  it('an invoice number follows the highest one, so a gap never names a number already taken', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const first = await checkout.checkout((await makeDraft(a.id, p.id)).id, 'MOCK');
    invoiceIds.push(first.invoice.id);
    const taken = Number(first.invoice.number.split('-')[2]) + 2;
    const year = first.invoice.number.split('-')[1];
    const holder = await prisma.adInvoice.create({ data: { advertiserId: a.id, campaignId: first.invoice.campaignId, number: `ADS-${year}-${String(taken).padStart(6, '0')}`, amount: 1, status: 'VOID' } });
    invoiceIds.push(holder.id);
    const next = await checkout.checkout((await makeDraft(a.id, p.id, new Date('2026-08-10T00:00:00Z'))).id, 'MOCK');
    invoiceIds.push(next.invoice.id);
    expect(Number(next.invoice.number.split('-')[2])).toBe(taken + 1);
  });

  it('checkouts at the same instant each get their own number', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const weeks = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
    const drafts = await Promise.all(weeks.map((w) => makeDraft(a.id, p.id, new Date(`${w}T00:00:00Z`))));
    const out = await Promise.all(drafts.map((c) => checkout.checkout(c.id, 'MOCK')));
    invoiceIds.push(...out.map((o) => o.invoice.id));
    expect(new Set(out.map((o) => o.invoice.number)).size).toBe(weeks.length);
  });
});

describe('§6.1 reservation_expired', () => {
  it('an expired hold releases the slot, voids the invoice, and returns the campaign to DRAFT', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const { invoice } = await checkout.checkout(c.id, 'MOCK');
    invoiceIds.push(invoice.id);
    // Force the hold into the past.
    await prisma.adBooking.updateMany({ where: { campaignId: c.id }, data: { reservedUntil: new Date(Date.now() - 60_000) } });

    const res = await booking.releaseExpired();
    expect(res.released).toBeGreaterThanOrEqual(1);
    expect(res.voided).toBeGreaterThanOrEqual(1);
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('DRAFT');
    expect((await prisma.adInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('VOID');
    expect((await prisma.adInventoryWeek.findUniqueOrThrow({ where: { placementId_city_weekStart: { placementId: p.id, city: '*', weekStart: MON } } })).booked).toBe(0);
    // [R045-ADS-05] Money that arrives for the VOID invoice is a late capture:
    // recorded as paid, the campaign stays in DRAFT with no inventory confirmed,
    // and the full amount becomes a refund obligation — never a hybrid.
    const late = await checkout.markPaid(invoice.id, { providerRef: `late-${nanoid(6)}` });
    expect(late.status).toBe('PAID');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('DRAFT');
    expect(await prisma.adBooking.count({ where: { campaignId: c.id, status: 'CONFIRMED' } })).toBe(0);
    expect(await prisma.adRefundIntent.count({ where: { campaignId: c.id, reason: 'LATE_CAPTURE' } })).toBe(1);
  });
});
