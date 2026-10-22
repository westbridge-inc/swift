// ---------------------------------------------------------------------------
// [S1 · SWITCHES 21 Oct, Option A] The MMG push rail is its own switch.
//
// Production used to boot MMG_DRIVER=live only with
// MMG_REFERENCE_ROUNDTRIP_VERIFIED=1, and that same flag ARMED the unproven
// push rail: the billing run and the poller would have sent automatic charge
// requests to every partner on MOBILE_MONEY with a payer number, and partners
// can choose that rail. GUARDRAILS §1: the weekly fee is paid on the MMG
// checkout page only. Now:
//   - live MMG (checkout, lookup, reversal) needs no round-trip flag (boot-config.test.ts);
//   - the push rail needs MMG_PUSH_RAIL_ON=1 AND the round trip, never in production;
//   - with it off, the billing run sends nothing to MMG: the week fails with a
//     "pay on the checkout page" note, like a cash plan;
//   - with it off, the poller never follows up a request it cannot match by
//     OUR reference (no round trip): the row waits untouched;
//   - with it off, a partner cannot switch to automatic MMG charges.
// Subjects are stores (vendor subscriptions): their fee has one owner.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PaymentMethod } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService, MMG_PUSH_OFF_REASON } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_PUSH_RAIL_ENV, mmgPushFollowUpOn, mmgPushRailOn } from '../providers/mmg/mmg-provider';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

const DAY = 24 * 60 * 60 * 1000;
const LIVE = {
  MMG_DRIVER: 'live', MMG_API_URL: 'https://api.mmg.gy/olive/publisher/v1', MMG_API_KEY: 'k', MMG_MERCHANT_ID: '5926000000',
  MMG_PASSWORD: 'p', MMG_MKEY: 'mk', MMG_MSECRET: 'ms',
};

describe('[Option A] the push rail switch (no database)', () => {
  it('pushes only from the sandbox off production, or live with BOTH the switch and the round trip, never in production', () => {
    expect(mmgPushRailOn({ NODE_ENV: 'test' })).toBe(true);
    expect(mmgPushRailOn({ NODE_ENV: 'test', MMG_DRIVER: 'sandbox' })).toBe(true);
    expect(mmgPushRailOn({ NODE_ENV: 'production', MMG_DRIVER: 'sandbox' })).toBe(false);
    expect(mmgPushRailOn({ NODE_ENV: 'test', MMG_DRIVER: 'disabled', [MMG_PUSH_RAIL_ENV]: '1' })).toBe(false);
    expect(mmgPushRailOn({ NODE_ENV: 'test', ...LIVE })).toBe(false);
    expect(mmgPushRailOn({ NODE_ENV: 'test', ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' })).toBe(false);
    expect(mmgPushRailOn({ NODE_ENV: 'test', ...LIVE, [MMG_PUSH_RAIL_ENV]: '1' })).toBe(false);
    for (const near of ['true', 'yes', 'on', ' 1', '01']) {
      expect(mmgPushRailOn({ NODE_ENV: 'test', ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', [MMG_PUSH_RAIL_ENV]: near }), near).toBe(false);
    }
    expect(mmgPushRailOn({ NODE_ENV: 'test', ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', [MMG_PUSH_RAIL_ENV]: '1' })).toBe(true);
    expect(mmgPushRailOn({ NODE_ENV: 'production', ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', [MMG_PUSH_RAIL_ENV]: '1' })).toBe(false);
  });

  it('follows up a request already sent only where our reference round trip is proved', () => {
    expect(mmgPushFollowUpOn({ NODE_ENV: 'test' })).toBe(true);
    expect(mmgPushFollowUpOn({ NODE_ENV: 'test', ...LIVE })).toBe(false);
    expect(mmgPushFollowUpOn({ NODE_ENV: 'test', ...LIVE, [MMG_PUSH_RAIL_ENV]: '1' })).toBe(false);
    expect(mmgPushFollowUpOn({ NODE_ENV: 'production', ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' })).toBe(true);
    expect(mmgPushFollowUpOn({ NODE_ENV: 'test', MMG_DRIVER: 'disabled' })).toBe(false);
  });
});

let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const PHONE_PREFIX = retainedPhonePrefix('29');

async function makeVendorSub(method: PaymentMethod, due = new Date(Date.now() - 60_000)) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Push', lastName: `Off${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Push Off Store ${seq}`, slug: `push-off-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Checkout Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 12000,
      billingMethod: method,
      mmgPayerMsisdn: method === 'MOBILE_MONEY' ? `6092${String(seq).padStart(3, '0')}` : null,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  subIds.push(sub.id);
  return sub.id;
}

const withRelations = (id: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
async function facts(subId: string) {
  const [payments, events] = await Promise.all([
    app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } }),
    app.prisma.billingEvent.findMany({ where: { subscriptionId: subId }, select: { type: true, note: true } }),
  ]);
  return {
    mmgPayments: payments.filter((p) => p.paymentMethod === 'MOBILE_MONEY'),
    failureNotes: events.filter((e) => e.type === 'CHARGE_FAILED').map((e) => e.note),
  };
}
function stubLive(extra: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...LIVE, ...extra })) vi.stubEnv(k, v);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (subIds.length > 0) {
    await app.prisma.subscription.updateMany({ where: { id: { in: subIds }, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', autoRenew: false } });
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
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

describe('[Option A] the billing run never pushes while the switch is off', () => {
  it('live MMG with the round trip verified but no push switch: nothing reaches MMG; the week fails with the checkout note', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    stubLive({ MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the push rail is off: MMG must not be contacted'));
    await billing.billSubscription((await withRelations(subId)) as any);
    expect(fetchSpy).not.toHaveBeenCalled();
    const f = await facts(subId);
    expect(f.mmgPayments).toEqual([]);
    expect(f.failureNotes).toEqual([MMG_PUSH_OFF_REASON]);
  });

  it('the partner is told: the payment-failed notice is written and delivered, and names only a way to pay that exists today', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    stubLive({ MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the push rail is off: MMG must not be contacted'));
    expect(await billing.billSubscription((await withRelations(subId)) as any)).toBe('failed');
    const owner = (await withRelations(subId)).vendor!.owner.userId;
    const outbox = await app.prisma.billingFeeNotice.findMany({ where: { subscriptionId: subId }, select: { status: true, stageKey: true } });
    expect(outbox).toEqual([{ status: 'DELIVERED', stageKey: 'failed:a1' }]);
    const told = await app.prisma.notification.findMany({ where: { userId: owner, data: { path: ['kind'], equals: 'billing_failed' } } });
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe('Subscription payment failed');
    expect(told[0]!.body.startsWith(`${MMG_PUSH_OFF_REASON}.`)).toBe(true);
    // The hosted checkout is not live in this test: the notice must not send the partner to it.
    expect(told[0]!.body).not.toMatch(/checkout/i);
    expect(told[0]!.body).toContain('The weekly fee of GY$12,000 is due now.');
  });

  it('control: with the push rail on (sandbox, off production) the same plan IS sent a charge request', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    vi.stubEnv('MMG_DRIVER', 'sandbox');
    await billing.billSubscription((await withRelations(subId)) as any);
    const f = await facts(subId);
    expect(f.mmgPayments.length).toBe(1);
    expect(f.failureNotes).not.toContain(MMG_PUSH_OFF_REASON);
  });
});

describe('[Option A] the poller never follows up a request it cannot match by our reference', () => {
  it('live MMG without the round trip: a pending MMG request waits untouched and MMG is not contacted', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    const row = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        periodStart: s.currentPeriodEnd!, periodEnd: new Date(s.currentPeriodEnd!.getTime() + 7 * DAY),
        externalRef: `push-off-${nanoid(10)}`, createdAt: new Date(Date.now() - DAY),
      },
    });
    stubLive({ [MMG_PUSH_RAIL_ENV]: '1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no round trip: MMG must not be contacted'));
    const out = await billing.pollPendingMmgCharges();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.stillPending).toBeGreaterThanOrEqual(1);
    const after = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('PENDING');
    expect(after.lastPolledAt).toBeNull();
  });
});

describe('[Option A] with the round trip proved, the poller still follows up a request already sent (never a new one)', () => {
  it('live MMG, round trip verified, push switch off: a pending request is looked up at MMG and stamped', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    const row = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        periodStart: s.currentPeriodEnd!, periodEnd: new Date(s.currentPeriodEnd!.getTime() + 7 * DAY),
        externalRef: `push-off-${nanoid(10)}`, createdAt: new Date(Date.now() - 60_000),
      },
    });
    stubLive({ MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' });
    // MMG unreachable: the request stays as it is [LAW M-5]; what matters is that it was asked.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('MMG unreachable in this test'));
    await billing.pollPendingMmgCharges();
    expect(fetchSpy).toHaveBeenCalled();
    const after = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastPolledAt).not.toBeNull();
    expect(after.status).toBe('PENDING');
    expect((await facts(subId)).mmgPayments).toHaveLength(1);
  });
});

describe('[Option A] a partner cannot choose automatic MMG charges while the push rail is off', () => {
  it('switching a cash plan to MOBILE_MONEY is refused (MMG_AUTO_CHARGE_OFF) and nothing changes', async () => {
    const subId = await makeVendorSub('CASH');
    stubLive({ MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' });
    await expect(billing.setBillingRail(subId, 'MOBILE_MONEY', '6092999')).rejects.toMatchObject({ statusCode: 409, code: 'MMG_AUTO_CHARGE_OFF' });
    const s = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(s.billingMethod).toBe('CASH');
    expect(s.mmgPayerMsisdn).toBeNull();
  });

  it('a plan already on MOBILE_MONEY may still resume (the in-app resume keeps its method), and is never pushed', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    stubLive({ MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' });
    const updated = await billing.setBillingRail(subId, 'MOBILE_MONEY', '6092998');
    expect(updated.billingMethod).toBe('MOBILE_MONEY');
  });

  it('control: with the push rail on (sandbox) the same switch is allowed', async () => {
    const subId = await makeVendorSub('CASH');
    vi.stubEnv('MMG_DRIVER', 'sandbox');
    const updated = await billing.setBillingRail(subId, 'MOBILE_MONEY', '6092997');
    expect(updated.billingMethod).toBe('MOBILE_MONEY');
  });
});
