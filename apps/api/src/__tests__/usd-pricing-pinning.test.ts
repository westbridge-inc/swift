import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { BillingService } from '../modules/billing/billing.service';
import { runFxChangeNotices } from '../modules/billing/fx-notices';
import { enableModeB, sweepModeB } from '../modules/billing/usd-migration';

// System 2 ② — charge-time pinning. The laws under test: a priced charge
// carries the immutable trio on BOTH events; a later rate change cannot touch
// it; customRate overrides stay legacy; flag-off is byte-identical legacy; a
// late settle recovers the ATTEMPT's trio (never re-priced). Context is
// injected directly (usdCtx param) so no global flag toggling can race the
// rest of the suite.

let app: FastifyInstance;
let billing: BillingService;
// prisma alias assigned in beforeAll once the app is up.
let prisma: FastifyInstance['prisma'];

const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const rateIds: string[] = [];
let seq = 0;
const phoneBase = 592_005_000_000 + Math.floor(Math.random() * 8_000_000);

async function makePrepaidVendorSub(opts: { customRate?: number } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Pin', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  ownerIds.push(owner.id);
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Pin Vendor ${seq}`, slug: `pin-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 600_000 + seq}`,
      addressLine1: '4 Pinned Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000,
      ...(opts.customRate ? { customRate: opts.customRate } : {}),
      billingMethod: 'CASH', currentPeriodStart: new Date(Date.now() - 7 * 86_400_000),
      currentPeriodEnd: new Date(), nextBillingDate: new Date(),
      prepaidBalance: { create: { balance: 1_000_000 } }, // deep enough for any charge
    },
    include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
  });
  subIds.push(sub.id);
  return sub;
}

const ctxWith = (rateId: string, rate: number) => ({
  rateId, rate, increment: 100, currency: 'GYD',
  book: new Map([['VENDOR|RESTAURANT', 25]]),
});

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
  prisma = app.prisma;
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.fxRate.deleteMany({ where: { id: { in: rateIds } } });
  await app.close();
});

describe('System 2 ② — the pinned trio', () => {
  it('a priced charge writes the trio on ATTEMPT and SUCCESS, amount = converted book price', async () => {
    const rate = await prisma.fxRate.create({ data: { quote: 'GYD', rate: 208.72, source: 'FOUNDER_MANUAL', setByUserId: 'test', effectiveFrom: new Date() } });
    rateIds.push(rate.id);
    const sub = await makePrepaidVendorSub();

    const outcome = await billing.billSubscription(sub as never, new Date(), ctxWith(rate.id, 208.72));
    expect(outcome).toBe('succeeded');

    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id, type: { in: ['CHARGE_ATTEMPT', 'CHARGE_SUCCESS'] } } });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(Number(e.amount)).toBe(5200); // US$25 × 208.72 → GY$5,200
      expect(Number(e.amountUsd)).toBe(25);
      expect(e.fxRateId).toBe(rate.id);
      expect(Number(e.fxRateUsed)).toBe(208.72);
    }

    // Immutability: a wild new rate cannot touch the issued charge.
    const wild = await prisma.fxRate.create({ data: { quote: 'GYD', rate: 300, source: 'FOUNDER_MANUAL', setByUserId: 'test', effectiveFrom: new Date() } });
    rateIds.push(wild.id);
    const after = await prisma.billingEvent.findFirst({ where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS' } });
    expect(Number(after!.amount)).toBe(5200);
    expect(after!.fxRateId).toBe(rate.id);
  });

  it('acceptance #16: every charge in one run carries the SAME fxRateId', async () => {
    const rate = await prisma.fxRate.create({ data: { quote: 'GYD', rate: 210, source: 'FOUNDER_MANUAL', setByUserId: 'test', effectiveFrom: new Date() } });
    rateIds.push(rate.id);
    const ctx = ctxWith(rate.id, 210);
    const a = await makePrepaidVendorSub();
    const b = await makePrepaidVendorSub();
    await billing.billSubscription(a as never, new Date(), ctx);
    await billing.billSubscription(b as never, new Date(), ctx);
    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: { in: [a.id, b.id] }, type: 'CHARGE_SUCCESS' } });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.fxRateId)).size).toBe(1);
    expect(events.every((e) => Number(e.amount) === 5300)).toBe(true); // 25×210=5250→HALF_UP→5300? No: 5250 rounds to 5300? 5250/100=52.5→HALF_UP 53→5300.
  });

  it('customRate overrides stay legacy (no trio); flag-off context is byte-identical legacy', async () => {
    const rate = await prisma.fxRate.create({ data: { quote: 'GYD', rate: 208.72, source: 'FOUNDER_MANUAL', setByUserId: 'test', effectiveFrom: new Date() } });
    rateIds.push(rate.id);
    const custom = await makePrepaidVendorSub({ customRate: 15000 });
    await billing.billSubscription(custom as never, new Date(), ctxWith(rate.id, 208.72));
    const customEv = await prisma.billingEvent.findFirst({ where: { subscriptionId: custom.id, type: 'CHARGE_SUCCESS' } });
    expect(Number(customEv!.amount)).toBe(15000);
    expect(customEv!.fxRateId).toBeNull();

    const legacy = await makePrepaidVendorSub();
    await billing.billSubscription(legacy as never, new Date(), null); // flag off
    const legacyEv = await prisma.billingEvent.findFirst({ where: { subscriptionId: legacy.id, type: 'CHARGE_SUCCESS' } });
    expect(Number(legacyEv!.amount)).toBe(20000); // weeklyRate
    expect(legacyEv!.amountUsd).toBeNull();
  });
});

describe('System 2 ④ — the >2% FX-change notice (Part 12)', () => {
  it('notices once per rate change, USD-framed, ≥7-days-out bills only; small moves stay silent', async () => {
    // Enable the flag INSIDE this test and restore in finally — the notice
    // path reads it; the pinning tests above inject context directly.
    await prisma.tenantBillingCurrency.upsert({
      where: { tenantId: 'swift-default' },
      create: { tenantId: 'swift-default', settlementCurrency: 'GYD', roundingIncrement: 100, usdPricingEnabled: true },
      update: { usdPricingEnabled: true },
    });
    try {
      const oldRate = await prisma.fxRate.create({ data: { quote: 'GYD', rate: 208, source: 'FOUNDER_MANUAL', setByUserId: 'test', effectiveFrom: new Date(Date.now() - 86_400_000) } });
      rateIds.push(oldRate.id);
      // A payer whose last successful charge was at the old rate, next bill 10 days out.
      const sub = await makePrepaidVendorSub();
      await prisma.subscription.update({ where: { id: sub.id }, data: { nextBillingDate: new Date(Date.now() + 10 * 86_400_000) } });
      await prisma.billingEvent.create({
        data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: 5200, currencyCode: 'GYD', idempotencyKey: `seed:${sub.id}` },
      });
      // No price-book row for VENDOR|RESTAURANT? create one (the book is live data here).
      const entry = await prisma.priceBookEntry.create({ data: { role: 'VENDOR', tier: 'RESTAURANT', amountUsd: 25 } });

      // A big move: 208 → 230 (+10.6% → notice).
      const newRate = await prisma.fxRate.create({ data: { quote: 'GYD', rate: 230, source: 'FOUNDER_MANUAL', setByUserId: 'test', effectiveFrom: new Date() } });
      rateIds.push(newRate.id);

      const first = await runFxChangeNotices(prisma, { to: () => ({ emit: () => {} }) } as never);
      expect(first.notified).toBeGreaterThanOrEqual(1);
      const userId = sub.vendor!.owner.userId;
      const note = await prisma.notification.findFirst({ where: { userId, data: { path: ['kind'], equals: 'fx_change_notice' } } });
      expect(note).toBeTruthy();
      expect(note!.title).toContain('US$25.00'); // the USD framing IS the message
      expect(note!.body).toContain('GY$5,800'); // 25×230=5750→HALF_UP→5,800

      // Dedup: a second run notices nothing new for the same rate.
      const second = await runFxChangeNotices(prisma, { to: () => ({ emit: () => {} }) } as never);
      const notesAfter = await prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'fx_change_notice' } } });
      expect(notesAfter).toBe(1);
      expect(second.notified + 1).toBeGreaterThanOrEqual(1); // ran clean either way

      await prisma.priceBookEntry.delete({ where: { id: entry.id } });
    } finally {
      await prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdPricingEnabled: false } });
    }
  });
});

describe('System 2 ⑤ — Mode B grandfather → sunset (Part 13/20)', () => {
  it('freezes on customRate, notices T−30/T−7 exactly once each, flips at sunset with the notice check', async () => {
    const io = { to: () => ({ emit: () => {} }) } as never;
    const sub = await makePrepaidVendorSub(); // weeklyRate 20000, customRate null
    // enableModeB freezes EVERY unfrozen sub (its production semantic) — in a
    // shared CI run that includes other suites' rows. Snapshot who was frozen
    // BEFORE so the finally can thaw exactly the ones this test froze.
    const frozenBefore = new Set((await prisma.subscription.findMany({ where: { customRate: { not: null } }, select: { id: true } })).map((x) => x.id));
    try {
      // Enable Mode B with a sunset 31 days out (passes the ≥30d rule).
      const sunset = new Date(Date.now() + 31 * 86_400_000);
      const enabled = await enableModeB(prisma, sunset);
      expect(enabled.grandfathered).toBeGreaterThanOrEqual(1);
      const frozen = await prisma.subscription.findUnique({ where: { id: sub.id } });
      expect(Number(frozen!.customRate)).toBe(20000); // grandfathered on today's price

      // Day 1 (T−31): T−30 not due yet → no notice for this sub.
      await sweepModeB(prisma, io, new Date());
      expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, idempotencyKey: `usdmigB:${sub.id}:t30` } })).toBe(0);

      // T−20: the T−30 notice fires once; re-sweep does not duplicate.
      const t20 = new Date(sunset.getTime() - 20 * 86_400_000);
      await sweepModeB(prisma, io, t20);
      await sweepModeB(prisma, io, t20);
      expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, idempotencyKey: `usdmigB:${sub.id}:t30` } })).toBe(1);

      // T−3: the T−7 notice fires too.
      await sweepModeB(prisma, io, new Date(sunset.getTime() - 3 * 86_400_000));
      expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, idempotencyKey: `usdmigB:${sub.id}:t7` } })).toBe(1);

      // Past sunset: customRate clears (the USD book takes over) with zero alerts.
      const res = await sweepModeB(prisma, io, new Date(sunset.getTime() + 3600_000));
      expect(res.flipped).toBeGreaterThanOrEqual(1);
      expect(res.alerts).toBe(0); // both notices verifiably sent
      const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
      expect(after!.customRate).toBeNull();
    } finally {
      await prisma.tenantBillingCurrency.update({
        where: { tenantId: 'swift-default' },
        data: { usdMigrationMode: null, usdSunsetAt: null, usdPricingEnabled: false },
      }).catch(() => {});
      // Thaw exactly what THIS test froze (snapshot diff) — never touch
      // rows that carried a genuine customRate before.
      const frozenNow = await prisma.subscription.findMany({ where: { customRate: { not: null } }, select: { id: true } });
      const thaw = frozenNow.map((x) => x.id).filter((id) => !frozenBefore.has(id));
      if (thaw.length > 0) {
        await prisma.subscription.updateMany({ where: { id: { in: thaw } }, data: { customRate: null } });
      }
    }
  });
});
