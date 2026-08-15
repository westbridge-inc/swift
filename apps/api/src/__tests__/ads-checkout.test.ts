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
  await prisma.adInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await prisma.adsAuditLog.deleteMany({ where: { entityId: { in: invoiceIds } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
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
async function makeDraft(advertiserId: string, placementId: string) {
  const c = await prisma.adCampaign.create({ data: { advertiserId, placementId, name: 'C', cities: ['*'], startWeek: MON, endWeek: MON, status: 'DRAFT' } });
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

  it('uses an honest manual invoice path in production', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const { invoice } = await checkout.checkout(c.id, 'MANUAL');
      invoiceIds.push(invoice.id);
      expect(invoice.provider).toBe('MANUAL');
      expect(invoice.paymentUrl).toBeNull();
    } finally {
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

    const paid = await checkout.markPaid(invoice.id, { adminUserId: 'admin-1', manualReference: 'MMG txn 88213' });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PENDING_REVIEW');
    expect(await prisma.adBooking.count({ where: { campaignId: c.id, status: 'CONFIRMED' } })).toBe(1);
    expect(await prisma.adsAuditLog.findFirst({ where: { entityId: invoice.id, action: 'INVOICE_MARK_PAID' } })).not.toBeNull();

    // Idempotent replay (a re-fired webhook): still one PAID invoice, unchanged.
    const replay = await checkout.markPaid(invoice.id, { providerRef: 'dup' });
    expect(replay.status).toBe('PAID');
    expect(replay.paidAt?.getTime()).toBe(paid.paidAt?.getTime());
  });

  it('the admin path requires a reference note', async () => {
    const a = await makeApprovedAdvertiser();
    const p = await makePlacement();
    const c = await makeDraft(a.id, p.id);
    const { invoice } = await checkout.checkout(c.id, 'MOCK');
    invoiceIds.push(invoice.id);
    await expect(checkout.markPaid(invoice.id, { adminUserId: 'admin-1' })).rejects.toThrow(/reference/i);
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
    // A VOID invoice cannot then be marked paid.
    await expect(checkout.markPaid(invoice.id, { providerRef: 'late' })).rejects.toThrow(/cannot be marked paid/i);
  });
});
