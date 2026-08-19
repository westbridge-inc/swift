import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  const state = {
    queues: [] as unknown[],
    workers: [] as unknown[],
    events: [] as string[],
    failQueueName: undefined as string | undefined,
    failWorkerName: undefined as string | undefined,
    failWorkerReadyName: undefined as string | undefined,
    failWorkerRunName: undefined as string | undefined,
    failRecurringJobName: undefined as string | undefined,
  };
  class FakeRedisClient {
    public connected = true;

    get status() {
      return this.connected ? 'ready' : 'end';
    }

    async ping() {
      if (!this.connected) throw new Error('Redis client disconnected');
      return 'PONG';
    }

    disconnect() {
      this.connected = false;
    }
  }
  class Queue extends EventEmitter {
    public readonly adds: Array<{ name: string; data: unknown; options: unknown }> = [];
    public readonly connection = new FakeRedisClient();
    public readonly client = Promise.resolve(this.connection);
    public readyCalls = 0;
    public closeCalls = 0;

    constructor(public readonly name: string) {
      super();
      state.queues.push(this);
    }

    async waitUntilReady() {
      this.readyCalls += 1;
      if (state.failQueueName === this.name) throw new Error(`${this.name} failed readiness`);
      return this;
    }

    async add(name: string, data: unknown, options: unknown) {
      state.events.push(`schedule:${this.name}:${name}`);
      if (state.failRecurringJobName === name) throw new Error(`${name} schedule failed`);
      this.adds.push({ name, data, options });
      return { id: `${this.name}-${this.adds.length}` };
    }

    async close() {
      this.closeCalls += 1;
      this.connection.disconnect();
    }
  }

  class Worker extends EventEmitter {
    public readonly commandConnection = new FakeRedisClient();
    public readonly blockingConnection = new FakeRedisClient();
    public readonly client = Promise.resolve(this.commandConnection);
    public readyCalls = 0;
    public closeCalls = 0;
    public runCalls = 0;
    public running = false;
    public paused = false;
    private finishRun: (() => void) | undefined;

    constructor(
      public readonly name: string,
      public readonly processor: (job: { name: string; data: Record<string, unknown> }) => Promise<void>,
      public readonly options: { autorun?: boolean } = {},
    ) {
      super();
      if (state.failWorkerName === this.name) throw new Error(`${this.name} constructor failed`);
      state.workers.push(this);
      if (options.autorun !== false) void this.run();
    }

    async waitUntilReady() {
      this.readyCalls += 1;
      if (state.failWorkerReadyName === this.name) throw new Error(`${this.name} failed readiness`);
      return this.blockingConnection;
    }

    run() {
      this.runCalls += 1;
      state.events.push(`run:${this.name}`);
      if (state.failWorkerRunName === this.name) {
        this.running = false;
        return Promise.reject(new Error(`${this.name} run failed`));
      }
      this.running = true;
      return new Promise<void>((resolve) => { this.finishRun = resolve; });
    }

    isRunning() {
      return this.running;
    }

    isPaused() {
      return this.paused;
    }

    stopUnexpectedly() {
      this.running = false;
      this.finishRun?.();
    }

    async close() {
      this.closeCalls += 1;
      this.running = false;
      this.commandConnection.disconnect();
      this.blockingConnection.disconnect();
      this.finishRun?.();
    }
  }

  return { Queue, Worker, __state: state };
});

vi.mock('../modules/notification/notification.service', () => ({
  escalateVendorAlert: async () => 'realerted',
}));
vi.mock('../providers/notifications/channels', () => ({
  getChannels: () => ({}),
}));
vi.mock('../plugins/observability', () => {
  const calls: unknown[][] = [];
  return {
    captureError: (...args: unknown[]) => calls.push(args),
    __calls: calls,
  };
});

import * as BullModule from 'bullmq';
import * as ObservabilityModule from '../plugins/observability';
import {
  QUEUE_NAMES,
  createQueues,
  createWorkers,
  enqueueVendorAlertFollowup,
  type JobContext,
} from '../jobs/queue';
import { initializeJobRuntime } from '../jobs/runtime';
import { closeResourcesBounded } from '../utils/async-lifecycle';

const bullState = (BullModule as unknown as {
  __state: {
    queues: unknown[];
    workers: unknown[];
    events: string[];
    failQueueName?: string;
    failWorkerName?: string;
    failWorkerReadyName?: string;
    failWorkerRunName?: string;
    failRecurringJobName?: string;
  };
}).__state;
const observabilityCalls = (ObservabilityModule as unknown as { __calls: unknown[][] }).__calls;

interface FakeQueue extends EventEmitter {
  name: string;
  adds: Array<{ name: string; data: unknown; options: unknown }>;
  readyCalls: number;
  closeCalls: number;
  connection: { connected: boolean; disconnect(): void };
  close(): Promise<void>;
}

interface FakeWorker extends EventEmitter {
  name: string;
  processor(job: { name: string; data: Record<string, unknown> }): Promise<void>;
  readyCalls: number;
  closeCalls: number;
  runCalls: number;
  running: boolean;
  options: { autorun?: boolean };
  commandConnection: { connected: boolean; disconnect(): void };
  stopUnexpectedly(): void;
}

const log = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  child() { return log; },
};

let consumerLease: string | null = 'remote-consumer-alive';

function context(): JobContext {
  const nowMs = Date.now();
  return {
    prisma: {
      $queryRaw: async () => [{ nowMs: BigInt(nowMs) }],
    },
    redis: {
      options: { host: 'localhost', port: 6379, db: 15 },
      ping: async () => 'PONG',
      time: async () => [String(Math.floor(nowMs / 1_000)), String((nowMs % 1_000) * 1_000)],
      get: async () => consumerLease,
      set: async (_key: string, value: string) => {
        consumerLease = value;
        return 'OK';
      },
    },
    io: { to: () => ({ emit: () => undefined }) },
    log,
  } as unknown as JobContext;
}

beforeEach(() => {
  bullState.queues.length = 0;
  bullState.workers.length = 0;
  bullState.events.length = 0;
  bullState.failQueueName = undefined;
  bullState.failWorkerName = undefined;
  bullState.failWorkerReadyName = undefined;
  bullState.failWorkerRunName = undefined;
  bullState.failRecurringJobName = undefined;
  consumerLease = 'remote-consumer-alive';
  observabilityCalls.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['QUEUE_STARTUP_TIMEOUT_MS'];
  delete process.env['QUEUE_READINESS_TIMEOUT_MS'];
  delete process.env['QUEUE_SHUTDOWN_TIMEOUT_MS'];
  delete process.env['QUEUE_CONSUMER_LEASE_TTL_MS'];
  delete process.env['QUEUE_CONSUMER_LEASE_REFRESH_MS'];
});

describe('BullMQ lifecycle', () => {
  it('reuses one boot-created Queue during a burst and emits no unhandled rejection', async () => {
    const ctx = context();
    const queues = createQueues(ctx.redis, ctx.log);
    const workers = await createWorkers(ctx, queues);
    const notificationQueue = queues.notificationQueue as unknown as FakeQueue;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      expect(bullState.queues).toHaveLength(7);
      await Promise.all(Array.from({ length: 100 }, (_, index) =>
        enqueueVendorAlertFollowup(queues, `order-${index}`),
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(bullState.queues).toHaveLength(7);
      expect(notificationQueue.adds).toHaveLength(100);
      expect(notificationQueue.closeCalls).toBe(0);
      expect(unhandled).toEqual([]);
      for (const queue of bullState.queues as FakeQueue[]) {
        expect(queue.listenerCount('error')).toBeGreaterThanOrEqual(1);
      }

      const error = new Error('producer reconnect failed');
      expect(() => notificationQueue.emit('error', error)).not.toThrow();
      expect(observabilityCalls).toContainEqual([
        error,
        expect.objectContaining({ component: 'bullmq-producer' }),
      ]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await workers.cleanup();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    }
  });

  it('awaits every producer and worker, then shuts down exactly once', async () => {
    consumerLease = null;
    const runtime = await initializeJobRuntime(context(), { runWorkers: true });
    expect((bullState.queues as FakeQueue[]).every((queue) => queue.readyCalls >= 1)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.readyCalls === 1)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.options.autorun === false)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.runCalls === 1)).toBe(true);
    const lastSchedule = Math.max(...bullState.events.map((event, index) => event.startsWith('schedule:') ? index : -1));
    const firstRun = bullState.events.findIndex((event) => event.startsWith('run:'));
    expect(firstRun).toBeGreaterThan(lastSchedule);
    expect(consumerLease).toMatch(/^\d+:\d+$/);
    expect(await runtime.checkQueuesReady()).toBe(true);

    const firstCleanup = runtime.cleanup();
    const secondCleanup = runtime.cleanup();
    expect(secondCleanup).toBe(firstCleanup);
    await firstCleanup;

    expect((bullState.queues as FakeQueue[]).every((queue) => queue.closeCalls === 1)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.closeCalls === 1)).toBe(true);
    expect(await runtime.checkQueuesReady()).toBe(false);
  });

  it('actively detects a producer disconnected after successful boot', async () => {
    const runtime = await initializeJobRuntime(context(), { runWorkers: false });
    const producer = runtime.queues.orderQueue as unknown as FakeQueue;
    expect(await runtime.checkQueuesReady()).toBe(true);

    producer.connection.disconnect();

    expect(await runtime.checkQueuesReady()).toBe(false);
    await runtime.cleanup();
  });

  it('keeps a producer-only API out of rotation when no consumer bundle lease exists', async () => {
    consumerLease = null;
    const runtime = await initializeJobRuntime(context(), { runWorkers: false });
    try {
      expect(await runtime.checkQueuesReady()).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it('reports not-ready when a current worker loop stops after boot', async () => {
    const runtime = await initializeJobRuntime(context(), { runWorkers: true });
    const worker = (bullState.workers as FakeWorker[])[0]!;
    expect(await runtime.checkQueuesReady()).toBe(true);

    worker.stopUnexpectedly();
    await Promise.resolve();

    expect(await runtime.checkQueuesReady()).toBe(false);
    await runtime.cleanup();
  });

  it('actively detects a worker command connection disconnected after boot', async () => {
    const runtime = await initializeJobRuntime(context(), { runWorkers: true });
    const worker = (bullState.workers as FakeWorker[])[0]!;
    expect(await runtime.checkQueuesReady()).toBe(true);

    worker.commandConnection.disconnect();

    expect(await runtime.checkQueuesReady()).toBe(false);
    await runtime.cleanup();
  });

  it('closes every already-created queue when one queue fails readiness', async () => {
    bullState.failQueueName = QUEUE_NAMES.VERIFICATION;

    await expect(initializeJobRuntime(context(), { runWorkers: false }))
      .rejects.toThrow(/verification-jobs failed readiness/);

    expect(bullState.queues).toHaveLength(7);
    expect((bullState.queues as FakeQueue[]).every((queue) => queue.closeCalls === 1)).toBe(true);
    expect(bullState.workers).toHaveLength(0);
  });

  it('closes earlier Workers when a later Worker constructor fails synchronously', async () => {
    const ctx = context();
    const queues = createQueues(ctx.redis, ctx.log);
    bullState.failWorkerName = QUEUE_NAMES.VERIFICATION;

    try {
      await expect(createWorkers(ctx, queues)).rejects.toThrow(/verification-jobs constructor failed/);
      expect(bullState.workers).toHaveLength(3);
      expect((bullState.workers as FakeWorker[]).every((worker) => worker.closeCalls === 1)).toBe(true);
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    }
  });

  it('executes zero worker loops when recurring registration fails before activation', async () => {
    bullState.failRecurringJobName = 'process-billing';

    await expect(initializeJobRuntime(context(), { runWorkers: true }))
      .rejects.toThrow(/process-billing schedule failed/);

    expect(bullState.workers).toHaveLength(7);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.options.autorun === false)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.runCalls === 0)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.closeCalls === 1)).toBe(true);
    expect((bullState.queues as FakeQueue[]).every((queue) => queue.closeCalls === 1)).toBe(true);
  });

  it('executes zero worker loops when one consumer connection fails startup readiness', async () => {
    bullState.failWorkerReadyName = QUEUE_NAMES.DISPATCH;

    await expect(initializeJobRuntime(context(), { runWorkers: true }))
      .rejects.toThrow(/dispatch-jobs failed readiness/);

    expect((bullState.workers as FakeWorker[]).every((worker) => worker.runCalls === 0)).toBe(true);
    expect((bullState.workers as FakeWorker[]).every((worker) => worker.closeCalls === 1)).toBe(true);
  });

  it('observes an activation failure and closes every partially started worker', async () => {
    bullState.failWorkerRunName = QUEUE_NAMES.DISPATCH;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(initializeJobRuntime(context(), { runWorkers: true }))
        .rejects.toThrow(/failed to enter the running state|initial active probe/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect((bullState.workers as FakeWorker[]).every((worker) => worker.closeCalls === 1)).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('bounds a hung resource close and observes the late operation', async () => {
    const startedAt = Date.now();
    let failure: unknown;
    try {
      await closeResourcesBounded([
        { name: 'hung queue', close: () => new Promise(() => undefined) },
      ], 20);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/timed out after 20ms/) }),
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
