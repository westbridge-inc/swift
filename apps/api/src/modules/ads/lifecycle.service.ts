import { Prisma } from '@prisma/client';
import type { PrismaClient, AdCampaign, AdCampaignStatus } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

// Campaign lifecycle (ads-platform spec §6.1). ONE transition function owns
// every campaign status change downstream of payment — it validates the table,
// writes the audit log, and emits notifications, so no route or cron mutates
// `status` directly. (The pre-payment moves — DRAFT→PENDING_PAYMENT on
// checkout, →PENDING_REVIEW on pay, →DRAFT on expiry — predate this and live in
// their own services; everything from PENDING_REVIEW onward flows through here.)
//
//   PENDING_REVIEW ─all_creatives_approved→ SCHEDULED ─week_start→ LIVE ─week_end→ COMPLETED
//   PENDING_REVIEW ─auto_cancel_unapproved→ CANCELLED
//   LIVE ⇄ PAUSED (pause / resume);  PAUSED ─week_end→ COMPLETED
//   DRAFT|PENDING_REVIEW|SCHEDULED|LIVE ─cancel→ CANCELLED
//   any non-terminal ─kill→ REJECTED
// Terminal: COMPLETED, CANCELLED, REJECTED. No hard deletes.

export type CampaignEvent =
  | 'all_creatives_approved'
  | 'auto_cancel_unapproved'
  | 'week_start'
  | 'week_end'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'kill';

const TERMINAL: AdCampaignStatus[] = ['COMPLETED', 'CANCELLED', 'REJECTED'];

/** [from-states] → to-state for each event. A guard/side-effects layer sits on
 *  top in transition(); this is the legal-move table. */
const TABLE: Record<CampaignEvent, { from: AdCampaignStatus[]; to: AdCampaignStatus }> = {
  all_creatives_approved: { from: ['PENDING_REVIEW'], to: 'SCHEDULED' },
  auto_cancel_unapproved: { from: ['PENDING_REVIEW'], to: 'CANCELLED' },
  week_start: { from: ['SCHEDULED'], to: 'LIVE' },
  week_end: { from: ['LIVE', 'PAUSED'], to: 'COMPLETED' },
  pause: { from: ['LIVE'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'LIVE' },
  cancel: { from: ['DRAFT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE'], to: 'CANCELLED' },
  kill: { from: ['DRAFT', 'PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'PAUSED'], to: 'REJECTED' },
};

const NOTICE: Partial<Record<CampaignEvent, { title: string; body: string; kind: string }>> = {
  all_creatives_approved: { title: "You're scheduled", body: 'All creatives approved — your campaign goes live at week start.', kind: 'ad_campaign_scheduled' },
  auto_cancel_unapproved: { title: 'Campaign cancelled — creatives not approved in time', body: 'Your creatives were not approved before the go-live cutoff, so the campaign was cancelled and refunded.', kind: 'ad_campaign_auto_cancelled' },
  week_start: { title: "You're live", body: 'Your campaign is now live on the Swift home screen.', kind: 'ad_campaign_live' },
  week_end: { title: 'Campaign complete', body: 'Your campaign has finished its booked run. A performance summary is on its way.', kind: 'ad_campaign_completed' },
  pause: { title: 'Campaign paused', body: 'Your campaign is paused and no longer serving. Resume it anytime within the booked window.', kind: 'ad_campaign_paused' },
  resume: { title: 'Campaign resumed', body: 'Your campaign is serving again.', kind: 'ad_campaign_resumed' },
  cancel: { title: 'Campaign cancelled', body: 'Your campaign was cancelled. Any eligible refund is being processed.', kind: 'ad_campaign_cancelled' },
  kill: { title: 'Campaign removed', body: 'Your campaign was removed for a policy reason. Contact support for details.', kind: 'ad_campaign_killed' },
};

export class AdsLifecycleService {
  private notifications: NotificationService;
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** The one transition point. CAS on the pre-read status; illegal moves 409.
   *  actor = the userId performing it (or 'system:<cron>'). */
  async transition(
    campaignId: string,
    event: CampaignEvent,
    actor: string,
    reason?: string,
    opts: {
      /** [R045-ADS-08/09] Runs INSIDE the transition's transaction, after the
       *  status moved: the refund obligation is staged in the same database
       *  generation as the terminal state, or neither happens. */
      within?: (tx: Prisma.TransactionClient, moved: { before: AdCampaign; to: AdCampaignStatus }) => Promise<void>;
    } = {},
  ): Promise<AdCampaign> {
    const rule = TABLE[event];
    const before = await this.prisma.adCampaign.findUnique({ where: { id: campaignId } });
    if (!before) throw new NotFoundError('AdCampaign', campaignId);
    if (TERMINAL.includes(before.status)) {
      throw new AppError(409, 'CAMPAIGN_TERMINAL', `A ${before.status} campaign is terminal and cannot transition.`);
    }
    if (!rule.from.includes(before.status)) {
      log().warn({ campaignId, from: before.status, event }, 'illegal ad campaign transition rejected');
      throw new AppError(409, 'INVALID_CAMPAIGN_TRANSITION', `Cannot ${event} a ${before.status} campaign.`);
    }
    // ONE generation: the status CAS, the audit row and whatever the caller
    // stages within (the refund obligation) commit together — never a killed
    // campaign whose money obligation vanished on the way.
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.adCampaign.updateMany({
        where: { id: campaignId, status: before.status },
        data: { status: rule.to, statusReason: reason ?? null },
      });
      if (moved.count === 0) throw new AppError(409, 'CAMPAIGN_TRANSITION_RACE', 'The campaign changed underneath this action — retry.');
      await tx.adsAuditLog.create({
        data: {
          tenantId: before.tenantId, actorUserId: actor, action: `CAMPAIGN_${event.toUpperCase()}`,
          entityType: 'AdCampaign', entityId: campaignId,
          before: { status: before.status } as never, after: { status: rule.to } as never, reason: reason ?? null,
        },
      });
      if (opts.within) await opts.within(tx, { before, to: rule.to });
    });

    const notice = NOTICE[event];
    if (notice) await this.notifyOwners(before.advertiserId, notice.title, notice.body, notice.kind, campaignId).catch(() => {});
    if (event === 'kill') {
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: before.tenantId ?? null,
        title: 'Ad campaign killed',
        body: `A campaign was killed${reason ? `: ${reason}` : ''}. Refunds per policy.`,
        data: { kind: 'ad_campaign_killed_ops', campaignId, reason },
      }).catch(() => {});
    }
    log().info({ campaignId, from: before.status, to: rule.to, event, actor }, 'ad campaign transition');
    return this.prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  }

  private async notifyOwners(advertiserId: string, title: string, body: string, kind: string, campaignId: string) {
    const { notifyAdvertiserOwners } = await import('./ads-notify');
    await notifyAdvertiserOwners(this.prisma, this.notifications, advertiserId, { title, body, kind, data: { campaignId } });
  }
}
