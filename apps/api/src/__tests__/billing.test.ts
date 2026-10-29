import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { withSuiteCapability } from '../lib/test-target-lock';
import { recordCreditRefundPaid } from '../modules/billing/credit-refund';
import { approvalRefusalMessage } from '../modules/admin/admin-approval';
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
import { approveAsSecondAdmin, injectWithApproval, seedSecondApproval } from './helpers/admin-approval';
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
    // [OWNER #62 · 14 Oct] At most one week ahead (was four, 8 Oct): with
    // GY$10,000 already held and the owed week of GY$20,000, the most an
    // operator can record is GY$30,000 (the owed week and the coming one).
    const res = await injectWithApproval(app, {
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${subId}/topup`,
      payload: { amount: 30000, reference: `BANK-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': `topup-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }, // [M-08] the key is required
    });
    expect(res.statusCode).toBe(200);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.failedAttempts).toBe(0);

    const balance = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } });
    expect(Number(balance.balance)).toBe(10000 + 30000 - 20000); // the coming week held: one week ahead, the cap

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

  it('[FEE-STATUS] the due-tomorrow reminder names the due day as Guyana reads it and the fee in GY$', async () => {
    // A fee due at 02:00 UTC falls due at 22:00 the evening BEFORE in Guyana (UTC-4). The reminder
    // printed the UTC calendar date ("is due on 2026-10-14" for a fee due on the 13th in Guyana): a
    // day late, a misleading fee claim. And "$12,000 GYD" is not how any other fee notice writes money.
    const now = new Date();
    // The next 00:00-03:59 UTC hour that is 1-23 h away: always the day before in Guyana, always inside the reminder window.
    const due = [0, 1].flatMap((d) => [0, 1, 2, 3].map((h) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, h))))
      .find((t) => t.getTime() > now.getTime() + HOUR && t.getTime() <= now.getTime() + 23 * HOUR)!;
    const { subId, userId } = await makeMoverWithCardSub({ token: 'tok_good_reminder_day', due });
    await billing.sendUpcomingReminders(now);
    const notices = await app.prisma.billingFeeNotice.findMany({ where: { subscriptionId: subId } });
    const inbox = await app.prisma.notification.findMany({ where: { userId } });
    const bodies = [...notices.map((n) => String((n.payload as { body?: unknown }).body ?? '')), ...inbox.map((n) => n.body)]
      .filter((body) => body.startsWith('Your weekly fee of'));
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const guyana = new Date(due.getTime() - 4 * HOUR);
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = `${WEEKDAYS[guyana.getUTCDay()]} ${guyana.getUTCDate()} ${MONTHS[guyana.getUTCMonth()]}`;
    for (const body of bodies) {
      expect(body).toMatch(new RegExp(`^Your weekly fee of GY\\$12,000 is due on ${day}\\.`));
      expect(body).not.toContain(due.toISOString().slice(0, 10));
      expect(body).not.toMatch(/\$12,000 GYD/);
    }
  });

  it('prices a vendor for the large tier from catalogue size — never from sales; the rise is held for the 14-day notice', async () => {
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
    // [R27 · GUARDRAILS §7 standing rule 2] The large tier is a RISE: held (fee-rise-notice.ts), told
    // 14 days ahead and applied from the first weekly fee after that, never written at once.
    expect(Number(sub.weeklyRate)).toBe(15000);
    const heldKey = `billing.fee_rise:${fixture.subId}`;
    expect((await app.prisma.platformConfig.findUnique({ where: { key: heldKey } }))?.value).toMatchObject({ from: 15000, to: 20000, source: 'WEEKLY_RETIER' });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: fixture.subId, type: 'TIER_CHANGE' } })).toBe(0);

    // Shrink the catalogue back under the threshold: the held rise no longer stands and is dropped.
    await app.prisma.item.updateMany({ where: { vendorId: fixture.vendorId }, data: { isAvailable: false } });
    // [R27 · security review] The week's largest catalogue counts: listings hidden today still count
    // for 7 days, and the lower tier must then hold on two weekly passes before the rise is dropped.
    const t = Date.now();
    await billing.recalculateVendorTiers(new Date(t));
    expect((await app.prisma.platformConfig.findUnique({ where: { key: heldKey } }))?.value).toMatchObject({ to: 20000 });
    await billing.recalculateVendorTiers(new Date(t + 8 * DAY));
    expect((await app.prisma.platformConfig.findUnique({ where: { key: heldKey } }))?.value).toMatchObject({ to: 20000 });
    await billing.recalculateVendorTiers(new Date(t + 15 * DAY));
    sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(Number(sub.weeklyRate)).toBe(15000);
    expect(await app.prisma.platformConfig.findUnique({ where: { key: heldKey } })).toBeNull();
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
  // [owner #62 · 14 Oct] A fee payment here is the owed week (GY$20,000): one week at a time, never several.
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
      payload: { amount: 20000, reference: `ADMINSURVIVES-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
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
      payload: { amount: 20000, reference: `DOCSDEAD-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
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
      payload: { amount: 20000, reference: `KEEPSOURCE-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}` },
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
  async function storeWithCredit(credit: number, rate = 20000) {
    // Due in five days: the top-up only accumulates, nothing is billed. [owner #62]
    // At most one week is paid ahead, so the rate must cover the credit.
    const fx = await makeVendorWithSub({ rate, prepaid: 0, due: new Date(Date.now() + 5 * DAY) });
    const creditRef = credit > 0 ? await topUp(fx.subId, credit) : null;
    return { ...fx, creditRef };
  }
  const url = (subId: string, step: 'set-aside' | 'paid' | 'release') => `/api/v1/admin/subscriptions/${subId}/refund-credit/${step}`;
  const setAside = (subId: string, amount: number) => injectWithApproval(app, { method: 'POST', url: url(subId, 'set-aside'), payload: { amount }, headers: headers() });
  /** [Sol r2 S1] The set-aside the console shows as open now (its own event id), as the console sends it. */
  const openSetAsideIdOf = async (subId: string) => {
    const rows = await app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: { in: ['PREPAID_REFUND_RESERVED', 'PREPAID_REFUND', 'PREPAID_REFUND_RELEASED'] as never } }, orderBy: { createdAt: 'asc' } });
    const open = rows.reduce((c, r) => c + (r.type === ('PREPAID_REFUND_RESERVED' as never) ? 1 : -1) * Math.round(Number(r.amount) * 100), 0);
    return open > 0 ? rows.filter((r) => r.type === ('PREPAID_REFUND_RESERVED' as never)).at(-1)!.id : 'none';
  };
  const paid = async (subId: string, payload: Record<string, unknown>) => injectWithApproval(app, { method: 'POST', url: url(subId, 'paid'), payload: { setAsideId: await openSetAsideIdOf(subId), ...payload }, headers: headers() });
  const release = async (subId: string, amount: number) => injectWithApproval(app, { method: 'POST', url: url(subId, 'release'), payload: { amount, setAsideId: await openSetAsideIdOf(subId) }, headers: headers() });
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

  it('[owner ruling 14 Oct · Opus S4-2] the admin who asked for the set-aside may approve its release: nothing leaves Swift', async () => {
    const fx = await storeWithCredit(6000);
    // `admin` asks for the set-aside (headers() carries admin's token); the helper's second admin approves it.
    expect((await setAside(fx.subId, 6000)).statusCode).toBe(200);
    const askedAside = await app.prisma.privilegedApproval.findFirst({
      where: { action: { contains: 'refund-credit/set-aside' }, entityId: fx.subId, status: 'APPLIED' }, select: { requestedBy: true },
    });
    expect(askedAside?.requestedBy).toBe(admin.userId);
    // `other` asks for the release and `admin`, the set-aside's requester, approves it. Unlike the payout
    // record (REFUND_SAME_PERSON), a release has no pair rule: the money goes back to the partner's fee credit.
    const back = await twoPeople(other, admin, 'POST', url(fx.subId, 'release'), { amount: 6000, setAsideId: await openSetAsideIdOf(fx.subId) });
    expect(back.statusCode, back.payload).toBe(200);
    expect(back.json().data).toMatchObject({ amount: 6000, balance: 6000, refundSetAside: 0 });
    const approvedRelease = await app.prisma.privilegedApproval.findFirst({
      where: { action: { contains: 'refund-credit/release' }, entityId: fx.subId }, select: { requestedBy: true, approvedBy: true },
    });
    expect(approvedRelease).toMatchObject({ requestedBy: other.userId, approvedBy: admin.userId });
    expect(await wallet(fx.subId)).toBe(6000);
    expect(await events(fx.subId, 'PREPAID_REFUND_RELEASED')).toHaveLength(1);
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

  it('[review S3-1] a reference Swift has on record for money that went OUT (another payout) cannot record this refund, in any spelling; a fresh one can', async () => {
    const fx = await storeWithCredit(6000);
    expect((await setAside(fx.subId, 6000)).statusCode).toBe(200);
    const sentElsewhere = ref('PAYOUTOUT');
    const payout = await app.prisma.payoutRequest.create({ data: {
      userId: other.userId, amount: 6000, method: 'BANK_TRANSFER', destination: {}, netAmount: 6000, externalRef: sentElsewhere,
    } });
    try {
      const asks = () => app.prisma.privilegedApproval.count({ where: { action: 'POST /subscriptions/:id/refund-credit/paid', entityId: fx.subId } });
      for (const reuse of [sentElsewhere, sentElsewhere.toLowerCase()]) {
        const res = await paid(fx.subId, { amount: 6000, method: 'BANK_TRANSFER', reference: reuse });
        expect(res.statusCode, res.payload).toBe(409);
        expect(res.json().error.code).toBe('REFUND_REFERENCE_IS_A_PAYMENT');
      }
      // Refused when ASKED: nothing was recorded and no "payout reported" marker was written.
      expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(0);
      expect(await asks()).toBe(0);
      expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(6000);
      const fresh = await paid(fx.subId, { amount: 6000, method: 'BANK_TRANSFER', reference: ref('FRESHOUT') });
      expect(fresh.statusCode, fresh.payload).toBe(200);
      expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(1);
      expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(0);
      await booksAgree(fx.subId);
    } finally {
      await app.prisma.payoutRequest.delete({ where: { id: payout.id } });
    }
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
          amount: 7000, method: 'MMG', reference: historical.toLowerCase(), setAsideId: await openSetAsideIdOf(fx.subId),
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
    const res = await twoPeople(admin, other, 'POST', url(fx.subId, 'paid'), { amount: 15000, method: 'MMG', reference: ref('WAITED'), setAsideId: await openSetAsideIdOf(fx.subId) },
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
    const crossed = await twoPeople(other, admin, 'POST', url(fx.subId, 'paid'), { amount: 6000, method: 'MMG', reference: ref('CROSSED'), setAsideId: await openSetAsideIdOf(fx.subId) });
    expect(crossed.statusCode, crossed.payload).toBe(403);
    expect(crossed.json().error.code).toBe('REFUND_SAME_PERSON');
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(6000);
    // `admin` records it and `other` approves: recorded.
    const ok = await twoPeople(admin, other, 'POST', url(fx.subId, 'paid'), { amount: 6000, method: 'MMG', reference: ref('STRAIGHT'), setAsideId: await openSetAsideIdOf(fx.subId) });
    expect(ok.statusCode, ok.payload).toBe(200);
    await booksAgree(fx.subId);
  });

  // [Sol r2 S1] Each payout record and release names the set-aside it was asked
  // for, and a reported payout is never undone by a release.
  it('[Sol r2 S1] a release approved before a payout was reported never returns that set-aside: the payout stays recordable', async () => {
    const fx = await storeWithCredit(15000);
    expect((await setAside(fx.subId, 15000)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const reference = ref('REPORTED');
    // The release is approved; before it is applied, the payout is sent and its record asked for.
    const reportedPayload = { amount: 15000, method: 'MMG', reference, setAsideId };
    let reportedId = '';
    const back = await twoPeople(admin, other, 'POST', url(fx.subId, 'release'), { amount: 15000, setAsideId }, async () => {
      const reported = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: reportedPayload, headers: headersFor(other.token) });
      expect(reported.statusCode, reported.payload).toBe(202);
      reportedId = reported.json().error.details.approvalId as string;
    });
    expect(back.statusCode, back.payload).toBe(409);
    expect(back.json().error.code).toBe('REFUND_PAYOUT_REPORTED');
    expect(await wallet(fx.subId)).toBe(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(15000);
    expect(await events(fx.subId, 'PREPAID_REFUND_RELEASED')).toHaveLength(0);
    // [U06] The payout record the other admin asked for still stands, so a
    // second ask for it is refused at the gate (one ask per act)...
    const again = await paid(fx.subId, { amount: 15000, method: 'MMG', reference });
    expect(again.statusCode, again.payload).toBe(409);
    expect(again.json().error.code).toBe('APPROVAL_ALREADY_OPEN');
    // ...and that ask, approved by a person who did not set the refund aside
    // (REFUND_SAME_PERSON) and applied by the admin who asked, records it.
    await approveAsSecondAdmin(app, reportedId);
    const recorded = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: reportedPayload, headers: { ...headersFor(other.token), 'x-swift-approval': reportedId } });
    expect(recorded.statusCode, recorded.payload).toBe(200);
    expect(recorded.json().data).toMatchObject({ refundSetAside: 0 });
    await booksAgree(fx.subId);
  });

  it('[Sol r2 S1 · keep the hold] a payout record that is refused still keeps the set-aside from going back', async () => {
    const fx = await storeWithCredit(4000);
    expect((await setAside(fx.subId, 4000)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const reported = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: { amount: 4000, method: 'BANK_TRANSFER', reference: ref('REFUSED'), setAsideId }, headers: headersFor(admin.token) });
    expect(reported.statusCode, reported.payload).toBe(202);
    const refused = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${reported.json().error.details.approvalId}/decide`, payload: { approve: false, note: 'reference does not match the bank record' }, headers: headersFor(other.token) });
    expect(refused.statusCode, refused.payload).toBe(200);
    const back = await release(fx.subId, 4000);
    expect(back.statusCode, back.payload).toBe(409);
    expect(back.json().error.code).toBe('REFUND_PAYOUT_REPORTED');
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(4000);
    await booksAgree(fx.subId);
  });

  it('[Sol r2 S1] an approval for an earlier set-aside never acts on a later one of the same amount', async () => {
    const fx = await storeWithCredit(9000);
    expect((await setAside(fx.subId, 9000)).statusCode).toBe(200);
    const first = await openSetAsideIdOf(fx.subId);
    const ask = async (step: 'paid' | 'release', payload: Record<string, unknown>) => {
      const asked = await app.inject({ method: 'POST', url: url(fx.subId, step), payload, headers: headersFor(admin.token) });
      expect(asked.statusCode, asked.payload).toBe(202);
      const approvalId = asked.json().error.details.approvalId as string;
      const decided = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, payload: { approve: true, note: 'second person' }, headers: headersFor(other.token) });
      expect(decided.statusCode, decided.payload).toBe(200);
      return Object.assign(() => app.inject({ method: 'POST', url: url(fx.subId, step), payload, headers: { ...headersFor(admin.token), 'x-swift-approval': approvalId } }), { approvalId });
    };
    // Approved for the FIRST set-aside, not used yet.
    const staleRelease = await ask('release', { amount: 9000, setAsideId: first });
    const stalePayout = await ask('paid', { amount: 9000, method: 'MMG', reference: ref('STALE'), setAsideId: first });
    // The first set-aside is paid and recorded; credit arrives and a second one of the same amount is set aside.
    // [U06] While the stale payout ask stands, a second ask to record a payout
    // here is refused at the gate (one ask per act)...
    const firstPayout = { amount: 9000, method: 'MMG', reference: ref('FIRST'), setAsideId: first };
    const refused = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: firstPayout, headers: headersFor(admin.token) });
    expect(refused.statusCode, refused.payload).toBe(409);
    expect(refused.json().error.code).toBe('APPROVAL_ALREADY_OPEN');
    // ...so the payout recorded here carries a second approval written before that rule.
    const firstApproval = await seedSecondApproval(app, stalePayout.approvalId, { body: (b) => ({ ...b, reference: firstPayout.reference }) });
    expect((await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: firstPayout, headers: { ...headersFor(admin.token), 'x-swift-approval': firstApproval } })).statusCode).toBe(200);
    await topUp(fx.subId, 9000);
    expect((await setAside(fx.subId, 9000)).statusCode).toBe(200);
    expect(await openSetAsideIdOf(fx.subId)).not.toBe(first);
    const released = await staleRelease();
    expect(released.statusCode, released.payload).toBe(409);
    expect(released.json().error.code).toBe('REFUND_CYCLE_CHANGED');
    const recorded = await stalePayout();
    expect(recorded.statusCode, recorded.payload).toBe(409);
    expect(recorded.json().error.code).toBe('REFUND_CYCLE_CHANGED');
    expect(await wallet(fx.subId)).toBe(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(9000);
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(1);
    await booksAgree(fx.subId);
  });

  /**
   * [DS1122 S1] An open transaction holding the refund's ask lock (the key the
   * approval gate and a release share), optionally with an uncommitted
   * payout-record ask in it, until `commit()`.
   */
  async function holdRefundAskLock(subId: string, askFor: string | null) {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const tx = app.prisma.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`credit-refund-ask:${subId}`}, 0))`;
      if (askFor) {
        await db.privilegedApproval.create({ data: {
          action: 'POST /subscriptions/:id/refund-credit/paid', cls: 'C4', capability: 'subscription.refund', entityId: subId,
          fingerprint: ref('INFLIGHT'), bodySnapshot: { params: { id: subId }, body: { amount: 1, method: 'MMG', reference: ref('INFLIGHT'), setAsideId: askFor }, query: {} },
          status: 'PENDING', requestedBy: other.userId, reason: TEST_ADMIN_REASON, expiresAt: new Date(Date.now() + DAY),
        } as never });
      }
      locked();
      await done;
    }, { timeout: 20_000 });
    await holding;
    return { commit: async () => { finish(); await tx; } };
  }
  const settledWithin = async <T,>(work: Promise<T>, ms: number) => {
    let settled = false;
    const tracked = work.then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { settled, tracked };
  };

  it('[DS1122 S1] a release applying while a payout-record ask is being written waits for it, then refuses', async () => {
    const fx = await storeWithCredit(5000);
    expect((await setAside(fx.subId, 5000)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const payload = { amount: 5000, setAsideId };
    const asked = await app.inject({ method: 'POST', url: url(fx.subId, 'release'), payload, headers: headersFor(admin.token) });
    expect(asked.statusCode, asked.payload).toBe(202);
    const approvalId = asked.json().error.details.approvalId as string;
    const decided = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, payload: { approve: true, note: 'second person' }, headers: headersFor(other.token) });
    expect(decided.statusCode, decided.payload).toBe(200);
    const ask = await holdRefundAskLock(fx.subId, setAsideId);
    const apply = await settledWithin(app.inject({ method: 'POST', url: url(fx.subId, 'release'), payload, headers: { ...headersFor(admin.token), 'x-swift-approval': approvalId } }), 500);
    await ask.commit();
    const res = await apply.tracked;
    expect(apply.settled, 'the release waited for the ask being written').toBe(false);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('REFUND_PAYOUT_REPORTED');
    expect(await wallet(fx.subId)).toBe(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(5000);
    await booksAgree(fx.subId);
  });

  it('[DS1122 S1] a release and a payout record applied at the same moment: the payout is recorded, the release refused, the books agree', async () => {
    const fx = await storeWithCredit(6000);
    expect((await setAside(fx.subId, 6000)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const approve = async (step: 'paid' | 'release', payload: Record<string, unknown>, asker: { token: string }, approver: { token: string }) => {
      const asked = await app.inject({ method: 'POST', url: url(fx.subId, step), payload, headers: headersFor(asker.token) });
      expect(asked.statusCode, asked.payload).toBe(202);
      const approvalId = asked.json().error.details.approvalId as string;
      expect((await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, payload: { approve: true, note: 'second person' }, headers: headersFor(approver.token) })).statusCode).toBe(200);
      return () => app.inject({ method: 'POST', url: url(fx.subId, step), payload, headers: { ...headersFor(asker.token), 'x-swift-approval': approvalId } });
    };
    const applyRelease = await approve('release', { amount: 6000, setAsideId }, other, admin);
    // `admin` asked for the set-aside, so another admin approves its payout record.
    const applyPaid = await approve('paid', { amount: 6000, method: 'BANK_TRANSFER', reference: ref('RACE'), setAsideId }, admin, other);
    const [released, recorded] = await Promise.all([applyRelease(), applyPaid()]);
    expect(recorded.statusCode, recorded.payload).toBe(200);
    expect(released.statusCode, released.payload).toBe(409);
    expect(['REFUND_PAYOUT_REPORTED', 'REFUND_CYCLE_CHANGED']).toContain(released.json().error.code);
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(1);
    expect(await events(fx.subId, 'PREPAID_REFUND_RELEASED')).toHaveLength(0);
    expect(await wallet(fx.subId)).toBe(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(0);
    await booksAgree(fx.subId);
  });

  it('[DS1122 S1] a payout-record ask waits while a release of that refund holds the lock', async () => {
    const fx = await storeWithCredit(3000);
    expect((await setAside(fx.subId, 3000)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const releasing = await holdRefundAskLock(fx.subId, null);
    const ask = await settledWithin(app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: { amount: 3000, method: 'MMG', reference: ref('WAITS'), setAsideId }, headers: headersFor(other.token) }), 500);
    await releasing.commit();
    const res = await ask.tracked;
    expect(ask.settled, 'the ask waited for the lock').toBe(false);
    expect(res.statusCode, res.payload).toBe(202);
    // [DS1122 S3] The list tells the console, for the open set-aside, that a payout was reported.
    const { openSetAsideIds, payoutAskStateFor } = await import('../modules/billing/credit-refund');
    const open = await openSetAsideIds(app.prisma, [fx.subId]);
    expect(open.get(fx.subId)).toBe(setAsideId);
    expect((await payoutAskStateFor(app.prisma, open)).get(fx.subId)).toBe('ACTIVE');
    expect((await payoutAskStateFor(app.prisma, new Map([[fx.subId, 'a-later-set-aside']]))).has(fx.subId)).toBe(false);
  });

  // [Owner ruling 14 Oct, S1-1] While the owner is the ONLY admin, the owner may approve both steps
  // under the solo ceremony; the gate counts "still the only admin" again at apply.
  async function makeOwner() {
    phoneSeq += 1;
    const user = await app.prisma.user.create({ data: {
      phone: `+59256${phoneRun}${String(phoneSeq).padStart(2, '0')}`, firstName: 'Solo', lastName: `Owner${phoneSeq}`,
      roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, status: 'ACTIVE',
      admin: { create: { permissions: ['*'] } },
    } });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'solo-owner', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { userId: user.id, token };
  }
  /** Every other admin who could approve is locked out for the duration (restored afterwards). */
  async function asTheOnlyAdmin<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    const others = await app.prisma.user.findMany({
      where: { id: { not: ownerId }, status: { notIn: ['SUSPENDED', 'BANNED', 'DEACTIVATED'] }, OR: [{ activeRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }, { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } }] },
      select: { id: true, status: true },
    });
    await app.prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'SUSPENDED' } });
    try {
      return await work();
    } finally {
      for (const o of others) await app.prisma.user.update({ where: { id: o.id }, data: { status: o.status } });
    }
  }
  /** The owner asks, the request is decided in solo mode exactly as decideSoloApproval stores it, and the owner re-sends it through the gate. */
  async function soloStep(owner: { token: string; userId: string }, target: string, payload: Record<string, unknown>) {
    const asked = await app.inject({ method: 'POST', url: target, payload, headers: headersFor(owner.token) });
    expect(asked.statusCode, asked.payload).toBe(202);
    const approvalId = asked.json().error.details.approvalId as string;
    const now = Date.now();
    await app.prisma.privilegedApproval.update({ where: { id: approvalId }, data: {
      status: 'APPROVED', approvedBy: owner.userId, decidedSolo: true, decidedAt: new Date(now),
      soloRequestedAt: new Date(now - 13 * 3_600_000), soloEligibleAt: new Date(now - 60_000),
    } as never });
    return app.inject({ method: 'POST', url: target, payload, headers: { ...headersFor(owner.token), 'x-swift-approval': approvalId } });
  }

  it('[owner ruling S1-1] the only admin approves both steps in solo mode: the payout is recorded', async () => {
    const owner = await makeOwner();
    const fx = await storeWithCredit(7000);
    await asTheOnlyAdmin(owner.userId, async () => {
      const aside = await soloStep(owner, url(fx.subId, 'set-aside'), { amount: 7000 });
      expect(aside.statusCode, aside.payload).toBe(200);
      const setAsideId = await openSetAsideIdOf(fx.subId);
      const recorded = await soloStep(owner, url(fx.subId, 'paid'), { amount: 7000, method: 'MMG', reference: ref('SOLOPAID'), setAsideId });
      expect(recorded.statusCode, recorded.payload).toBe(200);
    });
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(1);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(0);
    await booksAgree(fx.subId);
  });

  it('[owner ruling S1-1] with a second admin, a solo-decided payout record is refused at the gate and nothing is recorded', async () => {
    const owner = await makeOwner();
    const fx = await storeWithCredit(6500);
    expect((await twoPeople(owner, other, 'POST', url(fx.subId, 'set-aside'), { amount: 6500 })).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const recorded = await soloStep(owner, url(fx.subId, 'paid'), { amount: 6500, method: 'MMG', reference: ref('NOTSOLO'), setAsideId });
    // [Opus delta S4-a] Refused by the gate's own recount ("solo-ended"), not by some other barrier.
    expect(recorded.statusCode, recorded.payload).toBe(403);
    expect(recorded.json().error.message).toBe(approvalRefusalMessage('solo-ended'));
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(6500);
  });

  it('[Opus delta S4-a] the payout record counts "still the only admin" itself: a solo-decided approval while a second admin exists is refused as the same person', async () => {
    const owner = await makeOwner();
    const fx = await storeWithCredit(6200);
    // The owner asks for the set-aside and `other` approves it: the owner is the set-aside's requester.
    expect((await twoPeople(owner, other, 'POST', url(fx.subId, 'set-aside'), { amount: 6200 })).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    // A payout approval the owner decided solo, handed straight to the record (the gate would refuse
    // it first: its own recount is graded above and in admin-solo-approval). The record counts again.
    const now = Date.now();
    const approval = await app.prisma.privilegedApproval.create({ data: {
      action: 'POST /subscriptions/:id/refund-credit/paid', cls: 'C4', capability: 'subscription.refund',
      entityId: fx.subId, fingerprint: ref('FINGERPRINT'), requestedBy: owner.userId, approvedBy: owner.userId,
      decidedSolo: true, decidedAt: new Date(now), soloRequestedAt: new Date(now - 13 * 3_600_000), soloEligibleAt: new Date(now - 60_000),
      status: 'APPLIED', reason: TEST_ADMIN_REASON, expiresAt: new Date(now + DAY),
    } as never });
    const error = await recordCreditRefundPaid(app.prisma, {
      adminId: owner.userId, approvalId: approval.id, subscriptionId: fx.subId, amount: 6200, method: 'MMG', reference: ref('SOLOREC'), setAsideId,
    }).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: 'REFUND_SAME_PERSON' });
    expect(await events(fx.subId, 'PREPAID_REFUND')).toHaveLength(0);
    expect(await subledger('REFUND_PAYABLE', fx.subId)).toBe(6200);
    await booksAgree(fx.subId);
  });

  it('[review S2-1] a payout record that could never be recorded is refused when ASKED, and no "payout reported" marker is written', async () => {
    const fx = await storeWithCredit(5000);
    expect((await setAside(fx.subId, 5000)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const asks = () => app.prisma.privilegedApproval.count({ where: { action: 'POST /subscriptions/:id/refund-credit/paid', entityId: fx.subId } });
    const before = await asks();
    const bad = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: { amount: 5000, method: 'MMG', reference: 'x', setAsideId }, headers: headers() });
    expect(bad.statusCode, bad.payload).toBe(400);
    expect(bad.json().error.code).toBe('REFUND_REFERENCE_INVALID');
    const inbound = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: { amount: 5000, method: 'MMG', reference: fx.creditRef!, setAsideId }, headers: headers() });
    expect(inbound.statusCode, inbound.payload).toBe(409);
    expect(inbound.json().error.code).toBe('REFUND_REFERENCE_IS_A_PAYMENT');
    const wrongAmount = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: { amount: 4000, method: 'MMG', reference: ref('WRONGAMT'), setAsideId }, headers: headers() });
    expect(wrongAmount.statusCode, wrongAmount.payload).toBe(409);
    expect(await asks()).toBe(before);
    // nothing became a marker: the release is still possible
    expect((await release(fx.subId, 5000)).statusCode).toBe(200);
  });

  it('[review S2-1] after a refused payout record the set-aside can be recorded again (never released); the list says so', async () => {
    const fx = await storeWithCredit(4500);
    expect((await setAside(fx.subId, 4500)).statusCode).toBe(200);
    const setAsideId = await openSetAsideIdOf(fx.subId);
    const asked = await app.inject({ method: 'POST', url: url(fx.subId, 'paid'), payload: { amount: 4500, method: 'BANK_TRANSFER', reference: ref('TYPO'), setAsideId }, headers: headersFor(admin.token) });
    expect(asked.statusCode, asked.payload).toBe(202);
    const refused = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${asked.json().error.details.approvalId}/decide`, payload: { approve: false, note: 'reference does not match the bank record' }, headers: headersFor(other.token) });
    expect(refused.statusCode, refused.payload).toBe(200);
    const { openSetAsideIds, payoutAskStateFor } = await import('../modules/billing/credit-refund');
    expect((await payoutAskStateFor(app.prisma, await openSetAsideIds(app.prisma, [fx.subId]))).get(fx.subId)).toBe('NOT_COMPLETED');
    expect((await release(fx.subId, 4500)).json().error.code).toBe('REFUND_PAYOUT_REPORTED');
    const again = await paid(fx.subId, { amount: 4500, method: 'BANK_TRANSFER', reference: ref('CORRECT') });
    expect(again.statusCode, again.payload).toBe(200);
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
    const fx = await storeWithCredit(15_000_000, 15_000_000);
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
