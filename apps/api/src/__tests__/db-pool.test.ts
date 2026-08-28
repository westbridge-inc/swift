import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveDatabaseUrl,
  poolSizeFor,
  poolTimeoutSeconds,
  poolRoleForApiProcess,
  DEFAULT_API_POOL,
  DEFAULT_WORKER_POOL,
  DEFAULT_COMBINED_POOL,
  DEFAULT_POOL_TIMEOUT_SECONDS,
  POOL_HEADROOM,
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
    // budget this process cannot see. The limit is left exactly as stated.
    const url = new URL(resolveDatabaseUrl(`${BASE}?connection_limit=3`, 'worker', {})!);
    expect(url.searchParams.get('connection_limit')).toBe('3');
  });

  it('still applies a configured pool_timeout alongside an explicit limit [R037-03]', () => {
    // The two settings are INDEPENDENT. Returning early on an explicit limit
    // silently discarded a separately configured DB_POOL_TIMEOUT_SECONDS: both
    // dials read as set, and only one was in effect — so pool-wait failures
    // began at a different moment than the configuration said they would.
    const url = new URL(
      resolveDatabaseUrl(`${BASE}?connection_limit=3`, 'worker', { DB_POOL_TIMEOUT_SECONDS: '45' })!,
    );
    expect(url.searchParams.get('connection_limit')).toBe('3');
    expect(url.searchParams.get('pool_timeout')).toBe('45');
  });

  it('lets an explicit URL pool_timeout win over the configured one', () => {
    const url = new URL(
      resolveDatabaseUrl(`${BASE}?pool_timeout=90`, 'worker', { DB_POOL_TIMEOUT_SECONDS: '45' })!,
    );
    expect(url.searchParams.get('pool_timeout')).toBe('90');
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

    // Assert the EXPORTED headroom, not a copy of it. A private copy of 5 in
    // this test meant dropping the worker pool to 24 stayed green while
    // contradicting the module's own documented sizing [R037-06].
    expect(POOL_HEADROOM).toBe(6);
    expect(DEFAULT_WORKER_POOL).toBe(total + POOL_HEADROOM);
  });
});

describe('the DEFAULT topology is sized too [R037-01]', () => {
  // `RUN_WORKERS` unset means ONE process serves HTTP and runs all 19 job
  // consumers off a single Prisma client (server.ts hands the runtime
  // `app.prisma`). Sized at the API budget it stayed starved for exactly the
  // workload this module exists to fix — the first version only helped the
  // split topology, which is the one nobody runs by default.
  it('unset RUN_WORKERS means this process also consumes the queue', () => {
    expect(poolRoleForApiProcess({})).toBe('combined');
    expect(poolRoleForApiProcess({ RUN_WORKERS: '1' })).toBe('combined');
    expect(poolRoleForApiProcess({ RUN_WORKERS: '' })).toBe('combined');
  });

  it('only an explicit RUN_WORKERS=0 makes it HTTP-only', () => {
    expect(poolRoleForApiProcess({ RUN_WORKERS: '0' })).toBe('api');
  });

  it('the combined budget carries BOTH workloads, not a compromise', () => {
    expect(DEFAULT_COMBINED_POOL).toBe(DEFAULT_API_POOL + DEFAULT_WORKER_POOL);
    expect(poolSizeFor('combined', {})).toBe(DEFAULT_COMBINED_POOL);
    // The failure this encodes: a combined process must never be sized at the
    // API budget while running the whole queue.
    expect(DEFAULT_COMBINED_POOL).toBeGreaterThan(DEFAULT_API_POOL);
    expect(DEFAULT_COMBINED_POOL).toBeGreaterThan(DEFAULT_WORKER_POOL);
  });

  it('has its own override, distinct from the other two roles', () => {
    expect(poolSizeFor('combined', { DB_POOL_SIZE_COMBINED: '60' })).toBe(60);
    expect(poolSizeFor('combined', { DB_POOL_SIZE_API: '60' })).toBe(DEFAULT_COMBINED_POOL);
  });
});

describe('the chain: both clients are wired to the resolver', () => {
  // The resolver being correct is worthless if nothing calls it. #807 shipped a
  // fully-tested SOS fan-out that had nobody to text; the break was BETWEEN the
  // layers, which is the one place a unit test never looks.
  const raw = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
  /** Source with comments stripped. The chain assertions below name the exact
   *  code they guard, and the comments explaining that code necessarily quote
   *  it — so scanning raw text let a mutation delete the real property while a
   *  matching comment kept the gate green [R037-05]. Standing hazard-matching
   *  rule: match declarations, not prose. */
  const src = (rel: string) =>
    raw(rel)
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  it('the API client resolves its own URL', () => {
    const plugin = src('src/plugins/prisma.ts');
    expect(plugin).toContain("from '../utils/db-pool'");
    expect(plugin).toMatch(/datasourceUrl:\s*resolveDatabaseUrl\([^)]*poolRoleForApiProcess\(\)\)/);
  });

  it('the worker client resolves its own URL', () => {
    const worker = src('src/worker.ts');
    expect(worker).toContain("from './utils/db-pool'");
    expect(worker).toMatch(/datasourceUrl:\s*resolveDatabaseUrl\([^)]*'worker'\)/);
  });

  it('.env.example documents every dial the alarm tells an operator to turn', () => {
    // POOL_WAIT_ALERT_THRESHOLD's page says "raise connection_limit". Before
    // this change there was no documented variable that did.
    const env = raw('.env.example');
    expect(env).toContain('DB_POOL_SIZE_API');
    expect(env).toContain('DB_POOL_SIZE_WORKER');
    expect(env).toContain('DB_POOL_SIZE_COMBINED');
  });

  it('the DEPLOY template documents them too [R037-07]', () => {
    // An operator self-hosting from deploy/ follows THIS file and never opens
    // apps/api/.env.example, so the dials the alarm names were invisible to
    // exactly the person the alarm wakes.
    const deployEnv = raw('../../deploy/.env.deploy.example');
    expect(deployEnv).toContain('DB_POOL_SIZE_COMBINED');
    expect(deployEnv).toContain('DB_POOL_SIZE_WORKER');
    expect(deployEnv).toContain('DB_POOL_TIMEOUT_SECONDS');
    // And it must warn that this is a SHARED budget — sizing one process in
    // isolation is how five replicas silently consume max_connections.
    expect(deployEnv).toMatch(/max_connections/);
  });
});
