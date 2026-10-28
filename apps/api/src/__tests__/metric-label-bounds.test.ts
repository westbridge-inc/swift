import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerTenantHeaderScope, VENDOR_STORE_HEADER } from '../plugins/tenant-header-scope';
import { registerReadinessRoute, registerRoutedWhileDegradedCounter, getLastReadiness, resetReadinessForTests, type RuntimeReadinessState } from '../plugins/readiness';
import { routedWhileDegradedCounter, unexpectedTenantHeaderCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// A metric label is a series kept in memory for the life of the process and
// printed on every scrape. Request-path text must never become one: a caller
// who can choose the path could otherwise mint a new series per request. The
// family label is taken from the MATCHED route's template (bounded by the
// routes this server registers), and a request no route matched is ONE
// 'unmatched' series. The not-found handler is behind the rate limiter too.
// ---------------------------------------------------------------------------

/** A path segment no route has: long, lowercase letters and dashes only. */
function randomSegment(length = 600): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz-';
  const bytes = randomBytes(length);
  let out = 'z';
  for (let i = 1; i < length; i += 1) out += letters[bytes[i]! % letters.length];
  return out;
}

const N = 120;

function randomPaths(): string[] {
  const paths: string[] = [];
  for (let i = 0; i < N; i += 1) {
    paths.push(i % 3 === 0 ? `/${randomSegment()}` : i % 3 === 1 ? `/api/v1/${randomSegment()}` : `/api/v1/${randomSegment()}/x/${randomSegment(40)}`);
  }
  return paths;
}

async function seriesOf(metric: { get: () => Promise<{ values: Array<{ labels: Record<string, string | number | undefined> }> }> }, label: string): Promise<Set<string>> {
  const values = (await metric.get()).values;
  return new Set(values.map((v) => String(v.labels[label])));
}

describe('the tenant-header leak counter: request-path text never becomes its family label', () => {
  async function build(mode: 'ignore' | 'reject'): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerTenantHeaderScope(app, mode);
    app.get('/api/v1/customer/home', async () => ({ ok: true }));
    app.get('/api/v1/public/storefronts/:slug', async () => ({ ok: true }));
    app.get('/health', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  for (const mode of ['ignore', 'reject'] as const) {
    it(`${mode} mode: ${N} random long unmatched paths add at most one series, named 'unmatched'`, async () => {
      const app = await build(mode);
      try {
        const before = await seriesOf(unexpectedTenantHeaderCounter, 'family');
        for (const url of randomPaths()) {
          const res = await app.inject({ method: 'GET', url, headers: { [VENDOR_STORE_HEADER]: 'store-a' } });
          expect(res.statusCode, url.slice(0, 40)).toBe(mode === 'reject' ? 400 : 404);
        }
        const after = await seriesOf(unexpectedTenantHeaderCounter, 'family');
        const added = [...after].filter((f) => !before.has(f));
        expect(added.length).toBeLessThanOrEqual(1);
        for (const f of after) expect(f.length, f.slice(0, 40)).toBeLessThanOrEqual(64);
        expect(after.has('unmatched')).toBe(true);
      } finally {
        await app.close();
      }
    });
  }

  it('a matched route keeps its family from the route template, never the concrete path', async () => {
    const app = await build('ignore');
    try {
      const count = async (family: string) => (await unexpectedTenantHeaderCounter.get()).values.find((v) => v.labels['outcome'] === 'ignored' && v.labels['family'] === family)?.value ?? 0;
      const before = { public: await count('public'), customer: await count('customer'), health: await count('health') };
      await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/${randomSegment(40)}`, headers: { [VENDOR_STORE_HEADER]: 'store-a' } });
      await app.inject({ method: 'GET', url: '/api/v1/customer/home?x=1', headers: { [VENDOR_STORE_HEADER]: 'store-a' } });
      await app.inject({ method: 'GET', url: '/health', headers: { [VENDOR_STORE_HEADER]: 'store-a' } });
      expect(await count('public')).toBe(before.public + 1);
      expect(await count('customer')).toBe(before.customer + 1);
      expect(await count('health')).toBe(before.health + 1);
    } finally {
      await app.close();
    }
  });
});

describe('the routed-while-degraded counter: request-path text never becomes its family label', () => {
  it(`${N} random long paths answered while not ready add at most one series`, async () => {
    resetReadinessForTests();
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    const prisma = { $queryRaw: vi.fn(async () => { throw new Error('database down'); }) };
    const redis = { ping: vi.fn(async () => 'PONG'), time: vi.fn(async () => [String(Math.floor(Date.now() / 1_000)), '0']) };
    app.decorate('prisma', prisma as never);
    app.decorate('redis', redis as never);
    const state: RuntimeReadinessState = { checkQueues: () => true, checkConsumers: () => true, checkRealtime: () => true, checkWorker: () => 'ok', checkBoot: () => true };
    registerReadinessRoute(app, state);
    registerRoutedWhileDegradedCounter(app);
    app.get('/api/v1/customer/home', async () => ({ ok: true }));
    try {
      await app.inject({ method: 'GET', url: '/ready' });
      expect(getLastReadiness()?.ready).toBe(false);
      const before = await seriesOf(routedWhileDegradedCounter, 'family');
      for (const url of randomPaths()) await app.inject({ method: 'GET', url });
      const after = await seriesOf(routedWhileDegradedCounter, 'family');
      const added = [...after].filter((f) => !before.has(f));
      expect(added.length).toBeLessThanOrEqual(1);
      for (const f of after) expect(f.length, f.slice(0, 40)).toBeLessThanOrEqual(64);
      // a matched route still counts under its own family
      const customer = async () => (await routedWhileDegradedCounter.get()).values.find((v) => v.labels['family'] === 'customer')?.value ?? 0;
      const c0 = await customer();
      await app.inject({ method: 'GET', url: '/api/v1/customer/home' });
      expect(await customer()).toBe(c0 + 1);
    } finally {
      await app.close();
      resetReadinessForTests();
    }
  });
});

describe('the not-found handler is behind the rate limiter', () => {
  it('unmatched paths count against the caller\'s ceiling; under it the 404 shape is unchanged', async () => {
    const app = Fastify({ logger: false });
    // Same order as app.ts: the error handler (and its not-found handler) first, the limiter after.
    registerErrorHandler(app);
    await app.register(rateLimit, { max: 3, timeWindow: '1 minute' });
    app.get('/api/v1/customer/home', async () => ({ ok: true }));
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({ method: 'GET', url: `/api/v1/nothing-here-${i}?q=secret`, remoteAddress: '10.44.0.1' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ success: false, error: { code: 'NOT_FOUND', message: `Route GET /api/v1/nothing-here-${i} not found` } });
      }
      const limited = await app.inject({ method: 'GET', url: '/api/v1/nothing-here-4', remoteAddress: '10.44.0.1' });
      expect(limited.statusCode).toBe(429);
      // another caller has its own bucket
      const other = await app.inject({ method: 'GET', url: '/api/v1/nothing-here-5', remoteAddress: '10.44.0.2' });
      expect(other.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('an app with no limiter registered still answers the plain 404', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({ method: 'GET', url: '/nowhere' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Route GET /nowhere not found' } });
      }
    } finally {
      await app.close();
    }
  });
});
