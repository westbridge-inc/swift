import type { Prisma, PrismaClient, UserRole, VehicleType } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { VEHICLE_CLASSES, carDeliveriesEnabled, carriesGoods, isPassengerVehicle, isVehicleOffered } from '../../config/vehicle-classes';
import { evaluateMoverDocuments, lockMoverDocuments, type MoverDocumentVerdict } from '../verification/mover-document-authority';
import { normalizeRegistrationMark } from '../verification/subjects';
import { FloatService } from '../dispatch/float.service';
import { ReviewDemoRoleRefusedError } from '../review/demo-policy';

// ---------------------------------------------------------------------------
// [CARS-DELIVER · owner 8 Oct 2026 ~23:30 GYT + 25 Oct 22:33Z] A verified taxi driver's car can ALSO take
// store deliveries ("Deliveries too"). It ships behind the CAR_DELIVERIES switch (config/vehicle-classes:
// on only when exactly '1', OFF by default). GUARDRAILS §8: taxi cars carry passengers only until counsel
// verifies goods carriage, so while the switch is off nothing here can be set up and nothing changes.
//
// The delivery work runs on a DELIVERY PROFILE: the account's Rider row, carrying the driver's OWN car.
// Every delivery rule is the rider's, unchanged — the offer card and its cash math, the float gate,
// custody, door cash, settlement, earnings, ratings, recovery — and a delivery binds riderId, never
// driverId. The taxi profile, its GO, its dispatch and its claims are untouched. One person is still taxi
// OR delivery supply at a time: GO on either profile retires the other (mover-authority), and the mover
// switches between the two with the existing switch-role.
//
// The delivery profile is a MIRROR of the taxi car: its vehicle fields, photos and legacy document grant
// are copied from the Driver row (carMirror) when it is set up, on every delivery GO, and when the
// vehicle changes. And it works only as its owner's VERIFIED taxi car: delivery GO and every delivery
// claim also need the taxi document verdict on that car (H plate, hire licences, hire-class insurance —
// Mover Agreement §7: "anyone delivering must hold insurance that permits use for hire or reward").
// Store orders only (riderType DELIVERY): parcels stay with riders, as the owner's ruling names
// "food/shop deliveries".
//
// [PR4 · "or get both", COORD ruling 26 Oct] "Taxi + deliveries" (drivers.takesDeliveries): while the taxi profile
// is online and free, the delivery profile is ALSO a delivery candidate, located where the taxi is (the delivery
// candidate search, dispatch.service). Accepting a delivery PROMOTES it inside the claim's own transaction (taxi
// supply retired, the delivery profile online on the same device session, work app -> deliveries, marked
// returnsToTaxi); when its deliveries end the account RETURNS to taxi work with deliveries on
// (car-deliveries-return.ts). Still one job at a time; the taxi pool, taxi GO and taxi claims are untouched.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Prisma.TransactionClient;

/** The code a delivery profile is refused in when its car no longer matches a usable taxi profile. */
export const CAR_DELIVERY_NEEDS_TAXI = 'CAR_DELIVERY_NEEDS_TAXI';
/** The code "Deliveries too" is refused in when the account already delivers with another vehicle. */
export const DELIVERY_PROFILE_OTHER_VEHICLE = 'DELIVERY_PROFILE_OTHER_VEHICLE';

/** Why "Deliveries too" cannot be set up right now (null: it can be, or already is). */
export type CarDeliveriesReason = 'SWITCH_OFF' | 'VEHICLE' | 'OTHER_DELIVERY_VEHICLE';

export interface CarDeliveriesStatus {
  /** "Deliveries too" can be set up (or used) on this account today. The phone shows the card only then. */
  available: boolean;
  /** This account has a delivery profile on its taxi car. */
  enabled: boolean;
  reason: CarDeliveriesReason | null;
  /** The car the deliveries would run on, as the mover's vehicle picker names it. */
  vehicle: { type: VehicleType; label: string } | null;
  /** [PR4] "Taxi + deliveries" is on: store delivery offers also come while the taxi is online and free. */
  takesDeliveries: boolean;
}

/** A Rider row on a passenger vehicle is a taxi car's delivery profile (onboarding never makes one otherwise). */
export function isCarDeliveryProfile(vehicleType: VehicleType): boolean {
  return isPassengerVehicle(vehicleType);
}

const samePlate = (a?: string | null, b?: string | null) => normalizeRegistrationMark(a ?? '') === normalizeRegistrationMark(b ?? '');

const MIRROR_SOURCE = {
  vehicleType: true, vehicleMake: true, vehicleModel: true, vehicleYear: true, vehicleColor: true, licensePlate: true,
  vehiclePhotoUrl: true, profilePhotoUrl: true,
  documentsVerified: true, documentsVerifiedAt: true, documentsVerifiedBy: true,
} as const;
type MirrorSource = Prisma.DriverGetPayload<{ select: typeof MIRROR_SOURCE }>;

/** The delivery profile's car and grant, exactly the taxi profile's. */
export function carMirror(driver: MirrorSource) {
  return {
    vehicleType: driver.vehicleType,
    vehicleMake: driver.vehicleMake,
    vehicleModel: driver.vehicleModel,
    vehicleYear: driver.vehicleYear,
    vehicleColor: driver.vehicleColor,
    licensePlate: driver.licensePlate,
    vehiclePhotoUrl: driver.vehiclePhotoUrl,
    profilePhotoUrl: driver.profilePhotoUrl,
    documentsVerified: driver.documentsVerified,
    documentsVerifiedAt: driver.documentsVerifiedAt,
    documentsVerifiedBy: driver.documentsVerifiedBy,
  };
}

function mirrorDiffers(rider: Prisma.RiderGetPayload<{ select: typeof MIRROR_SOURCE }>, next: ReturnType<typeof carMirror>): boolean {
  return rider.vehicleType !== next.vehicleType
    || (rider.vehicleMake ?? null) !== (next.vehicleMake ?? null)
    || (rider.vehicleModel ?? null) !== (next.vehicleModel ?? null)
    || (rider.vehicleYear ?? null) !== (next.vehicleYear ?? null)
    || (rider.vehicleColor ?? null) !== (next.vehicleColor ?? null)
    || (rider.licensePlate ?? null) !== (next.licensePlate ?? null)
    || (rider.vehiclePhotoUrl ?? null) !== (next.vehiclePhotoUrl ?? null)
    || (rider.profilePhotoUrl ?? null) !== (next.profilePhotoUrl ?? null)
    || rider.documentsVerified !== next.documentsVerified
    || (rider.documentsVerifiedAt?.getTime() ?? null) !== (next.documentsVerifiedAt?.getTime() ?? null)
    || (rider.documentsVerifiedBy ?? null) !== (next.documentsVerifiedBy ?? null);
}

/** Can this taxi car take deliveries today (switch AND vehicle)? */
function carCanDeliver(vehicleType: VehicleType): boolean {
  return isPassengerVehicle(vehicleType) && isVehicleOffered(vehicleType) && carriesGoods(vehicleType);
}

function carDeliveryNeedsTaxi(): AppError {
  return new AppError(403, CAR_DELIVERY_NEEDS_TAXI,
    'Deliveries by car run on your taxi profile. Set up taxi driving with this car first.');
}

/** GET /driver/deliveries — what the driver's account screen shows. Reads only. */
export async function carDeliveriesStatus(db: Db, userId: string): Promise<CarDeliveriesStatus> {
  const [driver, rider] = await Promise.all([
    db.driver.findUnique({ where: { userId }, select: { vehicleType: true, takesDeliveries: true } }),
    db.rider.findUnique({ where: { userId }, select: { vehicleType: true } }),
  ]);
  if (!driver) throw new NotFoundError('Driver');
  const enabled = !!rider && isCarDeliveryProfile(rider.vehicleType);
  const vehicle = { type: driver.vehicleType, label: VEHICLE_CLASSES[driver.vehicleType]?.label ?? driver.vehicleType };
  const reason: CarDeliveriesReason | null = !carDeliveriesEnabled()
    ? 'SWITCH_OFF'
    : rider && !enabled
      ? 'OTHER_DELIVERY_VEHICLE'
      : !carCanDeliver(driver.vehicleType) ? 'VEHICLE' : null;
  return { available: reason === null, enabled, reason, vehicle, takesDeliveries: enabled && driver.takesDeliveries };
}

/**
 * POST /driver/deliveries — set up "Deliveries too": a delivery profile on the taxi car. Caller checked the
 * switch (and refused while it is off, before this runs). Idempotent: an existing delivery profile is
 * answered as it is (every delivery GO re-syncs it). Nothing about the taxi profile or its supply changes:
 * the new profile starts offline, and the mover's current work app (lastMoverRole) stays as it was.
 */
export async function enableCarDeliveries(prisma: PrismaClient, userId: string): Promise<CarDeliveriesStatus> {
  await prisma.$transaction(async (tx) => {
    // The global lock order (mover-authority): User, then Rider, then Driver.
    const users = await tx.$queryRaw<Array<{ roles: UserRole[]; status: string; tenantKind: string }>>`
      SELECT u."roles", u."status"::text AS "status", t."kind"::text AS "tenantKind"
      FROM "users" u JOIN "tenants" t ON t."id" = u."tenantId"
      WHERE u."id" = ${userId}
      FOR UPDATE OF u
    `;
    const user = users[0];
    if (!user) throw new NotFoundError('User');
    // [REVIEW-PARTNER] A demo (REVIEW) account never gains a rider role.
    if (user.tenantKind === 'REVIEW') throw new ReviewDemoRoleRefusedError();
    if (user.status === 'SUSPENDED' || user.status === 'BANNED' || user.status === 'DEACTIVATED') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot add delivery work.');
    }
    await tx.$queryRaw`SELECT "id" FROM "riders" WHERE "userId" = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "drivers" WHERE "userId" = ${userId} FOR UPDATE`;
    const driver = await tx.driver.findUnique({ where: { userId }, select: MIRROR_SOURCE });
    if (!driver) throw new NotFoundError('Driver');
    if (!carCanDeliver(driver.vehicleType)) {
      throw new AppError(403, 'VEHICLE_NOT_OFFERED', 'This vehicle cannot take deliveries on Swift.');
    }
    const rider = await tx.rider.findUnique({ where: { userId }, select: { id: true, vehicleType: true } });
    if (rider && !isCarDeliveryProfile(rider.vehicleType)) {
      throw new AppError(409, DELIVERY_PROFILE_OTHER_VEHICLE,
        `You already deliver with your ${(VEHICLE_CLASSES[rider.vehicleType]?.label ?? 'other vehicle').toLowerCase()}. Switch to deliveries to use it.`);
    }
    if (rider) return;
    // A verified taxi car only: the taxi document verdict on this car, read under the locks.
    const verdict = await lockMoverDocuments(tx, userId, 'DRIVER');
    if (!verdict.allowed) {
      throw new AppError(403, 'VERIFICATION_REQUIRED', 'Your taxi documents must be approved and current before you add deliveries.');
    }
    const created = await tx.rider.create({ data: { userId, riderType: 'DELIVERY', ...carMirror(driver) }, select: { id: true } });
    // D.3 — the new profile's float limit from the mover's trust level + country, as onboarding seeds it.
    await new FloatService(tx).recomputeForUser(userId);
    const missing = (['MOVER', 'RIDER'] as const).filter((role) => !user.roles.includes(role));
    if (missing.length) await tx.user.update({ where: { id: userId }, data: { roles: [...user.roles, ...missing] } });
    await tx.auditLog.create({
      data: {
        userId,
        action: 'MOVER_CAR_DELIVERIES_ADDED',
        entity: 'Rider',
        entityId: created.id,
        changes: { vehicleType: driver.vehicleType, riderType: 'DELIVERY' },
      },
    });
  });
  return carDeliveriesStatus(prisma, userId);
}

/**
 * Delivery GO, under the caller's User and Rider locks: re-derive the delivery profile's car from the taxi
 * profile (Rider -> Driver lock order), so it always goes online as the car the taxi profile names today —
 * a plate, make, model, year, colour or photo changed through the taxi profile is never left behind.
 */
export async function syncCarDeliveryProfile(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "drivers" WHERE "userId" = ${userId} FOR UPDATE`;
  const driver = await tx.driver.findUnique({ where: { userId }, select: MIRROR_SOURCE });
  if (!driver || !isPassengerVehicle(driver.vehicleType) || !normalizeRegistrationMark(driver.licensePlate ?? '')) {
    throw carDeliveryNeedsTaxi();
  }
  const rider = await tx.rider.findUniqueOrThrow({ where: { userId }, select: MIRROR_SOURCE });
  const next = carMirror(driver);
  if (mirrorDiffers(rider, next)) await tx.rider.update({ where: { userId }, data: next });
}

/**
 * Vehicle change (PartnerService.changeVehicleWithAuthority, which holds the User, Rider and Driver locks):
 * the delivery profile follows the taxi profile's NEW car, offline, so it never names a car the account no
 * longer drives (customers are shown the car that comes; the old car's papers retire through the change's own
 * fresh-review rule).
 */
export async function followTaxiCar(tx: Tx, riderId: string, driverId: string, extra: Prisma.RiderUpdateInput): Promise<void> {
  const driver = await tx.driver.findUniqueOrThrow({ where: { id: driverId }, select: MIRROR_SOURCE });
  await tx.rider.update({ where: { id: riderId }, data: { ...carMirror(driver), ...extra } });
}

/**
 * Delivery GO's fast preview for a taxi car (honest words before the locked checks): the taxi document
 * verdict on the car the taxi profile names today. The delivery profile's own checklist is the same
 * vehicle's, so the taxi verdict covers it; the AUTHORITATIVE checks re-run under the locks.
 */
export async function carDeliveryLivePreview(db: Db, userId: string): Promise<boolean> {
  const driver = await db.driver.findUnique({ where: { userId }, select: { vehicleType: true, licensePlate: true, documentsVerified: true } });
  if (!driver || !isPassengerVehicle(driver.vehicleType) || !normalizeRegistrationMark(driver.licensePlate ?? '')) throw carDeliveryNeedsTaxi();
  return (await evaluateMoverDocuments(db, userId, { kind: 'DRIVER', vehicleType: driver.vehicleType, legacyVerified: driver.documentsVerified })).allowed;
}

/**
 * The taxi document verdict a delivery profile works under, read under the caller's Rider lock (Rider ->
 * Driver). Denied unless the account's taxi profile names the same car (type and plate) as the delivery
 * profile. Delivery GO and every delivery claim (reserveRiderLeg) read it for a passenger vehicle.
 */
export async function lockCarDeliveryAuthority(tx: Tx, userId: string): Promise<MoverDocumentVerdict> {
  const verdict = await lockMoverDocuments(tx, userId, 'DRIVER');
  const [driver, rider] = await Promise.all([
    tx.driver.findUnique({ where: { userId }, select: { vehicleType: true, licensePlate: true } }),
    tx.rider.findUnique({ where: { userId }, select: { vehicleType: true, licensePlate: true } }),
  ]);
  if (!driver || !rider || driver.vehicleType !== rider.vehicleType || !samePlate(driver.licensePlate, rider.licensePlate)
    || !normalizeRegistrationMark(driver.licensePlate ?? '')) {
    return { allowed: false, reason: 'docs', validUntil: null };
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// [PR4] "Taxi + deliveries"
// ---------------------------------------------------------------------------

/** The code "Taxi + deliveries" is refused in before "Deliveries too" is set up. */
export const DELIVERIES_NOT_SET_UP = 'DELIVERIES_NOT_SET_UP';

/**
 * PUT /driver/deliveries/mode — turn "taxi + deliveries" on or off. On needs the switch (the route refuses first
 * while it is off), an active account and a delivery profile on this taxi car; off is always allowed. Under the
 * User, then Rider, then Driver locks. It changes no supply: an online taxi stays exactly as it is.
 */
export async function setTaxiAndDeliveries(prisma: PrismaClient, userId: string, on: boolean): Promise<CarDeliveriesStatus> {
  await prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    if (!users[0]) throw new NotFoundError('User');
    await tx.$queryRaw`SELECT "id" FROM "riders" WHERE "userId" = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "drivers" WHERE "userId" = ${userId} FOR UPDATE`;
    const [driver, rider] = await Promise.all([
      tx.driver.findUnique({ where: { userId }, select: { id: true, vehicleType: true } }),
      tx.rider.findUnique({ where: { userId }, select: { vehicleType: true } }),
    ]);
    if (!driver) throw new NotFoundError('Driver');
    if (on) {
      if (users[0].status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Your account must be active before you can take work.');
      if (!rider || !isCarDeliveryProfile(rider.vehicleType)) {
        throw new AppError(409, DELIVERIES_NOT_SET_UP, 'Add deliveries first, then turn on taxi rides and deliveries together.');
      }
      if (!carCanDeliver(driver.vehicleType)) throw new AppError(403, 'VEHICLE_NOT_OFFERED', 'This vehicle cannot take deliveries on Swift.');
    }
    await tx.driver.update({ where: { id: driver.id }, data: { takesDeliveries: on } });
  });
  return carDeliveriesStatus(prisma, userId);
}
