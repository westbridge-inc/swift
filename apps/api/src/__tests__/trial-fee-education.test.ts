import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { sweepTrialFeeEducation, firstPaymentFunnel } from '../modules/billing/trial-fee-education';
import { NotificationService } from '../modules/notification/notification.service';

// The trial first-payment funnel [san spec 21.4]: day-10 education, day-13
// exact-amount reminder — each stage exactly once (BillingEvent unique-key
// gate), SAN included, and the pilot metric derived from ledger rows.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => undefined }) } as never;
const notifications = new NotificationService(prisma, io);

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_009_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeTrial(daysLeft: number) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Edu', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Edu Vendor ${seq}`, slug: `edu-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '2 Funnel St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const end = new Date(Date.now() + daysLeft * 86_400_000);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'TRIAL', isTrialActive: true, trialEndDate: end,
      weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: end, nextBillingDate: end,
    },
  });
  subIds.push(sub.id);
  return { sub, userId: user.id };
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the trial fee-education sweep', () => {
  it('day-10 trials get the how-to (with SAN); day-13 get the exact amount; each stage once', async () => {
    const early = await makeTrial(3.5); // ~4 days left → d10 stage
    const late = await makeTrial(0.8); // <1 day → d13 stage

    const first = await sweepTrialFeeEducation(prisma, notifications);
    expect(first.day10).toBeGreaterThanOrEqual(1);
    expect(first.day13).toBeGreaterThanOrEqual(1);

    const earlyNotif = await prisma.notification.findFirst({ where: { userId: early.userId }, orderBy: { createdAt: 'desc' } });
    expect(earlyNotif?.body).toContain('MMG agent');
    expect(earlyNotif?.body).toMatch(/\d{3}-\d{3}-\d{4}/); // the SAN, grouped
    const lateNotif = await prisma.notification.findFirst({ where: { userId: late.userId }, orderBy: { createdAt: 'desc' } });
    expect(lateNotif?.body).toContain('GY$2,100');

    // Idempotent: a second sweep sends nothing new for these subs.
    const again = await sweepTrialFeeEducation(prisma, notifications);
    const eduEvents = await prisma.billingEvent.count({
      where: { subscriptionId: { in: [early.sub.id, late.sub.id] }, idempotencyKey: { startsWith: 'trialedu:' } },
    });
    expect(eduEvents).toBe(2);
    expect(again.day10 + again.day13).toBeLessThanOrEqual(first.day10 + first.day13);
  });

  it('the pilot metric derives paid-before-end from ledger rows', async () => {
    // A trial that ended yesterday and topped up the day before its end.
    const done = await makeTrial(-1);
    await prisma.subscription.update({ where: { id: done.sub.id }, data: { status: 'ACTIVE', isTrialActive: false } });
    await prisma.billingEvent.create({
      data: {
        subscriptionId: done.sub.id, type: 'PREPAID_TOPUP', amount: 2100,
        idempotencyKey: `edu-test:${nanoid(8)}`, createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    const funnel = await firstPaymentFunnel(prisma, 30);
    expect(funnel.trialsEnded).toBeGreaterThanOrEqual(1);
    expect(funnel.paidBeforeEnd).toBeGreaterThanOrEqual(1);
  });
});
