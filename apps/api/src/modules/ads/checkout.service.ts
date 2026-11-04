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
import { mmgCheckoutEnabled } from '../../providers/mmg/mmg-checkout';

// Ad checkout & payment (ads-platform spec §8.1/§8.2). Ad money is PLATFORM
// revenue paid UPFRONT — it reuses the subscription rails' discipline
// (idempotent by provider ref, integer-minor money as Decimal) but is a
// one-time invoice, not a recurring MIT charge.
//
// [ADS-ON · owner ruling 3 Nov] An advertiser pays through the MMG checkout
// page, and an invoice is paid only after MMG's own lookup confirms it. There
// is no typed-reference settlement: the admin mark-paid route is gone. The
// weekly fee's checkout (billing/mmg-checkout.service.ts) decides whether a
// payment happened and calls settleInTx in its own transaction, so a
// confirmation and its settlement commit together or not at all.
//
// The switch stays OFF until the owner has MMG's answers (second product on one
// merchant, limits, reversal rules): with it off, production takes no ad money.

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
/** 1 pauses automatic settlement: a payment MMG confirmed keeps waiting and nothing is settled until it is unset. */
export function adPaymentConfirmManualOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env['AD_PAYMENT_CONFIRM_MANUAL_ONLY'] === '1';
}
/** [ADS-ON] Advertisers may pay with MMG. Stays off until the owner has MMG's answers; only exactly 1 opens it. */
export function adMmgCheckoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['ADS_MMG_CHECKOUT'] === '1';
}

/** [ADS-ON] THE rule for "an advertiser can pay": this switch, and MMG's own checkout. */
export function adMmgLive(env: Record<string, string | undefined> = process.env): boolean {
  return adMmgCheckoutEnabled(env) && mmgCheckoutEnabled(env);
}

/** What a settlement did. `already` is the same payment, seen again. */
export type AdSettlement = 'settled' | 'late_capture' | 'already';

/** A second payment on an invoice another payment settled. Never swallowed: real money is at MMG. */
export class AdInvoiceSettledByAnotherPayment extends AppError {
  constructor() {
    super(409, 'AD_INVOICE_ALREADY_PAID', 'This invoice was settled by another payment.');
  }
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
  async checkout(
    campaignId: string,
    provider: AdPaymentProvider,
    reservationMinutes = 20,
    opts: {
      /** [MASTER-064] Runs FIRST inside the checkout's transaction (the
       *  caller's in-transaction authorization re-check): a throw rolls back
       *  the hold and the invoice together. */
      authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
    } = {},
  ): Promise<{ invoice: AdInvoice; reservedUntil: Date | null }> {
    // [ADS-ON] The server decides how an invoice is paid: in production that is
    // the MMG checkout, and the provider a client names is not read (the app in
    // the stores asks for MANUAL). Fail before reading or reserving inventory:
    // with either switch off, production issues no invoice nobody could pay.
    if (isProduction() && !adMmgLive()) {
      throw new AppError(503, 'ADS_PAYMENT_PROVIDER_UNAVAILABLE', 'Paying for ads is not open yet.');
    }
    const invoiceProvider: AdPaymentProvider = isProduction() ? 'MMG' : provider;
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
        if (opts.authorize) await opts.authorize(tx);
        const fresh = await tx.adCampaign.findUniqueOrThrow({ where: { id: campaignId } });
        const active = await tx.adInvoice.findMany({ where: { campaignId, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' } });
        const open = active.find((i) => i.status === 'UNPAID');
        if (open) { invoice = open; return; }
        if (active.length > 0) {
          adCheckoutCounter.labels('duplicate_invoice_refused').inc();
          throw new AppError(409, 'CAMPAIGN_ALREADY_INVOICED', 'This campaign already has a settled invoice.');
        }
        invoice = await this.createInvoice(tx, fresh.tenantId, fresh.advertiserId, campaignId, fresh.totalAmount ?? new Prisma.Decimal(0), fresh.currency, invoiceProvider);
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

  /** ADS-{YYYY}-{seq}. Numbers are unique across operators, and this transaction sees one operator behind the tenant
   *  wall, so a number can never be worked out from the rows: it comes from one sequence for all of them. A checkout
   *  that rolls back leaves a gap; a number is never issued twice. */
  private async createInvoice(tx: Prisma.TransactionClient, tenantId: string, advertiserId: string, campaignId: string, amount: Prisma.Decimal, currency: string, provider: AdPaymentProvider): Promise<AdInvoice> {
    const [next] = await tx.$queryRaw<Array<{ seq: bigint }>>`SELECT nextval('ad_invoice_number_seq') AS seq`;
    const number = `ADS-${new Date().getUTCFullYear()}-${String(next!.seq).padStart(6, '0')}`;
    return tx.adInvoice.create({
      data: {
        tenantId, advertiserId, campaignId, number,
        amount, currency, provider,
        paymentUrl: provider === 'MOCK' ? `mock://ads-checkout/${campaignId}` : null,
      },
    });
  }

  /** §8.2 payment confirmation: the ONE settlement action, inside the caller's transaction, under the campaign
   *  lock the expiry sweep takes. A payment seen again is `already`; ANOTHER payment on a paid invoice is refused
   *  and must reach a person (AdInvoiceSettledByAnotherPayment). Moves the campaign PENDING_PAYMENT → PENDING_REVIEW
   *  and confirms every booking. */
  async settleInTx(tx: Prisma.TransactionClient, invoiceId: string, opts: { providerRef: string; actor?: string }): Promise<AdSettlement> {
    const head = await tx.adInvoice.findUnique({ where: { id: invoiceId }, select: { campaignId: true } });
    if (!head) throw new NotFoundError('AdInvoice', invoiceId);
    const actor = opts.actor ?? 'system:ad-settlement';
    const paidAt = new Date();
    // [R045-ADS-04 · 05] ONE serializable transition under the campaign lock —
    // the same lock the expiry sweep takes. Every step is count-checked;
    // any miss rolls the whole thing back.
    await lockCampaign(tx, head.campaignId);
    await this.observer.afterLock?.(head.campaignId);
    const invoice = await tx.adInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (invoice.status === 'PAID') {
      if (invoice.providerRef === opts.providerRef) return 'already'; // settled under the lock by a peer
      adCheckoutCounter.labels('second_payment_refused').inc();
      throw new AdInvoiceSettledByAnotherPayment();
    }
    const reused = await tx.adInvoice.findFirst({ where: { providerRef: opts.providerRef, id: { not: invoiceId } }, select: { id: true } });
    if (reused) {
      adCheckoutCounter.labels('provider_ref_reused').inc();
      throw new AppError(409, 'PROVIDER_REF_REUSED', 'This payment reference already settled another invoice.');
    }
    const reserved = await tx.adBooking.count({ where: { campaignId: invoice.campaignId, status: 'RESERVED' } });
    const campaign = await tx.adCampaign.findUniqueOrThrow({ where: { id: invoice.campaignId }, select: { status: true } });
    if (invoice.status === 'UNPAID' && reserved > 0 && campaign.status === 'PENDING_PAYMENT') {
      const claimed = await tx.adInvoice.updateMany({
        where: { id: invoiceId, status: 'UNPAID' },
        data: { status: 'PAID', paidAt, providerRef: opts.providerRef },
      });
      if (claimed.count !== 1) throw new AppError(409, 'INVOICE_SETTLE_RACE', 'The invoice changed underneath this settlement.');
      const confirmed = await tx.adBooking.updateMany({ where: { campaignId: invoice.campaignId, status: 'RESERVED' }, data: { status: 'CONFIRMED' } });
      if (confirmed.count !== reserved) throw new AppError(409, 'INVENTORY_SETTLE_RACE', 'The held inventory changed underneath this settlement.');
      const moved = await tx.adCampaign.updateMany({ where: { id: invoice.campaignId, status: 'PENDING_PAYMENT' }, data: { status: 'PENDING_REVIEW' } });
      if (moved.count !== 1) throw new AppError(409, 'CAMPAIGN_SETTLE_RACE', 'The campaign changed underneath this settlement.');
      await tx.adsAuditLog.create({
        data: { tenantId: invoice.tenantId, actorUserId: actor, action: 'INVOICE_MARK_PAID', entityType: 'AdInvoice', entityId: invoiceId, reason: opts.providerRef },
      });
      return 'settled';
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
        data: { status: 'PAID', paidAt, providerRef: opts.providerRef },
      });
      if (claimed.count !== 1) throw new AppError(409, 'INVOICE_SETTLE_RACE', 'The invoice changed underneath this settlement.');
      await tx.adCampaign.updateMany({ where: { id: invoice.campaignId }, data: { statusReason: 'Paid after the reservation hold expired — full refund staged' } });
      await this.refunds.stageLateCapture(tx, invoice.campaignId, invoiceId, null);
      await tx.adsAuditLog.create({
        data: { tenantId: invoice.tenantId, actorUserId: actor, action: 'INVOICE_LATE_CAPTURE', entityType: 'AdInvoice', entityId: invoiceId, reason: opts.providerRef },
      });
      adCheckoutCounter.labels('late_capture').inc();
      return 'late_capture';
    }
    throw new AppError(409, 'INVOICE_NOT_PAYABLE', `A ${invoice.status} invoice cannot be marked paid.`);
  }

  /** The notices of a settlement that has committed. A failed notice never unsettles anything. */
  async afterSettled(invoiceId: string, outcome: AdSettlement): Promise<void> {
    if (outcome === 'already') return;
    const invoice = await this.prisma.adInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (outcome === 'late_capture') {
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: invoice.tenantId ?? null,
        title: 'Ad payment arrived after the hold expired',
        body: `Invoice ${invoice.number} was paid after its reservation expired. The money is recorded, the inventory was not confirmed, and a full refund obligation is staged — settle it with the payout reference.`,
        data: { kind: 'ad_late_capture', campaignId: invoice.campaignId, invoiceNumber: invoice.number },
      }).catch(() => {});
      // They paid and have no booking: they hear both from Swift, before they ask.
      const { notifyAdvertiserOwners } = await import('./ads-notify');
      await notifyAdvertiserOwners(this.prisma, this.notifications, invoice.advertiserId, {
        title: 'We received your payment, but your ad was not placed',
        body: `We received ${invoice.currency} ${Number(invoice.amount).toLocaleString('en-US')} for invoice ${invoice.number}, but its booking was no longer held, so your ad was not placed. The full amount is owed back to you. Please do not pay again. Support will contact you.`,
        kind: 'ad_mmg_checkout',
        data: { status: 'LATE_CAPTURE', campaignId: invoice.campaignId, invoiceNumber: invoice.number },
      }).catch(() => {});
      return;
    }
    log().info({ invoiceId, campaignId: invoice.campaignId }, 'ad invoice paid — campaign → PENDING_REVIEW');
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
  }

  /** One settlement in its own transaction, then its notices. The MMG checkout does not use this: it calls the
   *  two halves itself, so its confirmation commits with the settlement. Idempotent by providerRef. */
  async markPaid(invoiceId: string, opts: { providerRef: string }): Promise<AdInvoice> {
    // [R045-ADS-05] Rollback holds settlement back.
    if (adPaymentConfirmManualOnly()) {
      throw new AppError(503, 'ADS_CONFIRMATION_PAUSED', 'Automatic payment confirmation is paused.');
    }
    const outcome = await this.prisma.$transaction((tx) => this.settleInTx(tx, invoiceId, opts));
    await this.afterSettled(invoiceId, outcome);
    return this.prisma.adInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  }
}
