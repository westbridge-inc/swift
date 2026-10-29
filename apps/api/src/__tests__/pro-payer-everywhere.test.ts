import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import {
  PAYER_INCLUDE, SUBSCRIPTION_OWNER_JOINS_SQL, subscriptionOwnerOf, subscriptionOwnerTenant, subscriptionPaidBySql,
  subscriptionsPaidBy, subscriptionTenantInTx, subscriptionTenantSql, subscriptionTenantWhere,
} from '../modules/subscription/subscription-owner';
import {
  lockFeeCollectionAuthority, lockSubscriptionPayer, readFeeCollectionAuthorities, readFeeCollectionAuthority, subscriptionPayer,
} from '../modules/subscription/mover-fee-authority';
import { billingEffectsReady } from '../modules/billing/billing-cutover';
import { BillingService } from '../modules/billing/billing.service';
import { ensureSan, releaseSan, resolveSan } from '../modules/billing/san.service';
import { tenantOfSubscription } from '../modules/notification/notification.service';
import { partnerObligations, windDownPartner } from '../modules/user/partner-wind-down';

// [BILL-PRO PR2] A pro's weekly-fee subscription (schema from PR1) is paid by
// the pro, everywhere money and notices are routed: the one owner module, the
// payer lock (a pro keeps its own identity, like a store, never a mover's
// shared fee), billing notices, the SAN, the tenant scopes, and the erasure
// census and wind-down. Nothing in the app creates such a row yet (PR3, behind
// PRO_WEEKLY_FEE, off); the rows here are written directly. Synthetic data only.

const TENANT = 'swift-default';
const OTHER_TENANT = 'tenant-pro-payer-other';
const PHONE = '+59200575';
const DAY = 86_400_000;
const run = nanoid(7);
let app: FastifyInstance;
const users: string[] = [];
const subs: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-pro-payer-everywhere');
const week = () => ({ status: 'ACTIVE' as const, currencyCode: 'GYD', currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY) });

async function proWithFee() {
  return sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `${PHONE}${Date.now() % 1_000_000}${users.length}`, firstName: 'Pro', lastName: 'Payer', tenantId: TENANT, countryCode: 'GY',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true, selfieCapturedAt: new Date(),
    } });
    users.push(user.id);
    const pro = await app.prisma.serviceProvider.create({ data: { userId: user.id, trade: 'tutor' } });
    const sub = await app.prisma.subscription.create({ data: { serviceProviderId: pro.id, type: 'INDEPENDENT_PRO', weeklyRate: 8000, ...week() } });
    subs.push(sub.id);
    return { userId: user.id, proId: pro.id, subscriptionId: sub.id };
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subs } } });
    await app.prisma.sanTombstone.deleteMany({ where: { subscriptionId: { in: subs } } });
    await cleanupBillingClocks(app.prisma, subs);
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subs } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('a pro pays their own weekly fee (the one owner module)', () => {
  it("the owner is the pro, in the pro user's tenant", async () => {
    const pro = await proWithFee();
    await sys(async () => {
      expect(await subscriptionOwnerOf(app.prisma, pro.subscriptionId))
        .toEqual({ kind: 'PROVIDER', userId: pro.userId, tenantId: TENANT, serviceProviderId: pro.proId, ownerColumns: 1 });
      expect(await subscriptionPayer(app.prisma, pro.subscriptionId)).toEqual({ kind: 'PROVIDER', userId: pro.userId, tenantId: TENANT });
      expect(await subscriptionOwnerTenant(app.prisma, pro.subscriptionId)).toBe(TENANT);
      expect(await app.prisma.$transaction((tx) => subscriptionTenantInTx(tx, pro.subscriptionId))).toBe(TENANT);
      expect(await tenantOfSubscription(app.prisma, pro.subscriptionId, true)).toBe(TENANT);
    });
  });

  it("the paid-by filters, the tenant scope and the SQL fragments find the pro's subscription, and only in its tenant", async () => {
    const pro = await proWithFee();
    await sys(async () => {
      const paid = await app.prisma.subscription.findMany({ where: subscriptionsPaidBy(pro.userId), select: { id: true } });
      expect(paid.map((s) => s.id)).toEqual([pro.subscriptionId]);
      const inTenant = await app.prisma.subscription.count({ where: { id: pro.subscriptionId, ...subscriptionTenantWhere(TENANT) } });
      const elsewhere = await app.prisma.subscription.count({ where: { id: pro.subscriptionId, ...subscriptionTenantWhere(OTHER_TENANT) } });
      expect([inTenant, elsewhere]).toEqual([1, 0]);
      const locked = await app.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s.id FROM subscriptions s ${SUBSCRIPTION_OWNER_JOINS_SQL} WHERE ${subscriptionPaidBySql(pro.userId)}`);
      expect(locked.map((r) => r.id)).toEqual([pro.subscriptionId]);
      const tenant = await app.prisma.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
        SELECT u."tenantId" AS "tenantId" FROM subscriptions s ${subscriptionTenantSql} WHERE s.id = ${pro.subscriptionId}`);
      expect(tenant).toEqual([{ tenantId: TENANT }]);
    });
  });
});

describe('a pro keeps its own identity: locked like a store, never a mover', () => {
  it('the payer lock and the collection authority treat the pro like a store (own clock, no mover fee)', async () => {
    const pro = await proWithFee();
    await sys(async () => {
      const locked = await app.prisma.$transaction(async (tx) => {
        const payer = await lockSubscriptionPayer(tx, pro.subscriptionId);
        const authority = await lockFeeCollectionAuthority(tx, pro.subscriptionId);
        return { payer, authority, ready: await billingEffectsReady(tx) };
      });
      expect(locked.payer).toEqual({ kind: 'PROVIDER', userId: pro.userId, tenantId: TENANT });
      expect(locked.authority).toEqual({ allowed: locked.ready, mover: null });
      expect(await readFeeCollectionAuthority(app.prisma, pro.subscriptionId)).toEqual({ allowed: true, canonical: true, mover: null });
      const many = await readFeeCollectionAuthorities(app.prisma, [pro.subscriptionId]);
      expect(many.get(pro.subscriptionId)).toEqual({ allowed: true, canonical: true, mover: null });
    });
  });
});

describe("billing notices reach the pro, on the pro's own surface", () => {
  it("the billing run's payer and audience are the pro's; a pro row read without its owner is refused, never 'nobody'", async () => {
    const pro = await proWithFee();
    const billing = new BillingService(app.prisma, {} as never, {} as never) as unknown as {
      payerUserId(sub: unknown): string; payerAudience(sub: unknown): string;
    };
    await sys(async () => {
      const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: pro.subscriptionId }, include: PAYER_INCLUDE });
      expect(billing.payerUserId(sub)).toBe(pro.userId);
      expect(billing.payerAudience(sub)).toBe('provider');
      const partial = await app.prisma.subscription.findUniqueOrThrow({ where: { id: pro.subscriptionId }, include: { rider: { select: { userId: true } }, driver: { select: { userId: true } } } });
      expect(() => billing.payerUserId(partial)).toThrow(expect.objectContaining({ code: 'PAYER_NOT_LOADED' }));
    });
  });
});

describe("the pro's Swift account number (SAN)", () => {
  it('resolves to the pro in its own tenant only, and is tombstoned on release', async () => {
    const pro = await proWithFee();
    await sys(async () => {
      const san = await ensureSan(app.prisma, pro.subscriptionId);
      expect(await resolveSan(app.prisma, san, { tenantId: TENANT })).toMatchObject({ ok: true, subscription: { id: pro.subscriptionId } });
      expect(await resolveSan(app.prisma, san, { tenantId: OTHER_TENANT })).toMatchObject({ ok: false, code: 'SAN_UNKNOWN' });
      await releaseSan(app.prisma, pro.subscriptionId, 'test-release');
      expect(await app.prisma.sanTombstone.findUnique({ where: { san } })).toMatchObject({ subscriptionId: pro.subscriptionId, tenantId: TENANT });
      expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: pro.subscriptionId } })).san).toBeNull();
    });
  });
});

describe('erasure: a pro cannot leave with fee money open, and the fee winds down with them', () => {
  it("an open MMG checkout on the pro's fee is counted (deletion is refused until it settles)", async () => {
    const pro = await proWithFee();
    await sys(async () => {
      await app.prisma.mmgCheckoutIntent.create({ data: {
        subscriptionId: pro.subscriptionId, merchantTransactionId: `${String(Date.now()).slice(-13)}${run.replace(/\D/g, '0').slice(0, 5).padStart(5, '0')}`,
        amount: 8000, currencyCode: 'GYD', createdByUserId: pro.userId, platform: 'test',
        checkoutUrlSealed: Buffer.alloc(40), checkoutUrlDek: Buffer.alloc(60), expiresAt: new Date(Date.now() + 600_000),
      } });
      const obligations = await app.prisma.$transaction((tx) => partnerObligations(tx, pro.userId));
      expect(obligations.pendingFeePaymentCount).toBe(1);
    });
  });

  it("wind-down cancels the pro's own weekly fee (no renewal, no retry)", async () => {
    const pro = await proWithFee();
    await sys(async () => {
      await app.prisma.subscription.update({ where: { id: pro.subscriptionId }, data: { nextRetryAt: new Date(Date.now() + DAY) } });
      await windDownPartner(app.prisma, pro.userId);
      expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: pro.subscriptionId }, select: { status: true, autoRenew: true, nextRetryAt: true } }))
        .toEqual({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    });
  });
});
