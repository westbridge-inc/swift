import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// BILLING-REANCHOR (coordinator ruling 4 Oct under the owner's delegation,
// OWNER-DECISIONS "Weekly-fee arrears after a pause"): "No arrears for weeks a
// partner was switched off/paused or suspended and not operating; billing
// restarts at the week they return." A payment that reinstates a SUSPENDED or
// CHURNED partner buys the week starting when they come back, never a week
// they spent switched off, and the next charge is due a week after the return.
// A PAST_DUE partner (still operating inside the grace) keeps the old anchor.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RATE = 20000;

let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_009_500_000 + Math.floor(Math.random() * 400_000);

async function brokeVendorSub(due: Date) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Anchor', lastName: `U${seq}`, roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Anchor Vendor ${seq}`, slug: `anchor-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 200_000 + seq}`,
      addressLine1: '1 Anchor St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: RATE, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      prepaidBalance: { create: { balance: 0 } },
    },
  });
  subIds.push(sub.id);
  return { vendorId: vendor.id, subId: sub.id };
}

/** Three failed charges over 50 h: the billing suspension, starting at `due`. */
async function suspendFrom(subId: string, due: Date) {
  await billing.runBillingCycle(due);
  await billing.runBillingCycle(new Date(due.getTime() + 25 * HOUR));
  await billing.runBillingCycle(new Date(due.getTime() + 50 * HOUR));
  expect((await sub(subId)).status).toBe('SUSPENDED');
}

const sub = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const balance = async (id: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: id } })).balance);
const successes = (id: string) => app.prisma.billingEvent.count({ where: { subscriptionId: id, type: 'CHARGE_SUCCESS' } });
const attempts = (id: string) => app.prisma.billingEvent.count({ where: { subscriptionId: id, type: 'CHARGE_ATTEMPT' } });

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
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  // [#1393] Clock evidence first (RESTRICT FKs), then the events, then the rows.
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('BILLING-REANCHOR — a returning partner pays from the week they return', () => {
  it('suspended 3 weeks, pays: one week is spent, it starts at the return, and nothing is re-billed at once', async () => {
    const due = new Date(Date.now() - 21 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);

    const before = Date.now();
    // Two weeks of money: a stale anchor would spend it on switched-off weeks.
    await billing.recordTopUp(v.subId, 2 * RATE, 'admin-test', 'return', nanoid(10));
    const after = Date.now();

    const s = await sub(v.subId);
    expect(s.status).toBe('ACTIVE');
    expect(s.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(s.currentPeriodStart.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()).toBe(7 * DAY);
    expect(s.nextBillingDate.getTime()).toBe(s.currentPeriodEnd.getTime());
    expect(await successes(v.subId)).toBe(1);
    expect(await balance(v.subId)).toBe(RATE); // the second week's money is still theirs

    // The hourly run right after the return bills nothing more.
    const attemptsBefore = await attempts(v.subId);
    await billing.runBillingCycle(new Date(after + HOUR));
    expect(await attempts(v.subId)).toBe(attemptsBefore);
    expect(await successes(v.subId)).toBe(1);
    expect(await balance(v.subId)).toBe(RATE);
    expect((await sub(v.subId)).status).toBe('ACTIVE');
  });

  it('a churned partner rejoining is not dunned for the month they were gone', async () => {
    const due = new Date(Date.now() - 40 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    await billing.sweepSuspended(new Date(due.getTime() + 50 * HOUR + 31 * DAY));
    expect((await sub(v.subId)).status).toBe('CHURNED');

    const before = Date.now();
    await billing.recordTopUp(v.subId, RATE, 'admin-test', 'rejoin', nanoid(10));
    const s = await sub(v.subId);
    expect(s.status).toBe('ACTIVE');
    expect(s.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(s.nextBillingDate.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);

    // The next hourly run finds nothing due; the partner is not re-suspended.
    await billing.runBillingCycle(new Date(Date.now() + HOUR));
    await billing.runBillingCycle(new Date(Date.now() + 25 * HOUR));
    await billing.runBillingCycle(new Date(Date.now() + 50 * HOUR));
    expect((await sub(v.subId)).status).toBe('ACTIVE');
    expect(await successes(v.subId)).toBe(1);
  });

  it('a PAST_DUE partner still in the grace (still operating) pays the week that was due: no re-anchor', async () => {
    const due = new Date(Date.now() - 2 * HOUR);
    const v = await brokeVendorSub(due);
    await billing.runBillingCycle(due);
    expect((await sub(v.subId)).status).toBe('PAST_DUE');

    await billing.recordTopUp(v.subId, RATE, 'admin-test', 'late but in grace', nanoid(10));
    const s = await sub(v.subId);
    expect(s.status).toBe('ACTIVE');
    expect(s.currentPeriodStart.getTime()).toBe(due.getTime());
    expect(s.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
  });

  it('a repeated top-up key credits once and reinstates once', async () => {
    const due = new Date(Date.now() - 14 * DAY);
    const v = await brokeVendorSub(due);
    await suspendFrom(v.subId, due);
    const key = nanoid(10);
    await billing.recordTopUp(v.subId, RATE, 'admin-test', 'return', key);
    const first = await sub(v.subId);
    await billing.recordTopUp(v.subId, RATE, 'admin-test', 'return', key).catch(() => undefined);
    const second = await sub(v.subId);
    expect(second.nextBillingDate.getTime()).toBe(first.nextBillingDate.getTime());
    expect(await successes(v.subId)).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: v.subId, type: 'REINSTATED' } })).toBe(1);
  });
});
