import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { refundCalculator, type RefundReason, type RefundOpts } from './refund-calculator';

// Refund execution (ads-platform spec §8.4). The §8.4 CALCULATOR is a pure
// function (proven separately); this service runs it against a campaign's
// bookings and applies the plan ATOMICALLY: REFUND items flip the booking to
// REFUNDED and give the inventory back (guarded, once — §6.3); CREDIT items
// leave the ad serving and just record money owed. AdInvoice.refundedAmount is
// bumped by the refunded total. Since the ad payment provider's refund API is
// founder/acquirer-gated (like the live checkout URL), execution files a MANUAL
// PAYOUT TASK to ops (amount, advertiser, reason) — computed automatically,
// executed by a human, fully audited. Never silently keep money.

export interface RefundExecResult {
  planTotal: number;
  refundedTotal: number;
  creditedTotal: number;
  releasedSlots: number;
}

export class AdsRefundService {
  private notifications: NotificationService;
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  async execute(campaignId: string, reason: RefundReason, actorUserId: string, opts: Omit<RefundOpts, 'now'> & { now?: Date } = {}): Promise<RefundExecResult> {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId }, include: { advertiser: { select: { id: true } } } });
    if (!campaign) throw new NotFoundError('AdCampaign', campaignId);
    const now = opts.now ?? new Date();

    // Only bookings that could still owe money — CONFIRMED (paid) or RESERVED
    // (paid-then-expired edge). RELEASED/CANCELLED/REFUNDED are already settled.
    const bookings = await this.prisma.adBooking.findMany({
      where: { campaignId, status: { in: ['CONFIRMED', 'RESERVED'] } },
      select: { id: true, weekStart: true, amount: true, placementId: true, city: true },
    });
    const plan = refundCalculator(
      bookings.map((b) => ({ id: b.id, weekStart: b.weekStart, amount: Number(b.amount) })),
      reason,
      { ...opts, now },
    );
    if (plan.items.length === 0) {
      return { planTotal: 0, refundedTotal: 0, creditedTotal: 0, releasedSlots: 0 };
    }

    const byId = new Map(bookings.map((b) => [b.id, b]));
    let refundedTotal = 0;
    let creditedTotal = 0;
    let releasedSlots = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const item of plan.items) {
        const b = byId.get(item.bookingId);
        if (!b) continue;
        if (item.kind === 'REFUND') {
          // The ad won't run that week → free the slot (guarded, exactly once).
          const moved = await tx.adBooking.updateMany({ where: { id: b.id, status: { in: ['CONFIRMED', 'RESERVED'] } }, data: { status: 'REFUNDED' } });
          if (moved.count === 1) {
            await tx.adInventoryWeek.updateMany({ where: { placementId: b.placementId, city: b.city, weekStart: b.weekStart, booked: { gt: 0 } }, data: { booked: { decrement: 1 } } });
            releasedSlots += 1;
            refundedTotal += item.amount;
          }
        } else {
          // CREDIT: the ad keeps serving; only money is owed back.
          creditedTotal += item.amount;
        }
      }
      // Bump every open invoice's refundedAmount by the refunded portion.
      if (refundedTotal > 0) {
        const invoices = await tx.adInvoice.findMany({ where: { campaignId, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } }, select: { id: true, amount: true, refundedAmount: true } });
        for (const inv of invoices) {
          const newRefunded = Number(inv.refundedAmount) + refundedTotal;
          const fully = newRefunded >= Number(inv.amount);
          await tx.adInvoice.update({ where: { id: inv.id }, data: { refundedAmount: new Prisma.Decimal(newRefunded), status: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
          break; // one invoice per campaign in v1
        }
      }
      await tx.adsAuditLog.create({
        data: {
          tenantId: campaign.tenantId, actorUserId, action: 'REFUND_PLAN', entityType: 'AdCampaign', entityId: campaignId,
          after: { reason, refundedTotal, creditedTotal, items: plan.items } as never, reason,
        },
      });
    });

    // The manual payout task — computed here, executed by a human (§8.4).
    if (refundedTotal + creditedTotal > 0) {
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'Ad refund — manual payout needed',
        body: `Campaign ${campaign.name}: refund $${refundedTotal.toLocaleString()} + credit $${creditedTotal.toLocaleString()} (${reason}). Pay the advertiser via MMG/bank and mark done.`,
        data: { kind: 'ad_refund_payout_task', campaignId, advertiserId: campaign.advertiserId, refundedTotal, creditedTotal, reason },
      }).catch(() => {});
    }
    log().info({ campaignId, reason, refundedTotal, creditedTotal, releasedSlots }, 'ad refund plan executed');
    return { planTotal: plan.total, refundedTotal, creditedTotal, releasedSlots };
  }
}
