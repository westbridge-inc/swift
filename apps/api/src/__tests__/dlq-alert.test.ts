import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { dlqAlertThreshold, DEFAULT_JOB_OPTIONS } from '../jobs/queue';

/**
 * [N4 · WS-8.1] The dead letters had neither an alarm nor a door.
 *
 * A job that exhausts its attempts lands in BullMQ's failed set and stays
 * there. Nothing told anyone, and the three admin endpoints that can read and
 * act on that set — `GET /dlq`, `POST /dlq/:queue/:id/requeue`,
 * `DELETE /dlq/:queue/:id` — had no caller in any client. So the failure of
 * process-billing (hourly), process-settlements (Sunday 00:00),
 * poll-mmg-billing (every 2 minutes) or billing-invariants (nightly) was
 * invisible in both directions at once: nobody was told, and nobody could look.
 *
 * These tests guard the threshold's parse, the alarm's wiring, and — the one
 * that actually keeps this closed — that the endpoints still have a caller.
 */

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('dlqAlertThreshold — a mis-set variable must not disable the alarm', () => {
  it('defaults to one, because one dead money job is worth a page', () => {
    expect(dlqAlertThreshold({})).toBe(1);
  });

  it('accepts a whole number', () => {
    expect(dlqAlertThreshold({ DLQ_ALERT_THRESHOLD: '25' })).toBe(25);
  });

  it('falls back rather than becoming NaN', () => {
    // `total >= NaN` is false for every total, so a partial parse would silently
    // switch the alarm off forever — the exact failure mode this alarm exists to
    // prevent, one layer up. Only an entirely-numeric string counts.
    for (const junk of ['five', '', ' ', '-3', '2.5', '10 jobs', '0']) {
      expect(dlqAlertThreshold({ DLQ_ALERT_THRESHOLD: junk })).toBe(1);
    }
  });
});

describe('failures are retained long enough to be seen', () => {
  it('keeps failed jobs after their attempts are exhausted', () => {
    // removeOnFail as a NUMBER keeps that many; `true` would delete them the
    // instant they died and there would be nothing for the page to show.
    expect(typeof DEFAULT_JOB_OPTIONS.removeOnFail).toBe('number');
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBeGreaterThan(0);
    // Retention is finite, which is why the admin page states the bound instead
    // of implying an empty list means nothing ever failed.
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });
});

describe('the alarm is wired into the heartbeat', () => {
  const queue = src('src/jobs/queue.ts');

  it('measures the failed SET, not the per-attempt failure event', () => {
    // `worker.on('failed')` fires on every attempt, including ones a retry then
    // succeeds — paging on it would cry wolf and get muted. Only a job that ran
    // out of attempts is a dead letter.
    expect(queue).toContain('getFailedCount()');
    expect(queue).toMatch(/dlqAlertThreshold\(\)/);
  });

  it('pages through the deduplicated ops rail, like the pool alarm beside it', () => {
    expect(queue).toMatch(/opsPageOnce\(\s*ctx,\s*'dlq-non-empty'/);
    expect(queue).toContain('ops_dlq_non_empty');
  });

  it('does not swallow its own failure silently', () => {
    // An alarm that stops alarming without saying so is the defect, not the
    // symptom. The catch must log.
    const block = queue.slice(queue.indexOf('getFailedCount()'));
    const nextCatch = block.slice(0, block.indexOf('return;'));
    expect(nextCatch).toMatch(/catch \(err\)/);
    expect(nextCatch).toMatch(/ctx\.log\.warn/);
  });
});

describe('the door: the DLQ endpoints have a caller again', () => {
  // The route-reachability sweep's criterion, turned into a gate. An endpoint
  // with no client is this codebase's recurring defect — a finished, tested
  // engine that reaches nobody (#807's SOS fan-out, #817's report queue,
  // #822's ads gates). Re-orphaning these three should fail the build.
  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const adminSources = walk(join(process.cwd(), '../admin/src'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  it('finds the admin app reading the queue', () => {
    expect(adminSources).toContain('/api/v1/admin/dlq');
  });

  it('finds the admin app able to retry a dead job', () => {
    expect(adminSources).toMatch(/dlq\/\$\{queue\}\/\$\{id\}\/requeue/);
  });

  it('finds the admin app able to discard one', () => {
    expect(adminSources).toMatch(/method: 'DELETE'/);
    // Not anchored on the closing backtick: the call now appends the job's
    // identity as a query string (the compare half of compare-and-delete,
    // R037-09), and a gate that pins the exact literal breaks on every
    // legitimate change to the call rather than on the orphaning it guards.
    expect(adminSources).toMatch(/dlq\/\$\{queue\}\/\$\{id\}/);
  });

  it('sends the job identity, so the server can refuse a stale row [R037-09]', () => {
    expect(adminSources).toMatch(/expectedName/);
    expect(adminSources).toMatch(/expectedFinishedOn/);
  });

  it('finds the page reachable from navigation, not only by typing the URL', () => {
    // A page nothing links to is only a marginally better door than no page.
    const sidebar = readFileSync(join(process.cwd(), '../admin/src/components/layout/Sidebar.tsx'), 'utf8');
    expect(sidebar).toMatch(/href: '\/jobs'/);
  });
});
