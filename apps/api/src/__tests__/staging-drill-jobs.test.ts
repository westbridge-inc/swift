import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runWeeklySettlement, type JobContext } from '../jobs/queue';
import { DRILL_JOBS, DRILL_JOB_NAMES, parseDrillJobs, runDrillJobs, DrillUsageError } from '../modules/ops/drills/jobs';
import { DrillRefused, type DrillTarget } from '../modules/ops/drills/guard';

// ---------------------------------------------------------------------------
// [STG-DRILLS D4] The run-once job trigger. It must run the SAME function the
// worker runs — pinned here by import identity, and by the worker's own
// processor delegating to that export (a copy in either place goes red) — and
// it must refuse, before any job context exists, unless the drill guard
// passes. [AX324 R2] It can never run a billing job: those sweep every due
// subscription on the database. The boot entries are spawned for real: a
// production process, one without the staging marker, one on the wrong
// database or with a foreign system login, is refused without a socket.
// ---------------------------------------------------------------------------

const QUEUE_SRC = readFileSync(join(process.cwd(), 'src/jobs/queue.ts'), 'utf8');
const TSX = join(process.cwd(), 'node_modules/.bin/tsx');

/** The body of one `case '<name>': { … }` in queue.ts, up to its break. */
function caseBody(name: string): string {
  const start = QUEUE_SRC.indexOf(`case '${name}': {`);
  expect(start, `queue.ts has no case '${name}'`).toBeGreaterThan(-1);
  return QUEUE_SRC.slice(start, QUEUE_SRC.indexOf('break;', start));
}

describe('[STG-DRILLS] the trigger runs the worker’s own function — by identity, never a copy', () => {
  it('the allowlist is exactly the settlement digest, the worker export itself', () => {
    expect(DRILL_JOB_NAMES).toEqual(['settlement-digest']);
    expect(DRILL_JOBS['settlement-digest']).toBe(runWeeklySettlement);
  });

  it('the worker’s processor delegates to that same export', () => {
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
    expect(() => parseDrillJobs(['settlement-digest', 'settlement-digest'])).toThrow(/named twice/);
    expect(() => parseDrillJobs(['toString'])).toThrow(/not an allowlisted/);
    expect(() => parseDrillJobs(['__proto__'])).toThrow(/not an allowlisted/);
    expect(parseDrillJobs(['settlement-digest'])).toEqual(['settlement-digest']);
  });
});

describe('[AX324 R2] no drill can run a billing sweep', () => {
  it('the billing cycle and the trial conversion are usage errors, alone or beside the digest', () => {
    for (const names of [['billing-cycle'], ['convert-trials'], ['convert-trials', 'billing-cycle'], ['settlement-digest', 'billing-cycle']]) {
      expect(() => parseDrillJobs(names), names.join(' ')).toThrow(/not an allowlisted drill job/);
    }
  });

  it('refused before the guard is even asked — nothing connects', async () => {
    const assertTarget = vi.fn();
    const openContext = vi.fn();
    await expect(runDrillJobs(['convert-trials', 'billing-cycle'], { assertTarget, openContext })).rejects.toBeInstanceOf(DrillUsageError);
    expect(assertTarget).not.toHaveBeenCalled();
    expect(openContext).not.toHaveBeenCalled();
  });

  it('production code was not widened for a drill: queue.ts exports no billing job body for a caller to run', () => {
    expect(QUEUE_SRC).not.toMatch(/export\s+(async\s+)?function\s+run(BillingCycle|ConvertTrials)Job/);
    expect(caseBody('process-billing')).toContain('billing.runBillingCycle()');
    expect(caseBody('convert-trials')).toContain('.convertExpiredTrials()');
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
      jobs: { 'settlement-digest': job },
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

  it('a passing guard runs the named job once, on one context, and closes it', async () => {
    const calls: string[] = [];
    const close = vi.fn(async () => { calls.push('close'); });
    const job = vi.fn(async (ctx: JobContext) => { expect(ctx).toBe(fakeCtx); calls.push('settlement-digest'); });
    const out = await runDrillJobs(['settlement-digest'], {
      assertTarget: async () => { calls.push('guard'); return target; },
      openContext: async () => { calls.push('open'); return { ctx: fakeCtx, close }; },
      jobs: { 'settlement-digest': job },
    });
    expect(calls).toEqual(['guard', 'open', 'settlement-digest', 'close']);
    expect(job).toHaveBeenCalledTimes(1);
    expect(out.target).toBe(target);
    expect(out.runs.map((r) => r.job)).toEqual(['settlement-digest']);
  });

  it('a job that throws still closes the context, and the failure surfaces', async () => {
    const close = vi.fn(async () => undefined);
    const run = runDrillJobs(['settlement-digest'], {
      assertTarget: async () => target,
      openContext: async () => ({ ctx: fakeCtx, close }),
      jobs: { 'settlement-digest': async () => { throw new Error('boom'); } },
    });
    await expect(run).rejects.toThrow('boom');
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
    const r = run('drill-run-job.ts', ['settlement-digest'], { ...base, NODE_ENV: 'production', SWIFT_STAGING_DRILLS: '1' });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('PRODUCTION_ENV');
  });

  it('drill-run-job: the wrong database (not a disposable test database) → exit 3', () => {
    const r = run('drill-run-job.ts', ['settlement-digest'], { ...base, SWIFT_STAGING_DRILLS: '1', DATABASE_URL: 'postgresql://swift:swift@localhost:1/swift' });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('WRONG_DB_NAME');
  });

  it('drill-run-job: [AX324 R2] the billing jobs → exit 2 with a perfect drill environment, before any socket', () => {
    for (const job of ['billing-cycle', 'convert-trials']) {
      const r = run('drill-run-job.ts', [job], { ...base, SWIFT_STAGING_DRILLS: '1' });
      expect(r.status, `${job}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain('not an allowlisted drill job');
      expect(r.stdout).toBe('');
    }
  });

  it('drill-run-job and drill-fixtures: [AX324 R1] a system login on another database → exit 3, before any socket', () => {
    const foreign = { ...base, SWIFT_STAGING_DRILLS: '1', TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: 'postgresql://sys:pw@db.internal:5432/swift_live' };
    for (const [entry, args] of [['drill-run-job.ts', ['settlement-digest']], ['drill-fixtures.ts', ['cleanup', '--run-id', 'r1']]] as const) {
      const r = run(entry, [...args], foreign);
      expect(r.status, `${entry}: ${r.stderr}`).toBe(3);
      expect(r.stderr).toContain('SYSTEM_DB_MISMATCH');
      expect(r.stdout).toBe('');
    }
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

describe('[AX324 R3 · R7] the guard-only and evidence entries refuse for real', () => {
  const base = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    DATABASE_URL: 'postgresql://swift:swift@localhost:1/swift_test_unreachable',
    REDIS_URL: 'redis://localhost:1/2',
    NODE_ENV: 'test',
  };
  const run = (entry: string, args: string[], env: Record<string, string>) =>
    spawnSync(TSX, [join('src/boot', entry), ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 90_000 });

  it('drill-guard: production, no marker, the wrong database, a foreign system login or a foreign Redis → exit 3, nothing on stdout', () => {
    for (const [env, want] of [
      [{ ...base, NODE_ENV: 'production', SWIFT_STAGING_DRILLS: '1' }, 'PRODUCTION_ENV'],
      [base, 'MARKER_MISSING'],
      [{ ...base, SWIFT_STAGING_DRILLS: '1', DATABASE_URL: 'postgresql://swift:swift@localhost:1/swift' }, 'WRONG_DB_NAME'],
      [{ ...base, SWIFT_STAGING_DRILLS: '1', DATABASE_URL: 'postgresql://swift:swift@db.swiftgy.com:5432/swift_test_x' }, 'WRONG_DB_HOST'],
      [{ ...base, SWIFT_STAGING_DRILLS: '1', TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: 'postgresql://sys:pw@localhost:1/swift_prod' }, 'SYSTEM_DB_MISMATCH'],
      [{ ...base, SWIFT_STAGING_DRILLS: '1', REDIS_URL: 'redis://cache.internal:6379' }, 'WRONG_REDIS_HOST'],
    ] as const) {
      const r = run('drill-guard.ts', [], env);
      expect(r.status, `${want}: ${r.stderr}`).toBe(3);
      expect(r.stderr).toContain(want);
      expect(r.stdout).toBe('');
    }
  });

  it('drill-guard: arguments are a usage error (it only judges)', () => {
    expect(run('drill-guard.ts', ['create'], { ...base, SWIFT_STAGING_DRILLS: '1' }).status).toBe(2);
  });

  it('drill-evidence: no marker → exit 3; a malformed order id or mode → exit 2', () => {
    const refused = run('drill-evidence.ts', ['crash', '--order', 'cl0000000000000000000order1'], base);
    expect(refused.status, refused.stderr).toBe(3);
    expect(refused.stderr).toContain('MARKER_MISSING');
    for (const args of [['crash', '--order', "x'; DROP TABLE orders"], ['crash'], ['wipe', '--order', 'cl0000000000000000000order1']]) {
      expect(run('drill-evidence.ts', args, { ...base, SWIFT_STAGING_DRILLS: '1' }).status, args.join(' ')).toBe(2);
    }
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
