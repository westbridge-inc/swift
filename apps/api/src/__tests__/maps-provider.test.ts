import { describe, it, expect, vi, afterEach } from 'vitest';
import { HaversineMapsProvider, GoogleMapsProvider, OsrmMapsProvider, getMapsProvider } from '../providers/maps/maps-provider';

const ORIGIN = { lat: 6.8013, lng: -58.1551 };
const DESTS = [
  { lat: 6.81, lng: -58.16 },
  { lat: 6.79, lng: -58.14 },
];

/** Minimal fetch stub matching only what the provider reads (res.ok / res.json). */
function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('getMapsProvider', () => {
  afterEach(() => {
    delete process.env['MAPS_PROVIDER'];
    delete process.env['GOOGLE_MAPS_API_KEY_BACKEND'];
    delete process.env['OSRM_URL'];
    vi.unstubAllGlobals();
  });

  it('defaults to haversine', () => {
    expect(getMapsProvider()).toBeInstanceOf(HaversineMapsProvider);
  });

  it('throws on an unknown provider', () => {
    process.env['MAPS_PROVIDER'] = 'nope';
    expect(() => getMapsProvider()).toThrow(/Unknown MAPS_PROVIDER/);
  });

  it('requires GOOGLE_MAPS_API_KEY_BACKEND when MAPS_PROVIDER=google', () => {
    process.env['MAPS_PROVIDER'] = 'google';
    expect(() => getMapsProvider()).toThrow(/GOOGLE_MAPS_API_KEY_BACKEND/);
  });

  it('builds a GoogleMapsProvider when configured', () => {
    process.env['MAPS_PROVIDER'] = 'google';
    process.env['GOOGLE_MAPS_API_KEY_BACKEND'] = 'test-key';
    expect(getMapsProvider()).toBeInstanceOf(GoogleMapsProvider);
  });

  it('requires OSRM_URL when MAPS_PROVIDER=osrm', () => {
    process.env['MAPS_PROVIDER'] = 'osrm';
    expect(() => getMapsProvider()).toThrow(/OSRM_URL/);
  });

  it('builds an OsrmMapsProvider when configured', () => {
    process.env['MAPS_PROVIDER'] = 'osrm';
    process.env['OSRM_URL'] = 'http://osrm.test';
    expect(getMapsProvider()).toBeInstanceOf(OsrmMapsProvider);
  });
});

describe('HaversineMapsProvider', () => {
  it('returns one positive ETA per destination', async () => {
    const etas = await new HaversineMapsProvider().etaMinutes(ORIGIN, DESTS);
    expect(etas).toHaveLength(2);
    etas.forEach((e) => expect(e).toBeGreaterThan(0));
  });

  it('returns [] for no destinations', async () => {
    expect(await new HaversineMapsProvider().etaMinutes(ORIGIN, [])).toEqual([]);
  });
});

describe('GoogleMapsProvider', () => {
  const haversine = new HaversineMapsProvider();
  afterEach(() => vi.unstubAllGlobals());

  it('parses Distance Matrix durations into minutes', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        status: 'OK',
        rows: [{ elements: [{ status: 'OK', duration: { value: 600 } }, { status: 'OK', duration: { value: 1200 } }] }],
      }),
    );
    expect(await new GoogleMapsProvider('k').etaMinutes(ORIGIN, DESTS)).toEqual([10, 20]);
  });

  it('falls back to haversine when the request throws (never breaks dispatch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const etas = await new GoogleMapsProvider('k').etaMinutes(ORIGIN, DESTS);
    expect(etas).toEqual(await haversine.etaMinutes(ORIGIN, DESTS));
  });

  it('falls back to haversine on a non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'error'));
    const etas = await new GoogleMapsProvider('k').etaMinutes(ORIGIN, DESTS);
    expect(etas).toEqual(await haversine.etaMinutes(ORIGIN, DESTS));
  });

  it('falls back to haversine on a top-level non-OK API status', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { status: 'REQUEST_DENIED' }));
    const etas = await new GoogleMapsProvider('k').etaMinutes(ORIGIN, DESTS);
    expect(etas).toEqual(await haversine.etaMinutes(ORIGIN, DESTS));
  });

  it('uses haversine for individual ZERO_RESULTS elements', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        status: 'OK',
        rows: [{ elements: [{ status: 'OK', duration: { value: 600 } }, { status: 'ZERO_RESULTS' }] }],
      }),
    );
    const etas = await new GoogleMapsProvider('k').etaMinutes(ORIGIN, DESTS);
    const hv = await haversine.etaMinutes(ORIGIN, DESTS);
    expect(etas[0]).toBe(10);
    expect(etas[1]).toBe(hv[1]);
  });

  it('returns [] without fetching for no destinations', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await new GoogleMapsProvider('k').etaMinutes(ORIGIN, [])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('OsrmMapsProvider', () => {
  const haversine = new HaversineMapsProvider();
  afterEach(() => vi.unstubAllGlobals());

  it('parses OSRM table durations into minutes (skipping the self entry)', async () => {
    // durations[0] = [origin->self, origin->dest1=600s, origin->dest2=1200s]
    vi.stubGlobal('fetch', mockFetch(200, { code: 'Ok', durations: [[0, 600, 1200]] }));
    expect(await new OsrmMapsProvider('http://osrm.test').etaMinutes(ORIGIN, DESTS)).toEqual([10, 20]);
  });

  it('falls back to haversine on a non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', mockFetch(500, {}));
    const etas = await new OsrmMapsProvider('http://osrm.test').etaMinutes(ORIGIN, DESTS);
    expect(etas).toEqual(await haversine.etaMinutes(ORIGIN, DESTS));
  });

  it('falls back to haversine when the OSRM code is not Ok', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { code: 'NoRoute', durations: null }));
    const etas = await new OsrmMapsProvider('http://osrm.test').etaMinutes(ORIGIN, DESTS);
    expect(etas).toEqual(await haversine.etaMinutes(ORIGIN, DESTS));
  });

  it('returns [] for no destinations', async () => {
    expect(await new OsrmMapsProvider('http://osrm.test').etaMinutes(ORIGIN, [])).toEqual([]);
  });
});

describe('routeKm — point-to-point routing for fares/fees', () => {
  const haversine = new HaversineMapsProvider();
  afterEach(() => vi.unstubAllGlobals());

  it('haversine returns the historical deterministic estimate with null minutes', async () => {
    const r = await haversine.routeKm(ORIGIN, DESTS[0]!);
    expect(r.km).toBeGreaterThan(0);
    expect(r.minutes).toBeNull();
  });

  it('OSRM parses the route service (lng,lat order; metres/seconds → km/min)', async () => {
    const f = mockFetch(200, { code: 'Ok', routes: [{ distance: 5200, duration: 780 }] });
    vi.stubGlobal('fetch', f);
    const r = await new OsrmMapsProvider('http://osrm.test').routeKm(ORIGIN, DESTS[0]!);
    expect(r.km).toBeCloseTo(5.2, 5);
    expect(r.minutes).toBeCloseTo(13, 5);
    const url = String((f.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain('/route/v1/driving/');
    expect(url).toContain(`${ORIGIN.lng},${ORIGIN.lat}`); // OSRM wants lng,lat
  });

  it('OSRM falls back to the deterministic estimate on failure — fares never block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await new OsrmMapsProvider('http://osrm.test').routeKm(ORIGIN, DESTS[0]!);
    expect(r).toEqual(await haversine.routeKm(ORIGIN, DESTS[0]!));
  });

  it('Google routes stay deterministic (paid API is dispatch-only)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await new GoogleMapsProvider('key').routeKm(ORIGIN, DESTS[0]!);
    expect(r).toEqual(await haversine.routeKm(ORIGIN, DESTS[0]!));
    expect(f).not.toHaveBeenCalled();
  });
});

describe('routeLegs — [TAXI multi-stop] a whole itinerary, in one call', () => {
  const haversine = new HaversineMapsProvider();
  const STOP_1 = { lat: 6.8143, lng: -58.1443 };
  const STOP_2 = { lat: 6.825, lng: -58.15 };
  const FINAL = { lat: 6.82, lng: -58.16 };
  const POINTS = [ORIGIN, STOP_1, STOP_2, FINAL];
  const okRoute = {
    code: 'Ok',
    routes: [{ distance: 7400, duration: 1110, legs: [{ distance: 2000, duration: 300 }, { distance: 1500, duration: 270 }, { distance: 3900, duration: 540 }] }],
  };
  afterEach(() => vi.unstubAllGlobals());

  it('haversine: each leg exactly as routeKm estimates it, the route their sum, never degraded', async () => {
    const r = await haversine.routeLegs(POINTS);
    const each = await Promise.all([[ORIGIN, STOP_1], [STOP_1, STOP_2], [STOP_2, FINAL]].map(([a, b]) => haversine.routeKm(a!, b!)));
    expect(r.legs).toEqual(each.map((e) => ({ km: e.km, minutes: null })));
    expect(r.km).toBe(each[0]!.km + each[1]!.km + each[2]!.km);
    expect({ minutes: r.minutes, source: r.source, degraded: r.degraded }).toEqual({ minutes: null, source: 'haversine', degraded: false });
  });

  it('haversine: a two-point route is routeKm to the last digit', async () => {
    const r = await haversine.routeLegs([ORIGIN, FINAL]);
    expect(r.km).toBe((await haversine.routeKm(ORIGIN, FINAL)).km);
    expect(r.legs).toHaveLength(1);
  });

  it('haversine: fewer than two points has no legs', async () => {
    expect(await haversine.routeLegs([ORIGIN])).toEqual({ legs: [], km: 0, minutes: null, source: 'haversine', degraded: false });
  });

  it('OSRM: ONE /route call through every point in order (lng,lat), legs and totals in km/min', async () => {
    const f = mockFetch(200, okRoute);
    vi.stubGlobal('fetch', f);
    const r = await new OsrmMapsProvider('http://osrm.test/').routeLegs(POINTS);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toBe(
      'http://osrm.test/route/v1/driving/-58.1551,6.8013;-58.1443,6.8143;-58.15,6.825;-58.16,6.82?overview=false',
    );
    expect(r).toEqual({
      legs: [{ km: 2, minutes: 5 }, { km: 1.5, minutes: 4.5 }, { km: 3.9, minutes: 9 }],
      km: 7.4,
      minutes: 18.5,
      source: 'osrm',
      degraded: false,
    });
  });

  it('OSRM: one leg of 0 m is a real leg (two points across one road snap to one node) — kept, not degraded', async () => {
    const route = { distance: 5900, duration: 840, legs: [{ distance: 2000, duration: 300 }, { distance: 0, duration: 0 }, { distance: 3900, duration: 540 }] };
    vi.stubGlobal('fetch', mockFetch(200, { code: 'Ok', routes: [route] }));
    const r = await new OsrmMapsProvider('http://osrm.test').routeLegs(POINTS);
    expect(r).toMatchObject({ km: 5.9, degraded: false, source: 'osrm' });
    expect(r.legs[1]).toEqual({ km: 0, minutes: 0 });
  });

  it('OSRM: a leg without a duration keeps its distance and says so', async () => {
    const route = { ...okRoute.routes[0]!, legs: [{ distance: 2000 }, { distance: 1500, duration: 270 }, { distance: 3900, duration: 540 }] };
    vi.stubGlobal('fetch', mockFetch(200, { code: 'Ok', routes: [route] }));
    const r = await new OsrmMapsProvider('http://osrm.test').routeLegs(POINTS);
    expect(r.legs[0]).toEqual({ km: 2, minutes: null });
    expect(r.degraded).toBe(false);
  });

  const failures: Array<[string, () => unknown]> = [
    ['the request throws', () => vi.fn(async () => { throw new Error('ECONNREFUSED'); })],
    ['a non-OK HTTP status', () => mockFetch(500, {})],
    ['a code that is not Ok', () => mockFetch(200, { code: 'NoRoute', routes: [] })],
    ['no route', () => mockFetch(200, { code: 'Ok', routes: [] })],
    ['a route without a distance', () => mockFetch(200, { code: 'Ok', routes: [{ ...okRoute.routes[0], distance: undefined }] })],
    ['a route without legs', () => mockFetch(200, { code: 'Ok', routes: [{ distance: 7400, duration: 1110 }] })],
    ['one leg fewer than the points need', () => mockFetch(200, { code: 'Ok', routes: [{ ...okRoute.routes[0], legs: okRoute.routes[0]!.legs.slice(1) }] })],
    ['a leg without a distance', () => mockFetch(200, { code: 'Ok', routes: [{ ...okRoute.routes[0], legs: [{ duration: 300 }, ...okRoute.routes[0]!.legs.slice(1)] }] })],
    ['a negative distance', () => mockFetch(200, { code: 'Ok', routes: [{ ...okRoute.routes[0], distance: -1 }] })],
    ['a whole route of 0 m: every point snapped to one node, nothing routed', () => mockFetch(200, {
      code: 'Ok',
      routes: [{ distance: 0, duration: 0, legs: [{ distance: 0, duration: 0 }, { distance: 0, duration: 0 }, { distance: 0, duration: 0 }] }],
    })],
  ];
  it.each(failures)('OSRM: %s → the deterministic estimate, marked degraded', async (_label, stub) => {
    vi.stubGlobal('fetch', stub());
    const r = await new OsrmMapsProvider('http://osrm.test').routeLegs(POINTS);
    expect(r).toEqual({ ...(await haversine.routeLegs(POINTS)), degraded: true });
  });

  it('OSRM: fewer than two points asks nothing', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await new OsrmMapsProvider('http://osrm.test').routeLegs([ORIGIN])).legs).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('Google: the deterministic estimate, never degraded, never a paid call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await new GoogleMapsProvider('key').routeLegs(POINTS)).toEqual(await haversine.routeLegs(POINTS));
    expect(f).not.toHaveBeenCalled();
  });
});
