/**
 * [ALG-18] THE billable distance — one reader, one rounding.
 *
 * Every order that was priced from a distance carries that distance and the
 * engine that produced it, frozen at quote time: `billableKm` /
 * `billableKmSource` (delivery, mobile appointment, courier, taxi). Quote-
 * time distance is the QUOTE; this is the SETTLEMENT number — the fee path
 * priced it, the receipt states it, the earnings sentence reads it. A detour
 * the rider chose never changes it, because it was decided before they left.
 *
 * Read the distance through here. Never the column: legacy taxi rows carry
 * only `taxiDistance`, orders placed before the column existed carry
 * nothing, and both must resolve the same way everywhere.
 *
 * Rounding is declared ONCE, here, at two precisions with two jobs:
 *   canonicalBillableKm — 0.01 km, half up. THE number: what is priced AND
 *                         what is frozen. Pricing from a finer number than the
 *                         one stored is exactly the two-numbers hazard this
 *                         exists to end (the replay caught a $1 drift at
 *                         2.147 km before this line existed).
 *   roundBillableKm     — 0.1 km, half up. What a person reads on the receipt.
 */

export function canonicalBillableKm(km: number): number {
  return Math.round(km * 100) / 100;
}

export type BillableSource = 'osrm' | 'haversine' | 'legacy';

export interface BillableDistance {
  /** Kilometres, as priced (unrounded). */
  km: number;
  source: BillableSource;
  /** "2.1 km" — the one rounding, stated on the receipt. */
  label: string;
  /** "routed" | "estimated" | "recorded" — how to say the source to a person. */
  sourceLabel: string;
}

export function roundBillableKm(km: number): number {
  return Math.round(km * 10) / 10;
}

const SOURCE_LABEL: Record<BillableSource, string> = {
  osrm: 'routed',
  haversine: 'estimated',
  legacy: 'recorded',
};

function toSource(raw: unknown): BillableSource {
  return raw === 'osrm' || raw === 'haversine' ? raw : 'legacy';
}

export function billableDistance(order: {
  orderType?: string | null;
  billableKm?: unknown;
  billableKmSource?: string | null;
  taxiDistance?: unknown;
}): BillableDistance | null {
  const frozen = order.billableKm == null ? NaN : Number(order.billableKm);
  let km: number | null = Number.isFinite(frozen) && frozen > 0 ? frozen : null;
  let source: BillableSource = toSource(order.billableKmSource);
  if (km == null && order.orderType === 'TAXI' && order.taxiDistance != null) {
    // A taxi booked before the column existed: its distance was frozen as
    // taxiDistance from the same route estimate.
    const legacy = Number(order.taxiDistance);
    if (Number.isFinite(legacy) && legacy > 0) { km = legacy; source = 'legacy'; }
  }
  if (km == null) return null;
  return { km, source, label: `${roundBillableKm(km).toFixed(1)} km`, sourceLabel: SOURCE_LABEL[source] };
}
