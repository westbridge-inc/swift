import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * SWIFT-080: the earnings-summary "window" contract. Both
 * `/rider/earnings/summary` and `/driver/earnings/summary` must return each
 * window (today / thisWeek / thisMonth / allTime) as `{ total, count }` — the
 * mover EarningsScreen and MoverAccountScreen read `.today.total` / `.today.count`.
 *
 * The driver route used to return each window as a bare `Number`, so a DRIVER's
 * Today / This-month / All-time tiles silently rendered $0 (the client read
 * `.total` off a number → undefined → 0). Same screen, role-dependent shape —
 * the exact drift class SWIFT-080 exists to kill. This is the single source so
 * the two routes cannot diverge again.
 *
 * `count` is the jobs in the window (jobsIn below).
 */
export function earningsWindow(agg: { _sum: { amount: unknown } }, jobs: number): {
  total: number;
  count: number;
} {
  return { total: Number(agg._sum.amount ?? 0), count: jobs };
}

/**
 * [BUG-HUNT F08] One job is one job. There is one Earning row per fee and per tip, so counting rows called a delivery
 * with a tip two jobs, beside a history listing one. The count is the orders behind the rows.
 */
export async function jobsIn(db: Pick<PrismaClient, 'earning'>, where: Prisma.EarningWhereInput): Promise<number> {
  return (await db.earning.groupBy({ by: ['orderId'], where })).length;
}
