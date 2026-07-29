import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { scheduleRecurringJobs } from '../jobs/queue';

// F-0003 — the SOS grace-expiry sweep must be WIRED to a scheduler tick, not
// merely exist. safety-sos-core.test.ts (case E) proves promoteExpiredGrace()
// promotes an overdue TRIGGER_PENDING alert; THIS proves the sweep actually
// RUNS on a schedule. Without the tick the engine is dark: an SOS whose app was
// killed mid-grace would sit TRIGGER_PENDING forever and never page ops — the
// precise F-0003 defect. Pure unit test (no Redis/DB): mock the queues, call
// the real scheduler, assert the registration and a life-safety-tight cadence.

function mockQueues() {
  const make = () => ({ add: vi.fn().mockResolvedValue(undefined) });
  return {
    orderQueue: make(),
    subscriptionQueue: make(),
    settlementQueue: make(),
    notificationQueue: make(),
    verificationQueue: make(),
    dispatchQueue: make(),
    searchQueue: make(),
  } as never;
}
const findAdd = (q: { add: ReturnType<typeof vi.fn> }, name: string) =>
  q.add.mock.calls.find((c: unknown[]) => c[0] === name);

describe('SOS grace-expiry sweep is scheduled [F-0003]', () => {
  const saved = process.env['SOS_GRACE_SWEEP_MS'];
  beforeEach(() => { delete process.env['SOS_GRACE_SWEEP_MS']; }); // hermetic default
  afterAll(() => { if (saved === undefined) delete process.env['SOS_GRACE_SWEEP_MS']; else process.env['SOS_GRACE_SWEEP_MS'] = saved; });

  it('registers promote-sos-grace as a repeatable job on the dispatch queue', async () => {
    const q = mockQueues() as unknown as { dispatchQueue: { add: ReturnType<typeof vi.fn> } };
    await scheduleRecurringJobs(q as never);
    const call = findAdd(q.dispatchQueue, 'promote-sos-grace');
    expect(call, 'promote-sos-grace must be scheduled — the SOS backstop is dark without it (F-0003)').toBeTruthy();
    const opts = call![2] as { repeat?: { every?: number } };
    expect(opts.repeat?.every).toBeTypeOf('number');
    // A backstop for a 3–5s grace: tight enough to matter, never slower than a minute.
    expect(opts.repeat!.every!).toBeGreaterThanOrEqual(2_000);
    expect(opts.repeat!.every!).toBeLessThanOrEqual(60_000);
  });

  it('clamps a misconfigured sub-floor interval up to the 2s floor (no pathological churn)', async () => {
    process.env['SOS_GRACE_SWEEP_MS'] = '10'; // absurdly small
    const q = mockQueues() as unknown as { dispatchQueue: { add: ReturnType<typeof vi.fn> } };
    await scheduleRecurringJobs(q as never);
    const call = findAdd(q.dispatchQueue, 'promote-sos-grace')!;
    expect((call[2] as { repeat: { every: number } }).repeat.every).toBe(2_000);
  });

  it('ignores garbage (non-numeric) config and falls back to the default cadence', async () => {
    process.env['SOS_GRACE_SWEEP_MS'] = 'not-a-number';
    const q = mockQueues() as unknown as { dispatchQueue: { add: ReturnType<typeof vi.fn> } };
    await scheduleRecurringJobs(q as never);
    const call = findAdd(q.dispatchQueue, 'promote-sos-grace')!;
    const every = (call[2] as { repeat: { every: number } }).repeat.every;
    expect(Number.isFinite(every)).toBe(true); // never NaN → a NaN interval would break the repeatable job
    expect(every).toBeGreaterThanOrEqual(2_000);
  });
});
