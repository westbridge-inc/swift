import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { backlogNear, CAPACITY_RADIUS_KM } from './delivery-capacity';
import { dispatchOfferKey } from './dispatch-generation-keys';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [RIDER-SAFE 3 · COORD ruling 29 Oct 2026] A RIDER FREES UP: THE OLDEST
// WAITING ORDER NEAR THEM IS OFFERED FIRST.
//
// Between sweeps a waiting order sat for up to 90 s (a minute in the slow
// lane) while a rider who had just come online, or just handed over a bag,
// stood idle beside it. Now going online and finishing a delivery each ask
// dispatch to run again for the oldest waiting orders near that rider — in
// age order, the oldest first — instead of waiting for the next sweep.
//
// It only ENQUEUES the ordinary `dispatch-order` job: the offer, its ranking,
// every gate and the one-live-offer-per-order rule stay dispatch's own. An
// order that already has a live offer is skipped (dispatch would no-op). The
// job id is bucketed per order per KICK_BUCKET_MS, so a dozen riders coming
// online in the same moment ask once, not twelve times.
// ---------------------------------------------------------------------------

/** How many waiting orders one freed rider wakes, oldest first. */
export const KICK_LIMIT = 3;
const KICK_BUCKET_MS = 15_000;

export type KickEnqueue = (orderId: string, opts: { jobId: string; priority: number }) => Promise<void>;

export async function kickWaitingOrdersNear(
  deps: { prisma: PrismaClient; redis: Pick<Redis, 'get'>; enqueue: KickEnqueue },
  riderId: string,
  now = new Date(),
): Promise<string[]> {
  try {
    const rider = await deps.prisma.rider.findUnique({
      where: { id: riderId },
      select: { isOnline: true, isAvailable: true, currentLat: true, currentLng: true, user: { select: { tenantId: true } } },
    });
    if (!rider?.isOnline || !rider.isAvailable || rider.currentLat == null || rider.currentLng == null) return [];
    const waiting = await backlogNear(deps.prisma, { lat: rider.currentLat, lng: rider.currentLng }, rider.user.tenantId, CAPACITY_RADIUS_KM, now);
    const kicked: string[] = [];
    for (const order of waiting) {
      if (kicked.length >= KICK_LIMIT) break;
      if (await deps.redis.get(dispatchOfferKey(order.id))) continue; // a live offer: dispatch owns it
      const bucket = Math.floor(now.getTime() / KICK_BUCKET_MS);
      await deps.enqueue(order.id, { jobId: `supply-kick-${order.id}-${bucket}`, priority: kicked.length + 1 });
      kicked.push(order.id);
    }
    return kicked;
  } catch (err) {
    // Never fail a rider's go-online or handover over a courtesy re-sweep.
    log().warn({ err, riderId }, 'supply-kick: waiting orders were not re-swept');
    return [];
  }
}
