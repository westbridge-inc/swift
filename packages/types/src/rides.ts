/** Module A: Rides — Type definitions */

export type CarType = 'SWIFT_X' | 'SWIFT_COMFORT' | 'SWIFT_XL' | 'SWIFT_PREMIUM';

export type RideStatus =
  | 'REQUESTING'
  | 'MATCHING'
  | 'DRIVER_ASSIGNED'
  | 'DRIVER_EN_ROUTE'
  | 'DRIVER_ARRIVED'
  | 'VERIFYING_PIN'
  | 'RIDE_IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface RideRequest {
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  dropoffLat: number;
  dropoffLng: number;
  dropoffAddress: string;
  carType: CarType;
  paymentMethod: 'CASH' | 'WALLET' | 'CARD';
  scheduledAt?: string;
}

export interface FareEstimate {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeFare: number;
  totalFare: number;
  surgeMultiplier: number;
  carTypeMultiplier: number;
  distanceKm: number;
  durationMin: number;
  currency: 'GYD';
}

export interface CarTypeConfig {
  type: CarType;
  name: string;
  description: string;
  baseFare: number;
  perKm: number;
  perMin: number;
  minFare: number;
  multiplier: number;
  maxPassengers: number;
  icon: string;
}

export interface RideMatch {
  driverId: string;
  driverName: string;
  driverPhone: string;
  driverRating: number;
  vehicleModel: string;
  vehiclePlate: string;
  vehicleColor: string;
  etaMinutes: number;
  pin: string;
}

export interface SurgeInfo {
  zoneId: string;
  multiplier: number;
  isActive: boolean;
  updatedAt: string;
}
