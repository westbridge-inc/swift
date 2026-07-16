import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { redisPlugin } from '../plugins/redis';
import { observabilityPlugin } from '../plugins/observability';

// ---------------------------------------------------------------------------
// Scheduler liveness (launch-readiness Phase 6): the worker beats a Redis key
// each minute; the metric exposes its AGE so a dead worker — which silently
// stops hold-release, expiry sweeps and settlements — becomes alertable.
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['METRICS_TOKEN'] = 'test-metrics-token';
  app = Fastify({ logger: false });
  await app.register(redisPlugin);
  await app.register(observabilityPlugin);
  await app.ready();
});

afterAll(async () => {
  delete process.env['METRICS_TOKEN'];
  await app.redis.del('scheduler:heartbeat');
  await app.close();
});

const scrape = () =>
  app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer test-metrics-token' } });

describe('scheduler heartbeat metric', () => {
  it('a fresh beat reports a small age', async () => {
    await app.redis.set('scheduler:heartbeat', String(Date.now()));
    const res = await scrape();
    expect(res.statusCode).toBe(200);
    const line = res.body.split('\n').find((l) => l.startsWith('swift_scheduler_heartbeat_age_seconds'));
    expect(line).toBeDefined();
    const age = Number(line!.split(' ')[1]);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(10);
  });

  it('a stale beat reports a large, alertable age', async () => {
    await app.redis.set('scheduler:heartbeat', String(Date.now() - 600_000)); // 10 min ago
    const res = await scrape();
    const line = res.body.split('\n').find((l) => l.startsWith('swift_scheduler_heartbeat_age_seconds'));
    const age = Number(line!.split(' ')[1]);
    expect(age).toBeGreaterThan(300); // past a sane alert threshold
  });

  it('never beaten reports -1', async () => {
    await app.redis.del('scheduler:heartbeat');
    const res = await scrape();
    const line = res.body.split('\n').find((l) => l.startsWith('swift_scheduler_heartbeat_age_seconds'));
    expect(Number(line!.split(' ')[1])).toBe(-1);
  });
});
