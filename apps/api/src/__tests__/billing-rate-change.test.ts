import { grantStepUp } from './helpers/step-up';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PaymentStatus, SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// AX332 (PR #1389): a rate change meets the subscriptions already running.
// The owner moved delivery riders from 8,000 to 6,000 a week. The old rate
// could still reach a rider in two places, and both hold for ANY rate change:
//
//  F1  A DORMANT plan. The weekly re-tier moved ACTIVE, PAST_DUE and TRIAL
//      plans only, so a rider PAUSED (or SUSPENDED) on 8,000 kept 8,000 and was
//      charged it the moment they came back, prepaid funds included. The
//      re-tier now moves a dormant plan's FUTURE rate too, with the same
//      TIER_CHANGE event. A negotiated or waived rate, and any charge already
//      issued, keep exactly what they had.
//
//  F2  A charge ALREADY ISSUED. An 8,000 MMG request still pending when the
//      rate moves settles 8,000 when it is approved: an issued amount never
//      changes. The fee screen said "Due now: 6,000" because the amount due
//      was worked out from the new weekly rate. Due now is now the charge
//      already issued for the week owed, at its own amount; the new weekly
//      rate is reported beside it, and the next week bills 6,000.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// This file's own fixture block (+5920328nnn). Grep the repo: no other file
// uses 5920328 (stop-billing uses 5920326).
const PHONE_PREFIX = '+5920328';

let app: FastifyInstance;
let billing: BillingService;
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Rate',
      lastName: `Change${seq}`,
      roles,
      activeRole,
      countryCode: 'GY',
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: `ax332-${seq}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

/** A motorbike delivery rider in Guyana on the OLD 8,000 rate. */
async function makeRiderSub(opts: {
  due: Date;
  status?: SubscriptionStatus;
  autoRenew?: boolean;
  weeklyRate?: number;
  customRate?: number;
  feeWaived?: boolean;
  prepaid?: number;
  msisdn?: string;
  /** [#1393] The current period was paid: its captured payment and success record exist. */
  paid?: boolean;
}) {
  const { userId, token } = await makeUser(['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: {
      userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      locationSessionId: syntheticLocationOwner('ax332-rate-change'),
    },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: opts.status ?? 'ACTIVE',
      weeklyRate: opts.weeklyRate ?? 8000,
      ...(opts.customRate !== undefined ? { customRate: opts.customRate } : {}),
      ...(opts.feeWaived ? { feeWaived: true, feeWaivedBy: 'founder', feeWaivedReason: 'launch partner' } : {}),
      billingMethod: opts.msisdn ? 'MOBILE_MONEY' : 'CASH',
      mmgPayerMsisdn: opts.msisdn ?? null,
      autoRenew: opts.autoRenew ?? true,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
      ...(opts.prepaid !== undefined
        ? { prepaidBalance: { create: { balance: opts.prepaid, currencyCode: 'GYD' } } }
        : {}),
    },
  });
  if (opts.paid) await settlePeriod(sub.id, sub.currentPeriodStart, sub.currentPeriodEnd, Number(sub.weeklyRate));
  return { userId, subId: sub.id, httpToken: token };
}

/** [#1393] A paid week as the billing engine records one: its captured payment
 *  and matching success record. A stopped plan pauses at its period end only on
 *  this exact settled coverage; a date alone never erases a fee. */
async function settlePeriod(subId: string, start: Date, end: Date, amount: number) {
  const paymentRef = `ax332-paid:${subId}:${start.toISOString()}`;
  await app.prisma.subscriptionPayment.create({ data: { subscriptionId: subId, amount, paymentMethod: 'CASH', status: 'CAPTURED',
    periodStart: start, periodEnd: end, paidAt: start, externalRef: paymentRef } });
  await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_SUCCESS', amount, currencyCode: 'GYD',
    paymentRef, idempotencyKey: `success:${subId}:${start.toISOString().slice(0, 10)}` } });
}

/** Payments the billing engine made, leaving out a fixture's settled week. */
const enginePayments = (subId: string) => app.prisma.subscriptionPayment.findMany({
  where: { subscriptionId: subId, NOT: { externalRef: { startsWith: 'ax332-paid:' } } }, orderBy: { createdAt: 'asc' },
});

/** A taxi subscription issued on the previous 9,000 rate. */
async function makeTaxiSub(opts: {
  due: Date; status?: SubscriptionStatus; weeklyRate?: number; customRate?: number; feeWaived?: boolean; prepaid?: number; msisdn?: string;
  /** [#1393] Billing stopped with the current period paid: the lapse sweep pauses it at the period end. */
  stoppedPaid?: boolean;
}) {
  const { userId, token } = await makeUser(['MOVER', 'DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await app.prisma.driver.create({ data: {
    userId, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Test', vehicleYear: 2020,
    vehicleColor: 'White', licensePlate: `RATE-TAXI-${seq}`, driverLicenseUrl: 'test/licence', vehicleInsuranceUrl: 'test/insurance', documentsVerified: true,
  } });
  const sub = await app.prisma.subscription.create({ data: {
    driverId: driver.id, type: 'TAXI_DRIVER', status: opts.status ?? 'ACTIVE', weeklyRate: opts.weeklyRate ?? 9000,
    ...(opts.customRate !== undefined ? { customRate: opts.customRate } : {}),
    ...(opts.feeWaived ? { feeWaived: true, feeWaivedBy: 'test-admin', feeWaivedReason: 'test waiver' } : {}),
    billingMethod: opts.msisdn ? 'MOBILE_MONEY' : 'CASH', mmgPayerMsisdn: opts.msisdn ?? null,
    autoRenew: opts.status !== 'PAUSED' && !opts.stoppedPaid, currentPeriodStart: new Date(opts.due.getTime() - WEEK), currentPeriodEnd: opts.due, nextBillingDate: opts.due,
    ...(opts.prepaid !== undefined ? { prepaidBalance: { create: { balance: opts.prepaid, currencyCode: 'GYD' } } } : {}),
  } });
  if (opts.stoppedPaid) await settlePeriod(sub.id, sub.currentPeriodStart, sub.currentPeriodEnd, Number(sub.weeklyRate));
  return { userId, subId: sub.id, httpToken: token };
}

/** A restaurant with no listings (the small tier, 15,000) on a stale 20,000 rate. */
async function makeVendorSub(opts: { due: Date; status: SubscriptionStatus; autoRenew?: boolean }) {
  const { userId } = await makeUser(['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Rate Change Kitchen ${seq}`,
      slug: `ax332-rate-change-${seq}-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Rate Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id,
      type: 'RESTAURANT',
      status: opts.status,
      weeklyRate: 20000,
      billingMethod: 'CASH',
      autoRenew: opts.autoRenew ?? true,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
    },
  });
  return { subId: sub.id };
}

/** A weekly-fee payment row for the given week, as the biller writes one. */
function paymentRow(subId: string, amount: number, status: PaymentStatus, periodStart: Date, externalRef: string | null) {
  return app.prisma.subscriptionPayment.create({
    data: {
      subscriptionId: subId,
      amount,
      status,
      paymentMethod: 'MOBILE_MONEY',
      externalRef,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + WEEK),
    },
  });
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

/** The re-tier's own events (the pause, stop and rail notes share the type). */
const retierEvents = (subId: string) =>
  app.prisma.billingEvent.findMany({
    where: { subscriptionId: subId, type: 'TIER_CHANGE', idempotencyKey: { startsWith: `tier:${subId}:` } },
  });

const rate = async (subId: string) =>
  Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).weeklyRate);

/** The fee screen's data: GET /rider/subscription, the payload the app renders. */
async function feeScreen(token: string, kind: 'rider' | 'driver' = 'rider') {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/${kind}/subscription`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { amountDueGyd: number; weeklyFeeGyd: number; walletBalanceGyd: number };
}

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

/** Everything this file's phone block owns. Audit rows are append-only: they
 *  go through the sanctioned purge. */
async function purgeBlock() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const subs = await app.prisma.subscription.findMany({
    where: { OR: [{ rider: { userId: { in: ids } } }, { driver: { userId: { in: ids } } }, { vendor: { owner: { userId: { in: ids } } } }] },
    select: { id: true },
  });
  const sids = subs.map((sub) => sub.id);
  await cleanupBillingClocks(app.prisma, sids);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...sids, ...ids] } }, { userId: { in: ids } }] }, 'test-cleanup:ax332-rate-change');
  await app.prisma.subscription.deleteMany({ where: { id: { in: sids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

afterAll(async () => {
  await purgeBlock();
  await app.close();
});

describe('AX332 F1: the weekly re-tier reaches a dormant plan', () => {
  it('a rider paused on 8,000 moves to 6,000, and resuming charges 6,000 from prepaid funds', async () => {
    const now = new Date();
    // Stopped weekly billing on the old card; the paid period then ran out.
    const paused = await makeRiderSub({ due: new Date(now.getTime() - 2 * DAY), autoRenew: false, prepaid: 8000, paid: true });
    await billing.lapseStoppedSubscriptions(now);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: paused.subId } })).status).toBe('PAUSED');

    await billing.recalculateMoverTiers();

    // The FUTURE rate moved, with its audit event; the plan is still paused.
    expect(await rate(paused.subId)).toBe(6000);
    const events = await retierEvents(paused.subId);
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.amount)).toBe(6000);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: paused.subId } })).status).toBe('PAUSED');

    // Resume: charged at once, at the rate in force, from the money already held.
    await grantStepUp(app, paused.httpToken);
    const resume = await app.inject({
      method: 'PUT',
      url: '/api/v1/rider/subscription/billing-method',
      payload: { method: 'CASH' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${paused.httpToken}` },
    });
    expect(resume.statusCode, resume.body).toBe(200);

    const payments = await enginePayments(paused.subId);
    expect(payments).toHaveLength(1);
    expect({ amount: Number(payments[0]!.amount), status: payments[0]!.status }).toEqual({ amount: 6000, status: 'CAPTURED' });
    const wallet = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: paused.subId } });
    expect(Number(wallet.balance)).toBe(2000); // 8,000 held, 6,000 spent — never 8,000
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: paused.subId } })).status).toBe('ACTIVE');
  });

  it('a SUSPENDED rider moves too; a negotiated or waived dormant rate, and an issued request, keep their amounts', async () => {
    const now = new Date();
    const owedWeek = new Date(now.getTime() - 3 * DAY);
    const suspended = await makeRiderSub({ due: owedWeek, status: 'SUSPENDED', msisdn: '6091271' });
    // The MMG request for the owed week went out on the old rate, before the move.
    const issued = await paymentRow(suspended.subId, 8000, 'PENDING', owedWeek, `mmgtx_pending_${nanoid(8)}`);
    const negotiated = await makeRiderSub({ due: owedWeek, status: 'PAUSED', autoRenew: false, weeklyRate: 7500, customRate: 7500 });
    const waived = await makeRiderSub({ due: owedWeek, status: 'PAUSED', autoRenew: false, feeWaived: true });

    await billing.recalculateMoverTiers();

    expect(await rate(suspended.subId)).toBe(6000);
    expect(await retierEvents(suspended.subId)).toHaveLength(1);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: suspended.subId } })).status).toBe('SUSPENDED');
    // Issued money is a fact: the request still asks for, and settles, 8,000.
    const request = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: issued.id } });
    expect({ amount: Number(request.amount), status: request.status }).toEqual({ amount: 8000, status: 'PENDING' });

    // A human decided these; a card change never silently undoes one.
    const neg = await app.prisma.subscription.findUniqueOrThrow({ where: { id: negotiated.subId } });
    expect({ weeklyRate: Number(neg.weeklyRate), customRate: Number(neg.customRate) }).toEqual({ weeklyRate: 7500, customRate: 7500 });
    expect(await retierEvents(negotiated.subId)).toHaveLength(0);
    expect(await rate(waived.subId)).toBe(8000);
    expect(await retierEvents(waived.subId)).toHaveLength(0);
  });

  it('a vendor plan paused or suspended on a stale rate moves too: one re-tier for every partner', async () => {
    const now = new Date();
    const due = new Date(now.getTime() - 2 * DAY);
    const paused = await makeVendorSub({ due, status: 'PAUSED', autoRenew: false });
    const suspended = await makeVendorSub({ due, status: 'SUSPENDED' });

    await billing.recalculateVendorTiers();

    for (const { subId } of [paused, suspended]) {
      expect(await rate(subId)).toBe(15000); // no listings: the small tier
      const events = await retierEvents(subId);
      expect(events).toHaveLength(1);
      expect(Number(events[0]!.amount)).toBe(15000);
    }
  });
});

describe('AX332 F2: due now is the charge already issued', () => {
  it('an 8,000 request pending across the re-tier: due now 8,000 beside the new 6,000 fee, and the next week bills 6,000', async () => {
    const due = new Date(Date.now() - 60_000);
    const rider = await makeRiderSub({ due, msisdn: '6091272' });

    // The weekly charge goes out on the old rate and waits on the payer's phone.
    expect(await billing.billSubscription((await subWithRelations(rider.subId)) as never)).toBe('pending');
    const request = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: rider.subId } });
    expect({ amount: Number(request.amount), status: request.status }).toEqual({ amount: 8000, status: 'PENDING' });

    await billing.recalculateMoverTiers();
    expect(await rate(rider.subId)).toBe(6000);

    // What approving settles is what the screen says is due; the new fee is
    // reported beside it, never in its place.
    const pending = await feeScreen(rider.httpToken);
    expect({ amountDueGyd: pending.amountDueGyd, weeklyFeeGyd: pending.weeklyFeeGyd }).toEqual({ amountDueGyd: 8000, weeklyFeeGyd: 6000 });

    // Approved (the sandbox approves a request with no marker): 8,000 settles
    // the owed week and moves the plan on exactly one week.
    await billing.pollPendingMmgCharges();
    const settled = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: request.id } });
    expect({ amount: Number(settled.amount), status: settled.status }).toEqual({ amount: 8000, status: 'CAPTURED' });
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: rider.subId } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + WEEK);

    // Nothing issued any more: the next week's fee, at the new rate.
    const paid = await feeScreen(rider.httpToken);
    expect({ amountDueGyd: paid.amountDueGyd, weeklyFeeGyd: paid.weeklyFeeGyd }).toEqual({ amountDueGyd: 6000, weeklyFeeGyd: 6000 });

    // The next cycle bills the new rate.
    expect(await billing.billSubscription((await subWithRelations(rider.subId)) as never)).toBe('pending');
    const next = await app.prisma.subscriptionPayment.findFirstOrThrow({
      where: { subscriptionId: rider.subId, periodStart: new Date(due.getTime() + WEEK) },
    });
    expect({ amount: Number(next.amount), status: next.status }).toEqual({ amount: 6000, status: 'PENDING' });
    expect((await feeScreen(rider.httpToken)).amountDueGyd).toBe(6000);
  });

  it('the suspended nudge states what is owed: an 8,000 request pending across the re-tier is nudged as 8,000, not the new 6,000 fee [AX349]', async () => {
    const now = new Date();
    const owedWeek = new Date(now.getTime() - 3 * DAY);
    const rider = await makeRiderSub({ due: owedWeek, status: 'SUSPENDED', msisdn: '6091274' });
    await app.prisma.subscription.update({ where: { id: rider.subId }, data: { suspendedAt: new Date(now.getTime() - DAY) } });
    await paymentRow(rider.subId, 8000, 'PENDING', owedWeek, `mmgtx_pending_${nanoid(8)}`);

    await billing.recalculateMoverTiers();
    expect(await rate(rider.subId)).toBe(6000);

    await billing.sweepSuspended(now);
    // [#1393 owner decision] While the 8,000 request is being confirmed no
    // "you owe" nudge is committed or delivered at all, so no notice can quote
    // a figure the fee screen does not. The fee screen states what approving
    // the request settles: the issued 8,000, never the new weekly rate.
    expect(await app.prisma.billingEvent.count({
      where: { subscriptionId: rider.subId, type: 'REMINDER', idempotencyKey: { startsWith: `nudge:${rider.subId}:` } },
    })).toBe(0);
    expect(await app.prisma.notification.count({
      where: { userId: rider.userId, data: { path: ['kind'], equals: 'billing_suspended_nudge' } },
    })).toBe(0);
    expect((await feeScreen(rider.httpToken)).amountDueGyd).toBe(8000);
  });

  it('only a live charge for the week now owed is due now: not a dead one, not a request for a week already paid', async () => {
    const due = new Date(Date.now() + 2 * DAY);
    const rider = await makeRiderSub({ due, weeklyRate: 6000, msisdn: '6091273' });
    // A request for the week already paid, still open at MMG: approving it
    // would be banked to the wallet, not charged for a week, so it is not due.
    await paymentRow(rider.subId, 8000, 'PENDING', new Date(due.getTime() - WEEK), `mmgtx_pending_${nanoid(8)}`);
    // A request for the week owed that MMG declined: nothing can settle it.
    await paymentRow(rider.subId, 8000, 'FAILED', due, `mmgtx_declined_${nanoid(8)}`);

    expect((await feeScreen(rider.httpToken)).amountDueGyd).toBe(6000); // next week's fee, as before

    // An initiate that timed out may still be live on the payer's phone:
    // approving it settles its amount, so that amount is what is due.
    await paymentRow(rider.subId, 8000, 'UNKNOWN', due, null);
    expect((await feeScreen(rider.httpToken)).amountDueGyd).toBe(8000);
  });
});


describe('owner taxi 8,000: future fees change, issued money does not', () => {
  it.each(['ACTIVE', 'PAST_DUE', 'TRIAL', 'PAUSED', 'SUSPENDED'] as const)('re-tiers a %s taxi once with the new rate and an audit event', async (status) => {
    const due = new Date(Date.now() + DAY);
    const taxi = await makeTaxiSub({ due, status });
    await billing.recalculateMoverTiers();
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: taxi.subId } });
    expect({ rate: Number(after.weeklyRate), status: after.status, due: after.nextBillingDate }).toEqual({ rate: 8000, status, due });
    const events = await retierEvents(taxi.subId);
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.amount)).toBe(8000);
    expect(events[0]!.idempotencyKey).toContain(':9000->8000');
    await billing.recalculateMoverTiers();
    expect(await retierEvents(taxi.subId)).toHaveLength(1);
  });

  it('retains negotiated and waived taxi rates while re-tiering ordinary taxis', async () => {
    const due = new Date(Date.now() + DAY);
    const custom = await makeTaxiSub({ due, status: 'PAUSED', weeklyRate: 7500, customRate: 7500 });
    const waived = await makeTaxiSub({ due, status: 'SUSPENDED', feeWaived: true });
    await billing.recalculateMoverTiers();
    expect(await rate(custom.subId)).toBe(7500);
    expect(await rate(waived.subId)).toBe(9000);
    expect(await retierEvents(custom.subId)).toHaveLength(0);
    expect(await retierEvents(waived.subId)).toHaveLength(0);
  });

  it('resumes a paused taxi at 8,000 from prepaid funds', async () => {
    // [#1393] Paused the real way: billing stopped, the paid week ran out, the lapse sweep paused it.
    const taxi = await makeTaxiSub({ due: new Date(Date.now() - DAY), stoppedPaid: true, prepaid: 9000 });
    await billing.lapseStoppedSubscriptions();
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: taxi.subId } })).status).toBe('PAUSED');
    await billing.recalculateMoverTiers();
    // [SAFE-B] The billing-method routes need a stepped-up session.
    await grantStepUp(app, taxi.httpToken);
    const resume = await app.inject({ method: 'PUT', url: '/api/v1/driver/subscription/billing-method', payload: { method: 'CASH' }, headers: { 'content-type': 'application/json', authorization: `Bearer ${taxi.httpToken}` } });
    expect(resume.statusCode, resume.body).toBe(200);
    const payments = await enginePayments(taxi.subId);
    expect(payments).toHaveLength(1);
    expect({ amount: Number(payments[0]!.amount), status: payments[0]!.status }).toEqual({ amount: 8000, status: 'CAPTURED' });
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: taxi.subId } })).balance)).toBe(1000);
  });

  it('keeps an issued 9,000 taxi charge and fee-screen due amount, then bills the next week at 8,000', async () => {
    const due = new Date(Date.now() - 60_000);
    const taxi = await makeTaxiSub({ due, msisdn: '6091275' });
    expect(await billing.billSubscription((await subWithRelations(taxi.subId)) as never)).toBe('pending');
    const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: taxi.subId } });
    expect(Number(issued.amount)).toBe(9000);
    await billing.recalculateMoverTiers();
    const screen = await feeScreen(taxi.httpToken, 'driver');
    expect({ due: screen.amountDueGyd, weekly: screen.weeklyFeeGyd }).toEqual({ due: 9000, weekly: 8000 });
    await billing.pollPendingMmgCharges();
    const settled = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: issued.id } });
    expect({ amount: Number(settled.amount), status: settled.status }).toEqual({ amount: 9000, status: 'CAPTURED' });
    expect(await billing.billSubscription((await subWithRelations(taxi.subId)) as never)).toBe('pending');
    const next = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: taxi.subId, periodStart: new Date(due.getTime() + WEEK) } });
    expect(Number(next.amount)).toBe(8000);
  });
});
