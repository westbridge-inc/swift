import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { log } from '../../utils/logger';
import { mondayOf, weekStartInstant } from './ads-weeks';
import { AdsLifecycleService } from './lifecycle.service';
import { AdsRefundService } from './refund.service';

// Campaign lifecycle crons (ads-platform spec §6.1). One hourly tick advances
// every campaign through the time-driven transitions — all via the ONE
// lifecycle.transition(), so the machine's guards/audit/notify apply. Idempotent
// and overlap-safe (each transition is CAS; already-moved campaigns are skipped).

export class AdsCronService {
  private lifecycle: AdsLifecycleService;
  private refunds: AdsRefundService;
  constructor(private prisma: PrismaClient, private io: Server, private tz = 'America/Guyana') {
    this.lifecycle = new AdsLifecycleService(prisma, io);
    this.refunds = new AdsRefundService(prisma, io);
  }

  /** Run all three time-driven transitions for this tick. */
  /** `scope.campaignIds` narrows every phase to those campaigns — test isolation; production ticks pass nothing. */
  async tick(now = new Date(), scope: { campaignIds?: string[] } = {}): Promise<{ autoCancelled: number; activated: number; completed: number }> {
    return {
      autoCancelled: await this.autoCancelUnapproved(now, scope),
      activated: await this.activateScheduled(now, scope),
      completed: await this.completeFinished(now, scope),
    };
  }

  /** §6.1 auto_cancel_unapproved: a PENDING_REVIEW campaign whose go-live
   *  cutoff (startWeek − autoCancelUnapprovedHours) has passed without every
   *  creative approved → CANCELLED + full refund (§8.4 row 1). */
  async autoCancelUnapproved(now: Date, scope: { campaignIds?: string[] } = {}): Promise<number> {
    const pending = await this.prisma.adCampaign.findMany({
      where: { status: 'PENDING_REVIEW', ...(scope.campaignIds ? { id: { in: scope.campaignIds } } : {}) },
      select: { id: true, startWeek: true, tenantId: true },
      take: 500,
    });
    if (pending.length === 0) return 0;
    const settingsByTenant = new Map<string, number>();
    let cancelled = 0;
    for (const c of pending) {
      let cutoffHours = settingsByTenant.get(c.tenantId);
      if (cutoffHours === undefined) {
        const s = await this.prisma.adsSettings.findUnique({ where: { tenantId: c.tenantId }, select: { autoCancelUnapprovedHours: true } });
        cutoffHours = s?.autoCancelUnapprovedHours ?? 24;
        settingsByTenant.set(c.tenantId, cutoffHours);
      }
      const cutoff = new Date(weekStartInstant(c.startWeek).getTime() - cutoffHours * 3_600_000);
      if (now < cutoff) continue;
      // Not all creatives approved? (any PENDING/REJECTED, or none at all.)
      const total = await this.prisma.adCreative.count({ where: { campaignId: c.id } });
      const approved = await this.prisma.adCreative.count({ where: { campaignId: c.id, status: 'APPROVED' } });
      if (total > 0 && approved === total) continue; // fully approved — the approval hook will schedule it
      try {
        // [R045-ADS-09] The refund obligation is staged INSIDE the transition's
        // transaction — terminalization never outruns it. Execution follows
        // right away; if it fails, the outbox worker retries the same intent.
        let staged: { intentId: string } | null = null;
        await this.lifecycle.transition(c.id, 'auto_cancel_unapproved', 'system:ads-cron', undefined, {
          within: async (tx) => { staged = await this.refunds.stage(tx, c.id, 'AUTO_CANCEL_UNAPPROVED', 'system:ads-cron', { now }); },
        });
        cancelled += 1;
        if (staged) await this.refunds.executeNow((staged as { intentId: string }).intentId).catch((err: unknown) => log().warn({ err, campaignId: c.id }, 'ads auto-cancel refund execution deferred to the worker'));
      } catch (err) {
        log().error({ err, campaignId: c.id }, 'ads auto-cancel failed — continuing');
      }
    }
    return cancelled;
  }

  /** §6.1 week_start: a SCHEDULED campaign whose start week has arrived (today
   *  ≥ startWeek in tenant TZ) → LIVE. */
  async activateScheduled(now: Date, scope: { campaignIds?: string[] } = {}): Promise<number> {
    const thisMonday = mondayOf(now, this.tz);
    const due = await this.prisma.adCampaign.findMany({
      where: { status: 'SCHEDULED', startWeek: { lte: thisMonday }, ...(scope.campaignIds ? { id: { in: scope.campaignIds } } : {}) },
      select: { id: true },
      take: 500,
    });
    let activated = 0;
    for (const c of due) {
      try { await this.lifecycle.transition(c.id, 'week_start', 'system:ads-cron'); activated += 1; }
      catch (err) { log().error({ err, campaignId: c.id }, 'ads activate failed — continuing'); }
    }
    return activated;
  }

  /** §16 weekly performance report (Mon 09:00 tenant time): every campaign
   *  that had a CONFIRMED booking LAST week gets its owners a totals digest.
   *  Numbers come from the SAME rollups the dashboard reads (weekTotals), so
   *  the email can never disagree with the stats screen. Idempotence rides the
   *  cron cadence (fires once per Monday); a re-run within the same day would
   *  re-send, which is acceptable for a report and keeps this stateless. */
  async weeklyReport(now = new Date()): Promise<{ campaigns: number }> {
    const thisMonday = mondayOf(now, this.tz);
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86_400_000);
    const booked = await this.prisma.adBooking.findMany({
      where: { weekStart: lastMonday, status: 'CONFIRMED' },
      select: { campaignId: true, campaign: { select: { advertiserId: true, name: true } } },
      distinct: ['campaignId'],
      take: 500,
    });
    if (booked.length === 0) return { campaigns: 0 };
    const { AdStatsService } = await import('./stats.service');
    const { notifyAdvertiserOwners } = await import('./ads-notify');
    const { NotificationService } = await import('../notification/notification.service');
    const stats = new AdStatsService(this.prisma);
    const notifications = new NotificationService(this.prisma, this.io);
    let sent = 0;
    for (const b of booked) {
      try {
        const t = await stats.weekTotals(b.campaignId, lastMonday);
        await notifyAdvertiserOwners(this.prisma, notifications, b.campaign.advertiserId, {
          title: `Weekly report — ${b.campaign.name}`,
          body: `Last week: ${t.viewableImpressions.toLocaleString('en-US')} viewable impressions, ${t.clicks.toLocaleString('en-US')} clicks (CTR ${(t.ctr * 100).toFixed(2)}%), spend ${t.spend.toLocaleString('en-US')}.`,
          kind: 'ad_weekly_report',
          data: { campaignId: b.campaignId, weekStart: lastMonday.toISOString().slice(0, 10) },
        });
        sent += 1;
      } catch (err) {
        log().error({ err, campaignId: b.campaignId }, 'ads weekly report failed — continuing');
      }
    }
    return { campaigns: sent };
  }

  /** §6.1 week_end: a LIVE/PAUSED campaign whose booked window is over (the
   *  current tenant week is past endWeek) → COMPLETED. */
  async completeFinished(now: Date, scope: { campaignIds?: string[] } = {}): Promise<number> {
    const thisMonday = mondayOf(now, this.tz);
    const due = await this.prisma.adCampaign.findMany({
      where: { status: { in: ['LIVE', 'PAUSED'] }, endWeek: { lt: thisMonday }, ...(scope.campaignIds ? { id: { in: scope.campaignIds } } : {}) },
      select: { id: true },
      take: 500,
    });
    let completed = 0;
    for (const c of due) {
      try { await this.lifecycle.transition(c.id, 'week_end', 'system:ads-cron'); completed += 1; }
      catch (err) { log().error({ err, campaignId: c.id }, 'ads complete failed — continuing'); }
    }
    return completed;
  }
}
