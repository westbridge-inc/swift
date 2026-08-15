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
    await billing.recordTopUp(sub.id, 12000, 'admin', 'bank-xfer-123');

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
      rate: 20000,
      prepaid: 500000,
      due: new Date(Date.now() + 3 * DAY),
    });

    const category = await app.prisma.category.create({
      data: { vendorId: fixture.vendorId, name: 'Bulk', sortOrder: 0 },
    });
    // Large tier is 1000+ active listings (30k/week).
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

describe('F-012-05 — suspension is ONE authority generation [REPORT-012]', () => {
  it('with the vendor row locked, the subscription cannot flip SUSPENDED ahead of the vendor write', async () => {
    // A store one failed charge from suspension, with nothing prepaid.
    const fx = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - HOUR) });
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
    const resA = await app.inject({
      method: 'POST', url: `/api/v1/admin/subscriptions/${a.subId}/topup`,
      payload: { amount: 100000, reference: 'test-admin-survives' },
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
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
    const resB = await app.inject({
      method: 'POST', url: `/api/v1/admin/subscriptions/${b.subId}/topup`,
      payload: { amount: 100000, reference: 'test-docs-dead' },
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    });
    expect(resB.statusCode).toBe(200);
    const vendB = await app.prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } });
    expect(vendB.status).toBe('ACTIVE'); // billing's suspension lifted
    expect(vendB.isVerified).toBe(false);
    expect(vendB.acceptingOrders).toBe(false); // document truth gates commerce
  });

  it('a crash between the failure record and its outcome cannot suppress retries forever — the outcome RESUMES [F-013-09]', async () => {
    const fx = await makeVendorWithSub({ rate: 20000, prepaid: 0, due: new Date(Date.now() - HOUR) });
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
