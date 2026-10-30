import { Prisma, type PrismaClient } from '@prisma/client';
import { algoValue } from '../algo/algo-config';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
import { mmgDispatchEligibleWhere } from '../order/mmg-claim.service';
import { dispatchHoldExpiredFilter, dispatchTrigger, riderDispatchReadinessFilter } from './dispatch-trigger';
import { haversineM } from '../batching/eligibility';
import { riderStackingCapacity } from './concurrency-policy';
import { sizeClassForProbe, stackableForProbe } from './stack-eligibility';
import { goodsVehicleTypesForPackageSize } from '../../config/vehicle-classes';
import type { DispatchCandidate } from './scoring';

// ---------------------------------------------------------------------------
// [RIDER-SAFE · COORD rulings 29 Oct 2026] THE HONEST DELIVERY CAPACITY.
//
// The checkout gate used to refuse delivery only when ZERO riders with room
// stood within 5 km. Twenty riders could each hold a bag while forty orders
// waited for them, and checkout still said yes to the forty-first, with the
// same promise as at quiet midnight. This module answers the real question —
// can a rider take THIS order soon? — from three measured numbers:
//
//   free       riders near the store with room and no live leg — the EXACT
//              candidate query dispatch offers with (findCandidates);
//   stackable  riders near with a live leg and room, whose run THIS store's
//              order could join under the stacking rulebook (R1-R6);
//   backlog    delivery orders already waiting for a rider near the store
//              (the same predicate the stuck-dispatch reconciler re-drives).
//
// slots = free + stackable - backlog.
//   GOOD  a slot is free for this order now.
//   BUSY  every rider near is spoken for, but riders are working: the order is
//         taken, and the customer is told BEFORE ordering how much longer it
//         will be (the rider wait), and the promise includes it.
//   NONE  no rider near at all, or the wait would pass `maxRiderWaitMinutes`:
//         the existing refusal, "order for pickup instead".
//
// The rider wait when BUSY: this order is (backlog - free - stackable + 1)th
// in line, and the riders near (busy ones included) free up across one leg,
// so the wait is position × leg ÷ (riders + 1), whole minutes, rounded up.
//
// Customers get the level and the extra minutes, never counts or positions
// (availability spec §1). Counts stay server-side for the ops page.
// ---------------------------------------------------------------------------

export type DeliveryLevel = 'GOOD' | 'BUSY' | 'NONE';
export type DeliveryNoneReason = 'NO_RIDERS' | 'RIDERS_BUSY';

/** The candidate search radius dispatch starts with (dispatch.service BASE_RADIUS_KM). */
export const CAPACITY_RADIUS_KM = 5;

export interface DeliveryCapacity {
  level: DeliveryLevel;
  /** Why NONE; null otherwise. */
  reason: DeliveryNoneReason | null;
  /** The honest extra wait for a rider, in whole minutes: 0 unless BUSY (or NONE for RIDERS_BUSY). */
  riderWaitMinutes: number;
  nearestEtaMinutes: number | null;
  /** Server-side only: never sent to a customer. */
  counts: { free: number; stackable: number; ridersNear: number; backlog: number };
}

export interface CapacityProbe {
  tenantId: string | null;
  store: { id: string; lat: number; lng: number };
  /** FOOD_DELIVERY or GROCERY_DELIVERY: the stacking vertical. */
  orderType: string;
  /** The customer's drop-off. Unknown = no rider counts as a stack (conservative). */
  dropoff: { lat: number; lng: number } | null;
  /** Cash the rider fronts to the store (dispatch's float gate); 0 for MMG. */
  floatRequired: number;
  /** Cash the rider collects at the door (stacking R4); 0 for MMG. */
  cashToCollect: number;
  /** The vehicle size this basket needs (utils/load requiredPackageSizeForOrder). */
  packageSize: string | null;
}

export interface CapacityDeps {
  prisma: PrismaClient;
  /** The dispatch candidate query at the base radius, for an availability probe (no declined set). */
  candidates: (point: { lat: number; lng: number }, floatRequired: number, tenantId: string | null, packageSize: string | null) => Promise<DispatchCandidate[]>;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
};

export async function avgRiderLegMinutes(prisma: PrismaClient, tenantId: string): Promise<number> {
  return clampInt(await algoValue(prisma, 'delivery.avgRiderLegMinutes', tenantId), 5, 120, 25);
}
export async function maxRiderWaitMinutes(prisma: PrismaClient, tenantId: string): Promise<number> {
  return clampInt(await algoValue(prisma, 'delivery.maxRiderWaitMinutes', tenantId), 5, 120, 30);
}
export async function vendorBacklogCap(prisma: PrismaClient, tenantId: string): Promise<number> {
  return clampInt(await algoValue(prisma, 'delivery.vendorBacklogCap', tenantId), 0, 50, 3);
}
export async function waitingGraceMinutes(prisma: PrismaClient, tenantId: string): Promise<number> {
  return clampInt(await algoValue(prisma, 'delivery.waitingGraceMinutes', tenantId), 1, 30, 3);
}

/**
 * Orders waiting for a rider: platform delivery, riderless, dispatchable now.
 * The SAME predicate as the food/grocery/courier branch of
 * stuckDispatchEligibleWhere (dispatch.service) — delivery-capacity.test.ts
 * pins the two equal, so the backlog checkout subtracts is exactly the work
 * the reconciler would re-drive.
 */
export function waitingForRiderWhere(now = new Date()): Prisma.OrderWhereInput {
  return {
    orderType: { not: 'TAXI' },
    fulfillment: 'DELIVERY',
    riderId: null,
    foodAgeHeldAt: null,
    status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
    AND: [
      dispatchHoldExpiredFilter(now),
      notSelfDeliveredFilter(),
      riderDispatchReadinessFilter(),
      mmgDispatchEligibleWhere(),
    ],
  };
}

/** The moment an order started waiting for a rider: accepted (ON_ACCEPT) or ready (ON_READY). */
export function waitingSinceWhere(cutoff: Date): Prisma.OrderWhereInput {
  return dispatchTrigger() === 'ON_READY' ? { readyAt: { lte: cutoff } } : { acceptedAt: { lte: cutoff } };
}

/** A lat/lng box around a point, wide enough for `km` (then the exact distance decides). */
export function boxAround(p: { lat: number; lng: number }, km: number) {
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180)));
  return { lat: { gte: p.lat - dLat, lte: p.lat + dLat }, lng: { gte: p.lng - dLng, lte: p.lng + dLng } };
}

/** Delivery orders waiting for a rider whose pickup is within `km` of a point (one tenant). */
export async function backlogNear(
  prisma: PrismaClient,
  point: { lat: number; lng: number },
  tenantId: string | null,
  km = CAPACITY_RADIUS_KM,
  now = new Date(),
): Promise<Array<{ id: string; acceptedAt: Date | null; placedAt: Date }>> {
  const box = boxAround(point, km);
  const rows = await prisma.order.findMany({
    where: {
      ...waitingForRiderWhere(now),
      ...(tenantId ? { tenantId } : {}),
      pickupLat: box.lat,
      pickupLng: box.lng,
    },
    select: { id: true, pickupLat: true, pickupLng: true, acceptedAt: true, placedAt: true },
    orderBy: [{ acceptedAt: 'asc' }, { placedAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  return rows
    .filter((r) => r.pickupLat != null && r.pickupLng != null
      && haversineM(point, { lat: r.pickupLat, lng: r.pickupLng }) <= km * 1000)
    .map(({ id, acceptedAt, placedAt }) => ({ id, acceptedAt, placedAt }));
}

/**
 * Every delivery rider online near a point, busy or not: the riders whose
 * hands will free up. The candidate query's own filters (fresh location,
 * active account, rider role, this tenant, a vehicle that carries this size,
 * a delivery rider type) without the room or float gates.
 */
export async function ridersOnlineNear(
  prisma: PrismaClient,
  point: { lat: number; lng: number },
  tenantId: string | null,
  packageSize: string | null,
  freshSeconds: number,
  km = CAPACITY_RADIUS_KM,
): Promise<number> {
  const freshSince = new Date(Date.now() - freshSeconds * 1000);
  const tenantFilter = tenantId ? Prisma.sql`AND u."tenantId" = ${tenantId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM "riders" r
    JOIN "users" u ON u."id" = r."userId"
    WHERE r."isOnline" = true
      AND r."locationSessionId" IS NOT NULL
      AND r."lastLocationUpdate" >= ${freshSince}
      AND u."status" = 'ACTIVE'
      AND u."activeRole" IN ('MOVER', 'RIDER')
      ${tenantFilter}
      AND r."vehicleType"::text = ANY(${goodsVehicleTypesForPackageSize(packageSize)})
      AND r."riderType"::text = ANY(ARRAY['DELIVERY','BOTH'])
      AND r."currentLat" IS NOT NULL
      AND r."currentLng" IS NOT NULL
      AND ST_DWithin(
        geography(ST_MakePoint(r."currentLng", r."currentLat")),
        geography(ST_MakePoint(${point.lng}, ${point.lat})),
        ${km * 1000}
      )`;
  return Number(rows[0]?.n ?? 0);
}

/** The pure decision, from the measured numbers (exported for the unit test). */
export function decideCapacity(input: {
  free: number; stackable: number; ridersNear: number; backlog: number;
  legMinutes: number; maxWaitMinutes: number;
}): { level: DeliveryLevel; reason: DeliveryNoneReason | null; riderWaitMinutes: number } {
  const { free, stackable, backlog, legMinutes, maxWaitMinutes } = input;
  const ridersNear = Math.max(input.ridersNear, free + stackable);
  if (ridersNear <= 0) return { level: 'NONE', reason: 'NO_RIDERS', riderWaitMinutes: 0 };
  const slots = free + stackable - backlog;
  if (slots >= 1) return { level: 'GOOD', reason: null, riderWaitMinutes: 0 };
  const position = backlog - (free + stackable) + 1;
  const wait = Math.max(1, Math.ceil((position * legMinutes) / (ridersNear + 1)));
  if (wait > maxWaitMinutes) return { level: 'NONE', reason: 'RIDERS_BUSY', riderWaitMinutes: wait };
  return { level: 'BUSY', reason: null, riderWaitMinutes: wait };
}

/** Measure the delivery capacity for a new order from one store. Never throws a probe failure into checkout: callers catch. */
export async function measureDeliveryCapacity(deps: CapacityDeps, probe: CapacityProbe, freshSeconds: number): Promise<DeliveryCapacity> {
  const tenant = probe.tenantId ?? 'swift-default';
  const point = { lat: probe.store.lat, lng: probe.store.lng };
  const [candidates, backlog, ridersNear, legMinutes, maxWait, capacity] = await Promise.all([
    deps.candidates(point, probe.floatRequired, probe.tenantId, probe.packageSize),
    backlogNear(deps.prisma, point, probe.tenantId),
    ridersOnlineNear(deps.prisma, point, probe.tenantId, probe.packageSize, freshSeconds),
    avgRiderLegMinutes(deps.prisma, tenant),
    maxRiderWaitMinutes(deps.prisma, tenant),
    riderStackingCapacity(deps.prisma),
  ]);
  const free = candidates.filter((c) => !c.hasActiveJob).length;
  const working = candidates.filter((c) => c.hasActiveJob).map((c) => c.riderId);
  const vertical = probe.orderType === 'GROCERY_DELIVERY' ? 'GROCERY' : 'FOOD';
  const stackable = probe.dropoff && working.length > 0
    ? (await stackableForProbe(deps.prisma, working, {
        vertical,
        sizeClass: sizeClassForProbe(probe.packageSize),
        cashToCollect: probe.cashToCollect,
        pickup: { lat: point.lat, lng: point.lng, vendorId: probe.store.id },
        dropoff: probe.dropoff,
      }, capacity)).size
    : 0;
  const decision = decideCapacity({ free, stackable, ridersNear, backlog: backlog.length, legMinutes, maxWaitMinutes: maxWait });
  return {
    ...decision,
    nearestEtaMinutes: candidates[0] ? Math.max(1, Math.round(candidates[0].etaMinutes)) : null,
    counts: { free, stackable, ridersNear: Math.max(ridersNear, free + stackable), backlog: backlog.length },
  };
}

/**
 * [RIDER-SAFE 4] A store's own waiting-for-rider backlog: its delivery orders
 * that have waited longer than the grace for a rider. At `vendorBacklogCap`
 * new delivery orders for the store pause by themselves (pickup stays open)
 * and resume when a rider takes one. New orders never count until a store
 * accepts them and the grace passes, so two checkouts racing cannot push the
 * backlog over the cap: there is no race to lose.
 */
export async function storeRiderBacklog(prisma: PrismaClient, vendorId: string, tenantId: string, now = new Date()): Promise<{ waiting: number; cap: number; paused: boolean }> {
  const [cap, grace] = await Promise.all([vendorBacklogCap(prisma, tenantId), waitingGraceMinutes(prisma, tenantId)]);
  const base = waitingForRiderWhere(now);
  const waiting = await prisma.order.count({
    where: {
      ...base,
      vendorId,
      AND: [...(base.AND as Prisma.OrderWhereInput[]), waitingSinceWhere(new Date(now.getTime() - grace * 60_000))],
    },
  });
  return { waiting, cap, paused: cap > 0 && waiting >= cap };
}

/** [RIDER-SAFE 4] What the store is told when its own orders waiting for riders pause new delivery orders. */
export function storeBacklogSentence(waiting: number): string {
  return `${waiting} of your orders ${waiting === 1 ? 'is' : 'are'} waiting for a rider, so new delivery orders are paused. They restart by themselves when a rider takes one. Customers can still order for pickup.`;
}

/** The honest words, once, for every surface (checkout refusal, cart banner). */
export function capacitySentence(c: { level: DeliveryLevel; reason: DeliveryNoneReason | null; riderWaitMinutes: number }): string | null {
  if (c.level === 'BUSY') return `Riders are busy — about ${c.riderWaitMinutes} min extra for delivery.`;
  if (c.level === 'NONE' && c.reason === 'RIDERS_BUSY') return 'Riders are very busy right now — you can order for Pickup instead, or try delivery again later.';
  if (c.level === 'NONE') return 'No delivery riders are online right now — you can order for Pickup instead, or try delivery again later.';
  return null;
}
