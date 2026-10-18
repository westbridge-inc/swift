import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [M013] Credentials and sign-in links never reach the API or worker logs.
// Every logger here is built from the SAME redact paths and serializers that
// app.ts and worker.ts use, writing to a captured stream, so the assertions
// read what production would print. All values are synthetic.

vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  const workers: unknown[] = [];
  class FakeRedisClient {
    get status() { return 'ready'; }
    async ping() { return 'PONG'; }
    disconnect() {}
  }
  class Queue extends EventEmitter {
    public readonly connection = new FakeRedisClient();
    public readonly client = Promise.resolve(this.connection);
    constructor(public readonly name: string) { super(); }
    async waitUntilReady() { return this; }
    async add() { return { id: 'synthetic-added' }; }
    async close() {}
  }
  class Worker extends EventEmitter {
    public readonly client = Promise.resolve(new FakeRedisClient());
    constructor(public readonly name: string) { super(); workers.push(this); }
    async waitUntilReady() { return new FakeRedisClient(); }
    run() { return new Promise<void>(() => undefined); }
    isRunning() { return false; }
    isPaused() { return false; }
    async close() {}
  }
  class UnrecoverableError extends Error {}
  return { Queue, Worker, UnrecoverableError, __workers: workers };
});
vi.mock('../modules/notification/notification.service', () => ({ escalateVendorAlert: async () => 'realerted' }));
vi.mock('../providers/notifications/channels', () => ({ getChannels: () => ({}) }));
vi.mock('../plugins/observability', () => ({ captureError: () => undefined }));

import * as BullModule from 'bullmq';
import { createQueues, createWorkers, type JobContext } from '../jobs/queue';
import { loggerRedactConfig, loggerSerializers } from '../utils/logger-config';

const bullWorkers = (BullModule as unknown as { __workers: Array<{ name: string; emit(event: string, ...args: unknown[]): boolean }> }).__workers;

/** The production logger shape, writing into a string this test can read. */
function capturedLogger() {
  const sink = { text: '' };
  const stream = new Writable({ write(chunk, _encoding, done) { sink.text += String(chunk); done(); } });
  const logger = pino({ level: 'trace', redact: loggerRedactConfig, serializers: loggerSerializers }, stream);
  return { logger, sink };
}

beforeEach(() => { bullWorkers.length = 0; });

describe('[M013] structured logs: no credential at the top level or one level down', () => {
  // Field names a caller could plausibly log as-is. Each value is unique so a
  // leak names the field that leaked.
  const CREDENTIAL_FIELDS = [
    'password', 'passwordHash', 'refreshToken', 'accessToken', 'token', 'otp', 'pin', 'ridePin', 'pickupCode',
    'cardNumber', 'cvc', 'mmgPassword', 'mkey', 'msecret', 'signInUrl', 'magicLink', 'authorization', 'cookie',
  ];
  const credentials = Object.fromEntries(CREDENTIAL_FIELDS.map((key) => [key, `synthetic-private-${key}`]));

  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)('%s: bare and nested credential fields are censored; correlation survives', (level) => {
    const { logger, sink } = capturedLogger();
    logger[level]({ ...credentials, payload: { ...credentials }, reqId: 'safe-correlation', statusCode: 503, code: 'RATE_LIMITED' }, 'Delivery failed');
    for (const [field, value] of Object.entries(credentials)) expect(sink.text, `${field} leaked`).not.toContain(value);
    expect(sink.text).toContain('safe-correlation');
    expect(sink.text).toContain('503');
    // A top-level `code` is an error classification (ride queue, MMG result
    // codes) and stays readable; a nested `code` was already censored.
    expect(sink.text).toContain('RATE_LIMITED');
  });
});

describe('[M013] a failed background job is logged by identity, never by payload', () => {
  function jobContext(log: pino.Logger): JobContext {
    const nowMs = Date.now();
    return {
      prisma: { $queryRaw: async () => [{ nowMs: BigInt(nowMs) }] },
      redis: {
        options: { host: 'localhost', port: 6379, db: 15 },
        ping: async () => 'PONG',
        time: async () => [String(Math.floor(nowMs / 1_000)), String((nowMs % 1_000) * 1_000)],
        get: async () => 'remote-consumer-alive',
        set: async () => 'OK',
      },
      io: { to: () => ({ emit: () => undefined }) },
      log,
    } as unknown as JobContext;
  }

  it('every worker: no message body, sign-in link, reset grant or error text; queue, job id, attempts and record ids stay', async () => {
    const { logger, sink } = capturedLogger();
    const ctx = jobContext(logger);
    const queues = createQueues(ctx.redis, ctx.log);
    const workers = await createWorkers(ctx, queues);
    try {
      expect(bullWorkers.length).toBeGreaterThan(5);
      for (const worker of bullWorkers) {
        worker.emit('failed', {
          name: 'synthetic-notification', id: `job-${worker.name}`, attemptsMade: 2,
          data: {
            orderId: 'ord_synthetic_1',
            body: 'Sign in at https://example.invalid/synthetic-private-link',
            text: 'Your Swift verification code is: 918273',
            delivery: { resetToken: 'synthetic-private-reset' },
            phone: '+5920000000',
            // [S4-1] an id-named key that carries a phone number, and an id-named key whose value is not an id
            payerId: '5920000001', msisdnId: '5920000002', phoneId: '5920000003',
            linkId: 'https://example.invalid/synthetic-private-link-id',
          },
        }, new Error('Upstream refused synthetic-private-error'));
      }
      for (const marker of ['synthetic-private-link', '918273', 'synthetic-private-reset', 'synthetic-private-error', '+5920000000', '5920000001', '5920000002', '5920000003', 'synthetic-private-link-id']) {
        expect(sink.text, `${marker} reached the log`).not.toContain(marker);
      }
      for (const worker of bullWorkers) {
        expect(sink.text).toContain(`"queue":"${worker.name}"`);
        expect(sink.text).toContain(`"jobId":"job-${worker.name}"`);
      }
      expect(sink.text).toContain('"attempts":2');
      expect(sink.text).toContain('"orderId":"ord_synthetic_1"');
      expect(sink.text).toContain('BullMQ job failed');
    } finally {
      await workers.cleanup();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    }
  });
});

describe('[M013] the worker process logs deep-service lines through the redacted logger', () => {
  // Deep services (dispatch, billing, safety, ads crons…) log through
  // utils/logger's log(), which is console until a process hands it a logger.
  // The API does that in app.ts; the worker is its own process and must too,
  // or every log() line in a job prints raw error text with no redaction.
  const worker = readFileSync(path.resolve(__dirname, '..', 'worker.ts'), 'utf8');

  it('worker.ts hands its redacted pino logger to setAppLogger before any queue or job exists', () => {
    const built = worker.search(/const log = pino\(\{[^}]*redact: loggerRedactConfig, serializers: loggerSerializers/);
    const handed = worker.search(/\n\s*setAppLogger\(log\);/);
    const firstQueue = worker.search(/createQueues\(|createWorkers\(|initializeJobRuntime\(/);
    expect(built, 'the worker builds its logger from the shared redact config').toBeGreaterThan(-1);
    expect(handed, 'the worker hands that logger to setAppLogger').toBeGreaterThan(built);
    expect(firstQueue).toBeGreaterThan(-1);
    expect(handed, 'before any queue or job is created').toBeLessThan(firstQueue);
    expect(worker).toMatch(/import \{ setAppLogger \} from '\.\/utils\/logger';/);
  });
});
