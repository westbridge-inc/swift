import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';

// Ad stats rollups (ads-platform spec §12.3). Nightly rollupDay aggregates the
// billing-grade AdEvent rows → AdStatsDaily. Idempotent: re-running a day
// deletes and recomputes, never doubles. The advertiser stats API reads ONLY
// the rollups — no client-side totals, and the reconciliation test proves the
// dashboard numbers exactly equal the raw event counts.

interface Counts {
  impressions: number;
  viewableImpressions: number;
  clicks: number;
  videoStarts: number;
  videoCompletes: number;
}

const zero = (): Counts => ({ impressions: 0, viewableImpressions: 0, clicks: 0, videoStarts: 0, videoCompletes: 0 });

export class AdStatsService {
  constructor(private prisma: PrismaClient) {}

  /** Aggregate one UTC day of AdEvent into AdStatsDaily. Idempotent. */
  async rollupDay(day: Date): Promise<{ rows: number }> {
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const end = new Date(start.getTime() + 86_400_000);
    const events = await this.prisma.adEvent.findMany({
      where: { occurredAt: { gte: start, lt: end } },
      select: { campaignId: true, creativeId: true, city: true, eventType: true },
    });

    // Group by (campaign, creative, city).
    const groups = new Map<string, { campaignId: string; creativeId: string; city: string; c: Counts }>();
    for (const e of events) {
      const city = e.city ?? '*';
      const key = `${e.campaignId}|${e.creativeId}|${city}`;
      let g = groups.get(key);
      if (!g) { g = { campaignId: e.campaignId, creativeId: e.creativeId, city, c: zero() }; groups.set(key, g); }
      switch (e.eventType) {
        case 'IMPRESSION': g.c.impressions += 1; break;
        case 'VIEWABLE_IMPRESSION': g.c.viewableImpressions += 1; break;
        case 'CLICK': g.c.clicks += 1; break;
        case 'VIDEO_START': g.c.videoStarts += 1; break;
        case 'VIDEO_COMPLETE': g.c.videoCompletes += 1; break;
        default: break; // Q25/Q50/Q75 are stored raw, not rolled to a column
      }
    }

    // Recognized spend per campaign for this day (§8.5): weeklyPrice/7 per live
    // booking whose week contains `day`. Attach to each row of that campaign+city.
    const spendByCampaignCity = await this.recognizedSpend(start);

    const rows = [...groups.values()].map((g) => ({
      campaignId: g.campaignId,
      creativeId: g.creativeId,
      day: start,
      city: g.city,
      impressions: g.c.impressions,
      viewableImpressions: g.c.viewableImpressions,
      clicks: g.c.clicks,
      videoStarts: g.c.videoStarts,
      videoCompletes: g.c.videoCompletes,
      spend: spendByCampaignCity.get(`${g.campaignId}|${g.city}`) ?? 0,
    }));

    await this.prisma.$transaction([
      this.prisma.adStatsDaily.deleteMany({ where: { day: start } }),
      ...(rows.length > 0 ? [this.prisma.adStatsDaily.createMany({ data: rows })] : []),
    ]);
    return { rows: rows.length };
  }

  /** weeklyPrice/7 per CONFIRMED booking whose booked week contains `day`. */
  private async recognizedSpend(day: Date): Promise<Map<string, number>> {
    // The Monday of the week containing `day` (UTC-date granular).
    const dow = day.getUTCDay();
    const monday = new Date(day.getTime() - ((dow === 0 ? 6 : dow - 1) * 86_400_000));
    const bookings = await this.prisma.adBooking.findMany({
      where: { weekStart: monday, status: { in: ['CONFIRMED', 'REFUNDED'] } },
      select: { campaignId: true, city: true, amount: true, status: true },
    });
    const map = new Map<string, number>();
    for (const b of bookings) {
      if (b.status !== 'CONFIRMED') continue; // refunded weeks recognize no spend
      const key = `${b.campaignId}|${b.city}`;
      map.set(key, (map.get(key) ?? 0) + Number(b.amount) / 7);
    }
    return map;
  }

  /** One booked week's totals from the rollups — the §16 weekly-report and
   *  campaign-completed numbers. Same source as the dashboard (AdStatsDaily
   *  only), so the email can never disagree with the stats screen. */
  async weekTotals(campaignId: string, weekStart: Date) {
    const end = new Date(weekStart.getTime() + 7 * 86_400_000);
    const agg = await this.prisma.adStatsDaily.aggregate({
      where: { campaignId, day: { gte: weekStart, lt: end } },
      _sum: { impressions: true, viewableImpressions: true, clicks: true, videoStarts: true, videoCompletes: true, spend: true },
    });
    const impressions = agg._sum.impressions ?? 0;
    const clicks = agg._sum.clicks ?? 0;
    return {
      impressions,
      viewableImpressions: agg._sum.viewableImpressions ?? 0,
      clicks,
      ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : 0,
      videoStarts: agg._sum.videoStarts ?? 0,
      videoCompletes: agg._sum.videoCompletes ?? 0,
      spend: Number(agg._sum.spend ?? 0),
    };
  }

  /** Advertiser stats (§12.3) — reads rollups only. Series + totals with the
   *  derived ratios (ctr, completionRate). */
  async campaignStats(campaignId: string): Promise<{
    series: Array<{ day: string; impressions: number; viewableImpressions: number; clicks: number; ctr: number; videoStarts: number; videoCompletes: number; completionRate: number; spend: number }>;
    totals: { impressions: number; viewableImpressions: number; clicks: number; ctr: number; videoStarts: number; videoCompletes: number; completionRate: number; spend: number };
  }> {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!campaign) throw new NotFoundError('AdCampaign', campaignId);

    const rows = await this.prisma.adStatsDaily.groupBy({
      by: ['day'],
      where: { campaignId },
      _sum: { impressions: true, viewableImpressions: true, clicks: true, videoStarts: true, videoCompletes: true, spend: true },
      orderBy: { day: 'asc' },
    });

    const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : 0);
    const series = rows.map((r) => {
      const imp = r._sum.impressions ?? 0;
      const clk = r._sum.clicks ?? 0;
      const vs = r._sum.videoStarts ?? 0;
      const vc = r._sum.videoCompletes ?? 0;
      return {
        day: r.day.toISOString().slice(0, 10),
        impressions: imp,
        viewableImpressions: r._sum.viewableImpressions ?? 0,
        clicks: clk,
        ctr: ratio(clk, imp),
        videoStarts: vs,
        videoCompletes: vc,
        completionRate: ratio(vc, vs),
        spend: Number(r._sum.spend ?? 0),
      };
    });
    const totals = series.reduce((t, d) => ({
      impressions: t.impressions + d.impressions,
      viewableImpressions: t.viewableImpressions + d.viewableImpressions,
      clicks: t.clicks + d.clicks,
      videoStarts: t.videoStarts + d.videoStarts,
      videoCompletes: t.videoCompletes + d.videoCompletes,
      spend: Math.round((t.spend + d.spend) * 100) / 100,
    }), { impressions: 0, viewableImpressions: 0, clicks: 0, videoStarts: 0, videoCompletes: 0, spend: 0 });
    return {
      series,
      totals: { ...totals, ctr: ratio(totals.clicks, totals.impressions), completionRate: ratio(totals.videoCompletes, totals.videoStarts) },
    };
  }
}
