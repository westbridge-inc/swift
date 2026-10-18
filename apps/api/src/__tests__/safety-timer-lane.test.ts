import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createQueues, createWorkers, QUEUE_NAMES, safetyWorkerConcurrency, scheduleRecurringJobs, type JobContext, type SwiftQueues } from '../jobs/queue';

// ---------------------------------------------------------------------------
// [row 331 · QUEUE-ISOLATION · AUD-L4-005] The two safety timers have their own
// queue and worker slots.
//
// promote-sos-grace is the 10-second SOS backstop: it promotes an SOS whose app
// died mid-grace and runs the escalation ladder (contact texts, the ops page,
// the watchdog). guardian-sweep is the Trip Guardian tick. Both rode the
// dispatch queue, whose worker has five slots shared with ~30 repeating sweeps
// (outbox drains, reconcilers, ratings, discovery, ads ...). Five slow sweeps at
// once and an SOS waited behind them. #1741 moved the offer timeouts out; this
// moves the two safety timers onto the SAFETY queue, whose worker runs nothing
// else. The scheduler also removes the old dispatch-queue registration (a
// repeatable outlives the code that made it), and the dispatch worker still
// runs a tick it had already queued (drain only; both ticks are idempotent).
//
// The broker below models BullMQ's slot rule: a queue's jobs are taken only by
// that queue's worker, at most `concurrency` at a time; the rest wait in order.
// ---------------------------------------------------------------------------

type Job = { name: string; data: Record<string, unknown>; id?: string; timestamp?: number };
type Processor = (job: Job) => Promise<unknown>;

const state = vi.hoisted(() => ({
  workers: new Map<string, { processor: (job: { name: string; data: Record<string, unknown> }) => Promise<unknown>; concurrency: number }>(),
  repeatables: new Map<string, Array<{ key: string; name: string; every?: number; pattern?: string }>>(),
  removedKeys: [] as Array<{ queue: string; key: string }>,
  adds: [] as Array<{ queue: string; name: string; repeat: boolean }>,
  runs: [] as string[],
  sweepGate: { open: false, waiters: [] as Array<() => void> },
  drainGate: { open: true, waiters: [] as Array<() => void> },
}));

const wait = (gate: { open: boolean; waiters: Array<() => void> }) =>
  gate.open ? Promise.resolve() : new Promise<void>((resolve) => { gate.waiters.push(resolve); });
const release = (gate: { open: boolean; waiters: Array<() => void> }) => {
  gate.open = true;
  for (const resolve of gate.waiters.splice(0)) resolve();
};

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public readonly name: string) {}
    on() { return this; }
    async add(name: string, _data: unknown, opts?: { repeat?: { every?: number; pattern?: string } }) {
      state.adds.push({ queue: this.name, name, repeat: Boolean(opts?.repeat) });
      if (opts?.repeat) {
        const list = state.repeatables.get(this.name) ?? [];
        list.push({ key: `${name}::::${opts.repeat.every ?? opts.repeat.pattern}`, name, ...opts.repeat });
        state.repeatables.set(this.name, list);
      }
      return { id: `${this.name}-${state.adds.length}` };
    }
    async getRepeatableJobs() { return [...(state.repeatables.get(this.name) ?? [])]; }
    async removeRepeatableByKey(key: string) {
      const list = state.repeatables.get(this.name) ?? [];
      const at = list.findIndex((r) => r.key === key);
      if (at < 0) return false;
      list.splice(at, 1);
      state.removedKeys.push({ queue: this.name, key });
      return true;
    }
    async close() {}
  },
  Worker: class {
    constructor(public readonly name: string, processor: (job: { name: string; data: Record<string, unknown> }) => Promise<unknown>, options: { concurrency: number }) {
      state.workers.set(name, { processor, concurrency: options.concurrency });
    }
    on() { return this; }
    async close() {}
  },
  UnrecoverableError: class extends Error {},
}));

vi.mock('../providers/maps/maps-provider', () => ({ getMapsProvider: () => ({}) }));

// The SOS tick's modules as recorders (the same seams sos-failure-page-scheduled uses).
vi.mock('../modules/safety/sos.service', () => ({
  SosService: class { async promoteExpiredGrace() { state.runs.push('sos-grace-promotion'); return []; } },
}));
vi.mock('../modules/safety/sos-escalation', () => ({
  sosEscalationWorkerKilled: () => false,
  backfillSosEscalations: async () => ({ backfilled: [] }),
  // An SMS outage: the delivery batch of the FIRST tick can hang for minutes.
  drainSosEscalations: async () => { state.runs.push('sos-drain'); await wait(state.drainGate); return { delivered: 0, skipped: 0, failed: 0, deadLettered: 0 }; },
  scanSosEscalations: async () => ({ activeWithoutPage: [], pending: 0, failed: 0, liveWithoutRows: [] }),
  pageFailedSosEscalations: async () => ({ paged: [], review: [] }),
}));
vi.mock('../modules/safety/ops-alert', () => ({
  syncOpsAlertReadReceipts: async () => 0,
  escalateOverdueOpsAlerts: async () => ({ escalated: [], closed: [], platformPage: [] }),
  scanOpsAlerts: async () => ({}), runOpsAlertDrillIfDue: async () => ({ opened: null }),
}));
vi.mock('../modules/safety/trip-share.service', () => ({ rotateLegacyTripShareTokens: async () => ({ rotated: 0 }), notifyTripShareGuardians: async () => 0 }));
vi.mock('../modules/safety/sos-retrigger', () => ({ importLegacyRetriggers: async () => [], scanSosRetriggers: async () => ({}) }));
vi.mock('../modules/safety/evidence.service', () => ({ EvidenceService: class { async appendLiveFixes() {} } }));
vi.mock('../providers/notifications/channels', () => ({ getChannels: () => ({ sms: {} }) }));
// The Trip Guardian tick's modules as recorders.
vi.mock('../modules/safety/guardian.service', () => ({
  GuardianService: class { async sweep() { state.runs.push('guardian-sweep'); return { opened: 0, closed: 0, flagged: 0, escalated: 0 }; } },
}));
vi.mock('../modules/safety/guardian-delivery', () => ({
  checkinDeliveryKilled: () => true,
  backfillCheckinDeliveries: async () => ({ backfilled: [] }),
  drainCheckinDeliveries: async () => null,
  scanCheckinDeliveries: async () => ({ deadlineWithoutDelivery: [] }),
}));
vi.mock('../lib/sweep-cursor', () => ({ scanSweeps: async () => [] }));

// A slow sweep: the real stale-movers sweep holds its dispatch slot on its first
// database read until the gate opens (a slow query, a locked table ...).
const ctx = {
  prisma: {
    $queryRaw: vi.fn(async () => []),
    rider: { findMany: async () => { state.runs.push('stale-movers'); await wait(state.sweepGate); throw new Error('sweep released'); } },
  },
  io: {},
  redis: { options: {}, set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as JobContext;

const SAFETY_TIMERS = ['promote-sos-grace', 'guardian-sweep'] as const;

// Run each job path once, one at a time, before any test: the jobs import their
// modules lazily, so the first run of each is slow.
beforeAll(async () => {
  state.sweepGate.open = true;
  const warm = createQueues({ options: {} } as never);
  await createWorkers(ctx, warm);
  const dispatch = state.workers.get(QUEUE_NAMES.DISPATCH)!;
  for (const name of ['warm-up', 'stale-movers', 'promote-sos-grace', 'guardian-sweep']) {
    await dispatch.processor({ name, data: {} }).catch(() => undefined);
  }
});

let queues: SwiftQueues;
beforeEach(async () => {
  state.workers.clear();
  state.repeatables.clear();
  state.removedKeys.length = 0;
  state.adds.length = 0;
  state.runs.length = 0;
  state.sweepGate.open = false; state.sweepGate.waiters.length = 0;
  state.drainGate.open = true; state.drainGate.waiters.length = 0;
  queues = createQueues({ options: {} } as never);
  await createWorkers(ctx, queues);
});
afterEach(async () => {
  release(state.sweepGate);
  release(state.drainGate);
  // A failed test leaves its jobs running: finish them here, so they never write into the next test.
  await current?.settle();
  current = undefined;
  vi.unstubAllEnvs();
});

/** The queue the production scheduler registers a recurring job on. */
function registeredOn(name: string): string {
  const where = [...state.repeatables.entries()].filter(([, list]) => list.some((r) => r.name === name)).map(([queue]) => queue);
  expect(where, `${name} is registered on exactly one queue`).toHaveLength(1);
  return where[0]!;
}

let current: ReturnType<typeof broker> | undefined;

/** BullMQ's slot rule: a queue's worker takes at most `concurrency` of that queue's jobs at once. */
function broker() {
  const lanes = new Map<string, { active: number; waiting: Job[] }>();
  const settled: Promise<unknown>[] = [];
  const failures: string[] = [];
  const start = (queue: string, job: Job) => {
    const worker = state.workers.get(queue)!;
    const lane = lanes.get(queue)!;
    lane.active += 1;
    settled.push((worker.processor as Processor)(job).catch((err: unknown) => { failures.push(`${queue}/${job.name}: ${err instanceof Error ? err.message : String(err)}`); }).finally(() => {
      lane.active -= 1;
      const next = lane.waiting.shift();
      if (next) start(queue, next);
    }));
  };
  const self = {
    deliver(queue: string, job: Job) {
      const worker = state.workers.get(queue);
      expect(worker, `a worker consumes ${queue}`).toBeDefined();
      if (!lanes.has(queue)) lanes.set(queue, { active: 0, waiting: [] });
      const lane = lanes.get(queue)!;
      if (lane.active < worker!.concurrency) start(queue, job);
      else lane.waiting.push(job);
    },
    lane: (queue: string) => lanes.get(queue) ?? { active: 0, waiting: [] },
    failures,
    /** Every job delivered, including the backlog each finished job let in, has finished. */
    settle: async () => {
      for (let seen = -1; seen !== settled.length;) {
        seen = settled.length;
        await Promise.all(settled);
      }
    },
  };
  current = self;
  return self;
}

/** Wait (bounded) until the recorded runs satisfy `check`: the ticks import their modules lazily. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 10 });
const count = (run: string) => state.runs.filter((r) => r === run).length;

describe('the SOS backstop and the Trip Guardian ride their own lane (row 331 · AUD-L4-005)', () => {
  it('both safety timers are registered on the safety queue, and no other recurring job is', async () => {
    await scheduleRecurringJobs(queues);
    expect(QUEUE_NAMES.SAFETY).toBe('safety-jobs');
    expect(Object.values(QUEUE_NAMES).filter((n) => n === QUEUE_NAMES.SAFETY)).toHaveLength(1);
    for (const name of SAFETY_TIMERS) expect(registeredOn(name), name).toBe(QUEUE_NAMES.SAFETY);
    expect((state.repeatables.get(QUEUE_NAMES.SAFETY) ?? []).map((r) => r.name).sort()).toEqual([...SAFETY_TIMERS].sort());
    // The cadences did not change with the move.
    const every = (name: string) => state.repeatables.get(QUEUE_NAMES.SAFETY)!.find((r) => r.name === name)!.every;
    expect(every('promote-sos-grace')).toBe(10_000);
    expect(every('guardian-sweep')).toBe(15_000);
  });

  it('a saturated dispatch worker with a backlog of sweeps does not delay the SOS grace tick or the guardian tick', async () => {
    await scheduleRecurringJobs(queues);
    const b = broker();
    // Five slow sweeps hold all five dispatch slots; thirty more wait behind them.
    for (let i = 0; i < 35; i += 1) b.deliver(QUEUE_NAMES.DISPATCH, { name: 'stale-movers', data: {}, id: `sweep-${i}`, timestamp: i });
    await until(() => expect(count('stale-movers')).toBe(5));
    expect(b.failures).toEqual([]);
    expect(b.lane(QUEUE_NAMES.DISPATCH).active).toBe(state.workers.get(QUEUE_NAMES.DISPATCH)!.concurrency);
    expect(b.lane(QUEUE_NAMES.DISPATCH).waiting).toHaveLength(30);
    // The timers fire where the production scheduler put them.
    b.deliver(registeredOn('promote-sos-grace'), { name: 'promote-sos-grace', data: {} });
    b.deliver(registeredOn('guardian-sweep'), { name: 'guardian-sweep', data: {} });
    await until(() => { expect(count('sos-grace-promotion')).toBe(1); expect(count('guardian-sweep')).toBe(1); });
    // Both ran while every sweep is still stuck: no sweep finished, none of the backlog started.
    expect(count('stale-movers')).toBe(5);
    expect(b.lane(QUEUE_NAMES.DISPATCH).active).toBe(5);
    expect(b.lane(QUEUE_NAMES.DISPATCH).waiting).toHaveLength(30);
    release(state.sweepGate);
    await b.settle();
  });

  it('a tick stuck in an SMS outage does not hold the next SOS tick or the guardian tick', async () => {
    await scheduleRecurringJobs(queues);
    const b = broker();
    state.drainGate.open = false;
    b.deliver(QUEUE_NAMES.SAFETY, { name: 'promote-sos-grace', data: {} });
    await until(() => expect(state.runs).toEqual(['sos-grace-promotion', 'sos-drain']));
    // Ten seconds later the next tick promotes, and the guardian runs, while the first still waits on the SMS provider.
    b.deliver(QUEUE_NAMES.SAFETY, { name: 'promote-sos-grace', data: {} });
    b.deliver(QUEUE_NAMES.SAFETY, { name: 'guardian-sweep', data: {} });
    await until(() => { expect(count('sos-grace-promotion')).toBe(2); expect(count('guardian-sweep')).toBe(1); expect(count('sos-drain')).toBe(2); });
    release(state.drainGate);
    await b.settle();
  });

  it('the safety worker runs the two timers only: a sweep that lands on its queue by mistake is not run there', async () => {
    const safety = state.workers.get(QUEUE_NAMES.SAFETY);
    expect(safety, 'a worker consumes the safety queue').toBeDefined();
    state.sweepGate.open = true;
    for (const name of ['stale-movers', 'checkout-outbox', 'dispatch-order', 'offer-timeout', 'reconcile-dispatch']) {
      // [#1794 S4] ... and it fails, so it dead-letters instead of passing as done.
      await expect(safety!.processor({ name, data: { orderId: 'o-1' } }), name).rejects.toThrow(/safety lane runs only/);
    }
    expect(state.runs).toEqual([]);
  });

  it('the scheduler removes the old dispatch-queue registration of the two timers, and nothing else', async () => {
    // Production Redis still holds the registrations main made on the dispatch queue.
    state.repeatables.set(QUEUE_NAMES.DISPATCH, [
      { key: 'promote-sos-grace::::10000', name: 'promote-sos-grace', every: 10_000 },
      { key: 'guardian-sweep::::15000', name: 'guardian-sweep', every: 15_000 },
      { key: 'stale-movers::::*/5 * * * *', name: 'stale-movers', pattern: '*/5 * * * *' },
    ]);
    await scheduleRecurringJobs(queues);
    expect(state.removedKeys).toEqual([
      { queue: QUEUE_NAMES.DISPATCH, key: 'promote-sos-grace::::10000' },
      { queue: QUEUE_NAMES.DISPATCH, key: 'guardian-sweep::::15000' },
    ]);
    for (const name of SAFETY_TIMERS) expect(registeredOn(name), name).toBe(QUEUE_NAMES.SAFETY);
    expect(state.repeatables.get(QUEUE_NAMES.DISPATCH)!.some((r) => r.name === 'stale-movers')).toBe(true);
  });

  it('a tick the old registration had already queued on the dispatch queue still runs there (drain)', async () => {
    const dispatch = state.workers.get(QUEUE_NAMES.DISPATCH)!;
    await dispatch.processor({ name: 'promote-sos-grace', data: {} });
    await dispatch.processor({ name: 'guardian-sweep', data: {} });
    expect(count('sos-grace-promotion')).toBe(1);
    expect(count('guardian-sweep')).toBe(1);
  });

  it('the safety slots are env-tunable, never fewer than two, and fall back to 4 on a value that is not a sane integer', () => {
    expect(state.workers.get(QUEUE_NAMES.SAFETY)?.concurrency).toBe(safetyWorkerConcurrency());
    expect(safetyWorkerConcurrency({})).toBe(4);
    expect(safetyWorkerConcurrency({ SAFETY_WORKER_CONCURRENCY: '6' })).toBe(6);
    for (const bad of ['', 'four', '0', '1', '-3', '2.5', '21', '1e3']) {
      expect(safetyWorkerConcurrency({ SAFETY_WORKER_CONCURRENCY: bad }), bad).toBe(4);
    }
  });

  it('no source file adds a safety timer to any queue but the safety queue', () => {
    const SRC = join(process.cwd(), 'src');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(full, out);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
      }
      return out;
    };
    const producers: string[] = [];
    for (const file of walk(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/([\w.]+)\.add\(\s*'(promote-sos-grace|guardian-sweep)'/g)) producers.push(`${file.slice(SRC.length + 1)}: ${m[1]} ${m[2]}`);
    }
    expect(producers.sort()).toEqual(['jobs/queue.ts: queues.safetyQueue guardian-sweep', 'jobs/queue.ts: queues.safetyQueue promote-sos-grace']);
  });
});
