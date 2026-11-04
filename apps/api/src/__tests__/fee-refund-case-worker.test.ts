// [Row 156] The job is wired: the REAL verification worker handler, on a real database and Redis, under the tenant wall
// (TENANT_UNSCOPED_ACCESS=deny), pages an overdue case once and dedupes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { FEE_REFUND_OVERDUE_KEY, FEE_REFUND_OVERDUE_TITLE } from '../modules/billing/fee-refund-case';
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

const ONCALL = testPhone();
const system = <T>(run: () => Promise<T>) => runWithoutTenant(run, 'test:fee-refund-case-worker');
let app: FastifyInstance;
const made = { user: '', owner: '', vendor: '', sub: '', intent: '', refund: '', admin: '' };

const wipe = async () => {
  await app.redis.del(FEE_REFUND_OVERDUE_KEY);
  await system(async () => {
    const alerts = await app.prisma.opsAlert.findMany({ where: { title: FEE_REFUND_OVERDUE_TITLE }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: alerts.map((a) => a.id) } } });
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: alerts.map((a) => a.id) } } });
  });
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['OPS_ONCALL_PHONES'] = ONCALL;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
  await system(async () => {
    const admin = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Fee', lastName: 'Admin', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
    made.admin = admin.id;
    const user = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Case', lastName: 'Worker', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
    made.user = user.id;
    const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
    made.owner = owner.id;
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: 'Refund Worker Store', slug: `refund-worker-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(), addressLine1: '1 Refund Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    } });
    made.vendor = vendor.id;
    const now = new Date();
    const sub = await app.prisma.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH', currentPeriodStart: now, currentPeriodEnd: now, nextBillingDate: now } });
    made.sub = sub.id;
    const intent = await app.prisma.mmgCheckoutIntent.create({ data: {
      tenantId: 'swift-default', subscriptionId: sub.id, merchantTransactionId: `${Date.now()}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`.padEnd(18, '0').slice(0, 18), amount: 2100, currencyCode: 'GYD',
      createdByUserId: user.id, platform: 'ios', checkoutUrlSealed: new Uint8Array(40).fill(1), checkoutUrlDek: new Uint8Array(40).fill(1), expiresAt: new Date(Date.now() + 600_000),
    } as never });
    made.intent = intent.id;
    const refund = await app.prisma.feeRefundCase.create({ data: {
      tenantId: 'swift-default', subscriptionId: sub.id, checkoutId: intent.id, kind: 'DUPLICATE', reason: 'Paid twice by mistake and asked for it back', openedByUserId: admin.id, amount: 2100, currencyCode: 'GYD', dueBy: new Date(Date.now() - 60_000),
    } });
    made.refund = refund.id;
  });
  await wipe();
  resetDevChannelLog();
});

afterAll(async () => {
  await wipe();
  await system(async () => {
    await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.feeRefundCase.deleteMany({ where: { id: made.refund } });
    });
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { id: made.intent } });
    await app.prisma.subscription.deleteMany({ where: { id: made.sub } });
    await app.prisma.vendor.deleteMany({ where: { id: made.vendor } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: made.owner } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: [made.user, made.admin] } } });
    await app.prisma.admin.deleteMany({ where: { userId: made.admin } });
    await app.prisma.user.deleteMany({ where: { id: { in: [made.user, made.admin] } } });
  });
  await app.close();
  delete process.env['TENANT_UNSCOPED_ACCESS'];
  delete process.env['OPS_ONCALL_PHONES'];
});

describe('[Row 156] the worker runs the refund case sweep', () => {
  it('the real handler pages an overdue case once, through the wall, and a second run dedupes', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = { prisma: app.prisma, redis: app.redis, io: { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) }, log } as unknown as JobContext;
    await createWorkers(ctx, {} as never);
    const processor = state.workers.get(QUEUE_NAMES.VERIFICATION);
    expect(processor).toBeDefined();

    await processor!({ name: 'fee-refund-case-sweep', data: {}, attemptsStarted: 1, attemptsMade: 0 });
    const pages = await system(() => app.prisma.opsAlert.findMany({ where: { title: FEE_REFUND_OVERDUE_TITLE } }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: 'PLATFORM', tenantId: null, sosAlertId: null });
    expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL)).toHaveLength(1);

    await processor!({ name: 'fee-refund-case-sweep', data: {}, attemptsStarted: 1, attemptsMade: 0 });
    expect(await system(() => app.prisma.opsAlert.count({ where: { title: FEE_REFUND_OVERDUE_TITLE } }))).toBe(1);
    expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL)).toHaveLength(1);
    expect(log.info.mock.calls.map((c) => c[1])).toContain('weekly-fee refund cases swept');
  }, 60_000);
});
