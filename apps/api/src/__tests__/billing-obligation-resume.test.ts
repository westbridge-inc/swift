import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../modules/billing/billing.service';
import { currentDunningClock, activeOverdueMs, resolveConfirmationInTx } from '../modules/billing/dunning-clock';
import { confirmationReviewQueue } from '../modules/billing/confirmation-finance';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

const db = new PrismaClient();
const DAY = 86_400_000;
const users: string[] = [];
const vendors: string[] = [];
const subscriptions: string[] = [];
const notifications = { send: vi.fn(async () => 'test-inbox'), drainFeeDemands: vi.fn(async () => ({ attempted: 0, delivered: 0 })) };
const billing = new BillingService(db, notifications as never, getPaymentProvider());

async function fixture(paid = true) {
  const key = randomUUID();
  const user = await db.user.create({ data: { phone: `+592${Math.floor(1e10 + Math.random() * 9e10)}`, firstName: 'Resume', lastName: 'Fixture', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER' } });
  users.push(user.id);
  const owner = await db.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await db.vendor.create({ data: { ownerId: owner.id, name: 'Resume fixture', slug: `resume-${key}`, vendorType: 'RESTAURANT',
    phone: user.phone, addressLine1: 'Test street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', isVerified: true, acceptingOrders: true } });
  vendors.push(vendor.id);
  const due = new Date(Date.now() - 2 * DAY);
  const start = new Date(due.getTime() - 7 * DAY);
  const sub = await db.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', weeklyRate: 20000, status: 'ACTIVE',
    billingMethod: 'CASH', autoRenew: false, currentPeriodStart: start, currentPeriodEnd: due, nextBillingDate: due,
    prepaidBalance: { create: { balance: 20000 } } } });
  subscriptions.push(sub.id);
  if (paid) {
    const paymentRef = `resume-paid:${sub.id}`;
    await db.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: 20000, paymentMethod: 'CASH', status: 'CAPTURED',
      periodStart: start, periodEnd: due, paidAt: start, externalRef: paymentRef } });
    await db.billingEvent.create({ data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: 20000, currencyCode: 'GYD',
      paymentRef, idempotencyKey: `success:${sub.id}:${start.toISOString().slice(0, 10)}` } });
  }
  const clock = await db.$transaction((tx) => currentDunningClock(tx, sub.id));
  return { sub, clock, due, userId: user.id };
}

async function proposedResume(tx: Prisma.TransactionClient, f: Awaited<ReturnType<typeof fixture>>,
  override: Partial<Prisma.BillingObligationTransitionUncheckedCreateInput> = {}) {
  const payment = await tx.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: f.sub.id, status: 'CAPTURED' } });
  const event = await tx.billingEvent.findFirstOrThrow({ where: { subscriptionId: f.sub.id, type: 'CHARGE_SUCCESS' } });
  const lapse = await tx.billingEvent.findFirstOrThrow({ where: { subscriptionId: f.sub.id,
    idempotencyKey: `pause:${f.sub.id}:${f.clock.id}:${f.clock.epoch}` } });
  const now = new Date();
  const audit = await tx.auditLog.create({ data: { action: 'BILLING_CLOCK_VOLUNTARY_RESUME', entity: 'BillingDunningClock', entityId: f.clock.id,
    changes: { clockId: f.clock.id, tenantId: f.clock.tenantId, fromSubscriptionId: f.sub.id, subscriptionId: f.sub.id,
      previousEpoch: f.clock.epoch, nextEpoch: f.clock.epoch + 1, previousDue: f.due.toISOString(), nextDue: now.toISOString(),
      paymentId: payment.id, successEventId: event.id, lapseEventId: lapse.id, currencyCode: 'GYD', amount: payment.amount.toString() } } });
  return tx.billingObligationTransition.create({ data: { clockId: f.clock.id, tenantId: f.clock.tenantId,
    fromSubscriptionId: f.sub.id, subscriptionId: f.sub.id, kind: 'VOLUNTARY_RESUME', fromEpoch: f.clock.epoch,
    toEpoch: f.clock.epoch + 1, fromDue: f.due, toDue: now, effectiveAt: now, paymentId: payment.id,
    successEventId: event.id, lapseEventId: lapse.id, auditId: audit.id, amount: payment.amount, currencyCode: 'GYD',
    periodStart: payment.periodStart, periodEnd: payment.periodEnd, ...override } });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => {
  await cleanupBillingClocks(db, subscriptions);
  await db.subscription.deleteMany({ where: { id: { in: subscriptions } } });
  await db.vendor.deleteMany({ where: { id: { in: vendors } } });
  await db.vendorOwner.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('paid coverage alone permits a new obligation after voluntary pause', () => {
  it('a proven settled prior period resumes with exactly one paid new week', async () => {
    const f = await fixture();
    await billing.lapseStoppedSubscriptions();
    const before = Date.now();
    await billing.setBillingRail(f.sub.id, 'CASH');
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: f.sub.id } });
    const payments = await db.subscriptionPayment.findMany({ where: { subscriptionId: f.sub.id }, orderBy: { periodStart: 'asc' } });
    expect(payments).toHaveLength(2);
    expect(sub.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before);
    expect(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()).toBe(7 * DAY);
    expect(Number((await db.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: f.sub.id } })).balance)).toBe(0);
    expect((await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } })).dueAt).toEqual(sub.currentPeriodEnd);
  });

  it('an unproved legacy PAUSED row cannot reset its unpaid clock', async () => {
    const f = await fixture(false);
    await db.subscription.update({ where: { id: f.sub.id }, data: { status: 'PAUSED' } });
    const before = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    await expect(billing.setBillingRail(f.sub.id, 'CASH')).rejects.toMatchObject({ code: 'BILLING_OBLIGATION_REVIEW_REQUIRED' });
    expect(await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } })).toEqual(before);
    expect(await db.subscriptionPayment.count({ where: { subscriptionId: f.sub.id } })).toBe(0);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: f.sub.id } })).status).toBe('PAUSED');
    expect(await db.auditLog.count({ where: { action: 'BILLING_OBLIGATION_REVIEW_REQUIRED', entityId: f.clock.id } })).toBe(1);
    expect(await confirmationReviewQueue(db, f.clock.tenantId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: f.sub.id, source: 'OBLIGATION', status: 'REVIEW_REQUIRED', resolvable: false }),
    ]));
    expect(await confirmationReviewQueue(db, 'unrelated-tenant')).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: f.sub.id }),
    ]));
  });

  it('a crash before the instant charge cannot consume the same prior coverage twice', async () => {
    const f = await fixture();
    await billing.lapseStoppedSubscriptions();
    vi.spyOn(billing as unknown as { chargeResumedPlan(): Promise<void> }, 'chargeResumedPlan').mockRejectedValue(new Error('synthetic interruption before the instant charge'));
    await billing.setBillingRail(f.sub.id, 'CASH');
    const obligation = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    await billing.stopBilling(f.sub.id, f.userId);
    await billing.lapseStoppedSubscriptions();
    const stopped = await db.subscription.findUniqueOrThrow({ where: { id: f.sub.id } });
    expect(stopped.status).toBe('ACTIVE'); // still owes the already created period
    await billing.setBillingRail(f.sub.id, 'CASH');
    const after = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    expect(after).toMatchObject({ id: obligation.id, epoch: obligation.epoch, dueAt: obligation.dueAt,
      elapsedMs: obligation.elapsedMs, runningSince: obligation.runningSince, retryAtMs: obligation.retryAtMs });
    expect(await db.subscriptionPayment.count({ where: { subscriptionId: f.sub.id } })).toBe(1);
  });

  it('restart exactly at period end consumes its prior proof once and retains a refusal audit', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.due);
    await billing.lapseStoppedSubscriptions(f.due);
    vi.spyOn(billing as unknown as { chargeResumedPlan(): Promise<void> }, 'chargeResumedPlan').mockRejectedValue(new Error('synthetic interruption at exact period end'));
    await billing.setBillingRail(f.sub.id, 'CASH');
    const first = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    expect(first.dueAt).toEqual(f.due);
    expect(first.epoch).toBe(f.clock.epoch + 1);
    await db.subscription.update({ where: { id: f.sub.id }, data: { status: 'PAUSED', autoRenew: false } });
    await expect(billing.setBillingRail(f.sub.id, 'CASH')).rejects.toMatchObject({ code: 'BILLING_OBLIGATION_REVIEW_REQUIRED' });
    expect(await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } })).toEqual(first);
    expect(await db.auditLog.count({ where: { action: 'BILLING_CLOCK_VOLUNTARY_RESUME', entityId: f.clock.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'BILLING_OBLIGATION_REVIEW_REQUIRED', entityId: f.clock.id } })).toBe(1);
  });

  it.each(['elapsed', 'running-anchor', 'epoch'] as const)('SQL refuses an unproved same-source %s reset', async (kind) => {
    const f = await fixture();
    if (kind === 'elapsed') {
      // Store elapsed time by a real confirmation pause, not an arbitrary SQL value.
      const payment = await db.subscriptionPayment.create({ data: { subscriptionId: f.sub.id, amount: 20000,
        paymentMethod: 'CARD', status: 'UNKNOWN', periodStart: f.due, periodEnd: new Date(f.due.getTime() + 7 * DAY), failureRaw: { providerEffect: 'AUTHORIZED' } } });
      expect(payment.id).toBeTruthy();
      await db.$transaction((tx) => currentDunningClock(tx, f.sub.id));
    }
    const before = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    const data = kind === 'elapsed' ? { elapsedMs: 0n } : kind === 'running-anchor'
      ? { runningSince: new Date() } : { epoch: { increment: 1 }, elapsedMs: 0n, dueAt: new Date() };
    await expect(db.billingDunningClock.update({ where: { id: before.id }, data })).rejects.toThrow();
    expect(await db.billingDunningClock.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });
  it('an exact transition cannot commit without the paired clock advance', async () => {
    const f = await fixture();
    await billing.lapseStoppedSubscriptions();
    const before = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    await expect(db.$transaction((tx) => proposedResume(tx, f))).rejects.toThrow(/transition must commit with its clock/);
    expect(await db.billingObligationTransition.count({ where: { clockId: f.clock.id } })).toBe(0);
    expect(await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } })).toEqual(before);
  });

  it.each(['clock', 'tenant', 'source', 'success-event', 'amount', 'period', 'epoch'] as const)(
    'SQL rejects a transition with the wrong %s even when it has a real paid record', async (kind) => {
      const f = await fixture();
      const other = await fixture();
      await billing.lapseStoppedSubscriptions();
      const event = await db.billingEvent.findFirstOrThrow({ where: { subscriptionId: other.sub.id, type: 'CHARGE_SUCCESS' } });
      const data = kind === 'clock' ? { clockId: other.clock.id } : kind === 'tenant' ? { tenantId: 'unrelated-tenant' }
        : kind === 'source' ? { subscriptionId: other.sub.id } : kind === 'success-event' ? { successEventId: event.id }
          : kind === 'amount' ? { amount: 1 } : kind === 'period' ? { periodStart: f.due }
            : { fromEpoch: f.clock.epoch + 1, toEpoch: f.clock.epoch + 2 };
      await expect(db.$transaction((tx) => proposedResume(tx, f, data))).rejects.toThrow(/exact retained settlement proof/);
      expect(await db.billingObligationTransition.count({ where: { clockId: { in: [f.clock.id, other.clock.id] } } })).toBe(0);
    });

  it('consumed settlement and event facts are immutable and retained with tenant isolation', async () => {
    const f = await fixture();
    await billing.lapseStoppedSubscriptions();
    await billing.setBillingRail(f.sub.id, 'CASH');
    const transition = await db.billingObligationTransition.findFirstOrThrow({ where: { clockId: f.clock.id, kind: 'VOLUNTARY_RESUME' } });
    expect(await db.billingObligationTransition.count({ where: { clockId: f.clock.id } })).toBe(2);
    await expect(db.subscriptionPayment.update({ where: { id: transition.paymentId }, data: { amount: 1 } })).rejects.toThrow();
    await expect(db.billingEvent.update({ where: { id: transition.successEventId }, data: { paymentRef: 'wrong' } })).rejects.toThrow();
    await expect(db.billingObligationTransition.update({ where: { id: transition.id }, data: { toEpoch: 99 } })).rejects.toThrow();
    await expect(db.billingDunningClock.delete({ where: { id: f.clock.id } })).rejects.toThrow();
    await expect(db.subscriptionPayment.delete({ where: { id: transition.paymentId } })).rejects.toThrow();
    const counts = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${f.clock.tenantId}, true)`;
      const own = await tx.billingObligationTransition.count({ where: { clockId: f.clock.id } });
      await tx.$executeRaw`SELECT set_config('app.current_tenant', 'unrelated-tenant', true)`;
      return { own, other: await tx.billingObligationTransition.count({ where: { clockId: f.clock.id } }) };
    });
    expect(counts).toEqual({ own: 2, other: 0 });
    for (const mutation of ['UPDATE', 'DELETE'] as const) await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${f.clock.tenantId}, true)`;
      if (mutation === 'UPDATE') await tx.billingObligationTransition.update({ where: { id: transition.id }, data: { amount: 1 } });
      else await tx.billingObligationTransition.delete({ where: { id: transition.id } });
    })).rejects.toThrow();
  });

  it('a genuine same-epoch confirmation pause and resume keeps all accrued active time', async () => {
    const f = await fixture(false);
    const began = new Date(f.due.getTime() + 47 * 3_600_000);
    const payment = await db.subscriptionPayment.create({ data: { subscriptionId: f.sub.id, amount: 20000,
      paymentMethod: 'CARD', status: 'UNKNOWN', createdAt: began, periodStart: f.due,
      periodEnd: new Date(f.due.getTime() + 7 * DAY), failureRaw: { providerEffect: 'AUTHORIZED' } } });
    const paused = await db.$transaction((tx) => currentDunningClock(tx, f.sub.id, began));
    expect(Number(paused.elapsedMs)).toBe(47 * 3_600_000);
    const resumed = new Date(began.getTime() + 10 * DAY);
    await db.$transaction((tx) => resolveConfirmationInTx(tx, f.sub.id, { paymentId: payment.id }, 'PROVEN_UNPAID',
      { actor: 'synthetic-provider-proof', reference: `decline:${payment.id}` }, resumed));
    const after = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    expect(after.epoch).toBe(f.clock.epoch);
    expect(after.dueAt).toEqual(f.due);
    expect(activeOverdueMs(after, new Date(resumed.getTime() + 3_600_000))).toBe(48 * 3_600_000);
  });

  it('the same paid proof cannot be reserved twice before either clock update', async () => {
    const f = await fixture();
    await billing.lapseStoppedSubscriptions();
    await expect(db.$transaction(async (tx) => {
      await proposedResume(tx, f);
      await proposedResume(tx, f);
    })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.billingObligationTransition.count({ where: { clockId: f.clock.id } })).toBe(0);
  });

  it('a historical capture and a PAUSED status alone cannot invent the immediate paid lapse', async () => {
    const f = await fixture();
    await db.subscription.update({ where: { id: f.sub.id }, data: { status: 'PAUSED' } });
    await expect(billing.setBillingRail(f.sub.id, 'CASH')).rejects.toMatchObject({ code: 'BILLING_OBLIGATION_REVIEW_REQUIRED' });
    expect((await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } })).epoch).toBe(f.clock.epoch);
  });

  it('SQL refuses a forged later lapse using coverage already consumed at exact period end', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(f.due);
    await billing.lapseStoppedSubscriptions(f.due);
    vi.spyOn(billing as unknown as { chargeResumedPlan(): Promise<void> }, 'chargeResumedPlan').mockRejectedValue(new Error('synthetic unpaid period'));
    await billing.setBillingRail(f.sub.id, 'CASH');
    const current = await db.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
    await db.subscription.update({ where: { id: f.sub.id }, data: { status: 'PAUSED', autoRenew: false } });
    const payment = await db.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: f.sub.id, status: 'CAPTURED' } });
    await db.billingEvent.create({ data: { subscriptionId: f.sub.id, type: 'TIER_CHANGE', amount: payment.amount,
      currencyCode: 'GYD', paymentRef: payment.externalRef, idempotencyKey: `pause:${f.sub.id}:${current.id}:${current.epoch}` } });
    await expect(db.$transaction((tx) => proposedResume(tx, { ...f, clock: current }))).rejects.toThrow(/unused exact lapse coverage/);
    expect(await db.billingDunningClock.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
    expect(await db.subscriptionPayment.count({ where: { subscriptionId: f.sub.id } })).toBe(1);
  });

  it.each(['epoch', 'anchor'] as const)('SQL cannot seed an unproved initial %s on an existing unpaid source', async (kind) => {
    const f = await fixture(false);
    await expect(db.$transaction(async (tx) => {
      // This is an owned synthetic replacement within the regression transaction.
      // Runtime has no DELETE permission; creation must also obey initial facts.
      await tx.billingDunningClock.delete({ where: { id: f.clock.id } });
      await tx.billingDunningClock.create({ data: { id: f.clock.id, subscriptionId: f.sub.id, tenantId: f.clock.tenantId,
        dueAt: f.due, epoch: kind === 'epoch' ? 2 : 1, elapsedMs: 0n,
        runningSince: kind === 'anchor' ? new Date() : f.due } });
    })).rejects.toThrow(/initial obligation/);
  });

});
