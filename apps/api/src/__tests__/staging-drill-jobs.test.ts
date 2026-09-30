import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runWeeklySettlement, runBillingCycleJob, runConvertTrialsJob, type JobContext } from '../jobs/queue';
import { DRILL_JOBS, DRILL_JOB_NAMES, parseDrillJobs, runDrillJobs, DrillUsageError } from '../modules/ops/drills/jobs';
import { DrillRefused, type DrillTarget } from '../modules/ops/drills/guard';

// ---------------------------------------------------------------------------
// [STG-DRILLS D2/D4] The run-once job trigger. It must run the SAME function
// the worker runs — pinned here by import identity, and by the worker's own
// processors delegating to those exports (a copy in either place goes red) —
// and it must refuse, before any job context exists, unless the drill guard
// passes. The boot entries are spawned for real: a production process, or one
// without the staging marker, is refused without opening a database socket.
// ---------------------------------------------------------------------------

const QUEUE_SRC = readFileSync(join(process.cwd(), 'src/jobs/queue.ts'), 'utf8');
const TSX = join(process.cwd(), 'node_modules/.bin/tsx');

/** The body of one `case '<name>': { … }` in queue.ts, up to its break. */
function caseBody(name: string): string {
  const start = QUEUE_SRC.indexOf(`case '${name}': {`);
  expect(start, `queue.ts has no case '${name}'`).toBeGreaterThan(-1);
  return QUEUE_SRC.slice(start, QUEUE_SRC.indexOf('break;', start));
}

describe('[STG-DRILLS] the trigger runs the worker’s own functions — by identity, never a copy', () => {
  it('the allowlist is exactly three jobs, each the worker export itself', () => {
    expect(DRILL_JOB_NAMES).toEqual(['settlement-digest', 'convert-trials', 'billing-cycle']);
    expect(DRILL_JOBS['settlement-digest']).toBe(runWeeklySettlement);
    expect(DRILL_JOBS['convert-trials']).toBe(runConvertTrialsJob);
    expect(DRILL_JOBS['billing-cycle']).toBe(runBillingCycleJob);
  });

  it('the worker’s processors delegate to those same exports', () => {
    expect(caseBody('process-billing')).toContain('await runBillingCycleJob(ctx);');
    expect(caseBody('convert-trials')).toContain('await runConvertTrialsJob(ctx);');
    const settlement = QUEUE_SRC.slice(QUEUE_SRC.indexOf('QUEUE_NAMES.SETTLEMENT,'), QUEUE_SRC.indexOf('QUEUE_NAMES.VERIFICATION,'));
    expect(settlement).toContain("if (job.name !== 'process-settlements') return;");
    expect(settlement).toContain('await runWeeklySettlement(ctx);');
  });

  it('each job body exists once: the cycle, the conversion and the digest are never re-implemented beside the export', () => {
    const occurrences = (needle: string) => QUEUE_SRC.split(needle).length - 1;
    expect(occurrences('billing.runBillingCycle()')).toBe(1);
    expect(occurrences('.convertExpiredTrials()')).toBe(1);
    expect(occurrences('generateSalesDigests(ctx.prisma)')).toBe(1);
  });

  it('the recurring schedule still names the jobs the processors dispatch on', () => {
    for (const [queue, name] of [['subscriptionQueue', 'process-billing'], ['subscriptionQueue', 'convert-trials'], ['settlementQueue', 'process-settlements']] as const) {
      expect(QUEUE_SRC, `${queue}.add('${name}'`).toMatch(new RegExp(`${queue}\\.add\\('${name}'`));
    }
  });
});

describe('[STG-DRILLS] the allowlist is the only way in', () => {
  it('names outside the allowlist, repeats and an empty list are usage errors', () => {
    expect(() => parseDrillJobs([])).toThrow(DrillUsageError);
    expect(() => parseDrillJobs(['process-billing'])).toThrow(/not an allowlisted drill job/);
    expect(() => parseDrillJobs(['billing-cycle', 'billing-cycle'])).toThrow(/named twice/);
    expect(() => parseDrillJobs(['toString'])).toThrow(/not an allowlisted/);
    expect(() => parseDrillJobs(['__proto__'])).toThrow(/not an allowlisted/);
    expect(parseDrillJobs(['convert-trials', 'billing-cycle'])).toEqual(['convert-trials', 'billing-cycle']);
  });
});

describe('[STG-DRILLS] runDrillJobs: the guard first, then one context, the jobs in order', () => {
  const target: DrillTarget = { posture: 'test', host: 'localhost', port: '5434', database: 'swift_test_x', deploymentId: 'd', environment: 'test' };
  const fakeCtx = { marker: 'ctx' } as unknown as JobContext;

  it('a refusing guard means no context is opened and no job runs', async () => {
    const openContext = vi.fn();
    const job = vi.fn();
    const refused = runDrillJobs(['settlement-digest'], {
      assertTarget: async () => { throw new DrillRefused('MARKER_MISSING', 'no marker'); },
      openContext,
      jobs: { 'settlement-digest': job, 'convert-trials': job, 'billing-cycle': job },
    });
    await expect(refused).rejects.toBeInstanceOf(DrillRefused);
    expect(openContext).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
  });

  it('a usage error is raised before the guard is even asked', async () => {
    const assertTarget = vi.fn();
    await expect(runDrillJobs(['nope'], { assertTarget, openContext: vi.fn() })).rejects.toBeInstanceOf(DrillUsageError);
    expect(assertTarget).not.toHaveBeenCalled();
  });

  it('a passing guard runs each named job once, in order, on one context, and closes it', async () => {
    const calls: string[] = [];
    const close = vi.fn(async () => { calls.push('close'); });
    const job = (name: string) => vi.fn(async (ctx: JobContext) => { expect(ctx).toBe(fakeCtx); calls.push(name); });
    const jobs = { 'settlement-digest': job('settlement-digest'), 'convert-trials': job('convert-trials'), 'billing-cycle': job('billing-cycle') };
    const out = await runDrillJobs(['convert-trials', 'billing-cycle'], {
      assertTarget: async () => { calls.push('guard'); return target; },
      openContext: async () => { calls.push('open'); return { ctx: fakeCtx, close }; },
      jobs,
    });
    expect(calls).toEqual(['guard', 'open', 'convert-trials', 'billing-cycle', 'close']);
    expect(jobs['settlement-digest']).not.toHaveBeenCalled();
    expect(out.target).toBe(target);
    expect(out.runs.map((r) => r.job)).toEqual(['convert-trials', 'billing-cycle']);
  });

  it('a job that throws stops the rest and still closes the context', async () => {
    const close = vi.fn(async () => undefined);
    const later = vi.fn();
    const run = runDrillJobs(['convert-trials', 'billing-cycle'], {
      assertTarget: async () => target,
      openContext: async () => ({ ctx: fakeCtx, close }),
      jobs: { 'settlement-digest': later, 'convert-trials': async () => { throw new Error('boom'); }, 'billing-cycle': later },
    });
    await expect(run).rejects.toThrow('boom');
    expect(later).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('[STG-DRILLS] the boot entries refuse for real (spawned, like the worker container runs them)', () => {
  // Nothing listens on port 1: an entry that tried to connect would fail with a
  // connection error (exit 1), never the refusal (exit 3) asserted here.
  const base = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    DATABASE_URL: 'postgresql://swift:swift@localhost:1/swift_test_unreachable',
    REDIS_URL: 'redis://localhost:1/2',
    NODE_ENV: 'test',
  };
  const run = (entry: string, args: string[], env: Record<string, string>) =>
    spawnSync(TSX, [join('src/boot', entry), ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 90_000 });

  it('drill-run-job: no staging marker → exit 3, nothing printed, no socket', () => {
    const r = run('drill-run-job.ts', ['settlement-digest'], base);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('MARKER_MISSING');
    expect(r.stdout).toBe('');
  });

  it('drill-run-job: NODE_ENV=production with the marker → exit 3', () => {
    const r = run('drill-run-job.ts', ['billing-cycle'], { ...base, NODE_ENV: 'production', SWIFT_STAGING_DRILLS: '1' });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('PRODUCTION_ENV');
  });

  it('drill-run-job: the wrong database (not a disposable test database) → exit 3', () => {
    const r = run('drill-run-job.ts', ['billing-cycle'], { ...base, SWIFT_STAGING_DRILLS: '1', DATABASE_URL: 'postgresql://swift:swift@localhost:1/swift' });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('WRONG_DB_NAME');
  });

  it('drill-run-job: a job outside the allowlist → exit 2, before anything else', () => {
    const r = run('drill-run-job.ts', ['process-billing'], { ...base, SWIFT_STAGING_DRILLS: '1' });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('not an allowlisted drill job');
  });

  it('drill-fixtures: no marker → exit 3; no run id or a live admin phone → exit 2', () => {
    const refused = run('drill-fixtures.ts', ['create', '--run-id', 'r1', '--admin-phone', '+5920400000'], base);
    expect(refused.status, refused.stderr).toBe(3);
    expect(refused.stderr).toContain('MARKER_MISSING');
    expect(run('drill-fixtures.ts', ['create', '--admin-phone', '+5920400000'], { ...base, SWIFT_STAGING_DRILLS: '1' }).status).toBe(2);
    expect(run('drill-fixtures.ts', ['create', '--run-id', 'r1', '--admin-phone', '+5926001000'], { ...base, SWIFT_STAGING_DRILLS: '1' }).status).toBe(2);
  });
});

describe('[STG-DRILLS] the entries ship in the image', () => {
  it('tsconfig.build.json compiles src/boot and src/modules (only tests are excluded), and the Dockerfile copies dist/', () => {
    const build = readFileSync(join(process.cwd(), 'tsconfig.build.json'), 'utf8');
    const base = JSON.parse(readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf8')) as { include: string[]; compilerOptions: { rootDir: string; outDir: string } };
    expect(base.include).toEqual(['src']);
    expect(base.compilerOptions).toMatchObject({ rootDir: './src', outDir: './dist' });
    expect(build).toContain('"extends": "./tsconfig.json"');
    const excluded = JSON.parse(build.replace(/^\s*\/\/.*$/gm, '')).exclude as string[];
    for (const pattern of excluded) expect(pattern).not.toMatch(/boot|modules\/ops|drills/);
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY --from=build /app/apps/api/dist ./apps/api/dist');
    expect(dockerfile).toContain('WORKDIR /app/apps/api');
  });
});
