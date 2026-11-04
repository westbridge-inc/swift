// [BUG-HUNT-2 G08] The deadline, through the REAL verification worker on a real database and Redis, under the tenant wall. A
// missed refund is marked once, its store told once, one page stands while any is overdue and closes when none is. A send
// nobody answered is asked once more. It moves no money and closes nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { openMmgRefundObligation } from '../modules/order/mmg-refund-law';
import { MMG_REFUND_OVERDUE_KEY, MMG_REFUND_OVERDUE_TITLE, markMmgRefundMissed } from '../modules/order/mmg-refund-rail';
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
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:mmg-refund-deadlines');
let app: FastifyInstance;
let customerId = '';
let ownerUserId = '';
let vendorId = '';
const userIds: string[] = [];
const orderIds: string[] = [];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const person = (roles: string[], extra: Record<string, unknown> = {}) => sys(async () => {
  const row = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Late', lastName: 'Refund', roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true, ...extra } });
  userIds.push(row.id);
  return row.id;
});

/** A closed paid order owing `amount`, due `dueInMs` from now. */
const owed = (dueInMs: number, status: 'OWED' | 'SENT' = 'OWED', sentAgoMs = 0) => sys(() => app.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: {
    orderNumber: `RDL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId, vendorId, status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED',
    mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: 900,
    deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900, deliveryFee: 0, totalAmount: 900,
  } });
  orderIds.push(order.id);
  const obligation = await tx.mmgRefundObligation.create({ data: { ...openMmgRefundObligation({
    kind: 'CANCELLATION', tenantId: order.tenantId, orderId: order.id, vendorId, customerId, amount: new Prisma.Decimal(900), currencyCode: 'GYD', basis: 'ATTESTED_REMAINDER', reason: 'Fixture', createdById: null,
  }, { deadlineHours: 72, missLimit: 2 }, new Date()), dueAt: new Date(Date.now() + dueInMs) } });
  await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  if (status === 'SENT') {
    const send = await tx.mmgRefundSend.create({ data: {
      tenantId: order.tenantId, orderId: order.id, vendorId, customerId, mmgRefundRef: `RFD${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`, amount: 900, currencyCode: 'GYD', sentById: ownerUserId, sentAt: new Date(Date.now() - sentAgoMs), coveredObligationIds: [obligation.id],
    } });
    await tx.mmgRefundObligation.update({ where: { id: obligation.id }, data: { status: 'SENT', sendId: send.id, revision: 1 } });
  }
  return { order, obligationId: obligation.id };
}));

const run = () => state.workers.get(QUEUE_NAMES.VERIFICATION)!({ name: 'mmg-refund-deadlines', data: {}, attemptsStarted: 1, attemptsMade: 0 });
const pages = () => sys(() => app.prisma.opsAlert.findMany({ where: { title: MMG_REFUND_OVERDUE_TITLE } }));
const noticesFor = (userId: string, orderId: string) => sys(() => app.prisma.notification.findMany({ where: { userId, data: { path: ['orderId'], equals: orderId } } }));
const row = (id: string) => sys(() => app.prisma.mmgRefundObligation.findUniqueOrThrow({ where: { id } }));
const settleAll = () => sys(async () => {
  await app.prisma.mmgRefundObligation.updateMany({ where: { orderId: { in: orderIds }, status: 'OWED' }, data: { status: 'VOIDED', sendId: null } });
  await app.prisma.mmgRefundSend.updateMany({ where: { orderId: { in: orderIds }, answer: null }, data: { answer: 'RECEIVED' } });
  await app.prisma.mmgRefundObligation.updateMany({ where: { orderId: { in: orderIds }, status: 'SENT' }, data: { status: 'CONFIRMED' } });
});
const wipePages = async () => {
  await app.redis.del(MMG_REFUND_OVERDUE_KEY);
  await sys(async () => {
    const alerts = await app.prisma.opsAlert.findMany({ where: { title: MMG_REFUND_OVERDUE_TITLE }, select: { id: true } });
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: alerts.map((alert) => alert.id) } } });
  });
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['OPS_ONCALL_PHONES'] = testPhone();
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
    return (await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: `Late Shop ${wordFreeTag(4)}`, slug: `refund-late-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '3 Refund Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, status: 'ACTIVE', isVerified: true,
    } })).id;
  });
  const ctx = { prisma: app.prisma, redis: app.redis, io: { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) }, log } as unknown as JobContext;
  await createWorkers(ctx, {} as never);
});

beforeEach(async () => { await settleAll(); await wipePages(); });

afterAll(async () => {
  await wipePages();
  await sys(async () => {
    await app.prisma.mmgRefundObligation.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.mmgRefundSend.deleteMany({ where: { orderId: { in: orderIds } } });
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

describe('[G08] the deadline', () => {
  it('before it nothing happens', async () => {
    const { order, obligationId } = await owed(HOUR);
    await run();
    expect((await row(obligationId)).missedAt).toBeNull();
    expect(await noticesFor(ownerUserId, order.id)).toHaveLength(0);
    expect(await pages()).toHaveLength(0);
  });

  it('past it the miss is set once, the store told once, one page however many passes, and it stays owed', async () => {
    const { order, obligationId } = await owed(-HOUR);
    await run();
    const first = await row(obligationId);
    expect(first.status).toBe('OWED');
    expect(first.missedAt).toBeInstanceOf(Date);
    await run();
    expect((await row(obligationId)).missedAt).toEqual(first.missedAt);
    // Two sweeps that both read it as due: the second finds it marked, under the order lock.
    expect(await sys(() => markMmgRefundMissed(app.prisma, obligationId, new Date(Date.now() + HOUR)))).toBe(false);
    expect((await row(obligationId)).missedAt).toEqual(first.missedAt);
    const told = await noticesFor(ownerUserId, order.id);
    expect(told.map((notice) => notice.title)).toEqual(['Refund overdue']);
    expect(told[0]!.data).toMatchObject({ kind: 'mmg_refund_overdue', audience: 'business' });
    const open = await pages();
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain(order.orderNumber);
    expect(open[0]!.closedAt).toBeNull();
  });

  it('the page closes when none is overdue', async () => {
    await owed(-HOUR);
    await run();
    await settleAll();
    await run();
    const after = await pages();
    expect(after).toHaveLength(1);
    expect(after[0]!.closedAt).toBeInstanceOf(Date);
  });

  it('a sent refund is not overdue', async () => {
    const { order, obligationId } = await owed(-HOUR, 'SENT');
    await run();
    expect((await row(obligationId)).missedAt).toBeNull();
    expect(await noticesFor(ownerUserId, order.id)).toHaveLength(0);
  });

  it('it moves no money', async () => {
    const { order } = await owed(-HOUR);
    await run();
    expect(await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))).toMatchObject({ paymentStatus: 'CLAIMED', refundOwedAt: null, refundSettledAt: null });
  });
});

describe('[G08] a send nobody answered', () => {
  it('not before two days; asked once more after, however many passes', async () => {
    const fresh = await owed(HOUR, 'SENT', 47 * HOUR);
    const stale = await owed(HOUR, 'SENT', 49 * HOUR);
    await run();
    await run();
    expect(await noticesFor(customerId, fresh.order.id)).toHaveLength(0);
    const told = await noticesFor(customerId, stale.order.id);
    expect(told.map((notice) => notice.title)).toEqual(['Did your refund arrive?']);
    expect(told[0]!.data).toMatchObject({ kind: 'mmg_refund_sent', audience: 'customer' });
  });
});
