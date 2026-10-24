import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlacesHealth, resetPlacesHealthForTests } from '../providers/places/places-health';

// ---------------------------------------------------------------------------
// [PLACES-LOUD 22 Oct 2026] The composition root wires address-search health
// into /ready (provider + last known status: public, never a failure) and the
// token-gated /health detail (the last failure's class and Google status). The
// status is read from memory: neither probe calls Google. The unit behaviour is
// in places-fail-loud.test.ts; this proves app.ts reads the shared tracker.
// ---------------------------------------------------------------------------

const FIXTURE_KEY = 'places-wiring-fixture-key-value';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPlacesHealthForTests();
});

describe('the application reports address search in /ready and the /health detail', () => {
  it('names the provider and its last known status, without failing readiness or calling Google', async () => {
    vi.stubEnv('PLACES_PROVIDER', 'google');
    vi.stubEnv('GOOGLE_MAPS_API_KEY_BACKEND', FIXTURE_KEY);
    vi.stubEnv('RUN_WORKERS', '0');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('HEALTH_DETAIL_TOKEN', 'places-fixture-detail');
    const fetch = vi.fn(async (_url: unknown) => { throw new Error('unreachable'); });
    vi.stubGlobal('fetch', fetch);
    resetPlacesHealthForTests();
    const { buildApp } = await import('../app');
    const app = await buildApp();
    try {
      await app.ready();
      const before = await app.inject('/ready');
      expect(before.json()).toMatchObject({ places: { provider: 'google', status: 'unknown', since: null } });

      getPlacesHealth().recordFailure('autocomplete', { reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED' }, 'u-wiring');
      const ready = await app.inject('/ready');
      const body = ready.json();
      expect(body).toMatchObject({ places: { provider: 'google', status: 'failing' } });
      expect(typeof body.places.since).toBe('string');
      expect(Object.keys(body.places).sort()).toEqual(['provider', 'since', 'status']);
      // Reported only: a failing address search is never a readiness reason.
      expect(body.reasons).not.toContain('places');
      expect(Object.keys(body.deps)).not.toContain('places');

      const detail = await app.inject({ url: '/health', headers: { 'x-health-detail': 'places-fixture-detail' } });
      expect(detail.json()).toMatchObject({
        places: { provider: 'google', status: 'failing', lastFailure: { op: 'autocomplete', reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED' } },
      });
      const publicHealth = await app.inject('/health');
      expect(publicHealth.json()).not.toHaveProperty('places');

      // Exact hosts the provider calls (Places API (New), Geocoding), compared on the parsed hostname.
      const googleHosts = new Set(['places.googleapis.com', 'maps.googleapis.com']);
      const hostOf = (url: unknown) => { try { return new URL(String(url)).hostname; } catch { return ''; } };
      expect(fetch.mock.calls.filter(([url]) => googleHosts.has(hostOf(url)))).toHaveLength(0);
      expect(JSON.stringify([body, detail.json()])).not.toContain(FIXTURE_KEY);
    } finally {
      await app.close();
    }
  });
});
