import { z } from 'zod';

/**
 * SWIFT-080 — the mover EARNINGS response contracts.
 *
 * The shared mover screens (EarningsScreen, MoverHomeScreen, MoverAccountScreen)
 * consume BOTH the rider and driver earnings endpoints via `kind`, reading them
 * by these exact field names. Role-dependent drift here already shipped a live
 * bug — /driver/earnings/summary returned each window as a bare Number while
 * /rider returned `{ total, count }`, so a driver's tiles rendered $0 (fixed in
 * #408). These schemas are the single definition of what those endpoints must
 * return; parsing real responses through them in tests makes any future drift
 * fail CI instead of a user's screen. The `.passthrough()` allows role-specific
 * extras (todayRides, ratings, breakdown…) while pinning the shared fields.
 *
 * Server-side today; a follow-on can move these to `packages/types` and have the
 * mobile client infer its types from them, so a rename breaks the client compile.
 */

/** One earnings window — the shape EarningsScreen reads as `.today.total` / `.today.count`. */
export const earningsWindowContract = z.object({
  total: z.number(),
  count: z.number(),
});

/** GET /{rider,driver}/earnings/summary */
export const earningsSummaryContract = z.object({
  success: z.literal(true),
  data: z
    .object({
      today: earningsWindowContract,
      thisWeek: earningsWindowContract,
      thisMonth: earningsWindowContract,
      allTime: earningsWindowContract,
      pendingPayout: z.number(),
    })
    .passthrough(),
});

/** GET /{rider,driver}/earnings/today — the Home "today total" + the day's list. */
export const earningsTodayContract = z.object({
  success: z.literal(true),
  data: z
    .object({
      total: z.number(),
      earnings: z.array(z.unknown()),
    })
    .passthrough(),
});
