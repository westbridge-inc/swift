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

// ---------------------------------------------------------------------------
// [B3] Every live leg, each with an ETA that is TRUE for that customer.
//
// Since #899 a rider may carry more than one order. The straight-line answer
// for the second customer — "the rider is 6 minutes from you" — is a lie: the
// rider is going to finish the first delivery first. So the second leg's ETA
// is the CHAIN: rider → first leg's remaining stops → this leg's stops, summed
// hop by hop through the maps provider. It is labelled `after_current` so the
// screen can say so, and any hop the provider cannot price makes the whole leg
// null — no ETA beats a confidently wrong one [UI never lies].
//
// Hops are bounded: two legs cost at most four ETA calls on the throttled
// branch, and the un-throttled pings read the cache like before.
// ---------------------------------------------------------------------------

export type LegEtaBasis = 'direct' | 'after_current';
export interface LegEta { orderId: string; etaMinutes: number | null; basis: LegEtaBasis }

interface LegForEta {
  id: string;
  status: string;
  pickupLat: unknown; pickupLng: unknown;
  deliveryLat: unknown; deliveryLng: unknown;
}

function point(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  return lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
}

/** The stops a leg still has ahead of it: pickup (if not yet collected) then
 *  delivery. A leg with no usable coordinates contributes no stops and prices
 *  as null rather than as zero — zero would tell the next customer the rider
 *  is closer than anyone knows. */
export function remainingStops(leg: LegForEta): Array<{ lat: number; lng: number }> | null {
  const stops: Array<{ lat: number; lng: number }> = [];
  if (PICKUP_LEG.has(leg.status as never)) {
    const pickup = point(leg.pickupLat, leg.pickupLng);
    if (!pickup) return null;
    stops.push(pickup);
  }
  const drop = point(leg.deliveryLat, leg.deliveryLng);
  if (!drop) return null;
  stops.push(drop);
  return stops;
}

/**
 * ETAs for a rider's live legs IN ORDER. The first leg is direct (what
 * `computeActiveLegEta` has always answered); each later leg is the running
 * chain through every stop before it.
 */
export async function computeLegEtas(
  legs: LegForEta[],
  mover: { lat: number; lng: number },
): Promise<LegEta[]> {
  const provider = getMapsProvider();
  const out: LegEta[] = [];
  let origin: { lat: number; lng: number } | null = mover;
  let elapsed = 0;
  let chainBroken = false;
  for (const [i, leg] of legs.entries()) {
    const basis: LegEtaBasis = i === 0 ? 'direct' : 'after_current';
    const stops = remainingStops(leg);
    if (chainBroken || !stops || !origin) {
      out.push({ orderId: leg.id, etaMinutes: null, basis });
      chainBroken = true; // a hop nobody can price poisons every leg after it
      continue;
    }
    let legMinutes: number | null = 0;
    for (const stop of stops) {
      const [hop] = await provider.etaMinutes(origin, [stop]);
      if (typeof hop !== 'number' || !Number.isFinite(hop)) { legMinutes = null; break; }
      legMinutes += hop;
      origin = stop;
    }
    if (legMinutes == null) {
      out.push({ orderId: leg.id, etaMinutes: null, basis });
      chainBroken = true;
      continue;
    }
    elapsed += legMinutes;
    out.push({ orderId: leg.id, etaMinutes: Math.max(1, Math.round(elapsed)), basis });
  }
  return out;
}

/** Throttled-branch entry for the fan-out: recompute every leg and cache each
 *  under the per-order key the single-leg readers already use. Fire-and-caught. */
export async function refreshLegEtas(
  app: Pick<FastifyInstance, 'redis'>,
  legs: LegForEta[],
  mover: { lat: number; lng: number },
): Promise<LegEta[]> {
  try {
    const etas = await computeLegEtas(legs, mover);
    for (const e of etas) {
      if (e.etaMinutes != null) await app.redis.set(cacheKey(e.orderId), String(e.etaMinutes), 'EX', CACHE_TTL_SECONDS);
    }
    return etas;
  } catch {
    return legs.map((leg, i) => ({ orderId: leg.id, etaMinutes: null, basis: i === 0 ? 'direct' : 'after_current' }));
  }
}

/** Fast path for the un-throttled pings: last cached value per leg. */
export async function cachedLegEtas(
  app: Pick<FastifyInstance, 'redis'>,
  legs: Array<{ id: string }>,
): Promise<LegEta[]> {
  return Promise.all(legs.map(async (leg, i) => ({
    orderId: leg.id,
    etaMinutes: await cachedLegEta(app, leg.id),
    basis: (i === 0 ? 'direct' : 'after_current') as LegEtaBasis,
  })));
}
