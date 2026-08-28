/**
 * Database connection-pool sizing [P1 · WS-8.3].
 *
 * The worker declares **19** concurrent BullMQ jobs (queue.ts). Prisma sizes its
 * pool from the connection string and defaults to `(num_cpus * 2) + 1` — FIVE
 * connections on the 2-vCPU box this deploys to. So on the topology the repo
 * actually ships, fourteen of those nineteen jobs queue on `pool_timeout` the
 * moment the queue gets busy. The money jobs are in that set.
 *
 * The alarm for exactly this was already built: `POOL_WAIT_ALERT_THRESHOLD`
 * pages when queries wait for a connection, and its own message says "raise
 * connection_limit". **The setting it points at was never set anywhere** — not
 * in `.env.example`, not in `deploy/docker-compose.yml`, not in code. The alarm
 * has been wired to a dial that does not exist.
 *
 * Why this lives here and not only in the env examples: the deployment paths
 * that matter (Railway / ECS / "any container host", per deploy/README) supply
 * their own `DATABASE_URL`, so an example file cannot reach them. Sizing at the
 * ONE seam every client construction passes through is the same reasoning that
 * put the EXIF strip inside the storage provider rather than at seven upload
 * routes — the eighth caller is the one that forgets.
 *
 * **An explicit operator decision always wins.** If the URL already carries a
 * `connection_limit`, this returns it untouched. It supplies a missing number;
 * it never overrides a stated one.
 *
 * It also fails OPEN: anything it cannot parse is returned unchanged. A pool
 * hint is not worth refusing to boot over.
 *
 * ORDERING NOTE (verified by probe, 2026-08-27): both call sites read
 * `process.env['DATABASE_URL']` at module-evaluation time, which is safe only
 * because importing `@prisma/client` itself loads `.env` into `process.env`
 * first — and that import necessarily precedes any `new PrismaClient()`. If a
 * client is ever constructed somewhere that does NOT import @prisma/client
 * above it, read the env explicitly before calling this.
 */

/**
 * Which process is asking. Three shapes, not two — and the third is the one
 * that was missed the first time round.
 *
 *   'api'       HTTP only. Set RUN_WORKERS=0 and run a dedicated worker.
 *   'worker'    the dedicated `node dist/worker.js` entrypoint.
 *   'combined'  the DEFAULT topology: `RUN_WORKERS` unset means the API process
 *               runs the HTTP server AND all 19 job consumers, sharing ONE
 *               Prisma client (server.ts hands the runtime `app.prisma`). Sized
 *               at the API pool, that process was still starved for exactly the
 *               workload this module exists to fix — the original change only
 *               helped the split topology, which is the one nobody runs by
 *               default.
 */
export type PoolRole = 'api' | 'worker' | 'combined';

/**
 * The shape of `process.env` that this module needs, written structurally
 * rather than as `NodeJS.ProcessEnv` — the repo's ESLint config does not
 * declare the `NodeJS` global, so the namespace type type-checks but fails
 * `no-undef`. Structural is also what makes the resolver testable as a pure
 * function: a test passes a plain object, never a mutated global.
 */
type EnvLike = Record<string, string | undefined>;

/**
 * Headroom over declared job concurrency, for the work that runs in the same
 * process OUTSIDE a job slot: the scheduler heartbeat, repeatable-job
 * registration, and interactive `$transaction` callbacks that hold a connection
 * for the body of the callback. Exported so the test asserts THIS number rather
 * than a copy of it — with a private copy, dropping the worker pool by one
 * satisfied the test while contradicting the documented sizing.
 */
export const POOL_HEADROOM = 6;

/**
 * Worker default. 19 declared job concurrency + 6 headroom for the work that
 * runs OUTSIDE a job slot in the same process (the scheduler heartbeat, the
 * repeatable-job registration, `$transaction` interactive callbacks that hold a
 * connection while their body runs). `db-pool.test.ts` re-derives the 19 from
 * queue.ts on every run, so adding a worker forces this number to be revisited
 * instead of silently re-creating the starvation.
 */
export const DEFAULT_WORKER_POOL = 25;

/**
 * API default. Sized for request concurrency on a small box rather than for the
 * CPU count: the previous CPU-derived default gave a 2-vCPU API instance five
 * connections, which is fewer than a single burst of concurrent checkouts.
 * Deliberately modest — connections are a shared budget against Postgres
 * `max_connections`, and horizontal API replicas each take their own pool.
 */
export const DEFAULT_API_POOL = 15;

/**
 * Combined default: the API's request budget PLUS the worker's, because in this
 * topology one client serves both. Not a compromise between them — a process
 * doing both jobs needs both budgets, and halving either is how the starvation
 * comes back quietly.
 */
export const DEFAULT_COMBINED_POOL = DEFAULT_API_POOL + DEFAULT_WORKER_POOL;

/**
 * Seconds a query waits for a free connection before failing. Prisma's own
 * default is 10; stating it makes the number reviewable in one place instead of
 * being an invisible library default at the moment it starts mattering.
 */
export const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

const POOL_DEFAULTS: Record<PoolRole, number> = {
  api: DEFAULT_API_POOL,
  worker: DEFAULT_WORKER_POOL,
  combined: DEFAULT_COMBINED_POOL,
};

const SIZE_ENV_VAR: Record<PoolRole, string> = {
  api: 'DB_POOL_SIZE_API',
  worker: 'DB_POOL_SIZE_WORKER',
  combined: 'DB_POOL_SIZE_COMBINED',
};

/**
 * The role THIS process actually plays, read from the same variable server.ts
 * reads. `RUN_WORKERS` unset or anything other than '0' means this process runs
 * the consumers too — the default single-process topology.
 */
export function poolRoleForApiProcess(env: EnvLike = process.env): PoolRole {
  return env['RUN_WORKERS'] === '0' ? 'api' : 'combined';
}

/**
 * Total-parse an integer env var (the REPORT-036 lesson: a partial parse turns
 * `"20 connections"` into 20 and `"abc"` into NaN, and NaN in a URL is worse
 * than the default it replaced). Only a string that is ENTIRELY digits counts;
 * anything else falls back, so a typo degrades to the documented default rather
 * than to nonsense.
 */
function parseWholeNumber(raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min) return undefined;
  return value;
}

/** The pool size this role should use, honouring its env override. */
export function poolSizeFor(role: PoolRole, env: EnvLike = process.env): number {
  return parseWholeNumber(env[SIZE_ENV_VAR[role]], 1) ?? POOL_DEFAULTS[role];
}

/** The pool timeout to use, honouring its env override (`0` disables it). */
export function poolTimeoutSeconds(env: EnvLike = process.env): number {
  return parseWholeNumber(env['DB_POOL_TIMEOUT_SECONDS'], 0) ?? DEFAULT_POOL_TIMEOUT_SECONDS;
}

/**
 * Return `rawUrl` with an explicit `connection_limit` / `pool_timeout` for this
 * role, unless the URL already states one.
 *
 * @param rawUrl  the connection string as configured (usually `DATABASE_URL`)
 * @param role    which process is constructing the client
 * @param env     process env (injected so the behaviour is testable as a pure function)
 */
export function resolveDatabaseUrl(
  rawUrl: string | undefined,
  role: PoolRole,
  env: EnvLike = process.env,
): string | undefined {
  if (!rawUrl) return rawUrl;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a URL we understand (a Prisma datasource can be configured in shapes
    // this does not model). Fail open — never break boot to add a pool hint.
    return rawUrl;
  }

  // Only Postgres understands these parameters. Anything else is returned as-is.
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return rawUrl;

  // An operator who stated a limit has made a decision — possibly sized against
  // a PgBouncer budget this process cannot see. Never overrule it.
  //
  // But it used to return here, which silently threw away a SEPARATELY
  // configured DB_POOL_TIMEOUT_SECONDS: both dials looked set, and only one was
  // in effect. The two settings are independent, so an explicit limit now
  // suppresses only the limit.
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', String(poolSizeFor(role, env)));
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', String(poolTimeoutSeconds(env)));
  }
  return url.toString();
}
