import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
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
  await db.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
  await db.cardSession.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
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
