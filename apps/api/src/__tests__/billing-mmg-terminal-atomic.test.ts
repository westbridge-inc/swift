import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService, type BillingObserver } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { SandboxMmgProvider, sandboxSetTxStatus } from '../providers/mmg/mmg-provider';
import { mmgTerminalProof } from '../modules/billing/mmg-terminal-evidence';
import { syntheticLocationOwner } from './helpers/online-mover';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [M-04 · S0] MMG terminal status and dunning outcome are ONE transition.
//
// Before: every failure site flipped the payment row terminal in one
// statement (FAILED / EXPIRED) and only then recorded the CHARGE_FAILED
// event, advanced the dunning counter and moved the subscription to
// PAST_DUE or SUSPENDED. A crash between the two left a payment nobody
// polled and a subscription nobody retried or suspended — active, unpaid,
// forever — and the biller's own idempotency then skipped the period for
// good. These cases inject a failure INSIDE the transaction, after the
// terminal compare-and-set, and require that either everything landed or
// nothing did — and that the next tick lands it exactly once.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** The poller stamps a per-row poll backoff BEFORE touching a row (and that
 *  stamp is deliberately outside the transaction), so a "next tick" in these
 *  cases runs on a later clock, exactly as the real scheduler would. */
const tick = (hoursLater: number) => new Date(Date.now() + hoursLater * HOUR);

let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_410_000_000 + Math.floor(Math.random() * 500_000_000);

/** The failpoint: armed once, it throws inside the terminalization transaction. */
let armed = false;
const observer: BillingObserver = {
  afterPaymentTerminalized: async () => {
    if (!armed) return;
    armed = false;
    throw new Error('failpoint: the process died after the terminal CAS');
  },
};

async function makeMoverWithMmgSub(opts: { due: Date; failedAttempts?: number }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Atomic', lastName: `U${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('billing-m04-at') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: 'MOBILE_MONEY',
      mmgPayerMsisdn: '6091162',
      failedAttempts: opts.failedAttempts ?? 0,
      currentPeriodStart: new Date(opts.due.getTime() - 7 * DAY),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, riderId: rider.id, subId: sub.id };
}

/** [#1393] A live MMG request issued by the real intent machine (our merchant
 *  reference, the attempt's amount and pinned currency), whose sandbox lookup
 *  then answers `outcome`. Only an answer bound to the request it was asked
 *  about may terminalize it; a hand-written row is held for a person instead
 *  (billing-mmg-negative-integration.test.ts). */
async function issuedRequest(subId: string, outcome: 'reversed' | 'expired' | 'pending') {
  expect(await billing.billSubscription(await subWithRelations(subId))).toBe('pending');
  const payment = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId }, orderBy: { createdAt: 'desc' } });
  expect(payment).toMatchObject({ status: 'PENDING', paymentMethod: 'MOBILE_MONEY' });
  sandboxSetTxStatus(payment.externalRef!, outcome);
  return payment;
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

const failedEvents = (subId: string) => app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // sandbox
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider(), observer);
});

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  vi.restoreAllMocks();
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  // A mover payer's fee authority and sources survive while the payer does: remove the payer first.
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[M-04] the poller: terminal status and dunning outcome land together or not at all', () => {
  it('a crash after the terminal CAS rolls the payment back to PENDING — and the next tick applies exactly one outcome', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId, userId } = await makeMoverWithMmgSub({ due });
    const payment = await issuedRequest(subId, 'reversed');
    const before = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });

    armed = true;
    const crashed = await billing.pollPendingMmgCharges();
    expect(armed).toBe(false); // the failpoint fired
    expect(crashed.failed).toBe(0);

    // NOTHING landed: not the terminal status, not the event, not the counter.
    const p1 = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const s1 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(p1.status).toBe('PENDING');
    expect(await failedEvents(subId)).toBe(0);
    expect({ status: s1.status, failedAttempts: s1.failedAttempts, nextRetryAt: s1.nextRetryAt })
      .toEqual({ status: before.status, failedAttempts: before.failedAttempts, nextRetryAt: before.nextRetryAt });

    // The row is still polled, so the next tick finishes the job — once.
    const next = await billing.pollPendingMmgCharges(tick(1));
    expect(next.failed).toBe(1);
    const p2 = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const s2 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(p2.status).toBe('FAILED');
    expect(p2.failureCode).toBeTruthy();
    expect(await failedEvents(subId)).toBe(1);
    expect({ status: s2.status, failedAttempts: s2.failedAttempts }).toEqual({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(s2.nextRetryAt).not.toBeNull();
    expect(await app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'billing_failed' } } })).toBe(1);

    // And a third tick has nothing left to do.
    const idle = await billing.pollPendingMmgCharges(tick(2));
    expect(idle.failed).toBe(0);
    expect(await failedEvents(subId)).toBe(1);
  });

  it('the suspending failure is one transition too: payment, event and the exhausted ladder; the suspension that follows is one transition: SUSPENDED state, the rider offline, the SUSPENDED event', async () => {
    // [#1393] The owner's two days of grace have run (due 49 hours ago); the
    // third failure is the last rung. A confirmation's resolution never
    // suspends in its own instant: the next billing run does, in one step.
    const due = new Date(Date.now() - 49 * HOUR);
    const { subId, riderId } = await makeMoverWithMmgSub({ due, failedAttempts: 2 }); // the third failure exhausts the ladder
    const payment = await issuedRequest(subId, 'reversed');

    armed = true;
    await billing.pollPendingMmgCharges();
    const p1 = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const s1 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    const r1 = await app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect({ payment: p1.status, sub: s1.status, attempts: s1.failedAttempts, online: r1.isOnline })
      .toEqual({ payment: 'PENDING', sub: 'ACTIVE', attempts: 2, online: true });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: { in: ['CHARGE_FAILED', 'SUSPENDED'] } } })).toBe(0);

    await billing.pollPendingMmgCharges(tick(1));
    const p2 = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const s2 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    const r2 = await app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect({ payment: p2.status, sub: s2.status, attempts: s2.failedAttempts, online: r2.isOnline })
      .toEqual({ payment: 'FAILED', sub: 'PAST_DUE', attempts: 3, online: true });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'SUSPENDED' } })).toBe(0);

    await billing.runBillingCycle(tick(2));
    const s3 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    const r3 = await app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect({ sub: s3.status, attempts: s3.failedAttempts, online: r3.isOnline, available: r3.isAvailable })
      .toEqual({ sub: 'SUSPENDED', attempts: 3, online: false, available: false });
    expect(s3.suspendedAt).not.toBeNull();
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'SUSPENDED' } })).toBe(1);
  });

  it('two pollers racing on the same terminal payment produce ONE outcome', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    await issuedRequest(subId, 'reversed');
    await Promise.all([billing.pollPendingMmgCharges(), billing.pollPendingMmgCharges()]);
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: s.status, failedAttempts: s.failedAttempts }).toEqual({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(await failedEvents(subId)).toBe(1);
  });

  it('a never-authorized UNKNOWN reservation past TTL expires and duns atomically', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    const unknown = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'MOBILE_MONEY',
        clientKey: `sub:${subId}:${due.toISOString().slice(0, 10)}:a0`, externalRef: null,
        failureRaw: { providerEffect: 'NOT_SENT', providerRail: 'MOBILE_MONEY' },
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 26 * HOUR), expiresAt: new Date(Date.now() - HOUR),
      },
    });
    armed = true;
    await billing.pollPendingMmgCharges();
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe('UNKNOWN');
    expect(await failedEvents(subId)).toBe(0);

    const next = await billing.pollPendingMmgCharges(tick(1));
    expect(next.failed).toBeGreaterThanOrEqual(1); // this row, plus whatever other rows this file left due
    const p = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: unknown.id } });
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ payment: p.status, code: p.failureCode, sub: s.status, attempts: s.failedAttempts })
      .toEqual({ payment: 'EXPIRED', code: 'REQUEST_EXPIRED', sub: 'PAST_DUE', attempts: 1 });
    expect(await failedEvents(subId)).toBe(1);
  });
});

describe('[M-04] the biller: a synchronous MMG decline is the same one transition', () => {
  it('a crash after FAILED rolls back to UNKNOWN; confirmed provider recovery then duns exactly once', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'declined', transactionId: '', reason: 'Payer declined (test)' });
    try {
      armed = true;
      await expect(billing.billSubscription(await subWithRelations(subId))).rejects.toThrow('failpoint');
      const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
      const s1 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect({ intent: intent.status, ref: intent.externalRef, sub: s1.status, attempts: s1.failedAttempts })
        .toEqual({ intent: 'UNKNOWN', ref: null, sub: 'ACTIVE', attempts: 0 });
      expect(await failedEvents(subId)).toBe(0);

      // Re-running the biller neither double-charges nor invents an outcome: the
      // attempt is already recorded and its intent is live → 'pending'.
      expect(await billing.billSubscription(await subWithRelations(subId))).toBe('pending');
      expect(await failedEvents(subId)).toBe(0);

      // The rollback lost the terminal result, not its dispatch authority.
      // Empty history after TTL cannot stand in for another terminal answer.
      await billing.pollPendingMmgCharges(tick(25));
      expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('UNKNOWN');
      expect(await failedEvents(subId)).toBe(0);
      const evidence = { status: 'declined' as const, transactionId: `synthetic-declined-${subId}`, amountMinor: 1200000, currencyCode: 'GYD', reference: intent.clientKey! };
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([evidence]);
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(evidence);
      await billing.pollPendingMmgCharges(tick(26)); // adopt the provider id
      const polled = await billing.pollPendingMmgCharges(tick(27));
      expect(polled.failed).toBeGreaterThanOrEqual(1);
      const p = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
      const s2 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect({ payment: p.status, sub: s2.status, attempts: s2.failedAttempts }).toEqual({ payment: 'FAILED', sub: 'PAST_DUE', attempts: 1 });
      expect(await failedEvents(subId)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('without a crash, the synchronous decline lands payment + event + dunning state together', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'declined', transactionId: '', reason: 'Payer declined (test)' });
    try {
      expect(await billing.billSubscription(await subWithRelations(subId))).toBe('failed');
      const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } });
      const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect({ intent: intent.status, sub: s.status, attempts: s.failedAttempts }).toEqual({ intent: 'FAILED', sub: 'PAST_DUE', attempts: 1 });
      expect(intent.failureCode).toBeTruthy();
      expect(await failedEvents(subId)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('[M-04 · operations clause] the repair pass: a terminal payment without an outcome is applied once, and only where it belongs', () => {
  /** [#1393] The residue the repair pass applies: a request issued under our
   *  reference whose terminal status landed WITH MMG's bound terminal proof
   *  (the versioned record a bound lookup leaves), while its dunning outcome
   *  never did. Historical status text alone is not proof: such a row is held
   *  for a person (billing-mmg-negative-integration.test.ts). */
  async function terminalPayment(subId: string, due: Date, status: 'FAILED' | 'EXPIRED') {
    const periodKey = due.toISOString().slice(0, 10);
    const clientKey = `sub:${subId}:${periodKey}:a0`;
    await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_ATTEMPT', amount: 12000, currencyCode: 'GYD', idempotencyKey: `charge:${clientKey.slice(4)}` } });
    const externalRef = `mmgtx_expired_amt1200000_${nanoid(8)}`;
    const row = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status, paymentMethod: 'MOBILE_MONEY', failureCode: 'REQUEST_EXPIRED',
        externalRef, clientKey, periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * HOUR), lastPolledAt: new Date(Date.now() - HOUR),
      },
    });
    const proof = mmgTerminalProof(row, 'GYD', { status: 'expired', transactionId: externalRef, reference: clientKey, amountMinor: 1_200_000, currencyCode: 'GYD' },
      'LOOKUP', `fixture-lookup-${row.id}`, new Date(Date.now() - HOUR));
    return app.prisma.subscriptionPayment.update({ where: { id: row.id }, data: { failureRaw: { mmgTerminalEvidence: proof } } });
  }

  it('a FAILED row whose period has no outcome gets exactly one, and a second pass finds nothing', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    await terminalPayment(subId, due, 'EXPIRED'); // the pre-#994 crash shape
    const first = await billing.reconcileTerminalWithoutOutcome();
    expect(first.repaired).toBeGreaterThanOrEqual(1);
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: s.status, attempts: s.failedAttempts }).toEqual({ status: 'PAST_DUE', attempts: 1 });
    expect(await failedEvents(subId)).toBe(1);
    const again = await billing.reconcileTerminalWithoutOutcome();
    expect(await failedEvents(subId)).toBe(1);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).failedAttempts).toBe(1);
    expect(again.repaired).toBe(0);
  });

  it('a terminal row whose period already carries an outcome, or a success, is left alone', async () => {
    const due = new Date(Date.now() - 60_000);
    const withFailure = await makeMoverWithMmgSub({ due });
    await terminalPayment(withFailure.subId, due, 'FAILED');
    await app.prisma.billingEvent.create({ data: { subscriptionId: withFailure.subId, type: 'CHARGE_FAILED', amount: 12000, currencyCode: 'GYD', idempotencyKey: `failed:${withFailure.subId}:${due.toISOString().slice(0, 10)}:a0`, note: 'already applied' } });
    const withSuccess = await makeMoverWithMmgSub({ due });
    await terminalPayment(withSuccess.subId, due, 'FAILED');
    await app.prisma.billingEvent.create({ data: { subscriptionId: withSuccess.subId, type: 'CHARGE_SUCCESS', amount: 12000, currencyCode: 'GYD', idempotencyKey: `success:${withSuccess.subId}:${due.toISOString().slice(0, 10)}`, note: 'paid another way' } });
    await billing.reconcileTerminalWithoutOutcome();
    for (const { subId } of [withFailure, withSuccess]) {
      const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect({ status: s.status, attempts: s.failedAttempts }).toEqual({ status: 'ACTIVE', attempts: 0 });
    }
    expect(await failedEvents(withSuccess.subId)).toBe(0);
  });

  it('a gap on a subscription that has since left the live states is marked closed, never re-dunned', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    await terminalPayment(subId, due, 'EXPIRED');
    await app.prisma.subscription.update({ where: { id: subId }, data: { status: 'CANCELLED' } });
    const r = await billing.reconcileTerminalWithoutOutcome();
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: s.status, attempts: s.failedAttempts }).toEqual({ status: 'CANCELLED', attempts: 0 });
    expect(await failedEvents(subId)).toBe(0);
    expect((await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: subId } })).failureRaw)
      .toMatchObject({ subscriptionOutcome: 'PRESERVED_NO_DUNNING', subscriptionStatus: 'CANCELLED' });
  });

  it('preserved terminal markers are excluded before the 500-row repair cap', async () => {
    const due = new Date(Date.now() - 60_000);
    const closed = await makeMoverWithMmgSub({ due });
    await app.prisma.subscription.update({ where: { id: closed.subId }, data: { status: 'CANCELLED' } });
    const old = new Date(Date.now() - 20 * DAY);
    await app.prisma.subscriptionPayment.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        subscriptionId: closed.subId,
        amount: 12000,
        status: 'FAILED' as const,
        paymentMethod: 'MOBILE_MONEY' as const,
        failureCode: 'REQUEST_EXPIRED',
        failureRaw: { subscriptionOutcome: 'PRESERVED_NO_DUNNING', subscriptionStatus: 'CANCELLED' },
        periodStart: new Date(due.getTime() - i * 1000),
        periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(old.getTime() + i),
      })),
    });
    const live = await makeMoverWithMmgSub({ due });
    await terminalPayment(live.subId, due, 'EXPIRED');

    const result = await billing.reconcileTerminalWithoutOutcome();

    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: live.subId }, select: { status: true, failedAttempts: true } }))
      .toEqual({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(await failedEvents(live.subId)).toBe(1);
  });

  it('ordinary failure/success outcomes are excluded before the cap, including equal-createdAt rows', async () => {
    const handledDue = new Date(Date.now() - 5 * DAY);
    const failed = await makeMoverWithMmgSub({ due: handledDue });
    const paid = await makeMoverWithMmgSub({ due: handledDue });
    const old = new Date(Date.now() - 20 * DAY);
    const handledPayments = (subscriptionId: string, prefix: string) => Array.from({ length: 250 }, (_, i) => ({
      subscriptionId,
      amount: 12000,
      status: 'FAILED' as const,
      paymentMethod: 'MOBILE_MONEY' as const,
      failureCode: 'REQUEST_EXPIRED',
      externalRef: `${prefix}-${i}`,
      periodStart: handledDue,
      periodEnd: new Date(handledDue.getTime() + 7 * DAY),
      createdAt: old,
    }));
    await app.prisma.subscriptionPayment.createMany({
      data: [...handledPayments(failed.subId, 'handled-failure'), ...handledPayments(paid.subId, 'handled-success')],
    });
    const periodKey = handledDue.toISOString().slice(0, 10);
    await app.prisma.billingEvent.createMany({ data: [
      {
        subscriptionId: failed.subId, type: 'CHARGE_FAILED', amount: 12000, currencyCode: 'GYD',
        idempotencyKey: `failed:${failed.subId}:${periodKey}:a0`, note: 'already handled',
      },
      {
        subscriptionId: paid.subId, type: 'CHARGE_SUCCESS', amount: 12000, currencyCode: 'GYD',
        idempotencyKey: `success:${paid.subId}:${periodKey}`, note: 'already covered',
      },
    ] });
    const liveDue = new Date(Date.now() - 60_000);
    const live = await makeMoverWithMmgSub({ due: liveDue });
    await terminalPayment(live.subId, liveDue, 'EXPIRED');

    const result = await billing.reconcileTerminalWithoutOutcome();

    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: live.subId }, select: { status: true, failedAttempts: true } }))
      .toEqual({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(await failedEvents(live.subId)).toBe(1);
  });
});
