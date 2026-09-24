// The journey framework [TASK-057]: one Journey per ledger journey id, each a
// sequence of recorded steps against the live API. A step records what was
// asserted and the evidence (statuses, codes, the durable state read back).
//
// Status rules (never a faked PASS):
//   FAIL  any executed step failed, or the flow threw, or the journey ran no
//         negative (wrong-role / wrong-actor / bad-input) check;
//   SKIP  the journey's defining case cannot run on this target — `reason`
//         says exactly why (steps that did run are kept as evidence);
//   PASS  every executed step passed AND every server-side ledger case ran.
//         Only DEVICE-GATE cases (a real SIM receiving SMS, a camera, two
//         physical phones, OS backgrounding — the ledger's separate device
//         gate) may remain unproven under a PASS; they are listed in
//         `skippedCases` with gate 'device' and named in `reason`.
//   A case this target cannot run for any other reason (no second admin, a
//   clock-driven job, a dark feature flag, a provider secret the runner must
//   not hold) is a 'target' skip, and it makes the journey SKIP.

import type { Res } from './client.js';

export type Status = 'PASS' | 'FAIL' | 'SKIP';

export interface Step { name: string; ok: boolean; detail: string }
export interface SkippedCase { case: string; reason: string; gate: 'device' | 'target' }

export interface TargetInfo { deploymentId: string; environment: string; buildSha: string }

export interface JourneyResult {
  journeyId: string;
  title: string;
  status: Status;
  reason?: string;
  steps: Step[];
  skippedCases: SkippedCase[];
  startedAt: string;
  finishedAt: string;
  target: TargetInfo;
  runId: string;
}

/** Thrown to stop a journey early after a failed prerequisite (already recorded). */
export class Halt extends Error {
  constructor(message: string) { super(message); this.name = 'Halt'; }
}

const brief = (r: Res): string => {
  const code = r.json?.error?.code;
  return `${r.status}${code ? ` ${code}` : ''}`;
};

export class Recorder {
  readonly steps: Step[] = [];
  readonly skipped: SkippedCase[] = [];
  negatives = 0;
  wholeSkip: string | null = null;

  /** Record a step. Returns `ok` so a flow can branch on it. */
  step(name: string, ok: boolean, detail: string): boolean {
    this.steps.push({ name, ok, detail });
    return ok;
  }

  /** A denial check: the wrong actor (or bad input) must be refused. Counts toward the negative-check rule. */
  deny(name: string, r: Res, statuses: number[], codes?: string[], extra = ''): boolean {
    this.negatives += 1;
    const code = String(r.json?.error?.code ?? '');
    const ok = statuses.includes(r.status) && (!codes || codes.length === 0 || codes.includes(code));
    const want = `${statuses.join('|')}${codes?.length ? ` ${codes.join('|')}` : ''}`;
    return this.step(`DENY ${name}`, ok, `got ${brief(r)}; expected ${want}${extra ? `; ${extra}` : ''}`);
  }

  /** Expect a status (and optionally a code). */
  expect(name: string, r: Res, statuses: number | number[], codes?: string[], extra = ''): boolean {
    const list = Array.isArray(statuses) ? statuses : [statuses];
    const code = String(r.json?.error?.code ?? '');
    const ok = list.includes(r.status) && (!codes || codes.length === 0 || codes.includes(code));
    const want = `${list.join('|')}${codes?.length ? ` ${codes.join('|')}` : ''}`;
    return this.step(name, ok, `got ${brief(r)}; expected ${want}${extra ? `; ${extra}` : ''}${ok ? '' : ` — ${r.text.slice(0, 240)}`}`);
  }

  /** Expect success, or stop the journey (the rest depends on it). */
  must(name: string, r: Res, statuses: number | number[] = [200, 201], extra = ''): any {
    if (!this.expect(name, r, statuses, undefined, extra)) throw new Halt(`${name} failed`);
    return r.json?.data;
  }

  /** Assert a condition on state read back from the API. */
  check(name: string, ok: boolean, detail: string): boolean {
    return this.step(name, ok, detail);
  }

  /** Assert or stop. */
  require(name: string, ok: boolean, detail: string): void {
    if (!this.step(name, ok, detail)) throw new Halt(`${name} failed`);
  }

  /** A server-side ledger case this target cannot run (forces SKIP), with the exact reason. */
  skipCase(caseName: string, reason: string): void {
    this.skipped.push({ case: caseName, reason, gate: 'target' });
  }

  /** A case that only a physical device can prove (the ledger's device gate); does not block a PASS. */
  deviceCase(caseName: string, reason: string): void {
    this.skipped.push({ case: caseName, reason, gate: 'device' });
  }

  /** The whole journey cannot run here. */
  skipAll(reason: string): void {
    this.wholeSkip = reason;
  }
}

export interface Journey<C> {
  id: string;
  title: string;
  /** The ledger's case list for this journey, verbatim. */
  cases: string;
  /** Rough wall-clock need in seconds (the scheduler fills the hold window with journeys that fit). */
  estimateSeconds?: number;
  /**
   * Optional early phase: place the orders this journey needs while the
   * LIFECYCLE_V2 hold (5 minutes) runs down for every journey at once. Its
   * steps belong to the journey; a Halt here stops only this journey.
   */
  prepare?: (rec: Recorder, ctx: C) => Promise<void>;
  /**
   * Optional: right after the prepared orders leave their hold. A store must
   * accept within the auto-reject window (hold + 5 minutes), so journeys
   * accept (or otherwise claim) their prepared orders here, before the run.
   */
  release?: (rec: Recorder, ctx: C) => Promise<void>;
  run: (rec: Recorder, ctx: C) => Promise<void>;
  /** Optional: checks that need wall-clock time to pass (an expiry), run at the very end. */
  finish?: (rec: Recorder, ctx: C) => Promise<void>;
}

/** One journey's live recording across its prepare and run phases. */
export class JourneyRun<C> {
  readonly rec = new Recorder();
  readonly startedAt = new Date().toISOString();
  halted = false;
  constructor(readonly journey: Journey<C>) {}

  private async phase(fn: (rec: Recorder, ctx: C) => Promise<void>, ctx: C): Promise<void> {
    if (this.halted) return;
    try {
      await fn(this.rec, ctx);
    } catch (e: any) {
      this.halted = true;
      if (!(e instanceof Halt)) this.rec.step('flow completed without an exception', false, `threw: ${e?.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`);
    }
  }

  prepare(ctx: C) { return this.journey.prepare ? this.phase(this.journey.prepare, ctx) : Promise.resolve(); }
  release(ctx: C) { return this.journey.release ? this.phase(this.journey.release, ctx) : Promise.resolve(); }
  run(ctx: C) { return this.phase(this.journey.run, ctx); }
  finish(ctx: C) { return this.journey.finish ? this.phase(this.journey.finish, ctx) : Promise.resolve(); }

  result(target: TargetInfo, runId: string): JourneyResult {
    return finalize(this.journey, this.rec, this.startedAt, target, runId);
  }
}

export async function runJourney<C>(j: Journey<C>, ctx: C, target: TargetInfo, runId: string): Promise<JourneyResult> {
  const r = new JourneyRun(j);
  await r.prepare(ctx);
  await r.release(ctx);
  await r.run(ctx);
  await r.finish(ctx);
  return r.result(target, runId);
}

function finalize<C>(j: Journey<C>, rec: Recorder, startedAt: string, target: TargetInfo, runId: string): JourneyResult {
  const finishedAt = new Date().toISOString();
  // A copy: finalize may run more than once (progress line, then the report).
  const steps = [...rec.steps];
  const failed = steps.filter((s) => !s.ok);
  let status: Status;
  let reason: string | undefined;
  if (failed.length > 0) {
    // A failure observed is reported even when the journey's core could not run.
    status = 'FAIL';
    reason = `failed: ${failed.map((s) => s.name).join('; ')}`;
  } else if (rec.wholeSkip) {
    // The defining case cannot run here; any steps that did run stay as evidence.
    status = 'SKIP';
    reason = rec.wholeSkip;
  } else if (rec.skipped.some((c) => c.gate === 'target')) {
    status = 'SKIP';
    reason = `every executed step passed, but these cases cannot run on this target: ${rec.skipped.filter((c) => c.gate === 'target').map((c) => `${c.case} (${c.reason})`).join('; ')}`;
  } else if (steps.length === 0) {
    status = 'SKIP';
    reason = rec.wholeSkip ?? 'no step could run on this target';
  } else if (rec.negatives === 0) {
    steps.push({ name: 'runner coverage: at least one negative check', ok: false, detail: 'this flow executed no wrong-actor/bad-input denial' });
    status = 'FAIL';
    reason = 'runner coverage: no negative check executed';
  } else {
    status = 'PASS';
    if (rec.skipped.length > 0) {
      reason = `every server-side case passed; left to the device gate: ${rec.skipped.map((s) => `${s.case} (${s.reason})`).join('; ')}`;
    }
  }
  return {
    journeyId: j.id,
    title: j.title,
    status,
    ...(reason ? { reason } : {}),
    steps,
    skippedCases: [...rec.skipped],
    startedAt,
    finishedAt,
    target,
    runId,
  };
}
