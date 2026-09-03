import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { runFxChangeNotices, scanChargesWithoutDeliveredNotice, fxNoticeKey } from '../modules/billing/fx-notices';
import { FX_NOTICE_WINDOW_DAYS } from '../modules/billing/fx';
import { fxChargesIneligibleCounter } from '../plugins/observability';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [M-14 · S0] The FX notice is a CHARGE GATE, and the evidence follows delivery.
//
// Before: billing charged the run's latest effective rate unconditionally; the
// notice job wrote the "noticed" event first and swallowed a failed send, so
// the database said a payer was told when they were not; and an admin could
// make a >2% rate effective immediately. Now a materially changed amount is
// charged only if the notice for THAT rate was delivered at least the window
// before the invoice — otherwise the payer pays what they were told last time.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_BASE = 592_006_000_000 + Math.floor(Math.random() * 8_000_000);
let app: FastifyInstance;
let billing: BillingService;
let prisma: FastifyInstance['prisma'];
const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
const rateIds: string[] = [];
let seq = 0;

const TENANT = { usdPricingEnabled: true, settlementCurrency: 'GYD', roundingIncrement: 100 };
const BOOK = new Map([['VENDOR|RESTAURANT', 25]]); // US$25 / week
const ctx = (rate: { id: string; rate: number }) => ({ rateId: rate.id, rate: rate.rate, increment: 100, currency: 'GYD', book: BOOK });

async function makeRate(rate: number, effectiveFrom = new Date(Date.now() - DAY)) {
  const row = await prisma.fxRate.create({ data: { quote: 'GYD', rate, source: 'FOUNDER_MANUAL', setByUserId: 'fx-notice-gate-test', effectiveFrom } });
  rateIds.push(row.id);
  return { id: row.id, rate };
}

async function makeSub(due: Date) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Notice', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Notice Vendor ${seq}`, slug: `notice-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${PHONE_BASE + 600_000 + seq}`,
      addressLine1: '14 Notice Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 1_000_000 } },
    },
  });
  subIds.push(sub.id);
  return { subId: sub.id, userId: user.id };
}
/** The payer's history: last charged 5,000 at rate 200 (US$25). */
async function seedLastCharge(subId: string, rate: { id: string; rate: number }, amount = 5000, at = new Date(Date.now() - 7 * DAY)) {
  return prisma.billingEvent.create({
    data: { subscriptionId: subId, type: 'CHARGE_SUCCESS', amount, currencyCode: 'GYD', idempotencyKey: `seed:${subId}:${nanoid(6)}`, amountUsd: 25, fxRateId: rate.id, fxRateUsed: rate.rate, createdAt: at },
  });
}
const load = (subId: string) => prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
async function chargedThisPeriod(subId: string, due: Date) {
  const periodKey = due.toISOString().slice(0, 10);
  const ev = await prisma.billingEvent.findUnique({ where: { idempotencyKey: `success:${subId}:${periodKey}` }, select: { amount: true, fxRateId: true, fxRateUsed: true } });
  return ev ? { amount: Number(ev.amount), fxRateId: ev.fxRateId, fxRateUsed: Number(ev.fxRateUsed) } : null;
}
const counter = async () => (await fxChargesIneligibleCounter.get()).values[0]?.value ?? 0;

async function makeAdmin() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Fx', lastName: `A${seq}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'fxg', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { token, userId: user.id };
}
const post = (url: string, payload: unknown, token: string) =>
  injectWithApproval(app, { method: 'POST', url, payload: payload as Record<string, unknown>, headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), 'content-type': 'application/json', authorization: `Bearer ${token}` } });

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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  prisma = app.prisma;
  billing = new BillingService(prisma, new NotificationService(prisma, app.io), getPaymentProvider());
});

afterEach(() => { vi.restoreAllMocks(); delete process.env['FX_RATE_ACTIVATION_KILL']; });

afterAll(async () => {
  delete process.env['FX_RATE_ACTIVATION_KILL'];
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.fxRate.deleteMany({ where: { OR: [{ id: { in: rateIds } }, { setByUserId: { in: userIds } }, { quote: 'BBD' }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[M-14] the notice is a charge gate', () => {
  it('the register’s red test: a >2% rate effective now, the payer due tomorrow, no delivered notice — the charge holds the rate they were told', async () => {
    const due = new Date(Date.now() + DAY);
    const old = await makeRate(200); const fresh = await makeRate(212); // US$25: 5,000 → 5,300 (+6%)
    const { subId } = await makeSub(due);
    await seedLastCharge(subId, old);
    const before = await counter();
    expect(await billing.billSubscription((await load(subId)) as never, new Date(), ctx(fresh))).toBe('succeeded');
    expect(await chargedThisPeriod(subId, due)).toEqual({ amount: 5000, fxRateId: old.id, fxRateUsed: 200 });
    expect(await counter()).toBe(before + 1);
  });

  it('a notice that exists but was never delivered does not count; one delivered too late does not count; one delivered in time does', async () => {
    const due = new Date(Date.now() + 10 * DAY);
    const old = await makeRate(200); const fresh = await makeRate(212);
    const withNotice = async (deliveredAt: Date | null) => {
      const { subId } = await makeSub(due);
      await seedLastCharge(subId, old);
      await prisma.billingEvent.create({
        data: { subscriptionId: subId, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: fxNoticeKey(subId, fresh.id), amountUsd: 25, fxRateId: fresh.id, fxRateUsed: 212, deliveredAt },
      });
      expect(await billing.billSubscription((await load(subId)) as never, new Date(), ctx(fresh))).toBe('succeeded');
      return chargedThisPeriod(subId, due);
    };
    // The event alone is the obligation, not the proof.
    expect((await withNotice(null))?.amount).toBe(5000);
    // Delivered, but inside the window: not told in time.
    expect((await withNotice(new Date(due.getTime() - 2 * DAY)))?.amount).toBe(5000);
    // Delivered the window before the invoice: the new amount applies.
    expect(await withNotice(new Date(due.getTime() - (FX_NOTICE_WINDOW_DAYS + 1) * DAY))).toEqual({ amount: 5300, fxRateId: fresh.id, fxRateUsed: 212 });
  });

  it('a move within the 2% rule needs no notice; a first charge needs none either', async () => {
    const due = new Date(Date.now() + DAY);
    const old = await makeRate(200); const small = await makeRate(203); // 5,075 → rounds to 5,100: exactly 2%, not more
    const { subId } = await makeSub(due);
    await seedLastCharge(subId, old);
    await billing.billSubscription((await load(subId)) as never, new Date(), ctx(small));
    expect(await chargedThisPeriod(subId, due)).toEqual({ amount: 5100, fxRateId: small.id, fxRateUsed: 203 });
    const first = await makeSub(due);
    const big = await makeRate(300);
    await billing.billSubscription((await load(first.subId)) as never, new Date(), ctx(big));
    expect((await chargedThisPeriod(first.subId, due))?.fxRateId).toBe(big.id);
  });
});

describe('[M-14] the evidence follows delivery', () => {
  it('a failed send leaves the notice undelivered (the gate holds); the next run re-attempts it and only then stamps delivery', async () => {
    const due = new Date(Date.now() + 10 * DAY);
    const old = await makeRate(200); const fresh = await makeRate(212);
    const { subId, userId } = await makeSub(due);
    await seedLastCharge(subId, old);
    const failing = vi.spyOn(NotificationService.prototype, 'send').mockRejectedValue(new Error('notification unavailable'));
    const first = await runFxChangeNotices(prisma, app.io, new Date(), { tenant: TENANT, subscriptionIds: [subId], rateIds: [fresh.id], book: BOOK });
    failing.mockRestore();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    expect(first.delivered).toBe(0);
    expect(first.undelivered).toBeGreaterThanOrEqual(1);
    const event = await prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: fxNoticeKey(subId, fresh.id) } });
    expect(event.deliveredAt).toBeNull();
    expect(await prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'fx_change_notice' } } })).toBe(0);
    // Not told: the gate holds the previous rate.
    await billing.billSubscription((await load(subId)) as never, new Date(), ctx(fresh));
    expect((await chargedThisPeriod(subId, due))?.amount).toBe(5000);
    // The next run delivers what is owed, and only then records it.
    const second = await runFxChangeNotices(prisma, app.io, new Date(), { tenant: TENANT, subscriptionIds: [subId], rateIds: [fresh.id], book: BOOK });
    expect(second.retried).toBeGreaterThanOrEqual(1);
    expect(second.delivered).toBeGreaterThanOrEqual(1);
    expect((await prisma.billingEvent.findUniqueOrThrow({ where: { id: event.id } })).deliveredAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'fx_change_notice' } } })).toBe(1);
    // A third run sends nothing more: one notice per rate, delivered once.
    const third = await runFxChangeNotices(prisma, app.io, new Date(), { tenant: TENANT, subscriptionIds: [subId], rateIds: [fresh.id], book: BOOK });
    expect(third.retried + third.notified).toBe(0);
    expect(await prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'fx_change_notice' } } })).toBe(1);
  });

  it('a rate set to take effect in the future is announced now, ahead of its first invoice', async () => {
    const due = new Date(Date.now() + 10 * DAY);
    const old = await makeRate(200);
    const upcoming = await makeRate(212, new Date(Date.now() + 8 * DAY));
    const { subId, userId } = await makeSub(due);
    await seedLastCharge(subId, old);
    const run = await runFxChangeNotices(prisma, app.io, new Date(), { tenant: TENANT, subscriptionIds: [subId], rateIds: [upcoming.id], book: BOOK });
    expect(run.delivered).toBeGreaterThanOrEqual(1);
    const event = await prisma.billingEvent.findUnique({ where: { idempotencyKey: fxNoticeKey(subId, upcoming.id) } });
    expect(event?.deliveredAt).not.toBeNull();
    const sent = await prisma.notification.findFirst({ where: { userId, data: { path: ['fxRateId'], equals: upcoming.id } } });
    expect(sent?.body).toContain('GY$5,300');
  });
});

describe('[M-14] the admin cannot make a material rate effective inside the window', () => {
  it('>2% without a future effectiveFrom is refused; with the window it is accepted; ≤2% may be immediate; the kill switch holds new rates', async () => {
    const admin = await makeAdmin();
    const inNineDays = new Date(Date.now() + 9 * DAY).toISOString();
    // BBD: a quote no other suite writes, so `previous` is always this test's
    // own row; confirmQuote is always supplied so the fat-finger guard (its own
    // law, proven elsewhere) never decides this test.
    const q = 'BBD';
    const base = 2 + Math.random();
    expect((await post('/api/v1/admin/billing/fx-rates', { quote: q, rate: Number(base.toFixed(4)), effectiveFrom: inNineDays, confirmQuote: q }, admin.token)).statusCode).toBe(200);
    const within = Number((base * 1.01).toFixed(4));
    expect((await post('/api/v1/admin/billing/fx-rates', { quote: q, rate: within, confirmQuote: q }, admin.token)).statusCode).toBe(200); // ≤2%: immediate is fine
    const material = Number((within * 1.1).toFixed(4));
    const refused = await post('/api/v1/admin/billing/fx-rates', { quote: q, rate: material, confirmQuote: q }, admin.token);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('FX_NOTICE_WINDOW');
    expect(refused.json().error.message).toContain(`${FX_NOTICE_WINDOW_DAYS} days`);
    const tooSoon = await post('/api/v1/admin/billing/fx-rates', { quote: q, rate: material, confirmQuote: q, effectiveFrom: new Date(Date.now() + 2 * DAY).toISOString() }, admin.token);
    expect(tooSoon.statusCode).toBe(400);
    expect((await post('/api/v1/admin/billing/fx-rates', { quote: q, rate: material, confirmQuote: q, effectiveFrom: new Date(Date.now() + (FX_NOTICE_WINDOW_DAYS + 1) * DAY).toISOString() }, admin.token)).statusCode).toBe(200);
    process.env['FX_RATE_ACTIVATION_KILL'] = '1';
    const held = await post('/api/v1/admin/billing/fx-rates', { quote: q, rate: Number((material * 1.01).toFixed(4)), confirmQuote: q, effectiveFrom: inNineDays }, admin.token);
    expect(held.statusCode).toBe(503);
    expect(held.json().error.code).toBe('FX_RATE_ACTIVATION_KILLED');
  });
});

describe('[M-14 · operations] charges at a rate the payer was not told about', () => {
  it('are found for a remediation review, and a notice delivered in time clears them', async () => {
    const old = await makeRate(200); const fresh = await makeRate(212);
    const { subId } = await makeSub(new Date(Date.now() + 10 * DAY));
    await seedLastCharge(subId, old, 5000, new Date(Date.now() - 14 * DAY));
    const charge = await seedLastCharge(subId, fresh, 5300, new Date(Date.now() - 7 * DAY));
    let found = await scanChargesWithoutDeliveredNotice(prisma);
    expect(found.find((f) => f.eventId === charge.id)).toMatchObject({ subscriptionId: subId, fxRateId: fresh.id, amount: 5300, previousAmount: 5000 });
    await prisma.billingEvent.create({
      data: { subscriptionId: subId, type: 'REMINDER', currencyCode: 'GYD', idempotencyKey: fxNoticeKey(subId, fresh.id), amountUsd: 25, fxRateId: fresh.id, fxRateUsed: 212, deliveredAt: new Date(charge.createdAt.getTime() - (FX_NOTICE_WINDOW_DAYS + 1) * DAY) },
    });
    found = await scanChargesWithoutDeliveredNotice(prisma);
    expect(found.find((f) => f.eventId === charge.id)).toBeUndefined();
  });
});
