import { normalizeRegistrationMark } from './subjects';

interface VehicleIdentity {
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleColor: string | null;
  licensePlate: string | null;
}

const text = (value: string | null) => (value ?? '').trim().toLowerCase();

/** Omitted and formatting-only values preserve the saved vehicle's review. */
export function vehicleIdentityChanged(current: VehicleIdentity, update: Partial<VehicleIdentity>): boolean {
  return (['vehicleMake', 'vehicleModel', 'vehicleColor'] as const).some(
    (field) => update[field] !== undefined && text(update[field]) !== text(current[field]),
  ) || (update.vehicleYear !== undefined && update.vehicleYear !== current.vehicleYear)
    || (update.licensePlate !== undefined
      && normalizeRegistrationMark(update.licensePlate ?? '') !== normalizeRegistrationMark(current.licensePlate ?? ''));
}
