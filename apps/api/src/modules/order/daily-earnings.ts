import { startOfDayGY } from '../../utils/time-gy';

// ---------------------------------------------------------------------------
// Daily earnings for the mover Home chart [SWIFT-DASH-03]. The chart was
// grouped CLIENT-SIDE from the paginated earnings list (limit 20), so an
// active mover's older days silently truncated to ~0. This computes each
// Guyana-local day's true total with a SQL aggregate per day (server-side,
// over ALL rows in the day — never a capped list), so the trend is honest.
// ---------------------------------------------------------------------------

type EarningAgg = {
  earning: { aggregate: (args: unknown) => Promise<{ _sum: { amount: unknown } }> };
};

export interface DailyEarning {
  /** ISO date (Guyana day) */
  date: string;
  total: number;
  isToday: boolean;
}

/** Per-Guyana-day earnings totals for the last `days` days (oldest first).
 *  `prisma` is `unknown` + cast internally — Prisma's generic aggregate
 *  signature isn't structurally assignable to the loose one (same pattern as
 *  statement.ts). */
export async function dailyEarnings(
  prismaClient: unknown,
  where: Record<string, string>,
  days = 7,
): Promise<DailyEarning[]> {
  const prisma = prismaClient as EarningAgg;
  const todayStart = startOfDayGY().getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const results = await Promise.all(
    Array.from({ length: days }, (_, idx) => {
      const i = days - 1 - idx; // oldest first
      const start = new Date(todayStart - i * dayMs);
      const end = new Date(start.getTime() + dayMs);
      return prisma.earning
        .aggregate({ where: { ...where, createdAt: { gte: start, lt: end } }, _sum: { amount: true } })
        .then((agg) => ({
          date: start.toISOString().slice(0, 10),
          total: Number(agg._sum.amount ?? 0),
          isToday: i === 0,
        }));
    }),
  );
  return results;
}
