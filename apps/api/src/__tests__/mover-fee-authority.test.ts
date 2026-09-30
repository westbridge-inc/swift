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

const DAY = 86_400_000;
const run = nanoid(7);
const ids: string[] = [];
const tenantIds: string[] = [];
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

async function legacy(kind: 'empty' | 'paid' | 'pending' | 'funded' | 'restricted' = 'paid', tenantId = 'swift-default') {
  const who = await dual(tenantId);
  return sys(async () => {
    const start = new Date(Date.now() - DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    const base = { currencyCode: 'GYD', currentPeriodStart: start, currentPeriodEnd: end, nextBillingDate: end,
      status: kind === 'empty' ? 'TRIAL' as const : 'ACTIVE' as const,
      isTrialActive: kind === 'empty', trialEndDate: kind === 'empty' ? end : null };
    const rider = await app.prisma.subscription.create({ data: { ...base, riderId: who.riderId, type: 'DELIVERY_RIDER', weeklyRate: 6000 } });
    const driver = await app.prisma.subscription.create({ data: { ...base, driverId: who.driverId, type: 'TAXI_DRIVER', weeklyRate: 9000 } });
    if (kind !== 'empty') for (const sub of [rider, driver]) {
      await app.prisma.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: Number(sub.weeklyRate), paymentMethod: 'CASH', status: 'CAPTURED', paidAt: start, periodStart: start, periodEnd: end } });
      await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: Number(sub.weeklyRate), currencyCode: 'GYD', idempotencyKey: `legacy-proof:${sub.id}`, note: 'Synthetic historical paid period' } });
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
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: ids } } });
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] }, 'test-mover-fee-authority-cleanup');
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
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
  it('clean identical trials consolidate with immutable membership and one canonical worker', async () => {
    const f = await legacy('empty');
    expect(f.authority.state).toBe('ACTIVE');
    expect(f.authority.sourceSubscriptionIds).toHaveLength(2);
    const read = await sys(() => resolveMoverFeeAuthority(app.prisma, f));
    expect(read).toEqual(f.authority);
    expect(await sys(async () => billing.billSubscription(await ready(f.rider)))).toBe('skipped');
  });

  it('paid history resolves through two admins, preserves amounts and periods, and rejects replay', async () => {
    const f = await legacy('paid');
    const before = await sys(() => app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' } }));
    const action = await approvedDecision(f);
    const response = await action.apply();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ state: 'ACTIVE', revision: f.authority.revision + 1 });
    expect((await action.apply()).statusCode).toBe(403);
    await sys(async () => {
      expect((await resolveMoverFeeAuthority(app.prisma, f))?.state).toBe('ACTIVE');
      expect(await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: f.authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' } })).toEqual(before);
      const original = await app.prisma.subscription.findUniqueOrThrow({ where: { id: f.rider.id } });
      expect(original.currentPeriodEnd).toEqual(f.rider.currentPeriodEnd);
      expect(original.type).toBe('DELIVERY_RIDER');
      const audit = await app.prisma.auditLog.findFirstOrThrow({ where: { entity: 'MoverFeeAuthority', entityId: f.userId, action: 'MOVER_FEE_RESOLVED' } });
      expect(audit.userId).toBe(finance.userId);
      expect(audit.changes).toMatchObject({ approvalId: action.approvalId, aliasEvidence: { [f.rider.id]: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      await expect(app.prisma.auditLog.update({ where: { id: audit.id }, data: { action: 'changed' } })).rejects.toThrow();
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
