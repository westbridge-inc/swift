import { Prisma } from '@prisma/client';
// Type-only import: erased at compile time, so this does NOT create a runtime
// cycle with dispatch.service even though that module imports this one. The
// alternative — redeclaring the two-value union here — would be a second
// definition of something that already has one.
import type { DispatchPool } from './dispatch.service';

/**
 * [B1] How many live legs one mover may hold at once — in ONE place.
 *
 * Today the answer is 1, everywhere, and this module exists to change nothing.
 * That is the whole point of shipping it first: three separate gates currently
 * encode "one at a time" independently, in two different languages, and any
 * future change to that number has to move all three together or it silently
 * does nothing.
 *
 * THE THREE GATES, and why the third is the dangerous one:
 *
 *   1. the DRIVER candidate query   `AND d."currentRideId" IS NULL`   (raw SQL)
 *   2. the RIDER candidate query    `AND r."currentOrderId" IS NULL`  (raw SQL)
 *   3. `canReceiveOffer()`          `currentRideId: null`             (Prisma count)
 *
 * Gates 1 and 2 shape the candidate pool. Gate 3 is checked again at the moment
 * an offer is installed — and it FAILS CLOSED AND SILENTLY. Relax the first two
 * and stacked offers still never fire: `canReceiveOffer` returns false, the
 * cascade moves on, and nothing anywhere reports a reason. Anyone raising the
 * capacity by editing the SQL alone would find the feature simply not working,
 * with a green build and no error to chase.
 *
 * So all three derive from `moverCapacity()` here. When the number moves, it
 * moves once.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: decide. It reports a capacity; it
 * does not know about vendors, express orders, cash float or custody. Those are
 * B5's rules and they belong with `evaluatePureRules()` in batching/eligibility,
 * which already exists and must not be forked.
 */

/** The live-leg column for a pool. Driver legs are rides, rider legs are orders. */
export function currentLegColumn(pool: DispatchPool): 'currentRideId' | 'currentOrderId' {
  return pool === 'DRIVER' ? 'currentRideId' : 'currentOrderId';
}

/**
 * How many live legs a mover of this pool may hold.
 *
 * Returns 1 for every pool. It takes the pool as an argument anyway, because
 * the taxi answer and the delivery answer are not the same question and the
 * concurrency spec settles them differently — a taxi carries one passenger at a
 * time by law of physics and policy, while a rider carrying two bags from one
 * kitchen is the launch requirement. A capacity function that could not tell
 * them apart would have to be replaced rather than extended.
 */
export function moverCapacity(_pool: DispatchPool): number {
  return 1;
}

/** The two candidate queries alias drivers `d` and riders `r`. Both fragments
 *  are written out in full rather than composed from an alias and a column,
 *  because building an identifier at runtime means `Prisma.raw`, and
 *  `sql-safety-surface.test.ts` forbids it in production source with no
 *  allowlist. That gate is right: a raw fragment is an injection vector even
 *  when today's inputs happen to be a closed set, and "it is safe because of
 *  how it is called" is a property that call sites can quietly change. Two
 *  constants cost nothing.
 *
 *  (Written the way it is because CI rejected the first version. Recorded here
 *  so the next person does not reintroduce the composed form as a tidy-up.) */
const FREE_DRIVER = Prisma.sql`AND d."currentRideId" IS NULL`;
const FREE_RIDER = Prisma.sql`AND r."currentOrderId" IS NULL`;

/**
 * The candidate-query fragment for "this mover has room".
 *
 * At capacity 1 this is exactly the predicate the two queries carried before
 * the seam, so the candidate set, its ordering, and therefore every dispatch
 * decision replayed through it are unchanged.
 *
 * Above 1 it must become a count of live legs rather than a null check, which
 * is why this is a function and not a constant the call sites inline.
 */
export function capacityPredicateSql(pool: DispatchPool): Prisma.Sql {
  const capacity = moverCapacity(pool);
  if (capacity <= 1) return pool === 'DRIVER' ? FREE_DRIVER : FREE_RIDER;
  // Reserved for B5. Explicit rather than falling through to the null check,
  // which would make a raised capacity look applied while behaving exactly as
  // before — the failure mode this whole module exists to prevent.
  throw new Error(
    `concurrency-policy: capacity ${capacity} for ${pool} has no candidate-query implementation yet. `
    + 'Raising moverCapacity() requires the stacking rules (B5) and a live-leg count here, not a null check.',
  );
}

/**
 * The same question as a Prisma `where` fragment, for `canReceiveOffer()`.
 *
 * At capacity 1 this is `{ currentRideId: null }` — byte-identical to the
 * clause that gate carries today.
 */
export function capacityWhere(pool: DispatchPool): Record<string, null> {
  const capacity = moverCapacity(pool);
  if (capacity <= 1) return { [currentLegColumn(pool)]: null };
  throw new Error(
    `concurrency-policy: capacity ${capacity} for ${pool} has no offer-gate implementation yet. `
    + 'See capacityPredicateSql — the offer gate must move in the same change or stacked offers fail closed and silently.',
  );
}
