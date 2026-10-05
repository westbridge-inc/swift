import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { sweepTrialFeeEducation, firstPaymentFunnel } from '../modules/billing/trial-fee-education';
import { NotificationService } from '../modules/notification/notification.service';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// The trial first-payment funnel [san spec 21.4]: day-10 and day-13 notices
// of the first fee — each stage exactly once (BillingEvent unique-key gate) —
// and the pilot metric derived from ledger rows. [owner, 2026-09-29] Partners
// pay on the MMG checkout in the Swift app: a notice names it only while it is
// live, otherwise the amount and when it is due, and never an MMG agent, cash
// or a Swift Number (the SAN digits no longer ride in the message).

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
  await cleanupBillingClocks(prisma, subIds);
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
  it('day-10 trials get the due date; day-13 get the exact amount; neither carries the SAN or an agent; each stage once', async () => {
    const early = await makeTrial(3.5); // ~4 days left → d10 stage
    const late = await makeTrial(0.8); // <1 day → d13 stage

    const first = await sweepTrialFeeEducation(prisma, notifications);
    expect(first.day10).toBeGreaterThanOrEqual(1);
    expect(first.day13).toBeGreaterThanOrEqual(1);

    // The owner, 29 Sep: partners pay the weekly fee on the checkout page, with
    // MMG, in the app. Its MMG action is not live yet, so the notice says it
    // opens soon; it never names an agent, cash or the Swift Number, and never
    // prints the number (`123 456 7890`) for a counter.
    const closedDoors = /\bagents?\b|swift number|\bcash\b|\d{3}\D\d{3}\D\d{4}/i;
    const earlyNotif = await prisma.notification.findFirst({ where: { userId: early.userId }, orderBy: { createdAt: 'desc' } });
    // The checkout is off here (MMG_CHECKOUT_ENABLED unset): the amount and when
    // it is due, and no way to pay promised.
    expect(earlyNotif?.body).toContain('Your first weekly fee of GY$2,100 is due on');
    const lateNotif = await prisma.notification.findFirst({ where: { userId: late.userId }, orderBy: { createdAt: 'desc' } });
    expect(lateNotif?.body).toContain('GY$2,100');
    for (const body of [earlyNotif?.body, lateNotif?.body]) {
      expect(body).not.toMatch(/MMG agent|any agent|Swift Number|account number|pay cash|coming soon|with MMG in the Swift app/i);
      expect(body, 'the SAN no longer rides in a message').not.toMatch(/\d{3} \d{3} \d{4}/);
      expect(body).not.toMatch(closedDoors);
    }

    // Idempotent: a second sweep sends nothing new for these subs.
    const again = await sweepTrialFeeEducation(prisma, notifications);
    const eduEvents = await prisma.billingEvent.count({
      where: { subscriptionId: { in: [early.sub.id, late.sub.id] }, idempotencyKey: { startsWith: 'trialedu:' } },
    });
    expect(eduEvents).toBe(2);
    expect(again.day10 + again.day13).toBeLessThanOrEqual(first.day10 + first.day13);
  });

  it('while the MMG checkout is live the notice points to it; a wallet that covers the fee is told so, never asked again', async () => {
    const before = process.env['MMG_CHECKOUT_ENABLED'];
    process.env['MMG_CHECKOUT_ENABLED'] = '1';
    try {
      const owing = await makeTrial(3.5);
      const covered = await makeTrial(3.5);
      await prisma.prepaidBalance.create({ data: { subscriptionId: covered.sub.id, balance: 2100 } });
      await sweepTrialFeeEducation(prisma, notifications);
      const told = await prisma.notification.findFirst({ where: { userId: owing.userId }, orderBy: { createdAt: 'desc' } });
      expect(told?.body).toContain('Pay GY$2,100 with MMG in the Swift app.');
      const coveredNotice = await prisma.notification.findFirst({ where: { userId: covered.userId }, orderBy: { createdAt: 'desc' } });
      expect(coveredNotice?.body).toContain('Your balance already covers your first weekly fee of GY$2,100.');
      expect(coveredNotice?.body).not.toMatch(/Pay GY\$/);
    } finally {
      if (before === undefined) delete process.env['MMG_CHECKOUT_ENABLED'];
      else process.env['MMG_CHECKOUT_ENABLED'] = before;
    }
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
