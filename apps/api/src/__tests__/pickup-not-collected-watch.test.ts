// [BUG-HUNT-2 G20] The sweep behind it, through the REAL verification worker on a real database and Redis, under the tenant
// wall: a ready pickup nobody collected pages its store once at 24 hours, and support once at 48 hours, and the support page
// closes when no such order is left. It closes nothing itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { PICKUP_UNCOLLECTED_KEY, PICKUP_UNCOLLECTED_TITLE } from '../modules/order/pickup-not-collected';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

const state = vi.hoisted(() => ({ workers: new Map<string, (job: unknown) => Promise<unknown>>() }));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) { state.workers.set(name, processor); }
    on() { return this; }
    async close() {}
  },
}));

const HOUR = 3_600_000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:pickup-not-collected-watch');
const ONCALL = testPhone();
let app: FastifyInstance;
let customerId = '';
let ownerUserId = '';
let vendorId = '';
const userIds: string[] = [];
const orderIds: string[] = [];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const person = (roles: string[], extra: Record<string, unknown> = {}) => sys(async () => {
  const row = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Sweep', lastName: 'Pickup', roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true, ...extra } });
  userIds.push(row.id);
  return row.id;
});

const pickup = (readyAgoMs: number, over: Record<string, unknown> = {}) => sys(async () => {
  const readyAt = new Date(Date.now() - readyAgoMs);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `PNW-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId, vendorId, status: 'READY_FOR_PICKUP',
    placedAt: new Date(readyAt.getTime() - HOUR), acceptedAt: new Date(readyAt.getTime() - HOUR / 2), readyAt, deliveryAddress: 'pickup', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH', ...over,
  } as never });
  orderIds.push(order.id);
  return order;
});

const run = () => state.workers.get(QUEUE_NAMES.VERIFICATION)!({ name: 'pickup-not-collected-watch', data: {}, attemptsStarted: 1, attemptsMade: 0 });
const storeNotices = (orderId: string) => sys(() => app.prisma.notification.findMany({ where: { userId: ownerUserId, data: { path: ['orderId'], equals: orderId } } }));
const pages = () => sys(() => app.prisma.opsAlert.findMany({ where: { title: PICKUP_UNCOLLECTED_TITLE } }));
const closeAll = () => sys(() => app.prisma.order.updateMany({ where: { id: { in: orderIds }, status: 'READY_FOR_PICKUP' }, data: { status: 'COMPLETED' } }));
const wipePages = async () => {
  await app.redis.del(PICKUP_UNCOLLECTED_KEY);
  await sys(async () => {
    const alerts = await app.prisma.opsAlert.findMany({ where: { title: PICKUP_UNCOLLECTED_TITLE }, select: { id: true } });
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: alerts.map((alert) => alert.id) } } });
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
  await person(['ADMIN', 'CUSTOMER'], { status: 'ACTIVE', admin: { create: { permissions: ['*'] } } });
  customerId = await person(['CUSTOMER']);
  ownerUserId = await person(['VENDOR_OWNER', 'CUSTOMER']);
  vendorId = await sys(async () => {
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: `Sweep Shop ${wordFreeTag(4)}`, slug: `pickup-watch-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '2 Pickup Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    } });
    return vendor.id;
  });
  const ctx = { prisma: app.prisma, redis: app.redis, io: { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) }, log } as unknown as JobContext;
  await createWorkers(ctx, {} as never);
  await sys(() => app.prisma.order.updateMany({ where: { fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' }, data: { status: 'CANCELLED' } }));
});

beforeEach(async () => { await closeAll(); await wipePages(); });

afterAll(async () => {
  await wipePages();
  await sys(async () => {
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
  delete process.env['TENANT_UNSCOPED_ACCESS'];
  delete process.env['OPS_ONCALL_PHONES'];
});

describe('[G20] the store is paged once at 24 hours', () => {
  it('nothing before 24 hours; once at 24 hours; never again on the next pass', async () => {
    const early = await pickup(23 * HOUR);
    const due = await pickup(25 * HOUR);
    await run();
    await run();
    expect(await storeNotices(early.id)).toHaveLength(0);
    const told = await storeNotices(due.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Pickup not collected' });
    expect(told[0]!.body).toContain(due.orderNumber);
    expect(told[0]!.body).toContain('Not collected');
    expect(told[0]!.data).toMatchObject({ orderId: due.id, kind: 'pickup_not_collected', audience: 'business' });
  });

  it('a paid MMG one tells the store support closes it', async () => {
    const due = await pickup(25 * HOUR, { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgAttestedAmount: 1000, mmgAttestedRef: `REF${nanoid(8)}` });
    await run();
    const told = await storeNotices(due.id);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('Swift support');
  });

  it('a delivery order, a closed pickup and a pickup booked for later are left alone', async () => {
    const delivery = await pickup(3 * 24 * HOUR, { fulfillment: 'DELIVERY' });
    const closed = await pickup(3 * 24 * HOUR, { status: 'COMPLETED' });
    const later = await pickup(3 * 24 * HOUR, { scheduledFor: new Date(Date.now() + HOUR) });
    await run();
    expect(await storeNotices(delivery.id)).toHaveLength(0);
    expect(await storeNotices(closed.id)).toHaveLength(0);
    expect(await storeNotices(later.id)).toHaveLength(0);
    expect(await pages()).toHaveLength(0);
  });

  it('it closes nothing', async () => {
    const due = await pickup(3 * 24 * HOUR);
    await run();
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: due.id } }))).status).toBe('READY_FOR_PICKUP');
  });
});

describe('[G20] support is paged once at 48 hours', () => {
  it('not at 47 hours', async () => {
    await pickup(47 * HOUR);
    await run();
    expect(await pages()).toHaveLength(0);
  });

  it('one page however many orders and passes, naming the oldest, closed when none is left', async () => {
    const newer = await pickup(49 * HOUR);
    const oldest = await pickup(60 * HOUR);
    await run();
    await run();
    const open = await pages();
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain('2 pickup');
    expect(open[0]!.body).toContain(oldest.orderNumber);
    expect(open[0]!.body).not.toContain(newer.orderNumber);
    expect(open[0]!.closedAt).toBeNull();
    await closeAll();
    await run();
    const after = await pages();
    expect(after).toHaveLength(1);
    expect(after[0]!.closedAt).toBeInstanceOf(Date);
  });
});
