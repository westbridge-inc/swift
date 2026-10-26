import type { PrismaClient } from '@prisma/client';
import { isPassengerVehicle, isVehicleOffered } from '../../config/vehicle-classes';
import { documentDeadlineSql, lockMoverDocuments } from '../verification/mover-document-authority';
import { lockMoverSources, moverFeeOperability, moverFeePayer } from '../subscription/mover-fee-authority';
import { assertShiftLiveness } from '../safety/liveness.service';
import { assertNotSafetySuspended } from '../safety/incident.service';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';

// ---------------------------------------------------------------------------
// [CARS-DELIVER PR4 · COORD ruling 26 Oct] After a delivery taken from "taxi + deliveries" (car-deliveries.ts
// promoteDeliveryFromTaxi), the account AUTO-RETURNS to taxi work with deliveries on: the mover opted into both,
// and staying in delivery-only would silently drop them from taxi supply.
//
// The trigger is the delivery profile's own location heartbeat (PUT /rider/location): the first one after its
// last live leg ends — whichever path ended it (delivered, handed back, cancelled, rescued) — returns the account,
// on the same device session, at that heartbeat's position. The phone is told (the heartbeat is refused with
// RETURNED_TO_TAXI), refetches, and its location stream follows the taxi profile.
//
// The taxi profile goes back online only through the taxi GO's own gates, re-read under the locks: an active
// account, a vehicle Swift takes, no safety suspension or identity lock (and a fresh selfie check where required),
// the taxi documents (H plate, hire licences, hire-class insurance; deadline enforced at the write) and the
// weekly fee. If any of them fails, the delivery profile still goes offline and the account lands on taxi work
// OFFLINE (the taxi GO then says why). Nothing here depends on the CAR_DELIVERIES switch: taxi work never did.
// ---------------------------------------------------------------------------

export type TaxiReturn = 'RETURNED' | 'RETURNED_OFFLINE';

/** Lock order: User, the payer's subscriptions (as taxi GO takes them), Rider, Driver, then documents. */
export async function returnToTaxiAndDeliveries(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
  at: { latitude: number; longitude: number },
): Promise<TaxiReturn | null> {
  const payer = await moverFeePayer(prisma, userId);
  return prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<Array<{ status: string; selfieCapturedAt: Date | null }>>`
      SELECT "status"::text AS "status", "selfieCapturedAt" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    const user = users[0];
    if (!user || user.status !== 'ACTIVE') return null;
    await lockMoverSources(tx, payer);
    const riders = await tx.$queryRaw<Array<{ id: string; returnsToTaxi: boolean; isOnline: boolean; locationSessionId: string | null; vehicleType: string }>>`
      SELECT "id", "returnsToTaxi", "isOnline", "locationSessionId", "vehicleType"::text AS "vehicleType"
      FROM "riders" WHERE "userId" = ${userId} FOR UPDATE`;
    const rider = riders[0];
    if (!rider || !rider.returnsToTaxi || !rider.isOnline || rider.locationSessionId !== sessionId
      || !isPassengerVehicle(rider.vehicleType as never)) return null;
    const legs = await tx.order.count({ where: { riderId: rider.id, status: { notIn: [...TERMINAL_ORDER_STATUSES] } } });
    if (legs > 0) return null;
    const drivers = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "drivers" WHERE "userId" = ${userId} FOR UPDATE`;
    if (!drivers[0]) return null;
    const driver = await tx.driver.findUniqueOrThrow({
      where: { userId },
      select: { id: true, vehicleType: true, currentRideId: true, lastLivenessPassAt: true, livenessLockedAt: true, safetySuspendedAt: true },
    });
    if (driver.currentRideId) return null;
    const sessions = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sessions" WHERE "id" = ${sessionId} AND "userId" = ${userId} AND "expiresAt" > NOW() FOR SHARE`;

    // Delivery supply ends either way; the account is on taxi work from here.
    await tx.$executeRaw`
      UPDATE "riders" SET "isOnline" = false, "isAvailable" = false, "locationSessionId" = NULL, "returnsToTaxi" = false,
        "updatedAt" = clock_timestamp()
      WHERE "id" = ${rider.id}`;
    await tx.user.update({ where: { id: userId }, data: { activeRole: 'DRIVER', lastMoverRole: 'DRIVER' } });

    // The taxi GO's gates, under the locks.
    const passes = (() => {
      if (!sessions[0] || !user.selfieCapturedAt || !isVehicleOffered(driver.vehicleType)) return false;
      try {
        assertShiftLiveness(driver);
        assertNotSafetySuspended(driver);
      } catch {
        return false;
      }
      return true;
    })();
    if (!passes || !(await moverFeeOperability(tx, payer, { missingRow: 'BLOCK' })).operable) return 'RETURNED_OFFLINE';
    const documents = await lockMoverDocuments(tx, userId, 'DRIVER');
    if (!documents.allowed) return 'RETURNED_OFFLINE';
    const online = await tx.$executeRaw`
      UPDATE "drivers" SET "isOnline" = true, "isAvailable" = true,
        "currentLat" = ${at.latitude}, "currentLng" = ${at.longitude},
        "lastLocationUpdate" = clock_timestamp(), "locationSessionId" = ${sessionId}, "updatedAt" = clock_timestamp()
      WHERE "id" = ${driver.id} AND "currentRideId" IS NULL AND ${documentDeadlineSql(documents)}`;
    return online === 1 ? 'RETURNED' : 'RETURNED_OFFLINE';
  });
}
