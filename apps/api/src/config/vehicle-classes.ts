/**
 * Swift's vehicle taxonomy — the single source of truth for every physical
 * vehicle a mover can register, and how each maps onto the rules that already
 * exist: courier capacity (dispatch), the taxi ride tier (RideClass), the
 * verification document profile, and which services it can perform.
 *
 * The PHYSICAL facts (what a vehicle is, what it can carry, how many it seats)
 * live here and are universal. The MONEY (per-km rates, class multipliers) stays
 * per-country in CountryConfig — this file never prices anything.
 *
 * Expanding the fleet (SWIFT — vehicle-class taxonomy) is additive: new
 * VehicleType enum values land here with their capacity/docs, and dispatch +
 * verification derive their behaviour from this map rather than hard-coding it.
 */
import type { VehicleType, PackageSize, RideClass } from '@prisma/client';

export type MoverService = 'RIDE' | 'COURIER' | 'DELIVERY';

export interface VehicleClass {
  type: VehicleType;
  /** Display label — matches the mover's vehicle picker. */
  label: string;
  /** Largest courier parcel this vehicle can carry (drives dispatch capacity). */
  maxPackageSize: PackageSize;
  /** Passenger seats. 0 = cargo/parcel only, never a passenger ride. */
  seats: number;
  /** Top taxi tier this vehicle serves, or null if it is not a ride vehicle.
   *  Forward-looking: taxi passenger dispatch rides on RideClass (Driver side);
   *  wiring buses into passenger rides is a later layer. */
  rideClass: RideClass | null;
  /** Services this vehicle is eligible to perform. */
  services: MoverService[];
  /** Extra document-checklist keys beyond the base MOVER list (keys into
   *  CountryConfig.documentChecklists — unseeded keys resolve to no extra docs). */
  docProfiles: string[];
  /** Display / capability order, small → large. */
  order: number;
}

/** PackageSize rank for capacity comparisons (bigger number = bigger parcel). */
const SIZE_RANK: Record<string, number> = { SMALL: 1, MEDIUM: 2, LARGE: 3, EXTRA_LARGE: 4 };

/**
 * The fleet. Order small → large. The original three (BICYCLE/MOTORCYCLE/CAR)
 * keep their exact historical capacity: bicycle up to MEDIUM, motorbike up to
 * LARGE, car up to EXTRA_LARGE — so dispatch behaviour is preserved.
 */
export const VEHICLE_CLASSES: Record<VehicleType, VehicleClass> = {
  BICYCLE: {
    type: 'BICYCLE', label: 'Bicycle', maxPackageSize: 'MEDIUM', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'], docProfiles: [], order: 1,
  },
  MOTORCYCLE: {
    type: 'MOTORCYCLE', label: 'Motorbike', maxPackageSize: 'LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'], docProfiles: ['MOVER_MOTOR'], order: 2,
  },
  CAR: {
    type: 'CAR', label: 'Car', maxPackageSize: 'EXTRA_LARGE', seats: 4,
    rideClass: 'ECONOMY', services: ['RIDE', 'COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA'], order: 3,
  },
  WAGON_CAR: {
    type: 'WAGON_CAR', label: 'Wagon Car', maxPackageSize: 'EXTRA_LARGE', seats: 5,
    rideClass: 'COMFORT', services: ['RIDE', 'COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA'], order: 4,
  },
  BUS_9: {
    type: 'BUS_9', label: 'Bus (9-seater)', maxPackageSize: 'EXTRA_LARGE', seats: 9,
    rideClass: 'XL', services: ['RIDE', 'COURIER'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA', 'MOVER_COMMERCIAL'], order: 5,
  },
  BUS_15: {
    type: 'BUS_15', label: 'Bus (15-seater)', maxPackageSize: 'EXTRA_LARGE', seats: 15,
    rideClass: 'XL', services: ['RIDE', 'COURIER'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA', 'MOVER_COMMERCIAL'], order: 6,
  },
  CANTER_SHORT: {
    type: 'CANTER_SHORT', label: 'Short-Base Canter (Open Back)', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 7,
  },
  CANTER_LONG: {
    type: 'CANTER_LONG', label: 'Long-Base Canter (Open Back)', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 8,
  },
  BOX_TRUCK_SHORT: {
    type: 'BOX_TRUCK_SHORT', label: 'Short-Base Box Truck', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 9,
  },
  BOX_TRUCK_LONG: {
    type: 'BOX_TRUCK_LONG', label: 'Long-Base Box Truck', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 10,
  },
};

/** All vehicle types, small → large. */
export const VEHICLE_TYPES_IN_ORDER: VehicleType[] = Object.values(VEHICLE_CLASSES)
  .sort((a, b) => a.order - b.order)
  .map((v) => v.type);

/**
 * Vehicle types that can carry a parcel of the given size — every vehicle whose
 * max capacity is at least the parcel's size. An unknown/absent size (non-courier
 * orders such as food or rides) is carriable by any vehicle.
 */
export function vehicleTypesForPackageSize(size: string | null | undefined): VehicleType[] {
  const need = (size && SIZE_RANK[size]) || 0;
  return VEHICLE_TYPES_IN_ORDER.filter((t) => (SIZE_RANK[VEHICLE_CLASSES[t].maxPackageSize] ?? 0) >= need);
}

/** The document-checklist keys a given vehicle adds on top of the base MOVER list. */
export function docProfilesFor(vehicleType: VehicleType): string[] {
  return VEHICLE_CLASSES[vehicleType]?.docProfiles ?? [];
}
