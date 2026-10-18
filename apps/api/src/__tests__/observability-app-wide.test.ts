import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { registerErrorHandler } from '../middleware/error-handler';
import { observabilityPlugin, resetSentryForTests } from '../plugins/observability';
import { AppError } from '../utils/errors';

// ---------------------------------------------------------------------------
// [OBS-1] Launch monitoring must see EVERY route, not only /metrics.
//
// observabilityPlugin's onResponse hook feeds swift_http_request_duration_seconds
// (latency + status by route) and the API's 5xx reach the error tracker. Both
// have to cover the whole API. A plain async plugin is ENCAPSULATED by Fastify:
// its hooks bind only to the routes it declares itself, so the histogram only
// ever held /metrics and the 5xx capture only covered /metrics (the WALL
// journeys run, 17 Oct, measured 0 requests).
//
// The 5xx capture is decided on the FINAL status the error handler sends — a
// ZodError (400) or a Prisma "not found" (404) carries no statusCode of its own
// and is still the caller's problem, never ours.
//
// Labels are route TEMPLATES (":slug"), never the raw URL: no ids, tokens or
// phone numbers in a metric label (GUARDRAILS §2), and an unknown path is one
// bounded "unmatched" series however many paths a scanner tries.
// ---------------------------------------------------------------------------

vi.mock('@sentry/node', () => ({ init: vi.fn(), captureException: vi.fn() }));

const TOKEN = 'obs-metrics-token';
const SERIES = 'swift_http_request_duration_seconds_count';

interface Series { labels: Record<string, string>; count: number }

function histogramCounts(body: string): Series[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith(`${SERIES}{`))
    .map((line) => {
      const m = /^swift_http_request_duration_seconds_count\{(.*)\} (\S+)$/.exec(line);
      if (!m) throw new Error(`unparsable series line: ${line}`);
      const labels = Object.fromEntries([...m[1]!.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1]!, x[2]!]));
      return { labels, count: Number(m[2]) };
    });
}

function countFor(series: Series[], want: { method: string; route: string; status: string }): number {
  const hit = series.find((s) => s.labels['method'] === want.method && s.labels['route'] === want.route && s.labels['status'] === want.status);
  return hit?.count ?? 0;
}

async function scrape(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.statusCode).toBe(200);
  return res.body;
}

const captured = () => vi.mocked(Sentry.captureException).mock.calls;

class PrismaClientKnownRequestError extends Error {
  // The error handler recognises Prisma's known errors by constructor NAME.
  constructor(public code: string) { super(`prisma ${code}`); }
}

describe('[OBS-1] observability hooks cover routes outside the plugin (composition like app.ts)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.stubEnv('SENTRY_DSN', 'https://public@sentry.invalid/1');
    vi.stubEnv('METRICS_TOKEN', TOKEN);
    resetSentryForTests();
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(observabilityPlugin);
    // A route module registered AFTER the plugin, in its own encapsulated
    // context with a prefix — exactly how app.ts mounts every API module.
    await app.register(async (r) => {
      r.get('/orders/:orderId', async () => ({ ok: true }));
      r.get('/boom', async () => { throw new Error('ledger write exploded'); });
      r.get('/upstream', async () => { throw new AppError(503, 'MMG_LOOKUP_UNAVAILABLE', 'Provider unreachable'); });
      r.get('/gone', async () => { throw new AppError(404, 'NOT_FOUND', 'No such order'); });
      r.get('/invalid', async () => z.object({ phone: z.string() }).parse({}));
      r.get('/stale-record', async () => { throw new PrismaClientKnownRequestError('P2025'); });
    }, { prefix: '/api/v1/probe' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    resetSentryForTests();
  });

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  it('records a normal route in the latency histogram under its route TEMPLATE, never the raw id', async () => {
    const before = countFor(histogramCounts(await scrape(app)), { method: 'GET', route: '/api/v1/probe/orders/:orderId', status: '200' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe/orders/ord_obs_7f3a9c' });
    expect(res.statusCode).toBe(200);
    const body = await scrape(app);
    expect(countFor(histogramCounts(body), { method: 'GET', route: '/api/v1/probe/orders/:orderId', status: '200' })).toBe(before + 1);
    expect(body).not.toContain('ord_obs_7f3a9c');
  });

  it('collapses an unknown path into one bounded "unmatched" series (no raw URL in a label)', async () => {
    const before = countFor(histogramCounts(await scrape(app)), { method: 'GET', route: 'unmatched', status: '404' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe/lookup/5926001234?ref=abc' });
    expect(res.statusCode).toBe(404);
    const body = await scrape(app);
    expect(countFor(histogramCounts(body), { method: 'GET', route: 'unmatched', status: '404' })).toBe(before + 1);
    expect(body).not.toContain('5926001234');
    for (const s of histogramCounts(body)) expect(s.labels['route']).toMatch(/^(unmatched|\/[A-Za-z0-9/_:*.-]*)$/);
  });

  it('a thrown 500 on a normal route reaches the error tracker exactly once, with the route template', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe/boom' });
    expect(res.statusCode).toBe(500);
    expect(captured()).toHaveLength(1);
    const [err, ctx] = captured()[0]!;
    expect((err as Error).message).toBe('ledger write exploded');
    expect(ctx).toEqual({ extra: expect.objectContaining({ method: 'GET', url: '/api/v1/probe/boom' }) });
    const body = await scrape(app);
    expect(countFor(histogramCounts(body), { method: 'GET', route: '/api/v1/probe/boom', status: '500' })).toBe(1);
  });

  it('a deliberate 5xx (AppError 503) is ours too: captured exactly once', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe/upstream' });
    expect(res.statusCode).toBe(503);
    expect(captured()).toHaveLength(1);
    expect((captured()[0]![0] as AppError).code).toBe('MMG_LOOKUP_UNAVAILABLE');
  });

  it('a 404 never reaches the error tracker — thrown, unmatched, or a Prisma not-found', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/gone' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/no-such-route' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/stale-record' })).statusCode).toBe(404);
    expect(captured()).toHaveLength(0);
  });

  it('a validation error (ZodError → 400, no statusCode of its own) never reaches the error tracker', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe/invalid' });
    expect(res.statusCode).toBe(400);
    expect(captured()).toHaveLength(0);
    const body = await scrape(app);
    expect(countFor(histogramCounts(body), { method: 'GET', route: '/api/v1/probe/invalid', status: '400' })).toBe(1);
  });

  it('/metrics still requires its token: 404 when METRICS_TOKEN is unset, 401 on a wrong one, and neither is captured', async () => {
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    vi.stubEnv('METRICS_TOKEN', '');
    try {
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(404);
    } finally {
      vi.stubEnv('METRICS_TOKEN', TOKEN);
    }
    expect(captured()).toHaveLength(0);
  });
});

describe('[OBS-1] the real composition root (buildApp) measures and captures app-wide', () => {
  const PROBE_ROUTE = '/api/v1/public/storefronts/:slug';
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.stubEnv('RUN_WORKERS', '0');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('SENTRY_DSN', 'https://public@sentry.invalid/1');
    vi.stubEnv('METRICS_TOKEN', TOKEN);
    // Startup probes (search, routing) stay off the network.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
    resetSentryForTests();
    const { buildApp } = await import('../app');
    // One real route's handler is swapped for one that throws, through the
    // composition root's own onRoute seam: every hook, preHandler and the real
    // error handler around it stay exactly as production wires them.
    app = await buildApp({
      onRoute: (route: RouteOptions) => {
        if (route.url === PROBE_ROUTE && route.method === 'GET') {
          route.handler = async () => { throw new Error('storefront read exploded'); };
        }
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetSentryForTests();
  });

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  it('a real module route (legal pages, mounted with a prefix) lands in the histogram by template', async () => {
    const before = countFor(histogramCounts(await scrape(app)), { method: 'GET', route: '/legal/terms', status: '200' });
    expect((await app.inject({ method: 'GET', url: '/legal/terms' })).statusCode).toBe(200);
    expect(countFor(histogramCounts(await scrape(app)), { method: 'GET', route: '/legal/terms', status: '200' })).toBe(before + 1);
  });

  it('a 500 thrown on a real API route is measured under its template and captured exactly once', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/storefronts/obs-probe-store-4411' });
    expect(res.statusCode).toBe(500);
    expect(captured()).toHaveLength(1);
    expect((captured()[0]![0] as Error).message).toBe('storefront read exploded');
    expect(captured()[0]![1]).toEqual({ extra: expect.objectContaining({ method: 'GET', url: PROBE_ROUTE }) });
    const body = await scrape(app);
    expect(countFor(histogramCounts(body), { method: 'GET', route: PROBE_ROUTE, status: '500' })).toBeGreaterThanOrEqual(1);
    expect(body).not.toContain('obs-probe-store-4411');
  });

  it('an unknown path is one "unmatched" 404 series and never reaches the error tracker', async () => {
    const before = countFor(histogramCounts(await scrape(app)), { method: 'GET', route: 'unmatched', status: '404' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/no-such-module/obs-raw-9931' })).statusCode).toBe(404);
    const body = await scrape(app);
    expect(countFor(histogramCounts(body), { method: 'GET', route: 'unmatched', status: '404' })).toBe(before + 1);
    expect(body).not.toContain('obs-raw-9931');
    expect(captured()).toHaveLength(0);
  });

  it('/metrics on the real app still refuses a missing or wrong token', async () => {
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect(captured()).toHaveLength(0);
  });
});
