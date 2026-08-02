import type { PrismaClient } from '@prisma/client';
import { evaluatePureRules, DEFAULT_BATCHING_CONFIG, type CandidateOrder, type BatchingConfig } from './eligibility';
import { log } from '../../utils/logger';

// System 1 Part 8 — SHADOW MODE: evidence before offers. Every tick pairs the
// currently-unassigned dispatchable delivery orders and records which WOULD
// have batched (order-side rules only — rider-dependent rules R3/R4/R12 are
// honestly marked SHADOW_SKIPPED, and R7–R9 belong to the live evaluator).
// ZERO behavior change anywhere: this writes BatchEvaluation rows and
// nothing else. The founder's go/no-go reads ≥2 weeks of these rows
// (acceptance #1). Bounded per tick; cap hits are logged, never silent.

const EVAL_CAP = 200;
const PAIR_DEDUP_MIN = 30; // one row per pair per half hour — evidence, not spam
const ORDER_VERTICAL: Record<string, CandidateOrder['vertical'] | undefined> = {
  FOOD_DELIVERY: 'FOOD',
  GROCERY_DELIVERY: 'GROCERY',
  COURIER: 'COURIER',
};
const SIZE_CLASS: Record<string, CandidateOrder['sizeClass']> = {
  SMALL: 'S', MEDIUM: 'M', LARGE: 'L', EXTRA_LARGE: 'XL',
};

export async function runShadowScan(prisma: PrismaClient, now = new Date()): Promise<{ evaluated: number; wouldBatch: number; capped: boolean }> {
  const settings = await prisma.batchingSettings.findUnique({ where: { tenantId: 'swift-default' } });
  if (settings && !settings.shadowMode && !settings.enabled) return { evaluated: 0, wouldBatch: 0, capped: false };
  const cfg: BatchingConfig = {
    ...DEFAULT_BATCHING_CONFIG,
    ...(settings ? {
      maxOrdersPerRun: settings.maxOrdersPerRun,
      dropoffCorridorM: settings.dropoffCorridorM,
      verticalMatrix: (settings.verticalMatrix as Record<string, boolean> | null) ?? DEFAULT_BATCHING_CONFIG.verticalMatrix,
      sizePoints: (settings.sizePoints as Record<string, number> | null) ?? DEFAULT_BATCHING_CONFIG.sizePoints,
      capacityPointsByVehicle: (settings.capacityPointsByVehicle as Record<string, number> | null) ?? DEFAULT_BATCHING_CONFIG.capacityPointsByVehicle,
    } : {}),
  };

  // The waiting pool: unassigned delivery orders young enough to matter.
  const hourAgo = new Date(now.getTime() - 3600_000);
  const waiting = await prisma.order.findMany({
    where: {
      riderId: null,
      orderType: { in: ['FOOD_DELIVERY', 'GROCERY_DELIVERY', 'COURIER'] },
      status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
      createdAt: { gte: hourAgo, lte: now }, // a scan at time T sees T's world
    },
    select: {
      id: true, orderType: true, courierPackageSize: true, totalAmount: true, paymentMethod: true,
      pickupLat: true, pickupLng: true, deliveryLat: true, deliveryLng: true, vendorId: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 60, // 60 orders → ≤1,770 raw pairs; the eval cap bounds the work
  });
  if (waiting.length < 2) return { evaluated: 0, wouldBatch: 0, capped: false };

  const toCandidate = (o: (typeof waiting)[number]): CandidateOrder | null => {
    const vertical = ORDER_VERTICAL[o.orderType];
    if (!vertical || o.pickupLat == null || o.pickupLng == null) return null;
    return {
      orderId: o.id,
      vertical,
      sizeClass: (o.courierPackageSize && SIZE_CLASS[o.courierPackageSize]) || 'S',
      cashToCollect: o.paymentMethod === 'CASH' ? Number(o.totalAmount) : 0,
      pickup: { lat: o.pickupLat, lng: o.pickupLng, vendorId: o.vendorId },
      dropoff: { lat: o.deliveryLat, lng: o.deliveryLng },
    };
  };
  const candidates = waiting.map(toCandidate).filter((c): c is CandidateOrder => c !== null);

  // Pair-level dedup: skip pairs already evidenced in the window.
  const recent = await prisma.batchEvaluation.findMany({
    where: { decision: 'SHADOW_WOULD_BATCH', createdAt: { gte: new Date(now.getTime() - PAIR_DEDUP_MIN * 60_000) } },
    select: { orderId: true, scoreBreakdown: true },
  });
  const seenPairs = new Set<string>();
  for (const r of recent) {
    const paired = (r.scoreBreakdown as { pairedWith?: string } | null)?.pairedWith;
    if (paired) seenPairs.add([r.orderId, paired].sort().join('|'));
  }

  let evaluated = 0;
  let wouldBatch = 0;
  let capped = false;
  outer: for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (evaluated >= EVAL_CAP) {
        capped = true;
        log().warn({ cap: EVAL_CAP, pool: candidates.length }, 'SCAN_CAPPED: shadow batching evaluation cap hit — oldest pairs first');
        break outer;
      }
      const a = candidates[i]!;
      const b = candidates[j]!;
      const pairKey = [a.orderId, b.orderId].sort().join('|');
      if (seenPairs.has(pairKey)) continue;
      evaluated += 1;

      // Order-side rules only; rider-dependent rules honestly skipped.
      const res = evaluatePureRules(b, { orders: [a], vehicleType: 'MOTORBIKE', riderCashFloatCap: Number.MAX_SAFE_INTEGER, riderBlocked: false }, cfg);
      const orderSide = res.rules.filter((r) => !['R3', 'R4', 'R12'].includes(r.rule));
      const rules = [
        ...orderSide,
        { rule: 'R3', pass: true, value: 'SHADOW_SKIPPED', limit: 'rider-dependent' },
        { rule: 'R4', pass: true, value: 'SHADOW_SKIPPED', limit: 'rider-dependent' },
        { rule: 'R12', pass: true, value: 'SHADOW_SKIPPED', limit: 'rider-dependent' },
      ];
      if (orderSide.every((r) => r.pass)) {
        wouldBatch += 1;
        await prisma.batchEvaluation.create({
          data: {
            orderId: a.orderId,
            decision: 'SHADOW_WOULD_BATCH',
            rulesChecked: rules as never,
            scoreBreakdown: { pairedWith: b.orderId, mode: 'shadow-pure' } as never,
          },
        });
      }
    }
  }
  if (wouldBatch > 0) log().info({ evaluated, wouldBatch, pool: candidates.length }, 'shadow batching scan');
  return { evaluated, wouldBatch, capped };
}

/** The founder's go/no-go read (Part 8): would-batch density over the window. */
export async function shadowReport(prisma: PrismaClient, days = 14) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.batchEvaluation.findMany({
    where: { decision: 'SHADOW_WOULD_BATCH', createdAt: { gte: since } },
    select: { orderId: true, createdAt: true },
  });
  const byDay = new Map<string, number>();
  const orders = new Set<string>();
  for (const r of rows) {
    const d = r.createdAt.toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
    orders.add(r.orderId);
  }
  return {
    windowDays: days,
    totalWouldBatchPairs: rows.length,
    distinctOrdersInvolved: orders.size,
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, pairs]) => ({ day, pairs })),
  };
}
