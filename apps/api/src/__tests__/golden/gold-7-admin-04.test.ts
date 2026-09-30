import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, PaymentMethod, UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { purgeAuditLogs } from '../../lib/audit-immutability';
import { startGoldenWorker } from './gold-7-worker';

// ---------------------------------------------------------------------------
// GOLD-7 · ADMIN-04 — completed sales → production process-settlements
// consumer → mounted digest, payment-mix and revenue views → acknowledge.
// This is a sales record, never a transfer of vendor money through Swift.
// G5-F6 interrupted-import recovery stays pinned in gold-5-admin-finance.
// Provider/device-only: live wallet acceptance and real notice delivery.
//
// +5920979nnn: checked against src phone literals/generators; GOLD-7a uses
// 0971..0976 and 0978, weekly fees use 0977. Only Date is controlled; BullMQ
// and timers stay real. The historical window must contain no foreign sale,
// and every foreign digest must survive unchanged. No sweep is mocked.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920979';
const FIXTURE = 'gold7-admin04-fixture';
const TENANT = 'gold7-admin04-tenant';
const DAY = 86_400_000;
const NOW = new Date('2000-01-12T16:00:00.000Z');
const PERIOD_START = new Date('2000-01-03T04:00:00.000Z');
const PERIOD_END = new Date('2000-01-10T04:00:00.000Z');
let app: FastifyInstance;
let worker: Awaited<ReturnType<typeof startGoldenWorker>> | undefined;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

async function actor(role: UserRole) {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({ data: {
    tenantId: TENANT, phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
    firstName: 'Golden', lastName: 'Finance', roles: [role], activeRole: role, isPhoneVerified: true,
    ...(role === 'ADMIN' && { admin: { create: { permissions: ['*'] } } }),
    ...(role === 'CUSTOMER' && { customer: { create: {} } }),
  } }));
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `${FIXTURE}-${seq}`,
    deviceType: 'test', expiresAt: new Date(NOW.getTime() + DAY),
  } }));
  return { userId: user.id, token, phone: user.phone };
}

function call(method: 'GET' | 'PUT', url: string, token: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method, url: `/api/v1/admin/finance/${url}`, headers: {
    ...headers, authorization: `Bearer ${token}`, 'x-swift-reason': 'GOLD-7 finance: acknowledge the weekly sales record',
    ...(payload && { 'content-type': 'application/json' }),
  }, ...(payload && { payload }) });
}

async function purge() {
  await sys(async () => {
    const ids = (await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } })).map((u) => u.id);
    const vendors = (await app.prisma.vendor.findMany({ where: { tenantId: TENANT }, select: { id: true } })).map((v) => v.id);
    const digests = (await app.prisma.settlement.findMany({ where: { vendorId: { in: vendors } }, select: { id: true } })).map((d) => d.id);
    const sessions = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: digests } }] }, 'test-cleanup:gold7-admin04');
    await app.prisma.privilegedApproval.deleteMany({ where: { tenantId: TENANT } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { recipientId: { in: ids } } });
    await app.prisma.settlement.deleteMany({ where: { vendorId: { in: vendors } } });
    await app.prisma.order.deleteMany({ where: { tenantId: TENANT } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT } });
    const owned = new Set([...ids, ...vendors, ...sessions]);
    let cursor = '0';
    do {
      const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
      cursor = next;
      const mine = keys.filter((key) => key.split(':').some((part) => owned.has(part)));
      if (mine.length) await app.redis.del(...mine);
    } while (cursor !== '0');
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purge();
  // The production scan covers all tenants. Refuse a window that could create
  // somebody else's digest instead of narrowing or replacing that scan.
  expect(await sys(() => app.prisma.orderStatusLog.count({ where: {
    status: 'COMPLETED', createdAt: { gte: new Date(PERIOD_END.getTime() - 26 * 7 * DAY), lt: PERIOD_END },
    order: { vendorId: { not: null } },
  } }))).toBe(0);
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT, slug: TENANT, name: 'Golden Finance' } }));
  worker = await startGoldenWorker(app, 'settlement', 'gold7-admin04');
});

afterAll(async () => {
  const errors: unknown[] = [];
  const finish = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { errors.push(error); } };
  if (worker) await finish(() => worker!.close());
  await finish(() => new Promise((resolve) => setTimeout(resolve, 300)));
  if (app) { await finish(purge); await finish(() => app.close()); }
  vi.useRealTimers();
  if (errors.length) throw new AggregateError(errors, 'GOLD-7 finance fixture cleanup failed');
});

describe('GOLD-7 · ADMIN-04 — weekly sales digest [G7-R4]', () => {
  it('consumes completed orders once, exposes exact finance totals and acknowledges the digest without a payout', async () => {
    const admin = await actor('ADMIN');
    const approver = await actor('ADMIN');
    const customer = await actor('CUSTOMER');
    const owner = await actor('VENDOR_OWNER');
    const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
    const vendor = await sys(() => app.prisma.vendor.create({ data: {
      tenantId: TENANT, ownerId: vendorOwner.id, name: 'Golden Digest Counter', slug: `gold7-digest-${nanoid(8)}`,
      vendorType: 'RESTAURANT', phone: owner.phone, addressLine1: '7 Golden Lane', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    } }));
    async function sale(base: number, fee: number, method: PaymentMethod, at: Date, status: OrderStatus = 'COMPLETED') {
      await sys(() => app.prisma.order.create({ data: {
        tenantId: TENANT, orderNumber: `G7DG-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
        customerId: customer.userId, vendorId: vendor.id, status, deliveryAddress: '7 Golden Lane', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: base, subtotalMarkup: 0, subtotalCustomer: base, deliveryFee: fee, totalAmount: base + fee,
        paymentMethod: method, paymentStatus: method === 'MOBILE_MONEY' ? 'CLAIMED' : 'CAPTURED', placedAt: at, createdAt: at,
        ...(status === 'COMPLETED' && { statusHistory: { create: { status: 'COMPLETED', createdAt: at, note: 'GOLD-7 completed sale fixture' } } }),
      } }));
    }
    await sale(1500, 200, 'CASH', new Date(PERIOD_START.getTime() + DAY));
    await sale(2300, 300, 'MOBILE_MONEY', new Date(PERIOD_START.getTime() + 2 * DAY));
    await sale(9000, 0, 'CASH', new Date(PERIOD_START.getTime() + DAY), 'CANCELLED');
    await sale(8000, 0, 'CASH', new Date(PERIOD_START.getTime() + DAY), 'PENDING');
    await sale(1100, 0, 'CASH', NOW); // an unfinished calendar week is not digested
    const foreign = () => sys(() => app.prisma.settlement.findMany({ where: { vendorId: { not: vendor.id } }, orderBy: { id: 'asc' } }));
    const foreignBefore = await foreign();
    expect((await call('GET', `settlements?vendorId=${vendor.id}`, admin.token)).json().data).toEqual([]);

    await worker!.tick('process-settlements');
    const listed = await call('GET', `settlements?vendorId=${vendor.id}`, admin.token);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toHaveLength(1);
    const digest = listed.json().data[0];
    expect(digest).toMatchObject({
      vendorId: vendor.id, periodStart: PERIOD_START.toISOString(), periodEnd: PERIOD_END.toISOString(),
      kind: 'DIGEST', sequence: 0, totalOrders: 2, totalBase: 3800, totalMarkup: 0, totalDiscount: 0,
      goodsSales: 3800, customerCollection: 3800, netSales: 3800, moverPayable: 500,
      sponsorReceivable: 0, feeFunding: 0, status: 'PENDING', paidAt: null,
    });
    await worker!.tick('process-settlements');
    expect((await call('GET', `settlements?vendorId=${vendor.id}`, admin.token)).json().data).toEqual([digest]);

    const mix = await call('GET', 'payment-mix', admin.token);
    expect(mix.statusCode).toBe(200);
    expect(mix.json().data.byMethod.sort((a: { method: string }, b: { method: string }) => a.method.localeCompare(b.method)))
      .toEqual([{ method: 'CASH', count: 2, total: 2800 }, { method: 'MOBILE_MONEY', count: 1, total: 2600 }]);
    expect(mix.json().data.mmgUnconfirmed).toBe(1);
    const revenue = await call('GET', 'revenue', admin.token);
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().data.dailyRevenue).toEqual([
      { date: '2000-01-04', markup: 0, delivery_fees: 200, total: 1700, order_count: 1 },
      { date: '2000-01-05', markup: 0, delivery_fees: 300, total: 2600, order_count: 1 },
      { date: '2000-01-12', markup: 0, delivery_fees: 0, total: 1100, order_count: 1 },
    ]);
    expect(revenue.json().data.summary).toEqual({ thirtyDayMarkup: 0, thirtyDayDeliveryFees: 500,
      weeklySubscriptionRevenue: 0, monthlySubscriptionRevenue: 0, activeSubscriptions: 0 });

    async function acknowledge() {
      const url = `settlements/${digest.id}/process`;
      const payload = { reference: 'GOLD-7 weekly review' };
      const ask = await call('PUT', url, admin.token, payload);
      expect(ask.statusCode, ask.body).toBe(202);
      const approvalId = ask.json().error.details.approvalId as string;
      const decided = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`,
        headers: { authorization: `Bearer ${approver.token}`, 'x-swift-reason': 'GOLD-7 finance: reviewed the completed sales' },
        payload: { approve: true, note: 'Verified the sales digest against completed orders' } });
      expect(decided.statusCode, decided.body).toBe(200);
      return call('PUT', url, admin.token, payload, { 'x-swift-approval': approvalId });
    }
    const acknowledged = await acknowledge();
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(acknowledged.json().data).toMatchObject({ id: digest.id, status: 'ACKNOWLEDGED', paidAt: null });
    const duplicate = await acknowledge();
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error.code).toBe('ALREADY_ACKNOWLEDGED');
    const notices = await sys(() => app.prisma.notification.findMany({ where: { userId: owner.userId, title: 'Weekly sales digest ready' } }));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain('this is your record, not a payout');
    expect(await foreign()).toEqual(foreignBefore);
  });
});
