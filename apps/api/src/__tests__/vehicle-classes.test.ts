import { describe, it, expect } from 'vitest';
import { VehicleType } from '@prisma/client';
import {
  VEHICLE_CLASSES,
  VEHICLE_TYPES_IN_ORDER,
  vehicleTypesForPackageSize,
  docProfilesFor,
} from '../config/vehicle-classes';
import { vehiclesForPackageSize, vehicleCanCarry } from '../modules/dispatch/dispatch.service';

describe('vehicle-class taxonomy', () => {
  // ── Characterization: the original three vehicles keep their EXACT courier
  //    capacity, so expanding the fleet cannot silently change who gets a parcel.
  describe('capacity is preserved for the original fleet (SWIFT-062)', () => {
    it('bicycle carries up to MEDIUM, never LARGE/EXTRA_LARGE', () => {
      expect(vehicleCanCarry('BICYCLE', 'SMALL')).toBe(true);
      expect(vehicleCanCarry('BICYCLE', 'MEDIUM')).toBe(true);
      expect(vehicleCanCarry('BICYCLE', 'LARGE')).toBe(false);
      expect(vehicleCanCarry('BICYCLE', 'EXTRA_LARGE')).toBe(false);
    });
    it('motorcycle carries up to LARGE, never EXTRA_LARGE', () => {
      expect(vehicleCanCarry('MOTORCYCLE', 'LARGE')).toBe(true);
      expect(vehicleCanCarry('MOTORCYCLE', 'EXTRA_LARGE')).toBe(false);
    });
    it('car carries every size including EXTRA_LARGE', () => {
      expect(vehicleCanCarry('CAR', 'EXTRA_LARGE')).toBe(true);
    });
    it('an unknown/absent size is carriable by the original three (and now everyone)', () => {
      const any = vehiclesForPackageSize(null);
      expect(any).toEqual(expect.arrayContaining(['BICYCLE', 'MOTORCYCLE', 'CAR']));
    });
  });

  // ── New behaviour: the bigger Guyana fleet dispatches for heavy parcels.
  describe('the expanded fleet carries heavy parcels', () => {
    it('box trucks and canters carry EXTRA_LARGE (a car can, a bicycle cannot)', () => {
      for (const t of ['BOX_TRUCK_SHORT', 'BOX_TRUCK_LONG', 'CANTER_SHORT', 'CANTER_LONG', 'WAGON_CAR']) {
        expect(vehicleCanCarry(t, 'EXTRA_LARGE')).toBe(true);
      }
    });
    it('a bigger vehicle can still carry a small parcel', () => {
      expect(vehicleCanCarry('BOX_TRUCK_LONG', 'SMALL')).toBe(true);
    });
    it('EXTRA_LARGE dispatch reaches the big vehicles + car, but not bike/motorbike', () => {
      const capable = vehiclesForPackageSize('EXTRA_LARGE');
      expect(capable).toEqual(
        expect.arrayContaining(['CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15', 'CANTER_SHORT', 'BOX_TRUCK_LONG']),
      );
      expect(capable).not.toContain('BICYCLE');
      expect(capable).not.toContain('MOTORCYCLE');
    });
  });

  // ── Config integrity: every enum value is a class, and the picker order is total.
  describe('taxonomy integrity', () => {
    it('every VehicleType enum value has a class entry', () => {
      for (const t of Object.values(VehicleType)) {
        expect(VEHICLE_CLASSES[t], `missing class for ${t}`).toBeDefined();
      }
    });
    it('lists all vehicle types small → large, no duplicates', () => {
      expect(VEHICLE_TYPES_IN_ORDER).toHaveLength(Object.values(VehicleType).length);
      expect(new Set(VEHICLE_TYPES_IN_ORDER).size).toBe(VEHICLE_TYPES_IN_ORDER.length);
      expect(VEHICLE_TYPES_IN_ORDER[0]).toBe('BICYCLE');
    });
    it('config function and dispatch wrapper agree', () => {
      for (const size of ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE', null]) {
        expect(vehiclesForPackageSize(size)).toEqual(vehicleTypesForPackageSize(size));
      }
    });
  });

  // ── Document profiles: preserved for the base three, commercial for the fleet.
  describe('document profiles per vehicle (verification checklist source)', () => {
    it('bicycle needs no vehicle documents; car keeps motor + taxi-extra', () => {
      expect(docProfilesFor('BICYCLE')).toEqual([]);
      expect(docProfilesFor('MOTORCYCLE')).toEqual(['MOVER_MOTOR']);
      expect(docProfilesFor('CAR')).toEqual(['MOVER_MOTOR', 'MOVER_TAXI_EXTRA']);
    });
    it('trucks and buses carry a commercial document profile', () => {
      for (const t of ['BUS_9', 'BUS_15', 'CANTER_SHORT', 'BOX_TRUCK_LONG'] as const) {
        expect(docProfilesFor(t)).toContain('MOVER_COMMERCIAL');
      }
    });
  });
});
