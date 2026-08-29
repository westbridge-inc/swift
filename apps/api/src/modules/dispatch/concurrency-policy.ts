import { Prisma } from '@prisma/client';
// Type-only import: erased at compile time, so this does NOT create a runtime
// cycle with dispatch.service even though that module imports this one. The
// alternative — redeclaring the two-value union here — would be a second
// definition of something that already has one.
import type { DispatchPool } from './dispatch.service';
import type { PrismaClient } from '@prisma/client';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { algoValue } from '../algo/algo-config';

type Tx = Prisma.TransactionClient | PrismaClient;

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
export function moverCapacity(pool: DispatchPool): number {
  // DRIVER is a literal on purpose and must stay one: a taxi carries one
  // passenger's custody at a time — law, not configuration. Nothing that
  // resolves config may ever feed this branch.
  if (pool === 'DRIVER') return 1;
  // RIDER's synchronous answer stays 1 (the code default). The LIVE answer is
  // riderStackingCapacity() below — async because it reads AlgoConfig — and
  // every gate that can await it must.
  return 1;
}

/**
 * The live RIDER capacity: AlgoConfig `stacking.riderCapacity`, clamped 1..3.
 *
 * 1 is the kill switch — set a higher-version row with value 1 and every gate
 * returns to the historical null-pointer behaviour with no deploy. The read is
 * cached ~30s by the algo store and NEVER throws into dispatch: a failed read
 * resolves to the code default (1), which only ever makes the system MORE
 * conservative — degraded data must never widen capacity.
 */
export async function riderStackingCapacity(prisma: PrismaClient): Promise<number> {
  const raw = Number(await algoValue(prisma, 'stacking.riderCapacity'));
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(3, Math.trunc(raw)));
}

/** Comma-joined terminal statuses for raw SQL. ONE source: order-status.ts. */
const TERMINAL_SQL = Prisma.join(TERMINAL_ORDER_STATUSES.map((t) => Prisma.sql`${t}::text`));

/**
 * A rider's live delivery legs, counted from the ORDERS table — the one truth
 * that cannot drift from reality the way a cached pointer can. `currentOrderId`
 * remains the PRIMARY-leg pointer for the single-job readers the census
 * classified; capacity questions must never read it again.
 */
export async function riderLiveLegCount(tx: Tx, riderId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "orders" o
    WHERE o."riderId" = ${riderId} AND o."status"::text NOT IN (${TERMINAL_SQL})`;
  return Number(rows[0]?.count ?? 0);
}

/**
 * The RIDER claim reservation, capacity-aware and ATOMIC — the same guarded-
 * update idiom as FloatService.commit, and for the same reason: a JS
 * read-then-check lets two concurrent claims both pass. Both claim doors (the
 * dispatch offer-accept and the board grab) MUST come through here; a second
 * inline reservation is exactly the fork this module exists to prevent.
 *
 * The order row must already carry riderId = this rider (the claim CAS runs
 * first in the same transaction), so the leg being claimed is IN the count:
 * the guard is `count <= capacity` and the new availability is
 * `count < capacity`. The pointer COALESCEs — a first leg sets it, a stacked
 * leg leaves the primary alone.
 *
 * Demands `isAvailable` as well as the count: availability now MEANS "room for
 * another leg" and is the flag the delivery watchdog clears to quarantine a
 * GPS-dark rider before rescuing their legs. A reserve that ignored it would
 * let a dark rider whose app is still awake board-grab straight through that
 * quarantine. At capacity 1, settle-from-count keeps the two in agreement, so
 * behaviour is unchanged.
 *
 * Returns false when the rider was not eligible (offline, unavailable, no
 * location authority, wrong role, or at capacity) — the caller rolls the claim
 * back.
 */
export async function reserveRiderLeg(
  tx: Tx,
  riderId: string,
  orderId: string,
  capacity: number,
): Promise<boolean> {
  const rows = await tx.$executeRaw`
    UPDATE "riders" r SET
      "currentOrderId" = COALESCE(r."currentOrderId", ${orderId}),
      "isAvailable" = (
        (SELECT COUNT(*) FROM "orders" o
          WHERE o."riderId" = r."id" AND o."status"::text NOT IN (${TERMINAL_SQL})
        ) < ${capacity}
      )
    FROM "users" u
    WHERE r."id" = ${riderId}
      AND u."id" = r."userId"
      AND u."status" = 'ACTIVE'
      AND u."activeRole"::text IN ('MOVER', 'RIDER')
      AND r."isOnline" = true
      AND r."isAvailable" = true
      AND (SELECT COUNT(*) FROM "orders" o
            WHERE o."riderId" = r."id" AND o."status"::text NOT IN (${TERMINAL_SQL})
          ) <= ${capacity}`;
  return rows === 1;
}

/**
 * Settle a rider's PRIMARY pointer and availability from the legs they still
 * hold — the ONE rule, used by every path that ends a leg.
 *
 * Extracted from stageRiderRelease so the delivery watchdog (which ends legs
 * by rescuing them) does not carry a second copy of "re-point to the next live
 * leg, else null; available iff legs < capacity". Two copies of that rule is
 * how a dark rider and a finishing rider come to leave the pointer in
 * different shapes.
 *
 * `availability: 'offline'` pins isAvailable false regardless of room — a
 * rider who went GPS-dark is not free supply even with an empty hand.
 */
export async function settleRiderLegs(
  tx: Tx,
  prisma: PrismaClient,
  riderId: string,
  opts: { excludeOrderId?: string; availability?: 'from-count' | 'offline'; countDelivery?: boolean } = {},
): Promise<{ primaryLegId: string | null; legsLeft: number }> {
  const nextLeg = await tx.order.findFirst({
    where: {
      riderId,
      ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
      status: { notIn: TERMINAL_ORDER_STATUSES },
    },
    orderBy: { acceptedAt: 'asc' },
    select: { id: true },
  });
  const stackCap = await riderStackingCapacity(prisma);
  const legsLeft = await riderLiveLegCount(tx, riderId);
  await tx.rider.update({
    where: { id: riderId },
    data: {
      isAvailable: opts.availability === 'offline' ? false : legsLeft < stackCap,
      currentOrderId: nextLeg?.id ?? null,
      ...(opts.countDelivery ? { totalDeliveries: { increment: 1 } } : {}),
    },
  });
  return { primaryLegId: nextLeg?.id ?? null, legsLeft };
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
export function capacityPredicateSql(pool: DispatchPool, capacity = 1): Prisma.Sql {
  if (pool === 'DRIVER') return FREE_DRIVER; // capacity is never consulted — law
  if (capacity <= 1) return FREE_RIDER;
  // B5, fulfilled (2026-08-29): room = live legs below capacity, counted from
  // the orders table so the answer cannot drift from a stale pointer. At
  // capacity 1 the caller still gets the historical null check above, so the
  // seam's no-behaviour-change promise holds until the config says otherwise.
  return Prisma.sql`AND (
    SELECT COUNT(*) FROM "orders" o
    WHERE o."riderId" = r."id" AND o."status"::text NOT IN (${TERMINAL_SQL})
  ) < ${capacity}`;
}

/**
 * The same question as a Prisma `where` fragment, for `canReceiveOffer()`.
 *
 * At capacity 1 this is `{ currentRideId: null }` — byte-identical to the
 * clause that gate carries today.
 */
export function capacityWhere(pool: DispatchPool, capacity = moverCapacity(pool)): Record<string, null> {
  if (capacity <= 1) return { [currentLegColumn(pool)]: null };
  throw new Error(
    `concurrency-policy: capacity ${capacity} for ${pool} has no offer-gate implementation yet. `
    + 'See capacityPredicateSql — the offer gate must move in the same change or stacked offers fail closed and silently.',
  );
}
