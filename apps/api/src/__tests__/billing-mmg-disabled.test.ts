import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PaymentMethod, SubscriptionStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { sweepTrialFeeEducation } from '../modules/billing/trial-fee-education';
import { inJobContext, QUEUE_NAMES } from '../jobs/queue';
import type { Job } from 'bullmq';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { sandboxResetMmg } from '../providers/mmg/mmg-provider';
import { subscriptionOperability, inoperableSubscriptionWhere, type OperabilitySubscription } from '../modules/subscription/operate-gate';

/** A gate input that also carries the billing method, to prove the gate gives
 *  the same answer whatever it is (the gate itself never reads it). */
type GateRow = OperabilitySubscription & { billingMethod: PaymentMethod };
const gate = (row: GateRow, now: Date, env: Record<string, string>) => subscriptionOperability(row, { missingRow: 'BLOCK' }, now, env);
import { FEE_PAUSE_REPAIR_PREFIX, MMG_PAUSE_CLOCKS_KEY, feePauseHoldsBilling, feePauseStatus, syncMmgPauseClock } from '../modules/billing/mmg-pause';
import { activeOverdueMs, currentDunningClock, FULL_FEE_GRACE_MS } from '../modules/billing/dunning-clock';
import { mmgTerminalProof } from '../modules/billing/mmg-terminal-evidence';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { enqueueFeeDemand, handOffFeeDemand, persistFeeDemandInbox } from '../modules/billing/fee-demand-delivery';
import * as cardFactory from '../providers/card/card-rail-factory';

// ---------------------------------------------------------------------------
// [PROD-PATH] MMG fully OFF (MMG_DRIVER=disabled), the owner's ruling for a
// production launch before the live merchant keys arrive. With MMG off and no
// live card rail a partner has NO live way to pay, so (ruling of 6 Oct 2026)
// EVERY partner's weekly fee is PAUSED, whatever their billing method — a
// true pause:
//   - nothing is charged (not even prepaid balance), nothing is written, no
//     failure is recorded, nobody is dunned, suspended, nudged or churned;
//   - the recovery paths (a recorded failure whose outcome never landed, the
//     terminal-failure repair) wait too, and apply exactly as before once MMG
//     is on again;
//   - the shared dunning clock is paused for the span, so the grace the
//     operate gate enforces is exactly what it was when MMG went off;
//   - once MMG is on, the paused week is billed exactly once, and after weeks
//     off ONE fee covers the off weeks and the week in progress, whatever
//     order the billing jobs run in.
// The pause is decided by server facts only (the MMG driver and the card
// rail switches), never by anything a partner can set: their billing method,
// their card on file, or what their app says.
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

// Each case's stores leave billing when the case ends (the shared retire:
// cancelled, no renewal), so no later case bills or duns them. A case that
// runs the billing job (runBillingCycle, which bills EVERY due subscription
// in the database) must see only its own fixtures: otherwise the first run
// after a pause dunned the past-due stores earlier cases left due, and each
// final warning pages every admin in the database, so the case's time grew
// with the admins other suites had left behind, past the timeout.
afterEach(async () => {
  vi.unstubAllEnvs();
  if (subIds.length > 0) {
    await app.prisma.subscription.updateMany({ where: { id: { in: subIds }, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', autoRenew: false } });
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  // Close any pause this file opened (resuming every clock it held) so no
  // later suite runs under it, then drop this file's pause records.
  await syncMmgPauseClock(app.prisma, new Date(), ON).catch(() => {});
  await app.prisma.platformConfig.deleteMany({ where: { OR: [
    { key: MMG_PAUSE_CLOCKS_KEY }, { key: 'billing.mmg_pause.open' }, { key: { startsWith: 'billing.mmg_pause.reactivated:' } },
    { key: { startsWith: FEE_PAUSE_REPAIR_PREFIX } },
  ] } }).catch(() => {});
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

/** Run `fn` with MMG switched off (and, as in the test env, no live card rail): no live way to pay. */
async function whileOff<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv('MMG_DRIVER', 'disabled');
  try { return await fn(); } finally { vi.unstubAllEnvs(); }
}

/** Run `fn` with MMG switched off but the card rail live: partners have a live way to pay (a card). */
// This build has no real provider yet. These positive-path cases explicitly
// supply future factory support; merely configuring an unknown name must fail.
const CARD_LIVE = { MMG_DRIVER: 'disabled', CARD_RAIL_V2: '1', CARD_RAIL_KILL: '0', PAYMENT_PROVIDER: 'sandbox', CARD_RAIL_PROVIDER: 'powertranz' };
async function whileCardLive<T>(fn: () => Promise<T>): Promise<T> {
  const supported = vi.spyOn(cardFactory, 'cardRailProviderNames').mockReturnValue(['simulator', 'powertranz']);
  for (const [k, v] of Object.entries(CARD_LIVE)) vi.stubEnv(k, v);
  try { return await fn(); } finally { supported.mockRestore(); vi.unstubAllEnvs(); }
}

/** Start from no pause: close any pause an earlier case left open. */
async function noPauseOpen(): Promise<void> {
  await syncMmgPauseClock(app.prisma, new Date(), ON);
  await app.prisma.platformConfig.deleteMany({ where: { OR: [
    { key: { in: [MMG_PAUSE_CLOCKS_KEY, 'billing.mmg_pause.open'] } }, { key: { startsWith: FEE_PAUSE_REPAIR_PREFIX } },
  ] } });
}
const events = (subscriptionId: string, type?: 'CHARGE_FAILED' | 'CHARGE_SUCCESS' | 'REMINDER' | 'SUSPENDED' | 'CHURNED') =>
  app.prisma.billingEvent.count({ where: { subscriptionId, ...(type ? { type } : {}) } });
const balanceOf = async (subscriptionId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } })).balance);

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

  it('the charge itself refuses while the fee is paused, past the billing entry\'s wall: no prepaid spend', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    expect(await whileOff(async () => (billing as any).attemptCharge(await subWithRelations(subId), 12000, new Date()))).toEqual({ ok: false, deferred: true });
    expect(await balanceOf(subId)).toBe(50000);
  });

  it('nothing records a failure for a store while its fee is paused, even a path past the walls', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    await expect(whileOff(async () => (billing as any).applyFailedCharge(await subWithRelations(subId), 12000, 'declined', new Date(), due.toISOString().slice(0, 10))))
      .rejects.toMatchObject({ code: 'FEE_PAUSED' });
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

describe('[PROD-PATH] the operate gate holds every partner inside grace while their fee is paused', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const lapsed: GateRow = {
    status: 'PAST_DUE', gracePeriodEnd: new Date('2026-10-04T12:00:00.000Z'), billingEnforcementDueAt: new Date('2026-10-04T12:00:00.000Z'),
    billingConfirmationPausedAt: null, autoSuspendEnabled: true, autoRenew: true, currentPeriodEnd: new Date('2026-10-10T00:00:00.000Z'), billingMethod: 'MOBILE_MONEY',
  };

  it('MMG off and no live card: a partner whose grace ran out still operates, whatever their billing method', () => {
    for (const billingMethod of ['MOBILE_MONEY', 'CASH', 'CARD'] as const) {
      expect(gate({ ...lapsed, billingMethod }, now, OFF), billingMethod).toEqual({ operable: true });
    }
  });

  it('MMG on: the lapse refuses as before', () => {
    expect(subscriptionOperability(lapsed, { missingRow: 'BLOCK' }, now, ON)).toMatchObject({ operable: false, why: 'GRACE_LAPSED' });
  });

  it('the hold is only about grace: suspended and billing-stopped partners stay refused', () => {
    expect(subscriptionOperability({ ...lapsed, status: 'SUSPENDED' }, { missingRow: 'BLOCK' }, now, OFF)).toMatchObject({ operable: false, why: 'STATUS' });
    expect(subscriptionOperability({ ...lapsed, status: 'ACTIVE', autoRenew: false, currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z') }, { missingRow: 'BLOCK' }, now, OFF)).toMatchObject({ operable: false, why: 'BILLING_STOPPED' });
  });

  it('the database form, run for real, matches the predicate for every billing method', async () => {
    const graceGone = new Date(Date.now() - DAY);
    const extra = { gracePeriodEnd: graceGone, billingEnforcementDueAt: graceGone };
    const mmg = await makeVendorSub(new Date(Date.now() + 2 * DAY), { status: 'PAST_DUE', extra });
    const cash = await makeVendorSub(new Date(Date.now() + 2 * DAY), { status: 'PAST_DUE', method: 'CASH', extra });
    const blocked = async (env: Record<string, string>) => (await app.prisma.subscription.findMany({
      where: { id: { in: [mmg, cash] }, ...inoperableSubscriptionWhere(new Date(), env) }, select: { id: true },
    })).map((r) => r.id).sort();
    expect(await blocked(OFF)).toEqual([]);
    expect(await blocked(ON)).toEqual([mmg, cash].sort());
  });
});

describe('[PROD-PATH] the MMG-off pause holds the shared dunning clock for the span', () => {
  it('pauses every due store\'s clock (a cash one too), accrues nothing while off, and resumes it with the grace it had', async () => {
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
    expect((await clockOf(cash))?.pausedAt?.getTime()).toBe(t0.getTime());
    expect((await sub(cash)).billingConfirmationPausedAt?.getTime()).toBe(t0.getTime());

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
    expect((await clockOf(cash))!.pausedAt).toBeNull();
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

// ---------------------------------------------------------------------------
// [PROD-PATH · ruling 6 Oct 2026] While a partner has NO live way to pay (MMG
// off and no live card rail; agent cash and top-ups are hidden), their fee is
// PAUSED for EVERY billing method, cash included: no dunning, no PAST_DUE or
// grace lapse, no suspension, no churn. On resume only the current week is
// billed, regardless of job ordering.
// ---------------------------------------------------------------------------
describe('[PROD-PATH · 6 Oct ruling] no live way to pay pauses every partner\'s fee, cash included', () => {
  it('a cash store\'s due fee is paused: nothing spent, no failure, no PAST_DUE, the period unmoved', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(await whileOff(async () => billing.runBillingCycle())).toMatchObject({ failed: 0, suspended: 0 });
    expect(await events(subId)).toBe(0);
    expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due });
  });

  it('a card store with no card on file is paused the same way (the card rail is not live)', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due, { method: 'CARD' });
    expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(await events(subId)).toBe(0);
    expect(await sub(subId)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
  });

  it('a cash store past its grace is not suspended while paused; once a pay path is live it is', async () => {
    const due = new Date(Date.now() - 3 * DAY);
    const subId = await makeVendorSub(due, { method: 'CASH', status: 'PAST_DUE', extra: { failedAttempts: 3, nextRetryAt: new Date(Date.now() - 60_000) } });
    expect(await whileOff(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(await whileOff(async () => billing.runBillingCycle())).toMatchObject({ suspended: 0 });
    // The grace path itself refuses too, past the billing entry's wall.
    expect(await whileOff(async () => (billing as any).finishExhaustedGrace(await subWithRelations(subId), new Date()))).toBe('pending');
    expect(await sub(subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 3 });
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('suspended');
  });

  it('a suspended cash store is neither nudged nor churned while paused; once a pay path is live it is', async () => {
    const longAgo = new Date(Date.now() - 40 * DAY);
    const subId = await makeVendorSub(longAgo, { method: 'CASH', status: 'SUSPENDED', extra: { suspendedAt: longAgo, failedAttempts: 3 } });
    await whileOff(() => billing.sweepSuspended());
    expect((await sub(subId)).status).toBe('SUSPENDED');
    expect(await events(subId)).toBe(0);
    await billing.sweepSuspended();
    expect((await sub(subId)).status).toBe('CHURNED');
  });

  it('no "fee due soon" reminder while the fee is paused (it would name a fee nobody can pay); one once a pay path is live', async () => {
    const subId = await makeVendorSub(new Date(Date.now() + 12 * 3_600_000), { method: 'CASH' });
    await whileOff(() => billing.sendUpcomingReminders());
    expect(await events(subId, 'REMINDER')).toBe(0);
    await billing.sendUpcomingReminders();
    expect(await events(subId, 'REMINDER')).toBe(1);
  });

  it('no trial fee education while the fee is paused; it is sent once a pay path is live', async () => {
    const trialEnd = new Date(Date.now() + 2 * DAY);
    const subId = await makeVendorSub(trialEnd, { method: 'CASH', status: 'TRIAL', extra: { isTrialActive: true, trialEndDate: trialEnd } });
    const notifications = new NotificationService(app.prisma, app.io);
    await whileOff(() => sweepTrialFeeEducation(app.prisma, notifications));
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, idempotencyKey: { startsWith: 'trialedu:' } } })).toBe(0);
    await sweepTrialFeeEducation(app.prisma, notifications);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, idempotencyKey: { startsWith: 'trialedu:' } } })).toBe(1);
  });

  it('a delayed trial conversion AFTER resume pays only ONE fee through the current week', async () => {
    await noPauseOpen();
    const resumedAt = new Date();
    const trialEnd = new Date(resumedAt.getTime() - 20 * DAY);
    const subId = await makeVendorSub(trialEnd, { method: 'CASH', status: 'TRIAL', extra: { isTrialActive: true, trialEndDate: trialEnd } });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    // Conversion is backlogged for the entire outage, including the resume tick.
    await syncMmgPauseClock(app.prisma, new Date(trialEnd.getTime() - DAY), OFF);
    await syncMmgPauseClock(app.prisma, resumedAt, ON);
    expect((await sub(subId)).status).toBe('TRIAL');
    await new SubscriptionService(app.prisma).convertExpiredTrials(resumedAt);
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'CAPTURED', periodStart: trialEnd, periodEnd: new Date(trialEnd.getTime() + 21 * DAY) });
    expect(await balanceOf(subId)).toBe(38000);
    expect((await sub(subId)).nextBillingDate.getTime()).toBeGreaterThan(resumedAt.getTime());
  });

  it('a trial that ends during the pause converts and operates, owes nothing while paused, then pays ONE fee through the current week', async () => {
    await noPauseOpen();
    const trialEnd = new Date(Date.now() - 10 * DAY);
    const subId = await makeVendorSub(trialEnd, { method: 'CASH', status: 'TRIAL', extra: { isTrialActive: true, trialEndDate: trialEnd } });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    await whileOff(async () => {
      await new SubscriptionService(app.prisma).convertExpiredTrials();
      await syncMmgPauseClock(app.prisma, new Date(), OFF);
      await billing.runBillingCycle();
      await billing.sweepSuspended();
    });
    const paused = await sub(subId);
    expect(paused).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(subscriptionOperability(paused, { missingRow: 'BLOCK' }, new Date(), OFF)).toEqual({ operable: true });
    expect(await events(subId)).toBe(0);
    expect(await balanceOf(subId)).toBe(50000);
    const reactivatedAt = new Date();
    await syncMmgPauseClock(app.prisma, reactivatedAt, ON);
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'CAPTURED', periodStart: trialEnd, periodEnd: new Date(trialEnd.getTime() + 14 * DAY) });
    expect(await balanceOf(subId)).toBe(38000);
    expect((await sub(subId)).nextBillingDate.getTime()).toBeGreaterThan(reactivatedAt.getTime());
  });
});

describe('[PROD-PATH] the pause is decided by server facts only: nothing a partner sets pauses their fee', () => {
  it.each(['powertranz', 'typo-provider'])('a provider rejected by the card factory (%s) never unpauses fees', async (provider) => {
    const { noLivePayPath } = await import('../modules/billing/fee-pause');
    const env = { ...CARD_LIVE, CARD_RAIL_PROVIDER: provider };
    expect(() => cardFactory.getCardRailProvider({ redis: app.redis }, env)).toThrow('Unknown CARD_RAIL_PROVIDER');
    expect(noLivePayPath(env)).toBe(true);
  });
  it('the predicate reads only the server\'s MMG driver and card-rail switches', async () => {
    const { noLivePayPath } = await import('../modules/billing/fee-pause');
    expect(noLivePayPath({ MMG_DRIVER: 'disabled' })).toBe(true);
    expect(noLivePayPath({ MMG_DRIVER: 'disabled', CARD_RAIL_V2: '1', CARD_RAIL_KILL: '1' })).toBe(true);
    expect(noLivePayPath({ MMG_DRIVER: 'disabled', CARD_RAIL_V2: '1', PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '1' })).toBe(true);
    await whileCardLive(async () => {
      expect(noLivePayPath(CARD_LIVE)).toBe(false);
      expect(noLivePayPath({ ...CARD_LIVE, CARD_RAIL_KILL: '1' })).toBe(true);
      expect(noLivePayPath({ ...CARD_LIVE, CARD_RAIL_V2: '0' })).toBe(true);
      expect(noLivePayPath({ ...CARD_LIVE, PAYMENT_PROVIDER: 'disabled' })).toBe(true);
    });
    // The card simulator (test pages for listed test subscriptions, no money) or no provider at all is no way to pay.
    expect(noLivePayPath({ ...CARD_LIVE, CARD_RAIL_PROVIDER: 'simulator' })).toBe(true);
    expect(noLivePayPath({ ...CARD_LIVE, CARD_RAIL_PROVIDER: '' })).toBe(true);
    expect(noLivePayPath({ ...CARD_LIVE, CARD_RAIL_PROVIDER: undefined })).toBe(true);
    expect(noLivePayPath({ MMG_DRIVER: 'live' })).toBe(false);
    expect(noLivePayPath({ MMG_DRIVER: 'live', CARD_RAIL_KILL: '1', PAYMENT_PROVIDER: 'disabled' })).toBe(false);
    expect(noLivePayPath({})).toBe(false);
  });

  it('MMG on: a cash store with no card and no balance is billed as ever (and fails for want of money) — never paused', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('failed');
    expect(await events(subId, 'CHARGE_FAILED')).toBe(1);
    expect((await sub(subId)).status).toBe('PAST_DUE');
  });

  it('MMG off but the card rail live: an MMG-rail store is NOT paused (its billing method is its own choice) — it is dunned, and nothing reaches MMG', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const due = new Date(Date.now() - 60_000);
      const subId = await makeVendorSub(due);
      expect(await whileCardLive(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('failed');
      expect(await events(subId, 'CHARGE_FAILED')).toBe(1);
      expect(await sub(subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
      expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('MMG off but the card rail live: an MMG request already in flight for the week waits for MMG, never failed under it', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due);
    await app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: subId, amount: 12000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
      externalRef: `mmg-inflight-${nanoid(8)}`, clientKey: `mmg-inflight-${nanoid(12)}`,
      periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
    } });
    expect(await whileCardLive(async () => billing.billSubscription((await subWithRelations(subId)) as any))).toBe('pending');
    expect(await events(subId, 'CHARGE_FAILED')).toBe(0);
  });

  it('MMG off but the card rail live: a card store that removed its card is NOT paused — it is dunned for want of a card', async () => {
    const withRail = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider(), {}, () => ({}) as never);
    const due = new Date(Date.now() - 60_000);
    const subId = await makeVendorSub(due, { method: 'CARD' });
    expect(await whileCardLive(async () => withRail.billSubscription((await subWithRelations(subId)) as any))).toBe('failed');
    expect(await events(subId, 'CHARGE_FAILED')).toBe(1);
    expect((await sub(subId)).status).toBe('PAST_DUE');
  });

  it('MMG off but the card rail live: the operate gate enforces a lapsed grace for every billing method', async () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    const lapsed: GateRow = {
      status: 'PAST_DUE', gracePeriodEnd: new Date('2026-10-04T12:00:00.000Z'), billingEnforcementDueAt: new Date('2026-10-04T12:00:00.000Z'),
      billingConfirmationPausedAt: null, autoSuspendEnabled: true, autoRenew: true, currentPeriodEnd: new Date('2026-10-10T00:00:00.000Z'), billingMethod: 'MOBILE_MONEY',
    };
    await whileCardLive(async () => {
      for (const billingMethod of ['MOBILE_MONEY', 'CASH', 'CARD'] as const) {
        expect(gate({ ...lapsed, billingMethod }, now, CARD_LIVE), billingMethod).toMatchObject({ operable: false, why: 'GRACE_LAPSED' });
      }
    });
  });

  it('MMG off but the card rail live: the pause tick pauses nobody', async () => {
    await noPauseOpen();
    const t0 = new Date();
    const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { method: 'CASH', status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    expect(await whileCardLive(() => syncMmgPauseClock(app.prisma, t0, CARD_LIVE))).toMatchObject({ paused: false, pausedNow: 0 });
    expect((await clockOf(id))?.pausedAt ?? null).toBeNull();
  });
});

describe('[PROD-PATH] queued demands respect the platform pause at delivery', () => {
  it.each(['billing_reminder', 'trial_fee_education'] as const)('holds an already queued %s before the pause tick and throughout a pending resume', async (kind) => {
    await noPauseOpen();
    const due = new Date(Date.now() + 12 * 3_600_000);
    const id = await makeVendorSub(due, { method: 'CASH', status: kind === 'trial_fee_education' ? 'TRIAL' : 'ACTIVE', extra: kind === 'trial_fee_education' ? { isTrialActive: true, trialEndDate: due } : {} });
    const row = await subWithRelations(id);
    const userId = row.vendor!.owner.userId;
    const notice = await enqueueFeeDemand(app.prisma, { userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Weekly fee', body: 'Synthetic queued fee notice', data: { kind, subscriptionId: id }, feeStageKey: `queued:${kind}` });
    const delivery = vi.fn(async () => 'local handoff');
    const assertHeld = async () => {
      expect(await persistFeeDemandInbox(app.prisma, notice.id)).toBeNull();
      expect(await handOffFeeDemand(app.prisma, notice.id, 'sms', 'body', delivery)).toBeUndefined();
      expect(delivery).not.toHaveBeenCalled();
      expect(await app.prisma.notification.count({ where: { userId, dedupeKey: `fee-demand:${notice.id}` } })).toBe(0);
      expect((await app.prisma.billingFeeNotice.findUniqueOrThrow({ where: { id: notice.id } })).status).toBe('PENDING');
    };
    await whileOff(async () => {
      await assertHeld(); // flags changed; no tick has run yet
      await syncMmgPauseClock(app.prisma, new Date(), OFF);
      expect((await clockOf(id))!.pausedAt).toBeNull(); // future due: no per-clock pause
      await assertHeld();
    });
    await assertHeld(); // pay path live, but the open span has not been closed
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    expect(await persistFeeDemandInbox(app.prisma, notice.id)).toEqual(expect.any(String));
    expect(await handOffFeeDemand(app.prisma, notice.id, 'sms', 'body', delivery)).toBe('local handoff');
    await handOffFeeDemand(app.prisma, notice.id, 'sms', 'body', delivery);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('an open span holds churn, upcoming reminders and trial education until resume completes', async () => {
    await noPauseOpen();
    await syncMmgPauseClock(app.prisma, new Date(), OFF);
    // These subscriptions were not visited by the pause tick.
    const longAgo = new Date(Date.now() - 40 * DAY);
    const suspended = await makeVendorSub(longAgo, { method: 'CASH', status: 'SUSPENDED', extra: { suspendedAt: longAgo, failedAttempts: 3 } });
    const upcoming = await makeVendorSub(new Date(Date.now() + 12 * 3_600_000), { method: 'CASH' });
    const trialEnd = new Date(Date.now() + 2 * DAY);
    const trial = await makeVendorSub(trialEnd, { method: 'CASH', status: 'TRIAL', extra: { isTrialActive: true, trialEndDate: trialEnd } });
    await billing.sweepSuspended();
    await billing.sendUpcomingReminders();
    await sweepTrialFeeEducation(app.prisma, new NotificationService(app.prisma, app.io));
    expect((await sub(suspended)).status).toBe('SUSPENDED');
    for (const id of [suspended, upcoming, trial]) expect(await events(id)).toBe(0);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    await billing.sweepSuspended();
    await billing.sendUpcomingReminders();
    await sweepTrialFeeEducation(app.prisma, new NotificationService(app.prisma, app.io));
    expect((await sub(suspended)).status).toBe('CHURNED');
    expect(await events(upcoming, 'REMINDER')).toBe(1);
    expect(await events(trial, 'REMINDER')).toBe(1);
  });
});

describe('[PROD-PATH] each pause and resume is on the record, and admins see it', () => {
  it('the audit log records the platform pause once, each paused fee, the resume, and each resumed fee', async () => {
    await noPauseOpen();
    const t0 = new Date();
    const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { method: 'CASH', status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    await syncMmgPauseClock(app.prisma, t0, OFF);
    await syncMmgPauseClock(app.prisma, new Date(t0.getTime() + 60_000), OFF);
    const audit = (action: string, entityId?: string) => app.prisma.auditLog.findMany({ where: { action, ...(entityId ? { entityId } : { changes: { path: ['since'], equals: t0.toISOString() } }) } });
    expect(await audit('BILLING_FEE_PAUSE_STARTED')).toHaveLength(1);
    const paused = await audit('BILLING_FEE_PAUSED', id);
    expect(paused).toHaveLength(1);
    expect(paused[0]!.changes).toMatchObject({ reason: 'NO_LIVE_PAY_PATH' });
    const t1 = new Date(t0.getTime() + 120_000);
    await syncMmgPauseClock(app.prisma, t1, ON);
    const ended = await audit('BILLING_FEE_PAUSE_ENDED');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.changes).toMatchObject({ since: t0.toISOString(), until: t1.toISOString() });
    expect(await audit('BILLING_FEE_RESUMED', id)).toHaveLength(1);
  });

  it('the pause tick runs as the poll job\'s named system work: where unbound access is refused, the job still pauses and resumes', async () => {
    await noPauseOpen();
    const t0 = new Date();
    const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { method: 'CASH', status: 'PAST_DUE', extra: { failedAttempts: 1 } });
    const asPollJob = (env: Record<string, string>, at: Date) => inJobContext(QUEUE_NAMES.SUBSCRIPTION, async () => { await syncMmgPauseClock(app.prisma, at, env); });
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', 'deny');
    try {
      // Not vacuous: unbound, the tenant wall refuses the clock, so nothing is paused.
      expect(await syncMmgPauseClock(app.prisma, t0, OFF)).toMatchObject({ pausedNow: 0 });
      await asPollJob(OFF, t0)({ name: 'poll-mmg-billing', data: {} } as Job);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await clockOf(id))?.pausedAt?.getTime()).toBe(t0.getTime());
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', 'deny');
    try {
      await asPollJob(ON, new Date(t0.getTime() + 60_000))({ name: 'poll-mmg-billing', data: {} } as Job);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await clockOf(id))!.pausedAt).toBeNull();
    expect(await app.prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_pause.open' } })).toBeNull();
  });

  it('GET /admin/billing/fee-pause tells an admin whether fees are paused, since when, and how many fees the pause holds', async () => {
    await noPauseOpen();
    const admin = Fastify({ logger: false });
    registerErrorHandler(admin);
    await admin.register(prismaPlugin);
    await admin.register(redisPlugin);
    await admin.register(authPlugin);
    await admin.register(socketPlugin);
    await admin.register(adminRoutes, { prefix: '/api/v1/admin' });
    await admin.ready();
    try {
      seq += 1;
      const user = await admin.prisma.user.create({ data: {
        phone: `${PHONE_PREFIX}8${String(seq).padStart(2, '0')}`, firstName: 'Fee', lastName: 'Admin',
        roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(),
        admin: { create: { permissions: ['*'] } },
      } });
      userIds.push(user.id);
      const token = admin.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
      await admin.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `feepause-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
      const get = () => admin.inject({ method: 'GET', url: '/api/v1/admin/billing/fee-pause', headers: { authorization: `Bearer ${token}` } });

      const idle = await get();
      expect(idle.statusCode).toBe(200);
      expect(idle.json().data).toMatchObject({ paused: false, resumePending: false, since: null });

      const t0 = new Date();
      const id = await makeVendorSub(new Date(t0.getTime() - 3_600_000), { method: 'CASH' });
      await syncMmgPauseClock(app.prisma, t0, OFF);
      const on = await whileOff(get);
      expect(on.statusCode).toBe(200);
      const data = on.json().data;
      expect(data).toMatchObject({ paused: true, reason: 'NO_LIVE_PAY_PATH', since: t0.toISOString() });
      expect(data.pausedSubscriptions).toBeGreaterThanOrEqual(1);
      expect(data.pausedSubscriptions).toBe(await app.prisma.billingDunningClock.count({ where: { pausedAt: { not: null }, id: { in: ((await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: MMG_PAUSE_CLOCKS_KEY } })).value as string[]) } } }));
      expect((await clockOf(id))?.pausedAt?.getTime()).toBe(t0.getTime());
      // The pay path is back but the resume tick has not run: billing still waits, and the admin is told.
      const pending = await get();
      expect(pending.json().data).toMatchObject({ paused: false, resumePending: true });
      // Partners cannot reach it.
      expect((await admin.inject({ method: 'GET', url: '/api/v1/admin/billing/fee-pause' })).statusCode).toBe(401);
    } finally {
      await syncMmgPauseClock(app.prisma, new Date(), ON);
      await admin.close();
    }
  });
});

describe('[PROD-PATH] resume ordering: on resume only the current week is billed, whatever runs first', () => {
  it.each(['paused retry', 'resume'] as const)('a failed clock pause repaired on %s preserves the minute of grace that remained', async (repair) => {
    await noPauseOpen();
    const t0 = new Date(Date.now() - 120_000);
    const due = new Date(t0.getTime() - FULL_FEE_GRACE_MS + 60_000);
    const subId = await makeVendorSub(due, { method: 'CASH', status: 'PAST_DUE', extra: { failedAttempts: 3 } });
    await app.prisma.$transaction((tx) => currentDunningClock(tx, subId, t0));
    await syncMmgPauseClock(app.prisma, t0, OFF, async (boundary) => {
      if (boundary === 'after-read') throw new Error('injected: clock pause rolled back');
    });
    expect((await clockOf(subId))?.pausedAt ?? null).toBeNull();
    const resume = new Date(t0.getTime() + 120_000);
    if (repair === 'paused retry') await syncMmgPauseClock(app.prisma, new Date(t0.getTime() + 90_000), OFF);
    await syncMmgPauseClock(app.prisma, resume, ON);
    const clock = (await clockOf(subId))!;
    expect(clock).not.toBeNull();
    expect(activeOverdueMs(clock, resume)).toBe(FULL_FEE_GRACE_MS - 60_000);
    expect((await sub(subId)).billingEnforcementDueAt).toEqual(new Date(resume.getTime() + 60_000));
    expect(await (billing as any).finishExhaustedGrace(await subWithRelations(subId), new Date(resume.getTime() + 1))).toBe('pending');
    expect((await sub(subId)).status).toBe('PAST_DUE');
    expect(await events(subId, 'SUSPENDED')).toBe(0);
  });

  it('a fee whose clock can never be paused (a trial whose owner is gone) holds ONLY itself: the pause ends and everyone else bills', async () => {
    await noPauseOpen();
    const t0 = new Date(Date.now() - 120_000);
    // An owner's deletion sets the subscription's owner to NULL; the conversion
    // job already skips such a trial (no valid payer). Its clock cannot be read.
    const ended = new Date(t0.getTime() - DAY);
    const orphan = (await app.prisma.subscription.create({ data: {
      type: 'RESTAURANT', status: 'TRIAL', isTrialActive: true, trialEndDate: ended, weeklyRate: 12000, billingMethod: 'CASH',
      currentPeriodStart: new Date(ended.getTime() - 14 * DAY), currentPeriodEnd: ended, nextBillingDate: ended,
    } })).id;
    subIds.push(orphan);
    const due = new Date(Date.now() - 20 * DAY);
    const other = await makeVendorSub(due, { method: 'CASH' });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: other, balance: 50000, currencyCode: 'GYD' } });
    await syncMmgPauseClock(app.prisma, t0, OFF);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    // The pause is over: one unreadable clock never holds any other partner's billing.
    expect(await app.prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_pause.open' } })).toBeNull();
    expect(await feePauseHoldsBilling(app.prisma, other)).toBe(false);
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: other } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'CAPTURED', periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
    // Its own fee waits alone, on a record naming the pause start, and an admin is told.
    expect((await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: `${FEE_PAUSE_REPAIR_PREFIX}${orphan}` } })).value).toEqual({ since: t0.toISOString() });
    expect(await feePauseHoldsBilling(app.prisma, orphan)).toBe(true);
    expect((await feePauseStatus(app.prisma)).awaitingRepair).toBe(1);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    expect(await feePauseHoldsBilling(app.prisma, orphan)).toBe(true);
  });

  it.each(['after', 'during'] as const)('a clock that could not be paused waits alone, and is paused from the FIRST pause start when repaired %s a second pause', async (when) => {
    await noPauseOpen();
    const t0 = new Date(Date.now() - 10 * 60_000);
    const stuck = await makeVendorSub(new Date(t0.getTime() - FULL_FEE_GRACE_MS + 60_000), { method: 'CASH', status: 'PAST_DUE', extra: { failedAttempts: 3 } });
    const failStuck = async (boundary: string, id?: string) => { if (boundary === 'after-read' && id === stuck) throw new Error('injected: this clock cannot be paused'); };
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    await syncMmgPauseClock(app.prisma, t0, OFF, failStuck);
    await syncMmgPauseClock(app.prisma, at(2), ON, failStuck);
    expect(await app.prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_pause.open' } })).toBeNull();
    // Its own billing waits: no charge, no suspension.
    expect(await feePauseHoldsBilling(app.prisma, stuck)).toBe(true);
    expect(await billing.billSubscription((await subWithRelations(stuck)) as any)).toBe('pending');
    expect((await sub(stuck)).status).toBe('PAST_DUE');
    expect(await events(stuck, 'SUSPENDED')).toBe(0);
    // A second pause comes; the clock is repaired after it ends, or while it is open.
    await syncMmgPauseClock(app.prisma, at(4), OFF, failStuck);
    let released: Date;
    if (when === 'after') {
      await syncMmgPauseClock(app.prisma, at(6), ON, failStuck);
      // The second resume keeps the record's FIRST start.
      expect((await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: `${FEE_PAUSE_REPAIR_PREFIX}${stuck}` } })).value).toEqual({ since: t0.toISOString() });
      released = new Date();
      await syncMmgPauseClock(app.prisma, released, ON);
    } else {
      await syncMmgPauseClock(app.prisma, at(5), OFF);
      released = at(6);
      await syncMmgPauseClock(app.prisma, released, ON);
    }
    // Paused from that first start, then released: the minute of grace that remained is still there.
    expect(await feePauseHoldsBilling(app.prisma, stuck)).toBe(false);
    expect(activeOverdueMs((await clockOf(stuck))!, released)).toBe(FULL_FEE_GRACE_MS - 60_000);
    expect((await sub(stuck)).billingEnforcementDueAt).toEqual(new Date(released.getTime() + 60_000));
    expect((await feePauseStatus(app.prisma)).awaitingRepair).toBe(0);
  });

  it('billing that runs BEFORE the resume tick bills nothing; after it, ONE fee covers the off weeks and the current week (cash, prepaid)', async () => {
    await noPauseOpen();
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    await whileOff(async () => {
      await syncMmgPauseClock(app.prisma, new Date(), OFF);
      await billing.runBillingCycle();
    });
    // MMG is back on, but the first resume tick has not run yet.
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    expect(await events(subId, 'CHARGE_SUCCESS')).toBe(0);
    expect(await balanceOf(subId)).toBe(50000);
    const reactivatedAt = new Date();
    await syncMmgPauseClock(app.prisma, reactivatedAt, ON);
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'CAPTURED', periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
    expect(await balanceOf(subId)).toBe(38000);
    expect(await app.prisma.platformConfig.findUnique({ where: { key: `billing.mmg_pause.reactivated:${subId}` } })).toBeNull();
  });

  it('billing that runs BEFORE the resume tick reserves no MMG request; after it, ONE request covers the off weeks and the current week', async () => {
    await noPauseOpen();
    sandboxResetMmg();
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due);
    await whileOff(async () => {
      await syncMmgPauseClock(app.prisma, new Date(), OFF);
      await billing.runBillingCycle();
    });
    for (let i = 0; i < 2; i += 1) {
      await billing.runBillingCycle();
      await billing.pollPendingMmgCharges();
    }
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    for (let i = 0; i < 4; i += 1) {
      await billing.runBillingCycle();
      await billing.pollPendingMmgCharges();
    }
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'CAPTURED', periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
  });

  it('a resume tick that fails is retried, and billing waits for it', async () => {
    await noPauseOpen();
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    await whileOff(() => syncMmgPauseClock(app.prisma, new Date(), OFF));
    await syncMmgPauseClock(app.prisma, new Date(), ON, async (boundary) => { if (boundary === 'before-reactivate') throw new Error('injected: the resume tick dies'); });
    expect(await app.prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_pause.open' } })).not.toBeNull();
    // No clock resumes before every reactivation is on record.
    expect((await clockOf(subId))!.pausedAt).not.toBeNull();
    for (let i = 0; i < 2; i += 1) await billing.runBillingCycle();
    expect(await balanceOf(subId)).toBe(50000);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
  });

  it('an MMG request from before the pause, settled after it, pays its own week and leaves the reactivation for the next fee: two fees, never one per off week', async () => {
    await noPauseOpen();
    sandboxResetMmg();
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due);
    // MMG on: the week falls due and a request goes out before MMG is switched off.
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    const inFlight = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]!.periodEnd.getTime()).toBe(due.getTime() + 7 * DAY);
    await whileOff(() => syncMmgPauseClock(app.prisma, new Date(), OFF));
    const reactivatedAt = new Date();
    await syncMmgPauseClock(app.prisma, reactivatedAt, ON);
    for (let i = 0; i < 4; i += 1) {
      await billing.pollPendingMmgCharges();
      await billing.runBillingCycle();
    }
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId, status: 'CAPTURED' }, orderBy: { periodStart: 'asc' } });
    expect(payments.map((p) => [p.periodStart.getTime(), p.periodEnd.getTime()])).toEqual([
      [due.getTime(), due.getTime() + 7 * DAY],
      [due.getTime() + 7 * DAY, due.getTime() + 21 * DAY],
    ]);
    expect((await sub(subId)).nextBillingDate.getTime()).toBeGreaterThan(reactivatedAt.getTime());
  });

  it('a fee the pause tick never reached (it fell due after the last tick, or its clock could not be paused) still waits for the resume record', async () => {
    await noPauseOpen();
    await whileOff(() => syncMmgPauseClock(app.prisma, new Date(), OFF));
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    expect((await clockOf(subId))?.pausedAt ?? null).toBeNull();
    // A way to pay is back; billing runs before the resume tick.
    for (let i = 0; i < 2; i += 1) await billing.runBillingCycle();
    expect(await balanceOf(subId)).toBe(50000);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    for (let i = 0; i < 3; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
  });

  it('a payment that settles while the pause is open (a confirmation finished by a person) covers through the week in progress: nothing after it is back-billed', async () => {
    await noPauseOpen();
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    await whileOff(() => syncMmgPauseClock(app.prisma, new Date(), OFF));
    const settledAt = new Date();
    await whileOff(async () => (billing as any).applySuccessfulCharge(await subWithRelations(subId), 12000, `confirmed-${nanoid(8)}`, settledAt, due.toISOString().slice(0, 10)));
    const paid = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ status: 'CAPTURED', periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
    expect((await sub(subId)).nextBillingDate.getTime()).toBeGreaterThan(settledAt.getTime());
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    for (let i = 0; i < 2; i += 1) await billing.runBillingCycle();
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(1);
  });

  it('a clock whose resume fails stays held after the reactivations are recorded, and its billing waits until it resumes', async () => {
    await noPauseOpen();
    const due = new Date(Date.now() - 20 * DAY);
    const subId = await makeVendorSub(due, { method: 'CASH' });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 50000, currencyCode: 'GYD' } });
    await whileOff(() => syncMmgPauseClock(app.prisma, new Date(), OFF));
    await syncMmgPauseClock(app.prisma, new Date(), ON, async (boundary) => { if (boundary === 'before-resume') throw new Error('injected: this clock\'s resume dies'); });
    // The reactivation is on record and the span is closed, but the clock is still held.
    expect(await app.prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_pause.open' } })).toBeNull();
    expect(await app.prisma.platformConfig.findUnique({ where: { key: `billing.mmg_pause.reactivated:${subId}` } })).not.toBeNull();
    expect((await clockOf(subId))!.pausedAt).not.toBeNull();
    expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    expect(await balanceOf(subId)).toBe(50000);
    await syncMmgPauseClock(app.prisma, new Date(), ON);
    expect((await clockOf(subId))!.pausedAt).toBeNull();
    for (let i = 0; i < 2; i += 1) await billing.runBillingCycle();
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ periodStart: due, periodEnd: new Date(due.getTime() + 21 * DAY) });
  });
});
