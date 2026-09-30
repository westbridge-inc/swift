import type { PrismaClient } from '@prisma/client';
import { runtimeMode, type RuntimeMode } from '../../../utils/runtime-mode';
import { LOOPBACK_HOSTS, TEST_DB_PATTERN } from '../../../lib/test-target-lock';

/**
 * [STG-DRILLS] The staging drill guard.
 *
 * Seven pilot journeys skip on staging because the test server cannot produce
 * their conditions: a store whose trial ended, a digest the Sunday job writes,
 * a partner application in the reviewer's own identity cluster, a second
 * tenant, a worker killed mid-offer. The drills that produce them are
 * staging-only SCRIPTS (deploy/drill-*.sh) that reach this code by
 * `docker compose exec` inside the worker container. Nothing here is a route:
 * no public or admin API gains a way to mint a fixture or fire a job.
 *
 * Every drill entry point asks this guard first, and it refuses unless ALL of
 * these hold — each one alone keeps production out:
 *
 *   1. the marker: SWIFT_STAGING_DRILLS=1, a setting that exists only in the
 *      staging host's deploy/.env and so only in its containers' environment;
 *   2. the posture: never NODE_ENV=production. Staging is the pilot's
 *      loadtest posture (PILOT_ENV=staging, NODE_ENV=loadtest — the same pair
 *      deploy/journeys-run.sh requires); the only other accepted posture is
 *      the test harness (NODE_ENV=test), which is how CI proves this module;
 *   3. the database: the staging stack's OWN Postgres as deploy/docker-compose.yml
 *      wires the api and worker (the private `postgres` service, port 5432,
 *      database POSTGRES_DB), and the server must answer that same name; under
 *      the test harness, a loopback host and a disposable swift_test… database
 *      (lib/test-target-lock.ts). A name that looks like production is refused
 *      by name in either posture;
 *   4. no production marker: the database's own deployment_identity must exist
 *      and must not say production (the runner, seed and purge read the same
 *      row), it must say `staging` on staging, and the declared data
 *      classification (LOAD_TEST_DATA_CLASSIFICATION, the value
 *      /test-control/identity reports) must be synthetic.
 *
 * The verdict is a pure function of the facts (judgeDrillTarget), so every
 * refusal is proven in staging-drill-guard.test.ts without a staging host.
 */

export const DRILL_MARKER = 'SWIFT_STAGING_DRILLS';
/** deploy/docker-compose.yml, api and worker: POSTGRES_HOST: postgres, POSTGRES_PORT: "5432". */
export const STAGING_DB_HOST = 'postgres';
export const STAGING_DB_PORT = '5432';
/** The environment staging's deployment_identity row declares (PILOT-RUNBOOK section 8). */
export const STAGING_IDENTITY = 'staging';
/** What a CI or local test database declares (seed-guard's ephemeral identities). */
export const TEST_IDENTITIES: ReadonlySet<string> = new Set(['test', 'development', 'local', 'ephemeral']);
/** A database name that can only be someone's real data. */
const PRODUCTION_NAMED = /prod/i;
/** A host that can only be a managed or remote deployment, never this stack's container. */
const PRODUCTION_HOST = /prod|swiftgy\.com|amazonaws|render\.com|railway|supabase|neon\.tech|fly\.dev|flycast/i;

export type DrillRefusalCode =
  | 'MARKER_MISSING'
  | 'RUNTIME_MODE_INVALID'
  | 'PRODUCTION_ENV'
  | 'NOT_STAGING_ENV'
  | 'DATABASE_URL_INVALID'
  | 'WRONG_DB_HOST'
  | 'WRONG_DB_NAME'
  | 'DB_MISMATCH'
  | 'IDENTITY_MISSING'
  | 'PRODUCTION_MARKER'
  | 'WRONG_IDENTITY';

export type DrillPosture = 'staging' | 'test';

export interface DrillFacts {
  /** The process environment the drill runs in. */
  env: Record<string, string | undefined>;
  /** What the server itself answers to SELECT current_database(). */
  serverDatabase: string | null;
  /** The database's own deployment_identity row, or null when it has none. */
  identity: { deploymentId: string; environment: string } | null;
}

export interface DrillTarget {
  posture: DrillPosture;
  host: string;
  port: string;
  database: string;
  deploymentId: string;
  environment: string;
}

export type DrillVerdict =
  | { ok: true; target: DrillTarget }
  | { ok: false; code: DrillRefusalCode; reason: string };

export class DrillRefused extends Error {
  override readonly name = 'DrillRefused';
  constructor(readonly code: DrillRefusalCode, reason: string) {
    super(`[STG-DRILLS ${code}] ${reason}`);
  }
}

/** What the environment alone establishes, before any socket is opened. */
export interface DrillEnvTarget { posture: DrillPosture; host: string; port: string; database: string }
export type DrillEnvVerdict = { ok: true; target: DrillEnvTarget } | { ok: false; code: DrillRefusalCode; reason: string };

const refuse = (code: DrillRefusalCode, reason: string): { ok: false; code: DrillRefusalCode; reason: string } => ({ ok: false, code, reason });

/**
 * Checks 1–3 (marker, posture, the configured database), from the environment
 * ALONE. Every entry point runs this before it connects to anything, so a
 * process without the marker — production included — never opens a socket.
 */
export function judgeDrillEnv(env: Record<string, string | undefined>): DrillEnvVerdict {
  // 1. The marker: only staging's deploy/.env carries it.
  if (env[DRILL_MARKER] !== '1') {
    return refuse('MARKER_MISSING', `${DRILL_MARKER}=1 is not set in this process; it exists only in the staging host's deploy/.env (recreate the worker after adding it)`);
  }

  // 2. The posture, from the ONE runtime-mode parser.
  let mode: RuntimeMode;
  try {
    mode = runtimeMode(env);
  } catch {
    return refuse('RUNTIME_MODE_INVALID', `NODE_ENV is not one of the four runtime modes (got ${env['NODE_ENV'] === undefined ? 'unset' : JSON.stringify(env['NODE_ENV'])})`);
  }
  if (mode === 'production') {
    return refuse('PRODUCTION_ENV', 'NODE_ENV=production: a drill never runs against production');
  }
  let posture: DrillPosture;
  if (mode === 'loadtest' && env['PILOT_ENV'] === 'staging') posture = 'staging';
  else if (mode === 'test') posture = 'test';
  else {
    return refuse('NOT_STAGING_ENV', `drills run only on the staging pilot (NODE_ENV=loadtest with PILOT_ENV=staging) or under the test harness (NODE_ENV=test); got NODE_ENV=${mode}, PILOT_ENV=${env['PILOT_ENV'] ?? 'unset'}`);
  }

  // 3. The database this process will write to.
  let url: URL;
  try {
    url = new URL(env['DATABASE_URL'] ?? '');
  } catch {
    return refuse('DATABASE_URL_INVALID', 'DATABASE_URL is unset or not a URL; the drill never guesses a database');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return refuse('DATABASE_URL_INVALID', `DATABASE_URL is not a postgres URL (${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) return refuse('WRONG_DB_NAME', 'DATABASE_URL names no database');
  if (PRODUCTION_HOST.test(host)) return refuse('WRONG_DB_HOST', `database host "${host}" looks like a managed or production deployment`);
  if (PRODUCTION_NAMED.test(database)) return refuse('WRONG_DB_NAME', `database "${database}" is named like production`);
  if (posture === 'staging') {
    if (host !== STAGING_DB_HOST || port !== STAGING_DB_PORT) {
      return refuse('WRONG_DB_HOST', `database host ${host}:${port} is not the staging stack's own Postgres (${STAGING_DB_HOST}:${STAGING_DB_PORT}, deploy/docker-compose.yml)`);
    }
    const declared = env['POSTGRES_DB'];
    if (!declared || database !== declared) {
      return refuse('WRONG_DB_NAME', `database "${database}" is not the one this stack declares (POSTGRES_DB=${declared ?? 'unset'})`);
    }
  } else {
    if (!LOOPBACK_HOSTS.has(host)) return refuse('WRONG_DB_HOST', `under the test harness the database must be on loopback (got ${host})`);
    if (!TEST_DB_PATTERN.test(database)) return refuse('WRONG_DB_NAME', `under the test harness the database must be a disposable swift_test… database (got ${database})`);
  }
  // The declared data class is a production marker the environment carries.
  const classification = env['LOAD_TEST_DATA_CLASSIFICATION'];
  if (classification !== undefined && classification !== '' && classification !== 'synthetic') {
    return refuse('PRODUCTION_MARKER', `the declared data classification is ${JSON.stringify(classification)}, not synthetic`);
  }
  return { ok: true, target: { posture, host, port, database } };
}

/** The whole verdict: the environment (judgeDrillEnv), then what the server itself says. */
export function judgeDrillTarget(facts: DrillFacts): DrillVerdict {
  const envVerdict = judgeDrillEnv(facts.env);
  if (!envVerdict.ok) return envVerdict;
  const { posture, host, port, database } = envVerdict.target;

  // 3 (continued). The server must answer the name the configuration gives.
  if (facts.serverDatabase !== database) {
    return refuse('DB_MISMATCH', `the server answers database "${facts.serverDatabase ?? 'none'}", not "${database}" — the connection is not what the configuration says`);
  }

  // 4. The production marker the database itself carries: its deployment identity.
  if (!facts.identity) {
    return refuse('IDENTITY_MISSING', 'the database declares no deployment identity (deployment_identity singleton missing); an unidentified database is never a drill target');
  }
  const declaredEnv = facts.identity.environment;
  if (declaredEnv.trim().toLowerCase() === 'production') {
    return refuse('PRODUCTION_MARKER', `the database declares environment=production (${facts.identity.deploymentId})`);
  }
  if (posture === 'staging' && declaredEnv !== STAGING_IDENTITY) {
    return refuse('WRONG_IDENTITY', `the database declares environment=${declaredEnv}; a staging drill needs ${STAGING_IDENTITY}`);
  }
  if (posture === 'test' && !TEST_IDENTITIES.has(declaredEnv)) {
    return refuse('WRONG_IDENTITY', `the database declares environment=${declaredEnv}; the test harness accepts ${[...TEST_IDENTITIES].join('|')}`);
  }

  return { ok: true, target: { posture, host, port, database, deploymentId: facts.identity.deploymentId, environment: declaredEnv } };
}

type FactsDb = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  deploymentIdentity: Pick<PrismaClient['deploymentIdentity'], 'findUnique'>;
};

/** The facts, read from the live connection — never from configuration alone. */
export async function readDrillFacts(db: FactsDb, env: Record<string, string | undefined> = process.env): Promise<DrillFacts> {
  const [row] = await db.$queryRaw<Array<{ db: string }>>`SELECT current_database()::text AS db`;
  const identity = await db.deploymentIdentity.findUnique({
    where: { id: 'singleton' },
    select: { deploymentId: true, environment: true },
  });
  return { env, serverDatabase: row?.db ?? null, identity: identity ?? null };
}

/** The environment half, alone: call it before constructing any client. */
export function assertDrillEnv(env: Record<string, string | undefined> = process.env): DrillEnvTarget {
  const verdict = judgeDrillEnv(env);
  if (!verdict.ok) throw new DrillRefused(verdict.code, verdict.reason);
  return verdict.target;
}

/** Read, judge, and refuse loudly. Returns the target a drill may act on. */
export async function assertDrillTarget(db: FactsDb, env: Record<string, string | undefined> = process.env): Promise<DrillTarget> {
  assertDrillEnv(env); // nothing is read from the database for a process that fails here
  const verdict = judgeDrillTarget(await readDrillFacts(db, env));
  if (!verdict.ok) throw new DrillRefused(verdict.code, verdict.reason);
  return verdict.target;
}
