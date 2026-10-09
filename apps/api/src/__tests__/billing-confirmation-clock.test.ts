import { resolveFinanceConfirmation, confirmationReviewQueue } from '../modules/billing/confirmation-finance';
import { ExpoPushProvider, withPushRetry, type NotificationChannels } from '../providers/notifications/channels';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { beginConfirmationInTx, resolveConfirmationInTx, currentDunningClock, activeOverdueMs, hasConfirmationInTx } from '../modules/billing/dunning-clock';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { inoperableSubscriptionWhere, subscriptionOperability } from '../modules/subscription/operate-gate';

const db = new PrismaClient();
const HOUR = 3_600_000;
const due = new Date('2026-09-01T12:00:00Z');
const at = (hours: number) => new Date(due.getTime() + hours * HOUR);
const subscriptions: string[] = [];
const users: string[] = [];
const vendors: string[] = [];
const io = { to: () => ({ emit: () => undefined }) };
const billing = new BillingService(db, new NotificationService(db, io as never), getPaymentProvider());

async function fixture() {
  const key = randomUUID();
  const user = await db.user.create({ data: {
    phone: `+592${Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000}`,
    firstName: 'Clock', lastName: 'Fixture', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
  } });
  users.push(user.id);
  const owner = await db.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await db.vendor.create({ data: {
    ownerId: owner.id, name: 'Confirmation clock fixture', slug: `clock-${key}`,
    vendorType: 'RESTAURANT', phone: user.phone, addressLine1: 'Test street', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isVerified: true,
  } });
  vendors.push(vendor.id);
  const sub = await db.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000,
    billingMethod: 'CASH', currentPeriodStart: at(-168), currentPeriodEnd: due, nextBillingDate: due,
    prepaidBalance: { create: { balance: 0 } },
  } });
  subscriptions.push(sub.id);
  return { sub, user, vendor };
}

async function run(id: string, hours: number) {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id }, include: {
    vendor: { select: { id: true, owner: { select: { userId: true } } } },
    rider: { select: { userId: true } }, driver: { select: { userId: true } },
  } });
  return billing.billSubscription(sub, at(hours));
}

beforeAll(async () => { await db.$connect(); });
afterAll(async () => {
  await db.billingNoticeHandoff.deleteMany({ where: { notice: { subscriptionId: { in: subscriptions } } } });
  await db.billingFeeNotice.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.paymentConfirmationHold.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.billingDunningClock.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.cardSession.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.providerPayment.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.subscription.deleteMany({ where: { id: { in: subscriptions } } });
  await db.vendor.deleteMany({ where: { id: { in: vendors } } });
  await db.vendorOwner.deleteMany({ where: { userId: { in: users } } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('owner: a full 48 active hours of weekly-fee grace on every path', () => {
  it('a first failed charge keeps both memory and SQL operability at hour 47', async () => {
    const { sub } = await fixture();
    await run(sub.id, 0);
    const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(subscriptionOperability(fresh, { missingRow: 'BLOCK' }, at(47)).operable).toBe(true);
    expect(await db.subscription.count({ where: { id: sub.id, ...inoperableSubscriptionWhere(at(47)) } })).toBe(0);
  });

  it('three direct failures inside 47 hours cannot suspend or close the vendor', async () => {
    const { sub, vendor } = await fixture();
    await run(sub.id, 0);
    await run(sub.id, 1);
    await run(sub.id, 2);
    const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.status).toBe('PAST_DUE');
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).status).toBe('ACTIVE');
    expect(subscriptionOperability(fresh, { missingRow: 'BLOCK' }, at(47)).operable).toBe(true);
  });

  it('the ordinary three-failure ladder can suspend after 48 full hours', async () => {
    const { sub } = await fixture();
    await run(sub.id, 0);
    await run(sub.id, 24);
    await run(sub.id, 48);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('SUSPENDED');
  });

  it('autoSuspend disabled remains authoritative beyond 48h in the worker and both operability gates', async () => {
    const { sub } = await fixture();
    await db.subscription.update({ where: { id: sub.id }, data: { autoSuspendEnabled: false } });
    await run(sub.id, 0); await run(sub.id, 24); await run(sub.id, 48); await run(sub.id, 100);
    const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.status).toBe('PAST_DUE');
    expect(subscriptionOperability(fresh, { missingRow: 'BLOCK' }, at(100)).operable).toBe(true);
    expect(await db.subscription.count({ where: { id: sub.id, ...inoperableSubscriptionWhere(at(100)) } })).toBe(0);
  });
});

describe.each(['MMG_HELD', 'CARD_UNKNOWN', 'CARD_3DS', 'LEGACY_CARD_UNKNOWN'] as const)('%s confirmation pauses shared billing', (source) => {
  it('prevents another rail from suspending at wall hour 100 and sends no fee demand', async () => {
    const { sub, user } = await fixture();
    await run(sub.id, 0);
    await run(sub.id, 24);
    if (source === 'MMG_HELD') {
      await db.mmgCheckoutIntent.create({ data: {
        subscriptionId: sub.id, merchantTransactionId: `${Date.now()}${Math.floor(Math.random() * 90000) + 10000}`,
        amount: 20000, currencyCode: 'GYD', createdByUserId: user.id, platform: 'web', status: 'HELD',
        checkoutUrlSealed: Buffer.alloc(40), checkoutUrlDek: Buffer.alloc(40),
        createdAt: at(47), updatedAt: at(47), expiresAt: at(47.5), reason: 'REFERENCE_UNCONFIRMED',
      } });
    } else if (source === 'LEGACY_CARD_UNKNOWN') {
      await db.subscriptionPayment.create({ data: {
        subscriptionId: sub.id, amount: 20000, paymentMethod: 'CARD', status: 'UNKNOWN',
        clientKey: `card:${sub.id}:2026-09-01:a2`, periodStart: due, periodEnd: at(168),
        createdAt: at(47), expiresAt: at(71), failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD' },
      } });
    } else {
      await db.cardSession.create({ data: {
        subscriptionId: sub.id, userId: user.id, purpose: 'PAY_NOW',
        provider: 'simulator', environment: 'sandbox', providerAccount: 'clock-fixture',
        stateHash: 'a'.repeat(64), amount: 20000, currencyCode: 'GYD', periodStart: due,
        status: source === 'CARD_UNKNOWN' ? 'UNKNOWN' : 'OPEN',
        failureCode: source === 'CARD_UNKNOWN' ? 'PROVIDER_UNKNOWN' : 'REQUIRES_ACTION',
        createdAt: at(47), updatedAt: at(47), returnedAt: at(47), expiresAt: at(47.5),
      } });
    }
    const before = await db.notification.count({ where: { userId: user.id } });
    await run(sub.id, 100);
    const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.status).toBe('PAST_DUE');
    expect(fresh.failedAttempts).toBe(2);
    expect(subscriptionOperability(fresh, { missingRow: 'BLOCK' }, at(100)).operable).toBe(true);
    expect(await db.notification.count({ where: { userId: user.id } })).toBe(before);
  });
});

async function heldCheckout(subscriptionId: string, userId: string, hours: number) {
  return db.$transaction(async (tx) => {
    const row = await tx.mmgCheckoutIntent.create({ data: {
      subscriptionId, createdByUserId: userId, merchantTransactionId: `${Date.now()}${Math.floor(Math.random() * 90000) + 10000}`,
      amount: 20000, currencyCode: 'GYD', platform: 'web', status: 'HELD',
      checkoutUrlSealed: Buffer.alloc(40), checkoutUrlDek: Buffer.alloc(40), createdAt: at(hours), expiresAt: at(hours + 1),
    } });
    await beginConfirmationInTx(tx, subscriptionId, { checkoutId: row.id }, 'REFERENCE_UNCONFIRMED', at(hours));
    return row;
  });
}
const rejectCheckout = (subscriptionId: string, checkoutId: string, hours: number) => db.$transaction(async (tx) => {
  await tx.mmgCheckoutIntent.update({ where: { id: checkoutId }, data: { status: 'NOT_PAID' } });
  await resolveConfirmationInTx(tx, subscriptionId, { checkoutId }, 'PROVEN_UNPAID', { actor: 'fixture-finance', reference: 'fixture-bank-confirmed-unpaid' }, at(hours));
});

describe('remaining active time and exact source resolution', () => {
  it('pause at 47h and reject at 100h preserves exactly one hour, with no new charge to enforce exhausted attempts', async () => {
    const { sub, user } = await fixture();
    await run(sub.id, 0); await run(sub.id, 1); await run(sub.id, 2);
    const checkout = await heldCheckout(sub.id, user.id, 47);
    await run(sub.id, 100);
    await rejectCheckout(sub.id, checkout.id, 100);
    const resumed = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(resumed.status).toBe('PAST_DUE');
    expect(resumed.billingEnforcementDueAt).toEqual(at(101));
    expect(resumed.nextRetryAt).toEqual(at(101));
    expect(subscriptionOperability(resumed, { missingRow: 'BLOCK' }, new Date(at(101).getTime() - 1)).operable).toBe(true);
    const attempts = await db.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_ATTEMPT' } });
    expect(await run(sub.id, 100.999)).toBe('pending');
    expect(await run(sub.id, 101)).toBe('suspended');
    expect(await db.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_ATTEMPT' } })).toBe(attempts);
  });

  it('overlapping MMG and card uncertainty consumes the pause once and requires both exact resolutions', async () => {
    const { sub, user } = await fixture();
    await run(sub.id, 0); await run(sub.id, 24);
    const checkout = await heldCheckout(sub.id, user.id, 47);
    const card = await db.$transaction(async (tx) => {
      const row = await tx.cardSession.create({ data: { subscriptionId: sub.id, userId: user.id, purpose: 'PAY_NOW', provider: 'simulator',
        environment: 'sandbox', providerAccount: 'clock-fixture', stateHash: 'c'.repeat(64), amount: 20000, currencyCode: 'GYD',
        periodStart: due, status: 'UNKNOWN', createdAt: at(60), expiresAt: at(61) } });
      await beginConfirmationInTx(tx, sub.id, { cardSessionId: row.id }, 'CARD_UNKNOWN', at(60));
      return row;
    });
    expect(await db.$transaction((tx) => hasConfirmationInTx(tx, sub.id, at(100), { checkoutId: checkout.id }))).toBe(true);
    expect(await db.$transaction((tx) => hasConfirmationInTx(tx, sub.id, at(100), { cardSessionId: card.id }))).toBe(true);
    await rejectCheckout(sub.id, checkout.id, 100);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).billingConfirmationPausedAt).not.toBeNull();
    await db.$transaction(async (tx) => {
      await tx.cardSession.update({ where: { id: card.id }, data: { status: 'FAILED' } });
      await resolveConfirmationInTx(tx, sub.id, { cardSessionId: card.id }, 'PROVEN_UNPAID', { actor: 'card-provider', reference: 'declined' }, at(120));
    });
    const clock = await db.$transaction((tx) => currentDunningClock(tx, sub.id, at(120)));
    expect(activeOverdueMs(clock, at(120))).toBe(47 * HOUR);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).billingEnforcementDueAt).toEqual(at(121));
    await rejectCheckout(sub.id, checkout.id, 130);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).billingEnforcementDueAt).toEqual(at(121));
  });

  it('an eligible but unsuspended PAST_DUE payer remains operable during a late hold; zero time does not suspend in resolution', async () => {
    const { sub, user } = await fixture();
    await run(sub.id, 0); await run(sub.id, 1); await run(sub.id, 2);
    const checkout = await heldCheckout(sub.id, user.id, 50);
    const held = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(subscriptionOperability(held, { missingRow: 'BLOCK' }, at(100)).operable).toBe(true);
    expect(await db.subscription.count({ where: { id: sub.id, ...inoperableSubscriptionWhere(at(100)) } })).toBe(0);
    await rejectCheckout(sub.id, checkout.id, 100);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('PAST_DUE');
    expect(await run(sub.id, 100)).toBe('pending');
    expect(await run(sub.id, 100.001)).toBe('suspended');
  });

  it('opening a hold never restores an already suspended vendor', async () => {
    const { sub, user, vendor } = await fixture();
    await run(sub.id, 0); await run(sub.id, 24); await run(sub.id, 48);
    await heldCheckout(sub.id, user.id, 49);
    const held = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(subscriptionOperability(held, { missingRow: 'BLOCK' }, at(100)).operable).toBe(false);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).status).toBe('SUSPENDED');
  });

  it('a hold before due consumes no overdue time and preserves all 48 hours', async () => {
    const { sub, user } = await fixture();
    const checkout = await heldCheckout(sub.id, user.id, -1);
    await rejectCheckout(sub.id, checkout.id, 100);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).billingEnforcementDueAt).toEqual(at(148));
  });
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const noSms = { sendSms: async () => ({ ref: 'fixture-no-sms' }) };
const noEmail = { sendEmail: async () => ({ ref: 'fixture-no-email' }) };
const demand = (userId: string, subscriptionId: string, stage: string, sms = false) => ({
  userId, type: 'SYSTEM_ANNOUNCEMENT' as const, title: 'Fee fixture', body: 'Weekly fee needs attention',
  data: { kind: 'billing_failed', subscriptionId }, feeStageKey: stage, ...(sms ? { feeSms: 'Weekly fee fixture' } : {}),
});

describe('the actual fee-demand handoff is serialized with confirmation', () => {
  it('a hold after recipient preparation blocks push and resumes the same stage once', async () => {
    const { sub, user } = await fixture(); await run(sub.id, 0);
    await db.deviceToken.create({ data: { userId: user.id, token: `fixture-${randomUUID()}`, platform: 'ios' } });
    const prepared = latch(); const proceed = latch(); let sent = 0;
    const channels: NotificationChannels = { sms: noSms, email: noEmail, push: {
      supportsHandoff: true,
      async sendPush(_tokens, _title, _body, _data, options) {
        prepared.release(); await proceed.promise;
        return await options!.handoff!('chunk:0', async () => ({ sent: ++sent })) ?? { sent: 0 };
      },
    } };
    const notifications = new NotificationService(db, io as never, channels);
    const sending = notifications.send(demand(user.id, sub.id, 'recipient-barrier'));
    await prepared.promise;
    const checkout = await heldCheckout(sub.id, user.id, 47);
    proceed.release(); await sending;
    expect(sent).toBe(0);
    const notice = await db.billingFeeNotice.findFirstOrThrow({ where: { subscriptionId: sub.id, stageKey: 'recipient-barrier' } });
    expect(notice.status).toBe('PENDING');
    await rejectCheckout(sub.id, checkout.id, 100);
    await notifications.deliverFeeDemand(notice.id);
    await notifications.deliverFeeDemand(notice.id);
    expect(sent).toBe(1);
    expect(await db.notification.count({ where: { userId: user.id, dedupeKey: `fee-demand:${notice.id}` } })).toBe(1);
  });

  it('real Expo chunks and retry wrapper recheck after a hold wins between requests', async () => {
    const { sub, user } = await fixture(); await run(sub.id, 0);
    await db.deviceToken.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      userId: user.id, token: `ExponentPushToken[clock-${sub.id}-${String(i).padStart(3, '0')}]`, platform: 'ios',
    })) });
    const submitted = latch(); const response = latch(); let requests = 0;
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests += 1;
      if (requests === 1) { submitted.release(); await response.promise; }
      const count = JSON.parse(String(init?.body)).length;
      return { ok: true, json: async () => ({ data: Array.from({ length: count }, () => ({ status: 'ok' })) }) } as Response;
    });
    try {
      const notifications = new NotificationService(db, io as never, { sms: noSms, email: noEmail, push: withPushRetry(new ExpoPushProvider(), [0]) });
      const sending = notifications.send(demand(user.id, sub.id, 'expo-chunks'));
      await submitted.promise;
      // This commits while the first network response is still pending: no network await holds the payer lock.
      const checkout = await heldCheckout(sub.id, user.id, 47);
      response.release(); await sending;
      expect(requests).toBe(1);
      const notice = await db.billingFeeNotice.findFirstOrThrow({ where: { subscriptionId: sub.id, stageKey: 'expo-chunks' } });
      await rejectCheckout(sub.id, checkout.id, 100);
      await notifications.deliverFeeDemand(notice.id);
      expect(requests).toBe(2); // only the unsent second chunk
      await notifications.deliverFeeDemand(notice.id);
      expect(requests).toBe(2);
    } finally { response.release(); mock.mockRestore(); }
  });

  it('a lost SMS acknowledgement is durably UNKNOWN and never blindly resent', async () => {
    const { sub, user } = await fixture(); await run(sub.id, 0);
    let sends = 0;
    const notifications = new NotificationService(db, io as never, { email: noEmail, push: { sendPush: async () => ({ sent: 0 }) },
      sms: { async sendSms() { sends += 1; throw new Error('fixture lost acknowledgement'); } },
    });
    await expect(notifications.send(demand(user.id, sub.id, 'sms-unknown', true))).rejects.toThrow('lost acknowledgement');
    const notice = await db.billingFeeNotice.findFirstOrThrow({ where: { subscriptionId: sub.id, stageKey: 'sms-unknown' } });
    expect(await db.billingNoticeHandoff.findFirst({ where: { noticeId: notice.id, channel: 'sms' } })).toMatchObject({ status: 'UNKNOWN' });
    await notifications.deliverFeeDemand(notice.id);
    expect(sends).toBe(1);
  });
});

describe('finance proof and source ownership', () => {
  it('wrong tenant, stale epoch and a paid checkbox alone cannot release an MMG hold', async () => {
    const { sub, user } = await fixture(); await run(sub.id, 0);
    const checkout = await heldCheckout(sub.id, user.id, 47);
    const [row] = (await confirmationReviewQueue(db, 'swift-default', at(100))).filter((r) => r.subscriptionId === sub.id);
    expect(row).toMatchObject({ overdue: true, remainingGraceMs: HOUR });
    const input = { id: row!.id, tenantId: 'swift-default', actorId: user.id, sourceId: checkout.id,
      epoch: row!.epoch, clockVersion: row!.clockVersion, decision: 'PAID' as const, evidenceReference: 'fixture-bank-proof' };
    const audit = vi.fn(async () => undefined);
    await expect(resolveFinanceConfirmation(db, { ...input, tenantId: 'clock-foreign' }, audit, at(100))).rejects.toThrow();
    await expect(resolveFinanceConfirmation(db, { ...input, epoch: row!.epoch + 1 }, audit, at(100))).rejects.toThrow('Reload');
    await expect(resolveFinanceConfirmation(db, input, audit, at(100))).rejects.toThrow('settlement workflow');
    expect(audit).not.toHaveBeenCalled();
    const result = await resolveFinanceConfirmation(db, { ...input, decision: 'UNPAID' }, audit, at(100));
    expect(result).toMatchObject({ changed: true, status: 'PROVEN_UNPAID' });
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).billingEnforcementDueAt).toEqual(at(101));
    expect((await resolveFinanceConfirmation(db, { ...input, decision: 'UNPAID' }, audit, at(110))).changed).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});


describe('confirmation queue console context', () => {
  it('returns the Swift reference, partner and only matching credited MMG records', async () => {
    const { sub, user } = await fixture(); await run(sub.id, 0);
    const checkout = await heldCheckout(sub.id, user.id, 47);
    const key = `queue-${randomUUID()}`;
    await db.mmgCheckoutIntent.update({ where: { id: checkout.id }, data: { candidates: [key, `${key}-open`, `${key}-wrong-amount`, `${key}-wrong-currency`, `${key}-other-tenant`] } });
    const matching = await db.providerPayment.create({ data: { provider: 'MMG', providerTxnId: key, subscriptionId: sub.id, amount: checkout.amount, currencyCode: 'GYD', status: 'CREDITED' } });
    await db.providerPayment.createMany({ data: [
      { provider: 'MMG', providerTxnId: `${key}-open`, subscriptionId: sub.id, amount: checkout.amount, currencyCode: 'GYD', status: 'OPEN' },
      { provider: 'MMG', providerTxnId: `${key}-wrong-amount`, subscriptionId: sub.id, amount: 1, currencyCode: 'GYD', status: 'CREDITED' },
      { provider: 'MMG', providerTxnId: `${key}-wrong-currency`, subscriptionId: sub.id, amount: checkout.amount, currencyCode: 'USD', status: 'CREDITED' },
      { provider: 'MMG', providerTxnId: `${key}-other-tenant`, tenantId: 'synthetic-foreign', subscriptionId: sub.id, amount: checkout.amount, currencyCode: 'GYD', status: 'CREDITED' },
    ] });
    const row = (await confirmationReviewQueue(db, 'swift-default', at(100))).find((r) => r.sourceId === checkout.id);
    expect(row).toMatchObject({ swiftReference: checkout.merchantTransactionId, partner: 'Confirmation clock fixture',
      settlementPayments: [{ providerPaymentId: matching.id, mmgTransactionId: key }] });
    expect((await confirmationReviewQueue(db, 'synthetic-foreign', at(100))).some((r) => r.sourceId === checkout.id)).toBe(false);
    // Displaying a recorded payment never relaxes the resolver's independent ledger proof.
    await expect(resolveFinanceConfirmation(db, { id: row!.id, tenantId: 'swift-default', actorId: user.id, sourceId: checkout.id,
      epoch: row!.epoch, clockVersion: row!.clockVersion, decision: 'PAID', providerPaymentId: matching.id, evidenceReference: 'synthetic-proof' }, vi.fn(), at(100))).rejects.toThrow('settlement workflow');
  });
});
