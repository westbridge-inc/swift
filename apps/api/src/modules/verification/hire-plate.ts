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
import { Prisma, type VehicleType } from '@prisma/client';
import { VEHICLE_CLASSES, carDeliveriesEnabled, isPassengerVehicle, moverRoleFor, type MoverRole } from '../../config/vehicle-classes';
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

/**
 * [CARS-PLATES · owner 6 Nov 2026 ~04:20Z] Cars by plate: a PRIVATE (P, or any non-H) plate car does DELIVERIES
 * ONLY; an H-plate (hire) car drives taxi rides and may deliver too. So a car's work is decided by its plate:
 *  - an H plate -> the taxi profile (Driver), exactly as today (its deliveries are "Deliveries too" on that car);
 *  - any other plate -> a delivery profile (Rider) on the car, only while the CAR_DELIVERIES switch is on. With the
 *    switch off a car is a taxi as before, so a non-H plate is refused in TAXI_PLATE_COPY's words (the kill switch).
 * The plate class is the plate's first letter (subjects.plateClassOf, never stored twice); it counts only once a
 * person approves the car's Certificate of Registration for that plate (the evidence rule binds papers to the plate).
 * Every vehicle that carries no passengers keeps its role (moverRoleFor).
 */
export function moverRoleForVehicle(
  vehicleType: VehicleType,
  plate: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): MoverRole {
  if (needsHirePlate(vehicleType) && !isHirePlate(plate) && carDeliveriesEnabled(env)) return 'RIDER';
  return moverRoleFor(vehicleType);
}

/** Sign-up and a vehicle change: refuse the plate only where it can never be approved for the work it gets. */
export function assertPlateForWork(vehicleType: VehicleType, plate: string | null | undefined, role: MoverRole): void {
  if (role === 'DRIVER') assertHirePlate(vehicleType, plate);
}

/** Words for a private-plate car's delivery sign-up (the app and the website say the same). */
export const PRIVATE_CAR_COPY = 'A private (P) plate car can do deliveries only. Taxi rides need an H plate.';

/**
 * [CARS-PLATES] The H rule in SQL, for the taxi pool's candidate search: the plate column, normalised as
 * normalizeRegistrationMark does (upper case, no spaces or dashes), starts with H. A P-plate car is never offered a
 * ride, whatever its row says about anything else.
 */
export function hirePlateSql(plateColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`left(upper(regexp_replace(coalesce(${plateColumn}, ''), '[[:space:]-]+', '', 'g')), 1) = 'H'`;
}

/** The refusal a non-H taxi meets at the claim (the locked belt behind the candidate SQL and the papers gate). */
export const TAXI_NEEDS_HIRE_PLATE = 'TAXI_NEEDS_HIRE_PLATE';
