import { grantStepUp } from './helpers/step-up';
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
import { syntheticLocationOwner } from './helpers/online-mover';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { sandboxSetTxStatus } from '../providers/mmg/mmg-provider';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

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
// [SAFE-B · retained history] Choosing the MMG rail records an advisory payer declaration: immutable evidence
// naming its subscription and account, kept after the suite. The movers therefore live in a phone namespace no
// other suite uses or purges, unique to the run.
const PHONE_PREFIX = retainedPhonePrefix('17');

async function makeMoverWithMmgSub(opts: { due: Date; msisdn?: string }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
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
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('billing-mmg-ra') },
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
  // [SAFE-B · retained history] A subscription an MMG payer declaration names is kept with its money records and
  // mover; the rest goes as before, in one transaction. What stays is cancelled without renewal and the mover
  // taken offline, so no later billing cycle or dispatch reaches it.
  try {
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      const goneUsers = without(userIds, kept.userIds);
      // [#1393] The synthetic subscriptions own clock evidence (RESTRICT in production): remove it first.
      await cleanupBillingClocks(tx, subIds);
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      // A mover payer's fee authority and its member rows go with the payer, before its subscriptions.
      await tx.user.deleteMany({ where: { id: { in: goneUsers } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.rider.deleteMany({ where: { userId: { in: goneUsers } } });
      await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: goneUsers } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } finally {
    await app.close();
  }
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

  it.each(['pending', 'expired'] as const)('an aged request obeys provider %s truth instead of local TTL', async outcome => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091162' });

    // [#1393] Issued by the real intent machine, so MMG's answer is bound to
    // THIS request (our reference, amount and pinned currency). Local age
    // (polled 25 hours later, past our TTL) does not settle provider
    // authority in either direction.
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    sandboxSetTxStatus(issued.externalRef!, outcome);

    const polled = await billing.pollPendingMmgCharges(new Date(Date.now() + 25 * 60 * 60 * 1000));
    if (outcome === 'expired') expect(polled.failed).toBeGreaterThanOrEqual(1);
    else expect(polled.stillPending).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe(outcome === 'expired' ? 'PAST_DUE' : 'ACTIVE');
    expect(after.failedAttempts).toBe(outcome === 'expired' ? 1 : 0);
    const payment = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    expect(payment.status).toBe(outcome === 'expired' ? 'EXPIRED' : 'PENDING');
    expect(payment.failureCode).toBe(outcome === 'expired' ? 'REQUEST_EXPIRED' : null);
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

// [July P0 · coordinator item 9] The original double charge: the poller
// expired a request still pending at MMG on our own 24-hour clock, marked it
// FAILED and dunned it without cancelling it at MMG, so the next cycle's fresh
// attempt key fired a SECOND request for the same week. Local time is never
// provider proof: the request stays live, nothing is dunned or suspended while
// it is being confirmed (owner decision 2), and no second request is sent.
describe('[July P0] a request still live at MMG past our 24-hour clock is never charged twice', () => {
  it('stays pending with no failure, no dunning and no second request; the fee stays paused past 48 hours; a late approval settles it once', async () => {
    const due = new Date(Date.now() - 60_000);
    const hours = (n: number) => new Date(due.getTime() + n * 60 * 60 * 1000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091167' });
    expect(await billing.billSubscription(await subWithRelations(subId) as never, hours(0))).toBe('pending');
    const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId, paymentMethod: 'MOBILE_MONEY' } });
    expect(issued).toMatchObject({ status: 'PENDING', externalRef: expect.any(String) });
    sandboxSetTxStatus(issued.externalRef!, 'pending'); // the payer never answers on their phone
    const one = { requests: 1, attempts: 1, failures: 0 };
    const facts = async () => ({
      requests: await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId, paymentMethod: 'MOBILE_MONEY' } }),
      attempts: await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_ATTEMPT' } }),
      failures: await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } }),
    });

    // Our 24-hour clock runs out while MMG still says pending.
    for (const at of [hours(25), hours(26)]) {
      await billing.pollPendingMmgCharges(at);
      expect(await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: issued.id } })).toMatchObject({ status: 'PENDING', failureCode: null });
    }
    // Every later cycle, past 48 wall hours and well beyond, sends nothing new
    // and neither dunns nor suspends while the request is being confirmed.
    for (const at of [hours(25), hours(49), hours(100)]) {
      expect(await billing.billSubscription(await subWithRelations(subId) as never, at)).toBe('pending');
      expect(await facts()).toEqual(one);
      const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, billingConfirmationPausedAt: expect.any(Date), billingEnforcementDueAt: null });
    }
    const hold = await app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: issued.id } });
    expect(hold.status).toBe('ACTIVE');
    expect((await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { id: hold.clockId } })).pausedAt).not.toBeNull();
    expect(await app.prisma.billingFeeNotice.count({ where: { subscriptionId: subId } })).toBe(0);

    // MMG finally says approved: the ONE request settles, once.
    sandboxSetTxStatus(issued.externalRef!, 'approved');
    await billing.pollPendingMmgCharges(hours(101));
    await billing.pollPendingMmgCharges(hours(102));
    expect(await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: issued.id } })).toMatchObject({ status: 'CAPTURED' });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
    expect(await facts()).toEqual(one);
    expect((await app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: issued.id } })).status).toBe('PAID');
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

    let payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    // The guard must NOT have initiated a second MMG request: exactly one MMG
    // reference is in play for the week. (Pre-fix, a blind re-initiate added a
    // second approvable request → the double-charge.)
    const refs = new Set(payments.map((p) => p.externalRef));
    expect(refs.size).toBe(1);
    expect([...refs][0]).toBe(originalRef);
    // [#1393] A FAILED row with no proof from MMG is a payment still being
    // confirmed: it holds the shared clock, so the charge path stops before
    // any lookup or instruction. The repair pass re-attaches the original
    // (PENDING) so the poller can still settle it, never inventing a failure.
    const original = payments.find((p) => p.externalRef === originalRef)!;
    expect(await app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: original.id } })).toMatchObject({ status: 'ACTIVE' });
    await billing.reconcileTerminalWithoutOutcome();
    payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('PENDING');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(0);
  });

  it('heals a late approval — settles off the original request instead of charging again', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091165' });
    // [R13] The request is issued by the real intent machine, so its row carries
    // our merchant reference and the issued attempt's amount and currency: the
    // evidence R13 settles an approval against. (A hand-written row without it is
    // held for a person instead; see the next case.)
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
    const approvedRef = issued.externalRef!;
    // The payer approved AFTER we synthetically gave up: the row is FAILED, but
    // its MMG lookup now reports approved (no "pending" marker → sandbox approves).
    await app.prisma.subscriptionPayment.update({ where: { id: issued.id }, data: { status: 'FAILED' } });
    await app.prisma.subscription.update({
      where: { id: subId },
      data: { status: 'PAST_DUE', failedAttempts: 1, nextRetryAt: new Date(Date.now() - 1000) },
    });

    // [#1393] The FAILED row without MMG's proof is still being confirmed: the
    // charge path stops (no second request), the repair pass re-attaches the
    // original and the poller settles the approval off it.
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    await billing.reconcileTerminalWithoutOutcome();
    const polled = await billing.pollPendingMmgCharges();
    expect(polled.settled).toBeGreaterThanOrEqual(1);

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

  it('[R13] a late approval that cannot be tied to our request is held for a person — never settled, never charged again', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6091166' });
    await app.prisma.subscription.update({
      where: { id: subId },
      data: { status: 'PAST_DUE', failedAttempts: 1, nextRetryAt: new Date(Date.now() - 1000) },
    });
    // The hand-written legacy shape: a FAILED row with no merchant reference and
    // a provider id this system never issued. MMG's lookup says approved, but
    // nothing proves the approval belongs to this request.
    const approvedRef = `mmgtx_heal_amt1200000_${nanoid(8)}`;
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'FAILED', paymentMethod: 'MOBILE_MONEY',
        externalRef: approvedRef, periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    }
    // [#1393] The repair pass re-attaches it and the poller sees MMG's approval,
    // which nothing ties to our request: held for a person, never settled.
    await billing.reconcileTerminalWithoutOutcome();
    await billing.pollPendingMmgCharges();

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('PAST_DUE');
    expect(after.nextBillingDate.getTime()).toBe(due.getTime()); // no week granted
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1); // no second MMG request, on either attempt
    expect(payments[0]).toMatchObject({ externalRef: approvedRef, status: 'PENDING', failureCode: 'SETTLEMENT_MISMATCH' });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(0);
  });
});

describe('rail selection', () => {
  it('PUT /rider/subscription/billing-method flips to MMG (msisdn required) and back', async () => {
    const { subId, httpToken } = await makeMoverWithMmgSub({ due: new Date(Date.now() + 3 * DAY) });

    await grantStepUp(app, httpToken);
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
