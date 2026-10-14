import { LAUNCH_CITY } from '../../modules/review/gate';
import { withTimeout } from '../../utils/async-lifecycle';
import { isProduction } from '../../utils/runtime-mode';
import type { LatLng, MapsProvider } from './maps-provider';

export type RoutingProbe =
  | { status: 'skipped'; provider: string; why: string }
  | { status: 'ok'; provider: string; km: number }
  | { status: 'degraded'; provider: string; why: string };

// Public central Georgetown points inside the routing extract.
export const PROBE_ORIGIN: LatLng = LAUNCH_CITY;
export const PROBE_DEST: LatLng = { lat: 6.8149, lng: -58.1631 };
export const ROUTING_PROBE_TTL_MS = 30_000;
export const ROUTING_PROBE_TIMEOUT_MS = 1_500;

/** Ported from the routing-reachability probe: judge the engine's answer,
 * not a successful HTTP connection. Never expose URLs or thrown errors in
 * health output. A routing outage refuses new quotes; the rest of the API,
 * including safety endpoints, stays available. */
export async function probeRouting(
  maps: Pick<MapsProvider, 'routeKm'>,
  env: Record<string, string | undefined> = process.env,
): Promise<RoutingProbe> {
  const configured = env['MAPS_PROVIDER'] ?? 'haversine';
  const provider = ['osrm', 'google', 'haversine'].includes(configured) ? configured : 'unknown';
  if (provider !== 'osrm') {
    return isProduction(env)
      ? { status: 'degraded', provider, why: 'A road routing provider is required for production quotes.' }
      : { status: 'skipped', provider, why: 'Road routing is not configured in this environment.' };
  }
  try {
    const route = await withTimeout(maps.routeKm(PROBE_ORIGIN, PROBE_DEST), ROUTING_PROBE_TIMEOUT_MS, 'Road routing probe');
    if (route.source === 'osrm' && Number.isFinite(route.km) && route.km > 0) {
      return { status: 'ok', provider, km: route.km };
    }
  } catch {
    // The provider's refusal, an outage and an overdue probe are all degraded.
  }
  return { status: 'degraded', provider, why: 'Road routing is unavailable. New taxi and courier quotes cannot be priced.' };
}

/** One cache per app, shared by startup, health and readiness. Recheck after
 * a short TTL so both a later outage and recovery become visible. Concurrent
 * probe requests share one bounded operation rather than flooding OSRM. */
export function createRoutingProbe(
  maps: Pick<MapsProvider, 'routeKm'>,
  env: Record<string, string | undefined> = process.env,
): () => Promise<RoutingProbe> {
  let cached: { result: RoutingProbe; expiresAt: number } | undefined;
  let pending: Promise<RoutingProbe> | undefined;
  return () => {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.result);
    pending ??= probeRouting(maps, env).then((result) => {
      cached = { result, expiresAt: Date.now() + ROUTING_PROBE_TTL_MS };
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
