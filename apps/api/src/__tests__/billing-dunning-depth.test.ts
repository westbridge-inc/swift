import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// Lifecycle/billing spec §11 — dunning DEPTH (G-BILL-02). The retry engine and
// auto-suspend already exist and are tested in billing.test.ts; this suite
// covers the attention-ladder additions: the final warning that NAMES the
// suspension moment (push + SMS + ops task), the suspension SMS, the daily
// reinstatement nudge while suspended (idempotent per day), the CHURNED
// terminal at SUSPENSION_MAX_DAYS — and that churn is terminal for dunning
// but never for the door back in.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let app: FastifyInstance;
let billing: BillingService;

const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_740_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Dun', lastName: `U${seq}`,
      roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(activeRole === 'ADMIN' && { admin: { create: { permissions: ['*'] } } }),
    },
  });
  userIds.push(user.id);
  return user;
}

/** CASH vendor with an empty prepaid balance — every cycle tick fails. */
async function makeBrokeVendorSub(due: Date) {
  const user = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Dunning Vendor ${seq}`, slug: `dunning-vendor-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
      addressLine1: '1 Dunning Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE',
      weeklyRate: 20000, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 0 } },
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, vendorId: vendor.id, subId: sub.id, phone: `+${phoneBase + seq}` };
}

const sub = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

beforeEach(() => resetDevChannelLog());

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§11 final warning — the last rung before suspension', () => {
  it('attempt 2 of 3 names the suspension moment on push AND SMS, and files an ops task', async () => {
    const admin = await makeUser(['ADMIN'], 'ADMIN');
    const t0 = new Date('2026-07-01T12:00:00Z');
    const v = await makeBrokeVendorSub(t0);

    await billing.runBillingCycle(t0); // attempt 1 — generic retry notice
    expect((await sub(v.subId)).status).toBe('PAST_DUE');
    expect(devChannelLog.filter((e) => e.channel === 'sms')).toHaveLength(0); // no SMS yet

    await billing.runBillingCycle(new Date(t0.getTime() + 25 * HOUR)); // attempt 2 — FINAL WARNING
    const s = await sub(v.subId);
    expect(s.status).toBe('PAST_DUE');
    expect(s.failedAttempts).toBe(2);

    const finalPush = await app.prisma.notification.findFirst({
      where: { userId: v.userId, title: 'Final warning — payment needed' },
    });
    expect(finalPush).not.toBeNull();
    expect((finalPush!.data as Record<string, unknown>)['suspendsAt']).toBeTruthy();

    const smsToPayer = devChannelLog.find((e) => e.channel === 'sms' && e.to === v.phone);
    expect(smsToPayer).toBeTruthy();
    expect(smsToPayer!.body).toContain('suspended at'); // names the moment

    const opsTask = await app.prisma.notification.findFirst({
      where: { userId: admin.id, title: 'Dunning — final warning issued' },
    });
    expect(opsTask).not.toBeNull();
  });

  it('the suspension itself lands as SMS too, and stamps suspendedAt', async () => {
    const t0 = new Date('2026-07-01T12:00:00Z');
    const v = await makeBrokeVendorSub(t0);
    await billing.runBillingCycle(t0);
    await billing.runBillingCycle(new Date(t0.getTime() + 25 * HOUR));
    resetDevChannelLog();
    await billing.runBillingCycle(new Date(t0.getTime() + 50 * HOUR)); // attempt 3 — suspend

    const s = await sub(v.subId);
    expect(s.status).toBe('SUSPENDED');
    expect(s.suspendedAt).not.toBeNull();
    const sms = devChannelLog.find((e) => e.channel === 'sms' && e.to === v.phone);
    expect(sms?.body).toContain('suspended');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: v.vendorId } })).status).toBe('SUSPENDED');
  });
});

describe('§11 stages 6..N — suspended nudges and the CHURNED terminal', () => {
  it('one reinstatement nudge per day (idempotent), then CHURNED at 30 days — and dunning STOPS', async () => {
    const t0 = new Date('2026-07-01T12:00:00Z');
    const v = await makeBrokeVendorSub(t0);
    await billing.runBillingCycle(t0);
    await billing.runBillingCycle(new Date(t0.getTime() + 25 * HOUR));
    await billing.runBillingCycle(new Date(t0.getTime() + 50 * HOUR)); // suspended
    const suspendedAt = (await sub(v.subId)).suspendedAt!;

    // (The sweep is global — other suites' suspended fixtures may ride along.
    // Every assertion here is scoped to THIS subscription.)
    const nudges = () => app.prisma.billingEvent.count({ where: { subscriptionId: v.subId, type: 'REMINDER', idempotencyKey: { startsWith: 'nudge:' } } });

    // Day 3: first nudge fires push + SMS. [#1393] The nudges run on the shared
    // clock's unpaused time: the first comes one full day after the suspension
    // notice (t0 + 74 h here), never in the same breath as it.
    resetDevChannelLog();
    await billing.sweepSuspended(new Date(suspendedAt.getTime() + DAY - 60_000));
    expect(await nudges()).toBe(0);
    const day3 = new Date(suspendedAt.getTime() + DAY);
    await billing.sweepSuspended(day3);
    expect(await nudges()).toBe(1);
    expect(devChannelLog.find((e) => e.channel === 'sms' && e.to === v.phone)?.body).toContain('suspended');
    // Same day again: the REMINDER key already exists — nothing re-sends.
    resetDevChannelLog();
    await billing.sweepSuspended(new Date(day3.getTime() + 2 * HOUR));
    expect(await nudges()).toBe(1);
    expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === v.phone)).toHaveLength(0);
    // Next day: nudges again.
    await billing.sweepSuspended(new Date(day3.getTime() + DAY));
    expect(await nudges()).toBe(2);

    // Day 31 past suspension: CHURNED — terminal for dunning.
    resetDevChannelLog();
    const day31 = new Date(suspendedAt.getTime() + 31 * DAY);
    await billing.sweepSuspended(day31);
    const churned = await sub(v.subId);
    expect(churned.status).toBe('CHURNED');
    expect(churned.nextRetryAt).toBeNull(); // the daily MMG/cycle retry stops
    expect(devChannelLog.find((e) => e.channel === 'sms' && e.to === v.phone)?.body).toContain('closed');
    expect(await app.prisma.billingEvent.findFirst({ where: { subscriptionId: v.subId, type: 'CHURNED' } })).not.toBeNull();

    // Churned = out of every dunning loop: no more nudges, no cycle pickup.
    const nudgesAtChurn = await nudges();
    await billing.sweepSuspended(new Date(day31.getTime() + DAY));
    expect(await nudges()).toBe(nudgesAtChurn);
    const attemptsBefore = await app.prisma.billingEvent.count({ where: { subscriptionId: v.subId, type: 'CHARGE_ATTEMPT' } });
    await billing.runBillingCycle(new Date(day31.getTime() + 2 * DAY));
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: v.subId, type: 'CHARGE_ATTEMPT' } })).toBe(attemptsBefore);
    expect((await sub(v.subId)).status).toBe('CHURNED');
  });

  it('churn is never the end of the road: a top-up rejoins — ACTIVE, reinstated, clock cleared', async () => {
    const t0 = new Date('2026-07-01T12:00:00Z');
    const v = await makeBrokeVendorSub(t0);
    await billing.runBillingCycle(t0);
    await billing.runBillingCycle(new Date(t0.getTime() + 25 * HOUR));
    await billing.runBillingCycle(new Date(t0.getTime() + 50 * HOUR));
    await billing.sweepSuspended(new Date(t0.getTime() + 50 * HOUR + 31 * DAY));
    expect((await sub(v.subId)).status).toBe('CHURNED');

    await billing.recordTopUp(v.subId, 25000, 'admin-test', 'rejoin', nanoid(8));

    const s = await sub(v.subId);
    expect(s.status).toBe('ACTIVE');
    expect(s.suspendedAt).toBeNull();
    expect(s.failedAttempts).toBe(0);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: v.vendorId } })).status).toBe('ACTIVE');
    expect(await app.prisma.billingEvent.findFirst({ where: { subscriptionId: v.subId, type: 'REINSTATED' } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The notices say only what is TRUE about paying (owner, 2026-09-29): partners
// pay on the MMG checkout in the Swift app. No notice offers an MMG agent,
// cash, a Swift Number, an account number, the merchant-initiated request or
// "coming soon", and none promises an instant restore. The paying sentence is
// "Pay GY$X with MMG in the Swift app." only while the checkout is live;
// otherwise the amount and when it is due (fee-notice-copy.ts). [DS287 S3] The
// final-warning push carries it too.
// ---------------------------------------------------------------------------

/** Every way to pay a fee notice may NOT name. */
const FORBIDDEN = [
  /tap pay/i, /open the app to pay/i, /pay (?:your weekly fee )?in the app/i, /balance in the app/i, /update your card/i,
  /MMG agent|any agent|Swift Number|account number|pay cash|coming soon/i, /MMG request/i,
  // The doors the owner closed for partners (29 Sep), by word (#1389).
  /\bagents?\b/i, /swift number/i, /\bcash\b/i,
];
const INSTANT = /instantly|the moment you pay/i;
/** The makeBrokeVendorSub week: GY$20,000, nothing in the wallet. */
const DUE_NOW = 'The weekly fee of GY$20,000 is due now.';
const PAY_MMG = 'Pay GY$20,000 with MMG in the Swift app.';
/** [AX349 · #1389] The suspended nudge states what is owed (amountDueNow), not the weekly fee. */
const NUDGE_OWED = 'You owe $20,000 GYD.';

function expectTruthful(text: string | null | undefined, label: string, mode: 'off' | 'live', due: string = DUE_NOW) {
  expect(text, label).toBeTruthy();
  for (const door of FORBIDDEN) expect(text, `${label} names a way to pay that does not exist: ${door}`).not.toMatch(door);
  expect(text, `${label} promises an instant restore`).not.toMatch(INSTANT);
  if (mode === 'live') {
    expect(text, label).toContain(PAY_MMG);
  } else {
    expect(text, label).toContain(due);
    expect(text, `${label} points to a checkout that is off`).not.toMatch(/with MMG in the Swift app/);
  }
}

/** The MMG checkout on (sandbox driver) for one test. */
async function withCheckoutLive<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env['MMG_CHECKOUT_ENABLED'];
  process.env['MMG_CHECKOUT_ENABLED'] = '1';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env['MMG_CHECKOUT_ENABLED'];
    else process.env['MMG_CHECKOUT_ENABLED'] = before;
  }
}

const pushBody = async (userId: string, title: string) =>
  (await app.prisma.notification.findFirst({ where: { userId, title }, orderBy: { createdAt: 'desc' } }))?.body;
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone).map((e) => e.body);

/** The committed notice of a nudge or a churn: the audit record of what was
 *  decided. The delivery worker sends it rendered as billing HISTORY
 *  (billing-notice-delivery.ts), so the record itself must be true too. */
async function committedNotice(subscriptionId: string, keyPrefix: 'nudge:' | 'churned:') {
  const event = await app.prisma.billingEvent.findFirst({
    where: { subscriptionId, idempotencyKey: { startsWith: keyPrefix } },
    orderBy: { createdAt: 'desc' },
  });
  expect(event?.note, `${keyPrefix} notice committed`).toBeTruthy();
  return JSON.parse(event!.note!) as { body: string; sms?: string };
}

/** What the partner actually receives for a committed notice: never a way
 *  to pay that does not exist. */
function expectDeliveredHonestly(phone: string, label: string) {
  const delivered = smsTo(phone);
  expect(delivered.length, `${label} delivered`).toBeGreaterThan(0);
  for (const text of delivered) for (const door of FORBIDDEN) expect(text, label).not.toMatch(door);
}

/** A vendor already SUSPENDED on the given rail. The sweep reads it directly:
 *  replaying the cycle would not work for MOBILE_MONEY, whose sandbox rail
 *  simply approves. */
async function makeSuspendedVendorSub(rail: { billingMethod: 'MOBILE_MONEY' | 'CARD'; payer?: boolean }, suspendedAt: Date) {
  const v = await makeBrokeVendorSub(suspendedAt);
  await app.prisma.subscription.update({
    where: { id: v.subId },
    data: {
      status: 'SUSPENDED', suspendedAt, failedAttempts: 3, nextRetryAt: new Date(suspendedAt.getTime() + DAY),
      billingMethod: rail.billingMethod, mmgPayerMsisdn: rail.payer ? v.phone : null,
    },
  });
  return v;
}

/** The dunning ladder to suspension, checking every notice on the way. */
async function ladderNotices(mode: 'off' | 'live') {
  const t0 = new Date('2026-07-01T12:00:00Z');
  const v = await makeBrokeVendorSub(t0);

  await billing.runBillingCycle(t0); // attempt 1: the retry notice (push)
  expectTruthful(await pushBody(v.userId, 'Subscription payment failed'), 'retry notice', mode);

  resetDevChannelLog();
  await billing.runBillingCycle(new Date(t0.getTime() + 25 * HOUR)); // attempt 2: final warning
  const [finalSms] = smsTo(v.phone);
  expectTruthful(finalSms, 'final-warning SMS', mode);
  expect(finalSms).toContain('suspended at');
  expectTruthful(await pushBody(v.userId, 'Final warning — payment needed'), 'final-warning push', mode);

  resetDevChannelLog();
  await billing.runBillingCycle(new Date(t0.getTime() + 50 * HOUR)); // attempt 3: suspended
  expect((await sub(v.subId)).status).toBe('SUSPENDED');
  expectTruthful(await pushBody(v.userId, 'Subscription suspended'), 'suspension push', mode);
  expectTruthful(smsTo(v.phone)[0], 'suspension SMS', mode);
}

describe('fee notices name only the way to pay that exists', () => {
  it('with the MMG checkout off, every ladder notice states the amount due and promises no way to pay', async () => {
    await ladderNotices('off');
  });

  it('with the MMG checkout live, every ladder notice points to it for exactly what it would charge', async () => {
    await withCheckoutLive(() => ladderNotices('live'));
  });

  it('the daily nudge names neither the merchant-initiated request nor an agent, on any rail', async () => {
    const now = new Date();
    const suspendedAt = new Date(now.getTime() - 2 * DAY);
    const mmg = await makeSuspendedVendorSub({ billingMethod: 'MOBILE_MONEY', payer: true }, suspendedAt);
    const mmgNoPayer = await makeSuspendedVendorSub({ billingMethod: 'MOBILE_MONEY', payer: false }, suspendedAt);
    const card = await makeSuspendedVendorSub({ billingMethod: 'CARD' }, suspendedAt);

    resetDevChannelLog();
    await billing.sweepSuspended(now);

    for (const [label, v] of [['MOBILE_MONEY', mmg], ['MOBILE_MONEY without a payer number', mmgNoPayer], ['CARD', card]] as const) {
      const notice = await committedNotice(v.subId, 'nudge:');
      for (const [channel, text] of [['push', notice.body], ['SMS', notice.sms]] as const) {
        expectTruthful(text, `${label} nudge ${channel}`, 'off', NUDGE_OWED);
      }
      expectDeliveredHonestly(v.phone, `${label} nudge as delivered`);
    }
  });

  it('with the MMG checkout live, the nudge names what is owed and the checkout for exactly that', async () => {
    await withCheckoutLive(async () => {
      const now = new Date();
      const v = await makeSuspendedVendorSub({ billingMethod: 'CARD' }, new Date(now.getTime() - 2 * DAY));
      resetDevChannelLog();
      await billing.sweepSuspended(now);
      const notice = await committedNotice(v.subId, 'nudge:');
      for (const [channel, text] of [['push', notice.body], ['SMS', notice.sms]] as const) {
        expectTruthful(text, `nudge ${channel} (checkout live)`, 'live');
        expect(text, `nudge ${channel} (checkout live)`).toContain(NUDGE_OWED);
      }
      expectDeliveredHonestly(v.phone, 'nudge as delivered (checkout live)');
    });
  });

  it('the churn notice: the amount due while the checkout is off, the checkout to rejoin while it is live', async () => {
    const now = new Date();
    const off = await makeSuspendedVendorSub({ billingMethod: 'MOBILE_MONEY', payer: true }, new Date(now.getTime() - 31 * DAY));
    resetDevChannelLog();
    await billing.sweepSuspended(now);
    expect((await sub(off.subId)).status).toBe('CHURNED');
    const closed = await committedNotice(off.subId, 'churned:');
    expectTruthful(closed.sms, 'churn SMS', 'off');
    expect(closed.sms).toContain('closed');
    expectDeliveredHonestly(off.phone, 'churn SMS as delivered');

    const live = await makeSuspendedVendorSub({ billingMethod: 'CARD' }, new Date(now.getTime() - 31 * DAY));
    await withCheckoutLive(() => billing.sweepSuspended(now));
    expectTruthful((await committedNotice(live.subId, 'churned:')).sms, 'churn SMS (checkout live)', 'live');
  });
});
