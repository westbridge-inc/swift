import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { withSuiteCapability } from '../lib/test-target-lock';
import { recordCreditRefundPaid } from '../modules/billing/credit-refund';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { syntheticLocationOwner } from './helpers/online-mover';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';
import { runBillingInvariants } from '../modules/billing/invariants';

// ---------------------------------------------------------------------------
// the revenue engine. Hardest paths: idempotency under
// concurrent runs, clock-edge due dates, retries across days ending in
// suspension, and the full top-up -> instant reinstatement story with the
// audit log as evidence.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let app: FastifyInstance;
let billing: BillingService;

const createdUserIds: string[] = [];
const createdSubIds: string[] = [];

const phoneRun = Date.now().toString().slice(-7);
let phoneSeq = 0;
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  phoneSeq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59255${phoneRun}${String(phoneSeq).padStart(2, '0')}`,
      firstName: 'Step5',
      lastName: `User${phoneSeq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(activeRole === 'ADMIN' && { admin: { create: { permissions: ['*'] } } }),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);

  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      ...(roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN') && { authMethod: 'OTP' as const }),
      deviceId: 'step5-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendorWithSub(opts: { rate: number; prepaid: number; due: Date; customRate?: number }) {
  const { userId } = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Billing Vendor ${phoneSeq}`,
      slug: `billing-vendor-${phoneRun}-${phoneSeq}`,
      vendorType: 'RESTAURANT',
      phone: `+5920006${String(phoneSeq).padStart(3, '0')}`,
      addressLine1: '1 Billing Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  // One available item so the vendor is browse-visible: these tests assert
  // browse visibility tracks SUBSCRIPTION status, and the discovery feeds now
  // exclude empty stores (no orderable item).
  const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Billing Plate', basePrice: 1500, isAvailable: true } });
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id,
      type: 'RESTAURANT',
      status: 'ACTIVE',
      weeklyRate: opts.rate,
      ...(opts.customRate !== undefined ? { customRate: opts.customRate } : {}),
      billingMethod: 'CASH',
      currentPeriodStart: new Date(opts.due.getTime() - 7 * DAY),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
      prepaidBalance: { create: { balance: opts.prepaid } },
    },
  });
  createdSubIds.push(sub.id);
  return { userId, ownerId: owner.id, vendorId: vendor.id, subId: sub.id };
}

async function makeMoverWithCardSub(opts: { token: string; due: Date }) {
  const { userId, token } = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('billing') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: 'CARD',
      paymentToken: opts.token,
      currentPeriodStart: new Date(opts.due.getTime() - 7 * DAY),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
    },
  });
  createdSubIds.push(sub.id);
  return { userId, riderId: rider.id, subId: sub.id, httpToken: token };
}

async function getSubWithRelations(subId: string) {
  return app.prisma.subscription.findUniqueOrThrow({
    where: { id: subId },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { id: true, owner: { select: { userId: true } } } },
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  billing = new BillingService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getPaymentProvider(),
  );
});

afterAll(async () => {
  await cleanupPayerBillingClocks(app.prisma, createdUserIds);
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  if (createdSubIds.length) {
    await app.prisma.subscription.deleteMany({ where: { id: { in: createdSubIds } } });
  }
  await app.close();
});

describe('Idempotency — the double-charge guard', () => {
  it('two concurrent billing attempts produce exactly one charge', async () => {
    const now = new Date();
    const { subId } = await makeMoverWithCardSub({ token: 'tok_good_concurrent', due: new Date(now.getTime() - HOUR) });
    const sub = await getSubWithRelations(subId);

    const results = await Promise.allSettled([
      billing.billSubscription(sub, now),
      billing.billSubscription(sub, now),
    ]);
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value : 'error'));
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
    // [M-01] The loser is 'skipped' when it collides before the winner reserved
    // its card intent, and 'pending' when the intent already exists — a live
    // instruction the reconciler owns. Either way it sends nothing.
    expect(outcomes.filter((o) => o === 'skipped' || o === 'pending')).toHaveLength(1);

    const payments = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } });
    expect(payments).toBe(1);
    const successes = await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } });
    expect(successes).toBe(1);
  });

  it('a rerun of the whole cycle cannot double-charge (proven by the ledger)', async () => {
    const now = new Date();
    const { subId } = await makeMoverWithCardSub({ token: 'tok_good_rerun', due: new Date(now.getTime() - HOUR) });

    await billing.runBillingCycle(now);
    await billing.runBillingCycle(now);

    const payments = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } });
    expect(payments).toBe(1);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('ACTIVE');
    // Advanced exactly one week from the original due date
    expect(sub.nextBillingDate.getTime() - sub.currentPeriodStart.getTime()).toBe(7 * DAY);
  });
});

describe('Clock edges', () => {
  it('bills a subscription due exactly now, leaves one due in a minute untouched', async () => {
    const now = new Date();
    const { subId: dueNow } = await makeMoverWithCardSub({ token: 'tok_good_edge1', due: now });
    const { subId: dueSoon } = await makeMoverWithCardSub({ token: 'tok_good_edge2', due: new Date(now.getTime() + 60_000) });

    await billing.runBillingCycle(now);

    const billed = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: dueNow } });
    const notBilled = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: dueSoon } });
    expect(billed).toBe(1);
    expect(notBilled).toBe(0);
  });
});

describe('Prepaid path, retries across days, suspension, top-up reinstatement', () => {
  let vendorUserId: string;
  let vendorId: string;
  let subId: string;
  let customerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const fixture = await makeVendorWithSub({
      rate: 20000,
      prepaid: 10000, // not enough for one week
      due: new Date(Date.now() - HOUR),
    });
    vendorUserId = fixture.userId;
    vendorId = fixture.vendorId;
    subId = fixture.subId;

    customerToken = (await makeUserWithSession(['CUSTOMER'], 'CUSTOMER')).token;
    adminToken = (await makeUserWithSession(['ADMIN'], 'ADMIN')).token;
  });

  async function browseShowsVendor(): Promise<boolean> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/vendors?limit=50',
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data.some((v: { id: string }) => v.id === vendorId);
  }

  it('fails attempt 1 (insufficient prepaid), goes PAST_DUE, schedules a daily retry', async () => {
    const now = new Date();
    await billing.runBillingCycle(now);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('PAST_DUE');
    expect(sub.failedAttempts).toBe(1);
    expect(sub.nextRetryAt!.getTime()).toBeGreaterThan(now.getTime() + 23 * HOUR);

    // An immediate rerun does NOT retry — the retry is tomorrow
    await billing.runBillingCycle(new Date(now.getTime() + 5 * 60_000));
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.failedAttempts).toBe(1);
  });

  it('retries across days and suspends on the 3rd failure — vendor vanishes from browse', async () => {
    expect(await browseShowsVendor()).toBe(true);

    const day2 = new Date(Date.now() + 25 * HOUR);
    await billing.runBillingCycle(day2);
    const day3 = new Date(Date.now() + 50 * HOUR);
    await billing.runBillingCycle(day3);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('SUSPENDED');
    expect(sub.failedAttempts).toBe(3);

    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(vendor.status).toBe('SUSPENDED');
    expect(vendor.acceptingOrders).toBe(false);

    expect(await browseShowsVendor()).toBe(false);

    const suspendedEvent = await app.prisma.billingEvent.findFirst({
      where: { subscriptionId: subId, type: 'SUSPENDED' },
    });
    expect(suspendedEvent).not.toBeNull();
  });

  it('an admin top-up bills instantly and reinstates — vendor returns to browse', async () => {
    const res = await injectWithApproval(app, {
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${subId}/topup`,
      payload: { amount: 100000, reference: `BANK-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': `topup-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }, // [M-08] the key is required
    });
    expect(res.statusCode).toBe(200);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.failedAttempts).toBe(0);

    const balance = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } });
    expect(Number(balance.balance)).toBe(10000 + 100000 - 20000);

    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(vendor.status).toBe('ACTIVE');
    expect(vendor.acceptingOrders).toBe(true);
    expect(await browseShowsVendor()).toBe(true);

    // The audit log tells the whole story
    const events = await app.prisma.billingEvent.findMany({
      where: { subscriptionId: subId },
      orderBy: { createdAt: 'asc' },
      select: { type: true },
    });
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'CHARGE_FAILED')).toHaveLength(3);
    expect(types).toContain('SUSPENDED');
    expect(types).toContain('PREPAID_TOPUP');
    expect(types).toContain('CHARGE_SUCCESS');
    expect(types).toContain('REINSTATED');

    // R13: the payer notice is post-commit and historical. It reports the payment
    // for the period and never promises "access restored", which a cancellation
    // committed before delivery could make false. The reinstatement itself is the
    // REINSTATED event and the vendor state asserted above.
    const note = await app.prisma.notification.findFirst({
      where: { userId: vendorUserId, title: 'Subscription payment received' },
    });
    expect(note).not.toBeNull();
  });

  it('a top-up reinstates an MMG-rail sub from prepaid — no fresh MMG request', async () => {
    // A suspended mover on the MMG rail (billingMethod MOBILE_MONEY).
    const { userId } = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    const sub = await app.prisma.subscription.create({
      data: {
        riderId: rider.id, type: 'DELIVERY_RIDER', status: 'SUSPENDED', weeklyRate: 12000,
        billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '5926001234',
        currentPeriodStart: new Date(Date.now() - 8 * DAY), currentPeriodEnd: new Date(Date.now() - DAY),
        nextBillingDate: new Date(Date.now() - DAY), nextRetryAt: new Date(Date.now() - HOUR),
      },
    });
    createdSubIds.push(sub.id);

    // Admin records a real bank-transfer top-up covering the week.
    await billing.recordTopUp(sub.id, 12000, 'admin', 'bank-xfer-123', 'bank-xfer-123-key'); // [M-08] a key is required

    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.status).toBe('ACTIVE'); // reinstated by the recorded cash...
    const bal = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(bal.balance)).toBe(0); // ...which was CONSUMED, not left sitting unused
    // and it must NOT have fired a duplicate MMG request on the payer's phone
    const pendingMmg = await app.prisma.subscriptionPayment.count({ where: { subscriptionId: sub.id, status: 'PENDING' } });
    expect(pendingMmg).toBe(0);
  });

  it('SWIFT-030: a top-up retry with the same Idempotency-Key credits ONCE', async () => {
    const { userId } = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    // ACTIVE so the top-up just accumulates (a suspended sub would consume it on reinstate).
    const sub = await app.prisma.subscription.create({
      data: {
        riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 12000, billingMethod: 'CASH',
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
      },
    });
    createdSubIds.push(sub.id);

    await billing.recordTopUp(sub.id, 5000, 'admin', 'cash-at-office', 'IDEM-KEY-1');
    await billing.recordTopUp(sub.id, 5000, 'admin', 'cash-at-office', 'IDEM-KEY-1'); // retry, same key

    const bal = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    // RED before SWIFT-030: the Date.now() key made every call unique → 10000 (double credit).
    expect(Number(bal.balance)).toBe(5000);
    const events = await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(events).toBe(1);
  });
});

describe('Suspended movers are kicked and blocked', () => {
  it('3 failed card charges suspend, force offline, and block go-online', async () => {
    const now = new Date();
    const fixture = await makeMoverWithCardSub({
      token: 'tok_fail_card',
      due: new Date(now.getTime() - HOUR),
    });

    await billing.runBillingCycle(now);
    await billing.runBillingCycle(new Date(now.getTime() + 25 * HOUR));
    await billing.runBillingCycle(new Date(now.getTime() + 50 * HOUR));

    // [#1393] Each card charge holds the shared clock while it is confirmed. A
    // confirmation resolution never suspends in its own instant: the third
    // decline leaves the payer PAST_DUE with the 48-hour grace spent and the
    // next run due now, and that next hourly run suspends.
    const third = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(third).toMatchObject({ status: 'PAST_DUE', failedAttempts: 3 });
    expect(third.billingEnforcementDueAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 50 * HOUR);
    expect(third.nextRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 51 * HOUR);
    await billing.runBillingCycle(new Date(now.getTime() + 51 * HOUR));

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(sub.status).toBe('SUSPENDED');

    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { id: fixture.riderId } });
    expect(rider.isOnline).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      headers: { authorization: `Bearer ${fixture.httpToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIPTION_SUSPENDED');
  });
});

describe('Waivers, reminders, tier recalculation', () => {
  it('a waived subscription advances for free with the audit trail intact', async () => {
    const now = new Date();
    const { subId } = await makeMoverWithCardSub({ token: 'tok_good_waive', due: new Date(now.getTime() - HOUR) });
    await app.prisma.subscription.update({ where: { id: subId }, data: { feeWaived: true } });

    await billing.runBillingCycle(now);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.nextBillingDate.getTime()).toBeGreaterThan(now.getTime());

    const success = await app.prisma.billingEvent.findFirst({
      where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' },
    });
    expect(Number(success!.amount)).toBe(0);
  });

  it('a waiver is for ONE period only — the flag clears and the next cycle bills normally', async () => {
    const now = new Date();
    const { subId } = await makeMoverWithCardSub({ token: 'tok_good_waive_once', due: new Date(now.getTime() - HOUR) });
    await app.prisma.subscription.update({ where: { id: subId }, data: { feeWaived: true } });

    // Period 1: the waived cycle advances free AND clears the flag.
    await billing.runBillingCycle(now);
    const afterWaive = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(afterWaive.feeWaived).toBe(false); // no longer a permanent free ride

    // Period 2: once the next bill is due it charges the real fee.
    await billing.runBillingCycle(new Date(afterWaive.nextBillingDate.getTime() + HOUR));
    const charges = await app.prisma.billingEvent.findMany({
      where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' },
      orderBy: { createdAt: 'asc' },
    });
    expect(charges).toHaveLength(2);
    expect(Number(charges[0]!.amount)).toBe(0);            // the waived period
    expect(Number(charges[1]!.amount)).toBeGreaterThan(0); // billed normally after
  });

  it('sends exactly one due-tomorrow reminder per period', async () => {
    // A corrupt legacy subscription cannot be notified, but it also must not
    // poison the batch or consume a REMINDER idempotency key.
    const orphan = await app.prisma.subscription.create({
      data: {
        type: 'DELIVERY_RIDER',
        status: 'ACTIVE',
        weeklyRate: 12000,
        billingMethod: 'CASH',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 12 * HOUR),
        nextBillingDate: new Date(Date.now() + 12 * HOUR),
      },
    });
    createdSubIds.push(orphan.id);

    const { subId } = await makeMoverWithCardSub({
      token: 'tok_good_reminder',
      due: new Date(Date.now() + 12 * HOUR),
    });

    const first = await billing.sendUpcomingReminders();
    expect(first).toBeGreaterThanOrEqual(1);
    const mine = await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'REMINDER' } });
    expect(mine).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: orphan.id, type: 'REMINDER' } })).toBe(0);

    await billing.sendUpcomingReminders();
    const stillOne = await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'REMINDER' } });
    expect(stillOne).toBe(1);
  });

  it('moves a vendor to the large tier from catalogue size — never from sales', async () => {
    const fixture = await makeVendorWithSub({
      rate: 15000,
      prepaid: 500000,
      due: new Date(Date.now() + 3 * DAY),
    });

    const category = await app.prisma.category.create({
      data: { vendorId: fixture.vendorId, name: 'Bulk', sortOrder: 0 },
    });
    // Large tier is 1000+ active listings (20k/week; below it, 15k).
    await app.prisma.item.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        vendorId: fixture.vendorId,
        categoryId: category.id,
        name: `Bulk item ${i}`,
        basePrice: 100,
        isAvailable: true,
      })),
    });

    await billing.recalculateVendorTiers();
    let sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(Number(sub.weeklyRate)).toBe(20000);

    const tierEvent = await app.prisma.billingEvent.findFirst({
      where: { subscriptionId: fixture.subId, type: 'TIER_CHANGE' },
    });
    expect(tierEvent).not.toBeNull();

    // Shrink the catalogue back under the threshold
    await app.prisma.item.updateMany({ where: { vendorId: fixture.vendorId }, data: { isAvailable: false } });
    await billing.recalculateVendorTiers();
    sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(Number(sub.weeklyRate)).toBe(15000);
  });
});

describe('Subscription trial lifecycle', () => {
  async function makeBareVendor(vendorType: 'RESTAURANT' | 'STORE' | 'SERVICE' = 'RESTAURANT') {
    const { userId } = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const owner = await app.prisma.vendorOwner.create({ data: { userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id,
        name: `Trial Vendor ${phoneSeq}`,
        slug: `trial-vendor-${phoneSeq}-${nanoid(4)}`,
        vendorType,
        phone: `+5920077${String(phoneSeq).padStart(3, '0')}`,
        addressLine1: '1 Trial Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: 6.8,
        longitude: -58.15,
        status: 'PENDING_APPROVAL',
      },
    });
    return vendor.id;
  }

  it('starts a 14-day trial at the small-vendor rate on vendor activation', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const sub = await subscriptions.startTrialForVendor(await makeBareVendor('RESTAURANT'));
    createdSubIds.push(sub.id);

    expect(sub.status).toBe('TRIAL');
    expect(sub.isTrialActive).toBe(true);
    expect(sub.type).toBe('RESTAURANT');
    expect(Number(sub.weeklyRate)).toBe(15000); // smallVendor tier (seeded GY)
    expect(sub.billingMethod).toBe('CASH');
    const days = (sub.trialEndDate!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
  });

  it('maps STORE and SERVICE vendors to the new subscription types', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const store = await subscriptions.startTrialForVendor(await makeBareVendor('STORE'));
    const service = await subscriptions.startTrialForVendor(await makeBareVendor('SERVICE'));
    createdSubIds.push(store.id, service.id);
    expect(store.type).toBe('RETAIL_STORE');
    expect(service.type).toBe('SERVICE_PROVIDER');
  });

  it('is idempotent — re-activating returns the same subscription', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const vendorId = await makeBareVendor('RESTAURANT');
    const first = await subscriptions.startTrialForVendor(vendorId);
    const second = await subscriptions.startTrialForVendor(vendorId);
    createdSubIds.push(first.id);
    expect(second.id).toBe(first.id);
    expect(await app.prisma.subscription.count({ where: { vendorId } })).toBe(1);
  });

  it('converts an expired trial to ACTIVE and due for billing', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const sub = await subscriptions.startTrialForVendor(await makeBareVendor('RESTAURANT'));
    createdSubIds.push(sub.id);
    // [#1393] A trial ends when its period does: the trial end, the period end
    // and the first due date are one instant (startTrial writes them together).
    const ended = new Date(Date.now() - 1000);
    await app.prisma.subscription.update({
      where: { id: sub.id },
      data: { trialEndDate: ended, currentPeriodStart: new Date(ended.getTime() - 14 * DAY), currentPeriodEnd: ended, nextBillingDate: ended },
    });

    const converted = await subscriptions.convertExpiredTrials();
    expect(converted).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.isTrialActive).toBe(false);
    expect(after.nextBillingDate.getTime()).toBeLessThanOrEqual(Date.now());
    // The obligation keeps its own due instant, the trial end, not the run time of the job.
    expect(after.nextBillingDate.getTime()).toBe(ended.getTime());
  });
});

describe('F-012-05 — suspension is ONE authority generation [REPORT-012]', () => {
  it('with the vendor row locked, the subscription cannot flip SUSPENDED ahead of the vendor write', async () => {
    // A store one failed charge from suspension, with nothing prepaid. [#1393]
    // One charge from suspension now also means the owner's 48-hour grace has
    // run: due 49 hours ago on the shared clock.
    const fx = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - 49 * HOUR) });
    await app.prisma.subscription.update({
      where: { id: fx.subId },
      data: {
        status: 'PAST_DUE', failedAttempts: 2,
        nextRetryAt: new Date(Date.now() - HOUR),
        isInGracePeriod: true, gracePeriodEnd: new Date(Date.now() - HOUR),
      },
    });

    // Hold the vendor row lock the way any competing writer (toggle, admin)
    // would, then run the sweep. Split-commit suspension would flip the
    // subscription NOW and write the vendor row later; one-generation
    // suspension blocks the WHOLE flip on this lock.
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((r) => { lockAcquired = r; });
    const holder = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${fx.vendorId} FOR UPDATE`;
      lockAcquired();
      await hold;
    }, { timeout: 30_000 });
    await acquired;

    const sweep = billing.runBillingCycle(new Date());
    await new Promise((r) => setTimeout(r, 800));
    const during = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fx.subId } });
    expect(during.status).toBe('PAST_DUE'); // the flip waits WITH the vendor write

    release();
    await holder;
    await sweep;
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fx.subId } });
    const vend = await app.prisma.vendor.findUniqueOrThrow({ where: { id: fx.vendorId } });
    expect(after.status).toBe('SUSPENDED');
    expect(vend.status).toBe('SUSPENDED');
    expect(vend.acceptingOrders).toBe(false);
  });
});

describe('F-013-07/09 — reinstatement authority + resumable retry [REPORT-013]', () => {
  it('payment lifts ONLY a billing suspension: admin authority survives, and dead documents keep commerce closed', async () => {
    const adminToken = (await makeUserWithSession(['ADMIN'], 'ADMIN')).token;

    // A — admin-suspended store pays: entitlement restores, lifecycle does not.
    const a = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - HOUR) });
    await app.prisma.subscription.update({
      where: { id: a.subId },
      data: { status: 'SUSPENDED', failedAttempts: 3, nextRetryAt: new Date(Date.now() - HOUR), suspendedAt: new Date() },
    });
    await app.prisma.vendor.update({
      where: { id: a.vendorId },
      data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'ADMIN' },
    });
    const resA = await injectWithApproval(app, {
      method: 'POST', url: `/api/v1/admin/subscriptions/${a.subId}/topup`,
      payload: { amount: 100000, reference: `ADMINSURVIVES-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': `topup-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }, // [M-08] the key is required
    });
    expect(resA.statusCode).toBe(200);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: a.subId } })).status).toBe('ACTIVE');
    const vendA = await app.prisma.vendor.findUniqueOrThrow({ where: { id: a.vendorId } });
    expect(vendA.status).toBe('SUSPENDED'); // the admin's call, not billing's
    expect(vendA.acceptingOrders).toBe(false);

    // B — billing-suspended store whose documents died mid-suspension pays:
    // lifecycle restores, commerce stays closed (no blind acceptingOrders).
    const b = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - HOUR) });
    await app.prisma.subscription.update({
      where: { id: b.subId },
      data: { status: 'SUSPENDED', failedAttempts: 3, nextRetryAt: new Date(Date.now() - HOUR), suspendedAt: new Date() },
    });
    await app.prisma.vendor.update({
      where: { id: b.vendorId },
      data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING', isVerified: false },
    });
    const resB = await injectWithApproval(app, {
      method: 'POST', url: `/api/v1/admin/subscriptions/${b.subId}/topup`,
      payload: { amount: 100000, reference: `DOCSDEAD-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': `topup-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }, // [M-08] the key is required
    });
    expect(resB.statusCode).toBe(200);
    const vendB = await app.prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } });
    expect(vendB.status).toBe('ACTIVE'); // billing's suspension lifted
    expect(vendB.isVerified).toBe(false);
    expect(vendB.acceptingOrders).toBe(false); // document truth gates commerce
  });

  it.each([
    ['SUSPENDED', 'ADMIN'], ['SUSPENDED', null], ['PENDING_APPROVAL', null], ['CLOSED', null],
  ] as const)('a store already %s (source %s) keeps its state when its fee then goes unpaid, so a fee payment never reopens it', async (status, source) => {
    const adminToken = (await makeUserWithSession(['ADMIN'], 'ADMIN')).token;
    // [#1393] Due 49 hours ago: the 48-hour grace has run, so the third failure suspends.
    const fx = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - 49 * HOUR) });
    // Suspended first for another reason (an admin, or a suspension that
    // recorded none), or not open at all (awaiting approval, or closed).
    await app.prisma.vendor.update({ where: { id: fx.vendorId }, data: { status, acceptingOrders: false, suspensionSource: source } });
    // The weekly fee then goes unpaid: the third failure suspends billing.
    await app.prisma.subscription.update({
      where: { id: fx.subId },
      data: { status: 'PAST_DUE', failedAttempts: 2, nextRetryAt: new Date(Date.now() - HOUR), isInGracePeriod: true, gracePeriodEnd: new Date(Date.now() - HOUR) },
    });
    await billing.runBillingCycle(new Date());
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: fx.subId } })).status).toBe('SUSPENDED');
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: fx.vendorId } }))
      .toMatchObject({ status, acceptingOrders: false, suspensionSource: source });

    // The owner pays the fee: billing gives back only what billing took.
    const res = await injectWithApproval(app, {
      method: 'POST', url: `/api/v1/admin/subscriptions/${fx.subId}/topup`,
      payload: { amount: 100000, reference: `KEEPSOURCE-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': `topup-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: fx.subId } })).status).toBe('ACTIVE');
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: fx.vendorId } }))
      .toMatchObject({ status, acceptingOrders: false, suspensionSource: source });
  });

  it('a crash between the failure record and its outcome cannot suppress retries forever — the outcome RESUMES [F-013-09]', async () => {
    // [#1393] Due 49 hours ago: the 48-hour grace has run, so the third failure suspends.
    const fx = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - 49 * HOUR) });
    const sub = await app.prisma.subscription.update({
      where: { id: fx.subId },
      data: {
        status: 'PAST_DUE', failedAttempts: 2,
        nextRetryAt: new Date(Date.now() - HOUR),
        isInGracePeriod: true, gracePeriodEnd: new Date(Date.now() - HOUR),
      },
    });
    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    // The crash residue REPORT-013 proved: attempt + failure durably recorded
    // at level a2, process died before the outcome (increment/suspension).
    await app.prisma.billingEvent.create({
      data: { subscriptionId: fx.subId, type: 'CHARGE_ATTEMPT', amount: 20000, currencyCode: sub.currencyCode, idempotencyKey: `charge:${fx.subId}:${periodKey}:a2` },
    });
    await app.prisma.billingEvent.create({
      data: { subscriptionId: fx.subId, type: 'CHARGE_FAILED', amount: 20000, currencyCode: sub.currencyCode, idempotencyKey: `failed:${fx.subId}:${periodKey}:a2`, note: 'insufficient prepaid (crash residue)' },
    });

    // The hourly replay. Before the fix: same attempt key -> P2002 -> 'skipped'
    // forever; the store kept selling unpaid.
    await billing.runBillingCycle(new Date());

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fx.subId } });
    expect(after.failedAttempts).toBe(3); // the recorded outcome finally applied
    expect(after.status).toBe('SUSPENDED'); // third failure = suspension
    const vend = await app.prisma.vendor.findUniqueOrThrow({ where: { id: fx.vendorId } });
    expect(vend.status).toBe('SUSPENDED');
    expect(vend.suspensionSource).toBe('BILLING');
    expect(vend.acceptingOrders).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// [A-07] THE PRICE THE BILLER CHARGES.
//
// `customRate ?? weeklyRate` was written seven times and asserted nowhere: no
// test had ever proved the biller charges the agreed price rather than the tier
// list price. Charging the wrong amount is the most expensive defect this
// platform can have, and it was one edit away at all times.
// ---------------------------------------------------------------------------
describe('[A-07] a subscription is charged its own price', () => {
  it('an explicit customRate is what is charged — not the tier list rate', async () => {
    const now = new Date();
    // List price 90,000; the agreed price is 10,000. Prepaid covers the agreed
    // price and nothing like the list price, so charging the wrong one both
    // takes the wrong amount and fails the charge.
    const { subId } = await makeVendorWithSub({ rate: 90_000, customRate: 10_000, prepaid: 20_000, due: now });

    await billing.runBillingCycle(now);

    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0]!.amount)).toBe(10_000);

    const balance = await app.prisma.prepaidBalance.findFirstOrThrow({ where: { subscriptionId: subId } });
    expect(Number(balance.balance)).toBe(10_000); // 20,000 − the agreed 10,000
  });

  it('with no customRate the tier rate is charged — the fallback still works', async () => {
    const now = new Date();
    const { subId } = await makeVendorWithSub({ rate: 8_000, prepaid: 20_000, due: now });

    await billing.runBillingCycle(now);

    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0]!.amount)).toBe(8_000);
  });
});

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-07] Unused prepaid fee credit is refunded, then the
// account can be deleted. Swift never moves the money. Every step is a money
// action a second admin approves, in this order: SET ASIDE (the whole credit
// leaves the wallet; nothing is paid before), PAY outside Swift, RECORD THE
// PAYOUT (one transfer reference, one refund, across every account); RELEASE
// returns a set-aside that could not be paid. Books balanced at every step.
// ---------------------------------------------------------------------------
describe('fee credit refund — set aside, then paid, recorded once, two people, books balanced', () => {
  let admin: { userId: string; token: string };
  let other: { userId: string; token: string };
  const headersFor = (token: string, key = `topup-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`) => ({
    'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key,
  });
  const headers = (key?: string) => headersFor(admin.token, key);
  const ref = (tag: string) => `${tag}${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`;
  const topUp = async (subId: string, amount: number, reference = ref('CREDIT')) => {
    const res = await injectWithApproval(app, { method: 'POST', url: `/api/v1/admin/subscriptions/${subId}/topup`, payload: { amount, reference }, headers: headers() });
    expect(res.statusCode, res.payload).toBe(200);
    return reference;
  };
  async function storeWithCredit(credit: number) {
    // Due in five days: the top-up only accumulates, nothing is billed.
    const fx = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() + 5 * DAY) });
    const creditRef = credit > 0 ? await topUp(fx.subId, credit) : null;
    return { ...fx, creditRef };
  }
  const url = (subId: string, step: 'set-aside' | 'paid' | 'release') => `/api/v1/admin/subscriptions/${subId}/refund-credit/${step}`;
  const setAside = (subId: string, amount: number) => injectWithApproval(app, { method: 'POST', url: url(subId, 'set-aside'), payload: { amount }, headers: headers() });
  const paid = (subId: string, payload: Record<string, unknown>) => injectWithApproval(app, { method: 'POST', url: url(subId, 'paid'), payload, headers: headers() });
  const release = (subId: string, amount: number) => injectWithApproval(app, { method: 'POST', url: url(subId, 'release'), payload: { amount }, headers: headers() });
  /** The real two-person path with chosen people: `asker` asks, `approver` approves, `asker` re-sends. */
  async function twoPeople(asker: { token: string }, approver: { token: string }, method: 'POST', target: string, payload: Record<string, unknown>, between?: () => Promise<void>) {
    const first = await app.inject({ method, url: target, payload, headers: headersFor(asker.token) });
    expect(first.statusCode, first.payload).toBe(202);
    const approvalId = first.json().error.details.approvalId as string;
    if (between) await between();
    const decided = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, payload: { approve: true, note: 'second person' }, headers: headersFor(approver.token) });
    expect(decided.statusCode, decided.payload).toBe(200);
    return app.inject({ method, url: target, payload, headers: { ...headersFor(asker.token), 'x-swift-approval': approvalId } });
  }
  const wallet = async (subId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance);
  const subledger = async (account: 'WALLET_LIABILITY' | 'REFUND_PAYABLE', subId: string) => {
    const rows = await app.prisma.ledgerEntry.findMany({ where: { accountCode: account, subledgerId: subId } });
    return rows.reduce((sum, r) => sum + Number(r.credit) - Number(r.debit), 0);
  };
  const events = (subId: string, type: string) => app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: type as never } });
  /** Every nightly money check agrees for this subscription, and the whole ledger balances. */
  const booksAgree = async (subId: string) => {
    const report = await runBillingInvariants(app.prisma);
    expect(report.walletMismatches.filter((m) => m.subscriptionId === subId)).toEqual([]);
    expect(report.ledgerWalletMismatches.filter((m) => m.subscriptionId === subId)).toEqual([]);
    expect(report.refundPayableMismatches.filter((m) => m.subscriptionId === subId)).toEqual([]);
    expect(report.ledgerTrialImbalance).toBeNull();
  };

  beforeAll(async () => {
    admin = await makeUserWithSession(['ADMIN'], 'ADMIN');
    other = await makeUserWithSession(['ADMIN'], 'ADMIN');
  });

  it.each(['MMG', 'BANK_TRANSFER'] as const)('set aside, then paid by %s: the credit leaves once, the reference is recorded, the books agree at every step', async (method) => {
    const fx = await storeWithCredit(15000);
    expect(await wallet(fx.subId)).toBe(15000);

    const aside = await setAside(fx.subId, 15000);
    expect(aside.statusCode, aside.payload).toBe(200);
    expect(aside.json().data).toMatchObject({ amount: 15000, balance: 0, refundSetAside: 15000 });
    expect(await wallet(fx.subId)).toBe(0);
    expect(await subledger('WALLET_LIABILITY', fx.subId)).toBe(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(15000);
    expect(await events(fx.subId, 'PREPAID_REFUND_RESERVED')).toHaveLength(1);
    await booksAgree(fx.subId);

    const reference = ref('REFUND');
    const res = await paid(fx.subId, { amount: 15000, method, reference });
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ amount: 15000, balance: 0, refundSetAside: 0 });
    const done = await events(fx.subId, 'PREPAID_REFUND');
    expect(done).toHaveLength(1);
    // Stored the way every manual-rail reference is: trimmed and upper-cased.
    const stored = reference.toUpperCase();
    expect(done[0]).toMatchObject({ paymentRef: stored });
    expect(Number(done[0]!.amount)).toBe(15000);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(0);
    const out = await app.prisma.ledgerEntry.findFirst({ where: { accountCode: method === 'MMG' ? 'CLEARING_MMG' : 'BANK_LOCAL', credit: 15000, transaction: { idempotencyKey: { contains: stored } } } });
    expect(out).not.toBeNull();
    // One audit row per step, written in that step's own transaction.
    expect(await app.prisma.auditLog.count({ where: { entityId: fx.subId, action: { contains: 'refund-credit/paid' }, changes: { path: ['reference'], equals: stored } } })).toBe(1);
    expect(await app.prisma.auditLog.count({ where: { entityId: fx.subId, action: { contains: 'refund-credit/set-aside' } } })).toBe(1);
    await booksAgree(fx.subId);

    // The same payout recorded again changes nothing.
    const again = await paid(fx.subId, { amount: 15000, method, reference });
    expect(again.statusCode, again.payload).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true });
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(1);
    await booksAgree(fx.subId);
  });

  it('a set-aside that cannot be paid is released back to the wallet, books balanced; the credit can then be set aside again', async () => {
    const fx = await storeWithCredit(9000);
    expect((await setAside(fx.subId, 9000)).statusCode).toBe(200);
    const back = await release(fx.subId, 9000);
    expect(back.statusCode, back.payload).toBe(200);
    expect(back.json().data).toMatchObject({ amount: 9000, balance: 9000, refundSetAside: 0 });
    expect(await wallet(fx.subId)).toBe(9000);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(0);
    expect(await subledger('WALLET_LIABILITY', fx.subId)).toBe(9000);
    expect(await events(fx.subId, 'PREPAID_REFUND_RELEASED')).toHaveLength(1);
    await booksAgree(fx.subId);
    // Nothing is set aside now, so there is nothing to pay or release.
    expect((await paid(fx.subId, { amount: 9000, method: 'MMG', reference: ref('LATE') })).json().error.code).toBe('NO_REFUND_SET_ASIDE');
    expect((await release(fx.subId, 9000)).json().error.code).toBe('NO_REFUND_SET_ASIDE');
    expect((await setAside(fx.subId, 9000)).statusCode).toBe(200);
    await booksAgree(fx.subId);
  });

  it('[Sol S1] one transfer reference records one refund across every account: a second account cannot use it, in any letter case', async () => {
    const a = await storeWithCredit(15000);
    const b = await storeWithCredit(15000);
    expect((await setAside(a.subId, 15000)).statusCode).toBe(200);
    expect((await setAside(b.subId, 15000)).statusCode).toBe(200);
    const reference = ref('ONETRANSFER');
    expect((await paid(a.subId, { amount: 15000, method: 'MMG', reference })).statusCode).toBe(200);
    for (const reuse of [reference, reference.toLowerCase()]) {
      const second = await paid(b.subId, { amount: 15000, method: 'MMG', reference: reuse });
      expect(second.statusCode, second.payload).toBe(409);
      expect(second.json().error.code).toBe('REFUND_REFERENCE_REUSED');
    }
    // B is still owed its refund: nothing was recorded for it.
    expect(await events(b.subId, 'PREPAID_REFUND')).toHaveLength(0);
    expect(await subledger('REFUND_PAYABLE', b.subId)).toBe(15000);
    await booksAgree(b.subId);
  });

  it('a reference Swift received as a payment is not proof of a refund sent', async () => {
    const fx = await storeWithCredit(7000);
    expect((await setAside(fx.subId, 7000)).statusCode).toBe(200);
    const res = await paid(fx.subId, { amount: 7000, method: 'MMG', reference: fx.creditRef! });
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('REFUND_REFERENCE_IS_A_PAYMENT');
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(0);
  });

  it('a permanent inbound payment alias is refused as a refund transfer', async () => {
    const fx = await storeWithCredit(7000);
    expect((await setAside(fx.subId, 7000)).statusCode).toBe(200);
    const historical = ref('HISTORICAL');
    const inbound = await app.prisma.providerPayment.create({ data: {
      provider: 'MMG', providerTxnId: ref('CURRENT'), amount: 7000, currencyCode: 'GYD', status: 'CREDITED', subscriptionId: fx.subId,
    } });
    // Historical aliases can only be created by the migration. Install one
    // in a rolled-back owner fixture, restore its immutable trigger BEFORE
    // exercising the real refund service, and roll back all DDL and writes.
    const approval = await app.prisma.privilegedApproval.create({ data: {
      action: 'POST /subscriptions/:id/refund-credit/paid', cls: 'C4', capability: 'subscription.refund',
      entityId: fx.subId, fingerprint: ref('FINGERPRINT'), requestedBy: admin.userId, approvedBy: other.userId,
      status: 'APPLIED', reason: TEST_ADMIN_REASON, expiresAt: new Date(Date.now() + DAY),
    } });
    const rollback = new Error('ROLLBACK_REFUND_ALIAS_FIXTURE');
    try {
      await app.prisma.$transaction(async (tx) => {
        await withSuiteCapability('ddl', async () => {
          await tx.$executeRawUnsafe('ALTER TABLE provider_payment_aliases DISABLE TRIGGER provider_payment_aliases_immutable');
          await tx.providerPaymentAlias.create({ data: { provider: 'MMG', aliasKey: historical.toUpperCase(), providerPaymentId: inbound.id } });
          await tx.$executeRawUnsafe('ALTER TABLE provider_payment_aliases ENABLE TRIGGER provider_payment_aliases_immutable');
        });
        const [guard] = await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT tgenabled = 'O' AS enabled FROM pg_trigger WHERE tgname = 'provider_payment_aliases_immutable'`;
        expect(guard?.enabled).toBe(true);
        const db = new Proxy(tx, { get(target, key) {
          if (key === '$transaction') return (work: (client: Prisma.TransactionClient) => unknown) => work(tx);
          return Reflect.get(target, key);
        } }) as PrismaClient;
        const error = await recordCreditRefundPaid(db, {
          adminId: admin.userId, approvalId: approval.id, subscriptionId: fx.subId,
          amount: 7000, method: 'MMG', reference: historical.toLowerCase(),
        }).then(() => null, (e: unknown) => e);
        expect(error).toMatchObject({ code: 'REFUND_REFERENCE_IS_A_PAYMENT' });
        expect(await tx.billingEvent.count({ where: { subscriptionId: fx.subId, type: 'PREPAID_REFUND' } })).toBe(0);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(7000);
    await booksAgree(fx.subId);
  });

  it.each([150_000_000.02, 9_999_999_999.97, 9_999_999_999.99])('refunds a valid large balance with cents (%s)', async (amount) => {
    const fx = await storeWithCredit(0);
    // Existing balances can have cents even though the manual top-up form
    // accepts whole dollars. Seed through the transaction credit seam.
    await app.prisma.$transaction((tx) => billing.recordTopUpInTransaction(tx, {
      subscriptionId: fx.subId, amount, recordedBy: 'refund-cent-fixture', eventKey: `cent-fixture:${fx.subId}`,
    }));
    const aside = await setAside(fx.subId, amount);
    expect(aside.statusCode, aside.payload).toBe(200);
    expect(aside.json().data.refundSetAside).toBe(amount);
    const result = await paid(fx.subId, { amount, method: 'BANK_TRANSFER', reference: ref('LARGECENTS') });
    expect(result.statusCode, result.payload).toBe(200);
    expect(result.json().data.refundSetAside).toBe(0);
    expect(await wallet(fx.subId)).toBe(0);
    await booksAgree(fx.subId);
  });

  it('[Sol S1] once set aside, the amount is frozen: credit that arrives while the payout record waits for approval never makes the payout unrecordable', async () => {
    const fx = await storeWithCredit(15000);
    expect((await setAside(fx.subId, 15000)).statusCode).toBe(200);
    const res = await twoPeople(admin, other, 'POST', url(fx.subId, 'paid'), { amount: 15000, method: 'MMG', reference: ref('WAITED') },
      async () => { await topUp(fx.subId, 5000); });
    expect(res.statusCode, res.payload).toBe(200);
    // The answer is today's truth: the new credit is the person's, nothing is set aside.
    expect(res.json().data).toMatchObject({ amount: 15000, balance: 5000, refundSetAside: 0 });
    await booksAgree(fx.subId);
  });

  it('a set-aside asked for while the credit then changed is refused when applied, and nothing is set aside (nothing has been paid yet)', async () => {
    const fx = await storeWithCredit(15000);
    const res = await twoPeople(admin, other, 'POST', url(fx.subId, 'set-aside'), { amount: 15000 },
      async () => { await topUp(fx.subId, 5000); });
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('FEE_CREDIT_CHANGED');
    expect(await wallet(fx.subId)).toBe(20000);
    expect(await events(fx.subId, 'PREPAID_REFUND_RESERVED')).toHaveLength(0);
  });

  it('[coordinator] the admin who asked for the set-aside cannot be the one who approves its payout record', async () => {
    const fx = await storeWithCredit(6000);
    // `admin` asks for the set-aside and `other` approves it.
    expect((await twoPeople(admin, other, 'POST', url(fx.subId, 'set-aside'), { amount: 6000 })).statusCode).toBe(200);
    // `other` then records the payout and `admin` approves: refused.
    const crossed = await twoPeople(other, admin, 'POST', url(fx.subId, 'paid'), { amount: 6000, method: 'MMG', reference: ref('CROSSED') });
    expect(crossed.statusCode, crossed.payload).toBe(403);
    expect(crossed.json().error.code).toBe('REFUND_SAME_PERSON');
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(6000);
    // `admin` records it and `other` approves: recorded.
    const ok = await twoPeople(admin, other, 'POST', url(fx.subId, 'paid'), { amount: 6000, method: 'MMG', reference: ref('STRAIGHT') });
    expect(ok.statusCode, ok.payload).toBe(200);
    await booksAgree(fx.subId);
  });

  it('a payout is recorded only for what is set aside, and only one set-aside is open at a time', async () => {
    const fx = await storeWithCredit(8000);
    const none = await paid(fx.subId, { amount: 8000, method: 'MMG', reference: ref('EARLY') });
    expect(none.statusCode, none.payload).toBe(409);
    expect(none.json().error.code).toBe('NO_REFUND_SET_ASIDE');
    expect((await setAside(fx.subId, 8000)).statusCode).toBe(200);
    const wrong = await paid(fx.subId, { amount: 5000, method: 'MMG', reference: ref('WRONG') });
    expect(wrong.statusCode, wrong.payload).toBe(409);
    expect(wrong.json().error.code).toBe('REFUND_AMOUNT_MISMATCH');
    await topUp(fx.subId, 3000);
    const twice = await setAside(fx.subId, 3000);
    expect(twice.statusCode, twice.payload).toBe(409);
    expect(twice.json().error.code).toBe('REFUND_ALREADY_SET_ASIDE');
    expect(await wallet(fx.subId)).toBe(3000);
    await booksAgree(fx.subId);
  });

  it('[Sol S2] any balance a wallet can hold can be refunded whole (a GY$15,000,000 top-up is refundable); a third decimal place is refused', async () => {
    const fx = await storeWithCredit(15_000_000);
    const res = await setAside(fx.subId, 15_000_000);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ amount: 15_000_000, refundSetAside: 15_000_000 });
    const fine = await release(fx.subId, 15_000_000.001);
    expect(fine.statusCode, fine.payload).toBe(400);
  });

  it('[Sol S2] a replayed payout reports the wallet as it is now, not zero', async () => {
    const fx = await storeWithCredit(15000);
    expect((await setAside(fx.subId, 15000)).statusCode).toBe(200);
    const reference = ref('REPLAY');
    expect((await paid(fx.subId, { amount: 15000, method: 'MMG', reference })).statusCode).toBe(200);
    await topUp(fx.subId, 5000);
    const again = await paid(fx.subId, { amount: 15000, method: 'MMG', reference });
    expect(again.statusCode, again.payload).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, data: { amount: 15000, balance: 5000, refundSetAside: 0 } });
  });

  it('the nightly check names a set-aside the books do not agree with', async () => {
    const fx = await storeWithCredit(0);
    // A set-aside recorded with no matching REFUND_PAYABLE movement: drift.
    const stray = await app.prisma.billingEvent.create({ data: { subscriptionId: fx.subId, type: 'PREPAID_REFUND_RESERVED' as never, amount: 100, idempotencyKey: `credit-refund-reserve:stray-${fx.subId}` } });
    try {
      const report = await runBillingInvariants(app.prisma);
      expect(report.refundPayableMismatches).toContainEqual({ subscriptionId: fx.subId, ledgerBalance: 0, openSetAside: 100 });
    } finally {
      await app.prisma.billingEvent.delete({ where: { id: stray.id } });
    }
  });

  it('one admin alone cannot set credit aside: the request waits for a second person and nothing changes', async () => {
    const fx = await storeWithCredit(5000);
    const alone = await app.inject({ method: 'POST', url: url(fx.subId, 'set-aside'), payload: { amount: 5000 }, headers: headers() });
    expect(alone.statusCode, alone.payload).toBe(202);
    expect(await wallet(fx.subId)).toBe(5000);
    const unexplained = await app.inject({ method: 'POST', url: url(fx.subId, 'set-aside'), payload: { amount: 5000 }, headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' } });
    expect(unexplained.statusCode, unexplained.payload).toBe(400);
    expect(await wallet(fx.subId)).toBe(5000);
  });

  it('sets aside exactly the credit: another amount is refused and nothing changes; with no credit there is nothing to set aside', async () => {
    const fx = await storeWithCredit(8000);
    const res = await setAside(fx.subId, 5000);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('FEE_CREDIT_CHANGED');
    expect(await wallet(fx.subId)).toBe(8000);
    expect(await events(fx.subId, 'PREPAID_REFUND_RESERVED')).toHaveLength(0);
    const empty = await storeWithCredit(0);
    const nothing = await setAside(empty.subId, 100);
    expect(nothing.statusCode, nothing.payload).toBe(409);
    expect(nothing.json().error.code).toBe('NO_FEE_CREDIT');
  });
});
