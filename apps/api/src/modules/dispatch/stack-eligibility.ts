import type { Prisma, PrismaClient, VehicleType } from '@prisma/client';
import { evaluatePureRules, DEFAULT_BATCHING_CONFIG, type BatchingConfig, type CandidateOrder, type RunShape } from '../batching/eligibility';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { bandForBulk, totalBulkUnits, readOrderSize, DEFAULT_BULK_UNITS, DEFAULT_LOAD_BANDS } from '../../utils/load';
import { log } from '../../utils/logger';

type Tx = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------------
// Stacked-leg eligibility — the LIVE half of the batching rulebook.
//
// The pure rules (max per run, capacity points, summed cash vs float, pickup
// proximity, drop-off corridor, vertical matrix) shipped in
// batching/eligibility.ts and have been writing shadow evidence for weeks.
// This module ASSEMBLES a rider's live run and the candidate leg from real
// rows and asks that rulebook — it re-implements nothing (D-8: the rules have
// one home). Rider-dependent inputs the shadow honestly skipped (float cap,
// vehicle capacity points) are supplied here, because at accept time we know
// the rider.
//
// Fail-open is forbidden in both directions deliberately:
//   - a first leg (empty run) is ALWAYS eligible — this gate exists only
//     between legs, never in front of ordinary single-job dispatch;
//   - any assembly failure (missing coords, unknown vehicle) refuses the
//     STACK, not the rider — they keep their current job and stay dispatchable
//     for singles. Degraded data may only make stacking more conservative.
// ---------------------------------------------------------------------------

/** eligibility speaks S/M/L/XL; orders speak PackageSize. One translation. */
const SIZE_CLASS: Record<string, CandidateOrder['sizeClass']> = {
  SMALL: 'S',
  MEDIUM: 'M',
  LARGE: 'L',
  EXTRA_LARGE: 'XL',
};

/** eligibility's capacity table keys (BICYCLE/MOTORBIKE/CAR) predate the fleet
 *  taxonomy (MOTORCYCLE, buses, canters…). Translate; anything unmapped gets 0
 *  capacity points — the heavy fleet does not stack until someone prices its
 *  points on purpose, which is the conservative direction. */
const VEHICLE_KEY: Partial<Record<VehicleType, string>> = {
  BICYCLE: 'BICYCLE',
  MOTORCYCLE: 'MOTORBIKE',
  CAR: 'CAR',
  WAGON_CAR: 'CAR',
};

const VERTICAL: Record<string, CandidateOrder['vertical'] | undefined> = {
  FOOD_DELIVERY: 'FOOD',
  GROCERY_DELIVERY: 'GROCERY',
  COURIER: 'COURIER',
};

type OrderRow = {
  id: string;
  orderType: string;
  paymentMethod: string;
  totalAmount: Prisma.Decimal | number;
  courierPackageSize: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  deliveryLat: number;
  deliveryLng: number;
  vendorId: string | null;
  vendor: { latitude: Prisma.Decimal | number | null; longitude: Prisma.Decimal | number | null } | null;
  items: { quantity: number; bulkUnits: number | null }[];
};

const ORDER_SELECT = {
  id: true,
  orderType: true,
  paymentMethod: true,
  totalAmount: true,
  courierPackageSize: true,
  pickupLat: true,
  pickupLng: true,
  deliveryLat: true,
  deliveryLng: true,
  vendorId: true,
  vendor: { select: { latitude: true, longitude: true } },
  items: { select: { quantity: true, bulkUnits: true } },
} as const;

function toCandidate(o: OrderRow): CandidateOrder | null {
  const vertical = VERTICAL[o.orderType];
  if (!vertical) return null; // TAXI/unknown never stacks
  const pickupLat = o.pickupLat ?? (o.vendor?.latitude != null ? Number(o.vendor.latitude) : null);
  const pickupLng = o.pickupLng ?? (o.vendor?.longitude != null ? Number(o.vendor.longitude) : null);
  if (pickupLat == null || pickupLng == null) return null;
  // [owner #20 · DS1323 S3] The one size reading (utils/load), its TRUE band: [owner 31 Oct] the cap that lets a
  // big store order go to a motorbike decides who may carry it, never what it weighs, so an order past the
  // motorbike band is still XL here and never batches (R3), cars on or off. An order the rule cannot size
  // keeps the reading it always had.
  const lines = o.items.map((l) => ({ quantity: l.quantity, bulkUnits: l.bulkUnits ?? DEFAULT_BULK_UNITS }));
  const size = readOrderSize({ orderType: o.orderType, courierPackageSize: o.courierPackageSize, items: lines }, DEFAULT_LOAD_BANDS).trueBand
    ?? o.courierPackageSize
    ?? bandForBulk(totalBulkUnits(lines));
  return {
    orderId: o.id,
    vertical,
    sizeClass: SIZE_CLASS[size] ?? 'XL', // unknown size = worst case, conservative
    cashToCollect: o.paymentMethod === 'CASH' ? Number(o.totalAmount) : 0,
    pickup: { lat: pickupLat, lng: pickupLng, vendorId: o.vendorId },
    dropoff: { lat: o.deliveryLat, lng: o.deliveryLng },
  };
}

/**
 * [RIDER-SAFE 1] Which of these riders could take a NEW order from this store
 * as an extra leg — the checkout's honest-capacity read, asked BEFORE any
 * order exists. The same rulebook as `stackVerdict` (evaluatePureRules, the
 * one capacity knob as R2's limit); the candidate leg is described from the
 * store, the customer's drop-off and the basket instead of an order row.
 *
 * Conservative in the same directions: a rider with no live leg is not a
 * stack (the caller counts them as free), and a rider whose live run cannot
 * be described, or who cannot be read, is never counted. One read for all the
 * riders' legs, not one per rider.
 */
export async function stackableForProbe(
  tx: Tx,
  riderIds: readonly string[],
  probe: Omit<CandidateOrder, 'orderId'>,
  capacity: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (riderIds.length === 0 || capacity <= 1) return out;
  const [riders, legs] = await Promise.all([
    tx.rider.findMany({ where: { id: { in: [...riderIds] } }, select: { id: true, vehicleType: true, floatLimit: true } }),
    tx.order.findMany({
      where: { riderId: { in: [...riderIds] }, status: { notIn: TERMINAL_ORDER_STATUSES } },
      select: { ...ORDER_SELECT, riderId: true },
    }) as unknown as Promise<Array<OrderRow & { riderId: string }>>,
  ]);
  const candidate: CandidateOrder = { ...probe, orderId: 'probe' };
  const cfg: BatchingConfig = { ...DEFAULT_BATCHING_CONFIG, maxOrdersPerRun: capacity };
  for (const rider of riders) {
    const runRows = legs.filter((l) => l.riderId === rider.id);
    if (runRows.length === 0) continue; // free, not a stack
    const runOrders: CandidateOrder[] = [];
    let describable = true;
    for (const row of runRows) {
      const c = toCandidate(row);
      if (!c) { describable = false; break; }
      runOrders.push(c);
    }
    if (!describable) continue;
    const run: RunShape = {
      orders: runOrders,
      vehicleType: VEHICLE_KEY[rider.vehicleType] ?? '__UNPRICED__',
      riderCashFloatCap: Number(rider.floatLimit),
      riderBlocked: false,
    };
    if (evaluatePureRules(candidate, run, cfg).eligible) out.add(rider.id);
  }
  return out;
}

/** The size class the stacking rulebook speaks, for a goods order's required size (unknown = XL, conservative). */
export function sizeClassForProbe(size: string | null | undefined): CandidateOrder['sizeClass'] {
  return (size ? SIZE_CLASS[size] : undefined) ?? 'XL';
}

export type StackVerdict =
  | { eligible: true; legs: number }
  | { eligible: false; legs: number; rule: string; detail: string };

/**
 * May `orderId` become an ADDITIONAL live leg for this rider?
 *
 * Called inside the claim transaction, after the order CAS has bound the row
 * to the rider (so a refusal rolls the whole claim back) — and by the offer
 * cascade before installing a stacked offer, so an ineligible pairing is
 * skipped instead of dangled in front of a rider who cannot take it.
 *
 * `capacity` is the ONE founder knob, `riderStackingCapacity()`, exactly as
 * the caller read it for this decision (the same number it hands
 * reserveRiderLeg and the candidate gates). It is R2's limit. Required, so no
 * caller can ask the stacking question without saying how many legs are
 * allowed.
 */
export async function stackVerdict(tx: Tx, riderId: string, orderId: string, capacity: number): Promise<StackVerdict> {
  const rider = await tx.rider.findUnique({
    where: { id: riderId },
    select: { vehicleType: true, floatLimit: true },
  });
  if (!rider) return { eligible: false, legs: 0, rule: 'R0', detail: 'rider not found' };

  const rows = (await tx.order.findMany({
    where: { riderId, status: { notIn: TERMINAL_ORDER_STATUSES } },
    select: ORDER_SELECT,
  })) as unknown as OrderRow[];

  const candidateRow = rows.find((r) => r.id === orderId)
    ?? ((await tx.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT })) as unknown as OrderRow | null);
  const runRows = rows.filter((r) => r.id !== orderId);
  const legs = runRows.length;

  // First leg: this gate does not exist. Ordinary dispatch already decided.
  if (legs === 0) return { eligible: true, legs: 0 };

  if (!candidateRow) return { eligible: false, legs, rule: 'R0', detail: 'candidate order not found' };
  const candidate = toCandidate(candidateRow);
  if (!candidate) return { eligible: false, legs, rule: 'R0', detail: 'candidate not stackable (type/coords)' };

  const runOrders: CandidateOrder[] = [];
  for (const row of runRows) {
    const c = toCandidate(row);
    // A live leg we cannot describe = we cannot prove the pair is safe = no stack.
    if (!c) return { eligible: false, legs, rule: 'R0', detail: `live leg ${row.id} not describable` };
    runOrders.push(c);
  }

  const run: RunShape = {
    orders: runOrders,
    vehicleType: VEHICLE_KEY[rider.vehicleType] ?? '__UNPRICED__', // 0 capacity points
    riderCashFloatCap: Number(rider.floatLimit),
    riderBlocked: false, // R12's live inputs (SOS/incident) arrive with the safety wiring
  };

  // [STK-3] R2 counts against the ONE capacity knob. It used to read the
  // shadow engine's DEFAULT_BATCHING_CONFIG.maxOrdersPerRun (2), so after the
  // owner raised the knob to 3 (2026-09-24, #1358) every count gate said 3
  // and this gate refused the third leg "R2: 3 vs 2". Every other rule keeps
  // the rulebook's values, and R2 keeps its own hard ceiling of 3.
  const cfg: BatchingConfig = { ...DEFAULT_BATCHING_CONFIG, maxOrdersPerRun: capacity };
  const { eligible, rules } = evaluatePureRules(candidate, run, cfg);
  if (eligible) return { eligible: true, legs };
  const failed = rules.find((r) => !r.pass);
  const verdict: StackVerdict = {
    eligible: false,
    legs,
    rule: failed?.rule ?? '?',
    detail: failed ? `${failed.value} vs ${failed.limit}` : 'rule failed',
  };
  // The seam's old failure mode was silence. Never again: every refused stack
  // says which rule refused it, and against which capacity.
  log().info({ riderId, orderId, capacity, ...verdict }, 'stacking: stacked leg refused');
  return verdict;
}
