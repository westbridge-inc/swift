import { LAUNCH_CITY } from '../../modules/review/gate';
import type { LatLng, MapsProvider } from './maps-provider';

/**
 * [ROUTE-001] Does the configured routing engine actually answer?
 *
 * `OsrmMapsProvider` catches every failure — timeout, refused connection, a
 * 500, an unparseable body — and returns `HaversineMapsProvider`'s answer
 * instead. That is the right runtime behaviour: a fare must not fail because a
 * routing container restarted. But it means a PERMANENTLY misconfigured OSRM is
 * indistinguishable, from the outside, from `MAPS_PROVIDER=haversine`.
 *
 * That is not hypothetical. `deploy/.env.deploy.example` shipped
 * `MAPS_PROVIDER=osrm` with `OSRM_URL=http://osrm:5000` while the routing
 * services ran in a different compose project on a different network, so the
 * name never resolved. Every fare, every ETA and every dispatch ranking was
 * computed on straight lines, and nothing anywhere said so. In Georgetown the
 * Demerara splits the city and you cross at one bridge: a 2 km straight line
 * can be a 15 km drive.
 *
 * So the probe asks the provider for a real route between two real Georgetown
 * points and reads `RouteEstimate.source` — the field the provider already
 * sets honestly. If the answer says `haversine` while the configuration says
 * `osrm`, the engine is not being reached, whatever the reason.
 *
 * It runs ONCE, after listen. It never blocks boot and never fails readiness:
 * routing is degradable, and a guard that takes the platform down for a
 * degradable dependency is a worse outage than the one it reports.
 */

export type RoutingProbe =
  | { status: 'skipped'; provider: string; why: string }
  | { status: 'ok'; provider: string; km: number }
  | { status: 'degraded'; provider: string; why: string };

/** Two real points in central Georgetown, ~1.9 km apart — both inside the
 *  Guyana extract OSRM is built from, so a healthy engine always routes them. */
export const PROBE_ORIGIN: LatLng = LAUNCH_CITY;
export const PROBE_DEST: LatLng = { lat: 6.8149, lng: -58.1631 };

/**
 * Google is deliberately not probed this way: `GoogleMapsProvider.routeKm`
 * delegates to the haversine fallback by construction, so `source` would say
 * `haversine` on a perfectly healthy Google key and the probe would cry wolf
 * forever. OSRM is the launch standard (see .env.deploy.example) and the only
 * provider whose routeKm reports its own engine.
 */
export async function probeRouting(
  maps: MapsProvider,
  env: Record<string, string | undefined> = process.env,
): Promise<RoutingProbe> {
  const provider = env['MAPS_PROVIDER'] ?? 'haversine';
  if (provider !== 'osrm') {
    return {
      status: 'skipped',
      provider,
      why: provider === 'haversine'
        ? 'MAPS_PROVIDER=haversine — straight-line distance is the configured answer, not a degradation'
        : `MAPS_PROVIDER=${provider} does not report its own engine in RouteEstimate.source`,
    };
  }

  let result;
  try {
    result = await maps.routeKm(PROBE_ORIGIN, PROBE_DEST);
  } catch (err) {
    // routeKm is not supposed to throw — it degrades. If it threw, something
    // is wrong in a way the fallback did not cover, and that is worth saying.
    return { status: 'degraded', provider, why: `routeKm threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.source === 'osrm') return { status: 'ok', provider, km: result.km };
  return {
    status: 'degraded',
    provider,
    why: `MAPS_PROVIDER=osrm but the route came back source=${result.source} — OSRM_URL (${env['OSRM_URL'] ?? 'unset'}) is not reachable, so every fare, ETA and dispatch ranking is a straight line`,
  };
}

/** The last verdict this process computed, for /health to report. */
let last: RoutingProbe | null = null;
export function getLastRoutingProbe(): RoutingProbe | null { return last; }
export function setLastRoutingProbe(p: RoutingProbe | null): void { last = p; }
