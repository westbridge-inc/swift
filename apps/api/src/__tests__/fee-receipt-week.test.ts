import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { issueReceipt } from '../modules/billing/receipts';
import { NOT_USED_YET, PAID_TOWARD, feeReceiptDocument } from '../modules/billing/fee-receipt';
import { releaseCreditRefund, setAsideCreditRefund } from '../modules/billing/credit-refund';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [R12 · REVIEW-G #1771 S3-1 option a] A weekly-fee receipt says which week(s)
// its money covered. Each credit issues one receipt; each debit of that money
// records which receipts it used, oldest money first, in the debit's own
// transaction. Nothing is inferred from clocks: a receipt whose money has paid
// nothing yet says so, and one issued before weeks were tracked keeps the
// "paid toward" line.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// This file's own fixture block (+5920346nnn). No other file uses 5920346.
const PHONE_PREFIX = '+5920346';

let app: FastifyInstance;
let billing: BillingService;
let seq = 0;

const day = (at: Date) => at.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'long', year: 'numeric' });
const weekLine = (start: Date, amount: string) => `Week covered: ${day(start)} to ${day(new Date(start.getTime() + WEEK - 1))} (${amount})`;

/** A motorbike delivery rider paying cash, `weeklyRate` a week; the next fee is not due yet. */
async function makeRider(weeklyRate = 6000) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Week', lastName: `Covered${seq}`,
    roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER' as UserRole, countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  const rider = await app.prisma.rider.create({ data: {
    userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('fee-receipt-week'),
  } });
  const due = new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({ data: {
    riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate, billingMethod: 'CASH', autoRenew: true,
    currentPeriodStart: new Date(due.getTime() - WEEK), currentPeriodEnd: due, nextBillingDate: due,
  } });
  return { userId: user.id, subId: sub.id };
}

const subWithRelations = (subId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
/** Bill the next fee at its own due time (plus a minute): the clock is the
 *  billing call's argument, so no subscription row is aged by the fixture. */
async function billNextWeek(subId: string): Promise<Date> {
  const sub = await subWithRelations(subId);
  const start = sub.nextBillingDate;
  expect(await billing.billSubscription(sub as never, new Date(start.getTime() + 60_000))).toBe('succeeded');
  return start;
}
/** Money banked through the real credit path (receipt, ledger, wallet), as a
 *  late approval or a whole-payment capture is: banked, never refused, so it
 *  may hold more than the one week a recorded payment may. */
let banked = 0;
async function bank(subId: string, amount: number, mmgRef?: string): Promise<string> {
  banked += 1;
  const credit = (billing as unknown as { creditWalletInTx: (tx: unknown, o: Record<string, unknown>) => Promise<unknown> }).creditWalletInTx.bind(billing);
  await app.prisma.$transaction((tx) => credit(tx, {
    subscriptionId: subId, amount, currencyCode: 'GYD', eventKey: `fee-receipt-week-bank-${subId}-${banked}`,
    note: 'test: banked payment', channel: 'CARD_LATE_APPROVAL', rail: 'CARD', ...(mmgRef ? { mmgRef } : {}),
  }));
  const receipt = await app.prisma.feeReceipt.findFirstOrThrow({ where: { subscriptionId: subId }, orderBy: [{ issuedAt: 'desc' }, { receiptNumber: 'desc' }] });
  return receipt.receiptNumber;
}
let topUps = 0;
async function topUp(subId: string, amount: number): Promise<string> {
  topUps += 1;
  await billing.recordTopUp(subId, amount, 'fee-receipt-week-test', 'test credit', `fee-receipt-week-${subId}-${topUps}`);
  const receipt = await app.prisma.feeReceipt.findFirstOrThrow({ where: { subscriptionId: subId }, orderBy: [{ issuedAt: 'desc' }, { receiptNumber: 'desc' }] });
  return receipt.receiptNumber;
}
const lines = async (receiptNumber: string) => (await feeReceiptDocument(app.prisma, receiptNumber))!.lines;
const usage = async (receiptNumber: string) => (await lines(receiptNumber)).filter((l) => /^(Week covered|Not used yet|Returned by MMG|Set aside for a refund|Paid toward)/.test(l));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // sandbox: a way to pay is live, so no fee pause holds billing
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await purgeBlock();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

async function purgeBlock() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const subs = await app.prisma.subscription.findMany({ where: { rider: { userId: { in: ids } } }, select: { id: true } });
  const sids = subs.map((s) => s.id);
  await cleanupBillingClocks(app.prisma, sids);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  // Receipts (and what they paid) stay: the numbers are gapless by law and the rows outlive their account.
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...sids, ...ids] } }, { userId: { in: ids } }] }, 'test-cleanup:fee-receipt-week');
  await app.prisma.subscription.deleteMany({ where: { id: { in: sids } } });
}

afterAll(async () => {
  await purgeBlock();
  await app.close();
});

describe('[R12] a weekly-fee receipt names the week(s) its money covered', () => {
  it('names no week until its money pays one; then the week it covered', async () => {
    const { subId } = await makeRider(6000);
    const first = await topUp(subId, 6000); // one week's fee: the most a recorded payment may hold
    expect(await usage(first)).toEqual([PAID_TOWARD]);
    const week1 = await billNextWeek(subId);
    expect(await usage(first)).toEqual([weekLine(week1, 'GY$6,000')]);
    expect(await lines(first)).toContain('Weekly fee: GY$6,000');
    // The next payment pays the next week, on its own receipt; the first receipt keeps its week.
    const second = await bank(subId, 6000);
    expect(await usage(second)).toEqual([PAID_TOWARD]);
    const week2 = await billNextWeek(subId);
    expect(week2.getTime()).toBe(week1.getTime() + WEEK);
    expect(await usage(second)).toEqual([weekLine(week2, 'GY$6,000')]);
    expect(await usage(first)).toEqual([weekLine(week1, 'GY$6,000')]);
  });

  it('oldest money first: a week paid from two payments is named on both, for the part each paid', async () => {
    const { subId } = await makeRider(6000);
    const older = await topUp(subId, 4000);
    const newer = await bank(subId, 4000); // 8,000 held: the week takes all of the older money first
    const week = await billNextWeek(subId);
    expect(await usage(older)).toEqual([weekLine(week, 'GY$4,000')]);
    expect(await usage(newer)).toEqual([weekLine(week, 'GY$2,000'), NOT_USED_YET('GY$2,000')]);
  });

  it('money banked beyond one week names each week it pays, and what is not used yet', async () => {
    const { subId } = await makeRider(6000);
    const receipt = await bank(subId, 12_000);
    expect(await usage(receipt)).toEqual([PAID_TOWARD]);
    const week1 = await billNextWeek(subId);
    expect(await usage(receipt)).toEqual([weekLine(week1, 'GY$6,000'), NOT_USED_YET('GY$6,000')]);
    const week2 = await billNextWeek(subId);
    expect(await usage(receipt)).toEqual([weekLine(week1, 'GY$6,000'), weekLine(week2, 'GY$6,000')]);
  });

  it('money credited before weeks were tracked is the oldest and is used first; a receipt issued before keeps "paid toward"', async () => {
    const { subId } = await makeRider(6000);
    // Credit from before this existed: a receipt that does not track its weeks, and the money it left.
    const event = await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'PREPAID_TOPUP', amount: 6000, currencyCode: 'GYD', idempotencyKey: `fee-receipt-week-legacy:${subId}` } });
    const legacy = (await issueReceipt(app.prisma, { subscriptionId: subId, billingEventId: event.id, amount: 6000, tenantId: 'swift-default' })).receiptNumber;
    await app.prisma.feeReceipt.update({ where: { receiptNumber: legacy }, data: { weeksTracked: false } });
    await app.prisma.prepaidBalance.upsert({ where: { subscriptionId: subId }, update: { balance: 6000 }, create: { subscriptionId: subId, balance: 6000, currencyCode: 'GYD' } });
    const tracked = await bank(subId, 6000);
    const week1 = await billNextWeek(subId); // paid with the older, untracked money
    expect(await usage(tracked)).toEqual([PAID_TOWARD]);
    expect(await usage(legacy)).toEqual([PAID_TOWARD]);
    const week2 = await billNextWeek(subId);
    expect(await usage(tracked)).toEqual([weekLine(week2, 'GY$6,000')]);
    expect(await usage(legacy)).toEqual([PAID_TOWARD]);
    expect(await app.prisma.feeReceiptAllocation.count({ where: { receipt: { receiptNumber: legacy } } })).toBe(0);
    expect(week2.getTime()).toBe(week1.getTime() + WEEK);
  });

  it('a payment MMG returned is taken from its own receipt first; a refund set aside and released gives the money back', async () => {
    const { subId, userId } = await makeRider(6000);
    const ref = (k: string) => `MMG${k}${subId.slice(-8)}`;
    const credit = async (amount: number, mmgRef: string) => {
      const ev = await app.prisma.billingEvent.create({ data: { subscriptionId: subId, type: 'PREPAID_TOPUP', amount, currencyCode: 'GYD', idempotencyKey: `fee-receipt-week-${mmgRef}` } });
      return (await issueReceipt(app.prisma, { subscriptionId: subId, billingEventId: ev.id, amount, mmgRef, tenantId: 'swift-default' })).receiptNumber;
    };
    const a = await credit(3000, ref('A'));
    const b = await credit(3000, ref('B'));
    await app.prisma.prepaidBalance.upsert({ where: { subscriptionId: subId }, update: { balance: 6000 }, create: { subscriptionId: subId, balance: 6000, currencyCode: 'GYD' } });
    // MMG returns payment B (the wallet debit of the reversal flow): B's own money goes first, though A is older.
    const returned = await app.prisma.$transaction((tx) => billing.debitWalletForReversalInTx(tx, {
      subscriptionId: subId, amount: 3000, currencyCode: 'GYD', eventKey: `fee-receipt-week-return-${subId}`, note: 'test return', mmgRef: ref('B') }));
    expect('eventId' in returned).toBe(true);
    expect(await usage(b)).toEqual(['Returned by MMG: GY$3,000']);
    expect(await usage(a)).toEqual([PAID_TOWARD]);
    // The 3,000 left is set aside for a refund, then released unpaid (the console's two steps).
    const aside = await setAsideCreditRefund(app.prisma, { adminId: userId, approvalId: `fee-receipt-week-aside-${subId}`, subscriptionId: subId, amount: 3000 });
    expect(await usage(a)).toEqual(['Set aside for a refund: GY$3,000']);
    await releaseCreditRefund(app.prisma, { adminId: userId, approvalId: `fee-receipt-week-release-${subId}`, subscriptionId: subId, amount: 3000, setAsideId: aside.billingEventId });
    expect(await usage(a)).toEqual([NOT_USED_YET('GY$3,000')]);
    expect(await usage(b)).toEqual(['Returned by MMG: GY$3,000']);
  });

  it('what a payment paid is never rewritten', async () => {
    const { subId } = await makeRider(6000);
    const receipt = await topUp(subId, 6000);
    await billNextWeek(subId);
    const row = await app.prisma.feeReceiptAllocation.findFirstOrThrow({ where: { receipt: { receiptNumber: receipt } } });
    await expect(app.prisma.feeReceiptAllocation.update({ where: { id: row.id }, data: { amount: 1 } })).rejects.toThrow(/immutable/);
  });
});
