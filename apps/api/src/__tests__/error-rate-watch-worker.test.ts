// [FIXES-4 · REVIEW-G10 S4-2] The job is wired: the REAL verification worker handler, on a real database and Redis, under the
// tenant wall (TENANT_UNSCOPED_ACCESS=deny), pages once, and a second run dedupes. Lifted from the reviewer's probe.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { SUSTAINED_ERROR_PAGE_KEY, SUSTAINED_ERROR_PAGE_TITLE } from '../modules/ops/error-rate-watch';
import { serverErrorHourKey, tallyServerError } from '../lib/server-error-tally';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { testPhone } from './helpers/fixture-ids';

const state = vi.hoisted(() => ({ workers: new Map<string, (job: unknown) => Promise<unknown>>() }));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) { state.workers.set(name, processor); }
    on() { return this; }
    async close() {}
  },
}));

let app: FastifyInstance; const ONCALL = testPhone(); let admin = '';
const wipe = async () => { await app.redis.del(SUSTAINED_ERROR_PAGE_KEY); await runWithoutTenant(async () => { const r = await app.prisma.opsAlert.findMany({ where: { title: SUSTAINED_ERROR_PAGE_TITLE }, select: { id: true } }); await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: r.map((x) => x.id) } } }); await app.prisma.opsAlert.deleteMany({ where: { id: { in: r.map((x) => x.id) } } }); }, 'test-cleanup:rv'); };
beforeAll(async () => {
  process.env['NODE_ENV'] = 'development'; process.env['OPS_ONCALL_PHONES'] = ONCALL; process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  app = Fastify({ logger: false }); await app.register(prismaPlugin); await app.register(redisPlugin); await app.ready();
  const u = await runWithoutTenant(() => app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Errs', lastName: 'Worker', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } }), 'test-fixture:rv'); admin = u.id;
  await wipe(); resetDevChannelLog();
  await app.redis.del(serverErrorHourKey(Date.now()));
});
afterAll(async () => { await wipe(); await runWithoutTenant(async () => { await app.prisma.notification.deleteMany({ where: { userId: admin } }); await app.prisma.user.delete({ where: { id: admin } }).catch(() => {}); }, 'test-cleanup:rv'); await app.close(); });

describe('[FIXES-4] the worker runs the error-rate watch', () => {
  it('the real handler pages once, through the wall, and a second run dedupes', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = { prisma: app.prisma, redis: app.redis, io: { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) }, log } as unknown as JobContext;
    await createWorkers(ctx, {} as never);
    const processor = state.workers.get(QUEUE_NAMES.VERIFICATION);
    expect(processor).toBeDefined();
    for (let i = 0; i < 12; i += 1) await tallyServerError(app.redis);
    await processor!({ name: 'error-rate-watch', data: {}, attemptsStarted: 1, attemptsMade: 0 });
    const rows = await runWithoutTenant(() => app.prisma.opsAlert.findMany({ where: { title: SUSTAINED_ERROR_PAGE_TITLE } }), 'test-read:error-rate-worker');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'PLATFORM', tenantId: null, sosAlertId: null });
    expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL)).toHaveLength(1);
    await processor!({ name: 'error-rate-watch', data: {}, attemptsStarted: 1, attemptsMade: 0 });
    expect(await runWithoutTenant(() => app.prisma.opsAlert.count({ where: { title: SUSTAINED_ERROR_PAGE_TITLE } }), 'test-read:error-rate-worker')).toBe(1);
    expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL)).toHaveLength(1);
    expect(log.warn.mock.calls.map((c) => c[1])).toContain('server errors keep happening');
  }, 60_000);
});
