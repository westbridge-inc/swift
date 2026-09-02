import type { PrismaClient } from '@prisma/client';
import { startOfWeekGY } from '../../utils/time-gy';
import { salesDigestDeltaGauge, salesComponentsGauge, salesComponentsCounter } from '../../plugins/observability';
import { aggregateSalesComponents, type SalesTotals } from './sales-components';
import { log } from '../../utils/logger';

// [M-27] The weekly SALES DIGEST. Swift takes no commission and never holds
// vendor money (cash is customer → vendor direct), so the weekly row is a
// RECORD of a vendor's own completed sales, never a payout. Before: a sliding
// seven-day window measured from whenever the job happened to run (an early
// retry or a late run lost a period's tail or created a shifted duplicate),
// only ACTIVE vendors were counted (a vendor suspended after selling vanished
// from its own record), discounts were ignored (the base was reported as the
// sale), and the admin's "process → PAID" described money Swift never moved.
// Now: canonical calendar weeks (Guyana Monday 00:00 → next Monday), one
// DIGEST row per (vendor, period) enforced by the database — concurrent
// workers cannot duplicate it — every vendor with completed sales in the
// period, discounts allocated, and every correction a later immutable
// ADJUSTMENT recomputed from the ledger.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** How far back a first run digests — bounded so a fresh deployment does not
 *  rebuild years in one tick; older weeks are adjusted on request. */
export const DIGEST_LOOKBACK_WEEKS = 26;

export interface DigestTotals extends SalesTotals {
  totalOrders: number;
  totalBase: number;
  totalMarkup: number;
  totalDiscount: number;
  /** [M-38] 1 = the separated components are present. */
  componentsVersion: number;
}
export const DIGEST_COMPONENTS_VERSION = 1;
const EMPTY_COMPONENTS: SalesTotals = { goodsSales: 0, vendorPromoDiscount: 0, sponsorReceivable: 0, customerCollection: 0, feeFunding: 0, moverPayable: 0, estimatedOrders: 0, netSales: 0 };

/** The canonical period a moment belongs to. */
export function digestPeriodFor(at: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = startOfWeekGY(at);
  return { periodStart, periodEnd: new Date(periodStart.getTime() + WEEK_MS) };
}

/** Every complete calendar week that ended at or before `now`, newest first, bounded. */
export function completePeriodsBefore(now: Date, lookbackWeeks = DIGEST_LOOKBACK_WEEKS): Array<{ periodStart: Date; periodEnd: Date }> {
  const current = digestPeriodFor(now).periodStart; // the week in progress — never digested
  const out: Array<{ periodStart: Date; periodEnd: Date }> = [];
  for (let i = 1; i <= lookbackWeeks; i += 1) {
    const periodStart = new Date(current.getTime() - i * WEEK_MS);
    out.push({ periodStart, periodEnd: new Date(periodStart.getTime() + WEEK_MS) });
  }
  return out;
}

/** The ledger's answer for one vendor and period: every order that reached
 *  COMPLETED inside the period (the one universal, once-per-order completion
 *  marker — SWIFT-022) and is still a completed sale, with its discount. */
export async function computeDigest(prisma: PrismaClient, vendorId: string, period: { periodStart: Date; periodEnd: Date }): Promise<DigestTotals> {
  const completed = await prisma.orderStatusLog.findMany({
    where: { status: 'COMPLETED', createdAt: { gte: period.periodStart, lt: period.periodEnd }, order: { vendorId } },
    select: { orderId: true },
    distinct: ['orderId'],
  });
  if (completed.length === 0) return { totalOrders: 0, totalBase: 0, totalMarkup: 0, totalDiscount: 0, ...EMPTY_COMPONENTS, componentsVersion: DIGEST_COMPONENTS_VERSION };
  const ids = completed.map((c) => c.orderId);
  const agg = await prisma.order.aggregate({
    where: { id: { in: ids }, vendorId, status: { in: ['DELIVERED', 'COMPLETED'] } },
    _sum: { subtotalBase: true, subtotalMarkup: true, discount: true },
    _count: { _all: true },
  });
  const totalBase = Number(agg._sum.subtotalBase ?? 0);
  const totalDiscount = Number(agg._sum.discount ?? 0);
  // [M-38] The separated components from each order's redemption snapshot;
  // netSales is what the vendor keeps from goods (its own promotions only).
  const { orders: componentOrders, ...components } = await aggregateSalesComponents(prisma, { vendorId, orderIds: ids });
  void componentOrders; // the digest counts orders by the COMPLETED log, not by the components query
  // The shadow: what the old digest called net (every discount subtracted).
  const legacyNet = Math.round((totalBase - totalDiscount) * 100) / 100;
  if (Math.abs(legacyNet - components.netSales) > 0.009) salesComponentsCounter.labels('shadow_diff').inc();
  return {
    totalOrders: agg._count._all,
    totalBase,
    totalMarkup: Number(agg._sum.subtotalMarkup ?? 0),
    totalDiscount,
    ...components,
    componentsVersion: DIGEST_COMPONENTS_VERSION,
  };
}

/** [M-38 · operations] Recompute historical digests with versioned
 *  adjustments: the latest row of every (vendor, period) still at
 *  componentsVersion 0 gets an ADJUSTMENT carrying the components — bounded
 *  per run, idempotent (an adjusted period is no longer at version 0). */
export async function recomputeLegacyDigests(prisma: PrismaClient, limit = 50): Promise<{ adjusted: number; pending: number }> {
  const legacy = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "settlements" s
    WHERE s."componentsVersion" = 0
      AND s."sequence" = (SELECT max(x."sequence") FROM "settlements" x WHERE x."vendorId" = s."vendorId" AND x."periodStart" = s."periodStart")
    ORDER BY s."periodStart" DESC LIMIT ${limit + 1}`;
  let adjusted = 0;
  for (const row of legacy.slice(0, limit)) {
    await adjustSalesDigest(prisma, row.id, '[M-38] components recompute — legacy digest was estimated, not settled');
    adjusted += 1;
  }
  const pending = Math.max(0, legacy.length - adjusted);
  salesComponentsGauge.labels('legacy_digests_pending').set(pending);
  if (adjusted > 0) log().info({ adjusted, pending }, '[M-38] legacy sales digests recomputed with components');
  return { adjusted, pending };
}

/** Generate the missing DIGEST rows: for every complete period in the lookback,
 *  every vendor with completed sales in it that has no digest yet. The unique
 *  (vendor, period, sequence 0) makes a concurrent or repeated run a no-op. */
export async function generateSalesDigests(prisma: PrismaClient, now = new Date(), lookbackWeeks = DIGEST_LOOKBACK_WEEKS): Promise<{ created: number; periods: number }> {
  let created = 0;
  const periods = completePeriodsBefore(now, lookbackWeeks);
  for (const period of periods) {
    // The population is whoever SOLD in the period — suspended since or not.
    const sellers = await prisma.orderStatusLog.findMany({
      where: { status: 'COMPLETED', createdAt: { gte: period.periodStart, lt: period.periodEnd }, order: { vendorId: { not: null } } },
      select: { order: { select: { vendorId: true } } },
      distinct: ['orderId'],
    });
    const vendorIds = [...new Set(sellers.map((s) => s.order.vendorId).filter((v): v is string => !!v))];
    if (vendorIds.length === 0) continue;
    const have = new Set((await prisma.settlement.findMany({ where: { vendorId: { in: vendorIds }, periodStart: period.periodStart, sequence: 0 }, select: { vendorId: true } })).map((r) => r.vendorId));
    for (const vendorId of vendorIds) {
      if (have.has(vendorId)) continue;
      const totals = await computeDigest(prisma, vendorId, period);
      if (totals.totalOrders === 0) continue;
      const res = await prisma.settlement.createMany({
        data: [{ vendorId, periodStart: period.periodStart, periodEnd: period.periodEnd, kind: 'DIGEST', sequence: 0, ...totals, status: 'PENDING' }],
        skipDuplicates: true, // a concurrent worker wrote it first: one row, ever
      });
      created += res.count;
    }
  }
  if (created > 0) log().info({ created, periods: periods.length }, '[M-27] sales digests created');
  return { created, periods: periods.length };
}

/** A correction is a new, immutable ADJUSTMENT row — the period recomputed
 *  from the ledger now, sequence n+1, naming the row it supersedes. */
export async function adjustSalesDigest(prisma: PrismaClient, settlementId: string, reason: string): Promise<{ id: string; sequence: number; supersedesId: string; totals: DigestTotals }> {
  const latest = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
  const period = { periodStart: latest.periodStart, periodEnd: latest.periodEnd };
  const totals = await computeDigest(prisma, latest.vendorId, period);
  const head = await prisma.settlement.findFirst({ where: { vendorId: latest.vendorId, periodStart: latest.periodStart }, orderBy: { sequence: 'desc' }, select: { id: true, sequence: true } });
  const sequence = (head?.sequence ?? 0) + 1;
  const row = await prisma.settlement.create({
    data: { vendorId: latest.vendorId, periodStart: period.periodStart, periodEnd: period.periodEnd, kind: 'ADJUSTMENT', sequence, supersedesId: head?.id ?? latest.id, reason, ...totals, status: 'PENDING' },
    select: { id: true, sequence: true, supersedesId: true },
  });
  return { id: row.id, sequence: row.sequence, supersedesId: row.supersedesId!, totals };
}

/** [M-27 · operations] The ledger delta: the latest row of every recent period
 *  compared with a recompute now. A difference is a period to adjust — found
 *  and gauged, never rewritten here. */
export async function scanSalesDigestDelta(prisma: PrismaClient, now = new Date(), weeks = 8): Promise<Array<{ settlementId: string; vendorId: string; periodStart: Date; stored: number; recomputed: number }>> {
  const periods = completePeriodsBefore(now, weeks);
  const found: Array<{ settlementId: string; vendorId: string; periodStart: Date; stored: number; recomputed: number }> = [];
  for (const period of periods) {
    const rows = await prisma.settlement.findMany({ where: { periodStart: period.periodStart }, orderBy: [{ vendorId: 'asc' }, { sequence: 'desc' }] });
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.vendorId)) continue; // only the latest row of each vendor's period
      seen.add(row.vendorId);
      const totals = await computeDigest(prisma, row.vendorId, period);
      if (Math.abs(totals.netSales - Number(row.netSales)) > 0.009 || totals.totalOrders !== row.totalOrders) {
        found.push({ settlementId: row.id, vendorId: row.vendorId, periodStart: period.periodStart, stored: Number(row.netSales), recomputed: totals.netSales });
      }
    }
  }
  salesDigestDeltaGauge.set(found.length);
  if (found.length > 0) log().warn({ count: found.length, sample: found.slice(0, 10) }, '[M-27] sales digests that no longer match the ledger — adjust them');
  return found;
}
