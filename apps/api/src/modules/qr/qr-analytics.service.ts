import type { PrismaClient, ScanDecision } from '@prisma/client';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Vendor QR analytics (spec 12.5). The one law: every number the dashboard
// renders reconciles to database rows — raw ScanEvents PLUS ScanDailyRollup
// (so totals survive the 90-day retention sweep), orders by attribution id,
// claim receipts for installs. No client math, no PostHog, no estimates —
// except approxUniqueScanners, which is labeled approximate BY DESIGN
// (Σ per-day distinct ipHash; the daily salt rotation makes cross-day
// uniqueness unknowable, which is the DPA point).
// ---------------------------------------------------------------------------

export type QrAnalyticsRange = '7d' | '30d' | '90d' | 'all';

/** Funnel stage SCAN = a resolver hit of any outcome except pure NOT_FOUND
 *  noise (and excluding the later funnel stages sharing the spine table). */
const SCAN_DECISIONS: ScanDecision[] = ['WEB_RENDER', 'APP_OPEN_ASSUMED', 'RETIRED_PAGE', 'UNAVAILABLE_PAGE'];

export interface QrAnalyticsResponse {
  range: QrAnalyticsRange;
  totals: {
    scans: number;
    approxUniqueScanners: number;
    storeViews: number;
    webOrders: number;
    appOpens: number;
    installTaps: number;
    installsAttributed: number;
    attributedFirstOrders: number;
  };
  funnel: { stage: 'SCAN' | 'STORE_VIEW' | 'WEB_ORDER' | 'INSTALL_TAP' | 'INSTALL_ATTRIBUTED' | 'ATTRIBUTED_FIRST_ORDER'; count: number }[];
  byDay: { date: string; scans: number; webOrders: number }[];
  byTemplate: { template: string; scans: number }[];
}

function sinceFor(range: QrAnalyticsRange, now: Date): Date {
  if (range === 'all') return new Date(0);
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const EMPTY: Omit<QrAnalyticsResponse, 'range'> = {
  totals: { scans: 0, approxUniqueScanners: 0, storeViews: 0, webOrders: 0, appOpens: 0, installTaps: 0, installsAttributed: 0, attributedFirstOrders: 0 },
  funnel: [
    { stage: 'SCAN', count: 0 }, { stage: 'STORE_VIEW', count: 0 }, { stage: 'WEB_ORDER', count: 0 },
    { stage: 'INSTALL_TAP', count: 0 }, { stage: 'INSTALL_ATTRIBUTED', count: 0 }, { stage: 'ATTRIBUTED_FIRST_ORDER', count: 0 },
  ],
  byDay: [],
  byTemplate: [],
};

export class QrAnalyticsService {
  constructor(private prisma: PrismaClient) {}

  async forVendor(vendorId: string, range: QrAnalyticsRange): Promise<QrAnalyticsResponse> {
    const codes = await this.prisma.qrCode.findMany({
      where: { entityType: 'VENDOR', entityId: vendorId },
      select: { id: true },
    });
    const ids = codes.map((c) => c.id);
    if (ids.length === 0) return { range, ...EMPTY };

    const now = new Date();
    const since = sinceFor(range, now);

    const countDecisions = (decisions: ScanDecision[]) =>
      this.prisma.scanEvent.count({
        where: { qrCodeId: { in: ids }, occurredAt: { gte: since }, decision: { in: decisions } },
      });
    const rollupSum = async (decisions: ScanDecision[]) =>
      (await this.prisma.scanDailyRollup.aggregate({
        _sum: { count: true },
        where: { qrCodeId: { in: ids }, date: { gte: since }, decision: { in: decisions } },
      }))._sum.count ?? 0;

    const [scansRaw, scansRolled, appOpensRaw, appOpensRolled, storeViewsRaw, storeViewsRolled, installTapsRaw, installTapsRolled] =
      await Promise.all([
        countDecisions(SCAN_DECISIONS), rollupSum(SCAN_DECISIONS),
        countDecisions(['APP_OPEN_ASSUMED']), rollupSum(['APP_OPEN_ASSUMED']),
        countDecisions(['STORE_VIEW']), rollupSum(['STORE_VIEW']),
        countDecisions(['INSTALL_TAP']), rollupSum(['INSTALL_TAP']),
      ]);

    const [webOrders, installsAttributed] = await Promise.all([
      this.prisma.order.count({
        where: { attributionQrCodeId: { in: ids }, channel: 'WEB', placedAt: { gte: since } },
      }),
      this.prisma.attributionClaim.count({
        where: { qrCodeId: { in: ids }, destinationPath: { not: null }, createdAt: { gte: since } },
      }),
    ]);

    // Σ per-day distinct ipHash — approximate by construction (daily rotating
    // salt). Rollups cannot contribute (uniqueness is lost at aggregation).
    const uniqueRows = await this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '|' || COALESCE("ipHash", '')) AS n
      FROM "scan_events"
      WHERE "qrCodeId" IN (${Prisma.join(ids)})
        AND "occurredAt" >= ${since}
        AND "decision" = ANY(ARRAY[${Prisma.join(SCAN_DECISIONS)}]::"ScanDecision"[])
    `);
    const approxUniqueScanners = Number(uniqueRows[0]?.n ?? 0);

    const scanByDay = await this.prisma.$queryRaw<{ day: string; n: bigint }[]>(Prisma.sql`
      SELECT to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*) AS n
      FROM "scan_events"
      WHERE "qrCodeId" IN (${Prisma.join(ids)})
        AND "occurredAt" >= ${since}
        AND "decision" = ANY(ARRAY[${Prisma.join(SCAN_DECISIONS)}]::"ScanDecision"[])
      GROUP BY 1
    `);
    const rollupByDay = await this.prisma.scanDailyRollup.groupBy({
      by: ['date'],
      _sum: { count: true },
      where: { qrCodeId: { in: ids }, date: { gte: since }, decision: { in: SCAN_DECISIONS } },
    });
    const orderByDay = await this.prisma.$queryRaw<{ day: string; n: bigint }[]>(Prisma.sql`
      SELECT to_char("placedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*) AS n
      FROM "orders"
      WHERE "attributionQrCodeId" IN (${Prisma.join(ids)})
        AND "channel" = 'WEB'
        AND "placedAt" >= ${since}
      GROUP BY 1
    `);
    const dayMap = new Map<string, { scans: number; webOrders: number }>();
    const day = (d: string) => {
      const cur = dayMap.get(d) ?? { scans: 0, webOrders: 0 };
      dayMap.set(d, cur);
      return cur;
    };
    for (const r of scanByDay) day(r.day).scans += Number(r.n);
    for (const r of rollupByDay) day(r.date.toISOString().slice(0, 10)).scans += r._sum.count ?? 0;
    for (const r of orderByDay) day(r.day).webOrders += Number(r.n);
    const byDay = [...dayMap.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const templateRaw = await this.prisma.scanEvent.groupBy({
      by: ['template'],
      _count: { _all: true },
      where: { qrCodeId: { in: ids }, occurredAt: { gte: since }, decision: { in: SCAN_DECISIONS }, template: { not: null } },
    });
    const templateRolled = await this.prisma.scanDailyRollup.groupBy({
      by: ['template'],
      _sum: { count: true },
      where: { qrCodeId: { in: ids }, date: { gte: since }, decision: { in: SCAN_DECISIONS }, template: { not: null } },
    });
    const templateMap = new Map<string, number>();
    for (const r of templateRaw) templateMap.set(r.template!, (templateMap.get(r.template!) ?? 0) + r._count._all);
    for (const r of templateRolled) templateMap.set(r.template!, (templateMap.get(r.template!) ?? 0) + (r._sum.count ?? 0));
    const byTemplate = [...templateMap.entries()]
      .map(([template, scans]) => ({ template, scans }))
      .sort((a, b) => b.scans - a.scans);

    const totals = {
      scans: scansRaw + scansRolled,
      approxUniqueScanners,
      storeViews: storeViewsRaw + storeViewsRolled,
      webOrders,
      appOpens: appOpensRaw + appOpensRolled,
      installTaps: installTapsRaw + installTapsRolled,
      // Needs the app's first-launch claim report to tie installs to accounts;
      // that linkage lands with the deep-link slice. A real zero until then.
      attributedFirstOrders: 0,
      installsAttributed,
    };

    return {
      range,
      totals,
      funnel: [
        { stage: 'SCAN', count: totals.scans },
        { stage: 'STORE_VIEW', count: totals.storeViews },
        { stage: 'WEB_ORDER', count: totals.webOrders },
        { stage: 'INSTALL_TAP', count: totals.installTaps },
        { stage: 'INSTALL_ATTRIBUTED', count: totals.installsAttributed },
        { stage: 'ATTRIBUTED_FIRST_ORDER', count: totals.attributedFirstOrders },
      ],
      byDay,
      byTemplate,
    };
  }
}
