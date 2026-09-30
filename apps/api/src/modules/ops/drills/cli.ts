import type { PrismaClient } from '@prisma/client';
import { pino, destination } from 'pino';
import { setAppLogger } from '../../../utils/logger';
import { assertDrillEnv, assertDrillTarget, DrillRefused } from './guard';
import { parseDrillJobs, runDrillJobs, DrillUsageError } from './jobs';
import { createDrillFixtures, cleanupDrillFixtures, validateRunId, DrillFixtureError } from './fixtures';

/**
 * [STG-DRILLS] The two run-once entry points, as functions (the boot files in
 * src/boot only call these). Order is the safety property:
 *
 *   1. arguments        — a usage error before anything else (exit 2);
 *   2. the environment  — the marker, the posture and the configured database,
 *                         before any client exists: a process without the
 *                         marker never opens a socket (exit 3);
 *   3. the database     — the server's own name and deployment identity (exit 3);
 *   4. the work         — fixtures or the allowlisted jobs (exit 1 on failure).
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
}
const appClient: FixturesDeps = {
  client: async () => (await import('../../../plugins/prisma')).scopedPrisma as unknown as PrismaClient,
};

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
    assertDrillEnv(env);
    const db = await deps.client();
    try {
      const target = await assertDrillTarget(db, env);
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
      await db.$disconnect().catch(() => undefined);
    }
  } catch (err) {
    return exitFor(err, io);
  }
}

/** drill-run-job <settlement-digest|convert-trials|billing-cycle> [...] — each allowlisted job once, in order. */
export async function drillRunJobMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: DrillIo = stdio,
): Promise<number> {
  try {
    parseDrillJobs(argv);
    assertDrillEnv(env);
    // The job context the worker builds for itself (worker.ts): a plain client
    // sized for the worker, Redis, a broadcast-only Socket.IO server, a logger.
    const { PrismaClient: Client } = await import('@prisma/client');
    const { resolveDatabaseUrl } = await import('../../../utils/db-pool');
    const prisma = new Client({ datasourceUrl: resolveDatabaseUrl(env['DATABASE_URL'], 'worker') });
    try {
      const result = await runDrillJobs(argv, {
        assertTarget: () => assertDrillTarget(prisma, env),
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
    }
  } catch (err) {
    return exitFor(err, io);
  }
}
