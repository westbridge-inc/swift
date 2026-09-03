import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { nanoid } from 'nanoid';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// ---------------------------------------------------------------------------
// DLQ admin (mission-control §5.7): failed background jobs get eyes, and
// requeue/discard are audited admin actions.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
let customerToken: string;
let testQueue: Queue;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  // A real (empty) queue under the exact name the route resolves.
  testQueue = new Queue('order-processing-dlq-test', { connection: app.redis.duplicate() as unknown as import('bullmq').ConnectionOptions });
  app.decorate('queues', { orderQueue: testQueue } as never);
  await app.ready();

  const admin = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = admin.json().data.tokens.accessToken;
  const cust = await loginWithOtp(app, '+5926003000'); // seeded customer
  customerToken = cust.json().data.tokens.accessToken;
});

afterAll(async () => {
  await testQueue.obliterate({ force: true }).catch(() => {});
  await testQueue.close();
  await app.close();
});

/** Manufacture a real dead letter: one attempt, a worker that throws. */
async function failedJob(tag: string, jobName = 'scheduler-heartbeat') {
  const { Worker } = await import('bullmq');
  // [A-08] The job NAME decides whether a requeue is allowed at all. These
  // tests are about the claim mechanics, so they use a class that IS certified
  // for replay; the uncertified case has its own tests below.
  const job = await testQueue.add(jobName, { orderId: tag }, { attempts: 1 });
  const worker = new Worker(
    testQueue.name,
    async () => { throw new Error(`boom: ${tag}`); },
    { connection: app.redis.duplicate({ maxRetriesPerRequest: null }) as unknown as import('bullmq').ConnectionOptions },
  );
  for (let i = 0; i < 50; i++) {
    if ((await job.getState()) === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await worker.close();
  expect(await job.getState()).toBe('failed');
  return job;
}

const adminHeaders = () => ({ authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' });

describe('[TA-S0-005] compare-and-act is atomic in Redis', () => {
  it('two operators: Retry lands inside Discard’s audit gap → Discard is refused by the atomic claim and the waiting job survives', async () => {
    const job = await failedJob('race-retry-first');
    const since = new Date();

    // Barrier: hold DISCARD between its state read and its act by stalling
    // its audit write (the awaited step that separates the two).
    const delegate = app.prisma.auditLog;
    const original = delegate.create.bind(delegate);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    const spy = vi.spyOn(delegate, 'create').mockImplementation((async (args: { data?: { action?: string } }) => {
      if (!held && args?.data?.action === 'DISCARD_DLQ_JOB') {
        held = true;
        await gate;
      }
      return original(args as never);
    }) as never);
    try {
      const discard = app.inject({ method: 'DELETE', url: `/api/v1/admin/dlq/order/${job.id}`, headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {} });
      for (let i = 0; i < 100 && !held; i++) await new Promise((r) => setTimeout(r, 20));
      expect(held).toBe(true); // Discard has read "failed" and is parked before its act

      // Retry lands first: the job is live work again.
      const requeue = await app.inject({ method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`, headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {} });
      expect(requeue.statusCode).toBe(200);
      expect(await job.getState()).toBe('waiting');

      release();
      const res = await discard;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('JOB_NO_LONGER_FAILED');
    } finally {
      spy.mockRestore();
    }
    // The live job survived, and the audit trail says: asked, then refused.
    expect(await job.getState()).toBe('waiting');
    expect(await testQueue.getJob(job.id!)).toBeTruthy();
    // BullMQ reuses small numeric ids across obliterated queues, so only this run's rows count.
    const trail = await app.prisma.auditLog.findMany({ where: { entity: 'Job', entityId: `order:${job.id}`, createdAt: { gte: since }, action: { in: ['DISCARD_DLQ_JOB', 'DISCARD_DLQ_JOB_FAILED'] } } });
    expect(trail.map((r) => r.action).sort()).toEqual(['DISCARD_DLQ_JOB', 'DISCARD_DLQ_JOB_FAILED']);
  });

  it('the other order: Discard claims first → Retry is refused with the same 409 and the job is gone', async () => {
    const job = await failedJob('race-discard-first');
    const discard = await app.inject({ method: 'DELETE', url: `/api/v1/admin/dlq/order/${job.id}`, headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {} });
    expect(discard.statusCode).toBe(200);
    expect(await testQueue.getJob(job.id!)).toBeUndefined();

    const requeue = await app.inject({ method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`, headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {} });
    expect([404, 409]).toContain(requeue.statusCode); // gone: nothing to retry, and never a resurrection
  });

  it('the claim is the failed set itself: a job that leaves it between the read and the act cannot be removed', async () => {
    // Direct proof of the primitive, independent of request timing: pull the
    // id out of the failed set (what a concurrent Retry does) and the claim
    // must report "not yours".
    const job = await failedJob('race-primitive');
    const client = await testQueue.client;
    expect(await client.zrem(testQueue.toKey('failed'), job.id!)).toBe(1); // a Retry took it
    expect(await client.zrem(testQueue.toKey('failed'), job.id!)).toBe(0); // the claim after it must lose
    // Put it back so the queue's obliterate can clean it up.
    await client.zadd(testQueue.toKey('failed'), String(job.finishedOn ?? Date.now()), job.id!);
  });
});

describe('GET /admin/dlq', () => {
  it('rejects non-admins', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/dlq',
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${customerToken}` },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
  });

  it('returns the failed-job list (empty queue = empty list)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/dlq',
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('surfaces a genuinely failed job with its reason, then requeues and discards it', async () => {
    // Manufacture a real failure: a job with 0 retries processed by a worker
    // that throws lands in the failed set.
    const { Worker } = await import('bullmq');
    // [A-08] A class certified for replay — this test is about the list/requeue/
    // discard mechanics, not about whether replay is allowed.
    const job = await testQueue.add('scheduler-heartbeat', { orderId: 'test-123' }, { attempts: 1 });
    const worker = new Worker(
      testQueue.name,
      async () => { throw new Error('boom: downstream exploded'); },
      { connection: app.redis.duplicate({ maxRetriesPerRequest: null }) as unknown as import('bullmq').ConnectionOptions },
    );
    // Wait until BullMQ marks it failed.
    for (let i = 0; i < 50; i++) {
      const state = await job.getState();
      if (state === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.close();
    expect(await job.getState()).toBe('failed');

    const list = await app.inject({
      method: 'GET', url: '/api/v1/admin/dlq',
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` },
    });
    const rows = list.json().data as Array<{ queue: string; id: string; failedReason: string | null; data: string }>;
    const mine = rows.find((r) => r.id === job.id);
    expect(mine).toBeTruthy();
    expect(mine!.failedReason).toContain('boom');
    expect(mine!.data).toContain('test-123');

    // Requeue: the job leaves the failed set.
    const requeue = await app.inject({
      method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(requeue.statusCode).toBe(200);
    expect(await job.getState()).not.toBe('failed');

    // [REPORT-037 R037-09] The requeued job is now WAITING, not failed — it is
    // live work again. Discarding it must be REFUSED, not obeyed.
    //
    // This assertion used to be the opposite: it deleted the waiting job and
    // asserted it was gone, which blessed the exact sequence that permanently
    // destroys a live money job (Retry, then Discard from a stale page, or two
    // operators on the same queue).
    const discardLive = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/dlq/order/${job.id}`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(discardLive.statusCode).toBe(409);
    expect(discardLive.json().error.code).toBe('JOB_NO_LONGER_FAILED');
    expect(await testQueue.getJob(job.id!)).toBeTruthy();
  });

  it('refuses to act on a DIFFERENT job that inherited the same id [R037-09]', async () => {
    // BullMQ reuses numeric ids after a queue is obliterated and recreated, so
    // an id alone does not identify a job. The page sends what it actually saw;
    // a mismatch is a 409, not an action on the wrong job.
    const { Worker } = await import('bullmq');
    const job = await testQueue.add('doomed-identity', { orderId: 'ident-1' }, { attempts: 1 });
    const worker = new Worker(
      testQueue.name,
      async () => { throw new Error('boom: identity'); },
      { connection: app.redis.duplicate({ maxRetriesPerRequest: null }) as unknown as import('bullmq').ConnectionOptions },
    );
    for (let i = 0; i < 50; i++) {
      if ((await job.getState()) === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.close();

    const wrongName = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dlq/order/${job.id}?expectedName=something-else`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(wrongName.statusCode).toBe(409);
    expect(wrongName.json().error.code).toBe('JOB_IDENTITY_MISMATCH');
    expect(await testQueue.getJob(job.id!)).toBeTruthy();

    // The matching identity is accepted, so the guard is a compare, not a wall.
    const right = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dlq/order/${job.id}?expectedName=doomed-identity`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(right.statusCode).toBe(200);
    expect(await testQueue.getJob(job.id!)).toBeUndefined();
  });

  it('records the privileged mutation in the audit log [R037-08]', async () => {
    const { Worker } = await import('bullmq');
    const job = await testQueue.add('doomed-audit', { orderId: 'audit-1' }, { attempts: 1 });
    const worker = new Worker(
      testQueue.name,
      async () => { throw new Error('boom: audit'); },
      { connection: app.redis.duplicate({ maxRetriesPerRequest: null }) as unknown as import('bullmq').ConnectionOptions },
    );
    for (let i = 0; i < 50; i++) {
      if ((await job.getState()) === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.close();

    const before = await app.prisma.auditLog.count({ where: { action: 'DISCARD_DLQ_JOB', entityId: `order:${job.id}` } });
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/dlq/order/${job.id}`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.auditLog.count({ where: { action: 'DISCARD_DLQ_JOB', entityId: `order:${job.id}` } });
    expect(after).toBe(before + 1);
  });

  it('audits BEFORE it mutates, so a failed audit cannot leave an unrecorded mutation [R037-08]', () => {
    // The ordering IS the control. Mutating first meant an audit failure
    // returned 500 with the mutation already done — and the automatic audit
    // hook deliberately skips responses >= 400, so the action could end up with
    // no record at all. Asserted on code with comments stripped.
    const routes = readFileSync(join(process.cwd(), 'src/modules/admin/admin.routes.ts'), 'utf8')
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    const helper = routes.slice(routes.indexOf('async function auditedDlqAction('), routes.indexOf('/** POST /dlq/'));
    expect(helper).toBeTruthy();
    // the audit call comes first, the mutation after it
    expect(helper.indexOf('await audit(')).toBeGreaterThan(-1);
    expect(helper.indexOf('await mutate()')).toBeGreaterThan(helper.indexOf('await audit('));
    // and a failed mutation is itself recorded rather than silently swallowed
    expect(helper).toMatch(/_FAILED/);
  });

  it('404s an unknown queue and an unknown job', async () => {
    const badQueue = await app.inject({
      method: 'POST', url: '/api/v1/admin/dlq/nonsense/1/requeue',
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(badQueue.statusCode).toBe(404);
    const badJob = await app.inject({
      method: 'DELETE', url: '/api/v1/admin/dlq/order/does-not-exist',
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(badJob.statusCode).toBe(404);
  });
});


// ---------------------------------------------------------------------------
// [A-08] "Retrying is safe: every Swift job is written to be idempotent."
//
// The page said that, of all 53 job classes, and offered one-click retry on the
// strength of it. Nobody had established it. A job that failed AFTER an
// external side effect — a notification sent, a provider called, money moved —
// and is then retried does that side effect twice.
//
// Retry-safety is now a property each class has to earn, and the default is
// refusal.
// ---------------------------------------------------------------------------
describe('[A-08] a dead job is only replayed if its class was certified for it', () => {
  it('refuses a class nobody has certified, and says so instead of guessing', async () => {
    const job = await failedJob(`uncertified-${nanoid(6)}`, 'process-billing');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`,
      headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REPLAY_NOT_CERTIFIED');
    expect(res.json().error.message).toMatch(/not certified for replay/);
    // And the job is still where it was — a refusal changes nothing.
    expect(await job.getState()).toBe('failed');
  });

  it('refuses a job class it has never heard of — an unknown name is not a safe one', async () => {
    const job = await failedJob(`unknown-${nanoid(6)}`, 'not-a-real-job-class');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`,
      headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.policy).toBe('NOT_CERTIFIED');
    expect(await job.getState()).toBe('failed');
  });

  it('allows a certified class — the tool still works where the property was established', async () => {
    const job = await failedJob(`certified-${nanoid(6)}`, 'qr-attribution-purge');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`,
      headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await job.getState()).toBe('waiting');
  });

  it('every listed dead job carries its own policy — one blanket promise no longer stands for 53', async () => {
    const job = await failedJob(`listed-${nanoid(6)}`, 'process-billing');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/dlq', headers: { ...adminHeaders(), 'x-swift-reason': TEST_ADMIN_REASON } });
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as Array<{ id: string; recovery?: { policy: string; why: string } }>)
      .find((r) => r.id === String(job.id));
    expect(row?.recovery?.policy).toBe('NOT_CERTIFIED');
    expect(row?.recovery?.why).toBeTruthy();
  });
});
