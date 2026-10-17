import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { sandboxSetTxStatus } from '../providers/mmg/mmg-provider';
import { reanchorAtReturnInTx, suspensionKey } from '../modules/billing/dunning-clock';
import { bookAt, priceBookNoticeKey, type PriceBookRow } from '../modules/billing/price-book';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// BILLING-REANCHOR (board row 151, GUARDRAILS §7 dated obligation, due
// 2026-11-06). Ruling (OWNER-DECISIONS "Weekly-fee arrears after a pause",
// 4 Oct): "No arrears for weeks a partner was switched off/paused or suspended
// and not operating; billing restarts at the week they return."
//
// A payment that brings back a SUSPENDED or CHURNED partner buys the week that
// starts when they come back, never the unpaid week they were suspended for
// nor any week they spent switched off, and the next fee is due a week after
// the return. The billing engine records why: a RETURN_REANCHOR obligation
// transition proven by the SUSPENDED record of that obligation, paid in the
// same transaction. A PAST_DUE partner (still operating inside the 48-hour
// grace) keeps the week that fell due. A payment is credited only once and
// never dropped: money that arrives for a week the return did not bill is
// kept as fee credit. Continues an earlier builder's parked test of this rule.
// ---------------------------------------------------------------------------

// Each billing run walks every due subscription in the database.
vi.setConfig({ testTimeout: 180_000 });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RATE = 20000;

let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
// [SAFE-B · retained history] Choosing the MMG rail records an advisory payer
// declaration: immutable evidence naming its subscription and account, kept
// after the suite. The owners therefore live in a phone namespace no other
// suite uses or purges, unique to the run.
const PHONE_PREFIX = retainedPhonePrefix('28');

async function brokeVendorSub(due: Date) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Anchor', lastName: `U${seq}`, roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Anchor Vendor ${seq}`, slug: `anchor-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}${String(500 + seq).padStart(3, '0')}`,
      addressLine1: '1 Anchor St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: RATE, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 0 } },
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, vendorId: vendor.id, subId: sub.id };
}

/** Three failed charges over 50 h: the billing engine's own suspension, from `due`. */
async function suspendFrom(subId: string, due: Date) {
  await billing.runBillingCycle(due);
  await billing.runBillingCycle(new Date(due.getTime() + 25 * HOUR));
  await billing.runBillingCycle(new Date(due.getTime() + 50 * HOUR));
  expect((await sub(subId)).status).toBe('SUSPENDED');
}

const sub = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const subWithRelations = (id: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
const balance = async (id: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: id } })).balance);
const successes = (id: string) => app.prisma.billingEvent.findMany({ where: { subscriptionId: id, type: 'CHARGE_SUCCESS' } });
const attempts = (id: string) => app.prisma.billingEvent.count({ where: { subscriptionId: id, type: 'CHARGE_ATTEMPT' } });
const clockOf = (id: string) => app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: id } });
const transitionsOf = (id: string) => app.prisma.billingObligationTransition.findMany({ where: { subscriptionId: id }, orderBy: { toEpoch: 'asc' } });
const day = (at: Date) => at.toISOString().slice(0, 10);
const topUp = (id: string, amount: number, ref: string) => billing.recordTopUp(id, amount, 'admin-test', ref, nanoid(12));

/** What a return must leave behind: one paid week from the return, the span
 *  not billed on record against the suspension it was proven by. */
async function expectReturnedAt(subId: string, due: Date, from: number, to: number) {
  const s = await sub(subId);
  expect(s.status).toBe('ACTIVE');
  expect(s.suspendedAt).toBeNull();
  expect(s.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(from);
  expect(s.currentPeriodStart.getTime()).toBeLessThanOrEqual(to);
  expect(s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()).toBe(7 * DAY);
  expect(s.nextBillingDate.getTime()).toBe(s.currentPeriodEnd.getTime());

  const paid = await successes(subId);
  expect(paid).toHaveLength(1);
  // The week paid is the return week: never the unpaid week, never a week in between.
  expect(paid[0]!.idempotencyKey).toBe(`success:${subId}:${day(s.currentPeriodStart)}`);
  expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `success:${subId}:${day(due)}` } })).toBe(0);

  const suspension = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: suspensionKey(subId, due) } });
  const chain = await transitionsOf(subId);
  const reanchor = chain.find((t) => t.kind === 'RETURN_REANCHOR')!;
  expect(reanchor).toMatchObject({
    fromDue: due, toDue: s.currentPeriodStart, effectiveAt: s.currentPeriodStart,
    periodStart: due, periodEnd: s.currentPeriodStart, // the span not billed
    paymentId: null, successEventId: null, lapseEventId: null, suspensionEventId: suspension.id, currencyCode: 'GYD',
  });
  expect(Number(reanchor.amount)).toBe(0);
  const paidAdvance = chain.find((t) => t.kind === 'PAID' && t.fromEpoch === reanchor.toEpoch)!;
  expect(paidAdvance).toMatchObject({ fromDue: s.currentPeriodStart, toDue: s.currentPeriodEnd, successEventId: paid[0]!.id });

  const clock = await clockOf(subId);
  expect(clock.dueAt.getTime()).toBe(s.currentPeriodEnd.getTime());
  expect(clock.epoch).toBe(paidAdvance.toEpoch);
  expect(await app.prisma.auditLog.count({ where: { action: 'BILLING_CLOCK_RETURN_REANCHOR', entityId: clock.id } })).toBe(1);
  return { s, reanchor, paidAdvance };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // the push rail's sandbox: a way to pay is live, so nothing is fee-paused
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  // [SAFE-B · retained history] A subscription an MMG payer declaration names is
  // kept with its money records, store and owner (cancelled, store closed); the
  // rest goes. [#1393] Clock evidence first (RESTRICT FKs), then the events, then the rows.
  try {
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      await cleanupBillingClocks(tx, subIds);
      await tx.providerPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.feeReceipt.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.topUpCommand.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.vendor.deleteMany({ where: { id: { in: without(vendorIds, kept.vendorIds) } } });
      await tx.vendorOwner.deleteMany({ where: { userId: { in: without(userIds, kept.userIds) } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: without(userIds, kept.userIds) } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});

describe('BILLING-REANCHOR — a returning partner pays from the week they return', () => {
  it('suspended across two week boundaries, pays: no arrears — one week, starting at the return, and nothing is re-billed at once', async () => {
    const due = new Date(Date.now() - 15 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    const epochBefore = (await clockOf(v.subId)).epoch;

    const before = Date.now();
    // Two weeks of money: a stale anchor would spend it on switched-off weeks.
    await topUp(v.subId, 2 * RATE, 'return');
    const after = Date.now();

    const { reanchor, paidAdvance } = await expectReturnedAt(v.subId, due, before - 1000, after + 1000);
    expect([reanchor.fromEpoch, paidAdvance.toEpoch]).toEqual([epochBefore, epochBefore + 2]);
    expect(await balance(v.subId)).toBe(RATE); // the second week's money is still theirs

    // The hourly runs after the return bill nothing more and suspend nobody.
    const attemptsBefore = await attempts(v.subId);
    for (const h of [1, 25, 50]) await billing.runBillingCycle(new Date(after + h * HOUR));
    expect(await attempts(v.subId)).toBe(attemptsBefore);
    expect(await successes(v.subId)).toHaveLength(1);
    expect(await balance(v.subId)).toBe(RATE);
    expect((await sub(v.subId)).status).toBe('ACTIVE');
  });

  it('returns mid-week, inside the week they were suspended in: the week starts at the return, not at the old due date', async () => {
    const due = new Date(Date.now() - 3.5 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);

    const before = Date.now();
    await topUp(v.subId, RATE, 'back mid-week');
    const { s } = await expectReturnedAt(v.subId, due, before - 1000, Date.now() + 1000);
    // The old week would have ended in 3.5 days; the return week runs a full 7.
    expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(due.getTime() + 7 * DAY + 3 * DAY);
    expect(await balance(v.subId)).toBe(0);
  });

  it('a churned partner rejoining is not dunned for the month they were gone', async () => {
    const due = new Date(Date.now() - 40 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    await billing.sweepSuspended(new Date(due.getTime() + 50 * HOUR + 31 * DAY));
    expect((await sub(v.subId)).status).toBe('CHURNED');

    const before = Date.now();
    await topUp(v.subId, RATE, 'rejoin');
    await expectReturnedAt(v.subId, due, before - 1000, Date.now() + 1000);
    expect((await sub(v.subId)).nextBillingDate.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);

    // The next hourly runs find nothing due; the partner is not re-suspended.
    for (const h of [1, 25, 50]) await billing.runBillingCycle(new Date(Date.now() + h * HOUR));
    expect((await sub(v.subId)).status).toBe('ACTIVE');
    expect(await successes(v.subId)).toHaveLength(1);
  });

  it('a PAST_DUE partner still in the grace (still operating) pays the week that was due: no re-anchor', async () => {
    const due = new Date(Date.now() - 2 * HOUR);
    const v = await brokeVendorSub(due);
    await billing.runBillingCycle(due);
    expect((await sub(v.subId)).status).toBe('PAST_DUE');

    await topUp(v.subId, RATE, 'late but in grace');
    const s = await sub(v.subId);
    expect(s.status).toBe('ACTIVE');
    expect(s.currentPeriodStart.getTime()).toBe(due.getTime());
    expect(s.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect((await transitionsOf(v.subId)).map((t) => t.kind)).toEqual(['PAID']);
    expect(await app.prisma.auditLog.count({ where: { action: 'BILLING_REANCHOR_REVIEW_REQUIRED', entityId: (await clockOf(v.subId)).id } })).toBe(0);
  });

  it('a repeated top-up key credits once and reinstates once', async () => {
    const due = new Date(Date.now() - 14 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    const key = nanoid(10);
    await billing.recordTopUp(v.subId, RATE, 'admin-test', 'return', key);
    const first = await sub(v.subId);
    await billing.recordTopUp(v.subId, RATE, 'admin-test', 'return', key).catch(() => undefined);
    const second = await sub(v.subId);
    expect(second.nextBillingDate.getTime()).toBe(first.nextBillingDate.getTime());
    expect(await successes(v.subId)).toHaveLength(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: v.subId, type: 'REINSTATED' } })).toBe(1);
    expect((await transitionsOf(v.subId)).filter((t) => t.kind === 'RETURN_REANCHOR')).toHaveLength(1);
  });
});

describe('BILLING-REANCHOR — MMG money during a suspension: credited once, after MMG\'s own lookup, never dropped', () => {
  it('an MMG request being confirmed holds the return: a credit that lands meanwhile waits, the approval buys the return week, the credit stays', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    await billing.setBillingRail(v.subId, 'MOBILE_MONEY', '5926001234');

    // The suspended partner's request goes out for the unpaid week; MMG has not answered yet.
    expect(await billing.billSubscription(await subWithRelations(v.subId) as never)).toBe('pending');
    const request = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: v.subId, paymentMethod: 'MOBILE_MONEY' } });
    expect(request).toMatchObject({ status: 'PENDING', periodStart: due });
    sandboxSetTxStatus(request.externalRef!, 'pending');

    // Money arrives another way while MMG is confirming: credited, not spent, no second week.
    await topUp(v.subId, RATE, 'paid at the counter meanwhile');
    expect((await sub(v.subId)).status).toBe('SUSPENDED');
    expect(await balance(v.subId)).toBe(RATE);
    expect(await successes(v.subId)).toHaveLength(0);
    expect(await app.prisma.billingObligationTransition.count({ where: { subscriptionId: v.subId, kind: 'RETURN_REANCHOR' } })).toBe(0);

    // MMG's own lookup now says approved: that payment is the return.
    sandboxSetTxStatus(request.externalRef!, 'approved');
    // The next poll tick, past the backoff the earlier 'pending' answer set.
    const tick = new Date(Date.now() + 2 * 60_000);
    await billing.pollPendingMmgCharges(tick);
    const { s } = await expectReturnedAt(v.subId, due, tick.getTime(), tick.getTime());
    // The instruction keeps the week it was issued for (its identity is
    // immutable); its money is credited once, after MMG's lookup, and spent at
    // once on the return week, booked on a new period row.
    const settled = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: request.id } });
    expect(settled).toMatchObject({ status: 'CAPTURED', periodStart: due });
    const credit = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: `bank:${request.id}` } });
    expect([credit.type, Number(credit.amount)]).toEqual(['PREPAID_TOPUP', RATE]);
    const week = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: v.subId, periodStart: s.currentPeriodStart } });
    expect(week).toMatchObject({ status: 'CAPTURED', externalRef: 'prepaid', periodEnd: s.currentPeriodEnd });
    expect(Number(week.amount)).toBe(RATE);
    expect(await balance(v.subId)).toBe(RATE); // the counter money is still theirs, for the next week

    // A repeated observation changes nothing.
    await billing.pollPendingMmgCharges(new Date(tick.getTime() + 2 * 60_000));
    expect(await successes(v.subId)).toHaveLength(1);
    expect((await sub(v.subId)).nextBillingDate.getTime()).toBe(s.nextBillingDate.getTime());
  });

  it('a late MMG approval for the week the return did not bill is kept as fee credit: not dropped, not booked to that week, the period never moves back', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    await billing.setBillingRail(v.subId, 'MOBILE_MONEY', '5926001235');
    expect(await billing.billSubscription(await subWithRelations(v.subId) as never)).toBe('pending');
    const request = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: v.subId, paymentMethod: 'MOBILE_MONEY' } });
    // MMG's own lookup says the request expired: the poller closes it.
    sandboxSetTxStatus(request.externalRef!, 'expired');
    const suspendedAt = (await sub(v.subId)).suspendedAt;
    await billing.pollPendingMmgCharges(new Date(Date.now() + 2 * 60_000));
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('EXPIRED');
    expect(await app.prisma.paymentConfirmationHold.count({ where: { paymentId: request.id, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } } })).toBe(0);
    // A failed retry is not a return: still suspended, from the same moment, on one record.
    const still = await sub(v.subId);
    expect([still.status, still.isInGracePeriod, still.suspendedAt?.getTime()]).toEqual(['SUSPENDED', false, suspendedAt?.getTime()]);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: v.subId, type: 'SUSPENDED' } })).toBe(1);

    await topUp(v.subId, RATE, 'came back');
    const { s } = await expectReturnedAt(v.subId, due, Date.now() - 60_000, Date.now() + 1000);

    // MMG later reports the expired request approved after all.
    sandboxSetTxStatus(request.externalRef!, 'approved');
    const late = await (billing as unknown as { settleApprovedMmgPayment: (...a: unknown[]) => Promise<string> }).settleApprovedMmgPayment(
      await subWithRelations(v.subId), request.id,
      { transactionId: request.externalRef, status: 'approved', amountMinor: RATE * 100, currencyCode: 'GYD', reference: request.clientKey, createdAt: new Date().toISOString() },
      new Date(),
    );
    expect(late).toBe('banked');
    expect(await balance(v.subId)).toBe(RATE); // kept for the next weekly fee
    const banked = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: `bank:${request.id}` } });
    expect(Number(banked.amount)).toBe(RATE);
    const after = await sub(v.subId);
    expect([after.status, after.currentPeriodStart.getTime(), after.nextBillingDate.getTime()])
      .toEqual(['ACTIVE', s.currentPeriodStart.getTime(), s.nextBillingDate.getTime()]);
    expect(await successes(v.subId)).toHaveLength(1);
    expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `success:${v.subId}:${day(due)}` } })).toBe(0);
  });
});

// The return week's price (owner rulings: a paid week keeps its price; never
// retroactive; a rise needs 14 days' notice; a cut applies from the next week).
// The week a return buys starts at the return, so it is priced at the return
// like every other week is priced at its start, never at the unpaid week's
// date. Money already received for that unpaid week (an MMG approval) buys it
// at no more than was received; the rest stays fee credit.
const USD_RATE = 200; // GYD per USD in these books: 100 USD = RATE
const bookRow = (amountUsd: number, effectiveFrom: Date): PriceBookRow =>
  ({ id: `reanchor-${nanoid(8)}`, role: 'VENDOR', tier: 'RESTAURANT', amountUsd, effectiveFrom });
/** USD pricing on for this billing service only (never the shared database's switch). */
async function withPriceBook<T>(rows: PriceBookRow[], run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(billing as unknown as { loadUsdPricing: () => Promise<unknown> }, 'loadUsdPricing')
    .mockResolvedValue({ rateId: 'fx-reanchor', rate: USD_RATE, increment: 1, currency: 'GYD', book: bookAt(rows, new Date()), rows });
  try { return await run(); } finally { spy.mockRestore(); }
}
/** A suspended partner whose last paid week was 100 USD (= RATE). */
async function suspendedAfterPaying(due: Date) {
  const v = await brokeVendorSub(due);
  await app.prisma.billingEvent.create({ data: {
    subscriptionId: v.subId, type: 'CHARGE_SUCCESS', amount: RATE, currencyCode: 'GYD', amountUsd: 100, fxRateId: 'fx-reanchor', fxRateUsed: USD_RATE,
    idempotencyKey: `reanchor-paid-before:${v.subId}`, paymentRef: 'paid-before', createdAt: new Date(due.getTime() - 7 * DAY),
  } });
  await suspendFrom(v.subId, due);
  return v;
}
const told = (subId: string, row: PriceBookRow, at: Date) => app.prisma.billingEvent.create({ data: {
  subscriptionId: subId, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: priceBookNoticeKey(subId, row.id), deliveredAt: at,
} });
/** The return week's own charge: [GYD, USD]. */
async function returnWeekCharge(subId: string) {
  const s = await sub(subId);
  expect(s.status).toBe('ACTIVE');
  const week = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: `success:${subId}:${day(s.currentPeriodStart)}` } });
  expect(await app.prisma.billingObligationTransition.count({ where: { subscriptionId: subId, kind: 'RETURN_REANCHOR' } })).toBe(1);
  return [Number(week.amount), Number(week.amountUsd)];
}

describe('BILLING-REANCHOR — the return week is priced at its own start: a pending cut and a pending rise', () => {
  it('a cut that took effect while they were away is the return week\'s price; a rise told today but not yet in force is not charged', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const v = await suspendedAfterPaying(due);
    const cut = bookRow(80, new Date(due.getTime() + 2 * DAY));
    const rise = bookRow(120, new Date(Date.now() + 10 * DAY));
    await told(v.subId, rise, new Date());
    await withPriceBook([bookRow(100, new Date(due.getTime() - 60 * DAY)), cut, rise], () => topUp(v.subId, RATE, 'back after a cut'));
    // Priced at the unpaid week's date it would be 100 USD = 20,000: the cut is theirs.
    expect(await returnWeekCharge(v.subId)).toEqual([80 * USD_RATE, 80]);
    expect(await balance(v.subId)).toBe(RATE - 80 * USD_RATE);
  });

  it('a rise that took effect while they were away: not told 14 days before the return week, it keeps the price last paid; told in time, it is charged', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const rows = [bookRow(100, new Date(due.getTime() - 60 * DAY)), bookRow(120, new Date(due.getTime() + 3 * DAY))];
    const untold = await suspendedAfterPaying(due);
    const toldInTime = await suspendedAfterPaying(due);
    await told(toldInTime.subId, rows[1]!, new Date(Date.now() - 20 * DAY));
    await withPriceBook(rows, async () => {
      await topUp(untold.subId, 2 * RATE, 'back, never told of the rise');
      await topUp(toldInTime.subId, 2 * RATE, 'back, told 20 days ago');
    });
    expect(await returnWeekCharge(untold.subId)).toEqual([RATE, 100]);
    expect(await balance(untold.subId)).toBe(RATE);
    expect(await returnWeekCharge(toldInTime.subId)).toEqual([120 * USD_RATE, 120]);
    expect(await balance(toldInTime.subId)).toBe(2 * RATE - 120 * USD_RATE);
  });

  it('an MMG request priced before a cut and approved after it buys the return week at the cut price; the rest of the money stays fee credit', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const v = await suspendedAfterPaying(due);
    await billing.setBillingRail(v.subId, 'MOBILE_MONEY', '5926001236');
    const cut = bookRow(80, new Date(Date.now() + 60_000));
    const tick = new Date(Date.now() + 2 * 60_000); // MMG's lookup answers after the cut
    const request = await withPriceBook([bookRow(100, new Date(due.getTime() - 60 * DAY)), cut], async () => {
      expect(await billing.billSubscription(await subWithRelations(v.subId) as never)).toBe('pending');
      const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: v.subId, paymentMethod: 'MOBILE_MONEY' } });
      expect(Number(issued.amount)).toBe(RATE); // asked before the cut: 100 USD
      sandboxSetTxStatus(issued.externalRef!, 'approved');
      await billing.pollPendingMmgCharges(tick);
      return issued;
    });
    expect((await sub(v.subId)).currentPeriodStart.getTime()).toBe(tick.getTime());
    expect(await returnWeekCharge(v.subId)).toEqual([80 * USD_RATE, 80]);
    const credit = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: `bank:${request.id}` } });
    expect(Number(credit.amount)).toBe(RATE); // every dollar received is credited once
    expect(await balance(v.subId)).toBe(RATE - 80 * USD_RATE);
  });

  it('an MMG request priced before a told rise and approved after it: the return week costs what was asked, never more than was received', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const v = await suspendedAfterPaying(due);
    await billing.setBillingRail(v.subId, 'MOBILE_MONEY', '5926001237');
    const rise = bookRow(120, new Date(Date.now() + 60_000));
    await told(v.subId, rise, new Date(Date.now() - 20 * DAY));
    const tick = new Date(Date.now() + 2 * 60_000);
    await withPriceBook([bookRow(100, new Date(due.getTime() - 60 * DAY)), rise], async () => {
      expect(await billing.billSubscription(await subWithRelations(v.subId) as never)).toBe('pending');
      const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: v.subId, paymentMethod: 'MOBILE_MONEY' } });
      expect(Number(issued.amount)).toBe(RATE);
      sandboxSetTxStatus(issued.externalRef!, 'approved');
      await billing.pollPendingMmgCharges(tick);
    });
    expect(await returnWeekCharge(v.subId)).toEqual([RATE, 100]);
    expect(await balance(v.subId)).toBe(0);
  });
});

describe('BILLING-REANCHOR — the database admits only a proven, paid return', () => {
  /** Insert a re-anchor by hand, with chosen facts, inside one transaction. */
  async function forgeReanchor(subId: string, patch: { suspensionEventId?: string; nextDue?: Date } = {}) {
    return app.prisma.$transaction(async (tx) => {
      const clock = await tx.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: subId } });
      const s = await tx.subscription.findUniqueOrThrow({ where: { id: subId } });
      const suspension = await tx.billingEvent.findUnique({ where: { idempotencyKey: suspensionKey(subId, clock.dueAt) } });
      const suspensionEventId = patch.suspensionEventId ?? suspension!.id;
      const nextDue = patch.nextDue ?? new Date();
      const audit = await tx.auditLog.create({ data: { action: 'BILLING_CLOCK_RETURN_REANCHOR', entity: 'BillingDunningClock', entityId: clock.id,
        changes: { clockId: clock.id, tenantId: clock.tenantId, fromSubscriptionId: subId, subscriptionId: subId,
          previousEpoch: clock.epoch, nextEpoch: clock.epoch + 1, previousDue: clock.dueAt.toISOString(), nextDue: nextDue.toISOString(),
          suspensionEventId, currencyCode: s.currencyCode } } });
      return tx.billingObligationTransition.create({ data: { tenantId: clock.tenantId, clockId: clock.id, fromSubscriptionId: subId,
        subscriptionId: subId, kind: 'RETURN_REANCHOR', fromEpoch: clock.epoch, toEpoch: clock.epoch + 1, fromDue: clock.dueAt,
        toDue: nextDue, effectiveAt: nextDue, suspensionEventId, auditId: audit.id, amount: 0, currencyCode: s.currencyCode,
        periodStart: clock.dueAt, periodEnd: nextDue } });
    });
  }

  it('a re-anchor with no payment in its own transaction is refused at commit: no free weeks', async () => {
    const due = new Date(Date.now() - 9 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    const clockBefore = await clockOf(v.subId);
    await expect(app.prisma.$transaction((tx) => reanchorAtReturnInTx(tx, v.subId, new Date())))
      .rejects.toThrow(/Return re-anchor must be paid in its own transaction/);
    const clock = await clockOf(v.subId);
    expect([clock.epoch, clock.dueAt.getTime()]).toEqual([clockBefore.epoch, clockBefore.dueAt.getTime()]);
    expect((await sub(v.subId)).status).toBe('SUSPENDED');
  });

  it('a re-anchor proven by anything but this obligation\'s own suspension record is refused', async () => {
    const due = new Date(Date.now() - 9 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    const reminder = await app.prisma.billingEvent.create({ data: { subscriptionId: v.subId, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: `reminder-forged:${nanoid(8)}` } });
    await expect(forgeReanchor(v.subId, { suspensionEventId: reminder.id })).rejects.toThrow(/exact unused suspension/);
    const other = await app.prisma.billingEvent.create({ data: { subscriptionId: v.subId, type: 'SUSPENDED', currencyCode: 'GYD', idempotencyKey: suspensionKey(v.subId, new Date(due.getTime() - 7 * DAY)) } });
    await expect(forgeReanchor(v.subId, { suspensionEventId: other.id })).rejects.toThrow(/exact unused suspension/);
    // ...nor one that moves the obligation anywhere but forward.
    await expect(forgeReanchor(v.subId, { nextDue: new Date(due.getTime() - HOUR) })).rejects.toThrow(/exact unused suspension/);
  });

  it('a partner who is not suspended (PAST_DUE, still operating) can never be re-anchored', async () => {
    const due = new Date(Date.now() - 2 * HOUR);
    const v = await brokeVendorSub(due);
    await billing.runBillingCycle(due);
    expect((await sub(v.subId)).status).toBe('PAST_DUE');
    // Even holding a record shaped exactly like this obligation's suspension.
    await app.prisma.billingEvent.create({ data: { subscriptionId: v.subId, type: 'SUSPENDED', currencyCode: 'GYD', idempotencyKey: suspensionKey(v.subId, due) } });
    await expect(forgeReanchor(v.subId)).rejects.toThrow(/exact unused suspension/);
    // ...and a suspension moment on the row: only the status is left to refuse it.
    await app.prisma.subscription.update({ where: { id: v.subId }, data: { suspendedAt: new Date(Date.now() - HOUR) } });
    await expect(forgeReanchor(v.subId)).rejects.toThrow(/exact unused suspension/);
    expect((await sub(v.subId)).status).toBe('PAST_DUE');
  });

  it('one suspension authorizes one return: its record cannot be used again or altered', async () => {
    const due = new Date(Date.now() - 9 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    await topUp(v.subId, RATE, 'return');
    const suspension = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: suspensionKey(v.subId, due) } });
    // Put the row back in a suspended shape: the consumed record still cannot restart it.
    await app.prisma.subscription.update({ where: { id: v.subId }, data: { status: 'SUSPENDED', suspendedAt: new Date(Date.now() - HOUR) } });
    await expect(forgeReanchor(v.subId, { suspensionEventId: suspension.id })).rejects.toThrow();
    await expect(app.prisma.billingEvent.update({ where: { id: suspension.id }, data: { note: 'rewritten' } }))
      .rejects.toThrow(/Consumed billing event is immutable/);
  });
});
