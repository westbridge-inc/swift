import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { readPayAhead } from '../modules/billing/pay-ahead';
import {
  FEE_RISE_NOTICE_DAYS, feeRiseCopy, feeRiseKey, firstFeeOnOrAfter, holdFeeRiseInTx, readHeldFeeRise, riseAppliesFrom, type FeeRiseSource,
} from '../modules/billing/fee-rise-notice';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [F2 · GUARDRAILS §7 standing rule 2 · Mover and Business Agreements F2] A
// weekly-fee rise that a finance resolution (#1844) or a taxi activation
// (#1855) HELD is told in the app 14 days ahead, naming the old fee, the new
// fee and the first weekly fee it applies to, and applies from that fee only.
// A week already paid keeps its price. A rise never told applies to nothing.
// (modules/billing/fee-rise-notice.ts holds the rule.)
//
// Before this, a held rise had no reader: the partner kept the old fee for
// ever and was never told (REVIEW-M #1844 S4-4).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// This file's own fixture block (+5920329nnn). No other file uses 5920329.
const PHONE_PREFIX = '+5920329';

let app: FastifyInstance;
let billing: BillingService;
let seq = 0;

async function makeUser() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Fee', lastName: `Rise${seq}`, roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER' as UserRole, countryCode: 'GY',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  return user.id;
}

/** A motorbike delivery rider paying cash, `weeklyRate` a week, next fee `due`. */
async function makeRider(opts: { weeklyRate: number; due: Date; prepaid?: number }) {
  const userId = await makeUser();
  const rider = await app.prisma.rider.create({
    data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('fee-rise-notice') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: opts.weeklyRate, billingMethod: 'CASH', autoRenew: true,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK), currentPeriodEnd: opts.due, nextBillingDate: opts.due,
      prepaidBalance: { create: { balance: opts.prepaid ?? 0, currencyCode: 'GYD' } },
    },
  });
  return { userId, subId: sub.id };
}

const hold = (subId: string, from: number, to: number, now = new Date(), source: FeeRiseSource = 'TAXI_ACTIVATION') =>
  app.prisma.$transaction((tx) => holdFeeRiseInTx(tx, { subscriptionId: subId, from, to, currencyCode: 'GYD', source, now }));
const subWithRelations = (subId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
const rate = async (subId: string) => Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).weeklyRate);
const heldOf = async (subId: string) => {
  const row = await app.prisma.platformConfig.findUnique({ where: { key: feeRiseKey(subId) } });
  return row ? readHeldFeeRise(row.value) : null;
};
const notices = (userId: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: 'billing_rate_change' } }, orderBy: { createdAt: 'asc' },
});
const capturedFor = (subId: string, periodStart: Date) => app.prisma.subscriptionPayment.findFirst({
  where: { subscriptionId: subId, periodStart, status: 'CAPTURED' },
});
const topUp = (subId: string, balance: number) => app.prisma.prepaidBalance.update({ where: { subscriptionId: subId }, data: { balance } });
const bill = async (subId: string, now: Date) => billing.billSubscription((await subWithRelations(subId)) as never, now);
const audits = (subId: string, action: string) => app.prisma.auditLog.findMany({ where: { entity: 'Subscription', entityId: subId, action }, orderBy: { createdAt: 'asc' } });
const guyanaDay = (at: Date) => at.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', weekday: 'long', day: 'numeric', month: 'long' });

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
  await app.prisma.platformConfig.deleteMany({ where: { key: { in: sids.map(feeRiseKey) } } });
  await cleanupBillingClocks(app.prisma, sids);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  // Billing a mover classifies its fee authority (its decision is an audit row): it survives only
  // through its payer, so the users go first (riders with them), then the audits, then the plans.
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...sids, ...ids] } }, { userId: { in: ids } }] }, 'test-cleanup:fee-rise-notice');
  await app.prisma.subscription.deleteMany({ where: { id: { in: sids } } });
}

afterAll(async () => {
  await purgeBlock();
  await app.close();
});

describe('the dates', () => {
  it('the first fee a rise applies to is at least 14 days (and an hour) after the notice, on the partner\'s own fee days', () => {
    const next = new Date('2026-10-22T14:00:00Z'); // a Thursday fee
    const told = new Date('2026-10-18T19:00:00Z');
    // 14 days after the notice is Sun 1 Nov: the first fee on or after it is Thu 5 Nov (two weeks after the next).
    expect(riseAppliesFrom(next, told).toISOString()).toBe('2026-11-05T14:00:00.000Z');
    // A fee that falls exactly 14 days after the notice is too close by the hour's margin: the next one.
    expect(riseAppliesFrom(next, new Date('2026-10-22T14:00:00Z')).toISOString()).toBe('2026-11-12T14:00:00.000Z');
    // A next fee already 14+ days away is the one.
    expect(riseAppliesFrom(new Date('2026-11-10T14:00:00Z'), told).toISOString()).toBe('2026-11-10T14:00:00.000Z');
    expect(firstFeeOnOrAfter(next, next).toISOString()).toBe(next.toISOString());
  });

  it('a record that would charge more, or sooner than 14 days after its notice, is not a held rise', () => {
    const base = { from: 6000, to: 8000, currencyCode: 'GYD', source: 'TAXI_ACTIVATION', heldAt: '2026-10-18T19:00:00.000Z', noticeAt: null, appliesFrom: null };
    expect(readHeldFeeRise(base)).toMatchObject({ from: 6000, to: 8000 });
    expect(readHeldFeeRise({ ...base, to: 6000 })).toBeNull(); // not a rise
    expect(readHeldFeeRise({ ...base, from: 0 })).toBeNull(); // no rate to rise from
    expect(readHeldFeeRise({ ...base, from: '6000' })).toBeNull();
    expect(readHeldFeeRise({ ...base, source: 'CONSOLE' })).toBeNull();
    expect(readHeldFeeRise({ ...base, noticeAt: '2026-10-18T19:00:00.000Z' })).toBeNull(); // told with no date
    const told = { ...base, noticeAt: '2026-10-18T19:00:00.000Z' };
    expect(readHeldFeeRise({ ...told, appliesFrom: '2026-11-01T18:59:59.000Z' })).toBeNull(); // 1 s short of 14 days
    expect(readHeldFeeRise({ ...told, appliesFrom: '2026-11-01T19:00:00.000Z' })).toMatchObject({ appliesFrom: '2026-11-01T19:00:00.000Z' });
  });

  it('a notice without a date (never sent: the run dates every notice) still promises only the 14 days, and names the phone\'s control', () => {
    // [REVIEW-F #1884 S4-1/S4-2]
    const { body } = feeRiseCopy('RISE', { from: 6000, to: 8000, currencyCode: 'GYD', date: null });
    expect(body).toBe('From your first weekly fee due at least 14 days from today, your Swift weekly fee will be GY$8,000 (it is GY$6,000 now). '
      + 'Until then nothing changes, and any week you have already paid keeps the price you paid. '
      + 'If you do not want the new fee, tap Stop weekly billing in Swift before then and you will not pay it.');
  });
});

describe('[F2] a held weekly-fee rise is told 14 days ahead and applies only from the fee it was told for', () => {
  it('told with the old fee, the new fee and its date; nothing changes before it; the week before it is charged at the old fee; the told fee moves in with that paid week', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY); // the next fee is 3 days away: too soon for the rise
    const rider = await makeRider({ weeklyRate: 6000, due, prepaid: 6000 });
    expect(await hold(rider.subId, 6000, 8000, t)).toBe('held');
    expect((await audits(rider.subId, 'BILLING_FEE_RISE_HELD')).map((a) => a.changes)).toEqual([expect.objectContaining({ from: 6000, to: 8000, source: 'TAXI_ACTIVATION', noticeDays: 14 })]);
    // Held, not told: nothing anywhere says 8,000 yet, and the rate on record is the one being paid.
    expect(await heldOf(rider.subId)).toMatchObject({ from: 6000, to: 8000, noticeAt: null, appliesFrom: null });
    expect(await rate(rider.subId)).toBe(6000);
    expect(await notices(rider.userId)).toHaveLength(0);

    // (Counts are the whole table's: other files' rows may be in it, so each check is this partner's.)
    await billing.sweepFeeRises(t);
    expect(await rate(rider.subId)).toBe(6000);
    // Told, in the inbox (and pushed), with both fees and the date it applies from.
    const firstNewFee = new Date(due.getTime() + 2 * WEEK); // the first fee at least 14 days after the notice
    const [notice, ...more] = await notices(rider.userId);
    expect(more).toHaveLength(0);
    expect(notice!.type).toBe('SYSTEM_ANNOUNCEMENT');
    expect(notice!.title).toBe('Your weekly fee is changing');
    expect(notice!.data).toMatchObject({ kind: 'billing_rate_change', change: 'RISE', subscriptionId: rider.subId, weeklyFee: 8000, previousWeeklyFee: 6000, appliesFrom: firstNewFee.toISOString(), audience: 'earner' });
    expect(notice!.body).toBe(`From your weekly fee due ${guyanaDay(firstNewFee)}, your Swift weekly fee will be GY$8,000 (it is GY$6,000 now). `
      + 'Until then nothing changes, and any week you have already paid keeps the price you paid. '
      + 'If you do not want the new fee, tap Stop weekly billing in Swift before then and you will not pay it.');
    const held = await heldOf(rider.subId);
    expect(held).toMatchObject({ from: 6000, to: 8000, appliesFrom: firstNewFee.toISOString(), inboxId: notice!.id });
    expect(new Date(held!.appliesFrom!).getTime() - new Date(held!.noticeAt!).getTime()).toBeGreaterThanOrEqual(FEE_RISE_NOTICE_DAYS * DAY);
    expect((await audits(rider.subId, 'BILLING_FEE_RISE_TOLD')).map((a) => a.changes)).toEqual([expect.objectContaining({ from: 6000, to: 8000, appliesFrom: firstNewFee.toISOString(), inboxId: notice!.id })]);

    // Another run tells nobody twice and changes nothing; the same hold again is left as it is.
    expect(await hold(rider.subId, 6000, 8000, new Date(t.getTime() + 1000))).toBe('unchanged');
    await billing.sweepFeeRises(new Date(t.getTime() + DAY));
    expect(await notices(rider.userId)).toHaveLength(1);
    expect(await rate(rider.subId)).toBe(6000);
    expect((await heldOf(rider.subId))?.noticeAt).toBe(held!.noticeAt);

    // The week due in 3 days: the old fee.
    expect(await bill(rider.subId, new Date(due.getTime() + 60_000))).toBe('succeeded');
    expect(Number((await capturedFor(rider.subId, due))!.amount)).toBe(6000);
    expect(await rate(rider.subId)).toBe(6000); // the next week still starts before the told date
    await billing.sweepFeeRises(new Date(due.getTime() + DAY));
    expect(await rate(rider.subId)).toBe(6000);
    // The week after: still the old fee.
    const lastOld = new Date(due.getTime() + WEEK);
    await topUp(rider.subId, 6000);
    expect(await bill(rider.subId, new Date(lastOld.getTime() + 60_000))).toBe('succeeded');
    expect(Number((await capturedFor(rider.subId, lastOld))!.amount)).toBe(6000);
    // That paid week was the last before the told date: the told fee moved in with it, on the record.
    expect(await rate(rider.subId)).toBe(8000);
    expect(await heldOf(rider.subId)).toBeNull();
    const moved = await app.prisma.billingEvent.findMany({ where: { subscriptionId: rider.subId, type: 'TIER_CHANGE' } });
    expect(moved.map((e) => [Number(e.amount), e.idempotencyKey.endsWith(':6000->8000')])).toEqual([[8000, true]]);
    expect((await audits(rider.subId, 'BILLING_FEE_RISE_APPLIED')).map((a) => a.changes)).toEqual([expect.objectContaining({ from: 6000, to: 8000, firstFeeAtNewRate: firstNewFee.toISOString() })]);
    // From now the coming week is quoted at the told fee.
    expect((await readPayAhead(app.prisma, rider.subId, new Date(lastOld.getTime() + DAY)))!.weeklyFee).toBe(8000);
    // The first fee at the told date is charged at it.
    await topUp(rider.subId, 8000);
    expect(await bill(rider.subId, new Date(firstNewFee.getTime() + 60_000))).toBe('succeeded');
    expect(Number((await capturedFor(rider.subId, firstNewFee))!.amount)).toBe(8000);
  });

  it('a next fee already 14 days away is the one the rise starts with: it moves in when told, so that week is quoted at it', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 15 * DAY);
    const rider = await makeRider({ weeklyRate: 6000, due });
    await hold(rider.subId, 6000, 8000, t);
    await billing.sweepFeeRises(t);
    const [notice] = await notices(rider.userId);
    expect(notice!.data).toMatchObject({ appliesFrom: due.toISOString(), weeklyFee: 8000, previousWeeklyFee: 6000 });
    expect(await rate(rider.subId)).toBe(8000);
    expect((await readPayAhead(app.prisma, rider.subId, t))!.weeklyFee).toBe(8000);
  });

  it('the hourly billing run tells and applies held rises before it prices anything', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 15 * DAY);
    const rider = await makeRider({ weeklyRate: 6000, due });
    await hold(rider.subId, 6000, 8000, t);
    await billing.runBillingCycle(t);
    expect(await notices(rider.userId)).toHaveLength(1);
    expect(await rate(rider.subId)).toBe(8000);
  });

  it('a notice that could not be delivered tells nothing and applies nothing, however long it waits; its date counts from the delivery', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const rider = await makeRider({ weeklyRate: 6000, due, prepaid: 6000 });
    await hold(rider.subId, 6000, 8000, t);
    const silent = new BillingService(app.prisma, { send: async () => '', sendReach: async () => ({ id: '', pushed: false }) } as unknown as NotificationService, getPaymentProvider());
    await silent.sweepFeeRises(t);
    expect(await heldOf(rider.subId)).toMatchObject({ noticeAt: null, appliesFrom: null });
    // Three weeks pass, never told: every week keeps the old fee, the rise applies to nothing.
    for (const week of [0, 1, 2]) {
      const start = new Date(due.getTime() + week * WEEK);
      await topUp(rider.subId, 6000);
      await silent.sweepFeeRises(new Date(start.getTime() + 30_000));
      expect(await silent.billSubscription((await subWithRelations(rider.subId)) as never, new Date(start.getTime() + 60_000))).toBe('succeeded');
      expect(Number((await capturedFor(rider.subId, start))!.amount)).toBe(6000);
      expect(await rate(rider.subId)).toBe(6000);
    }
    // Delivered at last, three weeks on: its date is counted from then, never from when it was held.
    const late = new Date(due.getTime() + 2 * WEEK + DAY);
    await billing.sweepFeeRises(late);
    const told = await heldOf(rider.subId);
    expect(told?.noticeAt).not.toBeNull();
    expect(new Date(told!.appliesFrom!).getTime()).toBeGreaterThanOrEqual(late.getTime() + FEE_RISE_NOTICE_DAYS * DAY);
    expect(await rate(rider.subId)).toBe(6000);
  });

  it('a week already paid at the old fee keeps it: the rise moves one week later, once', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const rider = await makeRider({ weeklyRate: 6000, due, prepaid: 6000 });
    await hold(rider.subId, 6000, 8000, t);
    await billing.sweepFeeRises(t);
    const firstNewFee = new Date(due.getTime() + 2 * WEEK);
    expect((await heldOf(rider.subId))?.appliesFrom).toBe(firstNewFee.toISOString());
    expect(await bill(rider.subId, new Date(due.getTime() + 60_000))).toBe('succeeded');
    // Two weeks' money at the old fee before the last old week is billed: the week at the told date is paid too.
    await topUp(rider.subId, 12_000);
    const lastOld = new Date(due.getTime() + WEEK);
    expect(await bill(rider.subId, new Date(lastOld.getTime() + 60_000))).toBe('succeeded');
    expect(await rate(rider.subId)).toBe(6000);
    const deferred = await heldOf(rider.subId);
    expect(deferred).toMatchObject({ deferredOnce: true, appliesFrom: new Date(firstNewFee.getTime() + WEEK).toISOString() });
    expect((await audits(rider.subId, 'BILLING_FEE_RISE_DEFERRED')).map((a) => a.changes)).toEqual([expect.objectContaining({ paidAtOldPrice: 6000, weekKeepsOldPrice: firstNewFee.toISOString() })]);
    // The week at the told date keeps the old fee it was paid at ...
    expect(await bill(rider.subId, new Date(firstNewFee.getTime() + 60_000))).toBe('succeeded');
    expect(Number((await capturedFor(rider.subId, firstNewFee))!.amount)).toBe(6000);
    // ... and the rise moves in with it, once (no second deferral).
    expect(await rate(rider.subId)).toBe(8000);
    expect(await heldOf(rider.subId)).toBeNull();
  });

  it('a told rise that no longer matches is dropped and the partner is told it will not happen; an untold one is dropped silently', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    // Told, then a negotiated fee is set: dropped, and told.
    const negotiated = await makeRider({ weeklyRate: 6000, due });
    await hold(negotiated.subId, 6000, 8000, t);
    await billing.sweepFeeRises(t);
    await app.prisma.subscription.update({ where: { id: negotiated.subId }, data: { customRate: 5000 } });
    await billing.sweepFeeRises(new Date(t.getTime() + DAY));
    expect(await heldOf(negotiated.subId)).toBeNull();
    expect((await audits(negotiated.subId, 'BILLING_FEE_RISE_DROPPED')).map((a) => a.changes)).toEqual([expect.objectContaining({ why: 'NEGOTIATED_RATE', told: true })]);
    const said = await notices(negotiated.userId);
    expect(said.map((n) => n.title)).toEqual(['Your weekly fee is changing', 'Your weekly fee is not changing']);
    expect(said[1]!.body).toContain('will not happen: your Swift weekly fee stays GY$5,000.');
    expect(await rate(negotiated.subId)).toBe(6000);
    // Held, not told, and the rate moved under it (a cut): dropped, nobody told anything.
    const moved = await makeRider({ weeklyRate: 6000, due });
    await hold(moved.subId, 6000, 8000, t);
    await app.prisma.subscription.update({ where: { id: moved.subId }, data: { weeklyRate: 5500 } });
    await billing.sweepFeeRises(t);
    expect(await heldOf(moved.subId)).toBeNull();
    expect(await notices(moved.userId)).toHaveLength(0);
    expect((await audits(moved.subId, 'BILLING_FEE_RISE_DROPPED')).map((a) => a.changes)).toEqual([expect.objectContaining({ why: 'RATE_MOVED', told: false, rateNow: 5500 })]);
    expect(await rate(moved.subId)).toBe(5500);
  });

  it('nothing is held for a negotiated or waived fee, nor for a change that is not a rise', async () => {
    const due = new Date(Date.now() + 3 * DAY);
    const custom = await makeRider({ weeklyRate: 6000, due });
    await app.prisma.subscription.update({ where: { id: custom.subId }, data: { customRate: 5000 } });
    expect(await hold(custom.subId, 6000, 8000)).toBe('not-a-rise');
    const waived = await makeRider({ weeklyRate: 6000, due });
    await app.prisma.subscription.update({ where: { id: waived.subId }, data: { feeWaived: true, feeWaivedBy: 'test-admin', feeWaivedReason: 'test waiver' } });
    expect(await hold(waived.subId, 6000, 8000)).toBe('not-a-rise');
    const plain = await makeRider({ weeklyRate: 6000, due });
    expect(await hold(plain.subId, 6000, 6000)).toBe('not-a-rise');
    expect(await hold(plain.subId, 6000, 5000)).toBe('not-a-rise');
    expect(await hold(plain.subId, 7000, 8000)).toBe('not-a-rise'); // not the rate it pays
    for (const s of [custom, waived, plain]) expect(await heldOf(s.subId)).toBeNull();
  });

  it('a stored record dated sooner than 14 days after its notice applies to nothing', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const rider = await makeRider({ weeklyRate: 6000, due, prepaid: 6000 });
    // Forged: told now, "applies" from the fee in 3 days.
    await app.prisma.platformConfig.create({ data: { key: feeRiseKey(rider.subId), value: {
      from: 6000, to: 8000, currencyCode: 'GYD', source: 'TAXI_ACTIVATION', heldAt: t.toISOString(), noticeAt: t.toISOString(), appliesFrom: due.toISOString(), inboxId: null,
    } } });
    await billing.sweepFeeRises(new Date(due.getTime() + 30_000));
    expect(await bill(rider.subId, new Date(due.getTime() + 60_000))).toBe('succeeded');
    expect(Number((await capturedFor(rider.subId, due))!.amount)).toBe(6000);
    expect(await rate(rider.subId)).toBe(6000);
    expect(await notices(rider.userId)).toHaveLength(0);
  });
});
