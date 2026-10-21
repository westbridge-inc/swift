import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { buildWalkWorld, type WalkWorld } from './helpers/order-walk-world';
import {
  describeAction, runTrace, shrink, walkSeed, violationKey,
  type Trace, type Violation, type WalkResult,
} from './helpers/order-walk';

// ---------------------------------------------------------------------------
// [ORDER-FLOW · random walk] Every order, whatever anybody does to it, stays
// lawful: its log tells its history along declared edges, refused requests move
// nothing, cash is never refunded beyond what was taken, a mover is paid once,
// pointers and views agree, a person is told a thing once per status — and
// when everybody stops acting, the order still ENDS.
//
// The walks are real: every door is the production route, every sweep and job
// is the production handler (helpers/order-walk-world.ts says exactly what is a
// double). Seeds replay and shrink:
//
//   WALK_SEEDS=1,2,3        the seeds to walk (default: DEFAULT_SEEDS)
//   WALK_SEED_COUNT=200     walk seeds 1..N instead (local exploration)
//   WALK_TRACE='{"riders":1,"actions":[...]}'   replay ONE trace, exactly
//   WALK_SHRINK=0           report unknown violations without shrinking
//   WALK_REPORT=/path.txt   also write the run report (coverage map) there
//
// A violation is KNOWN when helpers/order-walk.ts `classify` names its
// FINDINGS.txt id; known ones are reported, never failed. An UNKNOWN one fails
// with its shrunk trace. Each known finding also has a PINNED trace below that
// must keep producing it: the PR that fixes the finding deletes its classify
// line and its pin, and the pin is what proves the fix (red before, gone after).
// ---------------------------------------------------------------------------

/** Chosen by greedy coverage over seeds 1..40 (21 Oct, on a database with
 *  every migration, the status-log append-only trigger included, and walk
 *  tokens that outlive a slow run), with each known finding kept: together
 *  they reach two deliveries, a cancellation, a handback, both custody
 *  findings (OF-33, OF-12), the OF-01 notice repeat and 83 of the 163
 *  distinct (status, action, outcome) / log-edge / violation features the 40
 *  reached. A wider sweep is `WALK_SEED_COUNT=40` locally (8 to 100 minutes,
 *  by machine load; past 30 the test times out, so walk them in parts with
 *  `WALK_SEEDS`). */
const DEFAULT_SEEDS = [10, 9, 24, 30, 13];

/** The smallest traces that produce each recorded finding (shrunk). */
const PINNED: Array<{ finding: string; inv: string; why: string; trace: Trace }> = [
  {
    finding: 'OF-02', inv: 'REFUND-OVER-CAPTURED',
    why: 'admin "record refund owed" on a cash order whose cash was never taken records the whole total as owed',
    trace: { riders: 1, actions: [{ a: 'admin.cancel', refund: true }] },
  },
  {
    finding: 'OF-33', inv: 'EXIT',
    why: 'a rider who accepted and then never moves, GPS alive, holds the order forever (food-age reads riderless orders only)',
    trace: { riders: 1, actions: [{ a: 'store.accept' }, { a: 'store.preparing' }, { a: 'store.ready' }, { a: 'rider.accept', r: 0 }, { a: 'abandon', ridersOnline: true }] },
  },
];

/** Fixed findings: their old pinned traces must now walk CLEAN (no violation
 *  at all) and end where the fix says. */
const FIXED: Array<{ finding: string; why: string; trace: Trace; ends: string }> = [
  {
    finding: 'OF-01', ends: 'CANCELLED',
    why: 'a store-accepted order nobody marks ready, with no rider, is told once, then cancelled after the grace — and nobody is told anything twice',
    trace: { riders: 1, actions: [{ a: 'store.accept' }, { a: 'abandon', ridersOnline: false }] },
  },
];

let w: WalkWorld;

beforeAll(async () => {
  w = await buildWalkWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
});

const fmtTrace = (t: Trace) => `riders=${t.riders}: ${t.actions.map(describeAction).join(' → ') || '(checkout only)'}`;
const fmtViolation = (x: Violation) => `${x.finding ?? 'UNKNOWN'} ${x.inv} after #${x.at} [${x.status}] ${x.detail}`;

function report(lines: string[]): void {
  const text = lines.join('\n');
  process.stderr.write(`${text}\n`);
  const path = process.env['WALK_REPORT'];
  if (path) writeFileSync(path, `${text}\n`, { flag: 'a' });
}

function seeds(): number[] {
  const count = Number(process.env['WALK_SEED_COUNT'] ?? 0);
  if (count > 0) return Array.from({ length: count }, (_, i) => i + 1);
  const listed = (process.env['WALK_SEEDS'] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return listed.length > 0 ? listed : DEFAULT_SEEDS;
}

describe('[ORDER-FLOW] random walks over the order state machine', () => {
  it('every walk holds every invariant; known findings are named, an unknown one fails with its shrunk trace', async () => {
    const replay = process.env['WALK_TRACE'];
    const results: Array<{ seed: number | 'trace'; result: WalkResult }> = [];
    const crashed: string[] = [];
    const one = async (seed: number | 'trace', run: () => Promise<WalkResult>) => {
      try {
        const result = await run();
        results.push({ seed, result });
        report([
          `walked seed ${seed}: ${result.finalStatus ?? 'no order'} · ${result.violations.length} violation(s)`,
          `json ${JSON.stringify({ seed, final: result.finalStatus, coverage: [...result.coverage.keys()], edges: [...result.edges], violations: result.violations.map(violationKey) })}`,
          // An unknown one is named at once, so a run cut short still says what it saw.
          ...result.violations.filter((x) => x.finding === null).map((x) => `   ${fmtViolation(x)}`),
        ]);
      } catch (err) {
        // A walk that THROWS is not a verdict on the product (a lost database
        // connection looks the same): it is named, and the run fails on it.
        const why = (err instanceof Error ? err.message : String(err)).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
        crashed.push(`seed ${seed}: ${why}`);
        report([`walked seed ${seed}: CRASHED · ${why}`]);
      }
    };
    if (replay) await one('trace', () => runTrace(w, JSON.parse(replay) as Trace));
    else for (const seed of seeds()) await one(seed, () => walkSeed(w, seed));

    const lines: string[] = ['', '== ORDER RANDOM WALK =='];
    const unknown: string[] = [];
    const coverage = new Map<string, number>();
    const edges = new Set<string>();
    const findings = new Map<string, number>();
    const shrunkKeys = new Set<string>();
    for (const { seed, result } of results) {
      for (const [k, n] of result.coverage) coverage.set(k, (coverage.get(k) ?? 0) + n);
      for (const e of result.edges) edges.add(e);
      lines.push(`seed ${seed}: ${result.finalStatus ?? 'no order'} · ${fmtTrace(result.trace)}`);
      const firstOfKey = new Map<string, Violation>();
      for (const x of result.violations) if (!firstOfKey.has(violationKey(x))) firstOfKey.set(violationKey(x), x);
      for (const x of firstOfKey.values()) {
        lines.push(`   ${fmtViolation(x)}`);
        if (x.finding) findings.set(x.finding, (findings.get(x.finding) ?? 0) + 1);
        else {
          // Shrink each distinct unknown violation once; later seeds name it.
          if (shrunkKeys.has(violationKey(x))) { unknown.push(`seed ${seed}: ${fmtViolation(x)} (same key as above)`); continue; }
          shrunkKeys.add(violationKey(x));
          let shrunk = result.trace;
          if (process.env['WALK_SHRINK'] !== '0') shrunk = (await shrink(w, result.trace, x)).trace;
          unknown.push(`seed ${seed}: ${fmtViolation(x)}\n   shrunk: ${fmtTrace(shrunk)}\n   replay: WALK_TRACE='${JSON.stringify(shrunk)}'`);
        }
      }
    }
    lines.push(`known findings seen: ${[...findings].map(([f, n]) => `${f}×${n}`).join(', ') || 'none'}`);
    lines.push(`log edges seen (${edges.size}): ${[...edges].sort().join(' ')}`);
    lines.push(`jobs without a walk handler: ${[...w.sched.unhandled].map(([n, c]) => `${n}×${c}`).join(', ') || 'none'}`);
    lines.push('coverage (status --action--> status [http]):');
    for (const [k, n] of [...coverage].sort()) lines.push(`   ${String(n).padStart(3)}  ${k}`);
    report(lines);

    expect(crashed, crashed.join('\n')).toEqual([]);
    expect(results.every(({ result }) => result.orderId !== null), 'every walk placed its order').toBe(true);
    expect(unknown, unknown.join('\n')).toEqual([]);
  }, 1_800_000);

  for (const fixed of FIXED) {
    it(`FIXED ${fixed.finding}: its pinned trace now walks clean and ends ${fixed.ends} (${fixed.why})`, async () => {
      const result = await runTrace(w, fixed.trace);
      expect(result.violations.map(fmtViolation)).toEqual([]);
      expect(result.finalStatus).toBe(fixed.ends);
    }, 300_000);
  }

  // One run per distinct trace (a 24-hour abandon is the expensive part).
  const byTrace = new Map<string, typeof PINNED>();
  for (const pin of PINNED) byTrace.set(JSON.stringify(pin.trace), [...(byTrace.get(JSON.stringify(pin.trace)) ?? []), pin]);
  for (const [key, pins] of byTrace) {
    const names = pins.map((p) => `${p.finding} ${p.inv}`).join(' + ');
    it(`PINNED ${names} still reproduce${pins.length === 1 ? 's' : ''} (${pins.map((p) => p.why).join('; ')}) — the fix deletes its pin`, async () => {
      const trace = JSON.parse(key) as Trace;
      const result = await runTrace(w, trace);
      for (const pin of pins) {
        const hit = result.violations.filter((x) => x.finding === pin.finding && x.inv === pin.inv);
        expect(hit.length, `expected ${pin.finding} ${pin.inv} from ${fmtTrace(trace)}; got ${result.violations.map(fmtViolation).join(' | ') || 'no violation'}`).toBeGreaterThan(0);
      }
      expect(result.violations.filter((x) => x.finding === null).map(fmtViolation)).toEqual([]);
    }, 300_000);
  }
});
