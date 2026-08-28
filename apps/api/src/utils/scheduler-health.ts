// Scheduler-liveness decision, factored out of the /health handler so it can be
// unit-tested without spinning the server [SWIFT-122].
//
// The worker writes `scheduler:heartbeat` = Date.now() every 60s with NO TTL
// (jobs/queue.ts). So the key's absence is not "expired" — it means the
// heartbeat job has NEVER run, i.e. the worker fleet never booted (crash, or
// RUN_WORKERS misconfigured in prod). That case used to be swallowed
// (`if (!beat) return`), leaving the stall-pager blind to a worker that never
// started — holds, expiry sweeps, billing and settlements silently never run.
//
// Grace = the stall window: a just-booted fleet writes its first beat within
// ~60s, so we only conclude "never booted" once THIS instance has been up past
// the stall threshold with still no beat anywhere in (shared) Redis.

/**
 * How long without a heartbeat before the scheduler is considered stalled
 * [REPORT-037 R037-27].
 *
 * This used to be `Number(process.env[...] ?? '5') * 60_000` at the call site,
 * and `Number('Infinity')` is `Infinity`. A syntactically plausible value
 * therefore made `ageMs <= stallMs` true forever, silently disabling BOTH
 * paging paths — the stalled-worker page and the never-booted page.
 *
 * That is the worst possible thing for this particular dial to do: the
 * scheduler heartbeat is the fallback that covers every other heartbeat-driven
 * alarm (pool saturation, dead letters, routing degradation all ride the same
 * job). Turning it off quietly turns those off too.
 *
 * Total-parsed: only a finite positive number counts, so junk and Infinity both
 * degrade to the documented default rather than to silence. NaN would have
 * failed LOUD (paging constantly), which is the safe direction — Infinity fails
 * silent, which is not.
 */
export const DEFAULT_SCHEDULER_STALL_MINUTES = 5;

export function schedulerStallMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env['SCHEDULER_STALL_ALERT_MINUTES']?.trim();
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCHEDULER_STALL_MINUTES;
  return minutes * 60_000;
}

export type SchedulerHealth =
  | { page: false }
  | { page: true; kind: 'stall' | 'never-booted'; ageMs: number };

export function evaluateSchedulerHealth(input: {
  beat: string | null;
  nowMs: number;
  bootAtMs: number;
  stallMs: number;
}): SchedulerHealth {
  const { beat, nowMs, bootAtMs, stallMs } = input;

  if (!beat) {
    const upMs = nowMs - bootAtMs;
    // Still inside the grace window — the fleet may just be coming up.
    if (upMs <= stallMs) return { page: false };
    // Up past the stall window and no heartbeat has EVER appeared → the worker
    // fleet never started. This is the blind spot SWIFT-122 closes.
    return { page: true, kind: 'never-booted', ageMs: upMs };
  }

  const ageMs = nowMs - Number(beat);
  if (ageMs <= stallMs) return { page: false };
  return { page: true, kind: 'stall', ageMs };
}
