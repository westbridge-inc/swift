import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { osrmFallbackAlertPct, osrmFallbackMinCalls } from '../jobs/queue';
import { estimateDrivingDistance } from '../utils/distance';

/**
 * [C2 · WS-0.2] Routing degradation — what a silent OSRM fallback actually costs.
 *
 * `OsrmMapsProvider` degrades to the straight-line estimate whenever OSRM times
 * out, errors, or returns no route. That is correct: a routing outage must not
 * stop deliveries. But it is silent, and the error is not small — the whole
 * point of C2 is that fares, ETAs and dispatch ranking all read the same seam,
 * so straight-line distance makes all three wrong at once.
 *
 * Georgetown makes this concrete in a way an abstraction never does. The city
 * sits on the east bank of the Demerara; the west bank is a few kilometres
 * across the water and about twenty by road, because you go via the Demerara
 * Harbour Bridge. Straight-line distance does not know the river is there.
 */

// ── MEASURED, not assumed ───────────────────────────────────────────────────
// Live probe against the local OSRM container carrying the Guyana OSM extract,
// 2026-08-28: Stabroek Market → Vreed-en-Hoop.
//   road:       19.07 km / 19.9 min   (via the Demerara Harbour Bridge)
//   crow-flies:  5.17 km
// These are recorded here so the assertion below is anchored to a real road
// network rather than to a guess about one.
const STABROEK = { lat: 6.8137, lng: -58.1637 };
const VREED_EN_HOOP = { lat: 6.809, lng: -58.2103 };
const MEASURED_ROAD_KM = 19.07;

describe('the cost of straight-line distance, in Georgetown, in numbers', () => {
  it('prices a cross-river delivery at about a third of the real ride', () => {
    // estimateDrivingDistance is haversine × 1.3 — the "streets are never
    // straight lines" wiggle. A wiggle factor cannot model a river.
    const estimated = estimateDrivingDistance(
      STABROEK.lat,
      STABROEK.lng,
      VREED_EN_HOOP.lat,
      VREED_EN_HOOP.lng,
    );

    // ~6.7 km against a measured 19.07 km. The mover rides the bridge and is
    // paid for the crow. This is the defect C2 names, with a number on it.
    expect(estimated).toBeLessThan(MEASURED_ROAD_KM * 0.45);
    expect(estimated).toBeGreaterThan(0);

    const shortfall = 1 - estimated / MEASURED_ROAD_KM;
    expect(shortfall).toBeGreaterThan(0.55); // >55% of the distance unpaid
  });

  it('is honest that the wiggle factor is not a routing engine', () => {
    // Same-side-of-the-river trips are where haversine×1.3 is defensible, and
    // the contrast is the argument: the model is not uniformly bad, it is
    // catastrophically bad exactly where a river, a one-way system or a canal
    // sits between two points — which in Georgetown is most interesting pairs.
    const shortHop = estimateDrivingDistance(6.8013, -58.1553, 6.818, -58.131);
    expect(shortHop).toBeGreaterThan(0);
    expect(shortHop).toBeLessThan(MEASURED_ROAD_KM);
  });
});

describe('the fallback alarm reads a rate, not a lifetime ratio', () => {
  it('defaults to a threshold that means "materially degraded", not "one blip"', () => {
    expect(osrmFallbackAlertPct({})).toBe(25);
    expect(osrmFallbackMinCalls({})).toBe(20);
  });

  it('accepts an operator override inside sane bounds', () => {
    expect(osrmFallbackAlertPct({ OSRM_FALLBACK_ALERT_PCT: '50' })).toBe(50);
    expect(osrmFallbackMinCalls({ OSRM_FALLBACK_ALERT_MIN_CALLS: '5' })).toBe(5);
  });

  it('falls back rather than becoming NaN or a nonsense percentage', () => {
    // A percentage above 100 can never trip, which would disable the alarm
    // silently — the failure mode this whole cluster of work exists to end.
    for (const junk of ['', ' ', 'lots', '0', '101', '-5', '2.5', '25%']) {
      expect(osrmFallbackAlertPct({ OSRM_FALLBACK_ALERT_PCT: junk })).toBe(25);
    }
    for (const junk of ['', 'many', '0', '-1', '1.5']) {
      expect(osrmFallbackMinCalls({ OSRM_FALLBACK_ALERT_MIN_CALLS: junk })).toBe(20);
    }
  });
});

describe('the chain: the alarm is actually wired into the heartbeat', () => {
  const queue = readFileSync(join(process.cwd(), 'src/jobs/queue.ts'), 'utf8');

  /**
   * The alarm's OWN block — from its counter read to the end of its branch.
   *
   * Every assertion below runs against this slice rather than the whole file,
   * and that is load-bearing. The first version of this suite matched the whole
   * file, so a test claiming "the page names the consequence" was satisfied by
   * the explanatory COMMENT sixty lines above the page it was meant to guard:
   * mutating the actual message left it green. That is the standing
   * hazard-matching rule (match declarations, not prose) and the exact way the
   * drift09 gate bit its own comments the first time round.
   */
  const start = queue.indexOf('osrmOutcomeCounter.get()');
  const block = queue.slice(start, queue.indexOf('return;', start));

  it('slices a real block (guards the guard)', () => {
    expect(start).toBeGreaterThan(0);
    expect(block.length).toBeGreaterThan(200);
  });

  it('compares against the PREVIOUS sample and re-arms it', () => {
    // Reading the counter alone gives the ratio since process start, which
    // stays high for days after an outage is fixed and then gets ignored.
    // Both halves matter: reading the old value, and storing the new one.
    expect(block).toMatch(/const previous = lastOsrmTotals/);
    expect(block).toMatch(/lastOsrmTotals = totals/);
  });

  it('pages through the deduplicated ops rail, like the pool and DLQ alarms', () => {
    expect(block).toMatch(/opsPageOnce\(\s*ctx,\s*'osrm-fallback'/);
    expect(block).toContain('ops_osrm_fallback');
  });

  it('re-baselines instead of reporting nonsense when the counter resets', () => {
    // A process restart resets a Prometheus counter to zero; a naive delta then
    // goes negative and a negative rate is a lie in a new direction.
    expect(block).toMatch(/totals\.ok >= previous\.ok && totals\.fallback >= previous\.fallback/);
  });

  it('requires enough calls before a percentage means anything', () => {
    expect(block).toMatch(/calls >= osrmFallbackMinCalls\(\)/);
    expect(block).toMatch(/pct >= osrmFallbackAlertPct\(\)/);
  });

  it('does not swallow its own failure silently', () => {
    expect(block).toMatch(/catch \(err\)/);
    expect(block).toMatch(/ctx\.log\.warn/);
    expect(block).toMatch(/routing degradation paging is blind/);
  });

  it('names the consequence in the page body, not the metric', () => {
    // "swift_osrm_calls_total fallback ratio 0.4" tells an operator nothing at
    // 3am. What is wrong for customers right now is the message. Asserted on
    // the `body:` line specifically — see the block comment above.
    const body = block.split('\n').find((line) => line.includes('body:')) ?? '';
    expect(body).toMatch(/Fares, ETAs and dispatch ranking/);
    expect(body).toMatch(/crow-flies/);
  });
});

// ── The live probe ──────────────────────────────────────────────────────────
// Runs only when an OSRM host answers; skips silently otherwise, because CI has
// no routing container and a network-dependent red is a false alarm. Locally it
// is the thing that would catch the extract being re-imported wrong: if the
// road network changed enough that the bridge route moved materially, the
// number recorded above stopped being true and someone should know.
const OSRM_URL = process.env['OSRM_URL'] ?? 'http://localhost:5001';

async function osrmRouteKm(a: typeof STABROEK, b: typeof STABROEK): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const url = `${OSRM_URL.replace(/\/$/, '')}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { code?: string; routes?: Array<{ distance?: number }> };
    if (data.code !== 'Ok') return null;
    const metres = data.routes?.[0]?.distance;
    return metres == null ? null : metres / 1000;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

describe('live OSRM (skipped when no routing host answers)', () => {
  it('routes across the Demerara over real roads, not through the water', async () => {
    const km = await osrmRouteKm(STABROEK, VREED_EN_HOOP);
    if (km === null) {
      // No OSRM here. Not a failure — CI has none by design.
      expect(true).toBe(true);
      return;
    }
    // Within 25% of the recorded measurement. A wider drift means the extract
    // or the road network changed and MEASURED_ROAD_KM above is stale.
    expect(km).toBeGreaterThan(MEASURED_ROAD_KM * 0.75);
    expect(km).toBeLessThan(MEASURED_ROAD_KM * 1.25);
    // And the whole point: the engine disagrees with the straight line by a lot.
    expect(km).toBeGreaterThan(
      estimateDrivingDistance(STABROEK.lat, STABROEK.lng, VREED_EN_HOOP.lat, VREED_EN_HOOP.lng) * 2,
    );
  });
});
