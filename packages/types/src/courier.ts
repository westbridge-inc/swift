/** Module C: Courier — Type definitions */

export type PackageSize = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
export type DeliverySpeed = 'STANDARD' | 'EXPRESS' | 'RUSH';

export type CourierStatus =
  | 'PENDING'
  | 'RIDER_ASSIGNED'
  | 'RIDER_EN_ROUTE_PICKUP'
  | 'RIDER_ARRIVED_PICKUP'
  | 'PICKED_UP'
  | 'EN_ROUTE_DELIVERY'
  | 'ARRIVED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface CourierOrderRequest {
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  pickupContactName: string;
  pickupContactPhone: string;
  dropoffLat: number;
  dropoffLng: number;
  dropoffAddress: string;
  dropoffContactName: string;
  dropoffContactPhone: string;
  packageSize: PackageSize;
  weight?: number;
  description: string;
  speed: DeliverySpeed;
  photoUrl?: string;
  paymentMethod: 'CASH' | 'WALLET' | 'CARD';
}

export interface CourierEstimate {
  baseFee: number;
  distanceFee: number;
  sizeSurcharge: number;
  speedMultiplier: number;
  totalFee: number;
  estimatedMinutes: number;
  distanceKm: number;
  currency: 'GYD';
}

export interface PackageSizeConfig {
  size: PackageSize;
  label: string;
  description: string;
  surcharge: number;
  maxWeight: number;
  icon: string;
}

export interface DeliverySpeedConfig {
  speed: DeliverySpeed;
  label: string;
  description: string;
  multiplier: number;
  etaRange: string;
}
