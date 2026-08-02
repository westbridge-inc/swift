import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { convertUsdToLocal, formatMoney, resolveRateForRun } from '../modules/billing/fx';

// System 2 acceptance: the Trinidad proof. USD-is-truth means a second market
// is CONFIG, not code — a TTD tenant (increment TT$1, ~6.75/USD) prices the
// same USD book through the same one conversion function. No TTD branch
// exists anywhere; this test proves none is needed.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const rateIds: string[] = [];

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.fxRate.deleteMany({ where: { id: { in: rateIds } } });
  await prisma.tenantBillingCurrency.deleteMany({ where: { tenantId: 'tt-proof-tenant' } });
  await prisma.$disconnect();
});

describe('the TTD tenant proof (config, not code)', () => {
  it('prices the USD book in TT$ through the same conversion function', () => {
    // US$25/week at 6.75 with a TT$1 increment.
    const r = convertUsdToLocal(25, 6.75, 1);
    expect(r.amountLocal).toBe(169); // 168.75 → HALF_UP to 169
    expect(formatMoney(r.amountLocal, 'TTD')).toBe('TT$169.00');
    // The GYD path is untouched by TTD existing: US$25 at 208 rounds on 100s.
    const gy = convertUsdToLocal(25, 208, 100);
    expect(gy.amountLocal).toBe(5200);
    expect(formatMoney(gy.amountLocal, 'GYD')).toBe('GY$5,200');
  });

  it('a TTD tenant config + pinned TTD rate resolve exactly like GYD does', async () => {
    await prisma.tenantBillingCurrency.upsert({
      where: { tenantId: 'tt-proof-tenant' },
      create: { tenantId: 'tt-proof-tenant', settlementCurrency: 'TTD', roundingIncrement: 1, usdPricingEnabled: true },
      update: { settlementCurrency: 'TTD', roundingIncrement: 1, usdPricingEnabled: true },
    });
    const rate = await prisma.fxRate.create({
      data: { base: 'USD', quote: 'TTD', rate: 6.75, source: 'FOUNDER_MANUAL', setByUserId: 'ttd-proof-test', effectiveFrom: new Date(Date.now() - 60_000) },
    });
    rateIds.push(rate.id);

    const resolved = await resolveRateForRun(prisma, 'TTD');
    expect(resolved).not.toBeNull();
    expect(Number(resolved!.rate)).toBe(6.75);

    // The week's fee for a US$25 plan in this tenant:
    const tenant = await prisma.tenantBillingCurrency.findUniqueOrThrow({ where: { tenantId: 'tt-proof-tenant' } });
    const fee = convertUsdToLocal(25, Number(resolved!.rate), Number(tenant.roundingIncrement));
    expect(formatMoney(fee.amountLocal, tenant.settlementCurrency)).toBe('TT$169.00');
  });

  it('minimum-clamp behaves for tiny USD amounts in TTD', () => {
    const r = convertUsdToLocal(0.05, 6.75, 1);
    expect(r.amountLocal).toBeGreaterThanOrEqual(1); // never rounds to zero — MIN_CLAMPED
    expect(r.minClamped).toBe(true);
  });
});
