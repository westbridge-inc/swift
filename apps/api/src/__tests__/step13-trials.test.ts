import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, VendorType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';

// ---------------------------------------------------------------------------
// Free trials — the only way a subscription is born. Verify -> 14-day TRIAL
// (never charged) -> auto-convert to ACTIVE & due -> the weekly cycle bills.
// Failure paths first: never charge a trial; convert only after it expires;
// remind exactly once.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920007'; // this file owns the 0007xxx phone sandbox

let app: FastifyInstance;
let subscriptions: SubscriptionService;
let billing: BillingService;

const userIds: string[] = [];
const subIds: string[] = [];
const riderIds: string[] = [];
const driverIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];

let seq = 0;
function nextPhone() {
  seq += 1;
  return `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
}

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({
    data: { phone: nextPhone(), firstName: 'Trial', lastName: `U${seq}`, roles, activeRole, isPhoneVerified: true, countryCode: 'GY' },
  });
  userIds.push(user.id);
  return user.id;
}

async function makeRider() {
  const userId = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  riderIds.push(rider.id);
  return { userId, riderId: rider.id };
}

async function makeDriver() {
  const userId = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2018,
      vehicleColor: 'Silver',
      licensePlate: `GAB-${seq}`,
      driverLicenseUrl: 'doc://license',
      vehicleInsuranceUrl: 'doc://insurance',
    },
  });
  driverIds.push(driver.id);
  return { userId, driverId: driver.id };
}

async function makeVendor(vendorType: VendorType) {
  const userId = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  ownerIds.push(owner.id);
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Trial Vendor ${seq}`,
      slug: `trial-vendor-${seq}-${nanoid(4)}`,
      vendorType,
      phone: nextPhone(),
      addressLine1: '1 Trial Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      status: 'PENDING_APPROVAL',
    },
  });
  vendorIds.push(vendor.id);
  return { userId, vendorId: vendor.id };
}

function track<T extends { subscription: { id: string } } | null>(result: T): T {
  if (result) subIds.push(result.subscription.id);
  return result;
}

async function subWithRelations(subId: string) {
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
  await app.ready();

  const notifications = new NotificationService(app.prisma, app.io);
  subscriptions = new SubscriptionService(app.prisma, notifications);
  billing = new BillingService(app.prisma, notifications, getPaymentProvider());
});

afterAll(async () => {
  if (subIds.length) {
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  }
  if (vendorIds.length) await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (ownerIds.length) await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  if (riderIds.length) await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
  if (driverIds.length) await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  if (userIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('Trial start on verification', () => {
  it('a verified rider gets a 14-day mover-rate trial, never charged yet', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { userId, riderId } = await makeRider();

    const result = track(await subscriptions.startTrialForRider(riderId, now));
    expect(result?.created).toBe(true);

    const sub = result!.subscription;
    expect(sub.status).toBe('TRIAL');
    expect(sub.isTrialActive).toBe(true);
    expect(Number(sub.weeklyRate)).toBe(12000); // mover tier
    expect(sub.trialEndDate?.toISOString()).toBe(new Date(now.getTime() + 14 * DAY).toISOString());
    // First charge is queued for the moment the trial ends, not before
    expect(sub.nextBillingDate.toISOString()).toBe(sub.trialEndDate?.toISOString());

    const started = await app.prisma.notification.findFirst({
      where: { userId, data: { path: ['kind'], equals: 'trial_started' } },
    });
    expect(started).not.toBeNull();
  });

  it('re-verifying is idempotent — no second subscription, no second fee', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { riderId } = await makeRider();

    const first = track(await subscriptions.startTrialForRider(riderId, now));
    const second = await subscriptions.startTrialForRider(riderId, now);

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.subscription.id).toBe(first?.subscription.id);
    const count = await app.prisma.subscription.count({ where: { riderId } });
    expect(count).toBe(1);
  });

  it('a verified driver gets a taxi-driver trial at the mover rate', async () => {
    const { driverId } = await makeDriver();
    const result = track(await subscriptions.startTrialForDriver(driverId));
    expect(result?.subscription.type).toBe('TAXI_DRIVER');
    expect(Number(result?.subscription.weeklyRate)).toBe(12000);
  });

  it('an approved supermarket trials at the large-catalogue-agnostic small-vendor rate', async () => {
    const { vendorId } = await makeVendor('SUPERMARKET');
    const result = track(await subscriptions.startTrialForVendor(vendorId));
    expect(result?.subscription.type).toBe('SUPERMARKET');
    expect(Number(result?.subscription.weeklyRate)).toBe(20000); // smallVendor tier at start
  });

  it('an approved restaurant trials as RESTAURANT', async () => {
    const { vendorId } = await makeVendor('RESTAURANT');
    const result = track(await subscriptions.startTrialForVendor(vendorId));
    expect(result?.subscription.type).toBe('RESTAURANT');
    expect(Number(result?.subscription.weeklyRate)).toBe(20000);
  });
});

describe('The weekly cycle never touches a trial', () => {
  it('runBillingCycle skips a TRIAL even when its (future) due date has passed in clock terms', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { riderId } = await makeRider();
    const result = track(await subscriptions.startTrialForRider(riderId, now));
    const subId = result!.subscription.id;

    // Run the cycle well past the trial end — a TRIAL is simply not selected
    await billing.runBillingCycle(new Date(now.getTime() + 30 * DAY));

    const attempts = await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_ATTEMPT' } });
    expect(attempts).toBe(0);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('TRIAL');
  });
});

describe('Trial conversion', () => {
  it('does not convert before the trial ends', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { riderId } = await makeRider();
    track(await subscriptions.startTrialForRider(riderId, now));

    const converted = await subscriptions.convertExpiredTrials(new Date(now.getTime() + 13 * DAY));
    expect(converted).toBeGreaterThanOrEqual(0);
    const sub = await app.prisma.subscription.findFirstOrThrow({ where: { riderId } });
    expect(sub.status).toBe('TRIAL');
  });

  it('converts an expired trial to ACTIVE and due, then the cycle bills it', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { userId, riderId } = await makeRider();
    const result = track(await subscriptions.startTrialForRider(riderId, now));
    const subId = result!.subscription.id;
    const trialEnd = result!.subscription.trialEndDate!;

    const afterEnd = new Date(trialEnd.getTime() + DAY);
    const converted = await subscriptions.convertExpiredTrials(afterEnd);
    expect(converted).toBeGreaterThanOrEqual(1);

    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.isTrialActive).toBe(false);
    expect(sub.nextBillingDate.toISOString()).toBe(trialEnd.toISOString());

    const ended = await app.prisma.notification.findFirst({
      where: { userId, data: { path: ['kind'], equals: 'trial_ended' } },
    });
    expect(ended).not.toBeNull();

    // Now it IS billable. With no prepaid balance the first cash charge fails
    // and it lapses to PAST_DUE — exactly the normal missed-week path.
    const outcome = await billing.billSubscription(await subWithRelations(subId), afterEnd);
    expect(outcome).toBe('failed');
    const lapsed = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(lapsed.status).toBe('PAST_DUE');
  });

  it('a converted trial with a funded prepaid balance is charged successfully', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { riderId } = await makeRider();
    const result = track(await subscriptions.startTrialForRider(riderId, now));
    const subId = result!.subscription.id;
    const trialEnd = result!.subscription.trialEndDate!;

    await app.prisma.prepaidBalance.create({ data: { subscriptionId: subId, balance: 12000, currencyCode: 'GYD' } });

    const afterEnd = new Date(trialEnd.getTime() + DAY);
    await subscriptions.convertExpiredTrials(afterEnd);
    const outcome = await billing.billSubscription(await subWithRelations(subId), afterEnd);

    expect(outcome).toBe('succeeded');
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('ACTIVE');
    const balance = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } });
    expect(Number(balance.balance)).toBe(0);
  });
});

describe('Trial-ending reminders', () => {
  it('reminds once inside the 3-day window and is idempotent; ignores far-off trials', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { userId, riderId } = await makeRider();
    track(await subscriptions.startTrialForRider(riderId, now));

    // 12 days in, trial ends in ~2 days -> inside the window
    const remindAt = new Date(now.getTime() + 12 * DAY);
    const sent = await subscriptions.sendTrialEndingReminders(remindAt);
    expect(sent).toBeGreaterThanOrEqual(1);

    const again = await subscriptions.sendTrialEndingReminders(new Date(remindAt.getTime() + 60 * 1000));
    // Same trial must not be reminded twice (idempotency key)
    const reminders = await app.prisma.notification.count({
      where: { userId, data: { path: ['kind'], equals: 'trial_ending' } },
    });
    expect(reminders).toBe(1);
    expect(again).toBeGreaterThanOrEqual(0);
  });

  it('does not remind a trial that is still far from ending', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const { userId, riderId } = await makeRider();
    track(await subscriptions.startTrialForRider(riderId, now));

    // Day 1 — 13 days left, outside the 3-day window
    await subscriptions.sendTrialEndingReminders(new Date(now.getTime() + DAY));
    const reminders = await app.prisma.notification.count({
      where: { userId, data: { path: ['kind'], equals: 'trial_ending' } },
    });
    expect(reminders).toBe(0);
  });
});
