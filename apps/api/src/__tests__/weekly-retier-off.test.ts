import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { WEEKLY_RETIER_ON } from '../modules/billing/weekly-retier';
import { syntheticLocationOwner } from './helpers/online-mover';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · R27, research F2] Until partners are told
// 14 days ahead, no partner moves to a new weekly fee. The scheduled weekly
// re-tier (tier-recalc) used to move every existing partner to the fee the
// rate card, their catalogue or their vehicle now gives them, at once and
// with no notice. It is OFF: the job moves nobody, up or down, and writes
// nothing.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// This file's own fixture block (+5920335nnn). No other file uses 5920335.
const PHONE_PREFIX = '+5920335';

let app: FastifyInstance;
let billing: BillingService;
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Retier', lastName: `Off${seq}`, roles, activeRole, countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  return user.id;
}

/** A motorbike delivery rider (the card says 6,000) on `weeklyRate`. */
async function makeRider(weeklyRate: number) {
  const userId = await makeUser(['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('weekly-retier-off') },
  });
  const due = new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate, billingMethod: 'CASH', autoRenew: true,
      currentPeriodStart: new Date(due.getTime() - WEEK), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  return sub.id;
}

/** A restaurant with no listings (the small tier, 15,000) on `weeklyRate`. */
async function makeVendor(weeklyRate: number) {
  const userId = await makeUser(['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Retier Off Kitchen ${seq}`, slug: `retier-off-${seq}-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: '1 Notice Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  const due = new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate, billingMethod: 'CASH', autoRenew: true,
      currentPeriodStart: new Date(due.getTime() - WEEK), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  return sub.id;
}

const rate = async (subId: string) => Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).weeklyRate);
const tierEvents = (subId: string) => app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'TIER_CHANGE' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await purgeBlock();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

async function purgeBlock() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const subs = await app.prisma.subscription.findMany({
    where: { OR: [{ rider: { userId: { in: ids } } }, { vendor: { owner: { userId: { in: ids } } } }] }, select: { id: true },
  });
  const sids = subs.map((s) => s.id);
  await cleanupBillingClocks(app.prisma, sids);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
  await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...sids, ...ids] } }, { userId: { in: ids } }] }, 'test-cleanup:weekly-retier-off');
  await app.prisma.subscription.deleteMany({ where: { id: { in: sids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

afterAll(async () => {
  await purgeBlock();
  await app.close();
});

describe('[R27] the weekly re-tier is OFF until partners are told 14 days ahead', () => {
  it('the scheduled re-tier moves nobody, up or down, and writes nothing', async () => {
    const riderUp = await makeRider(5000); // the card says 6,000: would have gone UP at once
    const riderDown = await makeRider(8000); // would have gone DOWN at once
    const storeDown = await makeVendor(20000); // no listings = small tier 15,000

    const result = await billing.runWeeklyRetier();

    expect(result).toEqual({ on: false, vendorsChanged: 0, moversChanged: 0 });
    expect(await rate(riderUp)).toBe(5000);
    expect(await rate(riderDown)).toBe(8000);
    expect(await rate(storeDown)).toBe(20000);
    for (const id of [riderUp, riderDown, storeDown]) expect(await tierEvents(id)).toBe(0);
  });

  it('is a constant, reviewed as code, never an environment flip', () => {
    expect(WEEKLY_RETIER_ON).toBe(false);
    const module = readFileSync(join(__dirname, '../modules/billing/weekly-retier.ts'), 'utf8');
    expect(module).not.toMatch(/process\.env|env\[/);
  });

  it('the tier-recalc job runs the switched re-tier, never the passes directly', () => {
    const queue = readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8');
    const start = queue.indexOf("case 'tier-recalc':");
    expect(start).toBeGreaterThan(-1);
    const body = queue.slice(start, queue.indexOf('break;', start));
    expect(body).toContain('billing.runWeeklyRetier()');
    // Nothing scheduled anywhere calls a pass on its own.
    expect(queue).not.toMatch(/recalculate(Vendor|Mover)Tiers\(/);
  });
});
