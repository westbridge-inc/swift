import type { PrismaClient, AdInvoice } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { BookingService } from './booking.service';
import { isProduction } from '../../utils/runtime-mode';

// Ad checkout & payment (ads-platform spec §8.1/§8.2). Ad money is PLATFORM
// revenue paid UPFRONT — it reuses the subscription rails' discipline
// (idempotent by provider ref, integer-minor money as Decimal) but is a
// one-time invoice, not a recurring MIT charge. The LIVE hosted-checkout URL
// (MMG Merchant Checkout / PowerTranz hosted page) is a FOUNDER/acquirer-gated
// integration exactly like the PowerTranz-MIT billing item; until those
// credentials exist, checkout issues the invoice + a mock/pending payment URL
// and the audited mark-paid path (§8.2 "Caribbean reality path") settles it —
// which is also the real webhook's settlement action.

export type AdPaymentProvider = 'MOCK' | 'MMG' | 'POWERTRANZ' | 'MANUAL';

export class AdCheckoutService {
  private notifications: NotificationService;
  private booking: BookingService;
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
    this.booking = new BookingService(prisma);
  }

  /** §8.1 — reserve (if not already) + issue the invoice. Idempotent: an
   *  existing UNPAID invoice for the campaign is returned rather than forked. */
  async checkout(campaignId: string, provider: AdPaymentProvider, reservationMinutes = 20): Promise<{ invoice: AdInvoice; reservedUntil: Date | null }> {
    // The hosted MMG/PowerTranz checkout adapters are not implemented here yet;
    // MANUAL is the honest production invoice path. Fail before reading or
    // reserving inventory so a synthetic provider cannot mutate production.
    if (isProduction() && provider !== 'MANUAL') {
      throw new AppError(
        503,
        'ADS_PAYMENT_PROVIDER_UNAVAILABLE',
        'Only audited manual invoice payment is available for ads right now.',
      );
    }
    const campaign = await this.prisma.adCampaign.findUnique({
      where: { id: campaignId },
      include: { advertiser: { select: { status: true } } },
    });
    if (!campaign) throw new NotFoundError('AdCampaign', campaignId);
    if (campaign.advertiser.status !== 'APPROVED') {
      throw new AppError(403, 'ADVERTISER_NOT_APPROVED', 'Your advertiser account must be approved before checkout.');
    }
    if (campaign.status !== 'DRAFT' && campaign.status !== 'PENDING_PAYMENT') {
      throw new AppError(409, 'CAMPAIGN_NOT_CHECKOUTABLE', `A ${campaign.status} campaign cannot check out.`);
    }

    // Ensure inventory is held. Only reserve from DRAFT — re-reserving a
    // PENDING_PAYMENT campaign would double-book. The reserve result carries
    // the locked total, which we stamp onto the campaign here (the DRAFT →
    // PENDING_PAYMENT transition owned by checkout, not the caller).
    if (campaign.status === 'DRAFT') {
      const r = await this.booking.reserve(campaignId, { reservationMinutes });
      await this.prisma.adCampaign.update({ where: { id: campaignId }, data: { status: 'PENDING_PAYMENT', totalAmount: r.total } });
    }
    const fresh = await this.prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    const amount = fresh.totalAmount ?? new Prisma.Decimal(0);

    // Idempotent invoice: reuse an open UNPAID one.
    const open = await this.prisma.adInvoice.findFirst({ where: { campaignId, status: 'UNPAID' } });
    const invoice = open ?? await this.createInvoice(fresh.tenantId, fresh.advertiserId, campaignId, amount, fresh.currency, provider);

    const nextExpiry = await this.prisma.adBooking.findFirst({
      where: { campaignId, status: 'RESERVED' },
      orderBy: { reservedUntil: 'asc' },
      select: { reservedUntil: true },
    });
    return { invoice, reservedUntil: nextExpiry?.reservedUntil ?? null };
  }

  /** ADS-{YYYY}-{seq}, per-year monotonic. @unique(number) + a small retry
   *  covers the count race. */
  private async createInvoice(tenantId: string, advertiserId: string, campaignId: string, amount: Prisma.Decimal, currency: string, provider: AdPaymentProvider): Promise<AdInvoice> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await this.prisma.adInvoice.count({ where: { number: { startsWith: `ADS-${year}-` } } });
      const number = `ADS-${year}-${String(count + 1 + attempt).padStart(6, '0')}`;
      try {
        return await this.prisma.adInvoice.create({
          data: {
            tenantId, advertiserId, campaignId, number,
            amount, currency, provider,
            paymentUrl: provider === 'MOCK' ? `mock://ads-checkout/${campaignId}` : null,
          },
        });
      } catch (err) {
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue; // number raced — retry
        throw err;
      }
    }
    throw new AppError(500, 'INVOICE_NUMBER_RACE', 'Could not allocate an invoice number — retry.');
  }

  /** §8.2 payment confirmation — the ONE settlement action, reached by both the
   *  provider webhook and the admin "mark paid" button. Idempotent by
   *  providerRef: a replayed callback returns the already-paid invoice. Moves
   *  the campaign PENDING_PAYMENT → PENDING_REVIEW and confirms every booking.
   *  manualReference is required on the admin path (audit). */
  async markPaid(invoiceId: string, opts: { providerRef?: string; adminUserId?: string; manualReference?: string }): Promise<AdInvoice> {
    const invoice = await this.prisma.adInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('AdInvoice', invoiceId);
    if (invoice.status === 'PAID') {
      return invoice; // idempotent replay
    }
    if (invoice.status !== 'UNPAID') {
      throw new AppError(409, 'INVOICE_NOT_PAYABLE', `A ${invoice.status} invoice cannot be marked paid.`);
    }
    if (opts.adminUserId && !opts.manualReference) {
      throw new AppError(400, 'REFERENCE_REQUIRED', 'A payment reference note is required to mark an invoice paid.');
    }

    const paidAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.adInvoice.updateMany({
        where: { id: invoiceId, status: 'UNPAID' },
        data: { status: 'PAID', paidAt, providerRef: opts.providerRef ?? invoice.providerRef ?? null, provider: opts.adminUserId ? 'MANUAL' : invoice.provider },
      });
      if (claimed.count === 0) throw new AppError(409, 'INVOICE_SETTLE_RACE', 'The invoice changed underneath this settlement.');
      // Bookings RESERVED → CONFIRMED (the slot stays held; no inventory change).
      await tx.adBooking.updateMany({ where: { campaignId: invoice.campaignId, status: 'RESERVED' }, data: { status: 'CONFIRMED' } });
      // Campaign PENDING_PAYMENT → PENDING_REVIEW (enters the creative queue).
      await tx.adCampaign.updateMany({ where: { id: invoice.campaignId, status: 'PENDING_PAYMENT' }, data: { status: 'PENDING_REVIEW' } });
      await tx.adsAuditLog.create({
        data: {
          tenantId: invoice.tenantId, actorUserId: opts.adminUserId ?? 'system:webhook',
          action: 'INVOICE_MARK_PAID', entityType: 'AdInvoice', entityId: invoiceId,
          reason: opts.manualReference ?? opts.providerRef ?? null,
        },
      });
    });

    log().info({ invoiceId, campaignId: invoice.campaignId, via: opts.adminUserId ? 'admin' : 'provider' }, 'ad invoice paid — campaign → PENDING_REVIEW');
    await notifyAdmins(this.prisma, this.notifications, {
      // Scoped to the subject's tenant [NOC-A F45].
      tenantId: invoice.tenantId ?? null,
      title: 'Ad campaign paid — ready for creative review',
      body: `Invoice ${invoice.number} is paid. Its campaign is now in the creative review queue.`,
      data: { kind: 'ad_campaign_paid', campaignId: invoice.campaignId, invoiceNumber: invoice.number },
    }).catch(() => {});
    // §16 "payment received" goes to BOTH sides — the advertiser gets a receipt.
    const { notifyAdvertiserOwners } = await import('./ads-notify');
    await notifyAdvertiserOwners(this.prisma, this.notifications, invoice.advertiserId, {
      title: `Payment received — ${invoice.number}`,
      body: `We received ${invoice.currency} ${Number(invoice.amount).toLocaleString('en-US')}. Your campaign is now in creative review.`,
      kind: 'ad_invoice_receipt',
      data: { campaignId: invoice.campaignId, invoiceNumber: invoice.number },
    }).catch(() => {});
    return this.prisma.adInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  }
}
