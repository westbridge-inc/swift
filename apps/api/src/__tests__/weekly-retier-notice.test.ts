import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole, VehicleType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { WEEKLY_RETIER_ON } from '../modules/billing/weekly-retier';
import { FEE_RISE_NOTICE_DAYS, feeRiseKey, holdChainDealRiseInTx, readHeldFeeRise, retierCutBy, retierMovesInFrom, riseAppliesFrom } from '../modules/billing/fee-rise-notice';
import { CATALOGUE_COUNT_WORDS } from '../modules/partner/store-fee';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [RETIER PR-B · owner 30 Oct 2026 15:54Z "okay" · research F2 · GUARDRAILS §7 standing rule 2] The weekly re-tier,
// switched ON here (runWeeklyRetier(true)); WEEKLY_RETIER_ON itself stays false until the owner's go after launch.
//
//  - a store whose catalogue reached a higher step gets ONE recorded notice (inbox + push): WHY (its items and the
//    step), the new fee, the first weekly fee it applies to (at least 14 full days after the notice), that nothing
//    changes until then, how to bring it back down, and how to say no; the fee moves only from that weekly fee;
//  - back under the step before the new fee starts (judged on the week's largest catalogue, so hiding listings just
//    before a count never counts), the change is cancelled and the store is told — on the next weekly count, or at
//    the moment the new fee would start;
//  - a rider whose vehicle moved them up is told why (the vehicle);
//  - agreed (chain deal) rates never rise; PAUSED and SUSPENDED plans are told and moved like any other (OWNER-
//    DECISIONS 30 Sep, line 9); re-runs never tell twice or move twice; every step is an audit row.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// This file's own fixture block (+5920341nnn). No other file uses 5920341.
const PHONE_PREFIX = '+5920341';
const RUN = wordFreeTag(6).toLowerCase();

let app: FastifyInstance;
let billing: BillingService;
let seq = 0;
let small = 0;
let large = 0;
let dept = 0;
let largeFloor = 0;
let mover = 0;
let moverHeavy = 0;
/** Every plan this file made: each pass below runs over these only, never over other files' fixtures. */
const mine: string[] = [];
const scope = () => ({ subscriptionIds: mine });

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Retier', lastName: `Notice${seq}`, roles, activeRole, countryCode: 'GY',
    isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  return user.id;
}

/** A supermarket billed `weeklyRate` a week, its next fee `due`, with `items` listings. */
async function makeStore(opts: { weeklyRate: number; due: Date; items: number; status?: SubscriptionStatus; deal?: number; prepaid?: number }) {
  const userId = await makeUser(['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: {
    userId,
    ...(opts.deal !== undefined ? { dealWeeklyRate: opts.deal, dealCurrencyCode: 'GYD', dealSetAt: new Date(), dealSetBy: 'retier-test', dealReason: 'retier notice test' } : {}),
  } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Retier Mart ${seq}`, slug: `retier-notice-${RUN}-${seq}-${nanoid(5).toLowerCase()}`, vendorType: 'SUPERMARKET',
    phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: '1 Retier Street', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
  } });
  const sub = await app.prisma.subscription.create({ data: {
    vendorId: vendor.id, type: 'SUPERMARKET', status: opts.status ?? 'ACTIVE', weeklyRate: opts.weeklyRate, billingMethod: 'CASH',
    ...(opts.deal !== undefined ? { customRate: opts.deal } : {}),
    autoRenew: opts.status !== 'PAUSED', currentPeriodStart: new Date(opts.due.getTime() - WEEK), currentPeriodEnd: opts.due, nextBillingDate: opts.due,
    ...(opts.prepaid !== undefined ? { prepaidBalance: { create: { balance: opts.prepaid, currencyCode: 'GYD' } } } : {}),
  } });
  if (opts.items > 0) await addItems(vendor.id, opts.items);
  mine.push(sub.id);
  return { userId, vendorId: vendor.id, subId: sub.id, name: vendor.name };
}

/** `n` listings, available (or hidden, last edited `updatedAt`), in one statement. */
async function addItems(vendorId: string, n: number, opts: { available?: boolean; updatedAt?: Date } = {}) {
  const category = await app.prisma.category.create({ data: { vendorId, name: `Aisle ${wordFreeTag(4)}`, sortOrder: 0 } });
  await app.prisma.$executeRaw`
    INSERT INTO "items" ("id", "vendorId", "categoryId", "tenantId", "name", "basePrice", "isAvailable", "updatedAt", "createdAt")
    SELECT 'rn-' || ${category.id} || '-' || g, ${vendorId}, ${category.id}, 'swift-default', 'Item ' || g, 100, ${opts.available ?? true},
           ${opts.updatedAt ?? new Date()}, now()
    FROM generate_series(1, ${n}) AS g`;
}

/** The store hides `n` of its listings, last edited `ago` ms before now. */
async function hide(vendorId: string, n: number, ago: number) {
  await app.prisma.$executeRaw`
    UPDATE "items" SET "isAvailable" = false, "updatedAt" = ${new Date(Date.now() - ago)}
    WHERE "id" IN (SELECT "id" FROM "items" WHERE "vendorId" = ${vendorId} AND "isAvailable" = true ORDER BY "id" LIMIT ${n})`;
}

/** The store hides `n` of its listings, last edited at `at` (a test clock moment, not the wall clock). */
async function hideAt(vendorId: string, n: number, at: Date) {
  await app.prisma.$executeRaw`
    UPDATE "items" SET "isAvailable" = false, "updatedAt" = ${at}
    WHERE "id" IN (SELECT "id" FROM "items" WHERE "vendorId" = ${vendorId} AND "isAvailable" = true ORDER BY "id" LIMIT ${n})`;
}

/** A delivery rider on `vehicleType`, billed `weeklyRate`, its next fee `due`. */
async function makeRider(opts: { weeklyRate: number; due: Date; vehicleType: VehicleType }) {
  const userId = await makeUser(['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER');
  const rider = await app.prisma.rider.create({ data: {
    userId, riderType: 'DELIVERY', vehicleType: opts.vehicleType, documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('retier-notice'),
  } });
  const sub = await app.prisma.subscription.create({ data: {
    riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: opts.weeklyRate, billingMethod: 'CASH', autoRenew: true,
    currentPeriodStart: new Date(opts.due.getTime() - WEEK), currentPeriodEnd: opts.due, nextBillingDate: opts.due,
  } });
  mine.push(sub.id);
  return { userId, subId: sub.id };
}

const sub = (subId: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
const rate = async (subId: string) => Number((await sub(subId)).weeklyRate);
const heldOf = async (subId: string) => {
  const row = await app.prisma.platformConfig.findUnique({ where: { key: feeRiseKey(subId) } });
  return row ? readHeldFeeRise(row.value) : null;
};
const notices = (userId: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: 'billing_rate_change' } }, orderBy: { createdAt: 'asc' },
});
const audits = (subId: string, action: string) => app.prisma.auditLog.findMany({ where: { entity: 'Subscription', entityId: subId, action }, orderBy: { createdAt: 'asc' } });
const subWithRelations = (subId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
const bill = async (subId: string, now: Date) => billing.billSubscription((await subWithRelations(subId)) as never, now);
const tierChanges = (subId: string) => app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: 'TIER_CHANGE' } });
/** A store told a rise, then told it will not happen: both notices name the store. */
const toldThenCancelled = (name: string) => [`${name}: your weekly fee is changing`, `${name}: your weekly fee is not changing`];
const guyanaDay = (at: Date) => at.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', weekday: 'long', day: 'numeric', month: 'long' });
const money = (n: number) => `GY$${n.toLocaleString('en-US')}`;
/** The weeks before the told date were billed: the next fee to charge is the told one. */
const reachToldFee = async (subId: string) => {
  const held = (await heldOf(subId))!;
  await app.prisma.subscription.update({ where: { id: subId }, data: { nextBillingDate: new Date(held.appliesFrom!) } });
  return new Date(held.appliesFrom!);
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER'];
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await purgeBlock();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
  const tiers = gy.subscriptionTiers as Record<string, number>;
  small = tiers['smallVendor']!; large = tiers['largeVendor']!; dept = tiers['departmentVendor']!; largeFloor = tiers['largeCatalogueThreshold']!;
  mover = tiers['mover']!; moverHeavy = tiers['moverHeavy']!;
});

async function purgeBlock() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const subs = await app.prisma.subscription.findMany({
    where: { OR: [{ rider: { userId: { in: ids } } }, { vendor: { owner: { userId: { in: ids } } } }] }, select: { id: true },
  });
  const sids = subs.map((s) => s.id);
  await app.prisma.platformConfig.deleteMany({ where: { OR: sids.map((id) => ({ key: { endsWith: id } })) } });
  await cleanupBillingClocks(app.prisma, sids);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: sids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...sids, ...ids] } }, { userId: { in: ids } }] }, 'test-cleanup:weekly-retier-notice');
  await app.prisma.subscription.deleteMany({ where: { id: { in: sids } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
}

afterAll(async () => {
  await purgeBlock();
  await app.close();
}, 120_000);

describe('[RETIER PR-B] the switch', () => {
  it('stays OFF: the scheduled pass moves nobody; the code path below runs only when switched on', async () => {
    expect(WEEKLY_RETIER_ON).toBe(false);
    const s = await makeStore({ weeklyRate: small, due: new Date(Date.now() + 3 * DAY), items: largeFloor });
    expect(await billing.runWeeklyRetier()).toEqual({ on: false, vendorsChanged: 0, moversChanged: 0 });
    expect(await heldOf(s.subId)).toBeNull();
  });
});

describe('[RETIER PR-B] a store that grew: one notice 14 days ahead, the new fee from the first weekly fee after it', () => {
  it('held with WHY; told once (items, step, new fee, date, how to come down, how to say no); nothing moves before; re-runs change nothing; moves in at the told fee', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const s = await makeStore({ weeklyRate: small, due, items: largeFloor });

    const ran = await billing.runWeeklyRetier(true);
    expect(ran.on).toBe(true);
    expect(ran.vendorsChanged).toBeGreaterThanOrEqual(1);
    expect(await heldOf(s.subId)).toMatchObject({
      from: small, to: large, source: 'WEEKLY_RETIER', noticeAt: null,
      basis: { kind: 'CATALOGUE', items: largeFloor, tier: 'large', stepFrom: largeFloor },
    });
    expect((await audits(s.subId, 'BILLING_FEE_RISE_HELD')).map((a) => a.changes)).toEqual([
      expect.objectContaining({ from: small, to: large, source: 'WEEKLY_RETIER', noticeDays: FEE_RISE_NOTICE_DAYS, basis: expect.objectContaining({ items: largeFloor }) }),
    ]);
    expect(await rate(s.subId)).toBe(small);

    await billing.sweepFeeRises(t, scope());
    const firstNewFee = new Date(due.getTime() + 2 * WEEK);
    const [notice, ...more] = await notices(s.userId);
    expect(more).toHaveLength(0);
    expect(notice!.type).toBe('SYSTEM_ANNOUNCEMENT');
    // [REVIEW-G #2259 S4-2] The notice names the store (an owner may have several) and opens THAT store's fee screen.
    expect(notice!.title).toBe(`${s.name}: your weekly fee is changing`);
    // [REVIEW-F/M #2259 S3-1 · COORD 03:50Z] How to come down is the rule the code runs: the rise moves in no sooner
    // than the day its new fee is due, counting items taken off sale, changed or removed in the 7 days before, so the
    // day to act by is the end of the day 8 days before the new fee's day.
    const lastCutDay = new Date(firstNewFee.getTime() - 8 * DAY);
    expect(notice!.body).toBe(
      `${s.name} now has ${largeFloor.toLocaleString('en-US')} items for sale, which is the large catalogue rate. `
      + `From its weekly fee due ${guyanaDay(firstNewFee)}, its Swift weekly fee will be ${money(large)} (it is ${money(small)} now). `
      + 'Until then nothing changes, and any week already paid keeps the price paid. '
      + `Swift counts the items in ${s.name} every week: items for sale, and items taken off sale, changed or removed in the last 7 days. `
      + `To stop this change, have fewer than ${largeFloor.toLocaleString('en-US')} items for sale by the end of ${guyanaDay(lastCutDay)}, and from then on add no items and leave the ones you took off sale or removed as they are: `
      + 'this change will then not happen, and we will tell you. '
      + `If you do not want the new fee for ${s.name}, tap Stop weekly billing on ${s.name}'s weekly-fee screen in Swift before then and you will not pay it.`,
    );
    // One phrase for the count everywhere (partner/store-fee.ts prices a new store on the same rule).
    expect(notice!.body).toContain(`items ${CATALOGUE_COUNT_WORDS}.`);
    expect(notice!.data).toMatchObject({
      kind: 'billing_rate_change', change: 'RISE', subscriptionId: s.subId, weeklyFee: large, previousWeeklyFee: small, appliesFrom: firstNewFee.toISOString(),
      reason: { kind: 'CATALOGUE', items: largeFloor, tier: 'large', stepFrom: largeFloor }, audience: 'business', vendorId: s.vendorId,
    });
    const held = (await heldOf(s.subId))!;
    expect(new Date(held.appliesFrom!).getTime() - new Date(held.noticeAt!).getTime()).toBeGreaterThanOrEqual(FEE_RISE_NOTICE_DAYS * DAY);

    // Re-runs (a crashed job retried, the next hour, the next week): one rise, one notice, no move.
    await billing.runWeeklyRetier(true);
    await billing.sweepFeeRises(new Date(t.getTime() + DAY), scope());
    expect(await notices(s.userId)).toHaveLength(1);
    expect((await heldOf(s.subId))?.heldAt).toBe(held.heldAt);
    expect(await audits(s.subId, 'BILLING_FEE_RISE_HELD')).toHaveLength(1);
    expect(await rate(s.subId)).toBe(small);
    expect(await tierChanges(s.subId)).toHaveLength(0);

    // The weeks before the told date are billed: the next fee is the told one. Until the day the new fee is due the
    // new fee does not move in (the store is counted then, on the last 7 days) ...
    await reachToldFee(s.subId);
    const movesIn = retierMovesInFrom(firstNewFee);
    expect(movesIn.getTime()).toBeLessThanOrEqual(firstNewFee.getTime());
    expect(movesIn.getTime()).toBeGreaterThan(firstNewFee.getTime() - DAY);
    expect(guyanaDay(movesIn)).toBe(guyanaDay(firstNewFee));
    // ... and the told day to act by ends exactly 7 days before that moment.
    expect(retierCutBy(firstNewFee).getTime()).toBe(movesIn.getTime() - WEEK - 1);
    expect(guyanaDay(retierCutBy(firstNewFee))).toBe(guyanaDay(lastCutDay));
    await billing.sweepFeeRises(new Date(t.getTime() + 2 * DAY), scope());
    await billing.sweepFeeRises(new Date(movesIn.getTime() - 1), scope());
    expect(await rate(s.subId)).toBe(small);
    expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large });
    // ... then it moves in, once.
    await billing.sweepFeeRises(movesIn, scope());
    await billing.sweepFeeRises(new Date(movesIn.getTime() + 60_000), scope());
    expect(await rate(s.subId)).toBe(large);
    expect(await heldOf(s.subId)).toBeNull();
    expect((await tierChanges(s.subId)).map((e) => Number(e.amount))).toEqual([large]);
    expect((await audits(s.subId, 'BILLING_FEE_RISE_APPLIED')).map((a) => a.changes)).toEqual([
      expect.objectContaining({ from: small, to: large, firstFeeAtNewRate: firstNewFee.toISOString() }),
    ]);
    expect(await notices(s.userId)).toHaveLength(1);
  });

  it('PAUSED and SUSPENDED stores are told and moved like any other (OWNER-DECISIONS line 9)', async () => {
    const due = new Date(Date.now() + 3 * DAY);
    const paused = await makeStore({ weeklyRate: small, due, items: largeFloor, status: 'PAUSED' });
    const suspended = await makeStore({ weeklyRate: small, due, items: largeFloor, status: 'SUSPENDED' });
    await billing.recalculateVendorTiers(new Date(), scope());
    await billing.sweepFeeRises(new Date(), scope());
    for (const s of [paused, suspended]) {
      expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large, source: 'WEEKLY_RETIER' });
      expect((await notices(s.userId)).map((n) => n.title)).toEqual([`${s.name}: your weekly fee is changing`]);
      expect(await rate(s.subId)).toBe(small);
    }
  });

  it('an agreed chain deal never rises: nothing is held, nothing told, the deal and the rate stay', async () => {
    const s = await makeStore({ weeklyRate: small, due: new Date(Date.now() + 3 * DAY), items: largeFloor, deal: small - 2000 });
    await billing.recalculateVendorTiers(new Date(), scope());
    await billing.sweepFeeRises(new Date(), scope());
    expect(await heldOf(s.subId)).toBeNull();
    expect(await notices(s.userId)).toHaveLength(0);
    const after = await sub(s.subId);
    expect([Number(after.weeklyRate), Number(after.customRate)]).toEqual([small, small - 2000]);
  });
});

describe('[RETIER PR-B] back under the step before the new fee starts: the change is cancelled, and the store told', () => {
  it('on the next weekly count: a store under the step for a whole week is never moved; the rise is dropped and the store told', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    expect(await notices(s.userId)).toHaveLength(1);

    await hide(s.vendorId, 10, 8 * DAY);
    await billing.recalculateVendorTiers(new Date(t.getTime() + 60_000), scope());
    expect(await heldOf(s.subId)).toBeNull();
    expect((await audits(s.subId, 'BILLING_FEE_RISE_DROPPED')).map((a) => a.changes)).toEqual([expect.objectContaining({ from: small, to: large, told: true, why: 'BELOW_AGAIN' })]);
    const said = await notices(s.userId);
    expect(said.map((n) => n.title)).toEqual(toldThenCancelled(s.name));
    const toldFor = new Date((said[0]!.data as { appliesFrom: string }).appliesFrom);
    expect(said[1]!.body).toBe(`${s.name}: the change to ${money(large)} we told you about for its weekly fee due ${guyanaDay(toldFor)} will not happen: its Swift weekly fee stays ${money(small)}.`);
    expect(said[1]!.data).toMatchObject({ kind: 'billing_rate_change', change: 'CANCELLED', subscriptionId: s.subId, weeklyFee: small, vendorId: s.vendorId });
    expect(await rate(s.subId)).toBe(small);
    expect(await tierChanges(s.subId)).toHaveLength(0);
    // Counted again: nothing more to tell.
    await billing.recalculateVendorTiers(new Date(t.getTime() + 120_000), scope());
    expect(await notices(s.userId)).toHaveLength(2);
  });

  it('hiding listings just before the count does not cancel it: a listing hidden in the last 7 days still counts', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    await hide(s.vendorId, 10, DAY);
    await billing.recalculateVendorTiers(new Date(t.getTime() + 60_000), scope());
    expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large });
    expect(await notices(s.userId)).toHaveLength(1);
  });

  it('at the moment the new fee would move in: a store back under the step by the told last day is not moved; the hourly pass drops it and tells', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    const movesIn = retierMovesInFrom(await reachToldFee(s.subId));
    await hideAt(s.vendorId, 10, new Date(movesIn.getTime() - 8 * DAY));
    await billing.sweepFeeRises(movesIn, scope());
    expect(await rate(s.subId)).toBe(small);
    expect(await heldOf(s.subId)).toBeNull();
    expect((await audits(s.subId, 'BILLING_FEE_RISE_DROPPED')).map((a) => a.changes)).toEqual([expect.objectContaining({ told: true, why: 'BELOW_AGAIN' })]);
    expect((await notices(s.userId)).map((n) => n.title)).toEqual(toldThenCancelled(s.name));
  });

  it('(COORD 03:50Z) one rule: a store under the step for sale by the end of the told day is NOT charged the new fee; one that cuts a moment later IS', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const onTime = await makeStore({ weeklyRate: small, due, items: largeFloor, prepaid: 0 });
    const late = await makeStore({ weeklyRate: small, due, items: largeFloor, prepaid: 0 });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    for (const s of [onTime, late]) {
      const firstNewFee = await reachToldFee(s.subId);
      const told = (await notices(s.userId))[0]!;
      const cutBy = retierCutBy(firstNewFee);
      expect(told.body).toContain(`have fewer than ${largeFloor.toLocaleString('en-US')} items for sale by the end of ${guyanaDay(cutBy)},`);
      // On time: the 10 items come off sale in the last moment of the told day. Late: one millisecond after it.
      await hideAt(s.vendorId, 10, s === onTime ? cutBy : new Date(cutBy.getTime() + 1));
      // The billing run on the day the new fee is due: it applies held rises, then charges that week (paid from the
      // credit topped up after the move-in: credit held before it would keep the old price for a week, by design).
      await billing.sweepFeeRises(retierMovesInFrom(firstNewFee), scope());
      await app.prisma.prepaidBalance.update({ where: { subscriptionId: s.subId }, data: { balance: large } });
      expect(await bill(s.subId, new Date(firstNewFee.getTime() + 60_000))).toBe('succeeded');
      const charged = await app.prisma.subscriptionPayment.findFirst({ where: { subscriptionId: s.subId, periodStart: firstNewFee, status: 'CAPTURED' } });
      expect(Number(charged!.amount)).toBe(s === onTime ? small : large);
      expect(await rate(s.subId)).toBe(s === onTime ? small : large);
    }
    expect((await notices(onTime.userId)).map((n) => n.title)).toEqual(toldThenCancelled(onTime.name));
    expect((await notices(late.userId)).map((n) => n.title)).toEqual([`${late.name}: your weekly fee is changing`]);
  });

  it('(COORD 03:50Z) the told day to act by is always after the notice: a 14-day notice leaves at least 6 days, and it ends at least 7 days before the new fee is due', () => {
    const base = Date.UTC(2026, 10, 2, 0, 0, 0);
    for (let noticeH = 0; noticeH < 7 * 24; noticeH += 1) {
      const noticeAt = new Date(base + noticeH * 3_600_000 + 17 * 60_000);
      for (let nextH = -24; nextH < 21 * 24; nextH += 5) {
        const appliesFrom = riseAppliesFrom(new Date(base + nextH * 3_600_000), noticeAt);
        const cutBy = retierCutBy(appliesFrom).getTime();
        expect(cutBy - noticeAt.getTime()).toBeGreaterThanOrEqual(6 * DAY);
        expect(appliesFrom.getTime() - cutBy).toBeGreaterThanOrEqual(WEEK);
        expect(retierMovesInFrom(appliesFrom).getTime()).toBeLessThanOrEqual(appliesFrom.getTime());
      }
    }
  });

  it('(REVIEW-M #2259 S3-1 · REVIEW-G S4-1 G3) cut in the last 7 days before the new fee moves in: the cut still counts, the new fee moves in', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    const movesIn = retierMovesInFrom(await reachToldFee(s.subId));
    // Hidden 3 days before the move-in (after the told last day to cut minus 7): counted, so the store still reaches the step.
    await hideAt(s.vendorId, 10, new Date(movesIn.getTime() - 3 * DAY));
    await billing.sweepFeeRises(movesIn, scope());
    expect(await rate(s.subId)).toBe(large);
    expect(await heldOf(s.subId)).toBeNull();
    expect(await audits(s.subId, 'BILLING_FEE_RISE_DROPPED')).toHaveLength(0);
    expect((await notices(s.userId)).map((n) => n.title)).toEqual([`${s.name}: your weekly fee is changing`]);
  });

  it('(REVIEW-G #2259 S4-1 G7) the last week at the old fee paid while the store is under the step: the new fee never moves in with it; the hourly pass drops it and tells', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const s = await makeStore({ weeklyRate: small, due, items: largeFloor, prepaid: 0 });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    const firstNewFee = new Date((await heldOf(s.subId))!.appliesFrom!);
    const lastOld = new Date(firstNewFee.getTime() - WEEK);
    // The weeks before the last old one are billed; the last one is paid a day late, after the told last day to cut.
    await app.prisma.subscription.update({ where: { id: s.subId }, data: { nextBillingDate: lastOld, currentPeriodStart: new Date(lastOld.getTime() - WEEK), currentPeriodEnd: lastOld } });
    const paidAt = new Date(retierMovesInFrom(firstNewFee).getTime() + 60_000);
    await hideAt(s.vendorId, 10, new Date(paidAt.getTime() - 8 * DAY));
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: s.subId }, data: { balance: small } });
    expect(await bill(s.subId, paidAt)).toBe('succeeded');
    expect((await sub(s.subId)).nextBillingDate.getTime()).toBe(firstNewFee.getTime());
    expect(await rate(s.subId)).toBe(small);
    expect(await tierChanges(s.subId)).toHaveLength(0);
    await billing.sweepFeeRises(new Date(paidAt.getTime() + 60_000), scope());
    expect(await rate(s.subId)).toBe(small);
    expect(await heldOf(s.subId)).toBeNull();
    expect((await audits(s.subId, 'BILLING_FEE_RISE_DROPPED')).map((a) => a.changes)).toEqual([expect.objectContaining({ told: true, why: 'BELOW_AGAIN' })]);
    expect((await notices(s.userId)).map((n) => n.title)).toEqual(toldThenCancelled(s.name));
  });

  it('a market whose weekly-fee card cannot price the store when the new fee would move in: the rise waits (never moved in on a count nobody could make)', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    const movesIn = retierMovesInFrom(await reachToldFee(s.subId));
    const broken = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
    const countryConfig = (broken as unknown as { countryConfig: { getSubscriptionTiers: (...a: unknown[]) => Promise<unknown> } }).countryConfig;
    countryConfig.getSubscriptionTiers = async () => ({});
    await broken.sweepFeeRises(movesIn, scope());
    expect(await rate(s.subId)).toBe(small);
    expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large });
    expect(await tierChanges(s.subId)).toHaveLength(0);
  });

  it('a store that grew further during the notice is told the higher fee afresh, its 14 days counted again', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    const first = (await heldOf(s.subId))!;
    const deptFloor = (await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } })).subscriptionTiers as Record<string, number>;
    await addItems(s.vendorId, deptFloor['departmentCatalogueThreshold']! - largeFloor);
    await billing.recalculateVendorTiers(new Date(t.getTime() + 60_000), scope());
    await billing.sweepFeeRises(new Date(t.getTime() + 120_000), scope());
    const second = (await heldOf(s.subId))!;
    expect(second).toMatchObject({ from: small, to: dept, basis: { tier: 'department' } });
    expect(new Date(second.appliesFrom!).getTime() - new Date(second.noticeAt!).getTime()).toBeGreaterThanOrEqual(FEE_RISE_NOTICE_DAYS * DAY);
    expect(second.heldAt).not.toBe(first.heldAt);
    expect((await notices(s.userId)).map((n) => (n.data as { weeklyFee?: number }).weeklyFee)).toEqual([large, dept]);
    expect(await rate(s.subId)).toBe(small);
  });
});

describe('[RETIER PR-B] an owner\'s chain-deal change is the owner\'s, never the catalogue\'s', () => {
  it('a branch whose catalogue shrank keeps its owner\'s told deal change on that count (only a confirmed lower tier moves it)', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: large, due: new Date(t.getTime() + 3 * DAY), items: 10, deal: small - 3000 });
    expect(await app.prisma.$transaction((tx) => holdChainDealRiseInTx(tx, {
      subscriptionId: s.subId, from: small - 3000, to: large - 1000, customFrom: small - 3000, customTo: large - 1000, notBefore: t, currencyCode: 'GYD', now: t,
    }))).toBe('held');
    await billing.recalculateVendorTiers(t, scope());
    expect(await heldOf(s.subId)).toMatchObject({ source: 'CHAIN_DEAL', from: small - 3000, to: large - 1000 });
    expect(await audits(s.subId, 'BILLING_FEE_RISE_DROPPED')).toHaveLength(0);
  });
});

describe('[RETIER PR-B · REVIEW-M #2245 S3-1 · COORD ruling] removed listings: 7 days, then never', () => {
  const remove = (vendorId: string, n: number, daysAgo: number) => app.prisma.$executeRaw`
    UPDATE "items" SET "archivedAt" = now() - make_interval(days => ${daysAgo}::int), "isAvailable" = false, "updatedAt" = now() - make_interval(days => ${daysAgo}::int)
    WHERE "id" IN (SELECT "id" FROM "items" WHERE "vendorId" = ${vendorId} AND "archivedAt" IS NULL ORDER BY "id" LIMIT ${n})`;

  it('listings removed long ago are not the catalogue: a store that reaches the step only with them is never told a rise', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await remove(s.vendorId, 10, 8);
    await billing.recalculateVendorTiers(t, scope());
    expect(await heldOf(s.subId)).toBeNull();
  });

  it('during the notice: removing listings today does not cancel the rise (the 7-day window); removed for a whole week, the next count cancels it', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large });
    await remove(s.vendorId, 10, 0);
    await billing.recalculateVendorTiers(new Date(t.getTime() + 60_000), scope());
    expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large });
    await app.prisma.$executeRaw`UPDATE "items" SET "archivedAt" = now() - interval '8 days', "updatedAt" = now() - interval '8 days' WHERE "vendorId" = ${s.vendorId} AND "archivedAt" IS NOT NULL`;
    await billing.recalculateVendorTiers(new Date(t.getTime() + 120_000), scope());
    expect(await heldOf(s.subId)).toBeNull();
    expect((await notices(s.userId)).map((n) => n.title)).toEqual(toldThenCancelled(s.name));
  });

  it('(REVIEW-M pair S4-1) listings removed more than 7 days ago stay out even when a later write touched them (the photo clean-up updates removed rows): the next count still cancels the rise', async () => {
    const t = new Date();
    const s = await makeStore({ weeklyRate: small, due: new Date(t.getTime() + 3 * DAY), items: largeFloor });
    await billing.recalculateVendorTiers(t, scope());
    await billing.sweepFeeRises(t, scope());
    expect(await heldOf(s.subId)).toMatchObject({ from: small, to: large });
    await remove(s.vendorId, 10, 8);
    await app.prisma.$executeRaw`UPDATE "items" SET "updatedAt" = now() WHERE "vendorId" = ${s.vendorId} AND "archivedAt" IS NOT NULL`;
    await billing.recalculateVendorTiers(new Date(t.getTime() + 60_000), scope());
    expect(await heldOf(s.subId)).toBeNull();
  });
});

describe('[RETIER PR-B] the fee coming down applies from the next weekly fee, with a notice', () => {
  it('a store whose catalogue shrank for good: seen on one weekly count, confirmed on the next, the lower fee from the next weekly fee', async () => {
    const t = Date.now();
    const s = await makeStore({ weeklyRate: large, due: new Date(t + 3 * DAY), items: 10 });
    await billing.recalculateVendorTiers(new Date(t), scope());
    expect(await rate(s.subId)).toBe(large);
    await billing.recalculateVendorTiers(new Date(t + WEEK), scope());
    expect(await rate(s.subId)).toBe(small);
    expect((await sub(s.subId)).nextBillingDate.getTime()).toBe(t + 3 * DAY);
    expect((await notices(s.userId)).map((n) => n.title)).toEqual(['Your weekly fee is going down']);
    expect((await tierChanges(s.subId)).map((e) => Number(e.amount))).toEqual([small]);
  });
});

describe('[RETIER PR-B] a mover: told why (the vehicle)', () => {
  it('a delivery rider now on a canter: held with the vehicle, told the heavy-delivery fee and how it comes back down', async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 3 * DAY);
    const r = await makeRider({ weeklyRate: mover, due, vehicleType: 'CANTER_SHORT' });
    await billing.recalculateMoverTiers(t, scope());
    expect(await heldOf(r.subId)).toMatchObject({ from: mover, to: moverHeavy, basis: { kind: 'VEHICLE', vehicleType: 'CANTER_SHORT', tier: 'courierHeavy' } });
    await billing.sweepFeeRises(t, scope());
    const [notice] = await notices(r.userId);
    expect(notice!.body).toContain('Your vehicle on Swift is now a Short-Base Canter (Open Back), which is the heavy delivery rate.');
    expect(notice!.body).toContain(`your Swift weekly fee will be ${money(moverHeavy)} (it is ${money(mover)} now)`);
    // [REVIEW-M #2259 S4-1 · REVIEW-F N1] When it comes down: only once the smaller vehicle holds on two weekly counts.
    expect(notice!.body).toContain('Your fee follows the vehicle you drive on Swift: if you change back to a smaller vehicle, your fee goes back down after Swift has seen the smaller vehicle on two weekly counts, a week apart, and we will tell you.');
    expect(notice!.title).toBe('Your weekly fee is changing');
    expect(notice!.data).not.toHaveProperty('vendorId');
    expect(await rate(r.subId)).toBe(mover);
  });
});
