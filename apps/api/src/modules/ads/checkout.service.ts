import type { PrismaClient, AdInvoice } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { BookingService, lockCampaign } from './booking.service';
import { AdsRefundService } from './refund.service';
import { adCheckoutCounter } from '../../plugins/observability';
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

/** Test seam: runs inside markPaid's transaction after the campaign lock is
 *  held, so a proof can let the expiry sweep contend for the same lock and
 *  watch the two serialize. Never set in routes. */
export interface AdCheckoutObserver {
  afterLock?: (campaignId: string) => Promise<void>;
}

export function adCheckoutKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['AD_CHECKOUT_KILL'] === '1';
}
export function adPaymentConfirmManualOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env['AD_PAYMENT_CONFIRM_MANUAL_ONLY'] === '1';
}

export class AdCheckoutService {
  private notifications: NotificationService;
  private booking: BookingService;
  private refunds: AdsRefundService;
  observer: AdCheckoutObserver = {};
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
    this.booking = new BookingService(prisma);
    this.refunds = new AdsRefundService(prisma, io);
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
    // [R045-ADS-04] Rollback makes checkout unavailable rather than ambiguous.
    if (adCheckoutKilled()) throw new AppError(503, 'ADS_CHECKOUT_UNAVAILABLE', 'Ad checkout is paused — try again shortly.');

    // [R045-ADS-04 · 06] ONE transaction under the campaign lock: the hold
    // (if still DRAFT), the campaign's status and the invoice commit together,
    // and concurrent checkouts serialize — the second one finds the first
    // one's open invoice. The database holds the floor: one UNPAID invoice
    // per campaign (partial unique), one provider reference per payment.
    let invoice: AdInvoice | null = null;
    await this.booking.reserveAndHold(campaignId, {
      reservationMinutes,
      within: async (tx) => {
        const fresh = await tx.adCampaign.findUniqueOrThrow({ where: { id: campaignId } });
        const active = await tx.adInvoice.findMany({ where: { campaignId, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' } });
        const open = active.find((i) => i.status === 'UNPAID');
        if (open) { invoice = open; return; }
        if (active.length > 0) {
          adCheckoutCounter.labels('duplicate_invoice_refused').inc();
          throw new AppError(409, 'CAMPAIGN_ALREADY_INVOICED', 'This campaign already has a settled invoice.');
        }
        invoice = await this.createInvoice(tx, fresh.tenantId, fresh.advertiserId, campaignId, fresh.totalAmount ?? new Prisma.Decimal(0), fresh.currency, provider);
      },
    });
    if (!invoice) throw new AppError(500, 'INVOICE_MISSING', 'Checkout did not produce an invoice.');

    const nextExpiry = await this.prisma.adBooking.findFirst({
      where: { campaignId, status: 'RESERVED' },
      orderBy: { reservedUntil: 'asc' },
      select: { reservedUntil: true },
    });
    return { invoice, reservedUntil: nextExpiry?.reservedUntil ?? null };
  }

  /** ADS-{YYYY}-{seq}, per-year monotonic. @unique(number) + a small retry
   *  covers the count race. */
  private async createInvoice(db: Prisma.TransactionClient, tenantId: string, advertiserId: string, campaignId: string, amount: Prisma.Decimal, currency: string, provider: AdPaymentProvider): Promise<AdInvoice> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await db.adInvoice.count({ where: { number: { startsWith: `ADS-${year}-` } } });
      const number = `ADS-${year}-${String(count + 1 + attempt).padStart(6, '0')}`;
      try {
        return await db.adInvoice.create({
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
    const head = await this.prisma.adInvoice.findUnique({ where: { id: invoiceId } });
    if (!head) throw new NotFoundError('AdInvoice', invoiceId);
    if (head.status === 'PAID') {
      return head; // idempotent replay
    }
    if (opts.adminUserId && !opts.manualReference) {
      throw new AppError(400, 'REFERENCE_REQUIRED', 'A payment reference note is required to mark an invoice paid.');
    }
    // [R045-ADS-05] Rollback routes confirmation to manual review.
    if (!opts.adminUserId && adPaymentConfirmManualOnly()) {
      throw new AppError(503, 'ADS_CONFIRMATION_MANUAL_ONLY', 'Automatic payment confirmation is paused — an operator confirms this invoice by hand.');
    }

    const paidAt = new Date();
    let lateCapture = false;
    await this.prisma.$transaction(async (tx) => {
      // [R045-ADS-04 · 05] ONE serializable transition under the campaign lock —
      // the same lock the expiry sweep takes. Every step is count-checked;
      // any miss rolls the whole thing back.
      await lockCampaign(tx, head.campaignId);
      await this.observer.afterLock?.(head.campaignId);
      const invoice = await tx.adInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (invoice.status === 'PAID') return; // settled under the lock by a peer
      if (opts.providerRef) {
        const reused = await tx.adInvoice.findFirst({ where: { providerRef: opts.providerRef, id: { not: invoiceId } }, select: { id: true } });
        if (reused) {
          adCheckoutCounter.labels('provider_ref_reused').inc();
          throw new AppError(409, 'PROVIDER_REF_REUSED', 'This payment reference already settled another invoice.');
        }
      }
      const reserved = await tx.adBooking.count({ where: { campaignId: invoice.campaignId, status: 'RESERVED' } });
      const campaign = await tx.adCampaign.findUniqueOrThrow({ where: { id: invoice.campaignId }, select: { status: true } });
      if (invoice.status === 'UNPAID' && reserved > 0 && campaign.status === 'PENDING_PAYMENT') {
        const claimed = await tx.adInvoice.updateMany({
          where: { id: invoiceId, status: 'UNPAID' },
          data: { status: 'PAID', paidAt, providerRef: opts.providerRef ?? invoice.providerRef ?? null, provider: opts.adminUserId ? 'MANUAL' : invoice.provider },
        });
        if (claimed.count !== 1) throw new AppError(409, 'INVOICE_SETTLE_RACE', 'The invoice changed underneath this settlement.');
        const confirmed = await tx.adBooking.updateMany({ where: { campaignId: invoice.campaignId, status: 'RESERVED' }, data: { status: 'CONFIRMED' } });
        if (confirmed.count !== reserved) throw new AppError(409, 'INVENTORY_SETTLE_RACE', 'The held inventory changed underneath this settlement.');
        const moved = await tx.adCampaign.updateMany({ where: { id: invoice.campaignId, status: 'PENDING_PAYMENT' }, data: { status: 'PENDING_REVIEW' } });
        if (moved.count !== 1) throw new AppError(409, 'CAMPAIGN_SETTLE_RACE', 'The campaign changed underneath this settlement.');
        await tx.adsAuditLog.create({
          data: {
            tenantId: invoice.tenantId, actorUserId: opts.adminUserId ?? 'system:webhook',
            action: 'INVOICE_MARK_PAID', entityType: 'AdInvoice', entityId: invoiceId,
            reason: opts.manualReference ?? opts.providerRef ?? null,
          },
        });
        return;
      }
      // [R045-ADS-05] The hold expired (inventory released, invoice VOID or the
      // campaign back in DRAFT) and the money arrived anyway — a late external
      // capture. Never a paid campaign with no inventory: the invoice records
      // the money, the campaign stays where the expiry left it, and the full
      // amount becomes a durable refund obligation (suspense) in the same
      // transaction.
      if (invoice.status === 'VOID' || invoice.status === 'UNPAID') {
        const claimed = await tx.adInvoice.updateMany({
          where: { id: invoiceId, status: invoice.status },
          data: { status: 'PAID', paidAt, providerRef: opts.providerRef ?? invoice.providerRef ?? null, provider: opts.adminUserId ? 'MANUAL' : invoice.provider },
        });
        if (claimed.count !== 1) throw new AppError(409, 'INVOICE_SETTLE_RACE', 'The invoice changed underneath this settlement.');
        await tx.adCampaign.updateMany({ where: { id: invoice.campaignId }, data: { statusReason: 'Paid after the reservation hold expired — full refund staged' } });
        await this.refunds.stageLateCapture(tx, invoice.campaignId, invoiceId, opts.adminUserId ?? null);
        await tx.adsAuditLog.create({
          data: {
            tenantId: invoice.tenantId, actorUserId: opts.adminUserId ?? 'system:webhook',
            action: 'INVOICE_LATE_CAPTURE', entityType: 'AdInvoice', entityId: invoiceId,
            reason: opts.manualReference ?? opts.providerRef ?? null,
          },
        });
        lateCapture = true;
        adCheckoutCounter.labels('late_capture').inc();
        return;
      }
      throw new AppError(409, 'INVOICE_NOT_PAYABLE', `A ${invoice.status} invoice cannot be marked paid.`);
    });
    if (lateCapture) {
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: head.tenantId ?? null,
        title: 'Ad payment arrived after the hold expired',
        body: `Invoice ${head.number} was paid after its reservation expired. The money is recorded, the inventory was not confirmed, and a full refund obligation is staged — settle it with the payout reference.`,
        data: { kind: 'ad_late_capture', campaignId: head.campaignId, invoiceNumber: head.number },
      }).catch(() => {});
      return this.prisma.adInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    }
    const invoice = head;

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
