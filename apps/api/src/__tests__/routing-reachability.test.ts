import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { probeRouting, getLastRoutingProbe, setLastRoutingProbe, PROBE_ORIGIN, PROBE_DEST } from '../providers/maps/routing-probe';
import type { LatLng, MapsProvider, RouteEstimate, MatchedRoute, TracePoint } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// [ROUTE-001] The routing engine was configured, unreachable, and silent.
//
// `.env.deploy.example` shipped MAPS_PROVIDER=osrm with
// OSRM_URL=http://osrm:5000. The API runs in compose project `swift`; the
// routing file set no project name, so its services landed in project `deploy`
// on a different network. `osrm` never resolved.
//
// Nothing errored. OsrmMapsProvider catches timeout, refusal, non-200 and
// unparseable body alike and returns HaversineMapsProvider's answer, so a
// deployment that believed it had road routing served STRAIGHT LINES for every
// fare, every ETA and every dispatch ranking — in a city split by a river you
// cross at one bridge.
//
// Two halves are guarded here: the topology has to resolve, and a topology
// that stops resolving has to be LOUD.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

const APP_COMPOSE = read('deploy/docker-compose.yml');
const ROUTING_COMPOSE = read('deploy/docker-compose.routing.yml');
const ENV_EXAMPLE = read('deploy/.env.deploy.example');
const APP_TS = readFileSync(join(process.cwd(), 'src/app.ts'), 'utf8');

/** Service keys declared in a compose file (two-space indented, before `volumes:`). */
function servicesOf(compose: string): string[] {
  const body = compose.slice(compose.indexOf('\nservices:'));
  const end = body.search(/\n(volumes|networks|configs|secrets):/);
  return [...(end === -1 ? body : body.slice(0, end)).matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((m) => m[1]!);
}

// A provider that answers like the real OSRM one: it never throws, it degrades.
function fakeMaps(source: RouteEstimate['source'], opts: { throws?: boolean } = {}): MapsProvider {
  return {
    async etaMinutes(_o: LatLng, d: LatLng[]) { return d.map(() => 5); },
    async etaMinutesFrom(o: LatLng[], _d: LatLng) { return o.map(() => 5); },
    async routeKm(): Promise<RouteEstimate> {
      if (opts.throws) throw new Error('connect ECONNREFUSED');
      return { km: 1.917, minutes: 3.3, source };
    },
    async matchTrace(_p: TracePoint[]): Promise<MatchedRoute> {
      return { km: 0, polyline: null, matched: false, source };
    },
  } as unknown as MapsProvider;
}

describe('[ROUTE-001] the probe reads the engine, not the configuration', () => {
  beforeEach(() => setLastRoutingProbe(null));

  it('osrm answering as osrm is ok', async () => {
    const v = await probeRouting(fakeMaps('osrm'), { MAPS_PROVIDER: 'osrm', OSRM_URL: 'http://osrm:5000' });
    expect(v.status).toBe('ok');
    expect(v).toMatchObject({ provider: 'osrm', km: 1.917 });
  });

  it('THE BUG: osrm configured but answering haversine is DEGRADED, not ok', async () => {
    // This is the exact production state — the provider is constructed, every
    // call silently falls back, and the only outward difference from a healthy
    // system is that every distance is wrong.
    const v = await probeRouting(fakeMaps('haversine'), { MAPS_PROVIDER: 'osrm', OSRM_URL: 'http://osrm:5000' });
    expect(v.status).toBe('degraded');
    if (v.status !== 'degraded') throw new Error('unreachable');
    // The message has to carry the URL, or the page cannot be acted on.
    expect(v.why).toContain('http://osrm:5000');
    expect(v.why).toMatch(/straight line/i);
  });

  it('names OSRM_URL as unset when it is, rather than printing "undefined"', async () => {
    const v = await probeRouting(fakeMaps('haversine'), { MAPS_PROVIDER: 'osrm' });
    expect(v.status).toBe('degraded');
    if (v.status !== 'degraded') throw new Error('unreachable');
    expect(v.why).toContain('unset');
  });

  it('a throw from routeKm is degraded, not a crashed boot', async () => {
    const v = await probeRouting(fakeMaps('osrm', { throws: true }), { MAPS_PROVIDER: 'osrm' });
    expect(v.status).toBe('degraded');
  });

  it('haversine is skipped — it is the configured answer, not a degradation', async () => {
    const v = await probeRouting(fakeMaps('haversine'), { MAPS_PROVIDER: 'haversine' });
    expect(v.status).toBe('skipped');
  });

  it('unset MAPS_PROVIDER is skipped (the default is haversine)', async () => {
    const v = await probeRouting(fakeMaps('haversine'), {});
    expect(v.status).toBe('skipped');
  });

  it('google is skipped, and the reason says why', async () => {
    // GoogleMapsProvider.routeKm delegates to the haversine fallback BY
    // CONSTRUCTION, so source would read `haversine` on a perfectly healthy
    // Google key. Probing it this way would cry wolf on every boot forever.
    const v = await probeRouting(fakeMaps('haversine'), { MAPS_PROVIDER: 'google' });
    expect(v.status).toBe('skipped');
    if (v.status !== 'skipped') throw new Error('unreachable');
    expect(v.why).toMatch(/does not report its own engine/);
  });

  it('the probe points at two real Georgetown coordinates inside the Guyana extract', () => {
    for (const p of [PROBE_ORIGIN, PROBE_DEST]) {
      expect(p.lat, 'latitude is outside Guyana').toBeGreaterThan(6.5);
      expect(p.lat, 'latitude is outside Guyana').toBeLessThan(7.1);
      expect(p.lng, 'longitude is outside Guyana').toBeGreaterThan(-58.4);
      expect(p.lng, 'longitude is outside Guyana').toBeLessThan(-57.9);
    }
    expect(PROBE_ORIGIN).not.toEqual(PROBE_DEST);
  });

  it('the verdict is readable after it is set, and starts null', () => {
    expect(getLastRoutingProbe()).toBeNull();
    setLastRoutingProbe({ status: 'ok', provider: 'osrm', km: 1.9 });
    expect(getLastRoutingProbe()).toMatchObject({ status: 'ok' });
  });
});

describe('[ROUTE-001] a degraded router must not take the API out of rotation', () => {
  it('routing is NOT one of the /health `checks` keys', () => {
    // /health computes `allOk` over Object.values(checks) and answers 503 when
    // any of them is not ok/starting — which the container probe and the load
    // balancer both read. Routing is DEGRADABLE: orders keep flowing on
    // haversine. Putting it in `checks` would convert a degraded platform into
    // a down one, which is the guard suppressing what it exists to protect.
    const assigned = [...APP_TS.matchAll(/checks\['([a-z]+)'\]\s*=/g)].map((m) => m[1]!);
    expect(assigned.length, 'no checks[...] assignments found — did /health move?').toBeGreaterThan(2);
    expect(new Set(assigned)).toEqual(new Set(['database', 'redis', 'worker']));
    expect(assigned).not.toContain('routing');
  });

  it('the verdict IS reported, in the detail payload', () => {
    expect(APP_TS).toMatch(/routing:\s*getLastRoutingProbe\(\)/);
  });
});

describe('[ROUTE-001] the deployed topology actually resolves', () => {
  it('the compose and env files were found', () => {
    expect(APP_COMPOSE.length).toBeGreaterThan(500);
    expect(ROUTING_COMPOSE.length).toBeGreaterThan(500);
    expect(ENV_EXAMPLE.length).toBeGreaterThan(500);
  });

  it('the app compose includes the routing stack, so they share one project and one network', () => {
    // Without this they are projects `swift` and `deploy` on separate
    // networks, and no service name crosses between them.
    expect(APP_COMPOSE).toMatch(/^include:/m);
    expect(APP_COMPOSE).toMatch(/docker-compose\.routing\.yml/);
  });

  it('OSRM_URL names a service that exists in the composed project', () => {
    const url = /^OSRM_URL=(\S+)/m.exec(ENV_EXAMPLE)?.[1];
    expect(url, 'OSRM_URL is not set in the example').toBeTruthy();
    const host = new URL(url!).hostname;
    const services = [...servicesOf(APP_COMPOSE), ...servicesOf(ROUTING_COMPOSE)];
    expect(services, 'no services parsed').toContain('osrm');
    expect(
      services,
      `OSRM_URL points at "${host}", which is not a service in this project — it will not resolve, and every route silently degrades to haversine`,
    ).toContain(host);
  });

  it('OSRM_URL uses the CONTAINER port, not the published host port', () => {
    // :5001 is the host publish for a developer's curl. Using it from the API
    // would leave the compose network and come back in — and on a host that
    // does not publish it, fail silently into haversine.
    const url = /^OSRM_URL=(\S+)/m.exec(ENV_EXAMPLE)![1]!;
    const port = new URL(url).port;
    const mapping = /"(\d+):(\d+)"/.exec(ROUTING_COMPOSE.slice(ROUTING_COMPOSE.indexOf('  osrm:')));
    expect(mapping, 'osrm publishes no port mapping to compare against').toBeTruthy();
    const [, hostPort, containerPort] = mapping!;
    expect(port, `OSRM_URL uses ${port}; the container listens on ${containerPort} and only publishes ${hostPort} to the host`).toBe(containerPort);
  });

  it('the env example does not point at a file that does not exist', () => {
    // It said "See deploy/docker-compose.osrm.yml", which was never a file.
    const referenced = [...ENV_EXAMPLE.matchAll(/deploy\/(docker-compose[a-z.-]*\.yml)/g)].map((m) => m[1]!);
    for (const f of new Set(referenced)) {
      expect(existsSync(join(ROOT, 'deploy', f)), `deploy/${f} is referenced but does not exist`).toBe(true);
    }
  });
});
