import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

    // Let it fail once more (no worker now — it sits waiting; move on) and
    // discard by id: gone for good.
    const discard = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/dlq/order/${job.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(discard.statusCode).toBe(200);
    expect(await testQueue.getJob(job.id!)).toBeUndefined();
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
