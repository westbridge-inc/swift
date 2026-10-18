import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queueModule from '../jobs/queue';
import { createQueues, createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';

// ---------------------------------------------------------------------------
// [row 331 · #1794 review S3-1 / S4] The safety lane is watched from OUTSIDE it.
//
// Every SOS watchdog (ACTIVE with no ops page, the failed-delivery pager, the
// ops-alert ladder, the sweep-SLO pager) runs INSIDE the safety ticks. If all
// safety slots are held by calls that never settle, or the safety worker alone
// stops consuming, the SOS backstop is dead and nothing pages: the DLQ alarm
// only sees FAILED jobs. So each tick stamps when it last COMPLETED, and the
// scheduler heartbeat (a dispatch-queue job, another lane) pages the platform
// (an OpsAlert: SUPER_ADMIN push + an on-call text, outside the lane) when a
// safety tick has not completed within the window, and closes that page when
// ticks complete again. The API's /health already pages when the heartbeat
// itself stops, so no single stuck lane can go dark.
//
// S4: a job name the safety lane does not know now fails (and dead-letters, so
// the DLQ alarm pages) instead of "succeeding" while doing nothing.
// ---------------------------------------------------------------------------

type Processor = (job: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
const state = vi.hoisted(() => ({
  workers: new Map<string, Processor>(),
  redis: new Map<string, string>(),
  pages: [] as Array<{ title: string; body: string; data: Record<string, unknown>; key: string }>,
  resolved: [] as string[],
  tickFails: false,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public readonly name: string) {}
    on() { return this; }
    async add() { return { id: 'x' }; }
    async getFailedCount() { return 0; }
    async close() {}
  },
  Worker: class {
    constructor(name: string, processor: Processor) { state.workers.set(name, processor); }
    on() { return this; }
    async close() {}
  },
  UnrecoverableError: class extends Error {},
}));
vi.mock('../modules/ops/ops-page', () => ({
  pageOps: async (_deps: unknown, input: { title: string; body: string; data: Record<string, unknown>; key: string }) => {
    state.pages.push(input);
    return { status: 'delivered', opsAlertId: 'a', recipients: 1 };
  },
  resolveOpsPage: async (_prisma: unknown, title: string) => { state.resolved.push(title); return 0; },
}));
// The two ticks as recorders (their own behaviour is covered by safety-timer-lane and the sos-* suites).
vi.mock('../modules/safety/sos.service', () => ({
  SosService: class { async promoteExpiredGrace() { if (state.tickFails) throw new Error('database gone'); return []; } },
}));
vi.mock('../modules/safety/sos-escalation', () => ({
  sosEscalationWorkerKilled: () => true,
  backfillSosEscalations: async () => ({ backfilled: [] }),
  drainSosEscalations: async () => null,
  scanSosEscalations: async () => ({ activeWithoutPage: [] }),
  pageFailedSosEscalations: async () => ({ paged: [], review: [] }),
}));
vi.mock('../modules/safety/ops-alert', () => ({
  syncOpsAlertReadReceipts: async () => 0,
  escalateOverdueOpsAlerts: async () => ({ escalated: [], closed: [], platformPage: [] }),
  scanOpsAlerts: async () => ({}), runOpsAlertDrillIfDue: async () => ({}),
}));
vi.mock('../modules/safety/trip-share.service', () => ({ rotateLegacyTripShareTokens: async () => ({ rotated: 0 }), notifyTripShareGuardians: async () => 0 }));
vi.mock('../modules/safety/sos-retrigger', () => ({ importLegacyRetriggers: async () => [], scanSosRetriggers: async () => ({}) }));
vi.mock('../modules/safety/evidence.service', () => ({ EvidenceService: class { async appendLiveFixes() {} } }));
vi.mock('../providers/notifications/channels', () => ({ getChannels: () => ({ sms: {} }) }));
vi.mock('../modules/safety/guardian.service', () => ({
  GuardianService: class { async sweep() { return { opened: 0, closed: 0, flagged: 0, escalated: 0 }; } },
}));
vi.mock('../modules/safety/guardian-delivery', () => ({
  checkinDeliveryKilled: () => true,
  backfillCheckinDeliveries: async () => ({ backfilled: [] }),
  drainCheckinDeliveries: async () => null,
  scanCheckinDeliveries: async () => ({ deadlineWithoutDelivery: [] }),
}));
vi.mock('../lib/sweep-cursor', () => ({ scanSweeps: async () => [] }));

const ctx = {
  prisma: { $queryRaw: vi.fn(async () => []), $metrics: { json: async () => ({ gauges: [] }) } },
  io: {},
  redis: {
    options: {},
    get: vi.fn(async (k: string) => state.redis.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { state.redis.set(k, v); return 'OK'; }),
    del: vi.fn(async () => 1),
  },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as JobContext;

const KEY = (name: string) => `safety:tick-completed:${name}`;
const MINUTE = 60_000;

beforeEach(() => {
  state.workers.clear();
  state.redis.clear();
  state.pages.length = 0;
  state.resolved.length = 0;
  state.tickFails = false;
  vi.useRealTimers();
});

async function lanes() {
  await createWorkers(ctx, createQueues({ options: {} } as never));
  return { safety: state.workers.get(QUEUE_NAMES.SAFETY)!, dispatch: state.workers.get(QUEUE_NAMES.DISPATCH)! };
}

describe('[#1794 S3-1] each safety tick stamps when it last completed', () => {
  it('a completed tick stamps its own key; a failed tick does not', async () => {
    const { safety } = await lanes();
    const before = Date.now();
    await safety({ name: 'promote-sos-grace', data: {} });
    await safety({ name: 'guardian-sweep', data: {} });
    for (const name of ['promote-sos-grace', 'guardian-sweep']) {
      const at = Number(state.redis.get(KEY(name)));
      expect(at, name).toBeGreaterThanOrEqual(before);
      expect(at, name).toBeLessThanOrEqual(Date.now());
    }
    state.redis.clear();
    state.tickFails = true;
    await expect(safety({ name: 'promote-sos-grace', data: {} })).rejects.toThrow();
    expect(state.redis.has(KEY('promote-sos-grace'))).toBe(false);
  });

  it('[S4] a job the safety lane does not know fails, so it dead-letters instead of passing as done', async () => {
    const { safety } = await lanes();
    for (const name of ['stale-movers', 'checkout-outbox', 'promote-sos-grace-typo']) {
      await expect(safety({ name, data: {} }), name).rejects.toThrow(/safety lane runs only/);
    }
    expect(state.redis.size).toBe(0);
  });
});

describe('[#1794 S3-1] the scheduler heartbeat, on another lane, pages when the safety lane stops completing', () => {
  const check = (queueModule as unknown as { checkSafetyLane?: (c: JobContext, bootedAtMs: number, nowMs?: number, staleMs?: number) => Promise<{ stalled: string[] }> }).checkSafetyLane;

  it('a stale tick opens one platform page naming it; fresh ticks close it', async () => {
    expect(check, 'checkSafetyLane is exported').toBeTypeOf('function');
    const now = 10 * MINUTE;
    state.redis.set(KEY('promote-sos-grace'), String(now - 90_000));
    state.redis.set(KEY('guardian-sweep'), String(now - 5_000));
    expect((await check!(ctx, 0, now, MINUTE)).stalled).toEqual(['promote-sos-grace']);
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0]).toMatchObject({ title: 'SOS safety lane stalled', data: { kind: 'safety_sweep_slo', workType: 'safety-lane', stalled: true, passAgeSeconds: 90 } });
    expect(state.pages[0]!.body).toMatch(/promote-sos-grace/);
    expect(state.resolved).toEqual([]);
    state.redis.set(KEY('promote-sos-grace'), String(now - 2_000));
    expect((await check!(ctx, 0, now, MINUTE)).stalled).toEqual([]);
    expect(state.pages).toHaveLength(1);
    expect(state.resolved).toEqual(['SOS safety lane stalled']);
  });

  it('a tick that never completed since boot pages once the boot grace is over, never inside it', async () => {
    const now = 10 * MINUTE;
    expect((await check!(ctx, now - 30_000, now, MINUTE)).stalled).toEqual([]);
    expect(state.pages).toHaveLength(0);
    expect((await check!(ctx, now - 2 * MINUTE, now, MINUTE)).stalled).toEqual(['promote-sos-grace', 'guardian-sweep']);
    expect(state.pages).toHaveLength(1);
    state.redis.set(KEY('promote-sos-grace'), 'garbage');
    state.redis.set(KEY('guardian-sweep'), String(now));
    expect((await check!(ctx, 0, now, MINUTE)).stalled).toEqual(['promote-sos-grace']);
  });

  it('the real heartbeat job runs the check (past its boot grace) and still beats when the check fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T21:00:00Z'));
    const { dispatch } = await lanes();
    vi.setSystemTime(new Date('2026-10-16T21:05:00Z'));
    state.redis.set(KEY('promote-sos-grace'), String(Date.now() - 4 * MINUTE));
    state.redis.set(KEY('guardian-sweep'), String(Date.now()));
    await dispatch({ name: 'scheduler-heartbeat', data: {} });
    expect(state.redis.get('scheduler:heartbeat')).toBe(String(Date.now()));
    expect(state.pages.map((p) => p.title)).toEqual(['SOS safety lane stalled']);
    // A Redis read that throws inside the check is logged; the heartbeat still beat.
    state.redis.clear();
    (ctx.redis.get as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('redis gone'));
    await dispatch({ name: 'scheduler-heartbeat', data: {} });
    expect(state.redis.get('scheduler:heartbeat')).toBe(String(Date.now()));
  });

  it('the window is env-tunable (30 s .. 10 min, default 60 s)', () => {
    const stale = (queueModule as unknown as { safetyTickStaleMs?: (env: Record<string, string | undefined>) => number }).safetyTickStaleMs;
    expect(stale, 'safetyTickStaleMs is exported').toBeTypeOf('function');
    expect(stale!({})).toBe(60_000);
    expect(stale!({ SAFETY_TICK_STALE_MS: '120000' })).toBe(120_000);
    for (const bad of ['', 'x', '29999', '600001', '1e5', '-1']) expect(stale!({ SAFETY_TICK_STALE_MS: bad }), bad).toBe(60_000);
  });
});
