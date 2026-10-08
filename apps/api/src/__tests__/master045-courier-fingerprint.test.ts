import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { pricingDefaults, pricingPayloadHash, readPricingConfig } from '../modules/country/pricing-config';

// ---------------------------------------------------------------------------
// [MASTER-045] A pricing fingerprint covers every nested rate.
//
// The payload hash serialized with a key allow-list taken from the TOP level
// only, so every nested object (the courier's size surcharges and speed
// multipliers) hashed as `{}`. Two courier configs that price differently had
// the same fingerprint, and a nested-only change discovered by the reader kept
// the previous version number. The hash is now a recursive canonical form:
// every value counts, key order does not.
// ---------------------------------------------------------------------------

const Q4 = 'Q4';
const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
type Courier = { baseFee: number; perKmRate: number; sizeSurcharge: Record<string, number>; speedMultiplier: Record<string, number> };
const base = () => pricingDefaults('COURIER_RATES') as unknown as Courier;

beforeAll(async () => {
  await prisma.pricingConfigVersion.deleteMany({ where: { countryCode: Q4 } });
  await prisma.countryConfig.deleteMany({ where: { code: Q4 } });
  await prisma.countryConfig.create({
    data: {
      code: Q4, name: 'Q4 Fingerprint Market', currencyCode: 'QQD', currencySymbol: 'Q$', usdExchangeRate: 100, isActive: false,
      subscriptionTiers: { mover: 1000, smallVendor: 2000, largeVendor: 5000 }, documentChecklists: {},
    },
  });
});

afterAll(async () => {
  await prisma.pricingConfigVersion.deleteMany({ where: { countryCode: Q4 } });
  await prisma.countryConfig.deleteMany({ where: { code: Q4 } });
  await prisma.$disconnect();
});

const setCourier = (payload: unknown) => prisma.countryConfig.update({ where: { code: Q4 }, data: { courierRates: payload as never } });

describe('[MASTER-045] the pricing fingerprint covers nested rates', () => {
  it('changing any single nested surcharge or speed multiplier changes the fingerprint', () => {
    const h0 = pricingPayloadHash(base() as never);
    const seen = new Set([h0]);
    for (const size of ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']) {
      const p = base(); p.sizeSurcharge[size] = (p.sizeSurcharge[size] ?? 0) + 1;
      seen.add(pricingPayloadHash(p as never));
    }
    for (const speed of ['EXPRESS', 'RUSH']) {
      const p = base(); p.speedMultiplier[speed] = (p.speedMultiplier[speed] ?? 1) + 0.25;
      seen.add(pricingPayloadHash(p as never));
    }
    expect(seen.size).toBe(1 + 4 + 2);
  });

  it('property order alone, at any depth, does not change the fingerprint', () => {
    const p = base();
    const reordered = {
      speedMultiplier: Object.fromEntries(Object.entries(p.speedMultiplier).reverse()),
      sizeSurcharge: Object.fromEntries(Object.entries(p.sizeSurcharge).reverse()),
      perKmRate: p.perKmRate,
      baseFee: p.baseFee,
    };
    expect(pricingPayloadHash(reordered as never)).toBe(pricingPayloadHash(p as never));
  });

  it('flat kinds keep the fingerprint they were recorded with', () => {
    // A flat payload's canonical form is unchanged, so no taxi/delivery/class
    // version is re-recorded by the fix.
    for (const kind of ['TAXI_RATES', 'TAXI_CLASS_RATES', 'DELIVERY_RATES'] as const) {
      const p = pricingDefaults(kind);
      const legacy = JSON.stringify(p, Object.keys(p).sort());
      expect(pricingPayloadHash(p)).toBe(createHash('sha256').update(legacy).digest('hex').slice(0, 32));
    }
  });

  it('a nested-only change discovered by the reader is a new version that reproduces the exact payload; an unchanged read is not', async () => {
    const first = base();
    first.sizeSurcharge['LARGE'] = 1500;
    await setCourier(first);
    const r1 = await readPricingConfig<Courier>(prisma, Q4, 'COURIER_RATES');
    expect(r1.source).toBe('config');
    const v1 = r1.version!;
    expect(v1).toBeGreaterThan(0);

    const again = await readPricingConfig<Courier>(prisma, Q4, 'COURIER_RATES');
    expect(again.version).toBe(v1);

    const second = base();
    second.sizeSurcharge['LARGE'] = 1750;
    second.speedMultiplier['RUSH'] = 2.5;
    await setCourier(second);
    const r2 = await readPricingConfig<Courier>(prisma, Q4, 'COURIER_RATES');
    expect(r2.version).toBe(v1 + 1);
    const stored = await prisma.pricingConfigVersion.findUniqueOrThrow({ where: { countryCode_kind_version: { countryCode: Q4, kind: 'COURIER_RATES', version: r2.version! } } });
    expect(stored.payload).toEqual(r2.payload);
    expect((stored.payload as unknown as Courier).sizeSurcharge['LARGE']).toBe(1750);
    expect((stored.payload as unknown as Courier).speedMultiplier['RUSH']).toBe(2.5);

    // An invalid later column falls back to THAT version's nested rates, not the first.
    await setCourier({ ...second, sizeSurcharge: { ...second.sizeSurcharge, LARGE: -1 } });
    const fallback = await readPricingConfig<Courier>(prisma, Q4, 'COURIER_RATES');
    expect(fallback.source).toBe('last_known_good');
    expect(fallback.version).toBe(r2.version);
    expect(fallback.payload.sizeSurcharge['LARGE']).toBe(1750);
  });

  it('a version recorded under the old fingerprint with the same payload is recognised, not re-recorded', async () => {
    const p = base();
    p.sizeSurcharge['SMALL'] = 99;
    await setCourier(p);
    const latest = await readPricingConfig<Courier>(prisma, Q4, 'COURIER_RATES');
    // Simulate history: the stored hash was computed the old (nested-blind) way.
    const legacyHash = createHash('sha256').update(JSON.stringify(latest.payload, Object.keys(latest.payload).sort())).digest('hex').slice(0, 32);
    await prisma.pricingConfigVersion.update({
      where: { countryCode_kind_version: { countryCode: Q4, kind: 'COURIER_RATES', version: latest.version! } },
      data: { payloadHash: legacyHash },
    });
    const reread = await readPricingConfig<Courier>(prisma, Q4, 'COURIER_RATES');
    expect(reread.version).toBe(latest.version);
  });
});
