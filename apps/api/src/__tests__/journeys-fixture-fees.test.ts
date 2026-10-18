import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNameNotReserved } from '../lib/fixture-filter';
import { moverFeeOperability } from '../modules/subscription/mover-fee-authority';
import { inoperableSubscriptionWhere, subscriptionOperability } from '../modules/subscription/operate-gate';
import { readFeePause } from '../modules/billing/mmg-pause';
import { TRIAL_DAYS } from '../modules/subscription/subscription.service';

// ---------------------------------------------------------------------------
// [TA-S0-003 · C1] The walled-login journeys on a throwaway copy of staging
// (deploy/wall/journeys-on-copy.sh). 16 Oct: the first copy that booted held
// the wall, yet 0 of 8 journeys passed, for two reasons that are not the wall:
//
// 1. The journey roster partners (+5920, scripts/livetest/roster.ts) live on
//    staging for weeks. Their trials ended on 8 Oct and billing suspended
//    every one for an unpaid weekly fee, correctly. deploy/wall/fixture-fees.sql
//    gives them, ON THE COPY ONLY, the fresh trial a new partner is born with,
//    and gives a store back exactly what a BILLING suspension took. Here the
//    statement runs against the real schema (its triggers included) inside one
//    transaction that is rolled back, and the real gates judge the result.
// 2. AUTH-01 registered its non-Guyana number as "TEST-Uk"; since #1716 a
//    TEST- name on a non-fixture phone is refused (RESERVED_NAME) before the
//    country check, so the journey never reached COUNTRY_NOT_ACTIVE.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'deploy', 'wall', 'fixture-fees.sql'), 'utf8');
const db = new PrismaClient();
const DAY = 86_400_000;
const TENANT = 'swift-default';
class Rollback extends Error {}

afterAll(async () => { await db.$disconnect(); });

async function rolledBack(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await expect(db.$transaction(async (tx) => {
    await fn(tx);
    throw new Rollback('fixture rolled back');
  }, { timeout: 60_000 })).rejects.toBeInstanceOf(Rollback);
}

async function identity(tx: Prisma.TransactionClient, environment: string | null) {
  if (environment === null) {
    await tx.$executeRaw`DELETE FROM deployment_identity WHERE id = 'singleton'`;
    return;
  }
  await tx.$executeRaw`INSERT INTO deployment_identity (id, "deploymentId", environment, "updatedAt")
    VALUES ('singleton', 'journeys-fixture-fees-test', ${environment}, now())
    ON CONFLICT (id) DO UPDATE SET environment = EXCLUDED.environment`;
}

/** Lapsed long ago: what billing leaves on a partner whose trial ended and whose fee went unpaid. */
function suspendedFee() {
  const past = new Date(Date.now() - 8 * DAY);
  return {
    status: 'SUSPENDED' as const, weeklyRate: 6000, billingMethod: 'CASH' as const, currencyCode: 'GYD',
    currentPeriodStart: new Date(past.getTime() - 14 * DAY), currentPeriodEnd: past, nextBillingDate: past,
    trialEndDate: past, isTrialActive: false, suspendedAt: new Date(past.getTime() + 3 * DAY),
    failedAttempts: 3, nextRetryAt: new Date(past.getTime() + 2 * DAY),
  };
}

async function user(tx: Prisma.TransactionClient, phone: string, role: 'MOVER' | 'VENDOR_OWNER') {
  return tx.user.create({ data: { phone, firstName: 'Fixture', lastName: 'Fee', roles: [role, 'CUSTOMER'], activeRole: role, isPhoneVerified: true, tenantId: TENANT } });
}

async function rider(tx: Prisma.TransactionClient, phone: string) {
  const u = await user(tx, phone, 'MOVER');
  const r = await tx.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false } });
  const sub = await tx.subscription.create({ data: { riderId: r.id, type: 'DELIVERY_RIDER', ...suspendedFee() } });
  return { userId: u.id, subId: sub.id };
}

async function driver(tx: Prisma.TransactionClient, phone: string) {
  const u = await user(tx, phone, 'MOVER');
  const d = await tx.driver.create({ data: { userId: u.id, vehicleType: 'CAR' as never, documentsVerified: true, vehicleMake: 'Toyota', vehicleModel: 'Axio',
    vehicleYear: 2018, vehicleColor: 'Silver', licensePlate: `HD ${randomUUID().slice(0, 6)}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins' } });
  const sub = await tx.subscription.create({ data: { driverId: d.id, type: 'TAXI_DRIVER', ...suspendedFee() } });
  return { userId: u.id, subId: sub.id };
}

async function store(tx: Prisma.TransactionClient, phone: string, suspensionSource: string) {
  const u = await user(tx, phone, 'VENDOR_OWNER');
  const owner = await tx.vendorOwner.create({ data: { userId: u.id } });
  const vendor = await tx.vendor.create({ data: { ownerId: owner.id, name: 'Fixture fee store', slug: `fixture-fee-${randomUUID()}`, vendorType: 'RESTAURANT',
    phone, addressLine1: 'Test street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'SUSPENDED', suspensionSource, isVerified: true, acceptingOrders: false } });
  const sub = await tx.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', ...suspendedFee(), weeklyRate: 15000 } });
  return { vendorId: vendor.id, subId: sub.id };
}

/** Money, receipts, ledger, clocks and audit: the reset writes none of them. */
const UNTOUCHED = ['subscription_payments', 'billing_events', 'billing_obligation_transitions', 'billing_dunning_clocks', 'payment_confirmation_holds',
  'fee_receipts', 'receipt_counters', 'ledger_transactions', 'ledger_entries', 'mmg_checkout_intents', 'mmg_agent_payments', 'provider_payments',
  'prepaid_balances', 'card_sessions', 'audit_logs'] as const;

async function moneyCounts(tx: Prisma.TransactionClient) {
  const out: Record<string, number> = {};
  for (const table of UNTOUCHED) {
    const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`);
    out[table] = Number(row!.n);
  }
  return out;
}

const moverOperable = async (tx: Prisma.TransactionClient, userId: string) =>
  (await moverFeeOperability(tx, { userId, tenantId: TENANT }, { missingRow: 'GRANDFATHER' })).operable;

async function storeOperable(tx: Prisma.TransactionClient, subId: string) {
  const now = new Date();
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subId } });
  const pause = await readFeePause(tx);
  const verdict = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' }, pause, now).operable;
  const blockedInSql = await tx.subscription.count({ where: { id: subId, ...inoperableSubscriptionWhere(pause, now) } });
  expect(blockedInSql === 0).toBe(verdict);
  return verdict;
}

const reset = async (tx: Prisma.TransactionClient) => (await tx.$queryRawUnsafe<{ touched: string }[]>(SQL))[0]!.touched;

describe('deploy/wall/fixture-fees.sql on the real schema (rolled back)', () => {
  it('gives the roster partners the fresh trial a new partner is born with, and nothing else', async () => {
    await rolledBack(async (tx) => {
      await identity(tx, 'staging');
      const dr1 = await rider(tx, '+5920403051');
      const t1 = await driver(tx, '+5920403061');
      const r1 = await store(tx, '+5920402011', 'BILLING');
      const r2 = await store(tx, '+5920402012', 'ADMIN');
      const outsider = await rider(tx, '+5920403099');

      // The 16 Oct state: billing refuses all of them.
      expect(await moverOperable(tx, dr1.userId)).toBe(false);
      expect(await moverOperable(tx, t1.userId)).toBe(false);
      expect(await storeOperable(tx, r1.subId)).toBe(false);
      const before = await moneyCounts(tx);
      const startedAt = Date.now();

      // Four roster fees reset; one store reopened (the admin suspension stays).
      expect(await reset(tx)).toBe('4 1');

      expect(await moverOperable(tx, dr1.userId)).toBe(true);
      expect(await moverOperable(tx, t1.userId)).toBe(true);
      expect(await storeOperable(tx, r1.subId)).toBe(true);
      expect(await tx.vendor.findUniqueOrThrow({ where: { id: r1.vendorId }, select: { status: true, suspensionSource: true, acceptingOrders: true } }))
        .toEqual({ status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
      expect(await tx.vendor.findUniqueOrThrow({ where: { id: r2.vendorId }, select: { status: true, suspensionSource: true, acceptingOrders: true } }))
        .toEqual({ status: 'SUSPENDED', suspensionSource: 'ADMIN', acceptingOrders: false });

      // Exactly the birth state (SubscriptionService activation): TRIAL for TRIAL_DAYS, no dunning left.
      for (const subId of [dr1.subId, t1.subId, r1.subId, r2.subId]) {
        const s = await tx.subscription.findUniqueOrThrow({ where: { id: subId } });
        expect(s).toMatchObject({ status: 'TRIAL', isTrialActive: true, isInGracePeriod: false, gracePeriodEnd: null, failedAttempts: 0,
          nextRetryAt: null, suspendedAt: null, billingEnforcementDueAt: null });
        expect(s.trialEndDate!.getTime()).toBe(s.currentPeriodEnd.getTime());
        expect(s.nextBillingDate.getTime()).toBe(s.currentPeriodEnd.getTime());
        const days = (s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()) / DAY;
        expect(days).toBeCloseTo(TRIAL_DAYS, 6);
        expect(s.currentPeriodStart.getTime()).toBeGreaterThan(startedAt - 60_000);
      }

      // Not on the roster: untouched, still refused.
      expect((await tx.subscription.findUniqueOrThrow({ where: { id: outsider.subId } })).status).toBe('SUSPENDED');
      expect(await moverOperable(tx, outsider.userId)).toBe(false);
      // No payment, receipt, ledger, clock or audit row.
      expect(await moneyCounts(tx)).toEqual(before);
    });
  });

  it('refuses by itself on any database that does not say staging', async () => {
    for (const environment of ['production', 'development', null]) {
      await rolledBack(async (tx) => {
        await identity(tx, environment);
        const dr1 = await rider(tx, '+5920403051');
        const r1 = await store(tx, '+5920402011', 'BILLING');
        expect(await reset(tx), String(environment)).toBe('0 0');
        expect((await tx.subscription.findUniqueOrThrow({ where: { id: dr1.subId } })).status).toBe('SUSPENDED');
        expect((await tx.vendor.findUniqueOrThrow({ where: { id: r1.vendorId } })).status).toBe('SUSPENDED');
      });
    }
  });
});

describe('AUTH-01: the non-Guyana registration reaches the country check', () => {
  it('names the non-Guyana number with a name the reserved-name guard lets through', () => {
    const auth = readFileSync(join(ROOT, 'scripts', 'livetest', 'journeys', 'auth.ts'), 'utf8');
    const lines = auth.split('\n');
    const at = lines.findIndex((l) => l.includes("POST('/auth/register', { phone: uk,"));
    expect(at, 'the non-Guyana registration in AUTH-01').toBeGreaterThan(-1);
    // ...and the journey expects the country check to answer it.
    expect(lines[at + 1]).toContain("rec.deny('a non-Guyana number cannot register (even claiming GY)', ukReg, [400], ['COUNTRY_NOT_ACTIVE']);");
    const firstName = /firstName: '([^']*)'/.exec(lines[at]!)?.[1];
    expect(firstName).toBeDefined();
    // UK_FICTIONAL is +447700900xxx (never a +5920 fixture number): a TEST- name is refused for it.
    expect(() => assertNameNotReserved(firstName, '+447700900123')).not.toThrow();
  });
});
