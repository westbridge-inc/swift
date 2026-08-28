import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveDatabaseUrl,
  poolSizeFor,
  poolTimeoutSeconds,
  DEFAULT_API_POOL,
  DEFAULT_WORKER_POOL,
  DEFAULT_POOL_TIMEOUT_SECONDS,
} from '../utils/db-pool';

/**
 * [P1 · WS-8.3] The worker declares 19 concurrent BullMQ jobs against a Prisma
 * pool that defaulted to (cpus*2)+1 — five on the 2-vCPU box this deploys to.
 * The pool-saturation alarm existed; the dial it told you to turn did not.
 *
 * These tests guard three separate things, and the third is the one that keeps
 * the defect from coming back:
 *   1. the pure resolver's behaviour, including every way it must NOT act;
 *   2. that the number is still big enough for the jobs actually declared;
 *   3. that both client constructions are still WIRED to the resolver — the
 *      units can all pass while nothing calls them (see #807: every layer
 *      passed its own tests and the chain between them was broken).
 */

const BASE = 'postgresql://swift:swift@localhost:5432/swift';

describe('resolveDatabaseUrl — supplying the missing number', () => {
  it('sizes the worker pool for its declared job concurrency', () => {
    const url = new URL(resolveDatabaseUrl(BASE, 'worker', {})!);
    expect(url.searchParams.get('connection_limit')).toBe(String(DEFAULT_WORKER_POOL));
    expect(url.searchParams.get('pool_timeout')).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS));
  });

  it('sizes the API pool for request concurrency, not for the CPU count', () => {
    const url = new URL(resolveDatabaseUrl(BASE, 'api', {})!);
    expect(url.searchParams.get('connection_limit')).toBe(String(DEFAULT_API_POOL));
  });

  it('keeps every parameter the connection string already carried', () => {
    const url = new URL(resolveDatabaseUrl(`${BASE}?schema=public&sslmode=require`, 'api', {})!);
    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('connection_limit')).toBe(String(DEFAULT_API_POOL));
  });

  it('honours a pool_timeout the operator already stated', () => {
    const url = new URL(resolveDatabaseUrl(`${BASE}?pool_timeout=45`, 'worker', {})!);
    expect(url.searchParams.get('pool_timeout')).toBe('45');
    expect(url.searchParams.get('connection_limit')).toBe(String(DEFAULT_WORKER_POOL));
  });
});

describe('resolveDatabaseUrl — the cases where it must NOT act', () => {
  it('never overrules an explicit connection_limit', () => {
    // An operator who states a limit may have sized it against a PgBouncer
    // budget this process cannot see. Returned byte-for-byte unchanged.
    const stated = `${BASE}?connection_limit=3`;
    expect(resolveDatabaseUrl(stated, 'worker', {})).toBe(stated);
  });

  it('leaves a non-Postgres connection string alone', () => {
    const other = 'mysql://user:pass@localhost:3306/db';
    expect(resolveDatabaseUrl(other, 'api', {})).toBe(other);
  });

  it('fails OPEN on anything it cannot parse', () => {
    // A pool hint is not worth refusing to boot over.
    expect(resolveDatabaseUrl('not a url at all', 'api', {})).toBe('not a url at all');
  });

  it('passes an unset URL straight through', () => {
    expect(resolveDatabaseUrl(undefined, 'api', {})).toBeUndefined();
  });
});

describe('env overrides are total-parsed', () => {
  it('accepts a whole number', () => {
    expect(poolSizeFor('worker', { DB_POOL_SIZE_WORKER: '40' })).toBe(40);
    expect(poolSizeFor('api', { DB_POOL_SIZE_API: '8' })).toBe(8);
  });

  it('falls back to the documented default on anything that is not one', () => {
    // REPORT-036's lesson: a partial parse turns "40 connections" into 40 and
    // "abc" into NaN, and NaN inside a URL is worse than the default it
    // replaced. Only an entirely-numeric string counts.
    for (const junk of ['40 connections', 'abc', '', '  ', '-1', '1.5', '0', '1e3']) {
      expect(poolSizeFor('worker', { DB_POOL_SIZE_WORKER: junk })).toBe(DEFAULT_WORKER_POOL);
    }
  });

  it('treats pool_timeout=0 as a real value, because Prisma does', () => {
    // 0 disables the wait timeout. It is a decision, not a missing value — so
    // unlike a pool SIZE of 0 it must survive the parse.
    expect(poolTimeoutSeconds({ DB_POOL_TIMEOUT_SECONDS: '0' })).toBe(0);
    expect(poolTimeoutSeconds({ DB_POOL_TIMEOUT_SECONDS: 'soon' })).toBe(DEFAULT_POOL_TIMEOUT_SECONDS);
  });

  it('applies the override through the resolver, per role', () => {
    const url = new URL(resolveDatabaseUrl(BASE, 'worker', { DB_POOL_SIZE_WORKER: '31' })!);
    expect(url.searchParams.get('connection_limit')).toBe('31');
    // The API's var must not move the worker's pool and vice versa.
    const apiUrl = new URL(resolveDatabaseUrl(BASE, 'api', { DB_POOL_SIZE_WORKER: '31' })!);
    expect(apiUrl.searchParams.get('connection_limit')).toBe(String(DEFAULT_API_POOL));
  });
});

describe('the pool still fits the jobs that are actually declared', () => {
  it('worker pool >= declared BullMQ concurrency + headroom', () => {
    // Re-derived from source on every run, so ADDING a worker fails here rather
    // than silently re-creating the starvation this fix exists to end.
    const queueSrc = readFileSync(join(process.cwd(), 'src/jobs/queue.ts'), 'utf8');
    // Match the VALUE form only — `concurrency: 5`, never the type annotation
    // `concurrency: number` (hazard-matching: declarations, not prose).
    const declared = [...queueSrc.matchAll(/concurrency:\s*(\d+)/g)].map((m) => Number(m[1]));

    expect(declared.length).toBeGreaterThan(0);
    const total = declared.reduce((sum, n) => sum + n, 0);

    // Headroom covers the work that runs in the same process OUTSIDE a job slot:
    // the scheduler heartbeat, repeatable-job registration, and interactive
    // $transaction callbacks that hold their connection for the callback body.
    const HEADROOM = 5;
    expect(DEFAULT_WORKER_POOL).toBeGreaterThanOrEqual(total + HEADROOM);
  });
});

describe('the chain: both clients are wired to the resolver', () => {
  // The resolver being correct is worthless if nothing calls it. #807 shipped a
  // fully-tested SOS fan-out that had nobody to text; the break was BETWEEN the
  // layers, which is the one place a unit test never looks.
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('the API client resolves its own URL', () => {
    const plugin = src('src/plugins/prisma.ts');
    expect(plugin).toContain("from '../utils/db-pool'");
    expect(plugin).toMatch(/datasourceUrl:\s*resolveDatabaseUrl\([^)]*'api'\)/);
  });

  it('the worker client resolves its own URL', () => {
    const worker = src('src/worker.ts');
    expect(worker).toContain("from './utils/db-pool'");
    expect(worker).toMatch(/datasourceUrl:\s*resolveDatabaseUrl\([^)]*'worker'\)/);
  });

  it('.env.example documents both dials the alarm tells an operator to turn', () => {
    // POOL_WAIT_ALERT_THRESHOLD's page says "raise connection_limit". Before
    // this change there was no documented variable that did.
    const env = src('.env.example');
    expect(env).toContain('DB_POOL_SIZE_API');
    expect(env).toContain('DB_POOL_SIZE_WORKER');
  });
});
