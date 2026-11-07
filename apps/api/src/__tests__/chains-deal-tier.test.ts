import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { weeklyFeeAmount, weeklyFeeFor } from '../modules/billing/subscription-fee';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [CHAINS · REVIEW-M #2211 S3-1] A chain deal is never above the branch's own tier fee, on any day — not only the day
// it is set. A custom rate used to stop the re-tier for good, so a branch that later qualified for a LOWER tier kept
// paying the deal above its tier: a discount become a surcharge. Now:
//  - the fee charged is the lower of the custom rate and the tier rate (weeklyFeeFor, the biller's one price);
//  - a chain-deal branch still follows its tier DOWN (two weekly passes, as every lower tier);
//  - a tier RISE is never moved in for it: it keeps its deal;
//  - a custom rate that is not a chain deal (the USD migration's freeze) is left exactly as before.
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const ownerIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];

async function branch(weeklyRate: number, customRate: number | null, deal: number | null) {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Tier', lastName: `Owner${userIds.length}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(u.id);
  const owner = await app.prisma.vendorOwner.create({ data: {
    userId: u.id,
    ...(deal !== null ? { dealWeeklyRate: deal, dealCurrencyCode: 'GYD', dealSetAt: new Date(), dealSetBy: 'founder-test', dealReason: 'chains tier test' } : {}),
  } });
  ownerIds.push(owner.id);
  const v = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Tier Branch ${wordFreeTag(6)}`, slug: `chain-tier-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Tier Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, acceptingOrders: true } });
  vendorIds.push(v.id);
  const due = new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({ data: {
    vendorId: v.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate, customRate, currencyCode: 'GYD', billingMethod: 'CASH',
    currentPeriodStart: new Date(), currentPeriodEnd: due, nextBillingDate: due } });
  subIds.push(sub.id);
  return sub.id;
}
const read = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  await app.prisma.platformConfig.deleteMany({ where: { OR: subIds.map((id) => ({ key: { endsWith: id } })) } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await purgeAuditLogs(app.prisma, { entityId: { in: subIds } }, 'test-cleanup:chains-deal-tier');
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[CHAINS] the price charged is never above the tier rate', () => {
  it('the lower of the custom rate and the tier rate; the tier rate alone without one', () => {
    expect(weeklyFeeAmount({ weeklyRate: 20000, customRate: 18000 })).toBe(18000);
    expect(weeklyFeeAmount({ weeklyRate: 15000, customRate: 18000 })).toBe(15000);
    expect(weeklyFeeAmount({ weeklyRate: 15000, customRate: null })).toBe(15000);
    expect(weeklyFeeAmount({ weeklyRate: 15000, customRate: 15000 })).toBe(15000);
    expect(weeklyFeeFor({ weeklyRate: 15000, customRate: 18000 })).toBe(15000);
  });
});

describe('[CHAINS] a chain-deal branch and the weekly re-tier', () => {
  it('follows its tier down below the deal and is charged the tier; keeps the deal when its tier rises; a frozen custom rate is untouched', async () => {
    const down = await branch(20000, 18000, 18000); // large tier, deal 18,000, no listings -> small tier (15,000)
    const up = await branch(12000, 11000, 11000); // tier below the card today -> the pass would RAISE it
    const frozen = await branch(20000, 20000, null); // the USD migration's freeze: not a chain deal
    const t = Date.now();
    await billing.recalculateVendorTiers(new Date(t));
    await billing.recalculateVendorTiers(new Date(t + 7 * DAY));

    const d = await read(down);
    expect(Number(d.weeklyRate), 'the deal branch moved down its tier').toBe(15000);
    expect(Number(d.customRate), 'its deal stays on record').toBe(18000);
    expect(weeklyFeeAmount(d), 'and it is charged the lower tier, never the deal above it').toBe(15000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: down, type: 'TIER_CHANGE' } })).toBe(1);

    const u = await read(up);
    expect(Number(u.weeklyRate), 'a rise is never moved in for a deal branch').toBe(12000);
    expect(weeklyFeeAmount(u), 'it keeps its deal').toBe(11000);
    expect(await app.prisma.platformConfig.count({ where: { key: { endsWith: up } } }), 'no rise is held for it').toBe(0);

    const f = await read(frozen);
    expect({ weeklyRate: Number(f.weeklyRate), customRate: Number(f.customRate) }).toEqual({ weeklyRate: 20000, customRate: 20000 });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: frozen, type: 'TIER_CHANGE' } })).toBe(0);
  });
});
