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
