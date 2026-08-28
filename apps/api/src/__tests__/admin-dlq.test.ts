import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('GET /admin/dlq', () => {
  it('rejects non-admins', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/dlq',
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
  });

  it('returns the failed-job list (empty queue = empty list)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/dlq',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('surfaces a genuinely failed job with its reason, then requeues and discards it', async () => {
    // Manufacture a real failure: a job with 0 retries processed by a worker
    // that throws lands in the failed set.
    const { Worker } = await import('bullmq');
    const job = await testQueue.add('doomed', { orderId: 'test-123' }, { attempts: 1 });
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
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rows = list.json().data as Array<{ queue: string; id: string; failedReason: string | null; data: string }>;
    const mine = rows.find((r) => r.id === job.id);
    expect(mine).toBeTruthy();
    expect(mine!.failedReason).toContain('boom');
    expect(mine!.data).toContain('test-123');

    // Requeue: the job leaves the failed set.
    const requeue = await app.inject({
      method: 'POST', url: `/api/v1/admin/dlq/order/${job.id}/requeue`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
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
      headers: { authorization: `Bearer ${adminToken}` },
    });
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
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(wrongName.statusCode).toBe(409);
    expect(wrongName.json().error.code).toBe('JOB_IDENTITY_MISMATCH');
    expect(await testQueue.getJob(job.id!)).toBeTruthy();

    // The matching identity is accepted, so the guard is a compare, not a wall.
    const right = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dlq/order/${job.id}?expectedName=doomed-identity`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
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
      headers: { authorization: `Bearer ${adminToken}` },
    });
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
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(badQueue.statusCode).toBe(404);
    const badJob = await app.inject({
      method: 'DELETE', url: '/api/v1/admin/dlq/order/does-not-exist',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(badJob.statusCode).toBe(404);
  });
});
