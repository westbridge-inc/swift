import type { PrismaClient } from '@prisma/client';
import { algoConfig } from '../algo/algo-config';
import { recordDecision, shadow } from '../algo/decisions';
import { log } from '../../utils/logger';

/**
 * [ALG-03 / FMC-01 Movement 12] Ready-time prediction — the prep-time learner.
 *
 * SHADOW ONLY (L4). Nothing here changes when a rider is dispatched or what a
 * customer is promised. It learns, predicts beside every accept, grades
 * itself nightly against what actually happened, and records whether the
 * promotion gate for PREDICTIVE dispatch has passed. dispatch-trigger.ts
 * keeps resolving PREDICTIVE to ON_ACCEPT until a person reads that row and
 * promotes it.
 *
 *   learn     acceptedAt → readyAt of every completed order in the trailing
 *             30 days, per vendor, per day-of-week and hour bucket in
 *             America/Guyana (FMC R-12.1). Outliers — a vendor who was
 *             clearly not attending — are COUNTED, never averaged in
 *             (R-12.1.2). Vendor-overall and vertical rows are learned from
 *             the same samples so the fallback tiers are real numbers, not
 *             guesses.
 *   predict   tiers, in order: the bucket (n ≥ prep.minBucketSamples) → the
 *             vendor overall (n ≥ prep.minVendorSamples) → the vertical → the
 *             vendor's own declared prep time → 30 minutes. Then basket size
 *             (perItemSeconds beyond the bucket's median basket, learned
 *             tiers only) and live load (queueSeconds per order already in
 *             the kitchen). p50 and p80 both published: dispatch would use
 *             p50, any customer promise uses p80 (R-12.1.3 — under-promising
 *             is cheaper than apologising).
 *   grade     median absolute error of p50 and p80 coverage over 14 days;
 *             the gate is MAE ≤ prep.gateMaeMinutes AND coverage ≥
 *             prep.gateCoverage over at least MIN_GRADED predictions.
 *
 * Conflict registered, not decided here: FMC R-2.4.2 degrades PREDICTIVE to
 * ON_READY; the algorithm document (newer, code-aware) degrades to ON_ACCEPT
 * — the code's current behaviour and the earlier of the two. ON_ACCEPT wins
 * until the founder rules.
 */

export const ALGO_ID = 'ALG-03';
export const GUYANA_TZ = 'America/Guyana';
export const DEFAULT_PREP_SECONDS = 30 * 60;
export const LEARN_WINDOW_DAYS = 30;
export const GRADE_WINDOW_DAYS = 14;
/** Below this many graded predictions the gate cannot pass, whatever the numbers say. */
export const MIN_GRADED = 30;
/** R-12.1.2: longer than max(90 min, 4 × the bucket's median) is "not attending". */
export const OUTLIER_FLOOR_SECONDS = 90 * 60;
export const OUTLIER_FACTOR = 4;
/** A tier with no distribution publishes p80 = p50 × this. */
export const NO_DISTRIBUTION_P80_FACTOR = 1.25;
export const AGGREGATE_BUCKET = -1;
export const verticalKey = (vendorType: string): string => `vertical:${vendorType}`;

export type PrepTier = 'BUCKET' | 'VENDOR' | 'VERTICAL' | 'DECLARED' | 'DEFAULT';
export type PrepScope = 'BUCKET' | 'VENDOR' | 'VERTICAL';

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const bucketFormatter = new Intl.DateTimeFormat('en-US', { timeZone: GUYANA_TZ, weekday: 'short', hour: 'numeric', hour12: false });

/** Day-of-week and hour of `at` in America/Guyana — the bucket a sample belongs to. */
export function bucketOf(at: Date): { dayOfWeek: number; hourBucket: number } {
  const parts = bucketFormatter.formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  return { dayOfWeek: DOW[weekday] ?? 0, hourBucket: Number.isFinite(hour) ? hour : 0 };
}

/** Nearest-rank percentile of an ascending list; 0 for an empty list. */
export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(p * sortedAsc.length)));
  return sortedAsc[rank - 1]!;
}

export function splitOutliers(seconds: number[]): { kept: number[]; outliers: number[] } {
  const positive = seconds.filter((s) => Number.isFinite(s) && s > 0);
  const sorted = [...positive].sort((a, b) => a - b);
  const cap = Math.max(OUTLIER_FLOOR_SECONDS, OUTLIER_FACTOR * percentile(sorted, 0.5));
  const kept: number[] = [];
  const outliers: number[] = [];
  for (const s of sorted) (s > cap ? outliers : kept).push(s);
  return { kept, outliers };
}

export interface PrepSummary {
  n: number;
  outliers: number;
  p50: number;
  p80: number;
  p95: number;
  medianItems: number;
}

export function summarise(samples: Array<{ seconds: number; items: number }>): PrepSummary {
  const { kept, outliers } = splitOutliers(samples.map((s) => s.seconds));
  const items = samples.map((s) => Math.max(1, Math.round(s.items))).sort((a, b) => a - b);
  return {
    n: kept.length,
    outliers: outliers.length,
    p50: Math.round(percentile(kept, 0.5)),
    p80: Math.round(percentile(kept, 0.8)),
    p95: Math.round(percentile(kept, 0.95)),
    medianItems: Math.max(1, percentile(items, 0.5)),
  };
}

const minutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

// ---------------------------------------------------------------------------
// Learn
// ---------------------------------------------------------------------------

export interface LearnResult {
  orders: number;
  buckets: number;
  vendors: number;
  verticals: number;
  pruned: number;
}

export async function computePrepStats(prisma: PrismaClient, now = new Date(), days = LEARN_WINDOW_DAYS): Promise<LearnResult> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const orders = await prisma.order.findMany({
    where: { acceptedAt: { gte: since }, readyAt: { not: null }, vendorId: { not: null }, orderType: { not: 'TAXI' } },
    select: {
      tenantId: true, vendorId: true, acceptedAt: true, readyAt: true,
      vendor: { select: { vendorType: true } },
      items: { select: { quantity: true } },
    },
  });

  type Group = { tenantId: string; scope: PrepScope; vendorId: string; dayOfWeek: number; hourBucket: number; samples: Array<{ seconds: number; items: number }> };
  const groups = new Map<string, Group>();
  const add = (g: Omit<Group, 'samples'>, sample: { seconds: number; items: number }) => {
    const key = `${g.tenantId}|${g.vendorId}|${g.dayOfWeek}|${g.hourBucket}`;
    const existing = groups.get(key);
    if (existing) existing.samples.push(sample);
    else groups.set(key, { ...g, samples: [sample] });
  };
  for (const o of orders) {
    if (!o.vendorId || !o.acceptedAt || !o.readyAt || !o.vendor) continue;
    const seconds = (o.readyAt.getTime() - o.acceptedAt.getTime()) / 1000;
    if (!(seconds > 0)) continue;
    const items = o.items.reduce((n, it) => n + (it.quantity ?? 1), 0) || 1;
    const b = bucketOf(o.acceptedAt);
    add({ tenantId: o.tenantId, scope: 'BUCKET', vendorId: o.vendorId, ...b }, { seconds, items });
    add({ tenantId: o.tenantId, scope: 'VENDOR', vendorId: o.vendorId, dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET }, { seconds, items });
    add({ tenantId: o.tenantId, scope: 'VERTICAL', vendorId: verticalKey(o.vendor.vendorType), dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET }, { seconds, items });
  }

  const startedAt = now;
  const counts = { buckets: 0, vendors: 0, verticals: 0 };
  for (const g of groups.values()) {
    const s = summarise(g.samples);
    if (!s.n) continue;
    const data = {
      scope: g.scope, sampleCount: s.n, outlierCount: s.outliers, medianItems: s.medianItems,
      p50Seconds: s.p50, p80Seconds: s.p80, p95Seconds: s.p95, lastComputedAt: startedAt,
    };
    await prisma.vendorPrepStat.upsert({
      where: { tenantId_vendorId_dayOfWeek_hourBucket: { tenantId: g.tenantId, vendorId: g.vendorId, dayOfWeek: g.dayOfWeek, hourBucket: g.hourBucket } },
      create: { tenantId: g.tenantId, vendorId: g.vendorId, dayOfWeek: g.dayOfWeek, hourBucket: g.hourBucket, ...data },
      update: data,
    });
    if (g.scope === 'BUCKET') counts.buckets += 1;
    else if (g.scope === 'VENDOR') counts.vendors += 1;
    else counts.verticals += 1;
  }
  // A bucket with no sample in the window is not "still true from last month"; it is gone.
  const pruned = await prisma.vendorPrepStat.deleteMany({ where: { lastComputedAt: { lt: startedAt } } });
  return { orders: orders.length, ...counts, pruned: pruned.count };
}

export async function prepStatsSummary(prisma: PrismaClient): Promise<{ buckets: number; vendors: number; verticals: number; lastComputedAt: string | null }> {
  const [buckets, vendors, verticals, latest] = await Promise.all([
    prisma.vendorPrepStat.count({ where: { scope: 'BUCKET' } }),
    prisma.vendorPrepStat.count({ where: { scope: 'VENDOR' } }),
    prisma.vendorPrepStat.count({ where: { scope: 'VERTICAL' } }),
    prisma.vendorPrepStat.findFirst({ orderBy: { lastComputedAt: 'desc' }, select: { lastComputedAt: true } }),
  ]);
  return { buckets, vendors, verticals, lastComputedAt: latest?.lastComputedAt.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// Predict
// ---------------------------------------------------------------------------

export interface PredictInput {
  vendorId: string;
  vendorType: string;
  /** The vendor's own declared prep time (minutes), the tier before the default. */
  declaredMinutes: number | null;
  at: Date;
  itemCount: number;
  tenantId?: string;
  /** The order being predicted must not count as its own live load. */
  excludeOrderId?: string;
}

export interface PrepPrediction {
  p50Seconds: number;
  p80Seconds: number;
  tier: PrepTier;
  sampleCount: number;
  baseP50Seconds: number;
  baseP80Seconds: number;
  basketSeconds: number;
  loadSeconds: number;
  liveLoad: number;
  configVersion: number;
}

export async function predictReady(prisma: PrismaClient, input: PredictInput): Promise<PrepPrediction> {
  const [minBucket, minVendor, perItem, queueS] = await Promise.all([
    algoConfig(prisma, 'prep.minBucketSamples'),
    algoConfig(prisma, 'prep.minVendorSamples'),
    algoConfig(prisma, 'prep.perItemSeconds'),
    algoConfig(prisma, 'prep.queueSeconds'),
  ]);
  const configVersion = Math.max(minBucket.version, minVendor.version, perItem.version, queueS.version);
  const tenantId = input.tenantId ?? 'swift-default';
  const b = bucketOf(input.at);
  const rows = await prisma.vendorPrepStat.findMany({
    where: {
      tenantId,
      OR: [
        { vendorId: input.vendorId, dayOfWeek: b.dayOfWeek, hourBucket: b.hourBucket },
        { vendorId: input.vendorId, dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET },
        { vendorId: verticalKey(input.vendorType), dayOfWeek: AGGREGATE_BUCKET, hourBucket: AGGREGATE_BUCKET },
      ],
    },
  });
  const bucket = rows.find((r) => r.vendorId === input.vendorId && r.dayOfWeek === b.dayOfWeek && r.hourBucket === b.hourBucket && r.sampleCount >= Number(minBucket.value));
  const vendor = rows.find((r) => r.vendorId === input.vendorId && r.dayOfWeek === AGGREGATE_BUCKET && r.sampleCount >= Number(minVendor.value));
  const vertical = rows.find((r) => r.vendorId === verticalKey(input.vendorType) && r.dayOfWeek === AGGREGATE_BUCKET && r.sampleCount >= Number(minVendor.value));

  let tier: PrepTier;
  let baseP50: number;
  let baseP80: number;
  let sampleCount = 0;
  let medianItems = 1;
  const learned = bucket ?? vendor ?? vertical;
  if (learned) {
    tier = bucket ? 'BUCKET' : vendor ? 'VENDOR' : 'VERTICAL';
    baseP50 = learned.p50Seconds;
    baseP80 = learned.p80Seconds;
    sampleCount = learned.sampleCount;
    medianItems = learned.medianItems;
  } else if (input.declaredMinutes && input.declaredMinutes > 0) {
    tier = 'DECLARED';
    baseP50 = Math.round(input.declaredMinutes * 60);
    baseP80 = Math.round(baseP50 * NO_DISTRIBUTION_P80_FACTOR);
  } else {
    tier = 'DEFAULT';
    baseP50 = DEFAULT_PREP_SECONDS;
    baseP80 = Math.round(DEFAULT_PREP_SECONDS * NO_DISTRIBUTION_P80_FACTOR);
  }

  const basketSeconds = learned ? Number(perItem.value) * Math.max(0, Math.round(input.itemCount) - medianItems) : 0;
  const liveLoad = await prisma.order.count({
    where: {
      vendorId: input.vendorId,
      status: { in: ['ACCEPTED', 'PREPARING'] },
      ...(input.excludeOrderId ? { id: { not: input.excludeOrderId } } : {}),
    },
  });
  const loadSeconds = liveLoad * Number(queueS.value);

  return {
    p50Seconds: baseP50 + basketSeconds + loadSeconds,
    p80Seconds: baseP80 + basketSeconds + loadSeconds,
    tier, sampleCount, baseP50Seconds: baseP50, baseP80Seconds: baseP80, basketSeconds, loadSeconds, liveLoad, configVersion,
  };
}

const TIER_WORDS: Record<PrepTier, string> = {
  BUCKET: 'this vendor at this hour',
  VENDOR: 'this vendor overall',
  VERTICAL: 'vendors of this kind',
  DECLARED: 'the vendor’s declared prep time',
  DEFAULT: 'the platform default',
};

/** Shadow row beside an accept: what the learner WOULD have predicted. Never throws. */
export async function shadowPredictAtAccept(prisma: PrismaClient, orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, tenantId: true, vendorId: true, orderType: true, acceptedAt: true, estimatedPrepTime: true,
        vendor: { select: { vendorType: true, estimatedPrepTime: true } },
        items: { select: { quantity: true } },
      },
    });
    if (!order || !order.vendorId || !order.vendor || order.orderType === 'TAXI') return;
    const at = order.acceptedAt ?? new Date();
    const itemCount = order.items.reduce((n, it) => n + (it.quantity ?? 1), 0) || 1;
    const vendorId = order.vendorId;
    const vendorType = order.vendor.vendorType;
    const declaredMinutes = order.estimatedPrepTime ?? order.vendor.estimatedPrepTime ?? null;
    await shadow(prisma, { algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId }, async () => {
      const p = await predictReady(prisma, { vendorId, vendorType, declaredMinutes, at, itemCount, tenantId: order.tenantId, excludeOrderId: order.id });
      return {
        outcome: 'PREDICTED',
        sentence: `Ready in about ${minutes(p.p50Seconds)} min, ${minutes(p.p80Seconds)} at the outside — from ${TIER_WORDS[p.tier]} (${p.sampleCount} samples), ${p.liveLoad} already in the kitchen.`,
        inputs: {
          p50Seconds: p.p50Seconds, p80Seconds: p.p80Seconds, tier: p.tier, sampleCount: p.sampleCount,
          baseP50Seconds: p.baseP50Seconds, baseP80Seconds: p.baseP80Seconds, basketSeconds: p.basketSeconds,
          loadSeconds: p.loadSeconds, liveLoad: p.liveLoad, itemCount, acceptedAt: at.toISOString(), configVersion: p.configVersion,
        },
      };
    }, undefined);
  } catch (err) {
    log().warn({ err, orderId }, 'prep-time: shadow prediction failed');
  }
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

export interface ShadowReport {
  days: number;
  predicted: number;
  graded: number;
  medianAbsErrorMinutes: number | null;
  p80Coverage: number | null;
  byTier: Record<string, { graded: number; medianAbsErrorMinutes: number | null; p80Coverage: number | null }>;
  gate: { maeMinutes: number; coverage: number; minGraded: number; maeOk: boolean; coverageOk: boolean; enoughGraded: boolean; passes: boolean };
}

export async function prepShadowReport(prisma: PrismaClient, days = GRADE_WINDOW_DAYS, now = new Date()): Promise<ShadowReport> {
  const [gateMae, gateCov] = await Promise.all([algoConfig(prisma, 'prep.gateMaeMinutes'), algoConfig(prisma, 'prep.gateCoverage')]);
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.algoDecision.findMany({
    where: { algo: ALGO_ID, shadow: true, outcome: 'PREDICTED', createdAt: { gte: since } },
    select: { subjectId: true, inputs: true },
  });
  const orders = rows.length
    ? await prisma.order.findMany({ where: { id: { in: rows.map((r) => r.subjectId) }, readyAt: { not: null } }, select: { id: true, acceptedAt: true, readyAt: true } })
    : [];
  const actualById = new Map(orders.map((o) => [o.id, o]));

  const errors: number[] = [];
  let covered = 0;
  const tiers = new Map<string, { errors: number[]; covered: number }>();
  for (const r of rows) {
    const o = actualById.get(r.subjectId);
    const inputs = r.inputs as Record<string, unknown>;
    const p50 = Number(inputs['p50Seconds']);
    const p80 = Number(inputs['p80Seconds']);
    const acceptedAt = typeof inputs['acceptedAt'] === 'string' ? new Date(inputs['acceptedAt'] as string) : o?.acceptedAt;
    if (!o?.readyAt || !acceptedAt || !Number.isFinite(p50) || !Number.isFinite(p80)) continue;
    const actual = (o.readyAt.getTime() - acceptedAt.getTime()) / 1000;
    if (!(actual > 0)) continue;
    const err = Math.abs(actual - p50) / 60;
    errors.push(err);
    const inside = actual <= p80;
    if (inside) covered += 1;
    const tier = String(inputs['tier'] ?? 'UNKNOWN');
    const t = tiers.get(tier) ?? { errors: [], covered: 0 };
    t.errors.push(err);
    if (inside) t.covered += 1;
    tiers.set(tier, t);
  }
  const graded = errors.length;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const mae = graded ? round2(percentile([...errors].sort((a, b) => a - b), 0.5)) : null;
  const coverage = graded ? round2(covered / graded) : null;
  const byTier: ShadowReport['byTier'] = {};
  for (const [tier, t] of tiers) {
    byTier[tier] = {
      graded: t.errors.length,
      medianAbsErrorMinutes: t.errors.length ? round2(percentile([...t.errors].sort((a, b) => a - b), 0.5)) : null,
      p80Coverage: t.errors.length ? round2(t.covered / t.errors.length) : null,
    };
  }
  const maeOk = mae != null && mae <= Number(gateMae.value);
  const coverageOk = coverage != null && coverage >= Number(gateCov.value);
  const enoughGraded = graded >= MIN_GRADED;
  return {
    days, predicted: rows.length, graded, medianAbsErrorMinutes: mae, p80Coverage: coverage, byTier,
    gate: { maeMinutes: Number(gateMae.value), coverage: Number(gateCov.value), minGraded: MIN_GRADED, maeOk, coverageOk, enoughGraded, passes: maeOk && coverageOk && enoughGraded },
  };
}

/** The nightly grade: the report, recorded as a shadow row so the gate's history is readable. */
export async function gradeShadow(prisma: PrismaClient, now = new Date()): Promise<ShadowReport> {
  const report = await prepShadowReport(prisma, GRADE_WINDOW_DAYS, now);
  const g = report.gate;
  const sentence = report.graded
    ? `Over ${report.days} days, ${report.graded} graded predictions: median error ${report.medianAbsErrorMinutes} min, p80 covered ${Math.round((report.p80Coverage ?? 0) * 100)}% — gate ${g.passes ? 'passed' : 'not yet'} (≤ ${g.maeMinutes} min, ≥ ${Math.round(g.coverage * 100)}%, n ≥ ${g.minGraded}).`
    : `Over ${report.days} days, nothing to grade yet: ${report.predicted} predictions, none with a ready time — gate not yet.`;
  await recordDecision(prisma, {
    algo: ALGO_ID, subjectType: 'VENDOR', subjectId: 'platform', outcome: g.passes ? 'GATE_PASSED' : 'GATE_NOT_YET',
    sentence, inputs: { ...report, byTier: report.byTier }, shadow: true,
  });
  return report;
}
