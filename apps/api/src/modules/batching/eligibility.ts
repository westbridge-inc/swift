// Batched Delivery Runs — the eligibility gate's PURE core (System 1 Part 2).
// Every rule returns a measured value vs its limit; one failure = ineligible;
// the caller writes every evaluation into BatchEvaluation — the founder must
// see exactly why any order did or didn't batch. No I/O here: candidates
// arrive described, verdicts leave explained. Geometry uses straight-line
// (haversine) distance in shadow mode — the CONSERVATIVE approximation
// (degraded data may only make the system more conservative, never more
// aggressive); routed detours arrive with the live-offer phase.

export interface RuleResult {
  rule: string;
  pass: boolean;
  value: number | string;
  limit: number | string;
  note?: string;
}

export interface BatchingConfig {
  maxOrdersPerRun: number;
  dropoffCorridorM: number;
  pickupProximityM: number; // stacked shape: pickups ≤400m apart (Part 2 R5)
  verticalMatrix: Record<string, boolean>; // "FOOD|GROCERY" → true
  sizePoints: Record<string, number>;
  capacityPointsByVehicle: Record<string, number>;
}

export const DEFAULT_BATCHING_CONFIG: BatchingConfig = {
  maxOrdersPerRun: 2,
  dropoffCorridorM: 1500,
  pickupProximityM: 400,
  verticalMatrix: {
    'FOOD|FOOD': true,
    'FOOD|GROCERY': true,
    'GROCERY|GROCERY': true,
    'COURIER|COURIER': true,
    // FOOD|COURIER absent = false; PHARMACY per tenant flag when it exists.
  },
  sizePoints: { S: 1, M: 2, L: 3, XL: 4 },
  capacityPointsByVehicle: { BICYCLE: 3, MOTORBIKE: 4, CAR: 6 },
};

export interface CandidateOrder {
  orderId: string;
  vertical: 'FOOD' | 'GROCERY' | 'COURIER';
  sizeClass: 'S' | 'M' | 'L' | 'XL';
  cashToCollect: number;
  pickup: { lat: number; lng: number; vendorId?: string | null };
  dropoff: { lat: number; lng: number };
}

export interface RunShape {
  orders: CandidateOrder[];
  vehicleType: string;
  riderCashFloatCap: number;
  riderBlocked: boolean; // R12: active incident/SOS or pending-offer grace
}

const EARTH_R = 6_371_000;
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.sqrt(h)));
}

const matrixKey = (a: string, b: string) => [a, b].sort().join('|');

/** The gate: evaluates the PURE rules for candidate B joining `run`.
 *  Returns every rule's measured row; eligible = all pass. Rules that need
 *  the routing/ETA service (R5-routed, R7, R8, R9) belong to the live-offer
 *  evaluator — SHADOW mode approximates R5/R6 conservatively by straight
 *  line and SKIPS SLA rules (a shadow row is evidence, not an offer). */
export function evaluatePureRules(b: CandidateOrder, run: RunShape, cfg: BatchingConfig = DEFAULT_BATCHING_CONFIG): { eligible: boolean; rules: RuleResult[] } {
  const rules: RuleResult[] = [];

  // R1 — vertical compatibility, config not code.
  const verticalOk = run.orders.every((o) => cfg.verticalMatrix[matrixKey(o.vertical, b.vertical)] === true);
  rules.push({
    rule: 'R1', pass: verticalOk,
    value: [...new Set([...run.orders.map((o) => o.vertical), b.vertical])].join('+'),
    limit: 'matrix',
  });

  // R2 — batch size (hard ceiling 3 regardless of config).
  const size = run.orders.length + 1;
  const maxOrders = Math.min(cfg.maxOrdersPerRun, 3);
  rules.push({ rule: 'R2', pass: size <= maxOrders, value: size, limit: maxOrders });

  // R3 — capacity points; XL never batches.
  const xl = b.sizeClass === 'XL' || run.orders.some((o) => o.sizeClass === 'XL');
  const points = [...run.orders, b].reduce((s, o) => s + (cfg.sizePoints[o.sizeClass] ?? 4), 0);
  const capacity = cfg.capacityPointsByVehicle[run.vehicleType] ?? 0;
  rules.push({
    rule: 'R3', pass: !xl && points <= capacity,
    value: xl ? 'XL' : points, limit: xl ? 'XL never batches' : capacity,
  });

  // R4 — summed cash within the rider's float cap.
  const cash = [...run.orders, b].reduce((s, o) => s + o.cashToCollect, 0);
  rules.push({ rule: 'R4', pass: cash <= run.riderCashFloatCap, value: cash, limit: run.riderCashFloatCap });

  // R5 (shadow form) — stacked pickup shape: same vendor or pickups close.
  const sameVendor = run.orders.every((o) => o.pickup.vendorId && b.pickup.vendorId && o.pickup.vendorId === b.pickup.vendorId);
  const pickupDist = run.orders.length === 0 ? 0 : Math.max(...run.orders.map((o) => haversineM(o.pickup, b.pickup)));
  const r5 = sameVendor || pickupDist <= cfg.pickupProximityM;
  rules.push({
    rule: 'R5', pass: r5, value: sameVendor ? 'same-vendor' : pickupDist, limit: cfg.pickupProximityM,
    note: 'shadow: straight-line (conservative); routed detour applies at live offers',
  });

  // R6 (shadow form) — dropoff corridor by straight line.
  const dropDist = run.orders.length === 0 ? 0 : Math.min(...run.orders.map((o) => haversineM(o.dropoff, b.dropoff)));
  rules.push({
    rule: 'R6', pass: dropDist <= cfg.dropoffCorridorM, value: dropDist, limit: cfg.dropoffCorridorM,
    note: 'shadow: nearest-dropoff straight-line (conservative)',
  });

  // R12 — rider state.
  rules.push({ rule: 'R12', pass: !run.riderBlocked, value: run.riderBlocked ? 'blocked' : 'clear', limit: 'clear' });

  return { eligible: rules.every((r) => r.pass), rules };
}
