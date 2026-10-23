import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesProvider, type PlacesProvider } from '../providers/places/places-provider';
import {
  PLACES_UNAVAILABLE_CODE,
  PLACES_UNAVAILABLE_MESSAGE,
  PlacesProviderError,
  describePlacesFailure,
  type PlacesFailure,
} from '../providers/places/places-failure';
import {
  PLACES_ALERT_FAILURES,
  PLACES_ALERT_MIN_CALLERS,
  PLACES_ALERT_WINDOW_MS,
  PLACES_PAGE_KEY,
  PLACES_PAGE_RETRY_MS,
  PLACES_PAGE_TITLE,
  PLACES_PAGE_WINDOW_SECONDS,
  PlacesHealth,
  getPlacesHealth,
  placesProviderName,
  resetPlacesHealthForTests,
  type PlacesPageInput,
  type PlacesPager,
} from '../providers/places/places-health';
import { formatPlacesSmoke, placesSmokeMain, runPlacesSmoke } from '../providers/places/places-smoke';
import { placesRoutes } from '../modules/places/places.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerReadinessRoute } from '../plugins/readiness';
import { placesCallsCounter } from '../plugins/observability';
import { loggerRedactConfig } from '../utils/logger-config';

// ---------------------------------------------------------------------------
// [PLACES-LOUD 22 Oct 2026] Address search must FAIL LOUD.
//
// Production address search is GooglePlacesProvider (Places API (New) + the
// Geocoding API). Every Google failure (a key that is invalid, restricted to
// the apps, missing an enabled API or billing, over quota; a timeout; a
// network error; an unreadable answer) used to come back as an empty list,
// which the apps show as "No matches". Customers saw a quiet search and nobody
// at Swift could know. Now:
//   - "no matches" (Google answered with nothing) stays an empty list / null;
//   - a FAILURE is a typed PlacesProviderError with a bounded class and
//     Google's own status words (never the key, never the query);
//   - the route answers 503 PLACES_UNAVAILABLE with a fixed, honest message,
//     logs the failure at error level (status/reason and a query LENGTH only),
//     counts it, and pages ops (deduped) when failures persist;
//   - /ready reports the provider and its last known status without failing
//     and without calling Google;
//   - a launch smoke command prints PASS/FAIL per call and exits non-zero.
// fetch is mocked throughout. No database.
// ---------------------------------------------------------------------------

const KEY = 'unit-test-places-loud-key-value';
const QUERY = 'Giftland';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type Call = { url: string; init: FetchInit };
let calls: Call[] = [];

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

/** A Google API error body (google.rpc.Status) with an optional ErrorInfo reason. */
function googleError(httpStatus: number, status: string, reason?: string, message = 'refused') {
  return jsonResponse(httpStatus, {
    error: {
      code: httpStatus,
      message,
      status,
      ...(reason
        ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'places.googleapis.com' } }] }
        : {}),
    },
  });
}

async function failureOf(p: Promise<unknown>): Promise<PlacesFailure> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PlacesProviderError);
    return (err as PlacesProviderError).failure;
  }
  throw new Error('expected the call to fail with a PlacesProviderError, but it answered');
}

const provider = () => new GooglePlacesProvider(KEY);

const SUGGESTIONS = {
  suggestions: [
    {
      placePrediction: {
        placeId: 'ChIJgiftland0001',
        text: { text: 'Giftland Mall, Turkeyen, Georgetown, Guyana' },
        structuredFormat: { mainText: { text: 'Giftland Mall' }, secondaryText: { text: 'Turkeyen, Georgetown, Guyana' } },
      },
    },
  ],
};
const PLACE = { id: 'ChIJgiftland0001', displayName: { text: 'Giftland Mall' }, location: { latitude: 6.8193, longitude: -58.1166 } };
const GEOCODE_OK = { status: 'OK', results: [{ formatted_address: 'Water Street, Georgetown, Guyana' }] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPlacesHealthForTests();
  placesCallsCounter.reset();
});

// ---------------------------------------------------------------------------
// 1. The provider tells "no matches" from FAILURE.
// ---------------------------------------------------------------------------

describe('GooglePlacesProvider: "no matches" is an empty answer, never a failure', () => {
  it('autocomplete: Google answering {} (its zero-result shape) or an empty list is []', async () => {
    stubFetch(() => jsonResponse(200, {}));
    await expect(provider().autocomplete(QUERY)).resolves.toEqual([]);
    stubFetch(() => jsonResponse(200, { suggestions: [] }));
    await expect(provider().autocomplete(QUERY)).resolves.toEqual([]);
  });

  it('details: Google saying NOT_FOUND (404) for the id is null, not a failure', async () => {
    stubFetch(() => googleError(404, 'NOT_FOUND'));
    await expect(provider().details('ChIJgone0001')).resolves.toBeNull();
  });

  it('reverse geocode: ZERO_RESULTS is null, not a failure', async () => {
    stubFetch(() => jsonResponse(200, { status: 'ZERO_RESULTS', results: [] }));
    await expect(provider().reverseGeocode({ lat: 6.8, lng: -58.1 })).resolves.toBeNull();
  });
});

describe('GooglePlacesProvider: every failure is a PlacesProviderError with its class and Google status', () => {
  const cases: Array<[string, () => Response | Promise<Response>, PlacesFailure]> = [
    ['an invalid key (400 INVALID_ARGUMENT, API_KEY_INVALID)', () => googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'),
      { reason: 'auth', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT', googleReason: 'API_KEY_INVALID' }],
    ['a key restricted to the Android app (403, API_KEY_ANDROID_APP_BLOCKED)', () => googleError(403, 'PERMISSION_DENIED', 'API_KEY_ANDROID_APP_BLOCKED'),
      { reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED', googleReason: 'API_KEY_ANDROID_APP_BLOCKED' }],
    ['Places API (New) not enabled (403, SERVICE_DISABLED)', () => googleError(403, 'PERMISSION_DENIED', 'SERVICE_DISABLED'),
      { reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED', googleReason: 'SERVICE_DISABLED' }],
    ['billing off (403, BILLING_DISABLED)', () => googleError(403, 'PERMISSION_DENIED', 'BILLING_DISABLED'),
      { reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED', googleReason: 'BILLING_DISABLED' }],
    ['a 401 with no body at all', () => new Response('', { status: 401 }),
      { reason: 'auth', httpStatus: 401 }],
    ['over quota (429 RESOURCE_EXHAUSTED)', () => googleError(429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'),
      { reason: 'quota', httpStatus: 429, googleStatus: 'RESOURCE_EXHAUSTED', googleReason: 'RATE_LIMIT_EXCEEDED' }],
    ['a Google outage (503 UNAVAILABLE)', () => googleError(503, 'UNAVAILABLE'),
      { reason: 'upstream', httpStatus: 503, googleStatus: 'UNAVAILABLE' }],
    ['a request Google refuses (400 INVALID_ARGUMENT, no key reason)', () => googleError(400, 'INVALID_ARGUMENT'),
      { reason: 'rejected', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT' }],
    ['a 200 carrying an error body', () => googleError(200, 'INVALID_ARGUMENT'),
      { reason: 'rejected', httpStatus: 200, googleStatus: 'INVALID_ARGUMENT' }],
    ['a network error', () => Promise.reject(new TypeError('fetch failed')),
      { reason: 'network' }],
    ['a 200 body that is not JSON', () => new Response('<html>oops</html>', { status: 200 }),
      { reason: 'bad_response', httpStatus: 200 }],
    ['a JSON null body', () => jsonResponse(200, null),
      { reason: 'bad_response', httpStatus: 200 }],
    ['suggestions that are not a list', () => jsonResponse(200, { suggestions: { placeId: 'x' } }),
      { reason: 'bad_response', httpStatus: 200 }],
  ];

  it.each(cases)('autocomplete on %s', async (_name, respond, expected) => {
    stubFetch(respond);
    expect(await failureOf(provider().autocomplete(QUERY))).toEqual(expected);
  });

  it.each(cases.filter(([n]) => n !== 'suggestions that are not a list'))('details on %s', async (_name, respond, expected) => {
    stubFetch(respond);
    expect(await failureOf(provider().details('ChIJgiftland0001'))).toEqual(expected);
  });

  it('a timeout (the 4 s abort) is its own class', async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const pending = failureOf(provider().autocomplete(QUERY));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toEqual({ reason: 'timeout' });
  });

  it.each([
    ['REQUEST_DENIED', { reason: 'auth', httpStatus: 200, googleStatus: 'REQUEST_DENIED' }],
    ['OVER_DAILY_LIMIT', { reason: 'auth', httpStatus: 200, googleStatus: 'OVER_DAILY_LIMIT' }],
    ['OVER_QUERY_LIMIT', { reason: 'quota', httpStatus: 200, googleStatus: 'OVER_QUERY_LIMIT' }],
    ['INVALID_REQUEST', { reason: 'rejected', httpStatus: 200, googleStatus: 'INVALID_REQUEST' }],
    ['UNKNOWN_ERROR', { reason: 'upstream', httpStatus: 200, googleStatus: 'UNKNOWN_ERROR' }],
  ] as Array<[string, PlacesFailure]>)('reverse geocode status %s is a failure', async (status, expected) => {
    stubFetch(() => jsonResponse(200, { status, error_message: `refused for ${KEY}`, results: [] }));
    expect(await failureOf(provider().reverseGeocode({ lat: 6.8, lng: -58.1 }))).toEqual(expected);
  });

  it('reverse geocode: an HTTP 500 and a network error are failures too', async () => {
    stubFetch(() => jsonResponse(500, {}));
    expect(await failureOf(provider().reverseGeocode({ lat: 6.8, lng: -58.1 }))).toEqual({ reason: 'upstream', httpStatus: 500 });
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await failureOf(provider().reverseGeocode({ lat: 6.8, lng: -58.1 }))).toEqual({ reason: 'network' });
  });

  it("Google's status words are kept only when they are plain upper-case tokens: free text and the key never ride along", async () => {
    stubFetch(() => jsonResponse(403, {
      error: {
        code: 403,
        message: `API key ${KEY} is restricted`,
        status: `PERMISSION_DENIED for ${KEY}`,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'api key blocked', metadata: { key: KEY } }],
      },
    }));
    const err = await provider().autocomplete(QUERY).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesProviderError);
    const failure = (err as PlacesProviderError).failure;
    expect(failure).toEqual({ reason: 'auth', httpStatus: 403 });
    expect(JSON.stringify(failure)).not.toContain(KEY);
    expect((err as Error).message).not.toContain(KEY);
    expect(String((err as Error).stack)).not.toContain(KEY);
  });

  it('describePlacesFailure names the class and the statuses only', () => {
    expect(describePlacesFailure({ reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED', googleReason: 'API_KEY_SERVICE_BLOCKED' }))
      .toBe('auth (HTTP 403, PERMISSION_DENIED, API_KEY_SERVICE_BLOCKED)');
    expect(describePlacesFailure({ reason: 'timeout' })).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// 2. The health tracker: last known status, and when a page is due.
// ---------------------------------------------------------------------------

describe('PlacesHealth: last known status and the paging threshold', () => {
  const AUTH: PlacesFailure = { reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED', googleReason: 'API_KEY_INVALID' };
  let t = 0;
  const clock = () => t;
  // Two real customers taking turns: a page needs failures from more than one caller.
  let n = 0;
  const who = () => (n++ % 2 === 0 ? 'u-a' : 'u-b');
  beforeEach(() => { t = Date.UTC(2026, 9, 22, 6, 0, 0); n = 0; });

  it('starts unknown, turns ok on an answer and failing on a failure, each "since" the first call of its streak', () => {
    const h = new PlacesHealth(clock);
    expect(h.readiness('google')).toEqual({ provider: 'google', status: 'unknown', since: null });
    h.recordOk();
    const okSince = new Date(t).toISOString();
    t += 1000;
    h.recordOk();
    expect(h.readiness('google')).toEqual({ provider: 'google', status: 'ok', since: okSince });
    t += 1000;
    h.recordFailure('autocomplete', AUTH, who());
    const failingSince = new Date(t).toISOString();
    t += 1000;
    h.recordFailure('details', AUTH, who());
    expect(h.readiness('google')).toEqual({ provider: 'google', status: 'failing', since: failingSince });
    t += 1000;
    h.recordOk();
    expect(h.readiness('google')).toEqual({ provider: 'google', status: 'ok', since: new Date(t).toISOString() });
  });

  it('readiness carries no failure detail; the detail view names the last failure and when', () => {
    const h = new PlacesHealth(clock);
    h.recordFailure('reverse', AUTH, who());
    expect(Object.keys(h.readiness('google')).sort()).toEqual(['provider', 'since', 'status']);
    expect(h.detail('google')).toMatchObject({
      provider: 'google',
      status: 'failing',
      lastFailureAt: new Date(t).toISOString(),
      lastFailure: { op: 'reverse', ...AUTH },
      failuresInWindow: 1,
    });
  });

  it(`pages exactly when ${PLACES_ALERT_FAILURES} failures fall inside ${PLACES_ALERT_WINDOW_MS / 60_000} minutes, then not again until the retry interval`, () => {
    const h = new PlacesHealth(clock);
    for (let i = 1; i < PLACES_ALERT_FAILURES; i++) {
      expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(false);
      t += 1000;
    }
    expect(h.recordFailure('autocomplete', AUTH, who())).toEqual({ page: true, failuresInWindow: PLACES_ALERT_FAILURES });
    t += 1000;
    expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(false);
    t += PLACES_PAGE_RETRY_MS - 2000;
    expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(false);
    t += 1000;
    // Still failing past the retry interval: try again (a page nobody received stays retryable).
    expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(true);
  });

  it('failures spread wider than the window never page', () => {
    const h = new PlacesHealth(clock);
    const gap = Math.ceil(PLACES_ALERT_WINDOW_MS / (PLACES_ALERT_FAILURES - 1)) + 1;
    for (let i = 0; i < PLACES_ALERT_FAILURES * 3; i++) {
      expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(false);
      t += gap;
    }
  });

  it('answers in between do not hide intermittent failures from the threshold', () => {
    const h = new PlacesHealth(clock);
    let paged = false;
    for (let i = 0; i < PLACES_ALERT_FAILURES; i++) {
      paged = h.recordFailure('autocomplete', AUTH, who()).page || paged;
      t += 1000;
      h.recordOk();
      t += 1000;
    }
    expect(paged).toBe(true);
  });

  it('the open page resolves only once the condition clears (fewer than the threshold inside the window), and only once', () => {
    const h = new PlacesHealth(clock);
    for (let i = 0; i < PLACES_ALERT_FAILURES; i++) { h.recordFailure('autocomplete', AUTH, who()); t += 1000; }
    expect(h.recordOk()).toEqual({ resolve: false });
    t += PLACES_ALERT_WINDOW_MS;
    expect(h.recordOk()).toEqual({ resolve: true });
    t += 1000;
    expect(h.recordOk()).toEqual({ resolve: false });
  });

  it('an answer with no page open never resolves anything', () => {
    const h = new PlacesHealth(clock);
    h.recordFailure('autocomplete', AUTH, who());
    t += PLACES_ALERT_WINDOW_MS + 1;
    expect(h.recordOk()).toEqual({ resolve: false });
  });

  it(`one caller alone never pages, however many failures; a second caller failing inside the window does (min ${PLACES_ALERT_MIN_CALLERS} callers)`, () => {
    const h = new PlacesHealth(clock);
    for (let i = 0; i < PLACES_ALERT_FAILURES * 4; i++) {
      expect(h.recordFailure('autocomplete', AUTH, 'u-lone').page).toBe(false);
      t += 1000;
    }
    expect(h.recordFailure('autocomplete', AUTH, 'u-second').page).toBe(true);
  });

  it('the detail view counts the callers in the window and never names one', () => {
    const h = new PlacesHealth(clock);
    h.recordFailure('autocomplete', AUTH, 'u-secret-caller-1');
    h.recordFailure('autocomplete', AUTH, 'u-secret-caller-2');
    h.recordFailure('autocomplete', AUTH, 'u-secret-caller-2');
    expect(h.detail('google')).toMatchObject({ failuresInWindow: 3, callersInWindow: 2 });
    expect(JSON.stringify(h.detail('google'))).not.toContain('u-secret-caller');
  });

  it('a caller-caused rejection handed to the tracker is ignored: no status change, never toward the threshold', () => {
    const REJECTED: PlacesFailure = { reason: 'rejected', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT' };
    const h = new PlacesHealth(clock);
    for (let i = 0; i < PLACES_ALERT_FAILURES * 3; i++) {
      expect(h.recordFailure('autocomplete', REJECTED, who())).toEqual({ page: false, failuresInWindow: 0 });
      t += 1000;
    }
    expect(h.readiness('google')).toEqual({ provider: 'google', status: 'unknown', since: null });
    h.recordOk();
    const okSince = new Date(t).toISOString();
    t += 1000;
    h.recordFailure('details', REJECTED, who());
    expect(h.readiness('google')).toEqual({ provider: 'google', status: 'ok', since: okSince });
    expect(h.detail('google')).toMatchObject({ lastFailure: null, lastFailureAt: null, failuresInWindow: 0 });
    for (let i = 1; i < PLACES_ALERT_FAILURES; i++) expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(false);
    expect(h.recordFailure('autocomplete', REJECTED, who()).page).toBe(false);
    expect(h.recordFailure('autocomplete', AUTH, who()).page).toBe(true);
  });

  it('the provider name is the configured one, and an unknown value is not echoed', () => {
    expect(placesProviderName({ PLACES_PROVIDER: 'google' })).toBe('google');
    expect(placesProviderName({})).toBe('local');
    expect(placesProviderName({ PLACES_PROVIDER: `google ${KEY}` })).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 3. The route: an honest 503, a log line, a metric, a page.
// ---------------------------------------------------------------------------

interface Harness { app: FastifyInstance; logs: () => string; pages: PlacesPageInput[]; resolves: number }

async function harness(places: PlacesProvider, health: PlacesHealth, providerName = 'google'): Promise<Harness> {
  let out = '';
  const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const h: Harness = { app: undefined as unknown as FastifyInstance, logs: () => out, pages: [], resolves: 0 };
  const pager: PlacesPager = {
    page: async (input) => { h.pages.push(input); return { status: 'delivered' }; },
    resolve: async () => { h.resolves += 1; return 1; },
  };
  vi.stubEnv('PLACES_PROVIDER', providerName);
  const app = Fastify({ logger: { level: 'warn', redact: loggerRedactConfig, stream: sink } });
  registerErrorHandler(app);
  // The caller is the x-test-user header (default u-places-loud): paging needs failures from more than one caller.
  app.decorate('authenticate', async (request) => {
    const who = request.headers['x-test-user'];
    request.user = { userId: typeof who === 'string' ? who : 'u-places-loud', role: 'CUSTOMER' };
  });
  await app.register(placesRoutes, { prefix: '/api/v1/places', provider: places, health, pager });
  await app.ready();
  h.app = app;
  return h;
}

async function counterValue(labels: { provider: string; op: string; outcome: string }): Promise<number> {
  const v = (await placesCallsCounter.get()).values.find((x) =>
    x.labels['provider'] === labels.provider && x.labels['op'] === labels.op && x.labels['outcome'] === labels.outcome);
  return v?.value ?? 0;
}

describe('places routes: a provider failure is a 503 the apps can show, logged and counted', () => {
  it('autocomplete with a refused key answers 503 PLACES_UNAVAILABLE (never an empty list), logs status + length only, counts it', async () => {
    stubFetch(() => googleError(403, 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED', `Requests from this key ${KEY} are blocked`));
    const h = await harness(new GooglePlacesProvider(KEY), new PlacesHealth());
    try {
      const res = await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}&lat=6.8&lng=-58.1` });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ success: false, error: { code: PLACES_UNAVAILABLE_CODE, message: PLACES_UNAVAILABLE_MESSAGE } });
      expect(PLACES_UNAVAILABLE_MESSAGE).toBe("Address search isn't working right now. Set the place on the map.");
      const lines = h.logs().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const failure = lines.find((l) => l['msg'] === 'places provider failure');
      expect(failure).toBeDefined();
      expect(failure!['level']).toBe(50); // error
      expect(failure!['places']).toEqual({
        provider: 'google', op: 'autocomplete', reason: 'auth', httpStatus: 403,
        googleStatus: 'PERMISSION_DENIED', googleReason: 'API_KEY_SERVICE_BLOCKED', queryLength: QUERY.length,
      });
      expect(h.logs()).not.toContain(KEY);
      expect(h.logs()).not.toContain(QUERY);
      expect(res.body).not.toContain(KEY);
      expect(await counterValue({ provider: 'google', op: 'autocomplete', outcome: 'auth' })).toBe(1);
    } finally { await h.app.close(); }
  });

  it('autocomplete with no matches is still 200 [] and counted as no_results, with no error logged', async () => {
    stubFetch(() => jsonResponse(200, {}));
    const health = new PlacesHealth();
    const h = await harness(new GooglePlacesProvider(KEY), health);
    try {
      const res = await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, data: [] });
      expect(h.logs()).not.toContain('places provider failure');
      expect(await counterValue({ provider: 'google', op: 'autocomplete', outcome: 'no_results' })).toBe(1);
      expect(health.readiness('google').status).toBe('ok');
    } finally { await h.app.close(); }
  });

  it('a good answer is 200 with the suggestions and counted ok', async () => {
    stubFetch(() => jsonResponse(200, SUGGESTIONS));
    const h = await harness(new GooglePlacesProvider(KEY), new PlacesHealth());
    try {
      const res = await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([{ placeId: 'ChIJgiftland0001', primary: 'Giftland Mall', secondary: 'Turkeyen, Georgetown, Guyana' }]);
      expect(await counterValue({ provider: 'google', op: 'autocomplete', outcome: 'ok' })).toBe(1);
    } finally { await h.app.close(); }
  });

  it('details: a failure is 503, a place Google does not know is still 200 null', async () => {
    const h = await harness(new GooglePlacesProvider(KEY), new PlacesHealth());
    try {
      stubFetch(() => googleError(429, 'RESOURCE_EXHAUSTED'));
      const failed = await h.app.inject({ method: 'GET', url: '/api/v1/places/details?placeId=ChIJgiftland0001' });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.code).toBe(PLACES_UNAVAILABLE_CODE);
      stubFetch(() => googleError(404, 'NOT_FOUND'));
      const gone = await h.app.inject({ method: 'GET', url: '/api/v1/places/details?placeId=ChIJgone0001' });
      expect(gone.statusCode).toBe(200);
      expect(gone.json()).toEqual({ success: true, data: null });
      expect(await counterValue({ provider: 'google', op: 'details', outcome: 'quota' })).toBe(1);
      expect(await counterValue({ provider: 'google', op: 'details', outcome: 'no_results' })).toBe(1);
    } finally { await h.app.close(); }
  });

  it('reverse: a refused key is 503, ZERO_RESULTS is still 200 with a null address', async () => {
    const h = await harness(new GooglePlacesProvider(KEY), new PlacesHealth());
    try {
      stubFetch(() => jsonResponse(200, { status: 'REQUEST_DENIED', error_message: `The provided API key ${KEY} is invalid.`, results: [] }));
      const failed = await h.app.inject({ method: 'GET', url: '/api/v1/places/reverse?lat=6.8&lng=-58.1' });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.code).toBe(PLACES_UNAVAILABLE_CODE);
      stubFetch(() => jsonResponse(200, { status: 'ZERO_RESULTS', results: [] }));
      const none = await h.app.inject({ method: 'GET', url: '/api/v1/places/reverse?lat=6.8&lng=-58.1' });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ success: true, data: { address: null } });
      expect(h.logs()).not.toContain(KEY);
      expect(await counterValue({ provider: 'google', op: 'reverse', outcome: 'auth' })).toBe(1);
    } finally { await h.app.close(); }
  });

  it('a database error from the local provider is NOT reported as an address-search failure (it stays a 500)', async () => {
    const broken: PlacesProvider = {
      autocomplete: async () => { throw new Error('connection terminated'); },
      details: async () => null,
      reverseGeocode: async () => null,
    };
    const health = new PlacesHealth();
    const h = await harness(broken, health, 'local');
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/places/autocomplete?q=kitty' });
      expect(res.statusCode).toBe(500);
      expect(health.readiness('local').status).toBe('unknown');
      expect(h.pages).toHaveLength(0);
    } finally { await h.app.close(); }
  });
});

describe('places routes: persistent failures page ops once, and the page closes when search recovers', () => {
  it(`${PLACES_ALERT_FAILURES} failures in the window page once (deduped key, title, no key or query in the page); recovery resolves it`, async () => {
    let t = Date.UTC(2026, 9, 22, 6, 0, 0);
    const health = new PlacesHealth(() => t);
    const h = await harness(new GooglePlacesProvider(KEY), health);
    try {
      stubFetch(() => googleError(403, 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED', `key ${KEY}`));
      for (let i = 0; i < PLACES_ALERT_FAILURES + 3; i++) {
        const res = await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}`, headers: { 'x-test-user': i % 2 === 0 ? 'u-a' : 'u-b' } });
        expect(res.statusCode).toBe(503);
        t += 1000;
      }
      await vi.waitFor(() => expect(h.pages).toHaveLength(1));
      const page = h.pages[0]!;
      expect(page.key).toBe(PLACES_PAGE_KEY);
      expect(page.title).toBe(PLACES_PAGE_TITLE);
      expect(page.windowSeconds).toBe(PLACES_PAGE_WINDOW_SECONDS);
      expect(page.body).toContain('API_KEY_SERVICE_BLOCKED');
      expect(page.data).toMatchObject({ kind: 'ops_places_failing', provider: 'google', reason: 'auth', failures: PLACES_ALERT_FAILURES });
      expect(JSON.stringify(page)).not.toContain(KEY);
      expect(JSON.stringify(page)).not.toContain(QUERY);

      stubFetch(() => jsonResponse(200, SUGGESTIONS));
      t += PLACES_ALERT_WINDOW_MS;
      const ok = await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}` });
      expect(ok.statusCode).toBe(200);
      await vi.waitFor(() => expect(h.resolves).toBe(1));
      expect(health.readiness('google').status).toBe('ok');
    } finally { await h.app.close(); }
  });

  it('a pager that throws never breaks the 503 the customer gets', async () => {
    const health = new PlacesHealth();
    stubFetch(() => googleError(403, 'PERMISSION_DENIED'));
    vi.stubEnv('PLACES_PROVIDER', 'google');
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.decorate('authenticate', async (request) => { request.user = { userId: 'u-places-loud', role: 'CUSTOMER' }; });
    await app.register(placesRoutes, {
      prefix: '/api/v1/places', provider: new GooglePlacesProvider(KEY), health,
      pager: { page: async () => { throw new Error('ops outbox down'); }, resolve: async () => { throw new Error('ops outbox down'); } },
    });
    try {
      for (let i = 0; i < PLACES_ALERT_FAILURES; i++) {
        const res = await app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}` });
        expect(res.statusCode).toBe(503);
      }
    } finally { await app.close(); }
  });
});

describe('places routes: a caller-caused rejection is that caller\'s own "no matches", never a page or a health change', () => {
  const as = (user: string) => ({ 'x-test-user': user });

  it('autocomplete refused as a bad request (400 INVALID_ARGUMENT) answers 200 [], logs a warning (no query), counts "rejected", pages nobody, leaves health alone', async () => {
    stubFetch(() => googleError(400, 'INVALID_ARGUMENT', undefined, `Invalid input ${QUERY}`));
    let t = Date.UTC(2026, 9, 22, 6, 0, 0);
    const health = new PlacesHealth(() => t);
    const h = await harness(new GooglePlacesProvider(KEY), health);
    try {
      const n = PLACES_ALERT_FAILURES * 3;
      for (let i = 0; i < n; i++) {
        const res = await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}`, headers: as(`u-${i % 4}`) });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true, data: [] });
        t += 1000;
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(h.pages).toHaveLength(0);
      expect(health.readiness('google')).toEqual({ provider: 'google', status: 'unknown', since: null });
      expect(health.detail('google')).toMatchObject({ lastFailure: null, failuresInWindow: 0, callersInWindow: 0 });
      expect(await counterValue({ provider: 'google', op: 'autocomplete', outcome: 'rejected' })).toBe(n);
      const lines = h.logs().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.filter((l) => l['msg'] === 'places provider failure')).toHaveLength(0);
      const rejected = lines.filter((l) => l['msg'] === 'places request rejected');
      expect(rejected).toHaveLength(n);
      expect(rejected[0]!['level']).toBe(40); // warn, not error
      expect(rejected[0]!['places']).toEqual({
        provider: 'google', op: 'autocomplete', reason: 'rejected', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT', queryLength: QUERY.length,
      });
      expect(h.logs()).not.toContain(QUERY);
      expect(h.logs()).not.toContain(KEY);
    } finally { await h.app.close(); }
  });

  it('details and reverse refused as bad requests answer 200 null, and an ok provider stays ok', async () => {
    const health = new PlacesHealth();
    const h = await harness(new GooglePlacesProvider(KEY), health);
    try {
      stubFetch(() => jsonResponse(200, SUGGESTIONS));
      expect((await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}` })).statusCode).toBe(200);
      const okSince = health.readiness('google').since;
      expect(health.readiness('google').status).toBe('ok');
      stubFetch(() => googleError(400, 'INVALID_ARGUMENT'));
      const details = await h.app.inject({ method: 'GET', url: '/api/v1/places/details?placeId=not-a-place', headers: as('u-x') });
      expect(details.statusCode).toBe(200);
      expect(details.json()).toEqual({ success: true, data: null });
      stubFetch(() => jsonResponse(200, { status: 'INVALID_REQUEST', results: [] }));
      const reverse = await h.app.inject({ method: 'GET', url: '/api/v1/places/reverse?lat=6.8&lng=-58.1', headers: as('u-y') });
      expect(reverse.statusCode).toBe(200);
      expect(reverse.json()).toEqual({ success: true, data: { address: null } });
      expect(health.readiness('google')).toEqual({ provider: 'google', status: 'ok', since: okSince });
      expect(await counterValue({ provider: 'google', op: 'details', outcome: 'rejected' })).toBe(1);
      expect(await counterValue({ provider: 'google', op: 'reverse', outcome: 'rejected' })).toBe(1);
      expect(h.pages).toHaveLength(0);
    } finally { await h.app.close(); }
  });

  it(`rejections never top up real failures: ${PLACES_ALERT_FAILURES - 1} provider failures plus a flood of rejections page nobody`, async () => {
    let t = Date.UTC(2026, 9, 22, 6, 0, 0);
    const health = new PlacesHealth(() => t);
    const h = await harness(new GooglePlacesProvider(KEY), health);
    try {
      stubFetch(() => googleError(503, 'UNAVAILABLE'));
      for (let i = 0; i < PLACES_ALERT_FAILURES - 1; i++) {
        expect((await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}`, headers: as(i % 2 ? 'u-a' : 'u-b') })).statusCode).toBe(503);
        t += 1000;
      }
      stubFetch(() => googleError(400, 'INVALID_ARGUMENT'));
      for (let i = 0; i < PLACES_ALERT_FAILURES * 3; i++) {
        expect((await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}`, headers: as(`u-flood-${i}`) })).statusCode).toBe(200);
        t += 1000;
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(h.pages).toHaveLength(0);
      expect(health.detail('google')).toMatchObject({ status: 'failing', failuresInWindow: PLACES_ALERT_FAILURES - 1, lastFailure: { reason: 'upstream' } });
    } finally { await h.app.close(); }
  });

  it('one account hammering a provider failure (quota it burned itself) never pages ops alone; a second customer failing does', async () => {
    let t = Date.UTC(2026, 9, 22, 6, 0, 0);
    const health = new PlacesHealth(() => t);
    const h = await harness(new GooglePlacesProvider(KEY), health);
    try {
      stubFetch(() => googleError(429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'));
      for (let i = 0; i < PLACES_ALERT_FAILURES * 4; i++) {
        expect((await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}`, headers: as('u-hammer') })).statusCode).toBe(503);
        t += 1000;
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(h.pages).toHaveLength(0);
      expect((await h.app.inject({ method: 'GET', url: `/api/v1/places/autocomplete?q=${QUERY}`, headers: as('u-customer') })).statusCode).toBe(503);
      await vi.waitFor(() => expect(h.pages).toHaveLength(1));
      expect(h.pages[0]!.data).toMatchObject({ reason: 'quota' });
      expect(JSON.stringify(h.pages[0])).not.toContain('u-hammer');
      expect(JSON.stringify(h.pages[0])).not.toContain('u-customer');
    } finally { await h.app.close(); }
  });
});

// ---------------------------------------------------------------------------
// 4. Readiness reports the provider and its last known status, never fails on
//    it, and never calls Google.
// ---------------------------------------------------------------------------

function readinessApp(state: Partial<Parameters<typeof registerReadinessRoute>[1]>) {
  const app = Fastify();
  const now = Date.now();
  app.decorate('prisma', { $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
    const sql = Array.from(parts).join(' ');
    if (sql.includes('information_schema.columns') || sql.includes('FROM "_prisma_migrations"')) return [{ ok: true }];
    return [{ nowMs: BigInt(now) }];
  }) } as never);
  app.decorate('redis', { ping: async () => 'PONG', time: async () => [String(Math.floor(now / 1000)), String(now % 1000 * 1000)] } as never);
  registerReadinessRoute(app, { checkQueues: () => true, ...state } as Parameters<typeof registerReadinessRoute>[1]);
  return app;
}

describe('/ready names the address-search provider and its last known status', () => {
  it('a failing provider is reported (provider, status, since) and /ready stays 200 ready, with no Google call', async () => {
    let t = Date.UTC(2026, 9, 22, 6, 0, 0);
    const health = new PlacesHealth(() => t);
    health.recordFailure('autocomplete', { reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED' }, 'u-a');
    const f = stubFetch(() => jsonResponse(200, {}));
    const app = readinessApp({ checkPlaces: () => health.readiness('google') });
    try {
      t += 60_000;
      const res = await app.inject('/ready');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ ready: true, reasons: [], places: { provider: 'google', status: 'failing', since: '2026-10-22T06:00:00.000Z' } });
      expect(body.places).not.toHaveProperty('reason');
      expect(JSON.stringify(body)).not.toContain('PERMISSION_DENIED');
      expect(f).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('a places report that throws is "unknown", never a readiness failure', async () => {
    const app = readinessApp({ checkPlaces: () => { throw new Error('boom'); } });
    try {
      const res = await app.inject('/ready');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ready: true, places: { provider: 'unknown', status: 'unknown', since: null } });
    } finally { await app.close(); }
  });

  it('the shared tracker is the one the readiness wiring reads', () => {
    vi.stubEnv('PLACES_PROVIDER', 'google');
    getPlacesHealth().recordOk();
    expect(getPlacesHealth().readiness(placesProviderName())).toMatchObject({ provider: 'google', status: 'ok' });
    resetPlacesHealthForTests();
    expect(getPlacesHealth().readiness('google').status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 5. The launch smoke: autocomplete "Giftland" in Guyana, one place details,
//    one reverse geocode; PASS/FAIL per call, Google status only, exit code.
// ---------------------------------------------------------------------------

function fakeProvider(over: Partial<PlacesProvider> = {}): PlacesProvider {
  return {
    autocomplete: async () => [{ placeId: 'ChIJgiftland0001', primary: 'Giftland Mall', secondary: 'Turkeyen' }],
    details: async () => ({ placeId: 'ChIJgiftland0001', label: 'Giftland Mall', lat: 6.8193, lng: -58.1166 }),
    reverseGeocode: async () => 'Water Street, Georgetown, Guyana',
    ...over,
  };
}
const AUTH_ERR = () => new PlacesProviderError({ reason: 'auth', httpStatus: 403, googleStatus: 'PERMISSION_DENIED', googleReason: 'API_KEY_SERVICE_BLOCKED' });

describe('places smoke: PASS/FAIL per call', () => {
  it('all three calls answering is PASS x3 and an overall PASS; no place name or address is printed', async () => {
    const result = await runPlacesSmoke(fakeProvider());
    expect(result.pass).toBe(true);
    expect(result.lines.map((l) => [l.call, l.pass])).toEqual([['autocomplete', true], ['details', true], ['reverse', true]]);
    const printed = formatPlacesSmoke(result).join('\n');
    expect(printed).toMatch(/^PASS places autocomplete/m);
    expect(printed).toMatch(/^PASS places details/m);
    expect(printed).toMatch(/^PASS places reverse/m);
    expect(printed).toMatch(/^PLACES SMOKE PASS$/m);
    expect(printed).not.toContain('Giftland Mall');
    expect(printed).not.toContain('Water Street');
  });

  it('a refused key FAILs autocomplete with the Google status, skips details, still tries reverse, and FAILs overall', async () => {
    const reverse = vi.fn(async () => { throw AUTH_ERR(); });
    const result = await runPlacesSmoke(fakeProvider({ autocomplete: async () => { throw AUTH_ERR(); }, reverseGeocode: reverse }));
    expect(result.pass).toBe(false);
    expect(reverse).toHaveBeenCalledOnce();
    const printed = formatPlacesSmoke(result);
    expect(printed).toContain('FAIL places autocomplete: auth (HTTP 403, PERMISSION_DENIED, API_KEY_SERVICE_BLOCKED)');
    expect(printed.find((l) => l.startsWith('FAIL places details'))).toBeDefined();
    expect(printed).toContain('FAIL places reverse: auth (HTTP 403, PERMISSION_DENIED, API_KEY_SERVICE_BLOCKED)');
    expect(printed[printed.length - 1]).toBe('PLACES SMOKE FAIL (3 of 3 calls failed)');
  });

  it.each([
    ['autocomplete finds nothing', fakeProvider({ autocomplete: async () => [] }), 'autocomplete'],
    ['details finds nothing', fakeProvider({ details: async () => null }), 'details'],
    ['details puts the place outside Guyana', fakeProvider({ details: async () => ({ placeId: 'x', label: 'Elsewhere', lat: 40.7, lng: -74 }) }), 'details'],
    ['reverse finds no address', fakeProvider({ reverseGeocode: async () => null }), 'reverse'],
  ] as Array<[string, PlacesProvider, string]>)('%s is a FAIL', async (_name, p, call) => {
    const result = await runPlacesSmoke(p);
    expect(result.pass).toBe(false);
    expect(result.lines.find((l) => l.call === call)?.pass).toBe(false);
  });

  it('asks for "Giftland" restricted to Guyana, then details for the first suggestion, then one reverse geocode', async () => {
    const autocomplete = vi.fn(fakeProvider().autocomplete);
    const details = vi.fn(fakeProvider().details);
    const reverseGeocode = vi.fn(fakeProvider().reverseGeocode);
    await runPlacesSmoke({ autocomplete, details, reverseGeocode });
    expect(autocomplete).toHaveBeenCalledWith('Giftland');
    expect(details).toHaveBeenCalledWith('ChIJgiftland0001');
    expect(reverseGeocode).toHaveBeenCalledOnce();
  });
});

describe('places smoke command: config refusals, exit codes, and the key never printed', () => {
  async function run(env: Record<string, string | undefined>) {
    const out: string[] = [];
    const code = await placesSmokeMain(env, (line) => out.push(line));
    return { code, out };
  }

  it('refuses (exit 2) when the provider is not google, or the key is missing', async () => {
    const f = stubFetch(() => jsonResponse(200, {}));
    let r = await run({ PLACES_PROVIDER: 'osm', GOOGLE_MAPS_API_KEY_BACKEND: KEY });
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toMatch(/^FAIL places smoke: PLACES_PROVIDER/m);
    r = await run({ PLACES_PROVIDER: 'google' });
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toMatch(/GOOGLE_MAPS_API_KEY_BACKEND is not set/);
    expect(f).not.toHaveBeenCalled();
  });

  it('a live-shaped success exits 0, calling Places (New) for "Giftland" in Guyana and the Geocoding API', async () => {
    stubFetch((url) => {
      const u = new URL(url);
      if (u.hostname === 'places.googleapis.com' && u.pathname === '/v1/places:autocomplete') return jsonResponse(200, SUGGESTIONS);
      if (u.hostname === 'places.googleapis.com' && u.pathname.startsWith('/v1/places/')) return jsonResponse(200, PLACE);
      return jsonResponse(200, GEOCODE_OK);
    });
    const r = await run({ PLACES_PROVIDER: 'google', GOOGLE_MAPS_API_KEY_BACKEND: KEY });
    expect(r.code).toBe(0);
    expect(r.out).toContain('PLACES SMOKE PASS');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: 'Giftland', includedRegionCodes: ['gy'] });
    expect(calls.map((c) => { const u = new URL(c.url); return `${u.protocol}//${u.hostname}${u.pathname}`; })).toEqual([
      'https://places.googleapis.com/v1/places:autocomplete',
      'https://places.googleapis.com/v1/places/ChIJgiftland0001',
      'https://maps.googleapis.com/maps/api/geocode/json',
    ]);
    expect(r.out.join('\n')).not.toContain(KEY);
  });

  it('a refused key exits 1 and prints the Google status, never the key or the message Google wrote', async () => {
    stubFetch((url) => new URL(url).hostname === 'maps.googleapis.com'
      ? jsonResponse(200, { status: 'REQUEST_DENIED', error_message: `The provided API key ${KEY} is invalid.`, results: [] })
      : googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', `API key not valid: ${KEY}`));
    const r = await run({ PLACES_PROVIDER: 'google', GOOGLE_MAPS_API_KEY_BACKEND: KEY });
    expect(r.code).toBe(1);
    const printed = r.out.join('\n');
    expect(printed).toContain('FAIL places autocomplete: auth (HTTP 400, INVALID_ARGUMENT, API_KEY_INVALID)');
    expect(printed).toContain('FAIL places reverse: auth (HTTP 200, REQUEST_DENIED)');
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain('not valid');
  });
});
