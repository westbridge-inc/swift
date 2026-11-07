import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { weeklyFeeAmount } from '../modules/billing/subscription-fee';

// ---------------------------------------------------------------------------
// [CHAINS · owner 29 Oct 2026] "Full tier fee per branch by default + an ADMIN
// tool so the founder can set a negotiated weekly rate for one chain"
// (decision 49 'no automatic multi-store discount' stays).
//
// PUT /admin/vendor-owners/:id/deal-rate is money (C4): a reason and a second
// person. It writes the deal on the owner and, as each branch's custom rate,
// on every branch it may apply to, from the branch's next weekly fee:
//  - never a rise: a branch already at or under the deal keeps its own fee, and
//    a deal is only ever lowered (raising or ending one needs the 14-day notice);
//  - never under a payment: a branch with an MMG checkout open is left alone
//    (setting the deal again later applies it there);
//  - one record: who, when, why, and what happened to each branch.
// GET /admin/vendor-owners/:id/chain shows the chain as the console draws it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = wordFreeTag(8);
const userIds: string[] = [];
const ownerIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let token = '';
let adminId = '';
const REASON = 'Chain deal agreed with head office on 29 Oct, signed letter on file';

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

async function chain(fees: Array<{ weeklyRate: number; status?: 'ACTIVE' | 'TRIAL' | 'CHURNED'; customRate?: number } | null>) {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Chain', lastName: `Head${RUN}${nanoid(3)}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(u.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: u.id } });
  ownerIds.push(owner.id);
  const branches: Array<{ vendorId: string; subscriptionId: string | null }> = [];
  for (const fee of fees) {
    const v = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: `Chain Branch ${RUN} ${wordFreeTag(6)}`, slug: `chain-deal-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: testPhone(), addressLine1: '1 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
    vendorIds.push(v.id);
    let subscriptionId: string | null = null;
    if (fee) {
      const next = new Date(Date.now() + 5 * 86_400_000);
      const sub = await app.prisma.subscription.create({ data: {
        vendorId: v.id, type: 'RESTAURANT', status: fee.status ?? 'ACTIVE', weeklyRate: fee.weeklyRate, customRate: fee.customRate ?? null,
        currencyCode: 'GYD', billingMethod: 'CASH', currentPeriodStart: new Date(), currentPeriodEnd: next, nextBillingDate: next } });
      subIds.push(sub.id);
      subscriptionId = sub.id;
    }
    branches.push({ vendorId: v.id, subscriptionId });
  }
  return { ownerId: owner.id, userId: u.id, branches };
}

const subOf = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Chain', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  adminId = admin.id;
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'chains', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
    await purgeFixtureAuditTrail(app.prisma, userIds, 'chains-deal-rate');
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'chains-deal');
  await app.close();
});

describe('[CHAINS] the chain deal is money: classified, reasoned, approved by a second person', () => {
  it('the routes are declared (C4 for the write)', () => {
    expect(ADMIN_ROUTE_AUTHORITY['PUT /vendor-owners/:id/deal-rate']?.cls).toBe('C4');
    expect(ADMIN_ROUTE_AUTHORITY['GET /vendor-owners/:id/chain']).toBeTruthy();
  });
});

describe('[CHAINS] PUT /admin/vendor-owners/:id/deal-rate', () => {
  it('lowers every branch at or above the deal from its next weekly fee; never raises one already under it', async () => {
    const c = await chain([{ weeklyRate: 20000 }, { weeklyRate: 15000 }, { weeklyRate: 12000 }, { weeklyRate: 20000, status: 'TRIAL' }, null]);
    const res = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 14000, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const outcomes = res.json().data.branches.map((b: { outcome: string }) => b.outcome);
    expect(outcomes).toEqual(['APPLIED', 'APPLIED', 'OWN_FEE_LOWER', 'APPLIED', 'NO_FEE_YET']);
    const [a, b, small, trial] = await Promise.all(c.branches.slice(0, 4).map((x) => subOf(x.subscriptionId!)));
    expect(Number(a!.customRate)).toBe(14000);
    expect(Number(b!.customRate)).toBe(14000);
    // The deal is a standing rule on every branch; one whose own fee is lower keeps paying its own fee.
    expect(Number(small!.customRate)).toBe(14000);
    expect(weeklyFeeAmount(small!), 'a branch already under the deal keeps its own fee').toBe(12000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: small!.id, type: 'TIER_CHANGE' } }), 'its fee did not change').toBe(0);
    expect(Number(trial!.customRate)).toBe(14000);
    // The weekly rate (the tier) is untouched: the deal is an override with a record.
    expect(Number(a!.weeklyRate)).toBe(20000);
    const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId: a!.id, type: 'TIER_CHANGE' } });
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.amount)).toBe(14000);
    const owner = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: c.ownerId } });
    expect(Number(owner.dealWeeklyRate)).toBe(14000);
    expect(owner).toMatchObject({ dealCurrencyCode: 'GYD', dealSetBy: adminId, dealReason: REASON });
    expect(owner.dealSetAt).toBeInstanceOf(Date);
    // The owner is told, on the fee screen's own notice.
    const notice = await app.prisma.notification.findFirst({ where: { userId: c.userId, data: { path: ['kind'], equals: 'billing_rate_change' } } });
    expect(notice?.body).toContain('14,000');
    // One audit row: who, why, and each branch's outcome.
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findFirst({ where: { userId: adminId, entityId: c.ownerId } }), 'read');
    expect(audit, 'the deal is on the record').toBeTruthy();
    expect(JSON.stringify(audit!.changes)).toContain('OWN_FEE_LOWER');
  });

  it('never changes a branch under a payment in flight; the same deal set again later applies it', async () => {
    const c = await chain([{ weeklyRate: 20000 }]);
    const subId = c.branches[0]!.subscriptionId!;
    const checkout = await app.prisma.mmgCheckoutIntent.create({ data: {
      tenantId: 'swift-default', subscriptionId: subId, merchantTransactionId: `${Date.now()}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`.padEnd(18, '0').slice(0, 18), amount: 20000, currencyCode: 'GYD',
      createdByUserId: c.userId, platform: 'ios', checkoutUrlSealed: new Uint8Array(40).fill(1), checkoutUrlDek: new Uint8Array(40).fill(1),
      expiresAt: new Date(Date.now() + 600_000) } });
    const first = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 16000, reason: REASON });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.branches[0].outcome).toBe('PAYMENT_IN_FLIGHT');
    expect((await subOf(subId)).customRate).toBeNull();
    await app.prisma.mmgCheckoutIntent.update({ where: { id: checkout.id }, data: { status: 'EXPIRED' } });
    const again = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 16000, reason: REASON });
    expect(again.json().data.branches[0].outcome).toBe('APPLIED');
    expect(Number((await subOf(subId)).customRate)).toBe(16000);
    const third = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 16000, reason: REASON });
    expect(third.json().data.branches[0].outcome, 'setting the same deal twice changes nothing').toBe('UNCHANGED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'TIER_CHANGE' } })).toBe(1);
  });

  it('a branch on an older, lower custom rate is never raised to the deal', async () => {
    const c = await chain([{ weeklyRate: 20000, customRate: 10000 }]);
    const res = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 14000, reason: REASON });
    expect(res.json().data.branches[0].outcome).toBe('WOULD_RAISE');
    expect(Number((await subOf(c.branches[0]!.subscriptionId!)).customRate)).toBe(10000);
  });

  it('a deal is only ever lowered: raising it is a fee rise and is refused', async () => {
    const c = await chain([{ weeklyRate: 20000 }]);
    expect((await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 15000, reason: REASON })).statusCode).toBe(200);
    const raise = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 17000, reason: REASON });
    expect(raise.statusCode, raise.body).toBe(409);
    expect(raise.json().error.code).toBe('DEAL_RISE_NEEDS_NOTICE');
    expect(Number((await subOf(c.branches[0]!.subscriptionId!)).customRate)).toBe(15000);
    expect(Number((await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: c.ownerId } })).dealWeeklyRate)).toBe(15000);
  });

  it('a churned branch and a waived fee are left alone; a zero or fractional deal is refused', async () => {
    const c = await chain([{ weeklyRate: 20000, status: 'CHURNED' }]);
    const res = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 10000, reason: REASON });
    expect(res.json().data.branches[0].outcome).toBe('NOT_BILLED');
    expect((await subOf(c.branches[0]!.subscriptionId!)).customRate).toBeNull();
    for (const bad of [0, 1500.5, -100]) {
      const r = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: bad, reason: REASON });
      expect(r.statusCode, `${bad}: ${r.body}`).toBe(400);
    }
  });

  it('an owner of another market (tenant) is a 404: nothing is read or written across the wall', async () => {
    const tenantB = `chains-b-${nanoid(6).toLowerCase()}`;
    await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: tenantB, name: 'Chains tenant B', slug: tenantB, isActive: true } }), 'test-fixture:chains');
    try {
      const u = await runWithoutTenant(() => app.prisma.user.create({ data: {
        phone: testPhone(), firstName: 'Other', lastName: `Market${RUN}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true, tenantId: tenantB } }), 'test-fixture:chains');
      userIds.push(u.id);
      const owner = await runWithoutTenant(() => app.prisma.vendorOwner.create({ data: { userId: u.id } }), 'test-fixture:chains');
      ownerIds.push(owner.id);
      const put = await call('PUT', `/api/v1/admin/vendor-owners/${owner.id}/deal-rate`, { weeklyRate: 10000, reason: REASON });
      expect(put.statusCode, put.body).toBe(404);
      const get = await app.inject({ method: 'GET', url: `/api/v1/admin/vendor-owners/${owner.id}/chain`, headers: { authorization: `Bearer ${token}` } });
      expect(get.statusCode, get.body).toBe(404);
      expect((await runWithoutTenant(() => app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: owner.id } }), 'read')).dealWeeklyRate).toBeNull();
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.vendorOwner.deleteMany({ where: { user: { tenantId: tenantB } } });
        await app.prisma.session.deleteMany({ where: { user: { tenantId: tenantB } } });
        await app.prisma.user.deleteMany({ where: { tenantId: tenantB } });
        await app.prisma.tenant.deleteMany({ where: { id: tenantB } });
      }, 'test-fixture:chains');
    }
  });

  it('an owner that does not exist is a 404', async () => {
    const res = await call('PUT', `/api/v1/admin/vendor-owners/nope${nanoid(6)}/deal-rate`, { weeklyRate: 10000, reason: REASON });
    expect(res.statusCode).toBe(404);
  });
});

describe('[CHAINS] GET /admin/vendor-owners/:id/chain', () => {
  it('lists each branch with the fee it pays and the deal', async () => {
    const c = await chain([{ weeklyRate: 20000 }, { weeklyRate: 12000 }]);
    await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 14000, reason: REASON });
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/vendor-owners/${c.ownerId}/chain`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.deal).toMatchObject({ weeklyRate: 14000, currencyCode: 'GYD', reason: REASON });
    expect(data.branches.map((b: { subscription: { weeklyFee: number } }) => b.subscription.weeklyFee)).toEqual([14000, 12000]);
  });
});
