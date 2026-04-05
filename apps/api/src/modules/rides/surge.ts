/**
 * Surge Pricing Calculator
 *
 * Recalculated every 60 seconds per zone via BullMQ job.
 * Stored in Redis with 60-second TTL.
 *
 * Formula:
 *   ratio = ride_requests_last_5min / online_drivers_in_zone
 *
 *   ratio < 1.5  → 1.0x (no surge)
 *   ratio < 2.0  → 1.3x
 *   ratio < 3.0  → 1.6x
 *   ratio < 5.0  → 2.0x
 *   ratio >= 5.0 → 2.5x (cap)
 */

const SURGE_TIERS = [
  { maxRatio: 1.5, multiplier: 1.0 },
  { maxRatio: 2.0, multiplier: 1.3 },
  { maxRatio: 3.0, multiplier: 1.6 },
  { maxRatio: 5.0, multiplier: 2.0 },
  { maxRatio: Infinity, multiplier: 2.5 },
];

export function calculateSurgeMultiplier(
  rideRequestsLast5Min: number,
  onlineDriversInZone: number
): number {
  if (onlineDriversInZone === 0) return SURGE_TIERS[SURGE_TIERS.length - 1].multiplier;

  const ratio = rideRequestsLast5Min / onlineDriversInZone;

  for (const tier of SURGE_TIERS) {
    if (ratio < tier.maxRatio) return tier.multiplier;
  }

  return SURGE_TIERS[SURGE_TIERS.length - 1].multiplier;
}

/** Car type multipliers applied on top of surge */
export const CAR_TYPE_MULTIPLIERS = {
  SWIFT_X: 1.0,
  SWIFT_COMFORT: 1.4,
  SWIFT_XL: 1.6,
  SWIFT_PREMIUM: 2.0,
} as const;

export interface FareEstimate {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeFare: number;
  totalFare: number;
  surgeMultiplier: number;
  carTypeMultiplier: number;
  currency: 'GYD';
}

const BASE_FARE = 800; // GYD
const PER_KM = 250;
const PER_MIN = 40;
const MIN_FARE = 1200;

export function estimateFare(
  distanceKm: number,
  durationMin: number,
  carType: keyof typeof CAR_TYPE_MULTIPLIERS,
  surgeMultiplier: number
): FareEstimate {
  const carMultiplier = CAR_TYPE_MULTIPLIERS[carType];
  const baseFare = BASE_FARE * carMultiplier;
  const distanceFare = distanceKm * PER_KM * carMultiplier;
  const timeFare = durationMin * PER_MIN * carMultiplier;
  const subtotal = baseFare + distanceFare + timeFare;
  const surgeFare = subtotal * (surgeMultiplier - 1);
  const totalFare = Math.max(MIN_FARE * carMultiplier, Math.round(subtotal * surgeMultiplier));

  return {
    baseFare: Math.round(baseFare),
    distanceFare: Math.round(distanceFare),
    timeFare: Math.round(timeFare),
    surgeFare: Math.round(surgeFare),
    totalFare,
    surgeMultiplier,
    carTypeMultiplier: carMultiplier,
    currency: 'GYD',
  };
}
