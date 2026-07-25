import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  calculateDeliveryFee,
  deliveryFeeFromRates,
  mergeDeliveryRates,
  DEFAULT_DELIVERY_RATES,
} from '../utils/markup';
import { CountryConfigService } from '../modules/country/country-config.service';

// ---------------------------------------------------------------------------
// FUL-003b: the food/grocery delivery fee now comes from CountryConfig
// (deliveryRates), defaulting to code — the same pattern courier/taxi use.
// The load-bearing invariant: a NULL config reproduces the old hardcoded
// behavior byte-for-byte, so no market's fee changes on deploy. A populated
// config drives the fee for a second market.
// ---------------------------------------------------------------------------

describe('deliveryFeeFromRates default-preservation (characterization)', () => {
  it('with DEFAULT_DELIVERY_RATES equals the old calculateDeliveryFee at every distance', () => {
    for (const km of [0, 0.5, 1, 2, 3, 4.7, 5, 10, 20, 37]) {
      expect(deliveryFeeFromRates(km, DEFAULT_DELIVERY_RATES)).toBe(calculateDeliveryFee(km));
    }
  });

  it('the code defaults are exactly the old function defaults (500 / 200 / 2 / 1.0)', () => {
    expect(DEFAULT_DELIVERY_RATES).toEqual({ baseFee: 500, perKmRate: 200, includedKm: 2, surgeMultiplier: 1.0 });
  });
});

describe('mergeDeliveryRates (tolerant)', () => {
  it('null / undefined / garbage → full defaults', () => {
    expect(mergeDeliveryRates(null)).toEqual(DEFAULT_DELIVERY_RATES);
    expect(mergeDeliveryRates(undefined)).toEqual(DEFAULT_DELIVERY_RATES);
    expect(mergeDeliveryRates('nonsense')).toEqual(DEFAULT_DELIVERY_RATES);
  });

  it('a partial config overrides only what it validly sets', () => {
    expect(mergeDeliveryRates({ baseFee: 800 })).toEqual({ ...DEFAULT_DELIVERY_RATES, baseFee: 800 });
    expect(mergeDeliveryRates({ perKmRate: 'bad' as unknown as number })).toEqual(DEFAULT_DELIVERY_RATES);
  });

  it('a full second-market schedule produces its own fee', () => {
    const rates = mergeDeliveryRates({ baseFee: 800, perKmRate: 300, includedKm: 1, surgeMultiplier: 1.0 });
    // 800 base + (4 - 1) * 300 = 1700
    expect(deliveryFeeFromRates(4, rates)).toBe(1700);
    // and it differs from the Georgetown default for the same trip
    expect(deliveryFeeFromRates(4, rates)).not.toBe(calculateDeliveryFee(4));
  });
});

describe('CountryConfigService.getDeliveryRates (reads config, resilient)', () => {
  let prisma: PrismaClient;
  let svc: CountryConfigService;
  const code = `QA${nanoid(4)}`.slice(0, 8);

  beforeAll(async () => {
    process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
    prisma = new PrismaClient();
    svc = new CountryConfigService(prisma);
    await prisma.countryConfig.create({
      data: {
        code, name: 'Testland', currencyCode: 'TST', usdExchangeRate: '1.0',
        subscriptionTiers: {}, documentChecklists: {},
        deliveryRates: { baseFee: 900, perKmRate: 250, includedKm: 1 }, // surge omitted → default 1.0
      },
    });
  });

  afterAll(async () => {
    await prisma.countryConfig.deleteMany({ where: { code } });
    await prisma.$disconnect();
  });

  it('a missing country falls back to defaults (no throw — delivery fee must never crash checkout)', async () => {
    expect(await svc.getDeliveryRates('ZZ_no_such_country')).toEqual(DEFAULT_DELIVERY_RATES);
  });

  it('a configured country returns its merged schedule', async () => {
    const rates = await svc.getDeliveryRates(code);
    expect(rates).toEqual({ baseFee: 900, perKmRate: 250, includedKm: 1, surgeMultiplier: 1.0 });
    // 900 + (5 - 1) * 250 = 1900
    expect(deliveryFeeFromRates(5, rates)).toBe(1900);
  });
});
