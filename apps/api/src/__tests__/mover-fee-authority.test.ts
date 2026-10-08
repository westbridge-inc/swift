import { registerMoverPush } from './helpers/mover-push';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { activeOverdueMs, currentDunningClock, projectDunningClock } from '../modules/billing/dunning-clock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Subscription, UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { BillingService } from '../modules/billing/billing.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { lockMoverFeeAuthority, resolveMoverFeeAuthority } from '../modules/subscription/mover-fee-authority';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { platformStats } from '../modules/admin/platform-stats';
import { runFxChangeNotices } from '../modules/billing/fx-notices';
import { grantStepUp } from './helpers/step-up';

const DAY = 86_400_000;
const run = nanoid(7);
const ids: string[] = [];
const tenantIds: string[] = [];
const rateIds: string[] = [];
const orphanSubscriptionIds: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-mover-fee-authority');
let app: FastifyInstance;
let billing: BillingService;
let subscriptions: SubscriptionService;
let finance: { userId: string; token: string };
let approver: { userId: string; token: string };

async function person(role: UserRole = 'MOVER', tenantId = 'swift-default', permissions = ['*']) {
  return sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `+59200081${Date.now()}${ids.length}`, firstName: 'Fee', lastName: 'Fixture',
      tenantId, countryCode: 'GY', roles: role === 'MOVER' ? ['MOVER', 'DRIVER', 'CUSTOMER'] : [role, 'CUSTOMER'],
      activeRole: role, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(role === 'SUPER_ADMIN' ? { admin: { create: { permissions } } } : {}),
    } });
    ids.push(user.id);
    await registerMoverPush(app.prisma, user.id);
    const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `fee-${run}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { userId: user.id, token };
  });
}

async function dual(tenantId = 'swift-default') {
  const who = await person('MOVER', tenantId);
  return sys(async () => {
    const rider = await app.prisma.rider.create({ data: { userId: who.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
    const driver = await app.prisma.driver.create({ data: { userId: who.userId, vehicleType: 'CAR', documentsVerified: true,
      vehicleMake: 'Test', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `FEE-${run}-${ids.length}`, driverLicenseUrl: 'storage://test/dl', vehicleInsuranceUrl: 'storage://test/insurance' } });
    await app.prisma.verificationDocument.create({ data: { userId: who.userId, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: 'storage://test/insurance', status: 'APPROVED', coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true, consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    return { ...who, riderId: rider.id, driverId: driver.id, tenantId };
  });
}

async function legacy(kind: 'empty' | 'paid' | 'pending' | 'funded' | 'restricted' = 'paid', tenantId = 'swift-default', ageDays = 1) {
  const who = await dual(tenantId);
  return sys(async () => {
    const start = new Date(Date.now() - ageDays * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    const base = { currencyCode: 'GYD', currentPeriodStart: start, currentPeriodEnd: end, nextBillingDate: end,
      status: kind === 'empty' ? 'TRIAL' as const : 'ACTIVE' as const,
      isTrialActive: kind === 'empty', trialEndDate: kind === 'empty' ? end : null };
    const rider = await app.prisma.subscription.create({ data: { ...base, riderId: who.riderId, type: 'DELIVERY_RIDER', weeklyRate: 6000 } });
    const driver = await app.prisma.subscription.create({ data: { ...base, driverId: who.driverId, type: 'TAXI_DRIVER', weeklyRate: 9000 } });
    if (kind !== 'empty') for (const sub of [rider, driver]) {
      await app.prisma.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: Number(sub.weeklyRate), paymentMethod: 'CASH', status: 'CAPTURED', paidAt: start, periodStart: start, periodEnd: end } });
      await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: Number(sub.weeklyRate), currencyCode: 'GYD', idempotencyKey: `success:${sub.id}:${start.toISOString().slice(0, 10)}`, note: 'Synthetic historical paid period' } });
    }
    if (kind === 'pending') await app.prisma.subscriptionPayment.create({ data: { subscriptionId: rider.id, amount: 6000, paymentMethod: 'MOBILE_MONEY', status: 'PENDING', periodStart: end, periodEnd: new Date(end.getTime() + 7 * DAY) } });
    if (kind === 'funded') await app.prisma.prepaidBalance.create({ data: { subscriptionId: rider.id, balance: 1000, currencyCode: 'GYD' } });
    if (kind === 'restricted') await app.prisma.subscription.update({ where: { id: rider.id }, data: { status: 'SUSPENDED', suspendedAt: start } });
    const authority = await app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, who));
    return { ...who, rider, driver, authority: authority! };
  });
}

const call = (token: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, extra: Record<string, string> = {}) => app.inject({
  method, url: `/api/v1/${path}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, ...(payload ? { payload } : {}),
});
const decisionBody = (f: Awaited<ReturnType<typeof legacy>>) => ({ expectedRevision: f.authority.revision, sourceSubscriptionIds: f.authority.sourceSubscriptionIds, canonicalSubscriptionId: f.driver.id, reason: 'Reviewed each original fee source and the existing paid periods.' });
async function approvedDecision(f: Awaited<ReturnType<typeof legacy>>, body = decisionBody(f)) {
  const path = `admin/billing/mover-fees/${f.userId}/resolve`;
  const ask = await call(finance.token, 'POST', path, body);
  expect(ask.statusCode, ask.body).toBe(202);
  const id = ask.json().error.details.approvalId as string;
  const approved = await call(approver.token, 'POST', `admin/approvals/${id}/decide`, { approve: true, reason: body.reason });
  expect(approved.statusCode, approved.body).toBe(200);
  return { path, body, approvalId: id, apply: () => call(finance.token, 'POST', path, body, { [APPROVAL_HEADER]: id }) };
}

async function ready(sub: Subscription) {
  return app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: {
    rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } },
  } });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  subscriptions = new SubscriptionService(app.prisma);
  finance = await person('SUPER_ADMIN'); approver = await person('SUPER_ADMIN');
});
afterAll(async () => {
  await sys(async () => {
    const originals = await app.prisma.subscription.findMany({ where: { OR: [
      { rider: { userId: { in: ids } } }, { driver: { userId: { in: ids } } },
    ] }, select: { id: true } });
    orphanSubscriptionIds.push(...originals.map((s) => s.id));
    await cleanupPayerBillingClocks(app.prisma, ids);
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: orphanSubscriptionIds } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: ids } } });
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] }, 'test-mover-fee-authority-cleanup');
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { fxRateId: { in: rateIds } } });
    await app.prisma.fxRate.deleteMany({ where: { id: { in: rateIds } } });
  });
  await app.close();
});

describe('one mover fee across actual role surfaces', () => {
  it.each(['taxi-first', 'delivery-first'] as const)('both screens, profiles, GO and settings use one fee after %s', async (order) => {
    const f = await dual();
    const sub = await sys(async () => {
      const first = order === 'taxi-first' ? await subscriptions.startTrialForDriver(f.driverId) : await subscriptions.startTrialForRider(f.riderId);
      if (order === 'taxi-first') await subscriptions.startTrialForRider(f.riderId); else await subscriptions.startTrialForDriver(f.driverId);
      return first;
    });
    for (const role of ['rider', 'driver']) {
      const screen = await call(f.token, 'GET', `${role}/subscription`);
      expect(screen.statusCode, screen.body).toBe(200);
      expect(screen.json().data).toMatchObject({ id: sub.id, type: 'TAXI_DRIVER', moverFee: { state: 'ACTIVE', canonicalSubscriptionId: sub.id } });
      expect(Number(screen.json().data.weeklyRate)).toBe(8000);
      const profile = await call(f.token, 'GET', `${role}/profile`);
      expect(profile.statusCode, profile.body).toBe(200);
      expect(profile.json().data.subscription.id).toBe(sub.id);
      const go = await call(f.token, 'POST', `${role}/go-online`, { latitude: 6.8, longitude: -58.15 });
      expect(go.statusCode, go.body).toBe(200);
    }
    // [SAFE-B] The billing-method routes need a stepped-up session.
    await grantStepUp(app, f.token);
    const stopped = await call(f.token, 'PUT', 'driver/subscription/billing-method', { method: 'NONE' });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const riderScreen = await call(f.token, 'GET', 'rider/subscription');
    expect(riderScreen.json().data.autoRenew).toBe(false);
    const resumed = await call(f.token, 'PUT', 'rider/subscription/billing-method', { method: 'CASH' });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await call(f.token, 'GET', 'driver/subscription')).json().data.autoRenew).toBe(true);
  });

  it('a held pair exposes both sources and prevents all new weekly debits and settings resume', async () => {
    const f = await legacy('funded');
    // [SAFE-B] A stepped-up session: the refusal below is the hold's, not the step-up's.
    await grantStepUp(app, f.token);
    for (const role of ['rider', 'driver']) {
      const screen = await call(f.token, 'GET', `${role}/subscription`);
      expect(screen.statusCode, screen.body).toBe(200);
      expect(screen.json().data.moverFee).toMatchObject({ state: 'FINANCE_HOLD' });
      expect(screen.json().data.moverFee.sources).toHaveLength(2);
      expect(screen.json().data.moverFee.sources.find((s: { subscriptionId: string }) => s.subscriptionId === f.rider.id).balance).toBe(1000);
      const resume = await call(f.token, 'PUT', `${role}/subscription/billing-method`, { method: 'CASH' });
      expect(resume.statusCode, resume.body).toBe(409);
    }
    await sys(async () => {
      const before = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: { in: [f.rider.id, f.driver.id] } } });
      expect(await billing.billSubscription(await ready(f.rider))).toBe('skipped');
      expect(await billing.billSubscription(await ready(f.driver))).toBe('skipped');
      expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: { in: [f.rider.id, f.driver.id] } } })).toBe(before);
      expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: f.rider.id } })).balance)).toBe(1000);
    });
  });

  it('a hold does not newly deny elapsed PAST_DUE but a durable suspension blocks both roles', async () => {
    const f = await legacy('paid');
    await sys(() => app.prisma.subscription.update({ where: { id: f.rider.id }, data: { status: 'PAST_DUE', gracePeriodEnd: new Date(Date.now() - DAY) } }));
    for (const role of ['rider', 'driver']) expect((await call(f.token, 'POST', `${role}/go-online`, { latitude: 6.8, longitude: -58.15 })).statusCode).toBe(200);
    await sys(() => app.prisma.subscription.update({ where: { id: f.rider.id }, data: { status: 'SUSPENDED', suspendedAt: new Date() } }));
    for (const role of ['rider', 'driver']) {
      const denied = await call(f.token, 'POST', `${role}/go-online`, { latitude: 6.8, longitude: -58.15 });
      expect([400, 403]).toContain(denied.statusCode);
      expect(denied.json().error.code).toMatch(/^SUBSCRIPTION_/);
    }
  });
});

describe('bounded finance decision with original money retained', () => {
  it('the real application database role sees only its tenant authority and cannot smuggle a foreign source', async () => {
    const tenant = await sys(() => app.prisma.tenant.create({ data: { name: 'Fee SQL tenant', slug: `fee-sql-${run}`, kind: 'REVIEW' } }));
    tenantIds.push(tenant.id);
    const a = await legacy('empty');
    const b = await legacy('empty', tenant.id);
    const visible = (tenantId: string) => sys(() => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      const authorities = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM mover_fee_authorities WHERE "userId" IN (${a.userId}, ${b.userId})`;
      const members = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM mover_fee_subscriptions WHERE "userId" IN (${a.userId}, ${b.userId})`;
      return { authorities, members };
    }));
    expect(await visible(a.tenantId)).toEqual({ authorities: [{ userId: a.userId }], members: [{ userId: a.userId }, { userId: a.userId }] });
    expect(await visible(b.tenantId)).toEqual({ authorities: [{ userId: b.userId }], members: [{ userId: b.userId }, { userId: b.userId }] });
    expect(await visible('')).toEqual({ authorities: [], members: [] });
    await expect(sys(() => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      await tx.$executeRaw`UPDATE mover_fee_authorities SET "tenantId"=${b.tenantId} WHERE "userId"=${a.userId}`;
    }))).rejects.toThrow();
    const foreign = await dual();
    const foreignSource = await sys(() => app.prisma.subscription.create({ data: { riderId: foreign.riderId, type: 'DELIVERY_RIDER', weeklyRate: 6000,
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + DAY), nextBillingDate: new Date(Date.now() + DAY) } }));
    await expect(sys(() => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      await tx.$executeRaw`INSERT INTO mover_fee_subscriptions ("subscriptionId", "userId", "tenantId") VALUES (${foreignSource.id}, ${a.userId}, ${a.tenantId})`;
    }))).rejects.toThrow(/same-payer|exact authority/);
    expect((await sys(() => resolveMoverFeeAuthority(app.prisma, a)))?.sourceSubscriptionIds).toEqual(a.authority.sourceSubscriptionIds);
  });

  it('an accrued clock prevents raw whole-payer deletion and preserves the original authority and history', async () => {
    const retained = await legacy('empty', 'swift-default', 9);
    await sys(async () => {
      const clock = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { moverPayerUserId: retained.userId } });
      const authority = await app.prisma.moverFeeAuthority.findUniqueOrThrow({ where: { userId: retained.userId }, include: { members: true, decision: true } });
      const sources = await app.prisma.subscription.findMany({ where: { id: { in: retained.authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' } });
      expect(clock.epoch).toBe(1);
      expect(activeOverdueMs(clock, new Date())).toBeGreaterThanOrEqual(48 * 3_600_000);
      expect(await app.prisma.paymentConfirmationHold.count({ where: { clockId: clock.id } })).toBe(0);
      expect(await app.prisma.billingFeeNotice.count({ where: { clockId: clock.id } })).toBe(0);
      await expect(app.prisma.user.delete({ where: { id: retained.userId } })).rejects.toThrow(/foreign key constraint/i);
      expect(await app.prisma.user.count({ where: { id: retained.userId } })).toBe(1);
      expect(await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { id: clock.id } })).toEqual(clock);
      expect(await app.prisma.moverFeeAuthority.findUniqueOrThrow({ where: { userId: retained.userId }, include: { members: true, decision: true } })).toEqual(authority);
      expect(await app.prisma.subscription.findMany({ where: { id: { in: retained.authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' } })).toEqual(sources);
    });
  });

  it('a retained pre-clock orphan stays outside trial conversion and cannot mint billing authority', async () => {
    const old = await dual();
    await sys(async () => {
      const start = new Date(Date.now() - 9 * DAY);
      const end = new Date(start.getTime() + 7 * DAY);
      const source = await app.prisma.subscription.create({ data: { riderId: old.riderId, type: 'DELIVERY_RIDER',
        status: 'TRIAL', isTrialActive: true, weeklyRate: 6000, currentPeriodStart: start,
        currentPeriodEnd: end, nextBillingDate: end, trialEndDate: end } });
      orphanSubscriptionIds.push(source.id);
      expect(await app.prisma.billingDunningClock.count({ where: { subscriptionId: source.id } })).toBe(0);
      await app.prisma.user.delete({ where: { id: old.userId } });
      await expect(app.prisma.$transaction((tx) => currentDunningClock(tx, source.id))).rejects.toThrow(/ownership check/);
      await subscriptions.convertExpiredTrials();
      expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: source.id } })).status).toBe('TRIAL');
      expect(await app.prisma.billingDunningClock.count({ where: { subscriptionId: source.id } })).toBe(0);
    });
  });

  it('a clean legacy pair converts, pays once at 8,000 and resumes both roles without inventing an alias stop', async () => {
    const f = await legacy('empty', 'swift-default', 9);
    await sys(async () => {
      await subscriptions.startTrialForDriver(f.driverId);
      await subscriptions.convertExpiredTrials();
      await billing.recordTopUp(f.driver.id, 20_000, finance.userId, 'test-canonical-credit', `fee-convert-${run}-${f.driver.id}`);
      expect(await billing.billSubscription(await ready(f.driver))).toBe('succeeded');
      const captures = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds }, status: 'CAPTURED' } });
      expect(captures).toHaveLength(1);
      expect(Number(captures[0]!.amount)).toBe(8000);
      expect(captures[0]!.subscriptionId).toBe(f.driver.id);
      expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: f.driver.id } })).balance)).toBe(12000);
      const stats = await platformStats(app.prisma, { tenantId: f.tenantId, today: new Date(), subscriptionScope: { id: { in: f.authority.sourceSubscriptionIds } } });
      expect(stats.activeSubscriptions).toHaveLength(1);
      expect(stats.activeSubscriptions[0]).toMatchObject({ id: f.driver.id, type: 'TAXI_DRIVER' });
    });
    await grantStepUp(app, f.token);
    expect((await call(f.token, 'PUT', 'driver/subscription/billing-method', { method: 'NONE' })).statusCode).toBe(200);
    expect((await call(f.token, 'PUT', 'rider/subscription/billing-method', { method: 'CASH' })).statusCode).toBe(200);
    expect((await sys(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: f.rider.id } }))).autoRenew).toBe(true);
    for (const role of ['rider', 'driver']) expect((await call(f.token, 'POST', `${role}/go-online`, { latitude: 6.8, longitude: -58.15 })).statusCode).toBe(200);
  });

  it('neutral FX disclosure uses the activated taxi tariff on an original delivery subscription', async () => {
    const f = await dual();
    await sys(async () => {
      const original = await subscriptions.startTrialForRider(f.riderId);
      await subscriptions.startTrialForDriver(f.driverId);
      await app.prisma.billingEvent.create({ data: { subscriptionId: original.id, type: 'CHARGE_SUCCESS', amount: 6000, currencyCode: 'GYD', idempotencyKey: `fx-history:${run}:${original.id}` } });
      const rate = await app.prisma.fxRate.create({ data: { quote: 'GYD', rate: 250, source: 'FOUNDER_MANUAL', setByUserId: finance.userId, effectiveFrom: new Date(Date.now() - DAY) } });
      rateIds.push(rate.id);
      const result = await runFxChangeNotices(app.prisma, app.io, new Date(), { subscriptionIds: [original.id], rateIds: [rate.id],
        tenant: { usdPricingEnabled: true, settlementCurrency: 'GYD', roundingIncrement: 100 }, book: new Map([['RIDER|DELIVERY_RIDER', 25], ['DRIVER|TAXI_DRIVER', 40]]) });
      expect(result.notified).toBe(1);
      const notice = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: `fxnotice:${original.id}:${rate.id}` } });
      expect(Number(notice.amountUsd)).toBe(40);
      expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: original.id } })).type).toBe('DELIVERY_RIDER');
    });
  });

  it('clean identical trials consolidate with immutable membership and one canonical worker', async () => {
    const f = await legacy('empty');
    expect(f.authority.state).toBe('ACTIVE');
    expect(f.authority.sourceSubscriptionIds).toHaveLength(2);
    const read = await sys(() => resolveMoverFeeAuthority(app.prisma, f));
    expect(read).toEqual(f.authority);
    expect(await sys(async () => billing.billSubscription(await ready(f.rider)))).toBe('skipped');
  });

  it('a canonical switch to exact broader paid coverage advances the one stable obligation through its typed proof', async () => {
    const f = await legacy('paid');
    const before = await sys(() => app.prisma.billingDunningClock.findUniqueOrThrow({ where: { moverPayerUserId: f.userId } }));
    const target = before.subscriptionId === f.driver.id ? f.rider : f.driver;
    const coveredStart = new Date(target.currentPeriodStart.getTime() - DAY);
    const coveredEnd = new Date(target.currentPeriodEnd.getTime() + 7 * DAY);
    const ref = `synthetic-covered:${target.id}`;
    await sys(async () => {
      await app.prisma.subscription.update({ where: { id: target.id }, data: { currentPeriodStart: coveredStart,
        currentPeriodEnd: coveredEnd, nextBillingDate: coveredEnd } });
      await app.prisma.subscriptionPayment.create({ data: { subscriptionId: target.id, amount: Number(target.weeklyRate),
        paymentMethod: 'CASH', status: 'CAPTURED', paidAt: coveredStart, externalRef: ref, periodStart: coveredStart, periodEnd: coveredEnd } });
      await app.prisma.billingEvent.create({ data: { subscriptionId: target.id, type: 'CHARGE_SUCCESS', amount: Number(target.weeklyRate),
        currencyCode: 'GYD', paymentRef: ref, idempotencyKey: `success:${target.id}:${coveredStart.toISOString().slice(0, 10)}` } });
      f.authority = (await app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, f)))!;
    });
    const action = await approvedDecision(f, { ...decisionBody(f), canonicalSubscriptionId: target.id });
    const answer = await action.apply();
    expect(answer.statusCode, answer.body).toBe(200);
    await sys(async () => {
      const clock = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { moverPayerUserId: f.userId } });
      expect(clock).toMatchObject({ id: before.id, subscriptionId: target.id, epoch: before.epoch + 1,
        dueAt: coveredEnd, runningSince: coveredEnd, elapsedMs: 0n, pausedAt: null });
      const transition = await app.prisma.billingObligationTransition.findUniqueOrThrow({ where: { clockId_toEpoch: { clockId: clock.id, toEpoch: clock.epoch } } });
      expect(transition).toMatchObject({ kind: 'PAID', fromSubscriptionId: before.subscriptionId, subscriptionId: target.id,
        fromEpoch: before.epoch, fromDue: before.dueAt, toDue: coveredEnd });
      expect(await app.prisma.billingDunningClock.count({ where: { moverPayerUserId: f.userId } })).toBe(1);
    });
  });

  it.each(['taxi-source', 'delivery-source'] as const)('paid history resolves through two admins onto %s, preserves amounts and periods, and rejects replay', async (choice) => {
    const f = await legacy('paid');
    const beforeClock = await sys(() => app.prisma.billingDunningClock.findUniqueOrThrow({ where: { moverPayerUserId: f.userId } }));
    const canonical = choice === 'taxi-source' ? f.driver : f.rider;
    const alias = choice === 'taxi-source' ? f.rider : f.driver;
    const before = await sys(() => app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' } }));
    const action = await approvedDecision(f, { ...decisionBody(f), canonicalSubscriptionId: canonical.id });
    const response = await action.apply();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ state: 'ACTIVE', revision: f.authority.revision + 1 });
    expect((await action.apply()).statusCode).toBe(403);
    await sys(async () => {
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.state).toBe('ACTIVE');
      expect(await billing.billSubscription(await ready(alias))).toBe('skipped');
      expect(await app.prisma.billingEvent.count({ where: { subscriptionId: alias.id, type: 'CHARGE_ATTEMPT' } })).toBe(0);
      expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: canonical.id } })).weeklyRate)).toBe(8000);
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.canonicalSubscriptionId).toBe(canonical.id);
      const clock = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { moverPayerUserId: f.userId } });
      expect(clock.id).toBe(beforeClock.id); expect(clock.epoch).toBe(beforeClock.epoch);
      expect(clock.elapsedMs).toBe(beforeClock.elapsedMs); expect(clock.subscriptionId).toBe(canonical.id);
      expect(await app.prisma.billingDunningClock.count({ where: { moverPayerUserId: f.userId } })).toBe(1);
      expect(await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' } })).toEqual(before);
      const original = await app.prisma.subscription.findUniqueOrThrow({ where: { id: f.rider.id } });
      expect(original.currentPeriodEnd).toEqual(f.rider.currentPeriodEnd);
      expect(original.type).toBe('DELIVERY_RIDER');
      const audit = await app.prisma.auditLog.findFirstOrThrow({ where: { entity: 'MoverFeeAuthority', entityId: f.userId, action: 'MOVER_FEE_RESOLVED' } });
      expect(audit.userId).toBe(finance.userId);
      expect(audit.changes).toMatchObject({ approvalId: action.approvalId, futureRate: { before: Number(canonical.weeklyRate), after: 8000 }, aliasEvidence: { [alias.id]: expect.stringMatching(/^[a-f0-9]{64}$/) },
        sourceEvidence: { [f.rider.id]: expect.stringMatching(/^[a-f0-9]{64}$/), [f.driver.id]: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      // Refused by the append-only trigger. Raw SQL, as audit-append-only.test.ts does: only the purge helper names an audit write.
      await expect(app.prisma.$executeRaw`UPDATE audit_logs SET action = 'changed' WHERE id = ${audit.id}`).rejects.toThrow(/append-only/);
    });
  });

  it.each(['pending', 'funded', 'restricted'] as const)('%s source remains held after an approved request and retains original money', async (kind) => {
    const f = await legacy(kind);
    const action = await approvedDecision(f);
    const response = await action.apply();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('MOVER_FEE_FINANCE_ACTION_REQUIRED');
    expect((await sys(() => resolveMoverFeeAuthority(app.prisma, f)))?.state).toBe('FINANCE_HOLD');
  });

  it('derived timer projection preserves finance acknowledgment, while a new manual stop re-holds', async () => {
    const f = await legacy('paid'); const action = await approvedDecision(f);
    const resolved = await action.apply(); expect(resolved.statusCode, resolved.body).toBe(200);
    await sys(async () => {
      await app.prisma.subscription.update({ where: { id: f.rider.id }, data: { nextRetryAt: new Date(), gracePeriodEnd: new Date() } });
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.state).toBe('ACTIVE');
      await app.prisma.$transaction(async (tx) => {
        const clock = await currentDunningClock(tx, f.driver.id);
        await projectDunningClock(tx, clock, new Date());
      });
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.state).toBe('ACTIVE');
      await app.prisma.subscription.update({ where: { id: f.rider.id }, data: { autoRenew: false } });
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.state).toBe('FINANCE_HOLD');
    });
  });

  it('a capture without exact paid-period success evidence cannot retire an old obligation', async () => {
    const f = await legacy('paid');
    await sys(() => app.prisma.billingEvent.deleteMany({ where: { subscriptionId: f.rider.id, type: 'CHARGE_SUCCESS' } }));
    const action = await approvedDecision(f);
    const response = await action.apply();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.details.reason).toBe('PAID_PERIOD_PROOF_REQUIRED');
    expect((await sys(() => resolveMoverFeeAuthority(app.prisma, f)))?.state).toBe('FINANCE_HOLD');
  });

  it('refuses a previously approved decision after the independent approver loses finance authority', async () => {
    const f = await legacy('paid');
    const action = await approvedDecision(f);
    await sys(() => app.prisma.admin.update({ where: { userId: approver.userId }, data: { permissions: ['support.*'] } }));
    try {
      const response = await action.apply();
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('MOVER_FEE_APPROVAL_REQUIRED');
    } finally {
      await sys(() => app.prisma.admin.update({ where: { userId: approver.userId }, data: { permissions: ['*'] } }));
    }
  });

  it('a later real alias top-up preserves its source, re-holds and stops a waiting canonical bill', async () => {
    const f = await legacy('paid');
    const action = await approvedDecision(f);
    expect((await action.apply()).statusCode).toBe(200);
    await sys(() => billing.recordTopUp(f.rider.id, 50, finance.userId, 'test-source-credit', `fee-alias-${run}-${f.rider.id}`));
    await sys(async () => {
      const held = await resolveMoverFeeAuthority(app.prisma, f);
      expect(held).toMatchObject({ state: 'FINANCE_HOLD', holdReason: 'HISTORICAL_SOURCE_MONEY' });
      expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: f.rider.id } })).balance)).toBe(50);
      expect(await app.prisma.prepaidBalance.findUnique({ where: { subscriptionId: f.driver.id } })).toBeNull();
      expect(await billing.billSubscription(await ready(f.driver))).toBe('skipped');
    });
  });

  it('serializes a waiting canonical bill after an original-source credit commits', async () => {
    const f = await legacy('paid');
    const action = await approvedDecision(f);
    expect((await action.apply()).statusCode).toBe(200);
    await sys(async () => {
      const before = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds } } });
      let release!: () => void;
      let held!: (pid: number) => void;
      const creditGate = new Promise<void>((resolve) => { release = resolve; });
      const locked = new Promise<number>((resolve) => { held = resolve; });
      const credit = app.prisma.$transaction(async (tx) => {
        await billing.recordTopUpInTransaction(tx, { subscriptionId: f.rider.id, amount: 75,
          recordedBy: finance.userId, eventKey: `fee-race:${run}:${f.rider.id}` });
        const holder = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        held(holder[0]!.pid);
        await creditGate;
      }, { timeout: 15_000 });
      const pid = await locked;
      const bill = billing.billSubscription(await ready(f.driver));
      try {
        await expect.poll(async () => {
          const waiters = await app.prisma.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
          `;
          return waiters[0]!.waiting;
        }, { timeout: 3000, interval: 20 }).toBe(true);
      } finally { release(); }
      await credit;
      expect(await bill).toBe('skipped');
      expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds } } })).toBe(before);
      expect(await app.prisma.billingEvent.count({ where: { subscriptionId: f.driver.id, type: 'CHARGE_ATTEMPT' } })).toBe(0);
      expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: f.rider.id } })).balance)).toBe(75);
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.state).toBe('FINANCE_HOLD');
    });
  });

  it('denies a stale approved revision, a support-only admin and another tenant', async () => {
    const f = await legacy('paid');
    const stale = await approvedDecision(f, { ...decisionBody(f), expectedRevision: f.authority.revision + 1 });
    expect((await stale.apply()).statusCode).toBe(409);
    const support = await person('SUPER_ADMIN', 'swift-default', ['support.*']);
    expect((await call(support.token, 'POST', stale.path, decisionBody(f))).statusCode).toBe(403);
    const tenant = await sys(() => app.prisma.tenant.create({ data: { name: 'Fee test tenant', slug: `fee-${run}`, kind: 'REVIEW' } }));
    tenantIds.push(tenant.id);
    const other = await person('SUPER_ADMIN', tenant.id);
    // The established admin entity guard conceals out-of-tenant subjects as gone.
    expect((await call(other.token, 'GET', `admin/billing/mover-fees/${f.userId}`)).statusCode).toBe(410);
    const summary = await call(finance.token, 'GET', 'admin/billing/mover-fees');
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().data.some((r: { userId: string }) => r.userId === f.userId)).toBe(true);
  });
});
