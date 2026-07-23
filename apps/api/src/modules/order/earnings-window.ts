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
 * `count` requires the aggregate to be taken with `_count: true`.
 */
export function earningsWindow(agg: { _sum: { amount: unknown }; _count?: number }): {
  total: number;
  count: number;
} {
  return { total: Number(agg._sum.amount ?? 0), count: agg._count ?? 0 };
}
