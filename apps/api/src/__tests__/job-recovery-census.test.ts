import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_RECOVERY, recoveryFor, requeueRefusal } from '../jobs/recovery-policy';

// ---------------------------------------------------------------------------
// [A-08] The DLQ page asserted, of all 53 job classes at once, that "every
// Swift job is written to be idempotent" — and offered one-click retry on the
// strength of it. Nobody had established that.
//
// The classification only protects anything if it stays COMPLETE. A job class
// added to the worker and forgotten here would fall through to the unknown
// branch, which refuses — safe, but silently un-retryable, and nobody would
// know why. This census is how it gets noticed.
// ---------------------------------------------------------------------------

const QUEUE = join(process.cwd(), 'src', 'jobs', 'queue.ts');

/** Every job name queue.ts actually dispatches on. */
function dispatchedNames(): string[] {
  const source = readFileSync(QUEUE, 'utf8');
  const byEquality = [...source.matchAll(/job\.name\s*===?\s*'([^']+)'/g)].map((m) => m[1]!);
  const bySwitch = [...source.matchAll(/case '([a-z0-9:_-]+)'/g)].map((m) => m[1]!);
  return [...new Set([...byEquality, ...bySwitch])].sort();
}

describe('[A-08] every job class has an answer about replaying it', () => {
  it('the scan found the worker and a realistic number of classes — not a silently empty census', () => {
    const names = dispatchedNames();
    expect(names.length).toBeGreaterThan(40);
    // Anchors: if the parse breaks, these disappear and the census stops
    // meaning anything.
    expect(names).toContain('process-billing');
    expect(names).toContain('dispatch-order');
  });

  it('the policy covers exactly the classes the worker dispatches — no strays, no gaps', () => {
    const dispatched = dispatchedNames();
    const classified = Object.keys(JOB_RECOVERY).sort();
    const missing = dispatched.filter((n) => !classified.includes(n));
    const stray = classified.filter((n) => !dispatched.includes(n));
    expect(missing, 'a job the worker runs with no recovery answer — add it to JOB_RECOVERY').toEqual([]);
    expect(stray, 'a recovery answer for a job that no longer exists — drop it').toEqual([]);
  });

  it('every certified class says WHY, in words a reviewer can check against the handler', () => {
    for (const [name, recovery] of Object.entries(JOB_RECOVERY)) {
      expect(recovery.why.length, name).toBeGreaterThan(20);
      if (recovery.policy === 'SAFE_REPLAY') {
        // The claim being checked is not evidence for itself.
        expect(recovery.why.toLowerCase(), `${name}: "the comment says idempotent" is not a certification`)
          .not.toMatch(/^the comment says/);
      }
    }
  });

  it('an unknown class is refused, never assumed safe', () => {
    expect(recoveryFor('a-job-that-does-not-exist').policy).toBe('NOT_CERTIFIED');
    expect(requeueRefusal('a-job-that-does-not-exist', false)).toMatch(/not certified/);
    // …and acknowledging a reconciliation does not unlock something uncertified.
    expect(requeueRefusal('a-job-that-does-not-exist', true)).toMatch(/not certified/);
  });

  it('a certified class replays; an uncertified one does not, whatever is acknowledged', () => {
    const certified = Object.entries(JOB_RECOVERY).find(([, r]) => r.policy === 'SAFE_REPLAY');
    expect(certified, 'at least one class must be certified or the tool is useless').toBeTruthy();
    expect(requeueRefusal(certified![0], false)).toBeNull();

    const uncertified = Object.entries(JOB_RECOVERY).find(([, r]) => r.policy === 'NOT_CERTIFIED');
    expect(uncertified).toBeTruthy();
    expect(requeueRefusal(uncertified![0], false)).not.toBeNull();
    expect(requeueRefusal(uncertified![0], true)).not.toBeNull();
  });

  it('money and notification jobs are NOT certified — the certified set is small and deliberate', () => {
    // The whole point is that these are the ones a second run would hurt.
    for (const name of ['process-billing', 'poll-mmg-billing', 'convert-trials', 'booking-reminders']) {
      expect(JOB_RECOVERY[name as keyof typeof JOB_RECOVERY]?.policy, name).not.toBe('SAFE_REPLAY');
    }
    const certified = Object.values(JOB_RECOVERY).filter((r) => r.policy === 'SAFE_REPLAY');
    expect(certified.length).toBeGreaterThan(0);
    expect(certified.length).toBeLessThan(Object.keys(JOB_RECOVERY).length / 2);
  });
});
