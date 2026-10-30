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
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { FEE_RISE_NOTICE_DAYS, feeRiseKey, readHeldFeeRise } from '../modules/billing/fee-rise-notice';
import { DEAL_CHANGE_HOLD_LEAD_MS, sweepChainDealChanges } from '../modules/vendor/chain-deal';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [ENTERPRISE E2 · owner 29 Oct 2026 "just do whats best"; COORD ruling 21:28Z]
// A chain deal's END date, and "end deal" / "raise deal", through the 14-day
// fee-change notice (GUARDRAILS s7 standing rule 2), against the real database
// and the real admin routes (C4: a reason and a second person):
//   N1 nothing a branch is charged changes when the change is asked for
//   N2 every branch on the deal whose fee goes UP is told in the app at least
//      14 days ahead, with the old fee, the new fee and the date; a branch
//      whose fee does not go up just leaves the deal (no notice owed)
//   N3 the new fee applies only from the branch's first weekly fee due on or
//      after the end date AND 14 days after it was told; a week already paid
//      keeps its price (the F2 machinery, unchanged); never retroactive
//   N4 the owner's own deal moves at the end date; the change closes once no
//      branch is left on the old deal
//   N5 withdrawing the change, or setting a lower deal, raises nothing and
//      tells a branch already told that it will not happen
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
let billing: BillingService;
const RUN = wordFreeTag(8);
const userIds: string[] = [];
const ownerIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let token = '';
const REASON = 'Head office deal ends as agreed in the signed letter of 29 Oct';

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

type Fee = { weeklyRate: number; status?: 'ACTIVE' | 'TRIAL' | 'CHURNED'; customRate?: number | null; prepaid?: number; due?: Date; feeWaived?: boolean };
/** An owner on a chain deal of `deal` a week, one branch per fee (customRate defaults to the deal). */
async function chain(deal: number, fees: Fee[]) {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Chain', lastName: `Head${RUN}${nanoid(3)}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(u.id);
  const owner = await app.prisma.vendorOwner.create({ data: {
    userId: u.id, dealWeeklyRate: deal, dealCurrencyCode: 'GYD', dealSetAt: new Date(), dealSetBy: 'test-admin', dealReason: 'test deal',
  } });
  ownerIds.push(owner.id);
  const branches: Array<{ vendorId: string; subId: string; name: string }> = [];
  for (const fee of fees) {
    const v = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: `Deal Branch ${RUN} ${wordFreeTag(6)}`, slug: `deal-change-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: testPhone(), addressLine1: '1 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
    vendorIds.push(v.id);
    const next = fee.due ?? new Date(Date.now() + 5 * DAY);
    const sub = await app.prisma.subscription.create({ data: {
      vendorId: v.id, type: 'RESTAURANT', status: fee.status ?? 'ACTIVE', weeklyRate: fee.weeklyRate,
      customRate: fee.customRate === undefined ? deal : fee.customRate, currencyCode: 'GYD', billingMethod: 'CASH', autoRenew: true, feeWaived: fee.feeWaived ?? false,
      currentPeriodStart: new Date(next.getTime() - 7 * DAY), currentPeriodEnd: next, nextBillingDate: next,
      prepaidBalance: { create: { balance: fee.prepaid ?? 0, currencyCode: 'GYD' } } } });
    subIds.push(sub.id);
    branches.push({ vendorId: v.id, subId: sub.id, name: v.name });
  }
  return { ownerId: owner.id, userId: u.id, branches };
}

const subOf = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const ownerOf = (id: string) => app.prisma.vendorOwner.findUniqueOrThrow({ where: { id } });
const heldOf = async (subId: string) => {
  const row = await app.prisma.platformConfig.findUnique({ where: { key: feeRiseKey(subId) } });
  return row ? readHeldFeeRise(row.value) : null;
};
const notices = (userId: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: 'billing_rate_change' } }, orderBy: { createdAt: 'asc' },
});
const change = (ownerId: string, body: Record<string, unknown>) => call('POST', `/api/v1/admin/vendor-owners/${ownerId}/deal-change`, { reason: REASON, ...body });
const withdraw = (ownerId: string) => call('DELETE', `/api/v1/admin/vendor-owners/${ownerId}/deal-change`, { reason: REASON });

beforeAll(async () => {
  delete process.env['MMG_DRIVER'];
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  const admin = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Chain', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'deal-change', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: { in: subIds.map(feeRiseKey) } } }).catch(() => {});
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await cleanupBillingClocks(app.prisma, subIds).catch(() => {});
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
    await purgeFixtureAuditTrail(app.prisma, userIds, 'chain-deal-change');
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'chain-deal-change');
  await app.close();
});

describe('[E2] a deal end or raise is money: classified, reasoned, approved by a second person', () => {
  it('both routes are C4', () => {
    expect(ADMIN_ROUTE_AUTHORITY['POST /vendor-owners/:id/deal-change']?.cls).toBe('C4');
    expect(ADMIN_ROUTE_AUTHORITY['DELETE /vendor-owners/:id/deal-change']?.cls).toBe('C4');
  });

  it('refuses what is not a rise, a past date, no deal, a second pending change', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    expect((await change(c.ownerId, { kind: 'RAISE', weeklyRate: 14000 })).json().error.code).toBe('DEAL_NOT_RAISED');
    expect((await change(c.ownerId, { kind: 'RAISE', weeklyRate: 9000 })).json().error.code).toBe('DEAL_NOT_RAISED');
    expect((await change(c.ownerId, { kind: 'RAISE' })).statusCode).toBe(400);
    expect((await change(c.ownerId, { kind: 'END', weeklyRate: 16000 })).json().error.code).toBe('DEAL_RATE_INVALID');
    expect((await change(c.ownerId, { kind: 'END', notBefore: new Date(Date.now() - 2 * DAY).toISOString() })).json().error.code).toBe('DEAL_CHANGE_DATE_INVALID');
    expect((await change(c.ownerId, { kind: 'END', notBefore: new Date(Date.now() + 400 * DAY).toISOString() })).json().error.code).toBe('DEAL_CHANGE_DATE_INVALID');
    expect((await change(c.ownerId, { kind: 'END' })).statusCode).toBe(200);
    expect((await change(c.ownerId, { kind: 'END' })).json().error.code).toBe('DEAL_CHANGE_PENDING');
    const none = await chain(14000, [{ weeklyRate: 20000 }]);
    await app.prisma.vendorOwner.update({ where: { id: none.ownerId }, data: { dealWeeklyRate: null, dealCurrencyCode: null, dealSetAt: null, dealSetBy: null, dealReason: null } });
    expect((await change(none.ownerId, { kind: 'END' })).json().error.code).toBe('NO_DEAL');
  });
});

describe('[E2] ending a deal now', () => {
  it('N1/N2 nothing changes at once; branches whose fee goes up are held and told 14 days ahead; the others just leave the deal', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }, { weeklyRate: 12000 }, { weeklyRate: 20000, status: 'TRIAL' }, { weeklyRate: 20000, status: 'CHURNED' }]);
    const [up, low, trial, churned] = c.branches as [typeof c.branches[0], typeof c.branches[0], typeof c.branches[0], typeof c.branches[0]];
    const res = await change(c.ownerId, { kind: 'END' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.branches.map((b: { outcome: string }) => b.outcome)).toEqual(['HELD', 'LEFT_DEAL', 'HELD', 'LEFT_DEAL']);
    // N1: what the branch is charged has not moved.
    expect(weeklyFeeAmount(await subOf(up.subId))).toBe(14000);
    expect(Number((await subOf(up.subId)).customRate)).toBe(14000);
    // A branch whose own fee is under the deal leaves it with no change to what it pays.
    expect((await subOf(low.subId)).customRate).toBeNull();
    expect(weeklyFeeAmount(await subOf(low.subId))).toBe(12000);
    expect((await subOf(churned.subId)).customRate).toBeNull();
    expect(await heldOf(low.subId)).toBeNull();
    const held = await heldOf(up.subId);
    expect(held).toMatchObject({ source: 'CHAIN_DEAL', from: 14000, to: 20000, customFrom: 14000, customTo: null, noticeAt: null });
    expect(await heldOf(trial.subId)).toMatchObject({ source: 'CHAIN_DEAL', from: 14000, to: 20000 });
    // N2: the billing run tells each held branch, in the app, with the deal, both fees and the date.
    // (The billing run is global: other rises on this database are told too; this owner's two are checked below.)
    await billing.sweepFeeRises(new Date());
    const sent = await notices(c.userId);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toContain(`${up.name}: your Swift chain deal is ending.`);
    expect(sent[0]!.body).toMatch(/GY\$20,000/);
    expect(sent[0]!.body).toMatch(/GY\$14,000/);
    expect(sent[0]!.body).toContain(`tap Stop weekly billing on ${up.name}'s weekly-fee screen`);
    const after = (await heldOf(up.subId))!;
    expect(Date.parse(after.appliesFrom!)).toBeGreaterThanOrEqual(Date.parse(after.noticeAt!) + FEE_RISE_NOTICE_DAYS * DAY);
    // The owner's deal moves now (the end date is today): a branch approved from now on pays its own tier fee.
    await sweepChainDealChanges(app.prisma, new Date());
    const owner = await ownerOf(c.ownerId);
    expect(owner.dealWeeklyRate).toBeNull();
    expect(owner.dealChangeKind).toBe('END');
    expect(owner.dealChangeSwitchedAt).not.toBeNull();
  });

  it('N3 the new fee applies only from the first weekly fee at least 14 days after the notice; never before; then the change closes', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    const sub = c.branches[0]!.subId;
    await change(c.ownerId, { kind: 'END' });
    await billing.sweepFeeRises(new Date());
    const held = (await heldOf(sub))!;
    const appliesFrom = new Date(held.appliesFrom!);
    // The fee due before the told date is still the deal: a run now applies nothing.
    await billing.sweepFeeRises(new Date());
    expect(Number((await subOf(sub)).customRate)).toBe(14000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub, type: 'TIER_CHANGE' } })).toBe(0);
    // The week before the told date settles at the deal; once the next fee is due on the told date it moves.
    await app.prisma.subscription.update({ where: { id: sub }, data: { nextBillingDate: new Date(appliesFrom.getTime() - 7 * DAY) } });
    await billing.sweepFeeRises(new Date());
    expect(Number((await subOf(sub)).customRate)).toBe(14000);
    await app.prisma.subscription.update({ where: { id: sub }, data: { nextBillingDate: appliesFrom } });
    await billing.sweepFeeRises(new Date());
    const moved = await subOf(sub);
    expect(moved.customRate).toBeNull();
    expect(weeklyFeeAmount(moved)).toBe(20000);
    const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId: sub, type: 'TIER_CHANGE' } });
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.amount)).toBe(20000);
    expect(events[0]!.note).toContain('Chain deal ended');
    // No branch left on the old deal: the change is done.
    await sweepChainDealChanges(app.prisma, new Date());
    expect((await ownerOf(c.ownerId)).dealChangeKind).toBeNull();
  });

  it('N3 a whole week already paid at the deal keeps its price: the new fee moves one week later', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000, prepaid: 14000 }]);
    const sub = c.branches[0]!.subId;
    await change(c.ownerId, { kind: 'END' });
    await billing.sweepFeeRises(new Date());
    const appliesFrom = new Date((await heldOf(sub))!.appliesFrom!);
    await app.prisma.subscription.update({ where: { id: sub }, data: { nextBillingDate: appliesFrom } });
    await billing.sweepFeeRises(new Date());
    expect(Number((await subOf(sub)).customRate)).toBe(14000);
    expect(Date.parse((await heldOf(sub))!.appliesFrom!)).toBe(appliesFrom.getTime() + 7 * DAY);
  });
});

describe('[REVIEW-F #2227 S3-1] each branch\'s notice names its branch, with its own numbers, and opens its own fee screen', () => {
  it('an owner with two branches on different tiers gets two notices, each naming its branch', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }, { weeklyRate: 16000 }]);
    const [a, b] = c.branches as [typeof c.branches[0], typeof c.branches[0]];
    await change(c.ownerId, { kind: 'END' });
    await billing.sweepFeeRises(new Date());
    const sent = await notices(c.userId);
    expect(sent).toHaveLength(2);
    const of = (vendorId: string) => sent.find((n) => (n.data as Record<string, unknown>)['vendorId'] === vendorId)!;
    expect(of(a.vendorId).title).toBe(`${a.name}: your weekly fee is changing`);
    expect(of(a.vendorId).body).toContain(`its Swift weekly fee will be GY$20,000 (it is GY$14,000 now)`);
    expect(of(b.vendorId).title).toBe(`${b.name}: your weekly fee is changing`);
    expect(of(b.vendorId).body).toContain(`its Swift weekly fee will be GY$16,000 (it is GY$14,000 now)`);
    expect(of(b.vendorId).body).toContain(`If you do not want the new fee for ${b.name}`);
  });
});

describe('[REVIEW-M #2227 S4-1 · REVIEW-F S4-1] edges of the end date', () => {
  it('a waived branch whose fee would go up stays on the deal until the end date, then leaves it', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000, feeWaived: true }]);
    const sub = c.branches[0]!.subId;
    const endsAt = new Date(Date.now() + 5 * DAY);
    const res = await change(c.ownerId, { kind: 'END', notBefore: endsAt.toISOString() });
    expect(res.json().data.branches[0].outcome).toBe('WAITING');
    expect(Number((await subOf(sub)).customRate)).toBe(14000);
    await sweepChainDealChanges(app.prisma, new Date(endsAt.getTime() + 1000));
    expect((await subOf(sub)).customRate).toBeNull();
  });

  it('today\'s date from the console (the start of today in Guyana) means now', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    const gy = new Date(Date.now() - 4 * 3_600_000);
    const startOfToday = new Date(Date.UTC(gy.getUTCFullYear(), gy.getUTCMonth(), gy.getUTCDate()) + 4 * 3_600_000);
    const res = await change(c.ownerId, { kind: 'END', notBefore: startOfToday.toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect(Date.parse(res.json().data.notBefore)).toBeGreaterThanOrEqual(Date.now() - 60_000);
  });
});

describe('[E2] an end date and a raise', () => {
  it('a deal ending in 60 days: nothing is held or told until its notice period, and no fee moves before the end date', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    const sub = c.branches[0]!.subId;
    const endsAt = new Date(Date.now() + 60 * DAY);
    const res = await change(c.ownerId, { kind: 'RAISE', weeklyRate: 17000, notBefore: endsAt.toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.branches[0].outcome).toBe('WAITING');
    expect(await heldOf(sub)).toBeNull();
    // Weeks pass: still waiting, the deal unchanged for the owner.
    await sweepChainDealChanges(app.prisma, new Date(Date.now() + 30 * DAY));
    expect(await heldOf(sub)).toBeNull();
    expect(Number((await ownerOf(c.ownerId)).dealWeeklyRate)).toBe(14000);
    // Inside the notice period of the end date: held for the raise (the branch pays the raised deal, under its tier).
    const inside = new Date(endsAt.getTime() - DEAL_CHANGE_HOLD_LEAD_MS + DAY);
    await sweepChainDealChanges(app.prisma, inside);
    expect(await heldOf(sub)).toMatchObject({ source: 'CHAIN_DEAL', from: 14000, to: 17000, customFrom: 14000, customTo: 17000, notBefore: endsAt.toISOString() });
    // Told now: the first fee it applies to is never before the end date.
    await billing.sweepFeeRises(new Date());
    const held = (await heldOf(sub))!;
    expect(Date.parse(held.appliesFrom!)).toBeGreaterThanOrEqual(endsAt.getTime());
    expect((await notices(c.userId))[0]!.body).toContain(`${c.branches[0]!.name}: your Swift chain deal is changing to GY$17,000 a week.`);
    // At the end date the owner's deal is the raised one.
    await sweepChainDealChanges(app.prisma, new Date(endsAt.getTime() + 1000));
    expect(Number((await ownerOf(c.ownerId)).dealWeeklyRate)).toBe(17000);
    expect(Number((await subOf(sub)).customRate), 'the branch keeps the deal until its own told date').toBe(14000);
  });

  it('a held rise whose branch tier moved is dropped by the billing run and held again with the new numbers', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    const sub = c.branches[0]!.subId;
    await change(c.ownerId, { kind: 'RAISE', weeklyRate: 18000 });
    expect(await heldOf(sub)).toMatchObject({ from: 14000, to: 18000 });
    await app.prisma.subscription.update({ where: { id: sub }, data: { weeklyRate: 16000 } });
    await billing.sweepFeeRises(new Date());
    expect(await heldOf(sub)).toBeNull();
    await sweepChainDealChanges(app.prisma, new Date());
    expect(await heldOf(sub)).toMatchObject({ from: 14000, to: 16000, customTo: 18000 });
  });
});

describe('[E2] withdrawing a change, or a lower deal, raises nothing', () => {
  it('N5 a withdrawn end: every held rise dropped, a told branch told it will not happen, the deal unchanged', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    const sub = c.branches[0]!.subId;
    await change(c.ownerId, { kind: 'END', notBefore: new Date(Date.now() + 3 * DAY).toISOString() });
    await billing.sweepFeeRises(new Date());
    expect((await heldOf(sub))!.noticeAt).not.toBeNull();
    const res = await withdraw(c.ownerId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.droppedRises).toBe(1);
    expect(await heldOf(sub)).toBeNull();
    expect((await ownerOf(c.ownerId)).dealChangeKind).toBeNull();
    expect(Number((await ownerOf(c.ownerId)).dealWeeklyRate)).toBe(14000);
    const sent = await notices(c.userId);
    const name = c.branches[0]!.name;
    expect(sent.map((n) => n.title)).toEqual([`${name}: your weekly fee is changing`, `${name}: your weekly fee is not changing`]);
    expect((sent[1]!.data as Record<string, unknown>)['vendorId']).toBe(c.branches[0]!.vendorId);
    expect((await withdraw(c.ownerId)).json().error.code).toBe('NO_DEAL_CHANGE');
    // A DELETE carries its reason in the stated-reason header alone (no body), as every console C4 call does.
    await change(c.ownerId, { kind: 'END', notBefore: new Date(Date.now() + 3 * DAY).toISOString() });
    const headerOnly = await call('DELETE', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-change`);
    expect(headerOnly.statusCode, headerOnly.body).toBe(200);
  });

  it('N5 a change already in force for the owner cannot be withdrawn; a lower deal supersedes it and drops what is left', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    const sub = c.branches[0]!.subId;
    await change(c.ownerId, { kind: 'RAISE', weeklyRate: 17000 });
    await billing.sweepFeeRises(new Date());
    await sweepChainDealChanges(app.prisma, new Date());
    expect((await withdraw(c.ownerId)).json().error.code).toBe('DEAL_CHANGE_IN_FORCE');
    const lower = await call('PUT', `/api/v1/admin/vendor-owners/${c.ownerId}/deal-rate`, { weeklyRate: 12000, reason: REASON });
    expect(lower.statusCode, lower.body).toBe(200);
    expect(await heldOf(sub)).toBeNull();
    expect((await ownerOf(c.ownerId)).dealChangeKind).toBeNull();
    expect(Number((await subOf(sub)).customRate)).toBe(12000);
    expect((await notices(c.userId)).some((n) => n.title === `${c.branches[0]!.name}: your weekly fee is not changing`)).toBe(true);
  });

  it('the console shows the pending change and each branch held change', async () => {
    const c = await chain(14000, [{ weeklyRate: 20000 }]);
    await change(c.ownerId, { kind: 'END' });
    const res = await call('GET', `/api/v1/admin/vendor-owners/${c.ownerId}/chain`);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.change).toMatchObject({ kind: 'END', from: 14000, to: null });
    expect(data.branches[0].subscription.heldChange).toMatchObject({ source: 'CHAIN_DEAL', from: 14000, to: 20000, told: false, dealTo: null });
  });
});

describe('[E2] the held record refuses what could charge more or sooner', () => {
  it('a chain-deal record told for a date before its end date, or that does not raise the deal, is not one', () => {
    const base = { from: 14000, to: 20000, currencyCode: 'GYD', source: 'CHAIN_DEAL', heldAt: new Date().toISOString(), inboxId: null, customFrom: 14000, customTo: null };
    const notBefore = new Date(Date.now() + 30 * DAY).toISOString();
    expect(readHeldFeeRise({ ...base, notBefore, noticeAt: null, appliesFrom: null })).not.toBeNull();
    const noticeAt = new Date().toISOString();
    expect(readHeldFeeRise({ ...base, notBefore, noticeAt, appliesFrom: new Date(Date.now() + 20 * DAY).toISOString() })).toBeNull();
    expect(readHeldFeeRise({ ...base, notBefore, noticeAt: null, appliesFrom: null, customTo: 13000 })).toBeNull();
    expect(readHeldFeeRise({ ...base, noticeAt: null, appliesFrom: null })).toBeNull();
    expect(readHeldFeeRise({ ...base, source: 'WEEKLY_RETIER', notBefore, noticeAt: null, appliesFrom: null })).toBeNull();
  });
});
