import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createQueues, createWorkers, offerWorkerConcurrency, QUEUE_NAMES, type JobContext, type SwiftQueues } from '../jobs/queue';

// ---------------------------------------------------------------------------
// [row 266 · AUD-L4-005] Offer timeouts have their own queue and worker slots.
//
// A rider's offer lasts 20 seconds; the timeout job is what takes it back and
// offers the order to the next mover. It used to be one more job class on the
// dispatch queue, whose worker has five slots shared with ~28 recurring sweeps
// (outbox drains, reconcilers, safety watchdogs, ads, ratings ...). Five slow
// sweep ticks at once and every offer on the platform overran its deadline:
// the rider who let it lapse still held it, and nobody else was asked.
//
// Now every producer adds offer timeouts to the OFFER queue, whose worker runs
// nothing else, with its own slots. The dispatch worker keeps a drain-only
// branch for timeouts enqueued there before the split.
// ---------------------------------------------------------------------------

type Processor = (job: { name: string; data: Record<string, unknown>; id?: string; timestamp?: number }) => Promise<unknown>;
const state = vi.hoisted(() => ({
  workers: new Map<string, { processor: Processor; concurrency: number }>(),
  adds: [] as Array<{ queue: string; name: string; data: Record<string, unknown> }>,
  timeouts: [] as Array<{ orderId: string; riderId: string; attemptId?: string }>,
  schedulers: [] as Array<{ timeout: (orderId: string, riderId: string, delayMs: number, attemptId?: string) => Promise<void> }>,
  cascade: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public readonly name: string) {}
    on() { return this; }
    async add(name: string, data: Record<string, unknown>) {
      state.adds.push({ queue: this.name, name, data });
      return { id: `${this.name}-${state.adds.length}` };
    }
    async close() {}
  },
  Worker: class {
    constructor(public readonly name: string, processor: Processor, options: { concurrency: number }) {
      state.workers.set(name, { processor, concurrency: options.concurrency });
    }
    on() { return this; }
    async close() {}
  },
  UnrecoverableError: class extends Error {},
}));

// The real DispatchService talks to Postgres, Redis and the maps provider; here
// it only records what the queue wiring hands it and what it is asked to do.
vi.mock('../modules/dispatch/dispatch.service', () => ({
  DispatchService: class {
    constructor(
      _prisma: unknown, _redis: unknown, _io: unknown, _maps: unknown,
      private readonly timeout: (orderId: string, riderId: string, delayMs: number, attemptId?: string) => Promise<void>,
    ) { state.schedulers.push({ timeout }); }
    async handleOfferTimeout(orderId: string, riderId: string, attemptId?: string) {
      state.timeouts.push({ orderId, riderId, attemptId });
      // The lapse cascades: the next mover is offered the order, with a new timeout.
      await this.timeout(orderId, 'next-rider', 20_000, 'attempt-2');
    }
    async dispatchOrder(orderId: string) {
      state.cascade.push(orderId);
      await this.timeout(orderId, 'first-rider', 20_000, 'attempt-1');
    }
  },
  sweepStaleMovers: async () => 0,
  reconcileStuckDispatch: async () => ({}),
  recoverStrandedTaxiRides: async () => ({}),
}));
vi.mock('../providers/maps/maps-provider', () => ({ getMapsProvider: () => ({}) }));

const ctx = {
  prisma: { order: { findUnique: vi.fn(async () => ({ tenantId: 'swift-default' })) } },
  io: {},
  redis: { options: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as JobContext;

let queues: SwiftQueues;
beforeEach(async () => {
  state.workers.clear();
  state.adds.length = 0;
  state.timeouts.length = 0;
  state.schedulers.length = 0;
  state.cascade.length = 0;
  queues = createQueues({ options: {} } as never);
  await createWorkers(ctx, queues);
});
afterEach(() => { vi.unstubAllEnvs(); });

const worker = (name: string) => {
  const w = state.workers.get(name);
  expect(w, `no worker consumes ${name}`).toBeDefined();
  return w!;
};

describe('offer timeouts ride their own lane (row 266)', () => {
  it('the offer queue is its own queue, consumed by its own worker with its own slots', () => {
    expect(QUEUE_NAMES.OFFER).toBe('offer-jobs');
    expect(Object.values(QUEUE_NAMES).filter((n) => n === QUEUE_NAMES.OFFER)).toHaveLength(1);
    expect((queues.offerQueue as unknown as { name: string }).name).toBe(QUEUE_NAMES.OFFER);
    expect(worker(QUEUE_NAMES.OFFER).concurrency).toBe(offerWorkerConcurrency());
    expect(worker(QUEUE_NAMES.OFFER).concurrency).toBeGreaterThanOrEqual(5);
    // The sweeps keep the dispatch worker; none of them can take an offer slot.
    expect(worker(QUEUE_NAMES.DISPATCH).concurrency).toBe(5);
  });

  it('the offer worker runs an offer timeout in the order tenant, and nothing else', async () => {
    await worker(QUEUE_NAMES.OFFER).processor({ name: 'offer-timeout', data: { orderId: 'o-1', riderId: 'r-1', attemptId: 'a-1' } });
    expect(state.timeouts).toEqual([{ orderId: 'o-1', riderId: 'r-1', attemptId: 'a-1' }]);
    expect(ctx.prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'o-1' }, select: { tenantId: true } });
    // A sweep that lands on the offer queue by mistake is not run there.
    for (const name of ['checkout-outbox', 'dispatch-order', 'reconcile-dispatch', 'promote-sos-grace']) {
      await worker(QUEUE_NAMES.OFFER).processor({ name, data: { orderId: 'o-2' } });
    }
    expect(state.timeouts).toHaveLength(1);
    expect(state.cascade).toEqual([]);
  });

  it('every job-side scheduler adds offer timeouts to the offer queue, never to the dispatch queue', async () => {
    // A dispatch run offers the order (first timeout); its lapse offers the next mover (second timeout).
    await worker(QUEUE_NAMES.DISPATCH).processor({ name: 'dispatch-order', data: { orderId: 'o-3' }, id: 'j-1', timestamp: 1 });
    await worker(QUEUE_NAMES.OFFER).processor({ name: 'offer-timeout', data: { orderId: 'o-3', riderId: 'first-rider', attemptId: 'attempt-1' } });
    // The legacy drain on the dispatch queue cascades onto the offer queue as well.
    await worker(QUEUE_NAMES.DISPATCH).processor({ name: 'offer-timeout', data: { orderId: 'o-4', riderId: 'r-4', attemptId: 'a-4' } });
    const timeouts = state.adds.filter((a) => a.name === 'offer-timeout');
    expect(timeouts.map((a) => [a.queue, a.data['orderId'], a.data['riderId']])).toEqual([
      [QUEUE_NAMES.OFFER, 'o-3', 'first-rider'],
      [QUEUE_NAMES.OFFER, 'o-3', 'next-rider'],
      [QUEUE_NAMES.OFFER, 'o-4', 'next-rider'],
    ]);
    expect(state.adds.filter((a) => a.queue === QUEUE_NAMES.DISPATCH && a.name === 'offer-timeout')).toEqual([]);
  });

  it('a timeout enqueued on the dispatch queue before the split is still honoured (drain)', async () => {
    await worker(QUEUE_NAMES.DISPATCH).processor({ name: 'offer-timeout', data: { orderId: 'o-5', riderId: 'r-5', attemptId: 'a-5' } });
    expect(state.timeouts).toEqual([{ orderId: 'o-5', riderId: 'r-5', attemptId: 'a-5' }]);
  });

  it('the slot count is env-tunable and falls back to 10 on a value that is not a sane integer', () => {
    expect(offerWorkerConcurrency({})).toBe(10);
    expect(offerWorkerConcurrency({ OFFER_WORKER_CONCURRENCY: '16' })).toBe(16);
    for (const bad of ['', 'ten', '0', '-3', '2.5', '51', '1e3']) {
      expect(offerWorkerConcurrency({ OFFER_WORKER_CONCURRENCY: bad }), bad).toBe(10);
    }
  });

  it('no source file adds an offer timeout to any queue but the offer queue', () => {
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
      for (const m of readFileSync(file, 'utf8').matchAll(/([\w.]+)\.add\(\s*'offer-timeout'/g)) producers.push(`${file.slice(SRC.length + 1)}: ${m[1]}`);
    }
    // The job side (one scheduler in jobs/queue.ts) and the route side (makeDispatchService).
    expect(producers.length).toBe(2);
    for (const p of producers) expect(p, p).toMatch(/: (queues|app)\.offerQueue$/);
  });
});
