import type { Prisma, PrismaClient, VehicleType } from '@prisma/client';
import { carDeliveriesEnabled, isVehicleOffered } from '../../config/vehicle-classes';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { assertShiftLiveness } from '../safety/liveness.service';
import { assertNotSafetySuspended } from '../safety/incident.service';
import { assertMoverPushReady } from '../notification/mover-push-authority';
import { requireIdentityAuthority } from '../integrity/identity-review';
import { moverFeeOperability, moverFeePayer } from '../subscription/mover-fee-authority';
import { carDeliveryLivePreview, isCarDeliveryProfile, syncCarDeliveryProfile } from './car-deliveries';

// ---------------------------------------------------------------------------
// [CARS-DELIVER PR4] "Taxi + deliveries" supply: the offer gate and the claim's promotion, used only by the
// dispatch engine (car-deliveries.ts carries the set-up, the mirror and the claim's document verdict).
//
// [SECURITY review · PR4 HIGH, COORD 26 Oct] A promotion IS a delivery GO — the delivery profile goes online in
// the claim — so it runs the gates delivery GO runs, on the locked rows, and refuses (null, nothing written) if any
// fails: an active account (the claim's User lock), a profile photo, a vehicle Swift takes, no identity lock and a
// fresh selfie check where required (shiftLiveness) and no safety suspension — on the delivery profile AND on the
// taxi it rides on — a live push registration where required, the weekly fee (the payer's one fee, as delivery GO
// reads it) and, for an account with no fee row at all, identity authority. The documents are the claim's own
// (reserveRiderLeg: the delivery verdict and the taxi verdict on the same car, deadlines at the write).
//
// [Second pass, 27 Oct] The offer gate runs the SAME gate function (deliveryGoGates), plus the device session and
// delivery GO's own preview of the papers for a car, so a blocked profile is never even offered a card. The
// candidate SQL drops every state a column can show (identity lock, suspension, photo, account status and role).
//
// Identity authority is read here WITHOUT delivery GO's global identity lock: the claim already holds User and
// Order, and taking that advisory lock after them would invert the order every identity writer takes. In practice
// the read never decides: a taxi online on "taxi + deliveries" passed taxi GO, which requires a fee row.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Prisma.TransactionClient;

type GateRow = { lastLivenessPassAt: Date | null; livenessLockedAt: Date | null; safetySuspendedAt: Date | null };

/** The safety half of delivery GO, on one profile row. */
function safetyClear(row: GateRow): boolean {
  try {
    assertShiftLiveness(row);
    assertNotSafetySuspended(row);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delivery GO's gates for a delivery profile riding on its taxi: ONE function for the offer gate and the claim's
 * promotion, so the two cannot drift apart. A vehicle Swift takes; no identity lock, a fresh selfie check where
 * required and no safety suspension, on the delivery profile AND on the taxi; a profile photo; a live push
 * registration where required; identity authority for an account with no fee row at all; the weekly fee (the
 * payer's one fee, read as delivery GO reads it).
 */
async function deliveryGoGates(
  db: Db, userId: string, riderId: string, rider: GateRow & { vehicleType: VehicleType }, taxi: GateRow,
): Promise<boolean> {
  if (!isVehicleOffered(rider.vehicleType) || !safetyClear(rider) || !safetyClear(taxi)) return false;
  const account = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { selfieCapturedAt: true } });
  if (!account.selfieCapturedAt) return false;
  try {
    await assertMoverPushReady(db as Tx, userId);
  } catch {
    return false;
  }
  const feeRows = await db.subscription.count({ where: { OR: [{ riderId }, { driver: { userId } }] } });
  if (feeRows === 0) {
    try {
      await requireIdentityAuthority(db, userId);
    } catch {
      return false;
    }
  }
  return (await moverFeeOperability(db, await moverFeePayer(db, userId), { missingRow: 'GRANDFATHER' })).operable;
}

/** A delivery profile's live legs, counted from the orders table (the one truth). */
async function liveLegs(db: Db, riderId: string): Promise<number> {
  return db.order.count({ where: { riderId, status: { notIn: [...TERMINAL_ORDER_STATUSES] } } });
}

/**
 * canReceiveOffer's answer for a delivery profile that is NOT online itself: may it still receive a delivery offer
 * because its taxi is online, free and on "taxi + deliveries"? Only while the switch is on, never with a live
 * delivery leg (one job at a time), on the taxi's live device session, through delivery GO's gates (deliveryGoGates,
 * the promotion's own) and delivery GO's preview of the papers for a car (the taxi verdict on the car the taxi
 * profile names; the claim re-derives both verdicts under its locks).
 */
export async function canTakeDeliveryFromTaxi(db: Db, riderId: string): Promise<boolean> {
  if (!carDeliveriesEnabled()) return false;
  const rider = await db.rider.findUnique({
    where: { id: riderId },
    select: { userId: true, vehicleType: true, isOnline: true, lastLivenessPassAt: true, livenessLockedAt: true, safetySuspendedAt: true },
  });
  if (!rider || rider.isOnline || !isCarDeliveryProfile(rider.vehicleType)) return false;
  const taxi = await db.driver.findFirst({
    where: {
      userId: rider.userId, takesDeliveries: true, deliveryCardsCapable: true, isOnline: true, isAvailable: true, currentRideId: null,
      locationSessionId: { not: null }, user: { status: 'ACTIVE', activeRole: { in: ['MOVER', 'DRIVER'] } },
    },
    select: { locationSessionId: true, lastLivenessPassAt: true, livenessLockedAt: true, safetySuspendedAt: true },
  });
  if (!taxi?.locationSessionId || (await liveLegs(db, riderId)) > 0) return false;
  const liveSession = await db.session.count({ where: { id: taxi.locationSessionId, userId: rider.userId, expiresAt: { gt: new Date() } } });
  if (liveSession !== 1 || !(await deliveryGoGates(db, rider.userId, riderId, rider, taxi))) return false;
  try {
    return await carDeliveryLivePreview(db, rider.userId);
  } catch {
    return false;
  }
}

/**
 * The delivery claim (claimOrder, RIDER pool) for an account whose taxi is online on "taxi + deliveries": PROMOTE
 * the delivery profile inside the claim's transaction, after its User and Order locks (then Rider, then Driver):
 * delivery GO's gates on the locked rows (above), then the car re-synced from the taxi profile, taxi supply retired,
 * the delivery profile online on the taxi's device session and position, marked to return to taxi work, and the
 * work app -> deliveries. Returns the retired taxi profile's id, or null when this is not such a claim or a gate
 * fails (the claim then refuses as before, nothing written). If anything later in the claim refuses, the whole
 * transaction — this promotion with it — rolls back.
 */
export async function promoteDeliveryFromTaxi(tx: Tx, userId: string, riderId: string): Promise<{ driverId: string } | null> {
  if (!carDeliveriesEnabled()) return null;
  const riders = await tx.$queryRaw<Array<GateRow & { userId: string; vehicleType: VehicleType; isOnline: boolean }>>`
    SELECT "userId", "vehicleType", "isOnline", "lastLivenessPassAt", "livenessLockedAt", "safetySuspendedAt"
    FROM "riders" WHERE "id" = ${riderId} FOR UPDATE`;
  const rider = riders[0];
  if (!rider || rider.userId !== userId || rider.isOnline || !isCarDeliveryProfile(rider.vehicleType)) return null;
  const drivers = await tx.$queryRaw<Array<GateRow & {
    id: string; takesDeliveries: boolean; deliveryCardsCapable: boolean; isOnline: boolean; isAvailable: boolean; currentRideId: string | null;
    locationSessionId: string | null; currentLat: number | null; currentLng: number | null; lastLocationUpdate: Date | null;
  }>>`
    SELECT "id", "takesDeliveries", "deliveryCardsCapable", "isOnline", "isAvailable", "currentRideId", "locationSessionId",
           "currentLat", "currentLng", "lastLocationUpdate", "lastLivenessPassAt", "livenessLockedAt", "safetySuspendedAt"
    FROM "drivers" WHERE "userId" = ${userId} FOR UPDATE`;
  const taxi = drivers[0];
  if (!taxi || !taxi.takesDeliveries || !taxi.deliveryCardsCapable || !taxi.isOnline || !taxi.isAvailable || taxi.currentRideId
    || !taxi.locationSessionId || taxi.currentLat == null || taxi.currentLng == null) return null;

  // Delivery GO's gates, on the locked rows (the offer gate's own).
  if (!(await deliveryGoGates(tx, userId, riderId, rider, taxi))) return null;

  const sessions = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "sessions" WHERE "id" = ${taxi.locationSessionId} AND "userId" = ${userId} AND "expiresAt" > NOW() FOR SHARE`;
  if (!sessions[0]) return null;
  if ((await liveLegs(tx, riderId)) > 0) return null;
  await syncCarDeliveryProfile(tx, userId);
  await tx.$executeRaw`
    UPDATE "drivers" SET "isOnline" = false, "isAvailable" = false, "locationSessionId" = NULL, "updatedAt" = clock_timestamp()
    WHERE "id" = ${taxi.id}`;
  await tx.$executeRaw`
    UPDATE "riders" SET "isOnline" = true, "isAvailable" = true, "locationSessionId" = ${taxi.locationSessionId},
      "currentLat" = ${taxi.currentLat}, "currentLng" = ${taxi.currentLng}, "lastLocationUpdate" = ${taxi.lastLocationUpdate},
      "returnsToTaxi" = true, "updatedAt" = clock_timestamp()
    WHERE "id" = ${riderId}`;
  await tx.user.update({ where: { id: userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } });
  return { driverId: taxi.id };
}
