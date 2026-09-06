/**
 * [Founder decision "XL-vehicle-gap" · delegated ruling 2026-09-06] A ride tier is
 * offered only when a vehicle class in the fleet serves it.
 *
 * Nothing maps to XL (CAR → ECONOMY, WAGON_CAR → COMFORT, BUS_9/BUS_15 → GROUP), yet
 * the quote sold it: a customer who booked XL got a 15-seater at XL price when a bus
 * was near, and an unfillable request when only cars were — the common case. The
 * offered ladder is now derived from the fleet table; the tier appears the day a
 * vehicle class maps to it, with no other change.
 */
import { describe, it, expect } from 'vitest';
import { VEHICLE_CLASSES, SERVED_RIDE_CLASSES, servedRideClassesOf, isRideClassServed } from '../config/vehicle-classes';
import { RIDE_CLASS_ORDER, offeredRideClasses, classesAtOrAbove } from '../modules/rides/fare.service';

describe('ride tier availability — offered only when a vehicle serves it', () => {
  it('the served set is derived from the fleet table, and today it has no XL', () => {
    expect([...SERVED_RIDE_CLASSES].sort()).toEqual(['COMFORT', 'ECONOMY', 'GROUP']);
    expect(isRideClassServed('XL')).toBe(false);
    expect(Object.values(VEHICLE_CLASSES).some((v) => v.rideClass === 'XL')).toBe(false);
  });

  it('the offered ladder keeps the order and drops the unserved tier; the eligibility ladder keeps every class', () => {
    expect(offeredRideClasses()).toEqual(['ECONOMY', 'COMFORT', 'GROUP']);
    expect(RIDE_CLASS_ORDER).toEqual(['ECONOMY', 'COMFORT', 'XL', 'GROUP']);
    expect(classesAtOrAbove('COMFORT')).toEqual(['COMFORT', 'XL', 'GROUP']);
  });

  it('the day a vehicle class maps to XL, the tier is served — nothing else has to change', () => {
    const withSuv = { ...VEHICLE_CLASSES, SUV: { rideClass: 'XL' as const } };
    expect([...servedRideClassesOf(withSuv)].sort()).toEqual(['COMFORT', 'ECONOMY', 'GROUP', 'XL']);
    const ordered = RIDE_CLASS_ORDER.filter((c) => servedRideClassesOf(withSuv).has(c));
    expect(ordered).toEqual(['ECONOMY', 'COMFORT', 'XL', 'GROUP']);
  });
});
