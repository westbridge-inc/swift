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

    // Day 3: first nudge fires push + SMS.
    resetDevChannelLog();
    const day3 = new Date(t0.getTime() + 3 * DAY);
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
// The notices say only what is TRUE about paying. The app has no pay button
// and no card door: its How-to-pay screen shows the Swift Number and the agent
// steps (agent-cash.service.ts payCashSteps), and an agent payment is recorded
// at its channel pace (within 1 business day in MANUAL mode), so no notice may
// promise an instant restore either. The MMG request is offered only where the
// rail really sends one: MOBILE_MONEY with a payer number, while still retried.
// ---------------------------------------------------------------------------

/** Every door a fee notice named that the app does not have. */
const UNTRUE_DOORS = [/tap pay/i, /open the app to pay/i, /pay (?:your weekly fee )?in the app/i, /balance in the app/i, /update your card/i];
/** The promise an agent payment cannot keep. */
const INSTANT = /instantly|the moment you pay/i;

function expectTruthful(text: string | null | undefined, label: string) {
  expect(text, label).toBeTruthy();
  for (const door of UNTRUE_DOORS) expect(text, `${label} names a door the app does not have: ${door}`).not.toMatch(door);
  expect(text, `${label} promises an instant restore`).not.toMatch(INSTANT);
  // The one door every partner has: cash at an MMG agent with the Swift Number.
  expect(text, label).toContain('MMG agent');
  expect(text, label).toContain('Swift Number');
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

/** What the partner actually receives for a committed notice: never a door
 *  the app does not have. */
function expectDeliveredHonestly(phone: string, label: string) {
  const delivered = smsTo(phone);
  expect(delivered.length, `${label} delivered`).toBeGreaterThan(0);
  for (const text of delivered) for (const door of UNTRUE_DOORS) expect(text, label).not.toMatch(door);
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

describe('fee notices name only the ways to pay that exist', () => {
  it('the retry notice, the final warning and the suspension send the partner to an MMG agent with the Swift Number', async () => {
    const t0 = new Date('2026-07-01T12:00:00Z');
    const v = await makeBrokeVendorSub(t0);

    await billing.runBillingCycle(t0); // attempt 1 — the retry notice (push)
    expectTruthful(await pushBody(v.userId, 'Subscription payment failed'), 'retry notice');

    resetDevChannelLog();
    await billing.runBillingCycle(new Date(t0.getTime() + 25 * HOUR)); // attempt 2 — final warning
    const [finalSms] = smsTo(v.phone);
    expectTruthful(finalSms, 'final-warning SMS');
    expect(finalSms).toContain('suspended at');

    resetDevChannelLog();
    await billing.runBillingCycle(new Date(t0.getTime() + 50 * HOUR)); // attempt 3 — suspended
    expect((await sub(v.subId)).status).toBe('SUSPENDED');
    expectTruthful(await pushBody(v.userId, 'Subscription suspended'), 'suspension push');
    expectTruthful(smsTo(v.phone)[0], 'suspension SMS');
  });

  it('the daily nudge offers the MMG request only where the rail sends one', async () => {
    const now = new Date();
    const suspendedAt = new Date(now.getTime() - 2 * DAY);
    const mmg = await makeSuspendedVendorSub({ billingMethod: 'MOBILE_MONEY', payer: true }, suspendedAt);
    const mmgNoPayer = await makeSuspendedVendorSub({ billingMethod: 'MOBILE_MONEY', payer: false }, suspendedAt);
    const card = await makeSuspendedVendorSub({ billingMethod: 'CARD' }, suspendedAt);

    resetDevChannelLog();
    await billing.sweepSuspended(now);

    for (const [label, v, offersRequest] of [['MOBILE_MONEY', mmg, true], ['MOBILE_MONEY without a payer number', mmgNoPayer, false], ['CARD', card, false]] as const) {
      const notice = await committedNotice(v.subId, 'nudge:');
      for (const [channel, text] of [['push', notice.body], ['SMS', notice.sms]] as const) {
        expectTruthful(text, `${label} nudge ${channel}`);
        if (offersRequest) expect(text, `${label} nudge ${channel}`).toContain('Approve the MMG request on your phone when one arrives');
        else expect(text, `${label} nudge ${channel}`).not.toContain('MMG request');
      }
      expectDeliveredHonestly(v.phone, `${label} nudge as delivered`);
    }
  });

  it('the churn notice never offers an MMG request — the retries have stopped', async () => {
    const now = new Date();
    const v = await makeSuspendedVendorSub({ billingMethod: 'MOBILE_MONEY', payer: true }, new Date(now.getTime() - 31 * DAY));

    resetDevChannelLog();
    await billing.sweepSuspended(now);

    expect((await sub(v.subId)).status).toBe('CHURNED');
    const { sms } = await committedNotice(v.subId, 'churned:');
    expectTruthful(sms, 'churn SMS');
    expect(sms).toContain('closed');
    expect(sms).not.toContain('MMG request');
    expectDeliveredHonestly(v.phone, 'churn SMS as delivered');
  });
});
