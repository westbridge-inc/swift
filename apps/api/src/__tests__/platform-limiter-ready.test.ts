import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readinessCacheMs, registerReadinessRoute, type RuntimeReadinessState } from '../plugins/readiness';
import { RATE_LIMIT_NAMESPACE, rateLimitOptions, watchRateLimitStore } from '../utils/rate-limit-options';

// ---------------------------------------------------------------------------
// [row 331 · APP-PLATFORM-GUARDS] A Redis blip must not take the API down.
//
// (b) Production's limiter kept its counters in Redis with no `skipOnError`:
//     @fastify/rate-limit 10.3 re-throws a store error, the limiter's hook runs
//     on every route, so one lost connection answered EVERY request with a 500,
//     the /live probe included (G5-F3 in gold-5-plat pins the composition on a
//     real Redis). Now the limiter fails OPEN on a store error, the store's
//     client logs an alert while it is down, and /live never consults the
//     limiter at all: liveness touches no dependency.
// (c) /ready is public (Caddy proxies every API path but /metrics) and ran the
//     catalog SQL, a Redis ping and the clock probe on every request. Its
//     verdict is now cached briefly (one evaluation shared by concurrent
//     callers), so a public caller cannot turn it into load. Its shape is kept:
//     booleans, reasons and a fixed-text routing report, which the deploy
//     scripts and the coordinator's gates read.
// ---------------------------------------------------------------------------

/** A Redis client as the limiter's store sees it, with the connection gone:
 *  every INCR fails at once (offline queue off), as production's does. */
function deadStore() {
  const calls = { n: 0 };
  const client = {
    defineCommand() {},
    rateLimit(...args: unknown[]) {
      calls.n += 1;
      const cb = args[args.length - 1] as (err: Error | null, res: unknown) => void;
      cb(new Error("Stream isn't writeable and enableOfflineQueue options is false"), null);
    },
  };
  return { client, calls };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('[row 331 · b] the production limiter fails OPEN on a store error, and says so', () => {
  it('composed as app.ts composes it, an ordinary request is served while the store is gone', async () => {
    const { client, calls } = deadStore();
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(rateLimit, rateLimitOptions({ store: client as never, verify: () => { throw new Error('no tokens here'); }, max: 200 }));
    app.get('/api/v1/customer/home', async () => ({ ok: true }));
    app.post('/api/v1/auth/send-otp', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    const home = await app.inject({ method: 'GET', url: '/api/v1/customer/home', remoteAddress: '10.33.1.2' });
    expect(home.statusCode).toBe(200);
    // A per-route ceiling (the OTP routes') inherits the same policy.
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/send-otp', remoteAddress: '10.33.1.2' });
    expect(otp.statusCode).toBe(200);
    expect(calls.n).toBe(2);
  });

  it('the options are production\'s: Redis counters under the shared namespace, the verified-token key, a one-minute window', () => {
    const { client } = deadStore();
    const opts = rateLimitOptions({ store: client as never, verify: () => ({ userId: 'u' }), max: 200 });
    expect(opts).toMatchObject({ redis: client, nameSpace: RATE_LIMIT_NAMESPACE, max: 200, timeWindow: '1 minute', skipOnError: true });
    expect(RATE_LIMIT_NAMESPACE).toBe('swift-rl:');
    expect(typeof opts.keyGenerator).toBe('function');
    // dev/test: no store, the in-memory one; same policy otherwise
    const local = rateLimitOptions({ verify: () => ({ userId: 'u' }), max: 50 });
    expect(local).not.toHaveProperty('redis');
    expect(local).toMatchObject({ max: 50, timeWindow: '1 minute', skipOnError: true });
  });

  it('the store client logs one alert per minute while it is down, and once when it is back; never the error text', () => {
    const store = new EventEmitter();
    const log = { error: vi.fn(), info: vi.fn() };
    let now = 1_000_000;
    watchRateLimitStore(store as never, log, () => now);
    const secret = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), { code: 'ECONNREFUSED' });
    store.emit('error', secret);
    store.emit('reconnecting');
    store.emit('error', secret);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![1]).toMatch(/rate limiter.*failing OPEN/i);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('10.0.0.5');
    expect(log.error.mock.calls[0]![0]).toMatchObject({ event: 'error', code: 'ECONNREFUSED' });
    now += 61_000;
    store.emit('reconnecting');
    expect(log.error).toHaveBeenCalledTimes(2);
    store.emit('ready');
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![1]).toMatch(/rate limiter.*reachable again/i);
    store.emit('ready'); // a healthy reconnect after no trouble says nothing
    expect(log.info).toHaveBeenCalledTimes(1);
    store.emit('end'); // the connection gave up: down again, alerted at once (the window restarted at recovery)
    expect(log.error).toHaveBeenCalledTimes(3);
  });

  it('app.ts builds its limiter from these two functions and nothing else', () => {
    const appTs = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');
    expect(appTs).toMatch(/createRateLimitStore\(/);
    expect(appTs).toMatch(/await app\.register\(rateLimit, rateLimitOptions\(/);
    expect(appTs).not.toMatch(/new Redis\(/);
  });
});

/** A fake app whose readiness evaluations are counted. */
function readyApp() {
  const evaluations = { n: 0 };
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorate('prisma', {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = Array.from(parts).join(' ');
      if (sql.includes('information_schema.columns') || sql.includes('FROM "_prisma_migrations"')) return [{ ok: true }];
      return [{ nowMs: BigInt(Date.now()) }];
    }),
  } as never);
  app.decorate('redis', {
    ping: vi.fn(async () => 'PONG'),
    time: vi.fn(async () => { const t = Date.now(); return [String(Math.floor(t / 1_000)), String((t % 1_000) * 1_000)]; }),
  } as never);
  let queues = true;
  const state: RuntimeReadinessState = { checkQueues: () => { evaluations.n += 1; return queues; } };
  registerReadinessRoute(app, state);
  return { app, evaluations, setQueues: (v: boolean) => { queues = v; } };
}

describe('[row 331 · c] /ready caches its verdict briefly', () => {
  it('repeat and concurrent callers inside the window share one evaluation; after it, the next caller re-evaluates', async () => {
    vi.stubEnv('READINESS_CACHE_MS', '300');
    const { app, evaluations, setQueues } = readyApp();
    const first = await app.inject({ method: 'GET', url: '/ready' });
    expect(first.statusCode).toBe(200);
    await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/ready' })));
    expect(evaluations.n).toBe(1);
    // A dependency fails inside the window: the cached verdict stands until the window ends ...
    setQueues(false);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 350));
    // ... then the next caller sees it.
    const after = await app.inject({ method: 'GET', url: '/ready' });
    expect(after.statusCode).toBe(503);
    expect(after.json().reasons).toEqual(['queueInit']);
    expect(evaluations.n).toBe(2);
  });

  it('the shape the deploy scripts and gates read is unchanged: booleans, reasons, a timestamp', async () => {
    vi.stubEnv('READINESS_CACHE_MS', '300');
    const { app } = readyApp();
    const body = (await app.inject({ method: 'GET', url: '/ready' })).json();
    expect(Object.keys(body).sort()).toEqual(['deps', 'ready', 'reasons', 'timestamp']);
    expect(Object.values(body.deps).every((v) => typeof v === 'boolean')).toBe(true);
  });

  it('the window: 2 s by default, 0 in the test runtime, tunable 0..5000 ms, anything else falls back', () => {
    expect(readinessCacheMs({ NODE_ENV: 'production' })).toBe(2_000);
    expect(readinessCacheMs({ NODE_ENV: 'loadtest' })).toBe(2_000);
    expect(readinessCacheMs({ NODE_ENV: 'development' })).toBe(2_000);
    expect(readinessCacheMs({ NODE_ENV: 'test' })).toBe(0);
    expect(readinessCacheMs({ NODE_ENV: 'production', READINESS_CACHE_MS: '0' })).toBe(0);
    expect(readinessCacheMs({ NODE_ENV: 'production', READINESS_CACHE_MS: '5000' })).toBe(5_000);
    for (const bad of ['', 'two', '-1', '1.5', '5001', '1e3']) {
      expect(readinessCacheMs({ NODE_ENV: 'production', READINESS_CACHE_MS: bad }), bad).toBe(2_000);
    }
  });

  it('with no window (the test runtime default) every caller evaluates, as before', async () => {
    const { app, evaluations } = readyApp();
    await app.inject({ method: 'GET', url: '/ready' });
    await app.inject({ method: 'GET', url: '/ready' });
    expect(evaluations.n).toBe(2);
  });
});
