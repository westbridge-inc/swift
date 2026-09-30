import { runWeeklySettlement, runBillingCycleJob, runConvertTrialsJob, type JobContext } from '../../../jobs/queue';
import type { DrillTarget } from './guard';

/**
 * [STG-DRILLS D2/D4] The run-once job trigger's allowlist.
 *
 * Staging cannot wait for Sunday 00:00 (the settlement digest), 03:00 (the
 * trial conversion) or the top of the hour (the billing cycle) to prove what
 * those jobs do, so deploy/drill-run-job.sh runs them ONCE, on demand, inside
 * the worker container — and runs exactly these functions: the ones the
 * worker's own processors call (jobs/queue.ts). Each entry is the imported
 * function itself, never a copy; staging-drill-jobs.test.ts pins both the
 * identity and the worker's delegation, so the two can never drift apart.
 *
 * Nothing outside this map can be named. There is no route and no queue entry:
 * the only way in is `docker compose exec` on the staging host, behind the
 * drill guard.
 */
export const DRILL_JOBS = {
  /** The Sunday 00:00 `process-settlements` job: weekly sales digests. */
  'settlement-digest': runWeeklySettlement,
  /** The daily 03:00 `convert-trials` job: trials past day 14 become due. */
  'convert-trials': runConvertTrialsJob,
  /** The hourly `process-billing` job: the subscription billing cycle. */
  'billing-cycle': runBillingCycleJob,
} as const satisfies Record<string, (ctx: JobContext) => Promise<unknown>>;

export type DrillJobName = keyof typeof DRILL_JOBS;
export const DRILL_JOB_NAMES = Object.keys(DRILL_JOBS) as DrillJobName[];

export class DrillUsageError extends Error {
  override readonly name = 'DrillUsageError';
}

/** The requested jobs, in order, each exactly once — or a usage error before anything connects. */
export function parseDrillJobs(names: readonly string[]): DrillJobName[] {
  if (names.length === 0) throw new DrillUsageError(`name at least one job: ${DRILL_JOB_NAMES.join(' | ')}`);
  const out: DrillJobName[] = [];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(DRILL_JOBS, name)) {
      throw new DrillUsageError(`"${name}" is not an allowlisted drill job (${DRILL_JOB_NAMES.join(' | ')})`);
    }
    if (out.includes(name as DrillJobName)) throw new DrillUsageError(`"${name}" is named twice; each job runs once`);
    out.push(name as DrillJobName);
  }
  return out;
}

export interface DrillJobRun {
  job: DrillJobName;
  startedAt: string;
  finishedAt: string;
}

export interface DrillJobDeps {
  /** The guard, against the database the jobs will use. It runs BEFORE any job context exists. */
  assertTarget: () => Promise<DrillTarget>;
  /** Builds the job context the way the worker builds its own (worker.ts). */
  openContext: () => Promise<{ ctx: JobContext; close: () => Promise<void> }>;
  /** Test seam: the registry to run from. Production passes nothing and runs DRILL_JOBS. */
  jobs?: Record<DrillJobName, (ctx: JobContext) => Promise<unknown>>;
}

/** Parse, guard, then run each named job once, in order. A job that throws stops the rest. */
export async function runDrillJobs(names: readonly string[], deps: DrillJobDeps): Promise<{ target: DrillTarget; runs: DrillJobRun[] }> {
  const jobs = parseDrillJobs(names);
  const target = await deps.assertTarget();
  const registry = deps.jobs ?? DRILL_JOBS;
  const { ctx, close } = await deps.openContext();
  const runs: DrillJobRun[] = [];
  try {
    for (const job of jobs) {
      const startedAt = new Date().toISOString();
      await registry[job](ctx);
      runs.push({ job, startedAt, finishedAt: new Date().toISOString() });
    }
  } finally {
    await close();
  }
  return { target, runs };
}
