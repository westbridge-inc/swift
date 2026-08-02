import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { payInfo } from '../modules/billing/agent-cash.service';

// System 2 ③ — the dual-currency display line. USD is truth, local settles:
// the SERVER composes the line ("US$25.00 / week · GY$5,200 this week") and
// only when the founder has enabled usdPricingEnabled + displayDual; until
// then usdDisplay is null and every screen renders the local-only line it
// always did (ships dark). Mode-B grandfathered subs (customRate frozen)
// stay single-currency by design — their price is deliberately NOT the book.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const entryIds: string[] = [];
const rateIds: string[] = [];
let seq = 0;
const phoneBase = 592_011_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorSub(over: Record<string, unknown> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Dual', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Dual Vendor ${seq}`, slug: `dual-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '5 Rate Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 5200, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
      ...over,
    } as never,
  });
  subIds.push(sub.id);
  return sub;
}

async function setUsdEnabled(on: boolean) {
  await prisma.tenantBillingCurrency.upsert({
    where: { tenantId: 'swift-default' },
    create: { tenantId: 'swift-default', settlementCurrency: 'GYD', roundingIncrement: 100, usdPricingEnabled: on, displayDual: true },
    update: { usdPricingEnabled: on, displayDual: true },
  });
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await setUsdEnabled(false); // same restore law as usd-pricing-pinning
  await prisma.priceBookEntry.deleteMany({ where: { id: { in: entryIds } } });
  await prisma.fxRate.deleteMany({ where: { id: { in: rateIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the dual-display line (dark until enabled)', () => {
  it('null while USD pricing is off; composed by the server once enabled; Mode-B stays single-currency', async () => {
    const sub = await makeVendorSub();
    await setUsdEnabled(false);
    const dark = await payInfo(prisma, sub);
    expect(dark.usdDisplay).toBeNull(); // ships dark — screens keep the local line

    const entry = await prisma.priceBookEntry.create({ data: { role: 'VENDOR', amountUsd: 25 } });
    entryIds.push(entry.id);
    const rate = await prisma.fxRate.create({
      data: { base: 'USD', quote: 'GYD', rate: 208, source: 'FOUNDER_MANUAL', setByUserId: 'dual-test', effectiveFrom: new Date(Date.now() - 60_000) },
    });
    rateIds.push(rate.id);

    try {
      await setUsdEnabled(true);
      const lit = await payInfo(prisma, sub);
      expect(lit.usdDisplay).not.toBeNull();
      expect(lit.usdDisplay!.amountUsd).toBe(25);
      expect(lit.usdDisplay!.rateUsed).toBe(208);
      expect(lit.usdDisplay!.line).toBe('US$25.00 / week · GY$5,200 this week');
      // The local numbers are untouched by the display layer.
      expect(lit.weeklyFeeGyd).toBe(5200);

      // Mode-B freeze: customRate present → deliberately single-currency.
      const frozen = await makeVendorSub({ customRate: 4800 });
      const frozenInfo = await payInfo(prisma, frozen);
      expect(frozenInfo.usdDisplay).toBeNull();
      expect(frozenInfo.weeklyFeeGyd).toBe(4800);
    } finally {
      await setUsdEnabled(false);
    }
  });
});
