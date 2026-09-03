import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { runtimeMode } from '../utils/runtime-mode';

/**
 * [R048-001] THE TEST TARGET LOCK.
 *
 * The test harness selected a shared test database when nothing else was
 * set, preserved whatever DATABASE_URL a shell exported, pinned no Redis
 * database at all, and let any suite delete every row of a table or install
 * DDL. Sequential execution is not target isolation: a developer or CI shell
 * exporting a shared or production URL — or a bare local run falling through
 * to Redis database 0, where the development app keeps its keys — turned a
 * green suite into a data-loss path.
 *
 * Two halves, both pure enough to prove without a socket:
 *
 *   assessTestTarget   — the STRUCTURAL proof, evaluated before any client is
 *                        constructed: NODE_ENV is test; the Postgres URL names
 *                        a loopback (or allowlisted) host and a disposable
 *                        database name; the Redis URL names a loopback host and
 *                        a database index that is never 0. A production-looking
 *                        host is refused by name.
 *   the destructive guard — a Prisma extension active in test mode: a
 *                        deleteMany/updateMany with no predicate, and any raw
 *                        DDL, is refused unless the suite has explicitly
 *                        granted itself the capability. Cleanup is
 *                        namespace-owned or it does not run.
 *
 * The global setup (src/__tests__/setup/target-lock.ts) runs the first before
 * vitest spawns a worker, then opens read-only probes, mints the run id and
 * publishes the target fingerprint. Rollback means stopping the suite; the
 * lock is never relaxed.
 */

export const TEST_TARGET_DEFAULTS = Object.freeze({
  DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift_test',
  /** Never database 0 — the development app's keys live there. */
  REDIS_URL: 'redis://localhost:6382/15',
});

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** A disposable test database, by name. Override with TEST_TARGET_DB_ALLOWLIST (comma-separated exact names). */
export const TEST_DB_PATTERN = /^swift_test[a-z0-9_]*$/;
/** Hosts that can only be someone's real data. */
const PRODUCTION_LOOKING = /prod|live|swift\.gy|swiftgy\.com|rds\.amazonaws|render\.com|railway|supabase|neon\.tech|fly\.dev/i;

export interface TestTarget {
  pgHost: string;
  pgPort: number;
  database: string;
  pgUser: string;
  redisHost: string;
  redisPort: number;
  redisDb: number;
}

export type TargetAssessment = { ok: true; target: TestTarget } | { ok: false; problems: string[] };

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function parseRedisDb(u: URL): number | null {
  const fromPath = u.pathname.replace(/^\//, '');
  if (fromPath !== '') return /^\d+$/.test(fromPath) ? Number(fromPath) : null;
  const q = u.searchParams.get('db');
  if (q !== null) return /^\d+$/.test(q) ? Number(q) : null;
  return 0; // ioredis default when nothing is said
}

/** The structural proof. No socket is opened here, ever. */
export function assessTestTarget(env: Record<string, string | undefined>): TargetAssessment {
  const problems: string[] = [];
  // The ONE runtime-mode parser decides the posture (an unknown word throws there, never a guess here).
  let mode: string | null = null;
  try { mode = runtimeMode(env); } catch { mode = null; }
  if (mode !== 'test') problems.push(`NODE_ENV must be "test" (got ${env['NODE_ENV'] ?? 'unset'}) — the destructive guard and the pinned flags exist only there`);
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...list(env['TEST_TARGET_HOST_ALLOWLIST'])]);
  const allowedDbs = list(env['TEST_TARGET_DB_ALLOWLIST']);

  const checkPostgres = (label: 'DATABASE_URL' | 'SYSTEM_DATABASE_URL', raw: string): URL | null => {
    let url: URL | null = null;
    try { url = new URL(raw); } catch { problems.push(`${label} is not a URL`); return null; }
    if (!/^postgres(ql)?:$/.test(url.protocol)) problems.push(`${label} must be a postgres URL (got ${url.protocol})`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (PRODUCTION_LOOKING.test(host)) problems.push(`${label} host "${host}" looks like a real deployment — refused by name`);
    else if (!allowedHosts.has(host)) problems.push(`${label} host "${host}" is not loopback and not in TEST_TARGET_HOST_ALLOWLIST`);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) problems.push(`${label} names no database`);
    else if (!(TEST_DB_PATTERN.test(database) || allowedDbs.includes(database))) problems.push(`${label} database "${database}" is not a disposable test database (swift_test…, or TEST_TARGET_DB_ALLOWLIST)`);
    return url;
  };

  let pg: URL | null = null;
  const pgRaw = env['DATABASE_URL'];
  if (!pgRaw) problems.push('DATABASE_URL is unset — the harness never guesses a database');
  else pg = checkPostgres('DATABASE_URL', pgRaw);
  // The system client (tenant-wall bypass work) is a SECOND socket; when a test
  // run names one it is held to the same proof — a disposable loopback target.
  const sysRaw = env['SYSTEM_DATABASE_URL'];
  if (sysRaw) checkPostgres('SYSTEM_DATABASE_URL', sysRaw);

  let redis: URL | null = null;
  const redisRaw = env['REDIS_URL'];
  if (!redisRaw) problems.push('REDIS_URL is unset — the harness never falls through to Redis database 0');
  else {
    try { redis = new URL(redisRaw); } catch { problems.push('REDIS_URL is not a URL'); }
  }
  let redisDb: number | null = null;
  if (redis) {
    if (!/^rediss?:$/.test(redis.protocol)) problems.push(`REDIS_URL must be a redis URL (got ${redis.protocol})`);
    const host = redis.hostname.replace(/^\[|\]$/g, '');
    if (PRODUCTION_LOOKING.test(host)) problems.push(`REDIS_URL host "${host}" looks like a real deployment — refused by name`);
    else if (!allowedHosts.has(host)) problems.push(`REDIS_URL host "${host}" is not loopback and not in TEST_TARGET_HOST_ALLOWLIST`);
    redisDb = parseRedisDb(redis);
    if (redisDb === null) problems.push('REDIS_URL database index is not a number');
    else if (redisDb === 0) problems.push('REDIS_URL selects database 0 — the development app lives there; tests pin a database of their own (…/15)');
  }

  if (problems.length || !pg || !redis || redisDb === null) return { ok: false, problems };
  return {
    ok: true,
    target: {
      pgHost: pg.hostname, pgPort: pg.port ? Number(pg.port) : 5432, database: decodeURIComponent(pg.pathname.replace(/^\//, '')), pgUser: decodeURIComponent(pg.username),
      redisHost: redis.hostname, redisPort: redis.port ? Number(redis.port) : 6379, redisDb,
    },
  };
}

// ---------------------------------------------------------------------------
// The destructive guard
// ---------------------------------------------------------------------------

export type SuiteCapability = 'unscoped-mutation' | 'ddl';

export class TestTargetLockError extends Error {
  constructor(readonly code: 'UNSCOPED_MUTATION_REFUSED' | 'DDL_REFUSED', message: string) {
    super(`[${code}] ${message}`);
    this.name = 'TestTargetLockError';
  }
}

const granted = new Set<SuiteCapability>();
const scoped = new AsyncLocalStorage<Set<SuiteCapability>>();

/** A suite states, at its top, the destructive capability it needs — visible in review, scoped to that file's module graph. */
export function grantSuiteCapability(capability: SuiteCapability): void {
  granted.add(capability);
}

/** The same, for one block only. */
export function withSuiteCapability<T>(capability: SuiteCapability, fn: () => Promise<T>): Promise<T> {
  const current = new Set(scoped.getStore() ?? []);
  current.add(capability);
  return scoped.run(current, fn);
}

export function hasSuiteCapability(capability: SuiteCapability): boolean {
  return granted.has(capability) || (scoped.getStore()?.has(capability) ?? false);
}

export function resetSuiteCapabilitiesForTests(): void {
  granted.clear();
}

/** deleteMany/updateMany that would touch every row: no `where`, or an empty one. */
export function isUnscopedMutation(operation: string, args: unknown): boolean {
  if (operation !== 'deleteMany' && operation !== 'updateMany') return false;
  const where = (args as { where?: unknown } | undefined)?.where;
  if (where === undefined || where === null) return true;
  return typeof where === 'object' && !Array.isArray(where) && Object.keys(where as object).length === 0;
}

/** A statement that changes the schema. `SET LOCAL`, `SELECT … FOR UPDATE`, DML are not. */
export function isDdl(sql: string): boolean {
  return sql.split(';').some((stmt) => /^\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT ON)\b/i.test(stmt));
}

function sqlOf(args: unknown): string {
  // the Unsafe forms take (sql, ...values) → an array whose first element is the SQL;
  // $executeRaw`…` / $queryRaw`…` → a Sql-shaped object { strings, values }.
  if (Array.isArray(args)) {
    const first = args[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && Array.isArray((first as { strings?: unknown }).strings)) return ((first as { strings: string[] }).strings).join(' ? ');
    if (Array.isArray(first)) return (first as string[]).join(' ? ');
    return '';
  }
  if (args && typeof args === 'object' && Array.isArray((args as { strings?: unknown }).strings)) return ((args as { strings: string[] }).strings).join(' ? ');
  if (typeof args === 'string') return args;
  return '';
}

const RAW_OPERATION = /^\$(?:execute|query)Raw(?:Unsafe)?$/;

/** The Prisma extension that refuses namespace-blind destruction in test mode. */
export const destructiveGuardExtension = () => Prisma.defineExtension({
  name: 'testTargetLock',
  query: {
    $allModels: {
      async deleteMany({ model, operation, args, query }) {
        if (isUnscopedMutation(operation, args) && !hasSuiteCapability('unscoped-mutation')) {
          throw new TestTargetLockError('UNSCOPED_MUTATION_REFUSED', `${model}.deleteMany with no predicate would delete every row — scope it to the rows this suite created, or grant the suite the unscoped-mutation capability explicitly`);
        }
        return query(args);
      },
      async updateMany({ model, operation, args, query }) {
        if (isUnscopedMutation(operation, args) && !hasSuiteCapability('unscoped-mutation')) {
          throw new TestTargetLockError('UNSCOPED_MUTATION_REFUSED', `${model}.updateMany with no predicate would rewrite every row — scope it, or grant the suite the unscoped-mutation capability explicitly`);
        }
        return query(args);
      },
    },
    // Every raw entry point — $executeRaw, $queryRaw and their Unsafe forms — is classified by
    // its suffix, so no unsafe API is named here (the SQL-safety census refuses the names in
    // production source) and a future raw entry point is covered the day it appears.
    async $allOperations({ model, operation, args, query }) {
      if (!model && RAW_OPERATION.test(operation) && isDdl(sqlOf(args)) && !hasSuiteCapability('ddl')) {
        throw new TestTargetLockError('DDL_REFUSED', 'raw DDL in a test needs the suite to grant itself the ddl capability explicitly');
      }
      return query(args);
    },
  },
});

export function isTestRuntime(env: Record<string, string | undefined> = process.env): boolean {
  try { return runtimeMode(env) === 'test'; } catch { return false; }
}
