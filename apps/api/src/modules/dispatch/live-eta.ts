import type { FastifyInstance } from 'fastify';
import { getMapsProvider } from '../../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// Live ETA for a mover's ACTIVE leg [SWIFT-UG-RT-01].
//
// The tracking screens already stream the mover's position over the per-order
// socket room; the missing half of "Uber-grade tracking" is an ETA that moves
// with them. The maps provider is only consulted on the location route's
// throttled (≥10 s) branch — the same discipline as the DB write — and the
// result is cached in Redis so every intermediate ping can still attach the
// latest value to its socket payload for free.
//
// Everything here is display-layer: callers treat failures as "no ETA"
// (null), never as an error — an ETA must never fail a location ping, and no
// contractual timer reads from this (the server's own timers stay the truth).
// ---------------------------------------------------------------------------

/** Statuses where the mover is still heading TO the pickup point. Terminal
 *  and pre-assignment states never reach here (the location routes only call
 *  with an ACTIVE currentOrderId / currentRideId). Everything else with
 *  delivery coordinates is the dropoff leg. */
const PICKUP_LEG = new Set([
  // delivery legs (rider)
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'RIDER_ASSIGNED',
  'RIDER_EN_ROUTE_PICKUP',
  'RIDER_ARRIVED_PICKUP',
  // taxi legs (driver)
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
]);

const CACHE_TTL_SECONDS = 60;

const cacheKey = (orderId: string) => `mover:eta:${orderId}`;

/** Compute the ETA (minutes) from the mover's position to its active-leg
 *  target. Returns null when the order/coords are missing. */
export async function computeActiveLegEta(
  app: Pick<FastifyInstance, 'prisma'>,
  orderId: string,
  mover: { lat: number; lng: number },
): Promise<number | null> {
  const order = await app.prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, pickupLat: true, pickupLng: true, deliveryLat: true, deliveryLng: true },
  });
  if (!order) return null;

  const toPickup = PICKUP_LEG.has(order.status);
  const target = toPickup
    ? order.pickupLat != null && order.pickupLng != null
      ? { lat: Number(order.pickupLat), lng: Number(order.pickupLng) }
      : null
    : order.deliveryLat != null && order.deliveryLng != null
      ? { lat: Number(order.deliveryLat), lng: Number(order.deliveryLng) }
      : null;
  if (!target) return null;

  const [eta] = await getMapsProvider().etaMinutes(mover, [target]);
  return typeof eta === 'number' && Number.isFinite(eta) ? Math.max(1, Math.round(eta)) : null;
}

/** Throttled-branch entry: recompute + cache. Fire-and-caught by design. */
export async function refreshLegEta(
  app: Pick<FastifyInstance, 'prisma' | 'redis'>,
  orderId: string,
  mover: { lat: number; lng: number },
): Promise<number | null> {
  try {
    const eta = await computeActiveLegEta(app, orderId, mover);
    if (eta != null) {
      await app.redis.set(cacheKey(orderId), String(eta), 'EX', CACHE_TTL_SECONDS);
    }
    return eta;
  } catch {
    return null; // display-layer: no ETA beats a failed ping
  }
}

/** Fast-path entry for the un-throttled pings: last cached value or null. */
export async function cachedLegEta(
  app: Pick<FastifyInstance, 'redis'>,
  orderId: string,
): Promise<number | null> {
  try {
    const v = await app.redis.get(cacheKey(orderId));
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
