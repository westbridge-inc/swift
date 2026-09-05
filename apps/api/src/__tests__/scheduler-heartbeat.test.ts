import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { join } from 'path';
import { redisPlugin } from '../plugins/redis';
import { observabilityPlugin } from '../plugins/observability';
import {
  evaluateSchedulerHealth,
  schedulerStallMs,
  DEFAULT_SCHEDULER_STALL_MINUTES,
} from '../utils/scheduler-health';

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

// ---------------------------------------------------------------------------
// [REPORT-037 R037-27] The stall threshold is total-parsed.
//
// It used to be `Number(env ?? '5') * 60_000` at the call site, and
// `Number('Infinity')` is Infinity — which makes `ageMs <= stallMs` true
// forever and silently disables BOTH paging paths. That matters more than it
// looks: the scheduler heartbeat is the fallback covering every other
// heartbeat-driven alarm (pool saturation, dead letters, routing degradation
// all ride the same job), so turning it off quietly turns those off too.
// ---------------------------------------------------------------------------
describe('schedulerStallMs — junk cannot disable the pager [R037-27]', () => {
  it('defaults to the documented five minutes', () => {
    expect(schedulerStallMs({})).toBe(5 * 60_000);
    expect(DEFAULT_SCHEDULER_STALL_MINUTES).toBe(5);
  });

  it('accepts a real value', () => {
    expect(schedulerStallMs({ SCHEDULER_STALL_ALERT_MINUTES: '12' })).toBe(12 * 60_000);
  });

  it('refuses Infinity — the value that fails SILENT', () => {
    // The dangerous one. NaN would page constantly (loud, and therefore
    // noticed); Infinity pages never.
    for (const junk of ['Infinity', '-Infinity', '1e999']) {
      expect(schedulerStallMs({ SCHEDULER_STALL_ALERT_MINUTES: junk })).toBe(5 * 60_000);
    }
  });

  it('refuses junk, blanks and non-positive values', () => {
    for (const junk of ['', '   ', 'soon', '0', '-3', 'NaN']) {
      expect(schedulerStallMs({ SCHEDULER_STALL_ALERT_MINUTES: junk })).toBe(5 * 60_000);
    }
  });

  it('an Infinity threshold would have disabled BOTH paging paths', () => {
    // The proof that the parse matters, expressed through the evaluator: with
    // an infinite window nothing is ever stale and nothing was ever
    // never-booted.
    const infinite = Infinity;
    expect(evaluateSchedulerHealth({ beat: String(Date.now() - 86_400_000), nowMs: Date.now(), bootAtMs: 0, stallMs: infinite }).page).toBe(false);
    expect(evaluateSchedulerHealth({ beat: null, nowMs: Date.now(), bootAtMs: 0, stallMs: infinite }).page).toBe(false);
    // With the total-parsed value, both page.
    const real = schedulerStallMs({ SCHEDULER_STALL_ALERT_MINUTES: 'Infinity' });
    expect(evaluateSchedulerHealth({ beat: String(Date.now() - 86_400_000), nowMs: Date.now(), bootAtMs: 0, stallMs: real }).page).toBe(true);
    expect(evaluateSchedulerHealth({ beat: null, nowMs: Date.now(), bootAtMs: 0, stallMs: real }).page).toBe(true);
  });

  it('the server reads it through the parser, not through a bare Number()', () => {
    // the /health route lives in the composition root, src/app.ts (server.ts only boots it)
    const server = readFileSync(join(process.cwd(), 'src/app.ts'), 'utf8')
      .split('\n')
      .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
      .join('\n');
    expect(server).toContain('schedulerStallMs()');
    expect(server).not.toMatch(/Number\(process\.env\['SCHEDULER_STALL_ALERT_MINUTES'\]/);
  });
});
