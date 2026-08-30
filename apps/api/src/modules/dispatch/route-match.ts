import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { getMapsProvider, type MapsProvider } from '../../providers/maps/maps-provider';
import { recentTrace, traceKey } from './gps-plausibility';
import { cleanTrace } from './trace-cleaner';
import { log } from '../../utils/logger';

/**
 * [ALG-16] Match one completed delivery's trace to the road graph and freeze
 * the result on the order — once, for money purposes. ALG-18 keeps pricing
 * the customer on the PLANNED distance; this is the ACTUAL, recorded beside
 * it for the day rider earnings may use it where a detour was Swift's doing.
 *
 * Idempotent (a matched order is left alone), bounded (only fixes between
 * acceptance and completion), and honest: no trace means no match, recorded
 * as exactly that rather than a straight line pretending to be a route.
 */
export type RouteMatchOutcome = 'matched' | 'unmatched' | 'already' | 'no-trace' | 'no-order' | 'not-complete';

export async function matchOrderRoute(
  deps: { prisma: PrismaClient; redis: Redis; maps?: MapsProvider },
  orderId: string,
): Promise<{ outcome: RouteMatchOutcome; km?: number; source?: string; points?: number; dropped?: number }> {
  const order = await deps.prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, riderId: true, driverId: true, orderType: true, acceptedAt: true, deliveredAt: true, updatedAt: true, status: true, routeMatchedAt: true },
  });
  if (!order) return { outcome: 'no-order' };
  if (order.routeMatchedAt) return { outcome: 'already' };
  if (!['DELIVERED', 'COMPLETED'].includes(order.status)) return { outcome: 'not-complete' };
  // deliveredAt is the handover moment; a COMPLETED pickup/ride has only its last update.
  const completedAt = order.deliveredAt ?? order.updatedAt;
  const pool = order.orderType === 'TAXI' ? 'DRIVER' : 'RIDER';
  const moverId = pool === 'DRIVER' ? order.driverId : order.riderId;
  if (!moverId) return { outcome: 'no-trace' };

  const since = (order.acceptedAt ?? completedAt).getTime() - 60_000;
  const raw = (await recentTrace(deps.redis, traceKey(pool, moverId), since)).filter((f) => f.at <= completedAt.getTime() + 60_000);
  if (raw.length < 2) return { outcome: 'no-trace' };

  const cleaned = cleanTrace(raw);
  if (cleaned.points.length < 2) return { outcome: 'no-trace' };
  const maps = deps.maps ?? getMapsProvider();
  const matched = await maps.matchTrace(cleaned.points);
  await deps.prisma.order.update({
    where: { id: orderId },
    data: {
      routeMatchedKm: Math.round(matched.km * 100) / 100,
      routePolyline: matched.polyline,
      routeMatchSource: matched.matched ? matched.source : `${matched.source}:unmatched`,
      routeMatchedAt: new Date(),
    },
  });
  log().info({ orderId, km: matched.km, matched: matched.matched, points: cleaned.points.length, dropped: cleaned.dropped }, 'route-match: frozen');
  return { outcome: matched.matched ? 'matched' : 'unmatched', km: matched.km, source: matched.source, points: cleaned.points.length, dropped: cleaned.dropped };
}
