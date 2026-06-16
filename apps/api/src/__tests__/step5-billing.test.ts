import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
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

// ---------------------------------------------------------------------------
// Step 5 — the revenue engine. Hardest paths per playbook: idempotency under
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

let phoneSeq = 0;
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  phoneSeq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200055${String(phoneSeq).padStart(2, '0')}`,
      firstName: 'Step5',
      lastName: `User${phoneSeq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
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
      deviceId: 'step5-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendorWithSub(opts: { rate: number; prepaid: number; due: Date }) {
  const { userId } = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Billing Vendor ${phoneSeq}`,
      slug: `billing-vendor-${phoneSeq}`,
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
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id,
      type: 'RESTAURANT',
      status: 'ACTIVE',
      weeklyRate: opts.rate,
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
    data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true },
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
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(1);

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
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${subId}/topup`,
      payload: { amount: 100000, reference: 'bank-transfer-123' },
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
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

    const note = await app.prisma.notification.findFirst({
      where: { userId: vendorUserId, title: 'Subscription reinstated' },
    });
    expect(note).not.toBeNull();
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

  it('sends exactly one due-tomorrow reminder per period', async () => {
    const { subId } = await makeMoverWithCardSub({
      token: 'tok_good_reminder',
      due: new Date(Date.now() + 12 * HOUR),
    });

    const first = await billing.sendUpcomingReminders();
    expect(first).toBeGreaterThanOrEqual(1);
    const mine = await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'REMINDER' } });
    expect(mine).toBe(1);

    await billing.sendUpcomingReminders();
    const stillOne = await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'REMINDER' } });
    expect(stillOne).toBe(1);
  });

  it('moves a vendor to the large tier from catalogue size — never from sales', async () => {
    const fixture = await makeVendorWithSub({
      rate: 20000,
      prepaid: 500000,
      due: new Date(Date.now() + 3 * DAY),
    });

    const category = await app.prisma.category.create({
      data: { vendorId: fixture.vendorId, name: 'Bulk', sortOrder: 0 },
    });
    await app.prisma.item.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        vendorId: fixture.vendorId,
        categoryId: category.id,
        name: `Bulk item ${i}`,
        basePrice: 100,
        isAvailable: true,
      })),
    });

    await billing.recalculateVendorTiers();
    let sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(Number(sub.weeklyRate)).toBe(30000);

    const tierEvent = await app.prisma.billingEvent.findFirst({
      where: { subscriptionId: fixture.subId, type: 'TIER_CHANGE' },
    });
    expect(tierEvent).not.toBeNull();

    // Shrink the catalogue back under the threshold
    await app.prisma.item.updateMany({ where: { vendorId: fixture.vendorId }, data: { isAvailable: false } });
    await billing.recalculateVendorTiers();
    sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.subId } });
    expect(Number(sub.weeklyRate)).toBe(20000);
  });
});

describe('Phase 5 — subscription trial lifecycle', () => {
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
    expect(Number(sub.weeklyRate)).toBe(20000); // smallVendor tier (seeded GY)
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
    await app.prisma.subscription.update({
      where: { id: sub.id },
      data: { trialEndDate: new Date(Date.now() - 1000) },
    });

    const converted = await subscriptions.convertExpiredTrials();
    expect(converted).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.isTrialActive).toBe(false);
    expect(after.nextBillingDate.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
