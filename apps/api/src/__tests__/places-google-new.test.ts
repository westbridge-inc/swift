import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesProvider } from '../providers/places/places-provider';

// ---------------------------------------------------------------------------
// GooglePlacesProvider on Places API (New). The owner's Google project only
// offers Places API (New) — the legacy Places endpoints cannot be enabled — so
// address search must call places.googleapis.com/v1 with the key in a header
// and a field mask, while handing the app and web EXACTLY the shapes they get
// today. Reverse geocoding stays on the Geocoding API. Every failure degrades
// to empty/null (the hot path never throws) and the key never leaves the
// server: not in a URL of the new endpoints, not in a log, not in a result.
// fetch is mocked throughout; live calls run only on the production host.
// ---------------------------------------------------------------------------

const KEY = 'unit-test-places-key-value';
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL_PREFIX = 'https://places.googleapis.com/v1/places/';
const AUTOCOMPLETE_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';
const DETAILS_MASK = 'id,displayName,formattedAddress,location';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type Call = { url: string; init: FetchInit };
let calls: Call[];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string, init: FetchInit) => Response | Promise<Response>) {
  calls = [];
  const f = vi.fn(async (input: unknown, init?: FetchInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  vi.stubGlobal('fetch', f);
  return f;
}

function headersOf(init: FetchInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

const provider = () => new GooglePlacesProvider(KEY);

const AUTOCOMPLETE_BODY = {
  suggestions: [
    {
      placePrediction: {
        place: 'places/ChIJgiftland0001',
        placeId: 'ChIJgiftland0001',
        text: { text: 'Giftland Mall, Turkeyen, Georgetown, Guyana' },
        structuredFormat: {
          mainText: { text: 'Giftland Mall' },
          secondaryText: { text: 'Turkeyen, Georgetown, Guyana' },
        },
      },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GooglePlacesProvider.autocomplete — Places API (New) request', () => {
  it('POSTs places:autocomplete with the key and the field mask in headers, never in the URL', async () => {
    stubFetch(() => jsonResponse(200, AUTOCOMPLETE_BODY));
    await provider().autocomplete('giftland');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(AUTOCOMPLETE_URL);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    const h = headersOf(init);
    expect(h['x-goog-api-key']).toBe(KEY);
    expect(h['x-goog-fieldmask']).toBe(AUTOCOMPLETE_MASK);
    expect(h['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the typed input restricted to Guyana and no bias when there is no point', async () => {
    stubFetch(() => jsonResponse(200, AUTOCOMPLETE_BODY));
    await provider().autocomplete('giftland');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: 'giftland', includedRegionCodes: ['gy'] });
  });

  it('biases toward the caller with a 50 km circle when a point is known (no session token: the current code has none)', async () => {
    stubFetch(() => jsonResponse(200, AUTOCOMPLETE_BODY));
    await provider().autocomplete('giftland', { near: { lat: 6.8137, lng: -58.1196 }, userId: 'u-1' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      input: 'giftland',
      includedRegionCodes: ['gy'],
      locationBias: { circle: { center: { latitude: 6.8137, longitude: -58.1196 }, radius: 50000 } },
    });
  });

  it('a blank query never calls Google', async () => {
    const f = stubFetch(() => jsonResponse(200, AUTOCOMPLETE_BODY));
    expect(await provider().autocomplete('   ')).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('GooglePlacesProvider.autocomplete — maps predictions into the unchanged PlaceSuggestion shape', () => {
  it('main text is the primary line and secondary text the context line', async () => {
    stubFetch(() => jsonResponse(200, AUTOCOMPLETE_BODY));
    expect(await provider().autocomplete('giftland')).toEqual([
      { placeId: 'ChIJgiftland0001', primary: 'Giftland Mall', secondary: 'Turkeyen, Georgetown, Guyana' },
    ]);
  });

  it('falls back to the full text, then to an empty primary; no secondary key when Google gives none', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        suggestions: [
          { placePrediction: { placeId: 'ChIJa', text: { text: 'Stabroek Market, Georgetown' } } },
          { placePrediction: { placeId: 'ChIJb' } },
        ],
      }),
    );
    const out = await provider().autocomplete('stab');
    expect(out).toEqual([
      { placeId: 'ChIJa', primary: 'Stabroek Market, Georgetown', secondary: undefined },
      { placeId: 'ChIJb', primary: '', secondary: undefined },
    ]);
    // The route serialises these with JSON: no secondary key reaches the client.
    expect(JSON.parse(JSON.stringify(out))).toEqual([
      { placeId: 'ChIJa', primary: 'Stabroek Market, Georgetown' },
      { placeId: 'ChIJb', primary: '' },
    ]);
  });

  it('skips query predictions and predictions without a place id, and caps at six', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      placePrediction: { placeId: `ChIJ${i}`, structuredFormat: { mainText: { text: `Place ${i}` } } },
    }));
    stubFetch(() =>
      jsonResponse(200, {
        suggestions: [
          { queryPrediction: { text: { text: 'pizza near Georgetown' } } },
          { placePrediction: { text: { text: 'no id' } } },
          ...many,
        ],
      }),
    );
    const out = await provider().autocomplete('place');
    expect(out.map((s) => s.placeId)).toEqual(['ChIJ0', 'ChIJ1', 'ChIJ2', 'ChIJ3', 'ChIJ4', 'ChIJ5']);
    expect(out[0]).toEqual({ placeId: 'ChIJ0', primary: 'Place 0', secondary: undefined });
  });

  it('no suggestions (Google answers {} for zero results) is an empty list', async () => {
    stubFetch(() => jsonResponse(200, {}));
    expect(await provider().autocomplete('zzzz')).toEqual([]);
  });
});

describe('GooglePlacesProvider.details — Place Details (New)', () => {
  const PLACE = {
    id: 'ChIJgiftland0001',
    displayName: { text: 'Giftland Mall', languageCode: 'en' },
    formattedAddress: 'Turkeyen, Georgetown, Guyana',
    location: { latitude: 6.8137, longitude: -58.1196 },
  };

  it('GETs /v1/places/{placeId} with the key and the field mask in headers, never in the URL', async () => {
    stubFetch(() => jsonResponse(200, PLACE));
    await provider().details('ChIJgiftland0001');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${DETAILS_URL_PREFIX}ChIJgiftland0001`);
    expect(url).not.toContain(KEY);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    const h = headersOf(init);
    expect(h['x-goog-api-key']).toBe(KEY);
    expect(h['x-goog-fieldmask']).toBe(DETAILS_MASK);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps the display name and location into the unchanged PlaceDetail shape', async () => {
    stubFetch(() => jsonResponse(200, PLACE));
    expect(await provider().details('ChIJgiftland0001')).toEqual({
      placeId: 'ChIJgiftland0001',
      label: 'Giftland Mall',
      lat: 6.8137,
      lng: -58.1196,
    });
  });

  it('label falls back to the formatted address, then to "Selected place"', async () => {
    stubFetch(() => jsonResponse(200, { formattedAddress: 'Lot 5, Regent St, Georgetown', location: PLACE.location }));
    expect((await provider().details('ChIJx'))?.label).toBe('Lot 5, Regent St, Georgetown');
    stubFetch(() => jsonResponse(200, { location: PLACE.location }));
    expect((await provider().details('ChIJx'))?.label).toBe('Selected place');
  });

  it('a place without a usable location resolves to null', async () => {
    for (const body of [
      { displayName: { text: 'No point' } },
      { displayName: { text: 'Half point' }, location: { latitude: 6.8 } },
      { displayName: { text: 'Text point' }, location: { latitude: '6.8', longitude: '-58.1' } },
    ]) {
      stubFetch(() => jsonResponse(200, body));
      expect(await provider().details('ChIJx')).toBeNull();
    }
  });

  it('an id that is not a Google place id never reaches the URL path (no request at all)', async () => {
    for (const bad of ['../places:autocomplete', 'ChIJ/../../v1', 'ChIJ?key=x', 'addr:abc123', 'zone:z1', 'ChIJ x', '']) {
      const f = stubFetch(() => jsonResponse(200, PLACE));
      expect(await provider().details(bad)).toBeNull();
      expect(f).not.toHaveBeenCalled();
    }
  });
});

describe('GooglePlacesProvider — every failure degrades (never throws)', () => {
  const PLACE_OK = { displayName: { text: 'X' }, location: { latitude: 6.8, longitude: -58.1 } };

  const failures: Array<[string, () => void]> = [
    ['network error', () => stubFetch(() => Promise.reject(new TypeError('fetch failed')))],
    ['403 with an error body', () =>
      stubFetch(() => jsonResponse(403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } }))],
    // A failed status degrades even when the body would otherwise map.
    ['500 with a usable-looking body', () => stubFetch(() => jsonResponse(500, { ...AUTOCOMPLETE_BODY, ...PLACE_OK }))],
    ['200 carrying an error body', () =>
      stubFetch(() => jsonResponse(200, { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' }, ...AUTOCOMPLETE_BODY, ...PLACE_OK }))],
    ['a body that is not JSON', () => stubFetch(() => new Response('<html>oops</html>', { status: 200 }))],
    ['a JSON null body', () => stubFetch(() => jsonResponse(200, null))],
    ['suggestions that are not a list', () => stubFetch(() => jsonResponse(200, { suggestions: { placeId: 'x' } }))],
  ];

  it.each(failures)('autocomplete → [] on %s', async (_name, arrange) => {
    arrange();
    await expect(provider().autocomplete('giftland')).resolves.toEqual([]);
  });

  it.each(failures.filter(([n]) => n !== 'suggestions that are not a list'))('details → null on %s', async (_name, arrange) => {
    arrange();
    await expect(provider().details('ChIJgiftland0001')).resolves.toBeNull();
  });

  function hangingFetch() {
    return stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }),
    );
  }

  it('autocomplete gives up after the same 4 s timeout and returns []', async () => {
    vi.useFakeTimers();
    hangingFetch();
    const pending = provider().autocomplete('giftland');
    await vi.advanceTimersByTimeAsync(3999);
    expect(calls[0]!.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([]);
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it('details gives up after the same 4 s timeout and returns null', async () => {
    vi.useFakeTimers();
    hangingFetch();
    const pending = provider().details('ChIJgiftland0001');
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toBeNull();
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });
});

describe('GooglePlacesProvider — the key stays on the server', () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
      });
    }
  });

  it('no success or failure path logs the key or returns it', async () => {
    const results: unknown[] = [];
    const scenarios: Array<() => void> = [
      () => stubFetch((url) => jsonResponse(200, url.includes(':autocomplete') ? AUTOCOMPLETE_BODY : { location: { latitude: 6.8, longitude: -58.1 } })),
      () => stubFetch(() => Promise.reject(new Error(`connect failed for key=${KEY}`))),
      () => stubFetch(() => jsonResponse(403, { error: { message: `API key ${KEY} not valid` } })),
      () => stubFetch(() => new Response(`not json ${KEY}`, { status: 200 })),
    ];
    for (const arrange of scenarios) {
      arrange();
      results.push(await provider().autocomplete('giftland', { near: { lat: 6.8, lng: -58.1 } }));
      results.push(await provider().details('ChIJgiftland0001'));
      results.push(await provider().reverseGeocode({ lat: 6.8, lng: -58.1 }));
    }
    expect(logged.filter((l) => l.includes(KEY))).toEqual([]);
    expect(JSON.stringify(results)).not.toContain(KEY);
    // Places (New) carries the key only in the X-Goog-Api-Key header.
    for (const c of calls) {
      if (c.url.startsWith('https://places.googleapis.com/')) {
        expect(c.url).not.toContain(KEY);
        expect(String(c.init.body ?? '')).not.toContain(KEY);
      }
    }
  });
});

describe('GooglePlacesProvider — the legacy Places endpoints are gone; Geocoding stays', () => {
  it('autocomplete and details never call maps.googleapis.com/maps/api/place/*', async () => {
    stubFetch((url) =>
      jsonResponse(200, url.includes(':autocomplete') ? AUTOCOMPLETE_BODY : { location: { latitude: 6.8, longitude: -58.1 } }),
    );
    await provider().autocomplete('giftland', { near: { lat: 6.8, lng: -58.1 } });
    await provider().details('ChIJgiftland0001');
    expect(calls.map((c) => c.url)).toEqual([AUTOCOMPLETE_URL, `${DETAILS_URL_PREFIX}ChIJgiftland0001`]);
    for (const c of calls) expect(c.url).not.toMatch(/maps\.googleapis\.com\/maps\/api\/place\//);
  });

  it('the provider source names no legacy Places endpoint', () => {
    const src = readFileSync(join(__dirname, '../providers/places/places-provider.ts'), 'utf8');
    expect(src).not.toMatch(/maps\/api\/place\//);
  });

  it('reverse geocoding still uses the Geocoding API and degrades to null', async () => {
    stubFetch(() => jsonResponse(200, { status: 'OK', results: [{ formatted_address: 'Regent St, Georgetown, Guyana' }] }));
    expect(await provider().reverseGeocode({ lat: 6.8, lng: -58.1 })).toBe('Regent St, Georgetown, Guyana');
    const u = new URL(calls[0]!.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(u.searchParams.get('latlng')).toBe('6.8,-58.1');
    stubFetch(() => jsonResponse(200, { status: 'REQUEST_DENIED', results: [] }));
    expect(await provider().reverseGeocode({ lat: 6.8, lng: -58.1 })).toBeNull();
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await provider().reverseGeocode({ lat: 6.8, lng: -58.1 })).toBeNull();
  });
});
