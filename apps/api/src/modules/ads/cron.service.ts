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
  async tick(now = new Date()): Promise<{ autoCancelled: number; activated: number; completed: number }> {
    return {
      autoCancelled: await this.autoCancelUnapproved(now),
      activated: await this.activateScheduled(now),
      completed: await this.completeFinished(now),
    };
  }

  /** §6.1 auto_cancel_unapproved: a PENDING_REVIEW campaign whose go-live
   *  cutoff (startWeek − autoCancelUnapprovedHours) has passed without every
   *  creative approved → CANCELLED + full refund (§8.4 row 1). */
  async autoCancelUnapproved(now: Date): Promise<number> {
    const pending = await this.prisma.adCampaign.findMany({
      where: { status: 'PENDING_REVIEW' },
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
        await this.lifecycle.transition(c.id, 'auto_cancel_unapproved', 'system:ads-cron');
        await this.refunds.execute(c.id, 'AUTO_CANCEL_UNAPPROVED', 'system:ads-cron', { now });
        cancelled += 1;
      } catch (err) {
        log().error({ err, campaignId: c.id }, 'ads auto-cancel failed — continuing');
      }
    }
    return cancelled;
  }

  /** §6.1 week_start: a SCHEDULED campaign whose start week has arrived (today
   *  ≥ startWeek in tenant TZ) → LIVE. */
  async activateScheduled(now: Date): Promise<number> {
    const thisMonday = mondayOf(now, this.tz);
    const due = await this.prisma.adCampaign.findMany({
      where: { status: 'SCHEDULED', startWeek: { lte: thisMonday } },
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

  /** §6.1 week_end: a LIVE/PAUSED campaign whose booked window is over (the
   *  current tenant week is past endWeek) → COMPLETED. */
  async completeFinished(now: Date): Promise<number> {
    const thisMonday = mondayOf(now, this.tz);
    const due = await this.prisma.adCampaign.findMany({
      where: { status: { in: ['LIVE', 'PAUSED'] }, endWeek: { lt: thisMonday } },
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
