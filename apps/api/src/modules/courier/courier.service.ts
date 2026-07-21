/**
 * Courier Service — Parcel delivery pricing and lifecycle
 */

export type PackageSize = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
export type DeliverySpeed = 'STANDARD' | 'EXPRESS' | 'RUSH';

/** Courier pricing knobs [UG-CRAFT-03] — per-country via
 *  CountryConfig.courierRates (same null→code-default pattern as taxiRates;
 *  rides were already priced per-country, courier was the one vertical
 *  hardcoded to GYD literals). */
export interface CourierRates {
  baseFee: number;
  perKmRate: number;
  sizeSurcharge: Record<PackageSize, number>;
  speedMultiplier: Record<DeliverySpeed, number>;
}

export const DEFAULT_COURIER_RATES: CourierRates = {
  baseFee: 1000, // GYD
  perKmRate: 300, // GYD
  sizeSurcharge: { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 },
  speedMultiplier: { STANDARD: 1.0, EXPRESS: 1.5, RUSH: 2.0 },
};

/** Tolerant merge of a CountryConfig.courierRates JSON over the defaults —
 *  a partial or malformed config can only override what it validly sets. */
export function mergeCourierRates(raw: unknown): CourierRates {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<CourierRates>;
  return {
    baseFee: typeof cfg.baseFee === 'number' ? cfg.baseFee : DEFAULT_COURIER_RATES.baseFee,
    perKmRate: typeof cfg.perKmRate === 'number' ? cfg.perKmRate : DEFAULT_COURIER_RATES.perKmRate,
    sizeSurcharge: { ...DEFAULT_COURIER_RATES.sizeSurcharge, ...(cfg.sizeSurcharge ?? {}) },
    speedMultiplier: { ...DEFAULT_COURIER_RATES.speedMultiplier, ...(cfg.speedMultiplier ?? {}) },
  };
}

export interface CourierEstimate {
  baseFee: number;
  distanceFee: number;
  sizeSurcharge: number;
  speedMultiplier: number;
  totalFee: number;
  estimatedMinutes: number;
  currency: 'GYD';
}

export function estimateCourierFee(
  distanceKm: number,
  packageSize: PackageSize,
  speed: DeliverySpeed,
  rates: CourierRates = DEFAULT_COURIER_RATES,
): CourierEstimate {
  const baseFee = rates.baseFee;
  const distanceFee = distanceKm * rates.perKmRate;
  const sizeSurcharge = rates.sizeSurcharge[packageSize];
  const speedMultiplier = rates.speedMultiplier[speed];
  const totalFee = Math.round((baseFee + distanceFee + sizeSurcharge) * speedMultiplier);

  const estimatedMinutes =
    speed === 'RUSH' ? 20 : speed === 'EXPRESS' ? 30 : Math.max(45, distanceKm * 5);

  return {
    baseFee,
    distanceFee: Math.round(distanceFee),
    sizeSurcharge,
    speedMultiplier,
    totalFee,
    estimatedMinutes: Math.round(estimatedMinutes),
    currency: 'GYD',
  };
}
