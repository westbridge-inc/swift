/**
 * Pricing helpers. Customer prices carry NO markup — customers pay the vendor
 * base price; platform revenue is weekly subscriptions only. The fees below are
 * mover earnings, not platform revenue.
 *
 * The default rates repeat the API's (DEFAULT_DELIVERY_RATES,
 * DEFAULT_COURIER_RATES, DEFAULT_TAXI_RATES), the one place they live;
 * apps/api's fares-georgetown-defaults test pins them to it. The API prices
 * every real fare and fee; these helpers do not round the way it does.
 */

/**
 * Delivery fee = base_fee + max(0, distance - included_km) * per_km_rate.
 * Results are rounded up. Surge is applied as a multiplier.
 */
export function calculateDeliveryFee(options: {
  distanceKm: number;
  baseFee?: number;
  perKmRate?: number;
  includedKm?: number;
  surgeMultiplier?: number;
}): number {
  const { distanceKm, baseFee = 500, perKmRate = 100, includedKm = 3, surgeMultiplier = 1.0 } = options;
  const distanceFee = Math.max(0, distanceKm - includedKm) * perKmRate;
  return Math.ceil((baseFee + distanceFee) * surgeMultiplier);
}

/**
 * Courier fee = base + distance * rate + size surcharge, multiplied by speed.
 */
export function calculateCourierFee(options: {
  distanceKm: number;
  packageSize: 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
  speed?: 'standard' | 'express' | 'rush';
}): number {
  const { distanceKm, packageSize, speed = 'standard' } = options;
  const baseFee = 800;
  const perKmRate = 120;
  const sizeSurcharge = { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 }[packageSize];
  const speedMultiplier = { standard: 1.0, express: 1.5, rush: 2.0 }[speed];
  return Math.ceil((baseFee + distanceKm * perKmRate + sizeSurcharge) * speedMultiplier);
}

/**
 * Taxi fare = base + max(0, distance - includedKm) * perKm + duration * perMin.
 * Minimum fare enforced.
 */
export function calculateTaxiFare(options: {
  distanceKm: number;
  durationMin: number;
  baseFare?: number;
  includedKm?: number;
  perKmRate?: number;
  perMinRate?: number;
  minimumFare?: number;
  surgeMultiplier?: number;
  vehicleMultiplier?: number;
}): number {
  const {
    distanceKm,
    durationMin,
    baseFare = 800,
    includedKm = 3,
    perKmRate = 175,
    perMinRate = 0,
    minimumFare = 800,
    surgeMultiplier = 1.0,
    vehicleMultiplier = 1.0,
  } = options;
  const fare = baseFare + Math.max(0, distanceKm - includedKm) * perKmRate + durationMin * perMinRate;
  return Math.max(minimumFare, Math.ceil(fare * surgeMultiplier * vehicleMultiplier));
}
