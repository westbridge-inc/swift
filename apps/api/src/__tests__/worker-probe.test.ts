import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerProbeOk } from '../boot/worker-probe';
import { DEFAULT_SCHEDULER_STALL_MINUTES, schedulerStallMs } from '../utils/scheduler-health';

// ---------------------------------------------------------------------------
// [STG-D] The dedicated worker container was permanently "unhealthy": the API
// image's HEALTHCHECK fetches GET /ready, and dist/worker.js serves no HTTP.
// The worker's own probe (dist/boot/worker-probe.js) reads the SAME signal
// /health and /ready use — the `scheduler:heartbeat` Redis key — and must
// agree with the API's verdict about the worker fleet.
// ---------------------------------------------------------------------------

const MIN = 60_000;

describe('workerProbeOk — the container probe agrees with /health', () => {
  const stall = schedulerStallMs({});

  it('a fresh heartbeat is healthy', () => {
    const now = Date.now();
    expect(workerProbeOk(String(now - MIN), now, stall)).toBe(true);
  });

  it('a heartbeat exactly at the stall window is still healthy (the API agrees)', () => {
    const now = Date.now();
    expect(workerProbeOk(String(now - stall), now, stall)).toBe(true);
  });

  it('a stale heartbeat is unhealthy', () => {
    const now = Date.now();
    expect(workerProbeOk(String(now - stall - 1), now, stall)).toBe(false);
  });

  it('a missing heartbeat is unhealthy — the probe has no boot grace to hide behind', () => {
    // The probe is a fresh process on every run; "no beat yet" inside a grace
    // window is what Docker's start_period covers, so after it a worker that
    // never beats (crash loop, or RUN_WORKERS misconfigured) must be red.
    expect(workerProbeOk(null, Date.now(), stall)).toBe(false);
  });

  it('an unparseable heartbeat is unhealthy', () => {
    for (const junk of ['', 'not-a-number', 'Infinity', 'NaN']) {
      expect(workerProbeOk(junk, Date.now(), stall)).toBe(false);
    }
  });

  it('reads the same key and the same total-parsed stall window as /health', () => {
    const probe = readFileSync(join(process.cwd(), 'src/boot/worker-probe.ts'), 'utf8');
    expect(probe).toContain("redis.get('scheduler:heartbeat')");
    expect(probe).toContain('schedulerStallMs()');
    expect(DEFAULT_SCHEDULER_STALL_MINUTES).toBe(5);
  });
});
