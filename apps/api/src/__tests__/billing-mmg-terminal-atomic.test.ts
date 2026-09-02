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
import { SandboxMmgProvider } from '../providers/mmg/mmg-provider';
import { syntheticLocationOwner } from './helpers/online-mover';

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

/** A live MMG request whose sandbox lookup will come back with `outcome`. */
async function pendingPayment(subId: string, due: Date, outcome: 'reversed' | 'expired' | 'pending', ageMs = HOUR) {
  return app.prisma.subscriptionPayment.create({
    data: {
      subscriptionId: subId,
      amount: 12000,
      status: 'PENDING',
      paymentMethod: 'MOBILE_MONEY',
      externalRef: `mmgtx_${outcome}_amt1200000_${nanoid(8)}`,
      periodStart: due,
      periodEnd: new Date(due.getTime() + 7 * DAY),
      createdAt: new Date(Date.now() - ageMs),
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
  vi.restoreAllMocks();
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[M-04] the poller: terminal status and dunning outcome land together or not at all', () => {
  it('a crash after the terminal CAS rolls the payment back to PENDING — and the next tick applies exactly one outcome', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId, userId } = await makeMoverWithMmgSub({ due });
    const payment = await pendingPayment(subId, due, 'reversed');
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

  it('the suspending failure is one transition too: payment, event, SUSPENDED state, the rider offline, the SUSPENDED event', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId, riderId } = await makeMoverWithMmgSub({ due, failedAttempts: 2 }); // the third failure suspends
    const payment = await pendingPayment(subId, due, 'reversed');

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
    expect({ payment: p2.status, sub: s2.status, attempts: s2.failedAttempts, online: r2.isOnline, available: r2.isAvailable })
      .toEqual({ payment: 'FAILED', sub: 'SUSPENDED', attempts: 3, online: false, available: false });
    expect(s2.suspendedAt).not.toBeNull();
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'SUSPENDED' } })).toBe(1);
  });

  it('two pollers racing on the same terminal payment produce ONE outcome', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    await pendingPayment(subId, due, 'reversed');
    await Promise.all([billing.pollPendingMmgCharges(), billing.pollPendingMmgCharges()]);
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect({ status: s.status, failedAttempts: s.failedAttempts }).toEqual({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(await failedEvents(subId)).toBe(1);
  });

  it('an UNKNOWN request past its TTL expires and duns in one transition as well', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due });
    const unknown = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'MOBILE_MONEY',
        clientKey: `sub:${subId}:${due.toISOString().slice(0, 10)}:a0`, externalRef: null,
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
  it('a crash after the intent is marked FAILED rolls it back to UNKNOWN; the poller then expires it with exactly one outcome', async () => {
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

      // Reconciliation owns the uncertainty: past the TTL the poller expires
      // the intent and applies the one outcome, atomically.
      const polled = await billing.pollPendingMmgCharges(tick(25));
      expect(polled.failed).toBeGreaterThanOrEqual(1); // this intent, plus any other row this file left due
      const p = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
      const s2 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect({ payment: p.status, sub: s2.status, attempts: s2.failedAttempts }).toEqual({ payment: 'EXPIRED', sub: 'PAST_DUE', attempts: 1 });
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
