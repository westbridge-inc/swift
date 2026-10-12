/**
 * [Owner ruling 11 Oct 2026 — H-PLATE: KEEP] A Guyana taxi (a hire car: car or wagon car) carries an
 * H-series registration mark (GRA's plate-series table: "Hire Car — HD"; private cars use P, buses B,
 * goods vehicles G). Approval already refuses a taxi whose registered plate is not H-series
 * (V_PLATE_CLASS, and the stored-vehicle check). This is the same rule said EARLIER, where the plate is
 * typed — sign-up and the vehicle screens — so nobody saves a taxi plate that could never be approved
 * and waits for an approval that cannot come (a taxi typed with a private plate used to sit unapprovable, unexplained).
 *
 * Buses (B-series plates; road-service licence, s.64) are hidden at launch and are not judged here.
 */
import type { VehicleType } from '@prisma/client';
import { VEHICLE_CLASSES, isPassengerVehicle } from '../../config/vehicle-classes';
import { AppError } from '../../utils/errors';
import { normalizeRegistrationMark, plateClassOf } from './subjects';

export const TAXI_PLATE_NOT_HIRE = 'TAXI_PLATE_NOT_HIRE';
/** Plain words for the person typing the plate. The app and website hints repeat these exact words. */
export const TAXI_PLATE_COPY = 'Taxi plates in Guyana start with H — e.g. HC 1234. Enter the plate shown on your Certificate of Registration. A private (P) plate cannot be approved for taxi work.';

/** The hire-car classes: passenger vehicles other than buses (Group). */
export function needsHirePlate(vehicleType: VehicleType): boolean {
  return isPassengerVehicle(vehicleType) && VEHICLE_CLASSES[vehicleType]?.rideClass !== 'GROUP';
}

export function isHirePlate(plate: string | null | undefined): boolean {
  return plateClassOf(plate ?? '') === 'H';
}

/** Refuses a hire-car plate that is not H-series, before anything is saved. */
export function assertHirePlate(vehicleType: VehicleType, plate: string | null | undefined): void {
  if (needsHirePlate(vehicleType) && !isHirePlate(plate)) throw new AppError(400, TAXI_PLATE_NOT_HIRE, TAXI_PLATE_COPY);
}

/** A plate EDIT: judged only when the plate really changes (formatting-only saves and other details pass). */
export function assertHirePlateChange(vehicleType: VehicleType, nextPlate: string | undefined, currentPlate: string | null): void {
  if (nextPlate === undefined || normalizeRegistrationMark(nextPlate) === normalizeRegistrationMark(currentPlate ?? '')) return;
  assertHirePlate(vehicleType, nextPlate);
}
