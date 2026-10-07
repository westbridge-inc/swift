import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_CLASS_RATES, DEFAULT_TAXI_RATES, readCourierRates, readDeliveryRates, readTaxiRates, validatePricingConfig, type TaxiRates,
} from '../modules/country/pricing-config';
import { DEFAULT_DELIVERY_RATES, calculateCourierFee, calculateDeliveryFee } from '../utils/markup';
import { DEFAULT_COURIER_RATES, estimateCourierFee, type DeliverySpeed, type PackageSize } from '../modules/courier/courier.service';
import { FareService, applyClassMultiplier, formulaFare } from '../modules/rides/fare.service';
import { planVendorGroup } from '../modules/order/cart-plans';
import { desiredPlatformConfig, PLATFORM_CONFIG_VERSION } from '../modules/ops/platform-config';
import { pricingConfigCounter } from '../plugins/observability';
import type { LatLng, MapsProvider, RouteEstimate, RouteLeg, RouteLegsEstimate } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// [PRICING-GY-OCT] The owner's Georgetown fares (1 Oct 2026) are the code
// defaults, and a fresh database starts on them.
//
//   Taxi (Guyana): 800 covers the first 3 km, then 175 a km. No per-minute
//     charge, and no minimum above the base. Class multipliers unchanged.
//   Delivery: 500 covers the first 3 km, then 100 a km. No surge.
//   Courier: 800 + 120 a km. Size surcharges and speed multipliers unchanged.
//
// The worked examples are the owner's, through the code's own rounding: a taxi
// fare is max(minimum, round((base + perKm × (km − includedKm) + perMin × min)
// / 100) × 100), a half rounding up, so 10 km (2,025) is 2,000 and 41 km
// (7,450) is 7,500. Delivery rounds up to a whole dollar; courier to the
// nearest. Every copy of a rate outside its one home reads it, or is pinned to
// it here.
// ---------------------------------------------------------------------------

const SPINE = desiredPlatformConfig();
const GY = SPINE.countries.find((c) => c.code === 'GY')!;
const GY_ROW = GY.create;

/** The slice of Prisma the fare engine and the pricing readers touch,
 *  answering with the Guyana row the seed spine creates (or `taxiRates` given
 *  in its place): no zones, no version recorded yet. */
function seededGuyana(taxiRates: unknown = GY_ROW['taxiRates'] ?? null): PrismaClient {
  return {
    zone: { findMany: async () => [] },
    zoneFare: { findUnique: async () => null, findMany: async () => [] },
    countryConfig: {
      findUnique: async () => ({
        code: 'GY',
        currencyCode: GY_ROW['currencyCode'],
        taxiRates,
        taxiClassRates: GY_ROW['taxiClassRates'] ?? null,
        deliveryRates: GY_ROW['deliveryRates'] ?? null,
        courierRates: GY_ROW['courierRates'] ?? null,
      }),
    },
    pricingConfigVersion: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => args.data,
    },
  } as unknown as PrismaClient;
}

/** Georgetown, and a stop and a drop-off nearby (inside Guyana). */
const PICKUP: LatLng = { lat: 6.8013, lng: -58.1553 };
const STOP: LatLng = { lat: 6.8080, lng: -58.1500 };
const DROPOFF: LatLng = { lat: 6.8143, lng: -58.1443 };

/** A routing engine that answers one route of `km` and `minutes`. */
const engine = (km: number, minutes: number | null): MapsProvider =>
  ({ routeKm: async (): Promise<RouteEstimate> => ({ km, minutes, source: 'osrm' }) }) as unknown as MapsProvider;

/** A routing engine that answers a whole itinerary from these legs. */
const legsEngine = (legs: RouteLeg[]): MapsProvider =>
  ({
    routeLegs: async (): Promise<RouteLegsEstimate> => ({
      legs,
      km: legs.reduce((sum, l) => sum + l.km, 0),
      minutes: legs.reduce((sum, l) => sum + (l.minutes ?? 0), 0),
      source: 'osrm',
      degraded: false,
    }),
  }) as unknown as MapsProvider;

const fares = (est: { tiers: Array<{ rideClass: string; fare: number }> }) => Object.fromEntries(est.tiers.map((t) => [t.rideClass, t.fare]));

async function quote(km: number, minutes: number | null, prisma: PrismaClient = seededGuyana()) {
  return fares(await new FareService(prisma, engine(km, minutes)).estimateTiers(PICKUP, DROPOFF, 'GY'));
}

const shadowDiffs = async () =>
  (await pricingConfigCounter.get()).values.find((v) => v.labels['event'] === 'shadow_diff' && v.labels['kind'] === 'TAXI_RATES')?.value ?? 0;

/** [km, the engine's minutes (the 25 km/h speed model's), 800 + 175 × (km − 3), the Economy fare]. */
const TAXI_WORKED: Array<[number, number, string, number]> = [
  [2, 5, '800', 800],
  [3, 8, '800', 800],
  [3.4, 9, '870', 900],
  [4, 10, '975', 1000],
  [5, 12, '1,150', 1200],
  [7, 17, '1,500', 1500],
  [10, 24, '2,025', 2000],
  [20, 48, '3,775', 3800],
  [41, 99, '7,450', 7500],
];

describe('the owner’s Georgetown fares are the declared defaults', () => {
  it('taxi: 800 covers the first 3 km, then 175 a km; no per-minute charge; the minimum is the base', () => {
    expect(DEFAULT_TAXI_RATES).toEqual({ base: 800, includedKm: 3, perKm: 175, perMin: 0, minimum: 800 });
  });

  it('taxi classes are unchanged: Comfort ×1.35, XL ×1.8, Group ×2.5', () => {
    expect(DEFAULT_CLASS_RATES).toEqual({ ECONOMY: 1, COMFORT: 1.35, XL: 1.8, GROUP: 2.5 });
  });

  it('delivery: 500 covers the first 3 km, then 100 a km; no surge', () => {
    expect(DEFAULT_DELIVERY_RATES).toEqual({ baseFee: 500, perKmRate: 100, includedKm: 3, surgeMultiplier: 1 });
  });

  it('courier: 800 + 120 a km; the size surcharges and speed multipliers are unchanged', () => {
    expect(DEFAULT_COURIER_RATES).toEqual({
      baseFee: 800,
      perKmRate: 120,
      sizeSurcharge: { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 },
      speedMultiplier: { STANDARD: 1, EXPRESS: 1.5, RUSH: 2 },
    });
  });
});

describe('a fresh database starts on them: the seed spine', () => {
  it('Guyana is created with the taxi default (a copy), and with no delivery or courier column, so those price from the defaults', () => {
    expect(GY_ROW['taxiRates']).toEqual(DEFAULT_TAXI_RATES);
    expect(GY.policy['taxiRates']).toEqual(DEFAULT_TAXI_RATES);
    expect(GY_ROW['taxiRates']).not.toBe(DEFAULT_TAXI_RATES);
    expect(GY_ROW).not.toHaveProperty('deliveryRates');
    expect(GY_ROW).not.toHaveProperty('courierRates');
  });

  it('a changed spine is a new config version, never the one that carried the previous Guyana card', () => {
    expect(SPINE.version).toBe(PLATFORM_CONFIG_VERSION);
    expect(PLATFORM_CONFIG_VERSION).not.toBe('2026-09-29.1');
  });

  it('Georgetown Central is created with the delivery default (no price reads these two zone columns)', () => {
    const central = SPINE.zones.find((z) => z.id === 'georgetown-central')!.create;
    expect([central['deliveryBaseFee'], central['deliveryPerKm']]).toEqual([DEFAULT_DELIVERY_RATES.baseFee, DEFAULT_DELIVERY_RATES.perKmRate]);
  });

  it('re-pricing Guyana re-prices Guyana alone: the inactive USD-pegged markets keep their taxi rates', () => {
    const taxi = (code: string) => SPINE.countries.find((c) => c.code === code)!.policy['taxiRates'];
    expect(taxi('TT')).toEqual({ base: 32, perKm: 9.72, perMin: 0.81, minimum: 49 });
    expect(taxi('JM')).toEqual({ base: 760, perKm: 230, perMin: 19, minimum: 1100 });
  });
});

describe('taxi economy: the owner’s worked examples, priced from the seeded Guyana row', () => {
  it.each(TAXI_WORKED)('%s km (%s min): %s → %s', async (km, minutes, _raw, fare) => {
    expect((await quote(km, minutes))['ECONOMY']).toBe(fare);
    expect(formulaFare(DEFAULT_TAXI_RATES, km, minutes)).toBe(fare);
  });

  it('minutes never change a Georgetown fare: there is no per-minute charge', async () => {
    for (const km of [2, 7, 41]) expect((await quote(km, 0))['ECONOMY']).toBe((await quote(km, 240))['ECONOMY']);
  });

  it('Comfort scales the same fare by the unchanged multiplier: 10 km is 2,000 / 2,700; Group would be 5,000', async () => {
    // [VERIFY-DOCS · owner ruling 9, 6 Oct 2026 — a DELIBERATE change] Both buses are hidden at launch, so the
    // Group tier is not quoted; its unchanged multiplier still prices 10 km at 5,000 the day buses return.
    expect(await quote(10, 24)).toEqual({ ECONOMY: 2000, COMFORT: 2700 });
    expect(applyClassMultiplier(2000, DEFAULT_CLASS_RATES.GROUP, DEFAULT_TAXI_RATES.minimum)).toBe(5000);
  });

  it('the seeded card reads as written, is recorded as version 1, and the shadow merge agrees with it', async () => {
    const before = await shadowDiffs();
    const read = await readTaxiRates(seededGuyana(), 'GY');
    expect(read).toEqual({ payload: DEFAULT_TAXI_RATES, source: 'config', version: 1, problems: [] });
    expect(await shadowDiffs()).toBe(before);
  });
});

describe('a ride with stops: the 3 included km apply once, to the whole route', () => {
  const itinerary = async (legs: RouteLeg[]) =>
    fares(await new FareService(seededGuyana(), legsEngine(legs)).estimateItineraryTiers(PICKUP, [STOP], DROPOFF, 'GY'));

  it('two 2.5 km legs are one 5 km trip: 1,200 — not 800 (3 km included per leg), not 1,600 (the base per leg)', async () => {
    expect((await itinerary([{ km: 2.5, minutes: 6 }, { km: 2.5, minutes: 6 }]))['ECONOMY']).toBe(1200);
  });

  it('the same road with or without the stop costs the same', async () => {
    expect((await itinerary([{ km: 4, minutes: 10 }, { km: 6, minutes: 14 }]))['ECONOMY']).toBe((await quote(10, 24))['ECONOMY']);
  });
});

describe('TAXI_RATES.includedKm: a distance, validated; a config that does not name it includes none', () => {
  const LEGACY: TaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };

  it('kilometres: never negative, never absurd, never a string; a fraction is a distance, not money', () => {
    for (const bad of [-1, NaN, Infinity, '3', null, 10_001]) {
      expect(validatePricingConfig('TAXI_RATES', { ...DEFAULT_TAXI_RATES, includedKm: bad }).status, String(bad)).toBe('INVALID');
    }
    for (const good of [0, 2.5, 3]) {
      expect(validatePricingConfig('TAXI_RATES', { ...DEFAULT_TAXI_RATES, includedKm: good })).toMatchObject({ status: 'VALID', payload: { includedKm: good } });
    }
  });

  it('a config written before includedKm existed reads as written, with no kilometres included, and the shadow agrees', async () => {
    expect(validatePricingConfig('TAXI_RATES', LEGACY)).toEqual({ status: 'VALID', payload: LEGACY, problems: [] });
    const before = await shadowDiffs();
    expect((await readTaxiRates(seededGuyana(LEGACY), 'GY')).payload).toEqual(LEGACY);
    expect(await shadowDiffs()).toBe(before);
  });

  it('with no kilometres included the formula is exactly the one before includedKm existed', () => {
    for (const [km, minutes] of [[0, 0], [0.07, 1], [2.45, 6], [3, 8], [7.95, 20], [10.15, 27], [15.99, 39], [41, 99]] as const) {
      const before = Math.max(LEGACY.minimum, Math.round((LEGACY.base + LEGACY.perKm * km + LEGACY.perMin * minutes) / 100) * 100);
      expect(formulaFare(LEGACY, km, minutes), `${km} km`).toBe(before);
      expect(formulaFare({ ...LEGACY, includedKm: 0 }, km, minutes), `${km} km`).toBe(before);
    }
  });

  it('a partial write that does not name includedKm includes none; only a market with no taxi config prices with the default’s', () => {
    expect(validatePricingConfig('TAXI_RATES', { base: 900 }).payload).toEqual({ base: 900, perKm: 175, perMin: 0, minimum: 800 });
    expect(validatePricingConfig('TAXI_RATES', null)).toEqual({ status: 'ABSENT', payload: DEFAULT_TAXI_RATES, problems: [] });
  });

  it('inside the included kilometres the distance charges nothing: never a discount below the base, even with no minimum', () => {
    const noMinimum: TaxiRates = { ...DEFAULT_TAXI_RATES, minimum: 0 };
    for (const km of [0, 0.5, 1, 2, 3]) expect(formulaFare(noMinimum, km, 0), `${km} km`).toBe(800);
  });

  it('the formula still charges a per-minute rate, and still lifts a fare to the minimum, where a market sets them', () => {
    const market: TaxiRates = { base: 800, includedKm: 3, perKm: 175, perMin: 10, minimum: 2000 };
    expect(formulaFare(market, 10, 30)).toBe(2300); // 800 + 175 × 7 + 10 × 30 = 2,325
    expect(formulaFare(market, 5, 12)).toBe(2000); // 1,270 rounds to 1,300; the minimum lifts it
  });
});

describe('delivery: the owner’s worked examples, through the cart planner', () => {
  it.each([[2, 500], [3, 500], [5, 700], [8, 1000], [10, 1200]])('%s km → %s', async (km, fee) => {
    const plan = await planVendorGroup({
      vendor: { id: 'v-gy', name: 'Georgetown Kitchen', latitude: PICKUP.lat, longitude: PICKUP.lng, minOrderAmount: 0 },
      lines: [],
      fulfillment: 'DELIVERY',
      destination: DROPOFF,
      deliveryRates: (await readDeliveryRates(seededGuyana(), 'GY')).payload,
      express: false,
      routeKm: async () => ({ km, source: 'osrm' }),
    });
    expect(plan.deliveryFee).toBe(fee);
  });
});

describe('courier: the owner’s worked examples, at the standard speed', () => {
  it.each([[5, 'SMALL', 1400], [10, 'SMALL', 2000], [5, 'LARGE', 2400]] as const)('%s km, %s → %s', async (km, size, fee) => {
    const rates = (await readCourierRates(seededGuyana(), 'GY')).payload;
    expect(estimateCourierFee(km, size, 'STANDARD', rates).totalFee).toBe(fee);
  });
});

describe('every copy of a rate reads its one home, or is pinned to it', () => {
  const T = DEFAULT_TAXI_RATES;
  const D = DEFAULT_DELIVERY_RATES;
  const C = DEFAULT_COURIER_RATES;
  const SIZES: PackageSize[] = ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'];
  const SPEEDS = ['standard', 'express', 'rush'] as const;
  const courierAt = (km: number, size: PackageSize, speed: (typeof SPEEDS)[number]) =>
    Math.ceil((C.baseFee + km * C.perKmRate + C.sizeSurcharge[size]) * C.speedMultiplier[speed.toUpperCase() as DeliverySpeed]);
  const KMS = [0, 1, 2.5, 3, 3.4, 7, 41];

  /** A package source file, compiled and run on its own (neither package imports anything). */
  function loadPackage(path: string): Record<string, unknown> {
    const js = ts.transpileModule(readFileSync(join(__dirname, '..', '..', '..', '..', path), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(js, { module, exports: module.exports });
    return module.exports;
  }

  it('markup.ts: calculateDeliveryFee and calculateCourierFee price from the defaults', () => {
    for (const km of KMS) {
      expect(calculateDeliveryFee(km)).toBe(Math.ceil((D.baseFee + Math.max(0, km - D.includedKm) * D.perKmRate) * D.surgeMultiplier));
      for (const size of SIZES) for (const speed of SPEEDS) expect(calculateCourierFee(km, size, speed)).toBe(courierAt(km, size, speed));
    }
  });

  it('packages/config: PLATFORM_DEFAULTS repeats the three defaults exactly', () => {
    const defaults = JSON.parse(JSON.stringify(loadPackage('packages/config/src/index.ts')['PLATFORM_DEFAULTS'])) as Record<string, unknown>;
    expect(defaults['taxi']).toEqual({ baseFare: T.base, includedKm: T.includedKm, perKmRate: T.perKm, perMinRate: T.perMin, minimumFare: T.minimum });
    expect(defaults['delivery']).toEqual({ baseFee: D.baseFee, perKmRate: D.perKmRate, includedKm: D.includedKm });
    expect(defaults['courier']).toEqual({
      baseFee: C.baseFee,
      perKmRate: C.perKmRate,
      sizeSurcharge: C.sizeSurcharge,
      speedMultiplier: { standard: C.speedMultiplier.STANDARD, express: C.speedMultiplier.EXPRESS, rush: C.speedMultiplier.RUSH },
    });
  });

  it('packages/utils: each pricing helper defaults to the same rates', () => {
    type Fn = (options: Record<string, unknown>) => number;
    const utils = loadPackage('packages/utils/src/pricing.ts') as Record<'calculateTaxiFare' | 'calculateDeliveryFee' | 'calculateCourierFee', Fn>;
    for (const km of KMS) {
      expect(utils.calculateTaxiFare({ distanceKm: km, durationMin: 12 }), `taxi ${km} km`).toBe(utils.calculateTaxiFare({
        distanceKm: km, durationMin: 12, baseFare: T.base, includedKm: T.includedKm, perKmRate: T.perKm, perMinRate: T.perMin, minimumFare: T.minimum,
      }));
      expect(utils.calculateDeliveryFee({ distanceKm: km }), `delivery ${km} km`).toBe(utils.calculateDeliveryFee({
        distanceKm: km, baseFee: D.baseFee, perKmRate: D.perKmRate, includedKm: D.includedKm, surgeMultiplier: D.surgeMultiplier,
      }));
      for (const size of SIZES) for (const speed of SPEEDS) {
        expect(utils.calculateCourierFee({ distanceKm: km, packageSize: size, speed }), `courier ${km} km ${size} ${speed}`).toBe(courierAt(km, size, speed));
      }
    }
  });
});

describe('on the seeded database (CI seeds a fresh one for every run)', () => {
  // Outside every seeded fare zone, so the formula prices it.
  const FAR_PICKUP = { lat: 6.90, lng: -58.10 };
  const FAR_DROPOFF = { lat: 6.95, lng: -58.05 };
  let prisma: PrismaClient;

  beforeAll(() => {
    process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Guyana’s taxi card is the October fare, read as written and recorded as its newest version', async () => {
    expect(await readTaxiRates(prisma, 'GY')).toMatchObject({ source: 'config', payload: DEFAULT_TAXI_RATES, problems: [] });
    const newest = await prisma.pricingConfigVersion.findFirst({ where: { countryCode: 'GY', kind: 'TAXI_RATES' }, orderBy: { version: 'desc' } });
    expect(newest?.payload).toEqual(DEFAULT_TAXI_RATES);
  });

  it('Guyana quotes the worked examples, and prices delivery and courier from the defaults', async () => {
    for (const [km, minutes, , fare] of TAXI_WORKED) {
      const est = await new FareService(prisma, engine(km, minutes)).estimateTiers(FAR_PICKUP, FAR_DROPOFF, 'GY');
      expect(fares(est)['ECONOMY'], `${km} km`).toBe(fare);
    }
    expect((await readDeliveryRates(prisma, 'GY')).payload).toEqual(DEFAULT_DELIVERY_RATES);
    expect((await readCourierRates(prisma, 'GY')).payload).toEqual(DEFAULT_COURIER_RATES);
  });
});
