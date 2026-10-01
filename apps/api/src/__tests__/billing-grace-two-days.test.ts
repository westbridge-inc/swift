import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Subscription, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider, type PaymentProvider } from '../providers/payment/payment-provider';
import { sandboxSetTxStatus } from '../providers/mmg/mmg-provider';
import { inoperableSubscriptionWhere, subscriptionOperability } from '../modules/subscription/operate-gate';
import { moverFeeOperability } from '../modules/subscription/mover-fee-authority';
import { syntheticLocationOwner } from './helpers/online-mover';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [#1393 · coordinator item 10] The owner's grace is two full days of active
// overdue time, shared by every gate that reads a lapsed state, never the 24 h
// retry interval (the 26 Sep audit / COL-1 finding: a store was blocked about
// a day after its first failure until the next hourly run re-evaluated it).
// Time spent while a payment is being confirmed does not count.
//
// Every gate reads the same projection: the store gates (accept, toggle,
// checkout, catalogue and search visibility) through subscriptionOperability
// and its SQL form inoperableSubscriptionWhere; the mover gates (go online)
// through moverFeeOperability; the operate-gate CI census
// (operate-gate-unification.test.ts) fails the build if a gate forks the rule.
// These cases drive the real billing service at chosen instants and evaluate
// exactly those predicates at the boundaries.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// [SAFE-B · retained history] Choosing the MMG rail records an advisory payer
// declaration: immutable evidence naming its subscription and account, kept
// after the suite. The fixtures therefore live in a phone namespace no other
// suite uses or purges, unique to the run.
const PHONE_PREFIX = retainedPhonePrefix('19');

let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Grace', lastName: `Two${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  return user;
}

/** A store with an empty wallet (every charge from it fails), or paying by card. */
async function makeStore(due: Date, rail: 'CASH' | 'CARD' = 'CASH') {
  const user = await makeUser(['VENDOR_OWNER'] as UserRole[], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Grace Store ${seq}`, slug: `grace-store-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}${String(500 + seq).padStart(3, '0')}`, addressLine1: '2 Grace Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 15000, billingMethod: rail,
      ...(rail === 'CARD' ? { paymentToken: 'tok_grace' } : {}),
      currentPeriodStart: new Date(due.getTime() - WEEK), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 0, currencyCode: 'GYD' } },
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, vendorId: vendor.id, subId: sub.id };
}

/** A delivery rider with an empty wallet. */
async function makeRider(due: Date) {
  const user = await makeUser(['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER');
  await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('grace-two-days') },
  });
  const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: user.id } });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 6000, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - WEEK), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 0, currencyCode: 'GYD' } },
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, subId: sub.id };
}

const row = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const withRelations = (id: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});

/** The store gates at one instant: the in-memory rule and its SQL form agree. */
async function storeGate(subId: string, at: Date) {
  const sub: Subscription = await row(subId);
  const verdict = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' }, at);
  const blockedInSql = await app.prisma.subscription.count({ where: { id: subId, ...inoperableSubscriptionWhere(at) } });
  expect(blockedInSql, `SQL gate at ${at.toISOString()}`).toBe(verdict.operable ? 0 : 1);
  return verdict;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  delete process.env['MMG_DRIVER']; // sandbox
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  // [SAFE-B · retained history] A subscription an MMG payer declaration names is
  // kept with its money records, store and owner; the rest goes as before, in
  // one transaction. What stays is cancelled without renewal and its store
  // closed, so no later billing cycle reaches it.
  try {
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      const goneVendors = without(vendorIds, kept.vendorIds);
      await cleanupBillingClocks(tx, subIds);
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      // A mover payer's fee authority and sources survive while the payer does: remove the payer first.
      await tx.user.deleteMany({ where: { id: { in: without(userIds, kept.userIds) } } });
      await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.item.deleteMany({ where: { vendorId: { in: goneVendors } } });
      await tx.vendor.deleteMany({ where: { id: { in: goneVendors } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});


describe('[#1393 · item 10] two full days of grace on every gate, paused while a payment is confirmed', () => {
  it('a store is never blocked before 48 hours of active overdue time; a confirmation pause does not count; it is blocked at exactly 48 hours, with no billing run in between', async () => {
    const t0 = new Date(Date.now() - 30 * DAY);
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const s = await makeStore(t0);

    // The week falls due and the first charge fails at once (empty wallet).
    expect(await billing.billSubscription(await withRelations(s.subId) as never, t0)).toBe('failed');
    expect(await row(s.subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
    expect((await row(s.subId)).billingEnforcementDueAt!.getTime()).toBe(at(48 * HOUR).getTime());

    // The audit finding: a day after the first failure (the old 24 h retry
    // instant) and a minute before two days, the store still works.
    expect(await storeGate(s.subId, at(24 * HOUR + MIN))).toEqual({ operable: true });
    expect(await storeGate(s.subId, at(48 * HOUR - MIN))).toEqual({ operable: true });

    // 40 hours in, the owner switches the rail to MMG and the retry sends a
    // request: while MMG confirms it, the grace clock stands still.
    await billing.setBillingRail(s.subId, 'MOBILE_MONEY', '6094101');
    expect(await billing.billSubscription(await withRelations(s.subId) as never, at(40 * HOUR))).toBe('pending');
    const request = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: s.subId, paymentMethod: 'MOBILE_MONEY' } });
    sandboxSetTxStatus(request.externalRef!, 'pending');
    expect((await row(s.subId)).billingConfirmationPausedAt).not.toBeNull();
    // Past the nominal two days while the payment is being confirmed: never blocked.
    for (const hours of [48, 50, 59]) expect(await storeGate(s.subId, at(hours * HOUR))).toEqual({ operable: true });

    // 60 hours in, MMG declines the request (its answer bound to the request):
    // the remaining 8 hours of grace resume, never a fresh two days, never zero.
    sandboxSetTxStatus(request.externalRef!, 'declined');
    await billing.pollPendingMmgCharges(at(60 * HOUR));
    const resumed = await row(s.subId);
    expect(resumed).toMatchObject({ status: 'PAST_DUE', failedAttempts: 2, billingConfirmationPausedAt: null });
    expect(resumed.billingEnforcementDueAt!.getTime()).toBe(at(68 * HOUR).getTime());
    expect(await storeGate(s.subId, at(68 * HOUR - MIN))).toEqual({ operable: true });
    // Exactly at 48 hours of active time the gate refuses, by itself: no
    // billing run has re-evaluated the row (still PAST_DUE, not SUSPENDED).
    expect(await storeGate(s.subId, at(68 * HOUR))).toEqual({ operable: false, why: 'GRACE_LAPSED', status: 'PAST_DUE' });
    expect((await row(s.subId)).status).toBe('PAST_DUE');
  });

  it('a third failure before two days never suspends; the next run after the 48th hour does, and the gate already refused at the boundary', async () => {
    const t0 = new Date(Date.now() - 20 * DAY);
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const s = await makeStore(t0);

    expect(await billing.billSubscription(await withRelations(s.subId) as never, t0)).toBe('failed');
    expect(await billing.billSubscription(await withRelations(s.subId) as never, at(24 * HOUR))).toBe('failed');
    // A third attempt forced early (a top-up or a rail change can re-bill at once).
    expect(await billing.billSubscription(await withRelations(s.subId) as never, at(30 * HOUR))).toBe('failed');
    expect(await row(s.subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 3, suspendedAt: null });
    expect(await storeGate(s.subId, at(48 * HOUR - MIN))).toEqual({ operable: true });
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })).status).toBe('ACTIVE');

    expect(await storeGate(s.subId, at(48 * HOUR))).toEqual({ operable: false, why: 'GRACE_LAPSED', status: 'PAST_DUE' });
    // The next run for this subscription (the hourly cycle's per-row step).
    expect(await billing.billSubscription(await withRelations(s.subId) as never, at(48 * HOUR + MIN))).toBe('suspended');
    const suspended = await row(s.subId);
    expect(suspended.status).toBe('SUSPENDED');
    expect(suspended.suspendedAt!.getTime()).toBe(at(48 * HOUR + MIN).getTime());
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })).status).toBe('SUSPENDED');
  });

  it('a store paying by card: declines inside two days never suspend; the gate refuses at exactly 48 hours, and the next run suspends', async () => {
    // Owner decision 4: the two days of grace hold on cards too, through the
    // same shared dunning clock (each attempt is a processor-proven decline).
    const t0 = new Date(Date.now() - 50 * DAY);
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const s = await makeStore(t0, 'CARD');
    const declines: string[] = [];
    const decliningCard: PaymentProvider = {
      tokenizeCard: async () => ({ token: 'tok_grace' }),
      chargeToken: async (input) => { declines.push(input.idempotencyKey); return { status: 'failed', providerRef: `ch_${nanoid(6)}`, reason: 'Card declined' }; },
      refund: async () => ({ status: 'succeeded', providerRef: `re_${nanoid(6)}` }),
      lookupCharge: async () => ({ status: 'failed', reason: 'Card declined' }),
    };
    const card = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), decliningCard);

    expect(await card.billSubscription(await withRelations(s.subId) as never, t0)).toBe('failed');
    expect(await card.billSubscription(await withRelations(s.subId) as never, at(24 * HOUR))).toBe('failed');
    // A third decline forced early (a rail change or a top-up can re-bill at once).
    expect(await card.billSubscription(await withRelations(s.subId) as never, at(30 * HOUR))).toBe('failed');
    expect(declines).toHaveLength(3);
    expect(await row(s.subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 3, suspendedAt: null });
    expect((await row(s.subId)).billingEnforcementDueAt!.getTime()).toBe(at(48 * HOUR).getTime());
    expect(await storeGate(s.subId, at(24 * HOUR + MIN))).toEqual({ operable: true });
    expect(await storeGate(s.subId, at(48 * HOUR - MIN))).toEqual({ operable: true });
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })).status).toBe('ACTIVE');

    expect(await storeGate(s.subId, at(48 * HOUR))).toEqual({ operable: false, why: 'GRACE_LAPSED', status: 'PAST_DUE' });
    expect(await card.billSubscription(await withRelations(s.subId) as never, at(48 * HOUR + MIN))).toBe('suspended');
    expect((await row(s.subId)).status).toBe('SUSPENDED');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })).status).toBe('SUSPENDED');
  });

  it('a mover goes online for two full days of active overdue time and is refused at exactly 48 hours', async () => {
    const t0 = new Date(Date.now() - 10 * DAY);
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const r = await makeRider(t0);
    const payer = { userId: r.userId, tenantId: 'swift-default' };

    expect(await billing.billSubscription(await withRelations(r.subId) as never, t0)).toBe('failed');
    for (const ms of [24 * HOUR + MIN, 48 * HOUR - MIN]) {
      expect(await moverFeeOperability(app.prisma, payer, { missingRow: 'GRANDFATHER' }, at(ms))).toEqual({ operable: true });
    }
    expect(await moverFeeOperability(app.prisma, payer, { missingRow: 'GRANDFATHER' }, at(48 * HOUR)))
      .toEqual({ operable: false, why: 'GRACE_LAPSED', status: 'PAST_DUE' });
  });
});
