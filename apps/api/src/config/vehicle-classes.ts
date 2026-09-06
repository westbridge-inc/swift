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

/**
 * Which weekly-fee band a mover bills on.
 *
 * STANDARD is the everyday fleet — bicycle, motorbike, car, wagon car — the
 * riders, delivery drivers and taxi drivers who make up most of the platform.
 * HEAVY is the commercial fleet — buses, canters and box trucks — which takes
 * larger, higher-value jobs and is priced accordingly.
 *
 * This is a CLASSIFICATION, not a price. The rate each band pays lives in
 * `CountryConfig.subscriptionTiers` (`mover` / `moverHeavy`) so it stays
 * config per market, exactly like every other number in this system.
 */
export type MoverFeeBand = 'STANDARD' | 'HEAVY';

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
  /** Weekly-fee band this vehicle bills on. Classification only — the rate for
   *  each band is CountryConfig.subscriptionTiers, never a constant in code. */
  feeBand: MoverFeeBand;
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
    rideClass: null, services: ['COURIER', 'DELIVERY'], docProfiles: [], order: 1, feeBand: 'STANDARD',
  },
  MOTORCYCLE: {
    type: 'MOTORCYCLE', label: 'Motorbike', maxPackageSize: 'LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'], docProfiles: ['MOVER_MOTOR'], order: 2, feeBand: 'STANDARD',
  },
  CAR: {
    type: 'CAR', label: 'Car', maxPackageSize: 'EXTRA_LARGE', seats: 4,
    rideClass: 'ECONOMY', services: ['RIDE', 'COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA'], order: 3, feeBand: 'STANDARD',
  },
  WAGON_CAR: {
    type: 'WAGON_CAR', label: 'Wagon Car', maxPackageSize: 'EXTRA_LARGE', seats: 5,
    rideClass: 'COMFORT', services: ['RIDE', 'COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA'], order: 4, feeBand: 'STANDARD',
  },
  BUS_9: {
    type: 'BUS_9', label: 'Bus (9-seater)', maxPackageSize: 'EXTRA_LARGE', seats: 9,
    rideClass: 'GROUP', services: ['RIDE', 'COURIER'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA', 'MOVER_COMMERCIAL'], order: 5, feeBand: 'HEAVY',
  },
  BUS_15: {
    type: 'BUS_15', label: 'Bus (15-seater)', maxPackageSize: 'EXTRA_LARGE', seats: 15,
    rideClass: 'GROUP', services: ['RIDE', 'COURIER'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA', 'MOVER_COMMERCIAL'], order: 6, feeBand: 'HEAVY',
  },
  CANTER_SHORT: {
    type: 'CANTER_SHORT', label: 'Short-Base Canter (Open Back)', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 7, feeBand: 'HEAVY',
  },
  CANTER_LONG: {
    type: 'CANTER_LONG', label: 'Long-Base Canter (Open Back)', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 8, feeBand: 'HEAVY',
  },
  BOX_TRUCK_SHORT: {
    type: 'BOX_TRUCK_SHORT', label: 'Short-Base Box Truck', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 9, feeBand: 'HEAVY',
  },
  BOX_TRUCK_LONG: {
    type: 'BOX_TRUCK_LONG', label: 'Long-Base Box Truck', maxPackageSize: 'EXTRA_LARGE', seats: 0,
    rideClass: null, services: ['COURIER', 'DELIVERY'],
    docProfiles: ['MOVER_MOTOR', 'MOVER_COMMERCIAL'], order: 10, feeBand: 'HEAVY',
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

/**
 * The weekly-fee band a vehicle bills on — the ONE place that answers "does this
 * mover pay the standard rate or the heavy-fleet rate".
 *
 * An unknown vehicle bills STANDARD: a new VehicleType enum value that lands
 * without a band must never silently charge a mover the higher rate. The
 * exhaustive `Record<VehicleType, VehicleClass>` above makes that unreachable
 * at compile time; this is the runtime floor behind it.
 */
export function feeBandFor(vehicleType: VehicleType): MoverFeeBand {
  return VEHICLE_CLASSES[vehicleType]?.feeBand ?? 'STANDARD';
}

/** A passenger-carrying vehicle (has a ride class): car, wagon, bus. These carry
 *  people, so they must clear the same hire-insurance + plate gate a taxi does —
 *  as opposed to cargo-only movers (bicycle, motorbike, canter, box truck). */
export function isPassengerVehicle(vehicleType: VehicleType): boolean {
  return VEHICLE_CLASSES[vehicleType]?.rideClass != null;
}

/**
 * [Founder decision XL-vehicle-gap · delegated ruling 2026-09-06] A ride tier is
 * OFFERED only when some vehicle class in the fleet serves it. Nothing maps to XL
 * today (CAR→ECONOMY, WAGON_CAR→COMFORT, BUS_9/BUS_15→GROUP), so selling XL meant
 * either a 15-seater at XL price or a request no driver could ever take. The tier
 * appears the day a vehicle class maps to it — no other change is needed.
 */
export function servedRideClassesOf(table: Record<string, Pick<VehicleClass, 'rideClass'>>): ReadonlySet<RideClass> {
  const set = new Set<RideClass>();
  for (const v of Object.values(table)) if (v.rideClass) set.add(v.rideClass);
  return set;
}
export const SERVED_RIDE_CLASSES: ReadonlySet<RideClass> = servedRideClassesOf(VEHICLE_CLASSES);
export function isRideClassServed(rideClass: RideClass): boolean {
  return SERVED_RIDE_CLASSES.has(rideClass);
}

