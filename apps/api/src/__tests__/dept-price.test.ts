import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, VendorType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { amountDueNow } from '../modules/billing/amount-due';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [DEPT-PRICE · owner 29 Oct 2026 ~22:31Z] Against the real database:
//  - a NEW department-store signup (its own catalogue at the department size
//    when Swift approves it) is born on a 7-day trial; every other store keeps
//    14 days; a store that signed up before the ruling keeps its 14 days; a
//    trial already running is never touched;
//  - a store billed above the card's department fee (the old 60,000) moves
//    down to it from its NEXT weekly fee: a TIER_CHANGE billing event, an
//    audit row, the "going down" notice; a charge already issued keeps its
//    amount; a payment in flight leaves it alone until it settles; nothing
//    else on the card moves.
// Phones come from testPhone() (unique per run), so a run cut short never collides with the next one.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let billing: BillingService;
let subscriptions: SubscriptionService;
let cardTop = 0;
let deptFloor = 0;

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

async function makeStore(opts: { vendorType?: VendorType; createdAt?: Date } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Dept', lastName: `Price${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Dept Price Store ${seq}`, slug: `dept-price-${seq}-${nanoid(5).toLowerCase()}`,
      vendorType: opts.vendorType ?? 'SUPERMARKET', phone: testPhone(), addressLine1: '1 Regent Street', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16, status: 'PENDING_APPROVAL',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  vendorIds.push(vendor.id);
  return { vendorId: vendor.id, userId: user.id };
}

/** Another store (a branch) of the same owner. */
async function makeBranch(userId: string) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Dept Price Branch ${seq}`, slug: `dept-price-b${seq}-${nanoid(5).toLowerCase()}`,
      vendorType: 'SUPERMARKET', phone: testPhone(), addressLine1: '2 Regent Street', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16, status: 'PENDING_APPROVAL',
    },
  });
  vendorIds.push(vendor.id);
  return vendor.id;
}

/** `n` listings on the store, in one statement. */
async function addItems(vendorId: string, n: number, opts: { available?: boolean; updatedAt?: Date } = {}) {
  const category = await app.prisma.category.create({ data: { vendorId, name: `Aisle ${wordFreeTag(4)}`, sortOrder: 0 } });
  await app.prisma.$executeRaw`
    INSERT INTO "items" ("id", "vendorId", "categoryId", "tenantId", "name", "basePrice", "isAvailable", "updatedAt", "createdAt")
    SELECT 'dp-' || ${category.id} || '-' || g, ${vendorId}, ${category.id}, 'swift-default', 'Item ' || g, 100, ${opts.available ?? true},
           ${opts.updatedAt ?? new Date()}, now()
    FROM generate_series(1, ${n}) AS g`;
}

async function approve(vendorId: string) {
  const sub = await subscriptions.startTrialForVendor(vendorId);
  subIds.push(sub.id);
  return app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
}

const daysOf = (sub: { currentPeriodStart: Date; trialEndDate: Date | null }) =>
  Math.round(((sub.trialEndDate?.getTime() ?? 0) - sub.currentPeriodStart.getTime()) / DAY);

/** A store already billed at `rate` a week: ACTIVE, its next weekly fee due in `dueIn`. */
async function billedStore(rate: number, opts: { vendorType?: VendorType; dueIn?: number; customRate?: number } = {}) {
  const { vendorId, userId } = await makeStore({ vendorType: opts.vendorType });
  const now = new Date();
  const next = new Date(now.getTime() + (opts.dueIn ?? 3 * DAY));
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId, type: 'SUPERMARKET', weeklyRate: rate, currencyCode: 'GYD', billingMethod: 'CASH', status: 'ACTIVE', isTrialActive: false,
      currentPeriodStart: new Date(next.getTime() - 7 * DAY), currentPeriodEnd: next, nextBillingDate: next, trialEndDate: new Date(now.getTime() - 30 * DAY),
      ...(opts.customRate !== undefined ? { customRate: opts.customRate } : {}),
    },
  });
  subIds.push(sub.id);
  return { subId: sub.id, vendorId, userId };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  subscriptions = new SubscriptionService(app.prisma);
  const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
  const tiers = gy.subscriptionTiers as Record<string, number>;
  cardTop = tiers['departmentVendor']!;
  deptFloor = tiers['departmentCatalogueThreshold']!;
});

// Cleanup removes some 80,000 listings (eight department-size catalogues): give it room on a busy machine.
afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.platformConfig.deleteMany({ where: { OR: subIds.map((id) => ({ key: { endsWith: id } })) } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
}, 300_000);

describe('the seeded card', () => {
  it('prices the department tier at 45,000 from 10,000 active items', () => {
    expect(cardTop).toBe(45000);
    expect(deptFloor).toBe(10000);
  });
});

describe('trial length at approval — department stores 7 days (new signups), everyone else 14', () => {
  it('a store with a department-size catalogue when Swift approves it is born on a 7-day trial, its trial grant ending the same day', async () => {
    const { vendorId, userId } = await makeStore();
    await addItems(vendorId, deptFloor);
    const sub = await approve(vendorId);
    expect(sub.status).toBe('TRIAL');
    expect(daysOf(sub)).toBe(7);
    expect(sub.nextBillingDate.getTime()).toBe(sub.trialEndDate!.getTime());
    // The price it is born on is unchanged: the signup quote (the first step), never the department fee.
    expect(Number(sub.weeklyRate)).toBe(15000);
    const grant = await app.prisma.trialGrant.findFirstOrThrow({ where: { accountId: userId } });
    // The grant is stamped by the trial law a moment later in the same transaction: the same end, to the second.
    expect(Math.abs(grant.endsAt.getTime() - sub.trialEndDate!.getTime())).toBeLessThan(1000);
  });

  it('one listing short of the department size is a 14-day trial', async () => {
    const { vendorId } = await makeStore();
    await addItems(vendorId, deptFloor - 1);
    expect(daysOf(await approve(vendorId))).toBe(14);
  });

  it('hiding listings just before approval does not count them out: one available or edited in the last 7 days counts', async () => {
    const { vendorId } = await makeStore();
    await addItems(vendorId, deptFloor - 10);
    await addItems(vendorId, 10, { available: false, updatedAt: new Date(Date.now() - HOUR) });
    expect(daysOf(await approve(vendorId))).toBe(7);
  });

  it('a listing hidden more than 7 days ago does not count', async () => {
    const { vendorId } = await makeStore();
    await addItems(vendorId, deptFloor - 10);
    await addItems(vendorId, 10, { available: false, updatedAt: new Date(Date.now() - 8 * DAY) });
    expect(daysOf(await approve(vendorId))).toBe(14);
  });

  it('a department-size store that signed up BEFORE the ruling keeps the 14 days it was offered', async () => {
    const { vendorId } = await makeStore({ createdAt: new Date('2026-10-29T22:30:00.000Z') });
    await addItems(vendorId, deptFloor);
    expect(daysOf(await approve(vendorId))).toBe(14);
  });

  it('a small store and a service business keep 14 days', async () => {
    const small = await makeStore({ vendorType: 'RESTAURANT' });
    await addItems(small.vendorId, 5);
    expect(daysOf(await approve(small.vendorId))).toBe(14);
    const service = await makeStore({ vendorType: 'SERVICE' });
    expect(daysOf(await approve(service.vendorId))).toBe(14);
  });

  it('a trial already running is never touched: not by a catalogue growing, not by billing', async () => {
    const { vendorId } = await makeStore();
    const sub = await approve(vendorId);
    expect(daysOf(sub)).toBe(14);
    await addItems(vendorId, deptFloor);
    await billing.applyCardPriceCuts(new Date());
    expect(await approve(vendorId)).toMatchObject({ id: sub.id, trialEndDate: sub.trialEndDate, status: 'TRIAL' });
  });
});

describe('chains: a branch shares its owner\'s running trial (end day), whatever its own size', () => {
  it('a department-size owner\'s 7-day trial: a small branch added during it ends the same day, never 14 days out', async () => {
    const { vendorId, userId } = await makeStore();
    await addItems(vendorId, deptFloor);
    const first = await approve(vendorId);
    expect(daysOf(first)).toBe(7);
    const branch = await approve(await makeBranch(userId));
    expect(branch.status).toBe('TRIAL');
    expect(branch.trialEndDate!.getTime()).toBe(first.trialEndDate!.getTime());
  });

  it('a small owner\'s 14-day trial: a department-size branch added during it shares the owner\'s end day, never cut to 7', async () => {
    const { vendorId, userId } = await makeStore();
    const first = await approve(vendorId);
    expect(daysOf(first)).toBe(14);
    const branchId = await makeBranch(userId);
    await addItems(branchId, deptFloor);
    const branch = await approve(branchId);
    expect(branch.status).toBe('TRIAL');
    expect(branch.trialEndDate!.getTime()).toBe(first.trialEndDate!.getTime());
  });
});

describe('existing department-tier subscriptions move down to 45,000 from their next weekly fee', () => {
  it('a store billed 60,000 a week moves to the card\'s 45,000: TIER_CHANGE event, audit row, notice; a re-run changes nothing', async () => {
    const s = await billedStore(60000);
    const now = new Date();
    const moved = await billing.applyCardPriceCuts(now);
    expect(moved).toBeGreaterThanOrEqual(1);
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } });
    expect(Number(sub.weeklyRate)).toBe(45000);
    const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId: s.subId, type: 'TIER_CHANGE' } });
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.amount)).toBe(45000);
    expect(events[0]!.note).toMatch(/60000 -> 45000/);
    expect(await app.prisma.auditLog.count({ where: { action: 'BILLING_CARD_PRICE_CUT', entityId: s.subId } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: s.userId, title: 'Your weekly fee is going down' } })).toBe(1);
    // The period already running keeps its dates: the lower fee is the NEXT weekly fee.
    expect(sub.nextBillingDate.getTime()).toBeGreaterThan(now.getTime());
    await billing.applyCardPriceCuts(new Date());
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'TIER_CHANGE' } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: s.userId, title: 'Your weekly fee is going down' } })).toBe(1);
  });

  it('a weekly fee already charged keeps its amount: the issued 60,000 request is still what is due', async () => {
    const s = await billedStore(60000, { dueIn: -HOUR });
    const sub0 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } });
    await app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: s.subId, amount: 60000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
      periodStart: sub0.nextBillingDate, periodEnd: new Date(sub0.nextBillingDate.getTime() + 7 * DAY),
    } });
    await billing.applyCardPriceCuts(new Date());
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } });
    expect(Number(sub.weeklyRate)).toBe(45000);
    expect(await amountDueNow(app.prisma, sub)).toBe(60000);
  });

  it('a payment in flight (an open MMG checkout) leaves the fee alone; once it settles, the next pass moves it', async () => {
    const s = await billedStore(60000);
    const intent = await app.prisma.mmgCheckoutIntent.create({ data: {
      subscriptionId: s.subId, merchantTransactionId: String(Date.now()).padStart(18, '9').slice(0, 18), amount: 60000, currencyCode: 'GYD',
      createdByUserId: s.userId, platform: 'ios', checkoutUrlSealed: Buffer.alloc(40), checkoutUrlDek: Buffer.alloc(40),
      expiresAt: new Date(Date.now() + HOUR),
    } });
    await billing.applyCardPriceCuts(new Date());
    expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).weeklyRate)).toBe(60000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'TIER_CHANGE' } })).toBe(0);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: intent.id }, data: { status: 'EXPIRED' } });
    await billing.applyCardPriceCuts(new Date());
    expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).weeklyRate)).toBe(45000);
  });

  it('a negotiated rate is kept as agreed; only the tier rate under it moves (a chain deal stays min(deal, tier))', async () => {
    const s = await billedStore(60000, { customRate: 50000 });
    await billing.applyCardPriceCuts(new Date());
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } });
    expect(Number(sub.weeklyRate)).toBe(45000);
    expect(Number(sub.customRate)).toBe(50000);
  });

  it('nothing else on the card moves: small and large stores, a store already at 45,000, a service business', async () => {
    const small = await billedStore(15000);
    const large = await billedStore(20000);
    const atTop = await billedStore(45000);
    const service = await billedStore(60000, { vendorType: 'SERVICE' });
    await billing.applyCardPriceCuts(new Date());
    const rates = await app.prisma.subscription.findMany({ where: { id: { in: [small.subId, large.subId, atTop.subId, service.subId] } }, select: { id: true, weeklyRate: true } });
    const by = Object.fromEntries(rates.map((r) => [r.id, Number(r.weeklyRate)]));
    expect([by[small.subId], by[large.subId], by[atTop.subId], by[service.subId]]).toEqual([15000, 20000, 45000, 60000]);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: { in: [small.subId, large.subId, atTop.subId, service.subId] }, type: 'TIER_CHANGE' } })).toBe(0);
    expect(await app.prisma.auditLog.count({ where: { action: 'BILLING_CARD_PRICE_CUT', entityId: { in: [small.subId, large.subId, atTop.subId, service.subId] } } })).toBe(0);
  });

  it('runs at the start of the hourly billing cycle, before anything due is priced', async () => {
    const s = await billedStore(60000);
    await billing.runBillingCycle();
    expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).weeklyRate)).toBe(45000);
  });
});
