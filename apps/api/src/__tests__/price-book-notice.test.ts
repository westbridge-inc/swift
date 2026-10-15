import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { BillingService } from '../modules/billing/billing.service';
import { announcePriceBookEntry } from '../modules/billing/fx-notices';
import { PRICE_BOOK_NOTICE_DAYS, activePriceBook, bookAt, earliestPriceChange, priceBookNoticeKey, type PriceBookRow } from '../modules/billing/price-book';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [Owner legal plan 15 Oct · F2 · GUARDRAILS §7 standing rule] A USD
// price-book price never changes at once: it takes effect no sooner than 14
// days after it is set; every partner it changes is told when it is set; a
// week is priced by the book in force when that week starts (a paid or owed
// week keeps its price); and a week takes the new price only if the partner
// was told 14 days before it starts. Before, PUT /billing/price-book replaced
// the price at once and the next charge used it, notice or not.
// The route itself is pinned in usd-pricing.test.ts; this file pins the book,
// the charge and the notices.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const entryIds: string[] = [];
let seq = 0;
const phoneBase = 592_006_000_000 + Math.floor(Math.random() * 8_000_000);
const TIER = 'RESTAURANT';

async function vendorSub(nextBillingDate: Date) {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Book', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  ownerIds.push(owner.id);
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Book Vendor ${seq}`, slug: `book-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 600_000 + seq}`,
    addressLine1: '5 Notice Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
  } });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000, billingMethod: 'CASH',
    currentPeriodStart: new Date(nextBillingDate.getTime() - 7 * DAY), currentPeriodEnd: nextBillingDate, nextBillingDate,
  } });
  subIds.push(sub.id);
  // A week was charged before (yesterday): a change since then needs its notice.
  await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: 5000, currencyCode: 'GYD', idempotencyKey: `book-test:${sub.id}`, createdAt: new Date(Date.now() - DAY) } });
  return app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
}

const row = (amountUsd: number, effectiveFrom: Date, id = nanoid(6)): PriceBookRow => ({ id, role: 'VENDOR', tier: TIER, amountUsd, effectiveFrom });
const ctx = (rows: PriceBookRow[]) => ({ rateId: 'fx-test', rate: 200, increment: 1, currency: 'GYD', book: bookAt(rows, new Date()), rows });
const price = (sub: unknown, rows: PriceBookRow[]) => (billing as unknown as { priceEligibleFor: (s: unknown, u: unknown) => Promise<{ amount: number; usdTrio?: { amountUsd: number } }> }).priceEligibleFor(sub, ctx(rows));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds).catch(() => {});
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => {});
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await app.prisma.priceBookEntry.deleteMany({ where: { id: { in: entryIds } } }).catch(() => {});
  await app.close();
});

describe('[F2] the book in force', () => {
  it('a scheduled price is not in force before its date; the old one stays until then', () => {
    const now = new Date();
    const rows = [row(25, new Date(now.getTime() - 30 * DAY)), row(30, new Date(now.getTime() + 15 * DAY))];
    expect(bookAt(rows, now).get(`VENDOR|${TIER}`)).toBe(25);
    expect(bookAt(rows, new Date(now.getTime() + 16 * DAY)).get(`VENDOR|${TIER}`)).toBe(30);
    expect(earliestPriceChange(now).getTime() - now.getTime()).toBe(PRICE_BOOK_NOTICE_DAYS * DAY);
  });
});

describe('[F2] a week is priced by the book in force when it starts, and only after a 14-day notice', () => {
  const now = new Date();
  const old = row(25, new Date(now.getTime() - 30 * DAY), 'old-row');
  const effective = new Date(now.getTime() + 15 * DAY);
  const next = row(30, effective, 'new-row');

  it('a week that starts before the new price keeps the old price, even when it is billed after it', async () => {
    const sub = await vendorSub(new Date(effective.getTime() - 2 * DAY));
    const priced = await price({ ...sub }, [old, next]);
    expect(priced.usdTrio?.amountUsd).toBe(25);
    expect(priced.amount).toBe(5000);
  });

  it('a week that starts after it takes the new price once the partner was told 14 days before that week', async () => {
    const sub = await vendorSub(new Date(effective.getTime() + DAY));
    await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: priceBookNoticeKey(sub.id, next.id), deliveredAt: now } });
    const priced = await price({ ...sub }, [old, next]);
    expect(priced.usdTrio?.amountUsd).toBe(30);
    expect(priced.amount).toBe(6000);
  });

  it('[coordinator ruling 15 Oct] a LOWER price applies from the next week without waiting for a notice', async () => {
    const lowerRow = row(20, new Date(now.getTime() + DAY), 'lower-row');
    const sub = await vendorSub(new Date(now.getTime() + 2 * DAY));
    const priced = await price({ ...sub }, [old, lowerRow]);
    expect(priced.usdTrio?.amountUsd).toBe(20);
    expect(priced.amount).toBe(4000);
  });

  it('not told (or told too late): that week keeps the price before it', async () => {
    const untold = await vendorSub(new Date(effective.getTime() + DAY));
    expect((await price({ ...untold }, [old, next])).usdTrio?.amountUsd).toBe(25);
    const late = await vendorSub(new Date(effective.getTime() + DAY));
    await app.prisma.billingEvent.create({ data: { subscriptionId: late.id, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: priceBookNoticeKey(late.id, next.id), deliveredAt: new Date(effective.getTime() - 5 * DAY) } });
    expect((await price({ ...late }, [old, next])).usdTrio?.amountUsd).toBe(25);
  });

  // [REVIEW-G #1769 S2-1] The gate used to run only for a row newer than the
  // last charge: once week 1 was charged (the old price, after the change took
  // effect), week 2 skipped it and charged the new price with no notice.
  const chargedAt = (subscriptionId: string, amountUsd: number, createdAt: Date) => app.prisma.billingEvent.create({ data: {
    subscriptionId, type: 'CHARGE_SUCCESS', amount: amountUsd * 200, currencyCode: 'GYD', amountUsd, fxRateId: 'fx-test', fxRateUsed: 200,
    idempotencyKey: `book-test:${subscriptionId}:${createdAt.getTime()}`, createdAt,
  } });

  it('[S2-1] not told: week 2 keeps the old price too; the new price starts with the first week 14 days after the notice reaches them, then stays', async () => {
    const weekOne = new Date(effective.getTime() + DAY);
    const weekTwo = new Date(weekOne.getTime() + 7 * DAY);
    const sub = await vendorSub(weekOne);
    expect((await price({ ...sub }, [old, next])).usdTrio?.amountUsd).toBe(25);
    await chargedAt(sub.id, 25, new Date(weekOne.getTime() + 60_000)); // week 1 charged the old price, after the change
    const atWeekTwo = { ...sub, nextBillingDate: weekTwo };
    expect(await price(atWeekTwo, [old, next])).toMatchObject({ amount: 5000, usdTrio: { amountUsd: 25 } });
    // Told late (3 days before week 2): week 2 still keeps the old price ...
    await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: priceBookNoticeKey(sub.id, next.id), deliveredAt: new Date(weekTwo.getTime() - 3 * DAY) } });
    expect((await price(atWeekTwo, [old, next])).usdTrio?.amountUsd).toBe(25);
    expect((await price({ ...sub, nextBillingDate: new Date(weekTwo.getTime() + 7 * DAY) }, [old, next])).usdTrio?.amountUsd).toBe(25);
    // ... and the first week starting 14 days after the notice takes the new one.
    const weekFour = new Date(weekTwo.getTime() + 14 * DAY);
    expect(await price({ ...sub, nextBillingDate: weekFour }, [old, next])).toMatchObject({ amount: 6000, usdTrio: { amountUsd: 30 } });
    await chargedAt(sub.id, 30, new Date(weekFour.getTime() + 60_000));
    expect((await price({ ...sub, nextBillingDate: new Date(weekFour.getTime() + 7 * DAY) }, [old, next])).usdTrio?.amountUsd).toBe(30);
  });

  it('[S2-1 · ruling 15 Oct] a rise is measured against the price last paid: an untold 27 after an untold 30 keeps 25; a cut below it applies at once', async () => {
    const after = new Date(effective.getTime() + 10 * DAY);
    const toTwentySeven = row(27, after, 'rise-27');
    const toTwentyTwo = row(22, after, 'cut-22');
    const sub = await vendorSub(new Date(effective.getTime() + DAY));
    await chargedAt(sub.id, 25, new Date(effective.getTime() + DAY + 60_000));
    const later = { ...sub, nextBillingDate: new Date(after.getTime() + DAY) };
    expect((await price(later, [old, next, toTwentySeven])).usdTrio?.amountUsd).toBe(25);
    expect(await price(later, [old, next, toTwentyTwo])).toMatchObject({ amount: 4400, usdTrio: { amountUsd: 22 } });
  });
});

describe('[F2] every partner a scheduled price changes is told when it is set', () => {
  it('one inbox notice per partner with the amount and the first weekly fee it applies to; none while USD pricing is off', async () => {
    const now = new Date();
    const sub = await vendorSub(new Date(now.getTime() + 3 * DAY));
    const entry = await app.prisma.priceBookEntry.create({ data: { role: 'VENDOR', tier: TIER, amountUsd: 31, effectiveFrom: new Date(now.getTime() + 15 * DAY) } });
    entryIds.push(entry.id);
    const tenant = await app.prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
    // Off: no fee comes from the book, nobody is told.
    if (tenant) await app.prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdPricingEnabled: false } });
    expect(await announcePriceBookEntry(app.prisma, app.io, entry.id, now)).toEqual({ notified: 0, delivered: 0 });
    if (!tenant) return; // no tenant billing row in this database: the "on" half needs one
    try {
      await app.prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdPricingEnabled: true } });
      const out = await announcePriceBookEntry(app.prisma, app.io, entry.id, now);
      expect(out.delivered).toBeGreaterThanOrEqual(1);
      const event = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: priceBookNoticeKey(sub.id, entry.id) } });
      expect(event.deliveredAt).not.toBeNull();
      const notices = await app.prisma.notification.findMany({ where: { userId: userIds[userIds.length - 1], data: { path: ['kind'], equals: 'billing_rate_change' } } });
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).toContain('US$31.00');
      // The first weekly fee on or after both its date and 14 days from now: due+14d (17 days out).
      expect(notices[0]!.data).toMatchObject({ change: 'PRICE_BOOK', priceBookEntryId: entry.id, appliesFrom: new Date(sub.nextBillingDate.getTime() + 14 * DAY).toISOString() });
      // Told once: a second run tells nobody again.
      await announcePriceBookEntry(app.prisma, app.io, entry.id, now);
      expect(await app.prisma.notification.count({ where: { userId: userIds[userIds.length - 1], data: { path: ['kind'], equals: 'billing_rate_change' } } })).toBe(1);
    } finally {
      await app.prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdPricingEnabled: tenant.usdPricingEnabled } });
    }
    expect((await activePriceBook(app.prisma)).some((r) => r.id === entry.id)).toBe(true);
  });

  it('[REVIEW-G S2-1] once a higher price is in force, a notice not yet delivered is still retried (dated 14 days on); nobody else is told', async () => {
    const now = new Date();
    const prior = await app.prisma.priceBookEntry.create({ data: { role: 'VENDOR', tier: TIER, amountUsd: 24, effectiveFrom: new Date(now.getTime() - 60 * DAY) } });
    const entry = await app.prisma.priceBookEntry.create({ data: { role: 'VENDOR', tier: TIER, amountUsd: 34, effectiveFrom: new Date(now.getTime() - 2 * DAY) } });
    entryIds.push(prior.id, entry.id);
    const pending = await vendorSub(new Date(now.getTime() + 3 * DAY));
    const pendingUser = userIds[userIds.length - 1]!;
    await app.prisma.billingEvent.create({ data: { subscriptionId: pending.id, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: priceBookNoticeKey(pending.id, entry.id), amountUsd: 34 } });
    const other = await vendorSub(new Date(now.getTime() + 3 * DAY));
    const tenant = await app.prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
    if (!tenant) return; // no tenant billing row in this database
    try {
      await app.prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdPricingEnabled: true } });
      await announcePriceBookEntry(app.prisma, app.io, entry.id, now);
      const event = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: priceBookNoticeKey(pending.id, entry.id) } });
      expect(event.deliveredAt).not.toBeNull();
      const notices = await app.prisma.notification.findMany({ where: { userId: pendingUser, data: { path: ['kind'], equals: 'billing_rate_change' } } });
      expect(notices).toHaveLength(1);
      expect(notices[0]!.data).toMatchObject({ priceBookEntryId: entry.id, appliesFrom: new Date(pending.nextBillingDate.getTime() + 14 * DAY).toISOString() });
      expect(await app.prisma.billingEvent.findUnique({ where: { idempotencyKey: priceBookNoticeKey(other.id, entry.id) } })).toBeNull();
    } finally {
      await app.prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdPricingEnabled: tenant.usdPricingEnabled } });
    }
  });
});
