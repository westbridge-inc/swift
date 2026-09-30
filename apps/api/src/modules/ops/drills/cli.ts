import type { PrismaClient } from '@prisma/client';
import { pino, destination } from 'pino';
import { setAppLogger } from '../../../utils/logger';
import { assertDrillEnv, assertDrillTarget, DrillRefused, type FactsDb } from './guard';
import { parseDrillJobs, runDrillJobs, DrillUsageError } from './jobs';
import { createDrillFixtures, cleanupDrillFixtures, validateRunId, DrillFixtureError } from './fixtures';
import { readCrashEvidence, ORDER_ID } from './evidence';

/**
 * [STG-DRILLS] The run-once entry points, as functions (the boot files in
 * src/boot only call these): fixtures, the job trigger, the guard alone
 * (drill-crash.sh asks it inside the worker before it kills anything) and the
 * crash drill's read-only evidence. Order is the safety property:
 *
 *   1. arguments        — a usage error before anything else (exit 2);
 *   2. the environment  — the marker, the posture and EVERY configured
 *                         connection (DATABASE_URL, SYSTEM_DATABASE_URL, Redis),
 *                         before any client exists: a process without the
 *                         marker never opens a socket (exit 3);
 *   3. the databases    — the server's own name and deployment identity, read
 *                         through every database connection the work can use,
 *                         and one database behind all of them (exit 3);
 *   4. the work         — fixtures, the allowlisted job, or the evidence read
 *                         (exit 1 on failure).
 *
 * stdout carries exactly ONE line: the JSON result (manifest, cleanup report,
 * or job runs). Every log line goes to stderr, so deploy/drill-*.sh can take
 * the last stdout line as the document.
 */

export const DRILL_EXIT = { OK: 0, FAILED: 1, USAGE: 2, REFUSED: 3 } as const;

export interface DrillIo { out: (line: string) => void; err: (line: string) => void }
const stdio: DrillIo = {
  out: (line) => { process.stdout.write(`${line}\n`); },
  err: (line) => { process.stderr.write(`${line}\n`); },
};

/** Never-a-subscriber: +5920 and six digits (the runner's gate p, scripts/livetest/guard.ts). */
const FICTIONAL_GY = /^\+5920\d{6}$/;

const stderrLogger = () => pino({ level: process.env['LOG_LEVEL'] ?? 'info' }, destination(2));

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

function exitFor(err: unknown, io: DrillIo): number {
  if (err instanceof DrillUsageError) {
    io.err(`usage: ${err.message}`);
    return DRILL_EXIT.USAGE;
  }
  if (err instanceof DrillRefused) {
    io.err(`REFUSED: ${err.message}`);
    return DRILL_EXIT.REFUSED;
  }
  io.err(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  return DRILL_EXIT.FAILED;
}

export interface FixturesDeps {
  /** The app's own client (tenant scoping and its guards); opened only after the environment passed. */
  client: () => Promise<PrismaClient>;
  /**
   * [AX324 R1] The client the app re-issues system work on under
   * TENANT_RLS_BIND=1 (SYSTEM_DATABASE_URL), or null when none is configured.
   * Asked only when the environment names a system connection; the guard
   * reads it and refuses unless it is the same database.
   */
  systemClient?: () => Promise<FactsDb | null>;
}
const appClient: Required<FixturesDeps> = {
  client: async () => (await import('../../../plugins/prisma')).scopedPrisma as unknown as PrismaClient,
  systemClient: async () => (await import('../../../plugins/prisma')).systemPrismaClient(),
};

type Disconnectable = { $disconnect?: () => Promise<void> };
const disconnect = async (c: unknown): Promise<void> => {
  await (c as Disconnectable | null)?.$disconnect?.().catch(() => undefined);
};

/** Steps 2 and 3 over the app's clients: the environment, then every connection. */
async function openGuarded(env: Record<string, string | undefined>, deps: FixturesDeps) {
  const envTarget = assertDrillEnv(env);
  const db = await deps.client();
  const system = envTarget.system ? await (deps.systemClient ?? appClient.systemClient)() : null;
  const close = async () => { await disconnect(db); await disconnect(system); };
  try {
    return { db, target: await assertDrillTarget(db, env, system), close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** drill-fixtures create --run-id <id> --admin-phone <+5920…> | cleanup --run-id <id> */
export async function drillFixturesMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: DrillIo = stdio,
  deps: FixturesDeps = appClient,
): Promise<number> {
  try {
    const [mode] = argv;
    if (mode !== 'create' && mode !== 'cleanup') {
      throw new DrillUsageError('drill-fixtures create --run-id <id> --admin-phone <+5920xxxxxx> | cleanup --run-id <id>');
    }
    let runId: string;
    try {
      runId = validateRunId(flag(argv, 'run-id') ?? '');
    } catch (e) {
      throw new DrillUsageError(e instanceof DrillFixtureError ? e.message : 'a --run-id is required');
    }
    const adminPhone = flag(argv, 'admin-phone') ?? '';
    if (mode === 'create' && !FICTIONAL_GY.test(adminPhone)) {
      throw new DrillUsageError('--admin-phone must be the seed admin, a never-a-subscriber +5920 number (staging: +5920400000)');
    }
    const { db, target, close } = await openGuarded(env, deps);
    try {
      setAppLogger(stderrLogger());
      if (mode === 'create') {
        const manifest = await createDrillFixtures(db, { runId, adminPhone, target });
        io.out(JSON.stringify(manifest));
        return DRILL_EXIT.OK;
      }
      const report = await cleanupDrillFixtures(db, { runId });
      io.out(JSON.stringify(report));
      if (report.kept.length > 0) io.err(`FAILED: ${report.kept.length} fixture row(s) could not be removed; see "kept" in the report`);
      return report.kept.length > 0 ? DRILL_EXIT.FAILED : DRILL_EXIT.OK;
    } finally {
      await close();
    }
  } catch (err) {
    return exitFor(err, io);
  }
}

/** drill-run-job settlement-digest — the allowlisted job, once (jobs.ts says why it is the only one). */
export async function drillRunJobMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: DrillIo = stdio,
): Promise<number> {
  try {
    parseDrillJobs(argv);
    const envTarget = assertDrillEnv(env);
    // The job context the worker builds for itself (worker.ts): a plain client
    // sized for the worker, Redis, a broadcast-only Socket.IO server, a logger.
    const { PrismaClient: Client } = await import('@prisma/client');
    const { resolveDatabaseUrl } = await import('../../../utils/db-pool');
    const prisma = new Client({ datasourceUrl: resolveDatabaseUrl(env['DATABASE_URL'], 'worker') });
    // [AX324 R1] A configured system login is judged too, though the job's
    // plain client never routes to it: every connection this process could use.
    const system = envTarget.system ? new Client({ datasourceUrl: env['SYSTEM_DATABASE_URL'] }) : null;
    try {
      const result = await runDrillJobs(argv, {
        assertTarget: () => assertDrillTarget(prisma, env, system),
        openContext: async () => {
          const { default: Redis } = await import('ioredis');
          const { Server } = await import('socket.io');
          const log = stderrLogger();
          setAppLogger(log);
          const redis = new Redis(env['REDIS_URL'] ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
          redis.on('error', (err) => log.error({ err }, 'drill job Redis connection error'));
          // Never attached to an HTTP server, like the worker's own: nothing to
          // close (Server.close() on an unattached server throws).
          const socket = new Server();
          return {
            ctx: { prisma, io: socket, redis, log },
            close: async () => {
              await redis.quit().catch(() => redis.disconnect(false));
            },
          };
        },
      });
      io.out(JSON.stringify(result));
      return DRILL_EXIT.OK;
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await disconnect(system);
    }
  } catch (err) {
    return exitFor(err, io);
  }
}

/**
 * drill-guard — the guard ALONE, no work [AX324 R3]. deploy/drill-crash.sh runs
 * it inside the very worker container it is about to kill, before the setup
 * and again right before the kill, and pins the journeys runner to the
 * deployment identity it prints: the worker's own posture, databases and
 * identity are judged, not just its image and marker.
 */
export async function drillGuardMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: DrillIo = stdio,
  deps: FixturesDeps = appClient,
): Promise<number> {
  try {
    if (argv.length > 0) throw new DrillUsageError('drill-guard takes no arguments');
    const { target, close } = await openGuarded(env, deps);
    await close();
    io.out(JSON.stringify({ ok: true, target }));
    return DRILL_EXIT.OK;
  } catch (err) {
    return exitFor(err, io);
  }
}

/** drill-evidence crash --order <id> — the crash drill's durable evidence, read-only [AX324 R7]. */
export async function drillEvidenceMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: DrillIo = stdio,
  deps: FixturesDeps = appClient,
): Promise<number> {
  try {
    const orderId = flag(argv, 'order') ?? '';
    if (argv[0] !== 'crash' || !ORDER_ID.test(orderId)) throw new DrillUsageError('drill-evidence crash --order <order id>');
    const { db, close } = await openGuarded(env, deps);
    try {
      io.out(JSON.stringify(await readCrashEvidence(db, orderId)));
      return DRILL_EXIT.OK;
    } finally {
      await close();
    }
  } catch (err) {
    return exitFor(err, io);
  }
}
