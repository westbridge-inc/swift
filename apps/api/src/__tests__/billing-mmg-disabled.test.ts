import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { syntheticLocationOwner } from './helpers/online-mover';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';
import { sandboxResetMmg } from '../providers/mmg/mmg-provider';
import { subscriptionOperability, inoperableSubscriptionWhere } from '../modules/subscription/operate-gate';
import { MMG_PAUSE_CLOCK_KEY, syncMmgPauseClock } from '../modules/billing/mmg-pause';

// ---------------------------------------------------------------------------
// [PROD-PATH] MMG fully OFF (MMG_DRIVER=disabled), the owner's ruling for a
// production launch before the live merchant keys arrive. The weekly fee on
// the MMG rail is then DEFERRED, exactly like a card while the card rail is
// off: no payment row, no request, no failure, no dunning, no period moved.
// And the poller, which would ask MMG about every in-flight row, leaves each
// one exactly as it was — an UNKNOWN stays UNKNOWN, a PENDING stays PENDING —
// so nothing a live MMG once accepted is ever judged without MMG's answer.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const PHONE_PREFIX = retainedPhonePrefix('18');

async function makeMoverWithMmgSub(due: Date, opts: { msisdn?: string | null; method?: 'MOBILE_MONEY' | 'CASH'; status?: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED'; extra?: Record<string, unknown> } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Off', lastName: `U${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('billing-mmg-off') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: opts.status ?? 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: opts.method ?? 'MOBILE_MONEY',
      mmgPayerMsisdn: opts.msisdn === undefined ? `6091${String(seq).padStart(3, '0')}` : opts.msisdn,
      ...(opts.extra ?? {}),
      currentPeriodStart: new Date(due.getTime() - 7 * DAY),
      currentPeriodEnd: due,
      nextBillingDate: due,
    },
  });
  subIds.push(sub.id);
  return sub.id;
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
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCK_KEY } }).catch(() => {});
  try {
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      const goneUsers = without(userIds, kept.userIds);
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.rider.deleteMany({ where: { userId: { in: goneUsers } } });
      await tx.user.deleteMany({ where: { id: { in: goneUsers } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});

describe('[PROD-PATH] MMG_DRIVER=disabled: the weekly fee on the MMG rail', () => {
  it('pauses the charge: nothing written, no request to MMG, no failure, the period unmoved', async () => {
    vi.stubEnv('MMG_DRIVER', 'disabled');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const due = new Date(Date.now() - 60_000);
      const subId = await makeMoverWithMmgSub(due);
      const outcome = await billing.billSubscription((await subWithRelations(subId)) as any);
      expect(outcome).toBe('pending');

      expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
      // A true pause: not even the attempt is recorded.
      expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
      const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(after.status).toBe('ACTIVE');
      expect(after.failedAttempts).toBe(0);
      expect(after.nextBillingDate.getTime()).toBe(due.getTime());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('reactivation bills the paused week exactly once: one request, one settlement, one period, across repeated runs', async () => {
    sandboxResetMmg();
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    // Paused: the hourly cycle and the poll job run three times and touch nothing.
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      for (let i = 0; i < 3; i += 1) {
        await billing.runBillingCycle();
        await billing.pollPendingMmgCharges();
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
    // MMG on again (the sandbox here): the cycle and the poller run three
    // more times — the paused week is requested once and settled once.
    for (let i = 0; i < 3; i += 1) {
      await billing.runBillingCycle();
      await billing.pollPendingMmgCharges();
    }
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ paymentMethod: 'MOBILE_MONEY', status: 'CAPTURED' });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect(after).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
  });

  it('spends no prepaid balance while paused, and spends it once MMG is on', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(50000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).nextBillingDate.getTime()).toBe(due.getTime());
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('succeeded');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(38000);
  });

  it('a subscription with no MMG payer number is paused, never failed as "insufficient balance"', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due, { msisdn: null });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    } finally {
      vi.unstubAllEnvs();
    }
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(0);
  });

  it('a recorded failure whose outcome never landed is not applied while paused (the duplicate-attempt recovery)', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    const periodKey = due.toISOString().slice(0, 10);
    await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_ATTEMPT', amount: 12000, currencyCode: 'GYD', idempotencyKey: `charge:${subId}:${periodKey}:a0` } });
    await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_FAILED', amount: 12000, currencyCode: 'GYD', idempotencyKey: `failed:${subId}:${periodKey}:a0`, note: 'declined' } });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    // MMG on: the recorded failure is applied as before (the pause holds it, never erases it).
    await billing.billSubscription((await subWithRelations(subId)) as any);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
  });

  it('the terminal-failure repair does not dun while paused, and does once MMG is on', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'FAILED', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_declined_${nanoid(8)}`, clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      const paused = await billing.reconcileTerminalWithoutOutcome();
      expect(paused.repaired).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(0);
    await billing.reconcileTerminalWithoutOutcome();
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
  });

  it('a suspended MMG-rail partner is neither nudged nor churned while paused; a cash one still is', async () => {
    const longAgo = new Date(Date.now() - 40 * DAY);
    const mmgSub = await makeMoverWithMmgSub(longAgo, { status: 'SUSPENDED', extra: { suspendedAt: longAgo } });
    const cashSub = await makeMoverWithMmgSub(longAgo, { status: 'SUSPENDED', method: 'CASH', msisdn: null, extra: { suspendedAt: longAgo } });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      await billing.sweepSuspended();
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: mmgSub } })).status).toBe('SUSPENDED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: mmgSub } })).toBe(0);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: cashSub } })).status).toBe('CHURNED');
  });

  it('the poller leaves every in-flight MMG row exactly as it was, unstamped', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    const pending = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmg-off-${nanoid(8)}`, clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * DAY),
      },
    });
    const unknown = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'MOBILE_MONEY',
        clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * DAY),
      },
    });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      const polled = await billing.pollPendingMmgCharges();
      expect(polled.settled + polled.failed + polled.banked + polled.adopted).toBe(0);
      for (const before of [pending, unknown]) {
        const row = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: before.id } });
        expect(row.status).toBe(before.status);
        expect(row.lastPolledAt).toBeNull();
        expect(row.pollBackoffSec).toBe(before.pollBackoffSec);
        expect(row.failureCode).toBeNull();
      }
      const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(after.nextBillingDate.getTime()).toBe(due.getTime());
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('[PROD-PATH] the operate gate holds an MMG-rail partner inside grace while MMG is off', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const lapsed = { status: 'PAST_DUE' as const, gracePeriodEnd: new Date('2026-10-04T12:00:00.000Z'), autoRenew: true, currentPeriodEnd: new Date('2026-10-10T00:00:00.000Z') };
  const off = { MMG_DRIVER: 'disabled' };
  const on = { MMG_DRIVER: 'live' };

  it('MMG off: an MMG-rail partner whose grace ran out still operates; a cash partner does not', () => {
    expect(subscriptionOperability({ ...lapsed, billingMethod: 'MOBILE_MONEY' }, { missingRow: 'BLOCK' }, now, off)).toEqual({ operable: true });
    expect(subscriptionOperability({ ...lapsed, billingMethod: 'CASH' }, { missingRow: 'BLOCK' }, now, off)).toMatchObject({ operable: false, why: 'GRACE_LAPSED' });
  });

  it('MMG on: the lapse refuses as before', () => {
    expect(subscriptionOperability({ ...lapsed, billingMethod: 'MOBILE_MONEY' }, { missingRow: 'BLOCK' }, now, on)).toMatchObject({ operable: false, why: 'GRACE_LAPSED' });
  });

  it('the hold is only about grace: suspended and billing-stopped partners stay refused', () => {
    expect(subscriptionOperability({ ...lapsed, status: 'SUSPENDED', billingMethod: 'MOBILE_MONEY' }, { missingRow: 'BLOCK' }, now, off)).toMatchObject({ operable: false, why: 'STATUS' });
    expect(subscriptionOperability({ ...lapsed, status: 'ACTIVE', autoRenew: false, currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'), billingMethod: 'MOBILE_MONEY' }, { missingRow: 'BLOCK' }, now, off)).toMatchObject({ operable: false, why: 'BILLING_STOPPED' });
  });

  it('the database form agrees: the lapsed-grace branch excludes the MMG rail only while MMG is off', () => {
    const offWhere = JSON.stringify(inoperableSubscriptionWhere(now, off));
    const onWhere = JSON.stringify(inoperableSubscriptionWhere(now, on));
    expect(offWhere).toContain('"billingMethod":{"not":"MOBILE_MONEY"}');
    expect(onWhere).not.toContain('billingMethod');
  });

  it('the database form, run for real, matches the predicate for both rails', async () => {
    const graceGone = new Date(Date.now() - DAY);
    const mmg = await makeMoverWithMmgSub(new Date(Date.now() + 2 * DAY), { status: 'PAST_DUE', extra: { gracePeriodEnd: graceGone } });
    const cash = await makeMoverWithMmgSub(new Date(Date.now() + 2 * DAY), { status: 'PAST_DUE', method: 'CASH', msisdn: null, extra: { gracePeriodEnd: graceGone } });
    const blocked = async (env: Record<string, string>) => (await app.prisma.subscription.findMany({
      where: { id: { in: [mmg, cash] }, ...inoperableSubscriptionWhere(new Date(), env) }, select: { id: true },
    })).map((r) => r.id).sort();
    expect(await blocked(off)).toEqual([cash]);
    expect(await blocked(on)).toEqual([mmg, cash].sort());
  });
});

describe('[PROD-PATH] the MMG-off pause clock holds every MMG-rail deadline for the span', () => {
  it('moves grace, retry and the churn clock by the elapsed span, only for the MMG rail, only while MMG is off, never twice', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCK_KEY } });
    const t0 = new Date('2026-10-05T10:00:00.000Z');
    const grace = new Date('2026-10-05T11:00:00.000Z');
    const retry = new Date('2026-10-05T11:00:00.000Z');
    const suspendedAt = new Date('2026-09-20T10:00:00.000Z');
    const pastDue = await makeMoverWithMmgSub(new Date(Date.now() + DAY), { status: 'PAST_DUE', extra: { gracePeriodEnd: grace, nextRetryAt: retry } });
    const suspended = await makeMoverWithMmgSub(new Date(Date.now() + DAY), { status: 'SUSPENDED', extra: { suspendedAt, nextRetryAt: retry } });
    const cash = await makeMoverWithMmgSub(new Date(Date.now() + DAY), { status: 'PAST_DUE', method: 'CASH', msisdn: null, extra: { gracePeriodEnd: grace, nextRetryAt: retry } });
    const off = { MMG_DRIVER: 'disabled' };
    const read = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id }, select: { gracePeriodEnd: true, nextRetryAt: true, suspendedAt: true } });

    expect(await syncMmgPauseClock(app.prisma, t0, off)).toMatchObject({ paused: true, movedMs: 0 });
    expect((await read(pastDue)).gracePeriodEnd!.getTime()).toBe(grace.getTime());
    // Ten minutes later, two workers tick at once: the first is held after it
    // has read the stored tick while the second runs; the span moves once.
    const t1 = new Date(t0.getTime() + 10 * 60_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let firstRead!: () => void;
    const reading = new Promise<void>((resolve) => { firstRead = resolve; });
    const first = syncMmgPauseClock(app.prisma, t1, off, async (b) => { if (b === 'after-read') { firstRead(); await held; } });
    await reading;
    const second = syncMmgPauseClock(app.prisma, t1, off);
    await new Promise((r) => setTimeout(r, 400));
    release();
    await Promise.all([first, second]);
    expect((await read(pastDue)).gracePeriodEnd!.getTime()).toBe(grace.getTime() + 10 * 60_000);
    expect((await read(pastDue)).nextRetryAt!.getTime()).toBe(retry.getTime() + 10 * 60_000);
    expect((await read(suspended)).suspendedAt!.getTime()).toBe(suspendedAt.getTime() + 10 * 60_000);
    expect((await read(suspended)).nextRetryAt!.getTime()).toBe(retry.getTime() + 10 * 60_000);
    expect((await read(cash)).gracePeriodEnd!.getTime()).toBe(grace.getTime());
    // A clock that steps backwards moves nothing.
    await syncMmgPauseClock(app.prisma, t0, off);
    expect((await read(pastDue)).gracePeriodEnd!.getTime()).toBe(grace.getTime() + 10 * 60_000);
    // MMG on: the clock row goes and nothing moves; the next pause starts fresh.
    const t2 = new Date(t1.getTime() + 60 * 60_000);
    expect(await syncMmgPauseClock(app.prisma, t2, { MMG_DRIVER: 'live' })).toMatchObject({ paused: false, movedMs: 0 });
    expect(await app.prisma.platformConfig.findUnique({ where: { key: MMG_PAUSE_CLOCK_KEY } })).toBeNull();
    expect((await read(pastDue)).gracePeriodEnd!.getTime()).toBe(grace.getTime() + 10 * 60_000);
  });
});
