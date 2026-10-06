import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PaymentMethod, SubscriptionStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { sandboxResetMmg } from '../providers/mmg/mmg-provider';
import { subscriptionOperability, inoperableSubscriptionWhere, type OperabilitySubscription } from '../modules/subscription/operate-gate';
import { MMG_PAUSE_CLOCKS_KEY, syncMmgPauseClock } from '../modules/billing/mmg-pause';
import { activeOverdueMs, FULL_FEE_GRACE_MS } from '../modules/billing/dunning-clock';
import { mmgTerminalProof } from '../modules/billing/mmg-terminal-evidence';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [PROD-PATH] MMG fully OFF (MMG_DRIVER=disabled), the owner's ruling for a
// production launch before the live merchant keys arrive. For a partner on
// the MMG rail, billing is PAUSED — a true pause:
//   - nothing is charged (not even prepaid balance), nothing is written, no
//     failure is recorded, nobody is dunned, suspended, nudged or churned;
//   - the recovery paths (a recorded failure whose outcome never landed, the
//     terminal-failure repair) wait too, and apply exactly as before once MMG
//     is on again;
//   - the shared dunning clock is paused for the span, so the grace the
//     operate gate enforces is exactly what it was when MMG went off;
//   - once MMG is on, the paused week is billed exactly once.
// Subjects are stores (vendor subscriptions): their fee has one owner.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const PHONE_PREFIX = retainedPhonePrefix('18');

async function makeVendorSub(due: Date, opts: { msisdn?: string | null; method?: PaymentMethod; status?: SubscriptionStatus; extra?: Record<string, unknown> } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Off', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `MMG Off Store ${seq}`, slug: `mmg-off-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Pause Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const method = opts.method ?? 'MOBILE_MONEY';
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 12000,
      billingMethod: method,
      mmgPayerMsisdn: method === 'MOBILE_MONEY' ? (opts.msisdn === undefined ? `6091${String(seq).padStart(3, '0')}` : opts.msisdn) : null,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      ...(opts.extra ?? {}),
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
const sub = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const clockOf = (id: string) => app.prisma.billingDunningClock.findUnique({ where: { subscriptionId: id } });
const OFF = { MMG_DRIVER: 'disabled' };
const ON = { MMG_DRIVER: 'sandbox' };

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
  await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCKS_KEY } }).catch(() => {});
  try {
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      await cleanupBillingClocks(tx, goneSubs);
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } catch {
    // Retained money evidence may keep some scaffolding; the suite's rows are unique to this run.
  } finally {
    await app.close();
  }
});

/** Run `fn` with MMG switched off. */
async function whileOff<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv('MMG_DRIVER', 'disabled');
  try { return await fn(); } finally { vi.unstubAllEnvs(); }
}

describe('[PROD-PATH] MMG_DRIVER=disabled: the weekly fee on the MMG rail is paused', () => {
  it('pauses the charge: nothing written, no request to MMG, no failure, the period unmoved', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const due = new Date(Date.now() - 60_000);
      const subId = await makeVendorSub(due);
      expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
      expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
      expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
      expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reactivation bills the paused week exactly once: one request, one settlement, one period, across repeated runs', async () => {
    sandboxResetMmg();
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    await whileOff(async () => {
      for (let i = 0; i < 3; i += 1) {
        await syncMmgPauseClock(app.prisma, new Date(), OFF);
        await billing.runBillingCycle();
        await billing.pollPendingMmgCharges();
      }
    });
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      await syncMmgPauseClock(app.prisma, new Date(), ON);
      await billing.runBillingCycle();
      await billing.pollPendingMmgCharges();
    }
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ paymentMethod: 'MOBILE_MONEY', status: 'CAPTURED' });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
    const after = await sub(subId);
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect(after).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
  });

  it('owner ruling: after weeks with MMG off, reactivation bills ONE fee that covers the off weeks and the current week', async () => {
    sandboxResetMmg();
    const due = new Date(Date.now() - 20 * DAY); // three weeks fell due while MMG was off
    const subId = await makeVendorSub(due);
    await whileOff(async () => {
      await syncMmgPauseClock(app.prisma, new Date(), OFF);
      await billing.runBillingCycle();
    });
    const reactivatedAt = new Date();
    await syncMmgPauseClock(app.prisma, reactivatedAt, ON);
    for (let i = 0; i < 4; i += 1) {
      await billing.runBillingCycle();
      await billing.pollPendingMmgCharges();
    }
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'CAPTURED', periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
    expect(Number(payments[0]!.amount)).toBe(12000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
    const after = await sub(subId);
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 21 * DAY);
    expect(after.nextBillingDate.getTime()).toBeGreaterThan(reactivatedAt.getTime());
    expect(await app.prisma.billingDunningClock.findUnique({ where: { subscriptionId: subId } })).toMatchObject({ dueAt: new Date(due.getTime() + 21 * DAY) });
    // The reactivation is used once: the next fee is an ordinary week.
    expect(await app.prisma.platformConfig.findUnique({ where: { key: `billing.mmg_pause.reactivated:${subId}` } })).toBeNull();
  });

  it('nothing records a failure for an MMG-rail store while MMG is off, even a path past the walls', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    await expect(whileOff(async () => (billing as any).applyFailedCharge(await subWithRelations(subId), 12000, 'declined', new Date(), due.toISOString().slice(0, 10))))
      .rejects.toMatchObject({ code: 'MMG_DISABLED' });
    expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(0);
  });

  it('spends no prepaid balance while paused, and spends it once MMG is on', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(50000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
    expect((await sub(subId)).nextBillingDate.getTime()).toBe(due.getTime());
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('succeeded');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance)).toBe(38000);
  });

  it('a subscription with no MMG payer number is paused, never failed as "insufficient balance"', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due, { msisdn: null });
    expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(0);
    // MMG on: the same subscription is billed (and fails for want of a payer), so the pause was load-bearing.
    await billing.billSubscription((await subWithRelations(subId)) as any);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(1);
  });

  it('a recorded failure whose outcome never landed is not applied while paused (the duplicate-attempt recovery); it is once MMG is on', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    const periodKey = due.toISOString().slice(0, 10);
    await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_ATTEMPT', amount: 12000, currencyCode: 'GYD', idempotencyKey: `charge:${subId}:${periodKey}:a0` } });
    await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_FAILED', amount: 12000, currencyCode: 'GYD', idempotencyKey: `failed:${subId}:${periodKey}:a0`, note: 'declined' } });
    expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    await billing.billSubscription((await subWithRelations(subId)) as any);
    expect(await sub(subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
  });

  it('the terminal-failure repair does not dun while paused, and does once MMG is on', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    const periodKey = due.toISOString().slice(0, 10);
    // The attempt this request belongs to: its currency is what MMG's answer is checked against.
    await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'CHARGE_ATTEMPT', amount: 12000, currencyCode: 'GYD', idempotencyKey: `charge:${subId}:${periodKey}:a0` } });
    const payment = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'FAILED', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_declined_${nanoid(8)}`, clientKey: `sub:${subId}:${periodKey}:a0`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    // MMG's own declined answer, bound to this request: what the repair may act on.
    const evidence = { transactionId: payment.externalRef!, reference: payment.clientKey!, amountMinor: 1_200_000, currencyCode: 'GYD', status: 'declined' as const };
    await app.prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { failureRaw: { mmgTerminalEvidence: mmgTerminalProof(payment, 'GYD', evidence, 'LOOKUP', 'gen-1', new Date()) } } });
    const paused = await whileOff(() => billing.reconcileTerminalWithoutOutcome());
    expect(paused.repaired).toBe(0);
    expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' } })).toBe(0);
    await billing.reconcileTerminalWithoutOutcome();
    expect(await sub(subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
  });

  it('a suspended MMG-rail store is neither nudged nor churned while paused; once MMG is on it is', async () => {
    const longAgo = new Date(Date.now() - 40 * DAY);
    const subId = await makeVendorSub(longAgo, { status: 'SUSPENDED', extra: { suspendedAt: longAgo, failedAttempts: 3 } });
    await whileOff(() => billing.sweepSuspended());
    expect((await sub(subId)).status).toBe('SUSPENDED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId } })).toBe(0);
    await billing.sweepSuspended();
    expect((await sub(subId)).status).toBe('CHURNED');
  });

  it('the poller leaves every in-flight MMG row exactly as it was, unstamped', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    const rows = await Promise.all([
      app.prisma.subscriptionPayment.create({ data: {
        subscriptionId: subId, amount: 12000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmg-off-${nanoid(8)}`, clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), createdAt: new Date(Date.now() - 2 * DAY),
      } }),
      app.prisma.subscriptionPayment.create({ data: {
        subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'MOBILE_MONEY', clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), createdAt: new Date(Date.now() - 2 * DAY),
      } }),
    ]);
    const polled = await whileOff(() => billing.pollPendingMmgCharges());
    expect(polled.settled + polled.failed + polled.banked + polled.adopted).toBe(0);
    for (const before of rows) {
      const row = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: before.id } });
      expect(row).toMatchObject({ status: before.status, lastPolledAt: null, pollBackoffSec: before.pollBackoffSec, failureCode: null });
    }
  });
});

describe('[PROD-PATH] the operate gate holds an MMG-rail partner inside grace while MMG is off', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const lapsed: OperabilitySubscription = {
    status: 'PAST_DUE', gracePeriodEnd: new Date('2026-10-04T12:00:00.000Z'), billingEnforcementDueAt: new Date('2026-10-04T12:00:00.000Z'),
    billingConfirmationPausedAt: null, autoSuspendEnabled: true, autoRenew: true, currentPeriodEnd: new Date('2026-10-10T00:00:00.000Z'), billingMethod: 'MOBILE_MONEY',
  };

  it('MMG off: an MMG-rail partner whose grace ran out still operates; a cash partner does not', () => {
    expect(subscriptionOperability(lapsed, { missingRow: 'BLOCK' }, now, OFF)).toEqual({ operable: true });
    expect(subscriptionOperability({ ...lapsed, billingMethod: 'CASH' }, { missingRow: 'BLOCK' }, now, OFF)).toMatchObject({ operable: false, why: 'GRACE_LAPSED' });
  });

  it('MMG on: the lapse refuses as before', () => {
    expect(subscriptionOperability(lapsed, { missingRow: 'BLOCK' }, now, ON)).toMatchObject({ operable: false, why: 'GRACE_LAPSED' });
  });

  it('the hold is only about grace: suspended and billing-stopped partners stay refused', () => {
    expect(subscriptionOperability({ ...lapsed, status: 'SUSPENDED' }, { missingRow: 'BLOCK' }, now, OFF)).toMatchObject({ operable: false, why: 'STATUS' });
    expect(subscriptionOperability({ ...lapsed, status: 'ACTIVE', autoRenew: false, currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z') }, { missingRow: 'BLOCK' }, now, OFF)).toMatchObject({ operable: false, why: 'BILLING_STOPPED' });
  });

  it('the database form, run for real, matches the predicate for both rails', async () => {
    const graceGone = new Date(Date.now() - DAY);
    const extra = { gracePeriodEnd: graceGone, billingEnforcementDueAt: graceGone };
    const mmg = await makeVendorSub(new Date(Date.now() + 2 * DAY), { status: 'PAST_DUE', extra });
    const cash = await makeVendorSub(new Date(Date.now() + 2 * DAY), { status: 'PAST_DUE', method: 'CASH', extra });
    const blocked = async (env: Record<string, string>) => (await app.prisma.subscription.findMany({
      where: { id: { in: [mmg, cash] }, ...inoperableSubscriptionWhere(new Date(), env) }, select: { id: true },
    })).map((r) => r.id).sort();
    expect(await blocked(OFF)).toEqual([cash]);
    expect(await blocked(ON)).toEqual([mmg, cash].sort());
  });
});

describe('[PROD-PATH] the MMG-off pause holds the shared dunning clock for the span', () => {
  it('pauses an MMG-rail store\'s clock (not a cash one), accrues nothing while off, and resumes it with the grace it had', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCKS_KEY } });
    const t0 = new Date();
    const due = new Date(t0.getTime() - 10 * 3_600_000); // ten hours overdue
    const mmg = await makeVendorSub(due, { status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    const cash = await makeVendorSub(due, { status: 'PAST_DUE', method: 'CASH', extra: { failedAttempts: 1 } });

    expect(await syncMmgPauseClock(app.prisma, t0, OFF)).toMatchObject({ paused: true });
    const paused = (await clockOf(mmg))!;
    expect(paused.pausedAt?.getTime()).toBe(t0.getTime());
    const elapsedAtPause = Number(paused.elapsedMs);
    expect(elapsedAtPause).toBeGreaterThanOrEqual(10 * 3_600_000 - 1_000);
    expect((await sub(mmg)).billingConfirmationPausedAt?.getTime()).toBe(t0.getTime());
    expect((await clockOf(cash))?.pausedAt ?? null).toBeNull();

    // An hour later MMG is still off: nothing accrues, nothing is paused twice.
    const t1 = new Date(t0.getTime() + 3_600_000);
    await syncMmgPauseClock(app.prisma, t1, OFF);
    const still = (await clockOf(mmg))!;
    expect(Number(still.elapsedMs)).toBe(elapsedAtPause);
    expect(still.version).toBe(paused.version);

    // MMG on: resumed with exactly the overdue time it had at the pause.
    const t2 = new Date(t0.getTime() + 5 * 3_600_000);
    const on = await syncMmgPauseClock(app.prisma, t2, ON);
    expect(on.paused).toBe(false);
    expect(on.resumedNow).toBeGreaterThanOrEqual(1);
    const resumed = (await clockOf(mmg))!;
    expect(resumed.pausedAt).toBeNull();
    expect(activeOverdueMs(resumed, t2)).toBe(elapsedAtPause);
    const after = await sub(mmg);
    expect(after.billingConfirmationPausedAt).toBeNull();
    expect(after.billingEnforcementDueAt?.getTime()).toBe(t2.getTime() + FULL_FEE_GRACE_MS - elapsedAtPause);
    expect(await app.prisma.platformConfig.findUnique({ where: { key: MMG_PAUSE_CLOCKS_KEY } })).toBeNull();
  });

  it('two ticks at once pause a clock once', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCKS_KEY } });
    const t0 = new Date();
    const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    // Create the clock first (an earlier ordinary read), so both ticks find it running.
    await syncMmgPauseClock(app.prisma, t0, ON);
    await app.prisma.$transaction(async (tx) => (await import('../modules/billing/dunning-clock')).currentDunningClock(tx, id, t0));
    const before = (await clockOf(id))!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let firstRead!: () => void;
    const reading = new Promise<void>((resolve) => { firstRead = resolve; });
    const first = syncMmgPauseClock(app.prisma, t0, OFF, async (b) => { if (b === 'after-read') { firstRead(); await held; } });
    await reading;
    const second = syncMmgPauseClock(app.prisma, t0, OFF);
    await new Promise((r) => setTimeout(r, 400));
    release();
    await Promise.all([first, second]);
    const after = (await clockOf(id))!;
    expect(after.pausedAt).not.toBeNull();
    expect(after.version).toBe(before.version + 1);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
  });

  it('a clock this pause holds that has since gained another hold is left paused for that owner, and forgotten', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCKS_KEY } });
    const t0 = new Date();
    const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    await syncMmgPauseClock(app.prisma, t0, OFF);
    const paused = (await clockOf(id))!;
    expect(paused.pausedAt?.getTime()).toBe(t0.getTime());
    // A finance review now holds the same clock.
    await app.prisma.billingDunningClock.update({ where: { id: paused.id }, data: { authorityHoldReason: 'FINANCE_REVIEW', version: { increment: 1 } } });
    await syncMmgPauseClock(app.prisma, new Date(t0.getTime() + 60_000), ON);
    expect((await clockOf(id))!.pausedAt?.getTime()).toBe(t0.getTime());
    expect(await app.prisma.platformConfig.findUnique({ where: { key: MMG_PAUSE_CLOCKS_KEY } })).toBeNull();
    await app.prisma.billingDunningClock.update({ where: { id: paused.id }, data: { authorityHoldReason: null, version: { increment: 1 } } });
  });

  it('a clock paused by something else (a payment being confirmed) is never resumed by this pause', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCKS_KEY } });
    const t0 = new Date();
    const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    // Paused by its own owner before MMG went off.
    const clock = await app.prisma.$transaction(async (tx) => (await import('../modules/billing/dunning-clock')).currentDunningClock(tx, id, t0));
    await app.prisma.billingDunningClock.update({ where: { id: clock.id }, data: {
      elapsedMs: BigInt(activeOverdueMs(clock, t0)), runningSince: null, pausedAt: t0, version: { increment: 1 },
    } });
    await syncMmgPauseClock(app.prisma, new Date(t0.getTime() + 60_000), OFF);
    await syncMmgPauseClock(app.prisma, new Date(t0.getTime() + 120_000), ON);
    expect((await clockOf(id))!.pausedAt?.getTime()).toBe(t0.getTime());
  });
});
