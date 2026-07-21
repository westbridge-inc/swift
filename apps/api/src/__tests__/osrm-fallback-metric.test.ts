import { describe, it, expect, beforeEach } from 'vitest';
import { OsrmMapsProvider } from '../providers/maps/maps-provider';
import { osrmOutcomeCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// SWIFT-UG-ETA-01 — when OSRM is configured but unreachable, the provider
// silently degrades to haversine. This pins that every degrade path bumps the
// fallback counter so "is OSRM actually up?" is observable (fallback / total).
// The provider points at an unroutable host so every call fails fast into the
// fallback; a genuine 'ok' can't be asserted without a live OSRM.
// ---------------------------------------------------------------------------

async function fallbackCount(op: 'eta' | 'route'): Promise<number> {
  const metric = await osrmOutcomeCounter.get();
  const s = metric.values.find((v) => v.labels['op'] === op && v.labels['outcome'] === 'fallback');
  return s?.value ?? 0;
}

describe('OSRM fallback metric [SWIFT-UG-ETA-01]', () => {
  // Unroutable base URL → every OSRM call errors into the haversine fallback.
  const provider = new OsrmMapsProvider('http://127.0.0.1:0');

  beforeEach(() => {
    osrmOutcomeCounter.reset();
  });

  it('an ETA fallback still returns a number AND counts the degrade', async () => {
    const before = await fallbackCount('eta');
    const etas = await provider.etaMinutes({ lat: 6.8, lng: -58.15 }, [{ lat: 6.81, lng: -58.16 }]);
    expect(etas).toHaveLength(1);
    expect(typeof etas[0]).toBe('number'); // haversine kept the caller working
    expect(await fallbackCount('eta')).toBe(before + 1);
  });

  it('a routeKm fallback still returns km AND counts the degrade', async () => {
    const before = await fallbackCount('route');
    const route = await provider.routeKm({ lat: 6.8, lng: -58.15 }, { lat: 6.81, lng: -58.16 });
    expect(route.km).toBeGreaterThan(0);
    expect(await fallbackCount('route')).toBe(before + 1);
  });
});
