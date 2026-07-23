import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';

// ---------------------------------------------------------------------------
// §13 MMG billing rail: the weekly fee as a merchant-initiated request the
// subscriber approves on their phone. Money path — failure-first: pending
// never advances the period; only the poller's terminal verdicts do.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_400_000_000 + Math.floor(Math.random() * 500_000_000);

async function makeMoverWithMmgSub(opts: { due: Date; msisdn?: string }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Rail', lastName: `U${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'rail-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: opts.msisdn ? 'MOBILE_MONEY' : 'CASH',
      mmgPayerMsisdn: opts.msisdn ?? null,
      currentPeriodStart: new Date(opts.due.getTime() - 7 * DAY),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, riderId: rider.id, subId: sub.id, httpToken: token };
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
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('poll settle correctness [SWIFT-AUD-D2-04]', () => {
  it('concurrent polls settle a payment ONCE — single winner, both runs survive (4 race rounds)', async () => {
    // Two poller deliveries racing (second instance / overlapping tick). The
    // PENDING-claim CAS must pick exactly one winner and neither run may
    // throw (pre-fix, the loser either died on the billing-event idempotency
    // key or double-advanced the period off a re-read subscription). Race
    // windows are timing-dependent, so run several rounds.
    for (let round = 0; round < 4; round += 1) {
      const due = new Date(Date.now() - 60_000);
      const { subId } = await makeMoverWithMmgSub({ due, msisdn: `609117${round}` });
      const outcome = await billing.billSubscription((await subWithRelations(subId)) as any);
      expect(outcome).toBe('pending');

      await Promise.all([billing.pollPendingMmgCharges(), billing.pollPendingMmgCharges()]);

      const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY); // advanced exactly one period
      const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } });
      expect(events).toHaveLength(1);
      const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
      expect(payments).toHaveLength(1);
      expect(payments[0]!.status).toBe('CAPTURED');
    }
  });

  it('runBillingCycle honors nextRetryAt on ACTIVE subs — no re-initiate while a request is in flight', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091172' });
    // An in-flight MMG request parks the sub ACTIVE with a future retry stamp;
    // the hourly cycle must NOT fire a second initiate for the same week.
    await app.prisma.subscription.update({
      where: { id: subId },
      data: { nextRetryAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    await billing.runBillingCycle();

    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(0); // nothing initiated — future nextRetryAt gates the ACTIVE arm
  });
});

describe('MMG charge lifecycle', () => {
  it('bill → pending (no period advance), poll → approved settles the SAME payment row', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091161' });

    const outcome = await billing.billSubscription((await subWithRelations(subId)) as any);
    expect(outcome).toBe('pending');

    const midway = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(midway.nextBillingDate.getTime()).toBe(due.getTime()); // NOT advanced
    const pendingRow = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    expect(pendingRow.status).toBe('PENDING');
    expect(pendingRow.externalRef).toBeTruthy();

    // Sandbox: our reference carries no marker → lookup approves.
    const polled = await billing.pollPendingMmgCharges();
    expect(polled.settled).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('ACTIVE');
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY); // advanced exactly one period

    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1); // settled in place — no duplicate row
    expect(payments[0]!.status).toBe('CAPTURED');
  });

  it('a request ignored for >24h expires into the normal dunning path', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091162' });

    // A stale pending row whose sandbox lookup stays pending forever.
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId,
        amount: 12000,
        status: 'PENDING',
        paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_pending_${nanoid(8)}`,
        periodStart: due,
        periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });

    const polled = await billing.pollPendingMmgCharges();
    expect(polled.failed).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('PAST_DUE'); // dunning, not silence
    expect(after.failedAttempts).toBe(1);
    const payment = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    expect(payment.status).toBe('FAILED');
  });

  it('a fresh still-pending request is left alone', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091163' });
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId,
        amount: 12000,
        status: 'PENDING',
        paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_pending_${nanoid(8)}`,
        periodStart: due,
        periodEnd: new Date(due.getTime() + 7 * DAY),
      },
    });
    await billing.pollPendingMmgCharges();
    const payment = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    expect(payment.status).toBe('PENDING'); // the payer still has time
  });
});

describe('MMG double-charge guard [SWIFT-004]', () => {
  it('a dunning retry does NOT fire a second request while the first is still live at MMG', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091164' });
    // State right after the poller synthetically expired an ignored-but-still-
    // live request: the sub is dunning (failedAttempts=1) and the original
    // payment row is FAILED — yet its MMG lookup still says pending (the request
    // is live on the payer's phone; our 24h expiry was a DB-side guess).
    await app.prisma.subscription.update({
      where: { id: subId },
      data: { status: 'PAST_DUE', failedAttempts: 1, nextRetryAt: new Date(Date.now() - 1000) },
    });
    const originalRef = `mmgtx_pending_${nanoid(8)}`; // sandbox lookup → stays pending
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'FAILED', paymentMethod: 'MOBILE_MONEY',
        externalRef: originalRef, periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });

    const outcome = await billing.billSubscription((await subWithRelations(subId)) as any);
    expect(outcome).toBe('pending');

    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    // The guard must NOT have initiated a second MMG request: exactly one MMG
    // reference is in play for the week. (Pre-fix, a blind re-initiate added a
    // second approvable request → the double-charge.)
    const refs = new Set(payments.map((p) => p.externalRef));
    expect(refs.size).toBe(1);
    expect([...refs][0]).toBe(originalRef);
    // The original is re-attached (PENDING) so the poller can still settle it.
    expect(payments.find((p) => p.externalRef === originalRef)!.status).toBe('PENDING');
  });

  it('heals a late approval — settles off the original request instead of charging again', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091165' });
    await app.prisma.subscription.update({
      where: { id: subId },
      data: { status: 'PAST_DUE', failedAttempts: 1, nextRetryAt: new Date(Date.now() - 1000) },
    });
    // The payer approved AFTER we synthetically gave up: the row is FAILED, but
    // its MMG lookup now reports approved (no "pending" marker → sandbox approves).
    const approvedRef = `mmgtx_heal_${nanoid(8)}`;
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'FAILED', paymentMethod: 'MOBILE_MONEY',
        externalRef: approvedRef, periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
      },
    });

    const outcome = await billing.billSubscription((await subWithRelations(subId)) as any);
    expect(outcome).toBe('succeeded');

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('ACTIVE');
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY); // advanced exactly once
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    const refs = new Set(payments.map((p) => p.externalRef));
    expect(refs.size).toBe(1); // no new MMG request — the same reference is reused
    expect([...refs][0]).toBe(approvedRef);
    expect(payments.filter((p) => p.status === 'CAPTURED')).toHaveLength(1); // settled in place
    const successes = await app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } });
    expect(successes).toHaveLength(1);
  });
});

describe('rail selection', () => {
  it('PUT /rider/subscription/billing-method flips to MMG (msisdn required) and back', async () => {
    const { subId, httpToken } = await makeMoverWithMmgSub({ due: new Date(Date.now() + 3 * DAY) });

    const noMsisdn = await app.inject({
      method: 'PUT', url: '/api/v1/rider/subscription/billing-method',
      payload: { method: 'MOBILE_MONEY' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${httpToken}` },
    });
    expect(noMsisdn.statusCode).toBe(400); // MMG without an account is refused

    const toMmg = await app.inject({
      method: 'PUT', url: '/api/v1/rider/subscription/billing-method',
      payload: { method: 'MOBILE_MONEY', mmgPayerMsisdn: '6099999' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${httpToken}` },
    });
    expect(toMmg.statusCode).toBe(200);
    expect(toMmg.json().data).toMatchObject({ billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '6099999' });

    const back = await app.inject({
      method: 'PUT', url: '/api/v1/rider/subscription/billing-method',
      payload: { method: 'CASH' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${httpToken}` },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().data).toMatchObject({ billingMethod: 'CASH', mmgPayerMsisdn: null });

    // The switch left an audit trail
    const trail = await app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, note: { contains: 'Billing rail' } } });
    expect(trail.length).toBe(2);
  });
});
