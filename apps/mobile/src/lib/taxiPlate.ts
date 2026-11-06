import type { VehicleKind } from '../services/api';

/**
 * [Owner ruling 11 Oct 2026 — H-PLATE: KEEP] A Guyana taxi (car / wagon car) carries an H-series plate
 * (GRA: "Hire Car — HD"). The server refuses any other taxi plate at sign-up and on the vehicle screens
 * (TAXI_PLATE_NOT_HIRE) and its message is shown as it is; the app says the same thing BEFORE the
 * person presses save. Buses (B-series) are hidden at launch and are not judged here.
 */
export const TAXI_PLATE_HINT = 'Taxi plates in Guyana start with H — e.g. HC 1234.';
export const TAXI_PLATE_ERROR = 'Taxi plates in Guyana start with H — e.g. HC 1234. Enter the plate shown on your Certificate of Registration. A private (P) plate cannot be approved for taxi work.';

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

/**
 * [CARS-PLATES · owner 6 Nov 2026] P-plate (private) cars deliver only; H-plate (hire) cars drive taxi rides and
 * deliver too. While the server says private cars deliver (`privateCars.on`), the plate decides the work and is never
 * an error; otherwise a car is a taxi, as before (taxiPlateMessage).
 */
export const CAR_PLATE_HINT = 'H plate (e.g. HC 1234): taxi rides, and deliveries too. Private (P) plate: deliveries only.';
export const PRIVATE_CAR_NOTE = 'A private (P) plate car can do deliveries only. Taxi rides need an H plate.';
/** The car rows' line in the vehicle picker while private cars deliver. */
export const CAR_ROW_HINT = 'Deliveries · taxi rides too with an H plate';
export const HIRE_CAR_NOTE = 'H plate: you sign up for taxi rides, and you can add deliveries in your account.';

export function carPlateMessage(kind: VehicleKind, plate: string, privateCarsOpen: boolean): { text: string; error: boolean } | null {
  if (!privateCarsOpen) return taxiPlateMessage(kind, plate);
  if (!needsHirePlate(kind)) return null;
  if (!plate.trim()) return { text: CAR_PLATE_HINT, error: false };
  return { text: isHirePlate(plate) ? HIRE_CAR_NOTE : PRIVATE_CAR_NOTE, error: false };
}

/** The work a car signs up for: a taxi (H plate, or while private cars do not deliver) or deliveries (a P plate). */
export function carWork(kind: VehicleKind, plate: string, privateCarsOpen: boolean): 'TAXI' | 'DELIVERY' | null {
  if (!needsHirePlate(kind)) return null;
  return privateCarsOpen && !isHirePlate(plate) ? 'DELIVERY' : 'TAXI';
}
