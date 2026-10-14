import { readFeePause } from '../modules/billing/mmg-pause';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { MmgTransaction } from '../providers/mmg/mmg-provider';
const remote = vi.hoisted(() => ({ lookup: vi.fn(), initiate: vi.fn(), history: vi.fn(async () => []) }));
vi.mock('../providers/mmg/mmg-provider', async (original) => ({
  ...await original<typeof import('../providers/mmg/mmg-provider')>(),
  getMmgProvider: () => ({ transactionLookup: remote.lookup, initiatePayment: remote.initiate, transactionHistory: remote.history }),
}));
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { activeOverdueMs, beginConfirmationInTx, currentDunningClock } from '../modules/billing/dunning-clock';
import { subscriptionOperability, inoperableSubscriptionWhere } from '../modules/subscription/operate-gate';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

const db = new PrismaClient();
const due = new Date('2026-09-25T12:00:00Z');
const HOUR = 3_600_000;
const at = (h: number) => new Date(due.getTime() + h * HOUR);
const owned: Array<{ sub: string; user: string; vendor: string }> = [];
const notifications = new NotificationService(db, { to: () => ({ emit: () => undefined }) } as never);
const service = new BillingService(db, notifications, getPaymentProvider());

async function fixture(status: 'PENDING' | 'FAILED' | 'EXPIRED' = 'PENDING') {
  const key = randomUUID();
  const user = await db.user.create({ data: { phone: `+592${Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000}`,
    firstName: 'Synthetic', lastName: 'NegativeProof', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER' } });
  const owner = await db.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await db.vendor.create({ data: { ownerId: owner.id, name: 'Synthetic negative proof fixture', slug: `negative-${key}`,
    vendorType: 'RESTAURANT', phone: user.phone, addressLine1: 'Fixture street', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
  const sub = await db.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', status: 'PAST_DUE', weeklyRate: 20000,
    billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '5926000000', failedAttempts: 2,
    currentPeriodStart: at(-168), currentPeriodEnd: due, nextBillingDate: due, gracePeriodEnd: at(24), prepaidBalance: { create: { balance: 0 } } } });
  owned.push({ sub: sub.id, user: user.id, vendor: vendor.id });
  const reference = `sub:${sub.id}:2026-09-25:a1`;
  await db.billingEvent.create({ data: { subscriptionId: sub.id, type: 'CHARGE_ATTEMPT', amount: 20000, currencyCode: 'GYD', idempotencyKey: `charge:${reference.slice(4)}` } });
  const payment = await db.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: 20000, paymentMethod: 'MOBILE_MONEY', status,
    clientKey: reference, externalRef: `mmg-synthetic-${key}`, periodStart: due, periodEnd: at(168),
    createdAt: at(47), expiresAt: at(200), failureRaw: { providerEffect: 'AUTHORIZED', authorizedAt: at(47).toISOString() } } });
  if (status === 'PENDING') await db.$transaction((tx) => beginConfirmationInTx(tx, sub.id, { paymentId: payment.id }, 'PAYMENT_DISPATCHED', at(47)));
  const answer: MmgTransaction = { transactionId: payment.externalRef!, reference, status: 'declined', amountMinor: 2_000_000, currencyCode: 'GYD' };
  return { sub, payment, answer };
}

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  const subIds = owned.map((r) => r.sub); const userIds = owned.map((r) => r.user);
  await cleanupBillingClocks(db, subIds);
  await db.subscription.deleteMany({ where: { id: { in: subIds } } });
  await db.vendor.deleteMany({ where: { id: { in: owned.map((r) => r.vendor) } } });
  await db.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe('MMG negative identity with the real shared clock and payment transaction', () => {
  for (const status of ['declined', 'expired', 'reversed'] as const) {
    for (const mismatch of ['transaction', 'reference', 'missing-reference'] as const) {
      it(`${status} with ${mismatch} mismatch keeps 47h pause, access and original instruction`, async () => {
        const { sub, payment, answer } = await fixture(); answer.status = status;
        if (mismatch === 'transaction') answer.transactionId = 'mmg-unrelated';
        if (mismatch === 'reference') answer.reference = 'unrelated-request';
        if (mismatch === 'missing-reference') delete answer.reference;
        remote.lookup.mockResolvedValue(answer);
        await service.pollPendingMmgCharges(at(100));
        const current = await db.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(current).toMatchObject({ status: 'PENDING', externalRef: payment.externalRef, clientKey: payment.clientKey });
        expect((current.failureRaw as any).mmgTerminalEvidence).toBeUndefined();
        const clock = await db.$transaction((tx) => currentDunningClock(tx, sub.id, at(100)));
        expect(clock.pausedAt).not.toBeNull(); expect(activeOverdueMs(clock, at(100))).toBe(47 * HOUR);
        const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
        expect(fresh.failedAttempts).toBe(2); expect(fresh.status).toBe('PAST_DUE');
        expect(subscriptionOperability(fresh, { missingRow: 'BLOCK' }, await readFeePause(db), at(100)).operable).toBe(true);
        expect(await db.subscription.count({ where: { id: sub.id, ...inoperableSubscriptionWhere(await readFeePause(db), at(100)) } })).toBe(0);
        expect(await db.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_FAILED' } })).toBe(0);
        expect(remote.initiate).not.toHaveBeenCalled();
      });
    }
  }
  it('a bound negative resumes exactly one hour and never suspends in resolution', async () => {
    const { sub, payment, answer } = await fixture(); remote.lookup.mockResolvedValue(answer);
    await service.pollPendingMmgCharges(at(100));
    const current = await db.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(current.status).toBe('FAILED'); expect((current.failureRaw as any).mmgTerminalEvidence).toMatchObject({ source: 'LOOKUP', paymentId: payment.id });
    const clock = await db.$transaction((tx) => currentDunningClock(tx, sub.id, at(100)));
    expect(clock.pausedAt).toBeNull(); expect(activeOverdueMs(clock, at(100))).toBe(47 * HOUR);
    const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.status).toBe('PAST_DUE'); expect(fresh.billingEnforcementDueAt).toEqual(at(101));
    expect(await db.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_FAILED' } })).toBe(1);
  });
  for (const status of ['FAILED', 'EXPIRED'] as const) {
    it(`legacy ${status} is held and made pollable without any new failure event`, async () => {
      const { sub, payment } = await fixture(status);
      await service.reconcileTerminalWithoutOutcome(at(100));
      expect(await db.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: 'PENDING', externalRef: payment.externalRef });
      expect(await db.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: payment.id } })).toMatchObject({ status: 'ACTIVE' });
      const fresh = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(fresh.failedAttempts).toBe(2); expect(fresh.status).toBe('PAST_DUE');
      expect(subscriptionOperability(fresh, { missingRow: 'BLOCK' }, await readFeePause(db), at(100)).operable).toBe(true);
      expect(await db.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_FAILED' } })).toBe(0);
      expect(remote.initiate).not.toHaveBeenCalled();
    });
  }
});
