import type { VehicleKind } from '../services/api';

/**
 * [Owner ruling 11 Oct 2026 — H-PLATE: KEEP] A Guyana taxi (car / wagon car) carries an H-series plate
 * (GRA: "Hire Car — HD"). The server refuses any other taxi plate at sign-up and on the vehicle screens
 * (TAXI_PLATE_NOT_HIRE) and its message is shown as it is; the app says the same thing BEFORE the
 * person presses save. Buses (B-series) are hidden at launch and are not judged here.
 */
export const TAXI_PLATE_HINT = 'Taxi plates in Guyana start with H — e.g. HC 1234.';
export const TAXI_PLATE_ERROR = 'Taxi plates in Guyana start with H — e.g. HC 1234. Enter the plate on your Certificate of Registration; a private (P) plate cannot be approved for taxi work.';

const HIRE_CAR_KINDS: readonly VehicleKind[] = ['CAR', 'WAGON_CAR'];

export function needsHirePlate(kind: VehicleKind): boolean {
  return HIRE_CAR_KINDS.includes(kind);
}

/** The server's reading: spaces and hyphens ignored, first letter H. */
export function isHirePlate(plate: string): boolean {
  return plate.toUpperCase().replace(/[\s-]+/g, '').startsWith('H');
}

/** What to say under the plate field: nothing, the hint, or the error once a non-H plate is typed. */
export function taxiPlateMessage(kind: VehicleKind, plate: string): { text: string; error: boolean } | null {
  if (!needsHirePlate(kind)) return null;
  if (plate.trim() && !isHirePlate(plate)) return { text: TAXI_PLATE_ERROR, error: true };
  return { text: TAXI_PLATE_HINT, error: false };
}
