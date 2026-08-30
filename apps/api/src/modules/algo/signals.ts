import type { PrismaClient } from '@prisma/client';

/**
 * [ALGO Band 0.4] The signal store — read-only, from history that ALREADY
 * exists. Algorithms must not each invent their own feature computation, so
 * this is the one place the shared signals are computed:
 *
 *   vendor acknowledgement latency  ← AlertDelivery (VENDOR_ORDER) sentAt →
 *                                     acknowledgedAt, recorded on every ping
 *   vendor prep duration            ← OrderStatusLog ACCEPTED → READY_FOR_PICKUP
 *   rider rates                     ← the Rider row's maintained columns
 *
 * Nothing is captured anew here. ALG-03, ALG-48 and ALG-55 read these.
 *
 * ⚠️ SURVIVORSHIP. A vendor who ignores every alert has NO latency and would
 * vanish from a percentile over answered pings — "never answering" must
 * never score better than "answering slowly". So every latency signal
 * carries `coverage` (answered ÷ sent) beside the percentiles, and a
 * `censoredP50Minutes` that ranks the unanswered as slower than anything
 * answered: null means more than half of the pings were never answered at
 * all, which is the honest median.
 *
 * ⚠️ CALIBRATION. Prep-time history on a fresh database is SEED data written
 * seconds apart (p50 ≈ 0 min). The store reports what the rows say; it is the
 * consumer's job not to promote an algorithm on a gate scored against seed.
 */

export interface LatencySignal {
  sentCount: number;
  answeredCount: number;
  /** answered ÷ sent, 0..1. Publish it beside every percentile. */
  coverage: number;
  /** Over ANSWERED pings only — optimistic by construction. */
  answeredP50Minutes: number | null;
  answeredP90Minutes: number | null;
  /** Unanswered pings ranked slower than every answered one. */
  censoredP50Minutes: number | null;
}

export interface DurationSignal {
  sampleSize: number;
  p50Minutes: number | null;
  p90Minutes: number | null;
}

export interface RiderRates {
  acceptanceRate: number;
  completionRate: number;
  averageRating: number;
}

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Nearest-rank percentile on an ascending array. Empty → null. */
export function percentile(sortedAscending: number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscending.length));
  return sortedAscending[rank - 1] ?? null;
}

export async function vendorAckLatency(
  prisma: PrismaClient,
  vendorUserId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<LatencySignal> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 14) * DAY);
  const pings = await prisma.alertDelivery.findMany({
    where: { kind: 'VENDOR_ORDER', recipientId: vendorUserId, sentAt: { gte: since, lte: now } },
    select: { sentAt: true, acknowledgedAt: true },
  });
  const answered = pings
    .filter((p) => p.acknowledgedAt !== null)
    .map((p) => Math.max(0, (p.acknowledgedAt!.getTime() - p.sentAt.getTime()) / MINUTE))
    .sort((a, b) => a - b);
  const sentCount = pings.length;
  const answeredCount = answered.length;
  // Censoring: an unanswered ping ranks after every answered one. If the
  // median rank falls among them, the median is "not answered" — null.
  const medianRank = Math.max(1, Math.ceil(0.5 * sentCount));
  const censoredP50Minutes = sentCount === 0 ? null : medianRank <= answeredCount ? answered[medianRank - 1]! : null;
  return {
    sentCount,
    answeredCount,
    coverage: sentCount === 0 ? 0 : answeredCount / sentCount,
    answeredP50Minutes: percentile(answered, 50),
    answeredP90Minutes: percentile(answered, 90),
    censoredP50Minutes,
  };
}

export async function vendorPrepDuration(
  prisma: PrismaClient,
  vendorId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<DurationSignal> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 28) * DAY);
  // Both edges of the window are read so an ACCEPTED just before `since`
  // still pairs with its READY inside it.
  const logs = await prisma.orderStatusLog.findMany({
    where: {
      order: { vendorId },
      status: { in: ['ACCEPTED', 'READY_FOR_PICKUP'] },
      createdAt: { gte: new Date(since.getTime() - 2 * DAY), lte: now },
    },
    select: { orderId: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const accepted = new Map<string, Date>();
  const durations: number[] = [];
  for (const row of logs) {
    if (row.status === 'ACCEPTED') {
      if (!accepted.has(row.orderId)) accepted.set(row.orderId, row.createdAt);
    } else if (row.createdAt >= since) {
      const start = accepted.get(row.orderId);
      if (start) {
        durations.push(Math.max(0, (row.createdAt.getTime() - start.getTime()) / MINUTE));
        accepted.delete(row.orderId); // first READY after ACCEPTED, once per order
      }
    }
  }
  durations.sort((a, b) => a - b);
  return { sampleSize: durations.length, p50Minutes: percentile(durations, 50), p90Minutes: percentile(durations, 90) };
}

export async function riderRates(prisma: PrismaClient, riderId: string): Promise<RiderRates | null> {
  const r = await prisma.rider.findUnique({
    where: { id: riderId },
    select: { acceptanceRate: true, completionRate: true, averageRating: true },
  });
  return r ? { acceptanceRate: r.acceptanceRate, completionRate: r.completionRate, averageRating: r.averageRating } : null;
}
