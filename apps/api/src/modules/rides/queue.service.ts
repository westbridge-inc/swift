import type { PrismaClient, RideQueueEntry, RideClass } from '@prisma/client';
import { Prisma } from '@prisma/client';

import type { DispatchService } from '../dispatch/dispatch.service';
import type { FareService } from './fare.service';
import type { NotificationService } from '../notification/notification.service';
import { createRideRequest, type RideRequestApp } from './rides.service';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// The 5.5B ride queue (rides spec): position is DERIVED (createdAt FIFO among
// WAITING), the 2-min supply scan claims the head via CAS and auto-requests
// through the SAME core the request route uses, and TTL expiry pushes a
// re-request deep link once. Counts are coarse and honest — never positions.
// ---------------------------------------------------------------------------

/** TTL for a queue entry, minutes. Env-tunable per market. */
export const RIDE_QUEUE_TTL_MIN = () => {
  const n = Number(process.env['RIDE_QUEUE_TTL_MIN'] ?? 30);
  return Number.isFinite(n) && n >= 1 ? n : 30;
};

/** Kill switch (standing order: every new loop has one). '1' disables the
 *  scan; endpoints keep working so entries just wait. */
const queueScanDisabled = () => process.env['RIDE_QUEUE_DISABLED'] === '1';

/** How many auto-requests one scan may fire — a courtesy loop, not a flood.
 *  A driver freed rarely means N drivers freed; the next scan is 2 min away. */
const SCAN_AUTO_REQUEST_CAP = Number(process.env['RIDE_QUEUE_SCAN_CAP'] ?? 5);

const BASE_RADIUS_KM = 8;

/**
 * Coarse supply counts near a point for the honest 5.5A copy ("2 drivers
 * online — both on trips"). Uses the driver rows' own live flags inside the
 * same base radius dispatch pings; no identities, no positions leave the
 * server. online = on shift; busy = online but not available (on a trip).
 */
export async function getSupplySnapshot(
  prisma: PrismaClient,
  point: { lat: number; lng: number },
): Promise<{ online: number; busy: number }> {
  const rows = await prisma.$queryRaw<{ online: bigint; busy: bigint }[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE d."isOnline")                          AS online,
      COUNT(*) FILTER (WHERE d."isOnline" AND NOT d."isAvailable")  AS busy
    FROM drivers d
    WHERE d."currentLat" IS NOT NULL
      AND d."currentLng" IS NOT NULL
      AND (
        6371 * acos(
          LEAST(1.0,
            cos(radians(${point.lat})) * cos(radians(d."currentLat")) *
            cos(radians(d."currentLng") - radians(${point.lng})) +
            sin(radians(${point.lat})) * sin(radians(d."currentLat"))
          )
        )
      ) <= ${BASE_RADIUS_KM}
  `);
  const r = rows[0];
  return { online: Number(r?.online ?? 0), busy: Number(r?.busy ?? 0) };
}

/** The client-facing queue status: derived position + honest counts. */
export async function queueStatusFor(
  prisma: PrismaClient,
  dispatch: DispatchService,
  entry: RideQueueEntry,
): Promise<{
  id: string;
  position: number;
  joinedAt: string;
  expiresAt: string;
  suppliersOnline: number;
  suppliersBusy: number;
}> {
  const ahead = await prisma.rideQueueEntry.count({
    where: { status: 'WAITING', expiresAt: { gt: new Date() }, createdAt: { lt: entry.createdAt } },
  });
  const snapshot = await getSupplySnapshot(prisma, { lat: entry.pickupLat, lng: entry.pickupLng });
  return {
    id: entry.id,
    position: ahead + 1,
    joinedAt: entry.createdAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString(),
    suppliersOnline: snapshot.online,
    suppliersBusy: snapshot.busy,
  };
}

/**
 * The queue scan — rides the same 2-min cadence as the supply watch:
 * 1) EXPIRY sweep: WAITING past TTL → EXPIRED (CAS) + ONE re-request push
 *    with the trip in the payload (deep-link prefill; S-48).
 * 2) MATCH sweep: WAITING, FIFO; per entry, the availability read dispatch
 *    itself uses; supply present → CAS-claim WAITING→MATCHED, then create the
 *    ride through the real request core. Failure rolls the claim back
 *    (except RIDE_IN_PROGRESS — they already have a ride → LEFT).
 */
export async function scanRideQueue(
  app: RideRequestApp,
  fareService: FareService,
  dispatch: DispatchService,
  notifications: NotificationService,
  cap = 50,
): Promise<{ expired: number; matched: number }> {
  if (queueScanDisabled()) return { expired: 0, matched: 0 };
  const prisma = app.prisma;
  const now = new Date();

  // ---- 1) expiry sweep ----
  let expired = 0;
  const dead = await prisma.rideQueueEntry.findMany({
    where: { status: 'WAITING', expiresAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: cap,
  });
  for (const e of dead) {
    const claimed = await prisma.rideQueueEntry.updateMany({
      where: { id: e.id, status: 'WAITING' },
      data: { status: 'EXPIRED', expiredNotifiedAt: now },
    });
    if (claimed.count === 0) continue;
    expired += 1;
    await notifications
      .send({
        userId: e.customerId,
        type: 'ORDER_UPDATE',
        title: `Still need a ride to ${e.dropoffAddress}?`,
        body: 'Your place in line timed out. Tap to request again — one tap, same trip.',
        audience: 'customer',
        data: {
          kind: 'ride_queue_expired',
          pickup: { lat: e.pickupLat, lng: e.pickupLng, address: e.pickupAddress },
          dropoff: { lat: e.dropoffLat, lng: e.dropoffLng, address: e.dropoffAddress },
          rideClass: e.rideClass,
          passengerCount: e.passengerCount,
        },
      })
      .catch(() => {});
  }

  // ---- 2) match sweep (FIFO) ----
  let matched = 0;
  const waiting = await prisma.rideQueueEntry.findMany({
    where: { status: 'WAITING', expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    take: cap,
  });

  // Per-area budget: one freed driver must not be chased by every queued
  // entry in the same neighbourhood in one sweep. A ~2km cell's budget comes
  // from the availability bucket itself (LOW ⇒ 1, GOOD ⇒ 3); the next scan
  // re-reads reality two minutes later.
  const cellBudget = new Map<string, number>();
  const cellOf = (lat: number, lng: number) => `${Math.round(lat / 0.02)}:${Math.round(lng / 0.02)}`;

  for (const e of waiting) {
    if (matched >= SCAN_AUTO_REQUEST_CAP) break;

    const cell = cellOf(e.pickupLat, e.pickupLng);
    if ((cellBudget.get(cell) ?? 1) <= 0) continue;

    const supply = await dispatch.getAvailability('DRIVER', { lat: e.pickupLat, lng: e.pickupLng });
    if (supply.level === 'NONE') continue;
    if (!cellBudget.has(cell)) cellBudget.set(cell, supply.level === 'GOOD' ? 3 : 1);
    if ((cellBudget.get(cell) ?? 0) <= 0) continue;

    // Claim FIRST (CAS) so a racing scan can't double-request the same entry.
    const claimed = await prisma.rideQueueEntry.updateMany({
      where: { id: e.id, status: 'WAITING' },
      data: { status: 'MATCHED' },
    });
    if (claimed.count === 0) continue;

    try {
      const { order } = await createRideRequest(
        app,
        fareService,
        dispatch,
        e.customerId,
        {
          pickup: { lat: e.pickupLat, lng: e.pickupLng },
          dropoff: { lat: e.dropoffLat, lng: e.dropoffLng },
          pickupAddress: e.pickupAddress,
          dropoffAddress: e.dropoffAddress,
          passengerCount: e.passengerCount,
          rideClass: e.rideClass as RideClass,
        },
        false, // the scan just read supply — no availability pre-check race
      );
      await prisma.rideQueueEntry.update({ where: { id: e.id }, data: { matchedOrderId: order.id } });
      matched += 1;
      cellBudget.set(cell, (cellBudget.get(cell) ?? 1) - 1);
      await notifications
        .send({
          userId: e.customerId,
          type: 'ORDER_UPDATE',
          title: 'A driver freed up — your ride is requested',
          body:
            supply.nearestEtaMinutes != null
              ? `Heading to ${e.dropoffAddress}. The nearest driver is about ${supply.nearestEtaMinutes} min away.`
              : `Heading to ${e.dropoffAddress}. Finding your driver now.`,
          audience: 'customer',
          data: { kind: 'ride_queue_matched', orderId: order.id },
        })
        .catch(() => {});
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'RIDE_IN_PROGRESS') {
        // They already have a ride — the queue entry is obsolete, not failed.
        await prisma.rideQueueEntry
          .updateMany({ where: { id: e.id, status: 'MATCHED' }, data: { status: 'LEFT' } })
          .catch(() => {});
      } else {
        // Anything else (fare hiccup, gate change, supply flap): roll the
        // claim back and let the next scan retry until TTL says stop.
        await prisma.rideQueueEntry
          .updateMany({ where: { id: e.id, status: 'MATCHED' }, data: { status: 'WAITING' } })
          .catch(() => {});
        log().warn({ entryId: e.id, code }, 'ride queue: auto-request failed, entry back to WAITING');
      }
    }
  }

  return { expired, matched };
}

// ---------------------------------------------------------------------------
// Coarse presence (rides spec 5.1/6.2) — the honest "map is alive" read.
// ---------------------------------------------------------------------------

const PRESENCE_CAP = 12;
const PRESENCE_RADIUS_KM = 5;
/** ~100m of deterministic jitter: stable per driver per 5-minute bucket so a
 *  refetch never makes parked cars dance, yet true positions never leave the
 *  server. */
function jitter(id: string, now = Date.now()): { dLat: number; dLng: number } {
  const bucket = Math.floor(now / 300_000);
  let h = 2166136261;
  const seed = `${id}:${bucket}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const angle = ((h >>> 8) % 360) * (Math.PI / 180);
  const meters = 40 + ((h >>> 3) % 80); // 40–120m off the true point
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng = (meters * Math.sin(angle)) / (111_320 * Math.cos((6.8 * Math.PI) / 180));
  return { dLat, dLng };
}

export async function presenceNear(
  prisma: PrismaClient,
  point: { lat: number; lng: number },
): Promise<{ lat: number; lng: number }[]> {
  const rows = await prisma.$queryRaw<{ id: string; lat: number; lng: number }[]>(Prisma.sql`
    SELECT d."id", d."currentLat" AS lat, d."currentLng" AS lng
    FROM drivers d
    WHERE d."isOnline" AND d."isAvailable"
      AND d."currentLat" IS NOT NULL AND d."currentLng" IS NOT NULL
      AND (
        6371 * acos(
          LEAST(1.0,
            cos(radians(${point.lat})) * cos(radians(d."currentLat")) *
            cos(radians(d."currentLng") - radians(${point.lng})) +
            sin(radians(${point.lat})) * sin(radians(d."currentLat"))
          )
        )
      ) <= ${PRESENCE_RADIUS_KM}
    LIMIT ${PRESENCE_CAP}
  `);
  return rows.map((r) => {
    const j = jitter(r.id);
    return { lat: Number(r.lat) + j.dLat, lng: Number(r.lng) + j.dLng };
  });
}
