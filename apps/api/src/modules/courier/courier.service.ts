/**
 * Courier Service — Parcel delivery pricing and lifecycle
 */

export type PackageSize = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
export type DeliverySpeed = 'STANDARD' | 'EXPRESS' | 'RUSH';

const SIZE_SURCHARGE: Record<PackageSize, number> = {
  SMALL: 0,
  MEDIUM: 500,
  LARGE: 1000,
  EXTRA_LARGE: 2000,
};

const SPEED_MULTIPLIER: Record<DeliverySpeed, number> = {
  STANDARD: 1.0,
  EXPRESS: 1.5,
  RUSH: 2.0,
};

const BASE_FEE = 1000; // GYD
const PER_KM_RATE = 300; // GYD

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
  speed: DeliverySpeed
): CourierEstimate {
  const baseFee = BASE_FEE;
  const distanceFee = distanceKm * PER_KM_RATE;
  const sizeSurcharge = SIZE_SURCHARGE[packageSize];
  const speedMultiplier = SPEED_MULTIPLIER[speed];
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
