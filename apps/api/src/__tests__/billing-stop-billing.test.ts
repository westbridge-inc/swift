import { grantStepUp } from './helpers/step-up';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { BillingService, CARD_PAY_NOW_KEY_PREFIX } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { subscriptionOperability } from '../modules/subscription/operate-gate';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';
import { currentDunningClock, readDunningClock, resolveConfirmationInTx } from '../modules/billing/dunning-clock';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { sandboxSetTxStatus } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// E12 (ledger S1) — the partner's self-serve stop/resume of the weekly fee.
// method NONE stops billing (rail preserved, debt preserved); CASH/MOBILE_MONEY
// resumes. The stopped subscription is never charged, never reminded, lapses
// at its paid period end, and a late MMG approval is banked — not a renewal.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// [SAFE-B · retained history] Choosing the MMG rail records an advisory payer
// declaration: immutable evidence naming its subscription and account, kept
// after the suite. The fixtures therefore live in a phone namespace no other
// suite uses or purges, unique to the run.
const PHONE_PREFIX = retainedPhonePrefix('25');

let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole, who: 'rider' | 'driver' | 'customer') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Stop',
      lastName: `${who}${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: `e12-${who}-${seq}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeRiderSub(opts: {
  due: Date;
  autoRenew?: boolean;
  status?: SubscriptionStatus;
  prepaid?: number;
  msisdn?: string;
  failedAttempts?: number;
  nextRetryAt?: Date | null;
  periodEnd?: Date;
  /** [#1393] The current period was paid: its captured payment and success record exist. */
  paid?: boolean;
}) {
  const { userId, token } = await makeUser(['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER', 'rider');
  const rider = await app.prisma.rider.create({
    data: {
      userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      locationSessionId: syntheticLocationOwner('e12-stop-billing'),
    },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: opts.status ?? 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: opts.msisdn ? 'MOBILE_MONEY' : 'CASH',
      mmgPayerMsisdn: opts.msisdn ?? null,
      autoRenew: opts.autoRenew ?? true,
      failedAttempts: opts.failedAttempts ?? 0,
      nextRetryAt: opts.nextRetryAt === undefined ? null : opts.nextRetryAt,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK),
      currentPeriodEnd: opts.periodEnd ?? opts.due,
      nextBillingDate: opts.due,
      ...(opts.prepaid !== undefined
        ? { prepaidBalance: { create: { balance: opts.prepaid, currencyCode: 'GYD' } } }
        : {}),
    },
  });
  subIds.push(sub.id);
  if (opts.paid) await settlePeriod(sub.id, sub.currentPeriodStart, sub.currentPeriodEnd, 12000);
  return { userId, riderId: rider.id, subId: sub.id, httpToken: token };
}

/** [#1393] A paid week as the billing engine records one: its captured
 *  payment and matching success record. A stopped plan pauses at its period
 *  end only on this exact settled coverage; a date alone never erases a fee. */
async function settlePeriod(subId: string, start: Date, end: Date, amount: number) {
  const paymentRef = `e12-paid:${subId}:${start.toISOString()}`;
  await app.prisma.subscriptionPayment.create({ data: { subscriptionId: subId, amount, paymentMethod: 'CASH', status: 'CAPTURED',
    periodStart: start, periodEnd: end, paidAt: start, externalRef: paymentRef } });
  await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_SUCCESS', amount, currencyCode: 'GYD',
    paymentRef, idempotencyKey: `success:${subId}:${start.toISOString().slice(0, 10)}` } });
}

/** Payments the billing engine made, leaving out a fixture's settled week. */
const enginePayments = (subId: string) => app.prisma.subscriptionPayment.findMany({
  where: { subscriptionId: subId, NOT: { externalRef: { startsWith: 'e12-paid:' } } }, orderBy: { createdAt: 'asc' },
});

async function makeDriverSub(opts: { due: Date; autoRenew?: boolean; status?: SubscriptionStatus }) {
  const { userId, token } = await makeUser(['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER', 'driver');
  const driver = await app.prisma.driver.create({
    data: {
      userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2021,
      vehicleColor: 'Silver',
      licensePlate: `E12-${seq}`,
      rideClass: 'ECONOMY',
      documentsVerified: true,
      driverLicenseUrl: 'storage://e12/dl.jpg',
      vehicleInsuranceUrl: 'storage://e12/ins.jpg',
    },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      driverId: driver.id,
      type: 'TAXI_DRIVER',
      status: opts.status ?? 'ACTIVE',
      weeklyRate: 20000,
      billingMethod: 'CASH',
      autoRenew: opts.autoRenew ?? true,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
    },
  });
  subIds.push(sub.id);
  return { userId, driverId: driver.id, subId: sub.id, httpToken: token };
}

async function subWithRelations(subId: string) {
  return app.prisma.subscription.findUniqueOrThrow({
    where: { id: subId },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { id: true, owner: { select: { userId: true } } } },
    },
  });
}

const putMethod = async (url: string, token: string, method: 'CASH' | 'MOBILE_MONEY' | 'NONE', msisdn?: string) => {
  await grantStepUp(app, token);
  return app.inject({
    method: 'PUT',
    url,
    payload: { method, ...(msisdn ? { mmgPayerMsisdn: msisdn } : {}) },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // sandbox

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  await purgeBlock(); // crash recovery: a failed earlier run left this block behind
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

/** Everything this file's phone block owns. Run before the suite too, so a
 *  crashed earlier run cannot leave phones behind that the next run collides
 *  on. Audit rows are append-only: they go through the sanctioned purge. */
async function purgeBlock() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const subs = await app.prisma.subscription.findMany({
    where: { OR: [{ rider: { userId: { in: ids } } }, { driver: { userId: { in: ids } } }] },
    select: { id: true },
  });
  const allSids = subs.map((sub) => sub.id);
  // [SAFE-B · retained history] A subscription an MMG payer declaration names
  // is kept with its money records and mover; the rest goes as before, in one
  // transaction, and what stays is taken out of service.
  const { sids, gone } = await app.prisma.$transaction(async (tx) => {
    const kept = await retainedCohort(tx, { subscriptionIds: allSids });
    const sids = without(allSids, kept.subscriptionIds);
    const gone = without(ids, kept.userIds);
    await cleanupBillingClocks(tx, allSids);
    await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
    await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: sids } } });
    await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: sids } } });
    // A mover payer's fee authority and its member rows go with the payer, before its subscriptions.
    await tx.user.deleteMany({ where: { id: { in: gone } } });
    await tx.subscription.deleteMany({ where: { id: { in: sids } } });
    await tx.notification.deleteMany({ where: { userId: { in: ids } } });
    await tx.rider.deleteMany({ where: { userId: { in: gone } } });
    await tx.driver.deleteMany({ where: { userId: { in: gone } } });
    await tx.session.deleteMany({ where: { userId: { in: ids } } });
    await tx.user.deleteMany({ where: { id: { in: gone } } });
    await retireKeptScaffolding(tx, kept);
    return { sids, gone };
  }, { timeout: 60_000 });
  // Audit rows are append-only: what goes, goes through the sanctioned purge.
  await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...sids, ...gone] } }, { userId: { in: gone } }] }, 'test-cleanup:e12-stop-billing');
}

afterAll(async () => {
  await purgeBlock();
  await app.close();
});

describe('E12 — stop weekly billing (rider route)', () => {
  it('stops billing, preserves the rail, writes exactly one stop event + audit row, and a double-stop changes nothing', async () => {
    const { subId, httpToken } = await makeRiderSub({ due: new Date(Date.now() + 3 * DAY), msisdn: '6099991' });

    const stop = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'NONE');
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().data).toEqual({ billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '6099991' });

    let after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after).toMatchObject({ autoRenew: false, nextRetryAt: null, billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '6099991' });

    const again = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'NONE');
    expect(again.statusCode, again.body).toBe(200);

    after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after).toMatchObject({ autoRenew: false, nextRetryAt: null });

    const stopEvents = await app.prisma.billingEvent.findMany({
      where: { subscriptionId: subId, idempotencyKey: { startsWith: `stop:${subId}:` } },
    });
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0]).toMatchObject({ type: 'TIER_CHANGE', note: 'Weekly billing stopped by the partner' });
    expect(await app.prisma.auditLog.count({ where: { entityId: subId, action: 'BILLING_STOPPED' } })).toBe(1);

    // Resume re-arms billing on the chosen rail (and a stop → resume → stop
    // sequence writes one stop event per episode, not a collision).
    const resume = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'CASH');
    expect(resume.statusCode, resume.body).toBe(200);
    expect(resume.json().data).toEqual({ billingMethod: 'CASH', mmgPayerMsisdn: null });
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).autoRenew).toBe(true);
    const stopAgain = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'NONE');
    expect(stopAgain.statusCode, stopAgain.body).toBe(200);
    expect(await app.prisma.billingEvent.count({
      where: { subscriptionId: subId, idempotencyKey: { startsWith: `stop:${subId}:` } },
    })).toBe(2);
  });

  it('refuses a customer and never lets another mover touch this subscription', async () => {
    const owner = await makeRiderSub({ due: new Date(Date.now() + 3 * DAY) });
    const other = await makeRiderSub({ due: new Date(Date.now() + 3 * DAY) });
    const customer = await makeUser(['CUSTOMER'] as UserRole[], 'CUSTOMER', 'customer');

    const refused = await putMethod('/api/v1/rider/subscription/billing-method', customer.token, 'NONE');
    expect(refused.statusCode).toBe(403);

    // The other rider's call resolves THEIR OWN subscription; the target row
    // is unreachable by the route's shape (no subscription id in the URL).
    const theirs = await putMethod('/api/v1/rider/subscription/billing-method', other.httpToken, 'NONE');
    expect(theirs.statusCode).toBe(200);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: owner.subId } })).autoRenew).toBe(true);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: other.subId } })).autoRenew).toBe(false);

    // A rider is an insider mover with no driver profile yet → the driver
    // route answers 404, never 200, never touching a driver row.
    const asDriver = await putMethod('/api/v1/driver/subscription/billing-method', owner.httpToken, 'NONE');
    expect(asDriver.statusCode).toBe(404);
  });

  it('GET /subscription exposes autoRenew so the app can show the state', async () => {
    const { subId, httpToken } = await makeRiderSub({ due: new Date(Date.now() + 3 * DAY) });
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/rider/subscription',
      headers: { authorization: `Bearer ${httpToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.autoRenew).toBe(true);
    expect(get.json().data.id).toBe(subId);
  });
});

describe('E12 — stop/resume for the driver', () => {
  it('driver stops, MMG resume without a number is refused, CASH resume re-arms autoRenew', async () => {
    const { subId, httpToken } = await makeDriverSub({ due: new Date(Date.now() + 3 * DAY) });

    const stop = await putMethod('/api/v1/driver/subscription/billing-method', httpToken, 'NONE');
    expect(stop.statusCode, stop.body).toBe(200);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).autoRenew).toBe(false);

    const noMsisdn = await putMethod('/api/v1/driver/subscription/billing-method', httpToken, 'MOBILE_MONEY');
    expect(noMsisdn.statusCode).toBe(400);
    expect(noMsisdn.json().error.code).toBe('MSISDN_REQUIRED');
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).autoRenew).toBe(false);

    const resume = await putMethod('/api/v1/driver/subscription/billing-method', httpToken, 'CASH');
    expect(resume.statusCode, resume.body).toBe(200);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).autoRenew).toBe(true);

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/subscription',
      headers: { authorization: `Bearer ${httpToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.autoRenew).toBe(true);
  });

  it('a CANCELLED (wound-down/closed) subscription: resume is refused 409, and so is a stop (DS198 D5)', async () => {
    const { subId, httpToken } = await makeDriverSub({ due: new Date(Date.now() - 60_000), autoRenew: false });
    await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'CANCELLED' } });
    const resume = await putMethod('/api/v1/driver/subscription/billing-method', httpToken, 'CASH');
    expect(resume.statusCode).toBe(409);
    expect(resume.json().error.code).toBe('SUBSCRIPTION_CLOSED');
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).autoRenew).toBe(false);
    // a stop on a closed row is not a silent 200 no-op either
    const stop = await putMethod('/api/v1/driver/subscription/billing-method', httpToken, 'NONE');
    expect(stop.statusCode).toBe(409);
    expect(stop.json().error.code).toBe('SUBSCRIPTION_CLOSED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
  });
});

describe('E12 — the stopped subscription and the billing engine', () => {
  it('runBillingCycle bills the control but creates no charge or event for the stopped row', async () => {
    const due = new Date(Date.now() - 60 * 60 * 1000);
    // A due week with a future period end (the post-trial-conversion shape):
    // the paid period has not run out, so no lapse sweep may touch the row
    // while this test asserts the cycle's behaviour on it.
    const periodEnd = new Date(Date.now() + 3 * DAY);
    const stopped = await makeRiderSub({ due, autoRenew: false, prepaid: 12000, periodEnd });
    const control = await makeRiderSub({ due, prepaid: 12000, periodEnd });

    await billing.runBillingCycle(new Date());
    // No aggregate assertion: other files' cycles share the database and may
    // bill this control first. The per-row facts below are the proof — a
    // stopped row is never billed, an identical auto-renewing row is billed
    // exactly once (the success event key makes that single-winner).

    const stoppedRow = await app.prisma.subscription.findUniqueOrThrow({ where: { id: stopped.subId } });
    expect(stoppedRow.status).toBe('ACTIVE'); // the cycle does not lapse — the lapse sweep does
    expect(stoppedRow.nextBillingDate.getTime()).toBe(due.getTime());
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: stopped.subId } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: stopped.subId } })).toBe(0);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: stopped.subId } })).balance)).toBe(12000);

    // The NOT-stopped control proves the test cannot pass vacuously.
    const controlRow = await app.prisma.subscription.findUniqueOrThrow({ where: { id: control.subId } });
    expect(controlRow.nextBillingDate.getTime()).toBe(due.getTime() + WEEK);
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: control.subId } })).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: control.subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
  });

  it('the advance-notice job skips the stopped row and reminds the identical control', async () => {
    const due = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const stopped = await makeRiderSub({ due, autoRenew: false });
    const control = await makeRiderSub({ due });

    await billing.sendUpcomingReminders();
    expect(await app.prisma.billingEvent.count({
      where: { subscriptionId: stopped.subId, type: 'REMINDER', idempotencyKey: { startsWith: 'reminder:' } },
    })).toBe(0);
    expect(await app.prisma.billingEvent.count({
      where: { subscriptionId: control.subId, type: 'REMINDER', idempotencyKey: { startsWith: 'reminder:' } },
    })).toBe(1);
  });

  it('pauses an ACTIVE stopped row exactly at its period end — and only that row; the gate refuses work before the sweep runs', async () => {
    const now = new Date();
    const lapsed = await makeRiderSub({ due: new Date(now.getTime() - 60 * 60 * 1000), autoRenew: false, paid: true });
    const stillBilling = await makeRiderSub({ due: new Date(now.getTime() - 60 * 60 * 1000) });
    const notYet = await makeRiderSub({ due: new Date(now.getTime() + 60 * 60 * 1000), autoRenew: false, paid: true });

    // [DS198 D2] The paid period is over: the gate refuses work NOW, not an
    // hour later when the billing job's sweep runs.
    const before = await app.prisma.subscription.findUniqueOrThrow({ where: { id: lapsed.subId } });
    expect(subscriptionOperability(before, { missingRow: 'BLOCK' }, now)).toEqual({ operable: false, why: 'BILLING_STOPPED', status: 'ACTIVE' });
    // …while a stopped row still inside its paid period keeps working
    const notYetRow = await app.prisma.subscription.findUniqueOrThrow({ where: { id: notYet.subId } });
    expect(subscriptionOperability(notYetRow, { missingRow: 'BLOCK' }, now)).toEqual({ operable: true });

    await billing.lapseStoppedSubscriptions(now);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: lapsed.subId } });
    expect(after).toMatchObject({ status: 'PAUSED', autoRenew: false, nextRetryAt: null, isInGracePeriod: false, gracePeriodEnd: null });
    expect(subscriptionOperability(after, { missingRow: 'BLOCK' }, now)).toEqual({ operable: false, why: 'STATUS', status: 'PAUSED' });
    // one pause event per paid period, and a second sweep adds none
    await billing.lapseStoppedSubscriptions(now);
    const pauseEvents = await app.prisma.billingEvent.findMany({ where: { subscriptionId: lapsed.subId, idempotencyKey: { startsWith: 'pause:' } } });
    expect(pauseEvents).toHaveLength(1);
    expect(pauseEvents[0]!.note).toMatch(/weekly billing was stopped/);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: stillBilling.subId } })).status).toBe('ACTIVE');
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: notYet.subId } })).status).toBe('ACTIVE');
  });

  it('a PAUSED plan resumes self-serve and is charged AT the resume — one week from then, and the next cycle bills nothing more (DS207 F2)', async () => {
    const now = new Date();
    const stopped = await makeRiderSub({ due: new Date(now.getTime() - 2 * DAY), autoRenew: false, prepaid: 12000, paid: true });
    await billing.lapseStoppedSubscriptions(now);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: stopped.subId } })).status).toBe('PAUSED');

    const resumedAt = Date.now();
    const resume = await putMethod('/api/v1/rider/subscription/billing-method', stopped.httpToken, 'CASH');
    expect(resume.statusCode, resume.body).toBe(200);

    // Charged by the resume itself, not an hour later by the cycle: there is
    // no unpaid window in which to work and stop again. The paused weeks are
    // never charged — the one week starts at the resume.
    const payments = await enginePayments(stopped.subId);
    expect(payments).toHaveLength(1);
    const start = payments[0]!.periodStart.getTime();
    expect(start).toBeGreaterThanOrEqual(resumedAt - 1000);
    expect(start).toBeLessThanOrEqual(Date.now() + 1000);
    const row = await app.prisma.subscription.findUniqueOrThrow({ where: { id: stopped.subId } });
    expect({ status: row.status, autoRenew: row.autoRenew }).toEqual({ status: 'ACTIVE', autoRenew: true });
    expect(row.currentPeriodStart.getTime()).toBe(start);
    expect(row.nextBillingDate.getTime()).toBe(start + WEEK);
    expect(row.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: stopped.subId } })).balance)).toBe(0);

    // The hourly cycle finds nothing left to bill for this row.
    await billing.runBillingCycle(new Date());
    expect(await enginePayments(stopped.subId)).toHaveLength(1);
  });

  it('the instant charge never bills a week the hourly cycle already took (DS213 F2-1)', async () => {
    // A resumed plan: ACTIVE, auto-renewing, due at the resume instant.
    const due = new Date(Date.now() - 60_000);
    const plan = await makeRiderSub({ due, prepaid: 24000 });
    // The cycle got there first: it charged the resumed week and moved the row a week on.
    await billing.runBillingCycle(new Date());
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: plan.subId } })).toBe(1);
    // Re-reading the row and billing it would take the NEXT week (the attempt
    // key dedupes only within one period). Anchored to the resumed week, the
    // instant charge sees the row has moved on and bills nothing.
    await expect(billing.chargeResumedPlan(plan.subId, due)).resolves.toBe('skipped');
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: plan.subId } })).toBe(1);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: plan.subId } })).balance)).toBe(12000);
  });

  it('the instant charge bills the resumed week when it gets there first, and the cycle then finds nothing due', async () => {
    const due = new Date(Date.now() - 60_000);
    const plan = await makeRiderSub({ due, prepaid: 12000 });
    await expect(billing.chargeResumedPlan(plan.subId, due)).resolves.toBe('succeeded');
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: plan.subId } })).toBe(1);
    await billing.runBillingCycle(new Date());
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: plan.subId } })).toBe(1);
  });

  it('one real charge failure is counted once when a stale run reaches the resume branch (DS219 F2-1R1)', async () => {
    // The resume charge and the hourly cycle race on the same week; both read
    // failedAttempts 0. The winner fails (an empty wallet) and lands the
    // failure; the loser collides on the SAME attempt key and finds the
    // recorded failure. Resuming it at the fresh level would count the one
    // real failure twice (a premature final warning, an early suspension).
    const due = new Date(Date.now() - 60_000);
    const plan = await makeRiderSub({ due, prepaid: 0 });
    const stale = await subWithRelations(plan.subId); // the loser's snapshot, taken before the winner ran
    await expect(billing.billSubscription(await subWithRelations(plan.subId))).resolves.toBe('failed');
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: plan.subId } })).failedAttempts).toBe(1);

    await expect(billing.billSubscription(stale)).resolves.toBe('skipped');
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: plan.subId } })).failedAttempts).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: plan.subId, idempotencyKey: { startsWith: 'failed:' } } })).toBe(1);
  });

  it('a resumed plan whose charge has not landed is never paused debt-free; once its week is paid it can be stopped and paused AGAIN — no event-key collision (DS207 F1)', async () => {
    // [#1393] Real flows only: two stopped plans with a paid week lapse; both
    // resume. One week is charged from the wallet at the resume; the other is
    // an MMG request still waiting on the payer's phone. Both stop again.
    const now = new Date();
    const paid = await makeRiderSub({ due: new Date(now.getTime() - 2 * DAY), autoRenew: false, paid: true, prepaid: 12000 });
    const owing = await makeRiderSub({ due: new Date(now.getTime() - 2 * DAY), autoRenew: false, paid: true });
    await billing.lapseStoppedSubscriptions(now);
    for (const plan of [paid, owing]) expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: plan.subId } })).status).toBe('PAUSED');

    expect((await putMethod('/api/v1/rider/subscription/billing-method', paid.httpToken, 'CASH')).statusCode).toBe(200);
    expect((await putMethod('/api/v1/rider/subscription/billing-method', owing.httpToken, 'MOBILE_MONEY', '6099993')).statusCode).toBe(200);
    const [request] = await enginePayments(owing.subId);
    expect(request).toMatchObject({ status: 'PENDING', paymentMethod: 'MOBILE_MONEY' });
    sandboxSetTxStatus(request!.externalRef!, 'pending'); // not approved on the phone yet
    const [charged] = await enginePayments(paid.subId);
    expect(charged).toMatchObject({ status: 'CAPTURED', externalRef: 'prepaid' });

    for (const plan of [paid, owing]) expect((await putMethod('/api/v1/rider/subscription/billing-method', plan.httpToken, 'NONE')).statusCode).toBe(200);

    // The resumed week ends. Keyed by period (the old key) the second pause of
    // the paid plan collided with the first (P2002), the row stayed ACTIVE and
    // the throw aborted the whole billing job, hourly.
    const weekEnd = (await app.prisma.subscription.findUniqueOrThrow({ where: { id: paid.subId } })).currentPeriodEnd;
    const second = await billing.lapseStoppedSubscriptions(new Date(weekEnd.getTime() + 60_000));
    expect(second.failed).toBe(0);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: paid.subId } })).status).toBe('PAUSED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: paid.subId, idempotencyKey: { startsWith: 'pause:' } } })).toBe(2);
    // The week whose MMG request has not landed is still owed: never a debt-free PAUSED row.
    const stillOwing = await app.prisma.subscription.findUniqueOrThrow({ where: { id: owing.subId } });
    expect({ status: stillOwing.status, autoRenew: stillOwing.autoRenew }).toEqual({ status: 'ACTIVE', autoRenew: false });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: owing.subId, idempotencyKey: { startsWith: 'pause:' } } })).toBe(1);
    expect(await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: request!.id } })).toMatchObject({ status: 'PENDING' });
  });

  it('one row that fails to pause never stops the sweep for the rest (DS207 F1)', async () => {
    const now = new Date();
    const broken = await makeRiderSub({ due: new Date(now.getTime() - DAY), autoRenew: false, paid: true });
    const fine = await makeRiderSub({ due: new Date(now.getTime() - DAY), autoRenew: false, paid: true });
    // Plant the exact event key the broken row's pause will write (one per
    // settled obligation: clock and epoch), so its transaction fails (P2002)
    // and rolls back.
    const row = await app.prisma.subscription.findUniqueOrThrow({ where: { id: broken.subId } });
    const clock = await readDunningClock(app.prisma, broken.subId);
    await app.prisma.billingEvent.create({
      data: { subscriptionId: broken.subId, type: 'TIER_CHANGE', currencyCode: row.currencyCode, idempotencyKey: `pause:${broken.subId}:${clock.id}:${clock.epoch}`, note: 'planted' },
    });

    const sweep = await billing.lapseStoppedSubscriptions(now);
    expect(sweep.paused).toBeGreaterThanOrEqual(1);
    expect(sweep.failed).toBeGreaterThanOrEqual(1); // counted for the billing-failure page (DS213 F1-1)
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: broken.subId } })).status).toBe('ACTIVE'); // rolled back, retried next run
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: fine.subId } })).status).toBe('PAUSED');
  });

  it('a PAST_DUE stop keeps the debt, the balance and the status; resume re-arms and the next cycle pays it off', async () => {
    const { subId, httpToken } = await makeRiderSub({
      due: new Date(Date.now() - 60 * 60 * 1000),
      status: 'PAST_DUE',
      prepaid: 12000,
      failedAttempts: 1,
      nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await app.prisma.subscription.update({
      where: { id: subId },
      data: { isInGracePeriod: true, gracePeriodEnd: new Date(Date.now() + 48 * 60 * 60 * 1000) },
    });

    const stop = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'NONE');
    expect(stop.statusCode).toBe(200);
    let after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after).toMatchObject({
      status: 'PAST_DUE',
      autoRenew: false,
      nextRetryAt: null,
      failedAttempts: 1,
      isInGracePeriod: true,
    });
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(12000);

    // Stopped: no retry, no charge, no new event beyond the stop itself.
    await billing.runBillingCycle(new Date());
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: { in: ['CHARGE_ATTEMPT', 'CHARGE_SUCCESS', 'CHARGE_FAILED'] } } })).toBe(0);

    const resume = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'CASH');
    expect(resume.statusCode, resume.body).toBe(200);
    after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.autoRenew).toBe(true);
    expect(after.status).toBe('PAST_DUE'); // the debt is still owed — nothing was cleared or reinstated
    expect(after.nextRetryAt).not.toBeNull(); // the retry clock is re-armed
    // [#1393] Re-armed where the shared clock left it (the remaining retry
    // interval), never pulled earlier by a rail change.
    expect(after.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1000);

    await billing.runBillingCycle(after.nextRetryAt!);
    after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('ACTIVE');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(0);
  });

  it('[#1393 · E12] a trial that ended while billing was stopped owed nothing: it pauses at the trial end, and the resume charges the first week at the resume, never the stopped weeks', async () => {
    const trialEnd = new Date(Date.now() - 3 * DAY);
    const { subId, httpToken } = await makeRiderSub({ due: trialEnd, autoRenew: false, prepaid: 12000 });
    await app.prisma.subscription.update({ where: { id: subId }, data: {
      status: 'TRIAL', isTrialActive: true, trialEndDate: trialEnd, currentPeriodStart: new Date(trialEnd.getTime() - 14 * DAY),
    } });
    await new SubscriptionService(app.prisma).convertExpiredTrials();
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status).toBe('ACTIVE');

    await billing.lapseStoppedSubscriptions(new Date());
    const paused = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(paused).toMatchObject({ status: 'PAUSED', autoRenew: false });
    // The free trial is recorded as zero-fee coverage: no money moved, no books touched.
    expect((await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } })).map((p) => ({ amount: Number(p.amount), status: p.status, ref: p.externalRef })))
      .toEqual([{ amount: 0, status: 'CAPTURED', ref: `trial:${subId}` }]);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: { startsWith: `ledger:success:${subId}:` } } })).toBe(0);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(12000);

    const resumedAt = Date.now();
    const resume = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'CASH');
    expect(resume.statusCode, resume.body).toBe(200);
    const charged = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId, amount: { gt: 0 } } });
    expect(charged).toHaveLength(1); // one week, starting at the resume
    expect(charged[0]!.periodStart.getTime()).toBeGreaterThanOrEqual(resumedAt - 1000);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(0);
    const row = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: row.status, autoRenew: row.autoRenew, due: row.nextBillingDate.getTime() })
      .toEqual({ status: 'ACTIVE', autoRenew: true, due: charged[0]!.periodStart.getTime() + WEEK });
  });

  it('[#1393 · E12] a trial-end week whose fee was already requested is owed: stopping never turns it into free trial coverage', async () => {
    const trialEnd = new Date(Date.now() - DAY);
    const { subId, httpToken } = await makeRiderSub({ due: trialEnd, msisdn: '6099994' });
    await app.prisma.subscription.update({ where: { id: subId }, data: {
      status: 'TRIAL', isTrialActive: true, trialEndDate: trialEnd, currentPeriodStart: new Date(trialEnd.getTime() - 14 * DAY),
    } });
    await new SubscriptionService(app.prisma).convertExpiredTrials();
    expect(await billing.billSubscription(await subWithRelations(subId) as any)).toBe('pending');
    const request = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    sandboxSetTxStatus(request.externalRef!, 'pending');
    expect((await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'NONE')).statusCode).toBe(200);

    await billing.lapseStoppedSubscriptions(new Date());
    const row = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: row.status, autoRenew: row.autoRenew }).toEqual({ status: 'ACTIVE', autoRenew: false });
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId, externalRef: `trial:${subId}` } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, idempotencyKey: { startsWith: 'pause:' } } })).toBe(0);
  });

  it('[#1393 · E12] a card payment instruction for the trial-end week, proven unpaid, still makes the week owed: no charge record is needed to say it was not free', async () => {
    const trialEnd = new Date(Date.now() - 3 * DAY);
    const { subId } = await makeRiderSub({ due: trialEnd, autoRenew: false });
    await app.prisma.subscription.update({ where: { id: subId }, data: {
      status: 'TRIAL', isTrialActive: true, trialEndDate: trialEnd, currentPeriodStart: new Date(trialEnd.getTime() - 14 * DAY),
    } });
    await new SubscriptionService(app.prisma).convertExpiredTrials();
    // A card PAY_NOW the provider authorized for the trial-end week, written as
    // the card rail writes it, then proven unpaid: an instruction was issued,
    // yet no charge record exists beside it and the clock runs again.
    const instruction = await app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'CARD', purpose: 'CARD_PAY_NOW',
      clientKey: `${CARD_PAY_NOW_KEY_PREFIX}e12-${nanoid(10)}`, failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD' },
      periodStart: trialEnd, periodEnd: new Date(trialEnd.getTime() + WEEK),
    } });
    const now = new Date();
    await app.prisma.$transaction(async (tx) => {
      await currentDunningClock(tx, subId, now);
      await resolveConfirmationInTx(tx, subId, { paymentId: instruction.id }, 'PROVEN_UNPAID',
        { actor: 'e12-finance-proof', reference: `unpaid:${instruction.id}` }, now);
    });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: { in: ['CHARGE_ATTEMPT', 'CHARGE_SUCCESS', 'CHARGE_FAILED'] } } })).toBe(0);
    expect((await readDunningClock(app.prisma, subId)).pausedAt).toBeNull();

    await billing.lapseStoppedSubscriptions(new Date());
    const row = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: row.status, autoRenew: row.autoRenew }).toEqual({ status: 'ACTIVE', autoRenew: false });
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId, externalRef: `trial:${subId}` } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, idempotencyKey: { startsWith: 'pause:' } } })).toBe(0);
  });

  it('[R13] a late MMG approval after a stop is banked to the wallet — it never renews the stopped period', async () => {
    const due = new Date(Date.now() - 60 * 60 * 1000);
    const { subId, httpToken } = await makeRiderSub({ due, msisdn: '6099992' });

    // The weekly MMG request is on the payer's phone; the sub is parked ACTIVE
    // with a future retry stamp while it pends.
    expect(await billing.billSubscription(await subWithRelations(subId) as any)).toBe('pending');
    const pending = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    expect(pending.status).toBe('PENDING');
    // [#1393 owner decision] Parked ACTIVE while the request is confirmed: the
    // instruction holds the shared clock (no retry, reminder or suspension).
    const parked = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(parked.billingConfirmationPausedAt).not.toBeNull();
    expect(await app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: pending.id } })).toMatchObject({ status: 'ACTIVE' });

    // The partner stops billing BEFORE approving the request.
    const stop = await putMethod('/api/v1/rider/subscription/billing-method', httpToken, 'NONE');
    expect(stop.statusCode, stop.body).toBe(200);
    const stopped = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(stopped).toMatchObject({ autoRenew: false, nextRetryAt: null, billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '6099992' });

    // The payer approves late; the poller settles it. Sandbox lookup approves
    // a reference that carries no 'pending' marker.
    const polled = await billing.pollPendingMmgCharges();
    expect(polled.banked).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime()); // NOT renewed
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(0);
    const captured = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(captured.status).toBe('CAPTURED');
    // The money is kept safely: the fee wallet, exactly one bank event.
    expect(await app.prisma.billingEvent.count({
      where: { subscriptionId: subId, type: 'PREPAID_TOPUP', idempotencyKey: `bank:${pending.id}` },
    })).toBe(1);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(12000);
  });
});
