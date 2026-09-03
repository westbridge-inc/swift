import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { FareService } from '../modules/rides/fare.service';
import { CountryConfigService } from '../modules/country/country-config.service';
import {
  PRICING_KINDS, assertSaneFare, pricingDefaults, readPricingConfig, scanPricingConfigs, validatePricingConfig, type PricingKind,
} from '../modules/country/pricing-config';
import { pricingConfigCounter, pricingConfigGauge } from '../plugins/observability';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [M-35] Pricing JSON accepts non-finite, negative, and partial values.
//
// The register's red test: property tests over every invalid boundary and
// every partial matrix — each one refused as a whole; a valid partial merged
// over the defaults. End to end on a synthetic market: an invalid live column
// prices from the last known good version (never raw JSON, never a guess),
// the admin write refuses the invalid and versions the valid, rollback points
// back, the database refuses a non-object column, a quote is never unsane.
// ---------------------------------------------------------------------------

const ZZ = 'ZZ';
let app: FastifyInstance;
let adminToken: string;
const P = { lat: 6.80, lng: -57.60 }; // nowhere near any zone
const Q = { lat: 6.85, lng: -57.55 };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await app.prisma.pricingConfigVersion.deleteMany({ where: { countryCode: ZZ } });
  await app.prisma.countryConfig.deleteMany({ where: { code: ZZ } });
  await app.prisma.countryConfig.create({
    data: {
      code: ZZ, name: 'Zed Test Market', currencyCode: 'ZZD', currencySymbol: 'Z$', usdExchangeRate: 100, isActive: false,
      subscriptionTiers: { mover: 1000, smallVendor: 2000, largeVendor: 5000 }, documentChecklists: {},
    },
  });
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
});

afterAll(async () => {
  await app.prisma.pricingConfigVersion.deleteMany({ where: { countryCode: ZZ } });
  await app.prisma.countryConfig.deleteMany({ where: { code: ZZ } });
  await app.close();
});

const BAD_NUMBERS = [NaN, Infinity, -Infinity, -1, -0.001, '5', null, true, {}, [], 1e12] as const;
const MONEY_FIELDS: Record<PricingKind, string[]> = {
  TAXI_RATES: ['base', 'perKm', 'perMin', 'minimum'],
  TAXI_CLASS_RATES: [],
  DELIVERY_RATES: ['baseFee', 'perKmRate'],
  COURIER_RATES: ['baseFee', 'perKmRate'],
};
const MULTIPLIER_FIELDS: Record<PricingKind, string[]> = {
  TAXI_RATES: [],
  TAXI_CLASS_RATES: ['COMFORT', 'XL', 'GROUP'],
  DELIVERY_RATES: ['surgeMultiplier'],
  COURIER_RATES: [],
};

describe('the law (pure, property-style over every boundary and every partial)', () => {
  it('null is the defaults; the defaults themselves are valid; a scalar or an array is refused', () => {
    for (const kind of PRICING_KINDS) {
      expect(validatePricingConfig(kind, null).status).toBe('ABSENT');
      expect(validatePricingConfig(kind, pricingDefaults(kind))).toMatchObject({ status: 'VALID', payload: pricingDefaults(kind) });
      expect(validatePricingConfig(kind, 'nonsense').status).toBe('INVALID');
      expect(validatePricingConfig(kind, 5).status).toBe('INVALID');
      expect(validatePricingConfig(kind, [1, 2]).status).toBe('INVALID');
    }
  });
  it('every money field × every bad value → INVALID, naming the field; fractional money is refused (whole units)', () => {
    let cases = 0;
    for (const kind of PRICING_KINDS) {
      for (const field of MONEY_FIELDS[kind]) {
        for (const bad of [...BAD_NUMBERS, 1.5]) {
          const verdict = validatePricingConfig(kind, { [field]: bad });
          expect(verdict.status, `${kind}.${field} = ${String(bad)}`).toBe('INVALID');
          expect(verdict.problems.join(' '), `${kind}.${field}`).toContain(field);
          cases += 1;
        }
      }
    }
    expect(cases).toBeGreaterThan(80);
  });
  it('every multiplier field × every bad value and out-of-bounds → INVALID; Economy and Standard are exactly 1', () => {
    for (const kind of PRICING_KINDS) {
      for (const field of MULTIPLIER_FIELDS[kind]) {
        for (const bad of [...BAD_NUMBERS, 0, 0.4, 11]) {
          expect(validatePricingConfig(kind, { [field]: bad }).status, `${kind}.${field} = ${String(bad)}`).toBe('INVALID');
        }
        expect(validatePricingConfig(kind, { [field]: 2 }).status).toBe('VALID');
      }
    }
    expect(validatePricingConfig('TAXI_CLASS_RATES', { ECONOMY: 1.1 }).status).toBe('INVALID');
    expect(validatePricingConfig('COURIER_RATES', { speedMultiplier: { STANDARD: 1.2 } }).status).toBe('INVALID');
    expect(validatePricingConfig('COURIER_RATES', { speedMultiplier: { RUSH: NaN } }).status).toBe('INVALID');
    expect(validatePricingConfig('COURIER_RATES', { sizeSurcharge: { LARGE: -5 } }).status).toBe('INVALID');
  });
  it('a valid partial merges over the defaults and the WHOLE payload is the answer; an unknown key is refused; one bad field poisons the whole', () => {
    expect(validatePricingConfig('TAXI_RATES', { base: 2000 })).toMatchObject({ status: 'VALID', payload: { base: 2000, perKm: 300, perMin: 25, minimum: 1500 } });
    expect(validatePricingConfig('DELIVERY_RATES', { includedKm: 0 })).toMatchObject({ status: 'VALID', payload: { baseFee: 500, perKmRate: 200, includedKm: 0, surgeMultiplier: 1 } });
    expect(validatePricingConfig('COURIER_RATES', { sizeSurcharge: { LARGE: 1500 } }).payload).toMatchObject({ sizeSurcharge: { SMALL: 0, MEDIUM: 500, LARGE: 1500, EXTRA_LARGE: 2000 } });
    expect(validatePricingConfig('TAXI_RATES', { base: 2000, perKmRate: 300 }).status).toBe('INVALID'); // a typo'd key can no longer silently do nothing
    expect(validatePricingConfig('TAXI_RATES', { base: 2000, perKm: -1 }).status).toBe('INVALID');    // never "keep the valid parts"
    // the full partial matrix over one kind: every subset of fields with valid values is VALID
    const fields = ['base', 'perKm', 'perMin', 'minimum'];
    for (let mask = 0; mask < 16; mask++) {
      const partial = Object.fromEntries(fields.filter((_, i) => mask & (1 << i)).map((f) => [f, 700]));
      expect(validatePricingConfig('TAXI_RATES', partial).status, JSON.stringify(partial)).toBe('VALID');
    }
  });
  it('a quote is never negative, NaN or infinite — refused as PRICING_UNAVAILABLE; an extreme fare is counted, not refused', async () => {
    for (const bad of [NaN, Infinity, -Infinity, -1]) expect(() => assertSaneFare(bad, 'test')).toThrow(/temporarily unavailable/);
    expect(assertSaneFare(0, 'test')).toBe(0);
    expect(assertSaneFare(1500, 'test')).toBe(1500);
    const before = (await pricingConfigCounter.get()).values.find((v) => v.labels['event'] === 'outlier' && v.labels['kind'] === 'test')?.value ?? 0;
    expect(assertSaneFare(5_000_000, 'test')).toBe(5_000_000);
    const after = (await pricingConfigCounter.get()).values.find((v) => v.labels['event'] === 'outlier' && v.labels['kind'] === 'test')?.value ?? 0;
    expect(after).toBe(before + 1);
  });
});

describe('the register’s red test, end to end: an invalid column never prices a quote', () => {
  const headers = () => ({ authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' });
  const svc = () => new FareService(app.prisma);
  const raw = (sql: string) => app.prisma.$executeRawUnsafe(sql);

  it('no column: the defaults, no version recorded', async () => {
    const read = await readPricingConfig(app.prisma, ZZ, 'TAXI_RATES');
    expect(read).toMatchObject({ source: 'defaults', version: null, payload: pricingDefaults('TAXI_RATES') });
    expect(await app.prisma.pricingConfigVersion.count({ where: { countryCode: ZZ } })).toBe(0);
  });
  it('the admin refuses an invalid write (column unchanged, no version) and versions a valid one; the quote follows', async () => {
    const bad = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/countries/${ZZ}/pricing/TAXI_RATES`, headers: { ...headers(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: { base: -50 } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_PRICING_CONFIG');
    expect(bad.json().error.message).toContain('base');
    expect((await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: ZZ } })).taxiRates).toBeNull();
    const nan = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/countries/${ZZ}/pricing/TAXI_RATES`, headers: { ...headers(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: { base: 'NaN' } });
    expect(nan.statusCode).toBe(400);
    const ok = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/countries/${ZZ}/pricing/TAXI_RATES`, headers: { ...headers(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: { base: 2000, minimum: 2500 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ version: 1, payload: { base: 2000, perKm: 300, perMin: 25, minimum: 2500 } });
    const est = await svc().estimate(P, Q, ZZ);
    expect(est.source).toBe('formula');
    expect(est.fare).toBeGreaterThanOrEqual(2500);
    expect(est.currencyCode).toBe('ZZD');
    const tiers = await svc().estimateTiers(P, Q, ZZ);
    expect(tiers.tiers.find((t) => t.rideClass === 'ECONOMY')!.fare).toBe(est.fare);
  });
  it('the column corrupted underneath (negative, NaN-as-string, a stray key): the readers price from the last known good version, the counter and gauge say so, and the scan names it', async () => {
    const good = await svc().estimate(P, Q, ZZ);
    for (const corrupt of ['{"base": -1, "perKm": 300, "perMin": 25, "minimum": 2500}', '{"base": "NaN"}', '{"base": 2000, "perKmRate": 300}', '{"base": 1e12}']) {
      await raw(`UPDATE "country_configs" SET "taxiRates" = '${corrupt}'::jsonb WHERE "code" = '${ZZ}'`);
      const read = await readPricingConfig(app.prisma, ZZ, 'TAXI_RATES');
      expect(read.source, corrupt).toBe('last_known_good');
      expect(read.version).toBe(1);
      expect(read.payload).toEqual({ base: 2000, perKm: 300, perMin: 25, minimum: 2500 });
      expect(read.problems.length).toBeGreaterThan(0);
      const est = await svc().estimate(P, Q, ZZ);
      expect(est.fare, corrupt).toBe(good.fare);
      const gauge = (await pricingConfigGauge.get()).values.find((v) => v.labels['kind'] === 'TAXI_RATES' && v.labels['country'] === ZZ && v.labels['check'] === 'invalid');
      expect(gauge?.value).toBe(1);
    }
    const scan = await scanPricingConfigs(app.prisma);
    expect(scan.invalid.some((i) => i.countryCode === ZZ && i.kind === 'TAXI_RATES')).toBe(true);
    // the admin view says the same: live INVALID, effective from version 1
    const view = await app.inject({ method: 'GET', url: `/api/v1/admin/countries/${ZZ}/pricing`, headers: { ...headers(), 'x-swift-reason': TEST_ADMIN_REASON } });
    expect(view.statusCode, view.body).toBe(200);
    const taxi = view.json().data.kinds.find((k: { kind: string }) => k.kind === 'TAXI_RATES');
    expect(taxi.live.status).toBe('INVALID');
    expect(taxi.effective).toMatchObject({ source: 'last_known_good', version: 1 });
    expect(taxi.units).toBe('GYD_WHOLE');
  });
  it('a valid write heals it as version 2; rollback pins version 1 as version 3; the quote follows each', async () => {
    const v2 = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/countries/${ZZ}/pricing/TAXI_RATES`, headers: { ...headers(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: { base: 3000, minimum: 4000 } });
    expect(v2.statusCode, v2.body).toBe(200);
    expect(v2.json().data.version).toBe(2);
    const v2Fare = (await svc().estimate(P, Q, ZZ)).fare;
    expect(v2Fare).toBeGreaterThanOrEqual(4000);
    expect((await readPricingConfig(app.prisma, ZZ, 'TAXI_RATES')).source).toBe('config');
    const back = await injectWithApproval(app, { method: 'POST', url: `/api/v1/admin/countries/${ZZ}/pricing/TAXI_RATES/rollback`, headers: { ...headers(), 'x-swift-reason': TEST_ADMIN_REASON }, payload: { } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().data).toMatchObject({ version: 3, restoredFrom: 1, payload: { base: 2000, minimum: 2500 } });
    // the same trip prices lower under the restored terms (base 2,000 vs 3,000) —
    // compared trip to trip, never to a fixed number the route estimate could exceed
    const est = await svc().estimate(P, Q, ZZ);
    expect(est.fare).toBeLessThan(v2Fare);
    expect(est.fare).toBeGreaterThanOrEqual(2500);
    const versions = await app.prisma.pricingConfigVersion.findMany({ where: { countryCode: ZZ, kind: 'TAXI_RATES' }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[2]!.restoredFrom).toBe(1);
    expect(versions[0]!.units).toBe('GYD_WHOLE');
  });
  it('the database refuses a non-object pricing column outright', async () => {
    await expect(raw(`UPDATE "country_configs" SET "taxiRates" = '"free"'::jsonb WHERE "code" = '${ZZ}'`)).rejects.toThrow(/country_configs_taxi_rates_object_check/);
    await expect(raw(`UPDATE "country_configs" SET "deliveryRates" = '[1,2]'::jsonb WHERE "code" = '${ZZ}'`)).rejects.toThrow(/country_configs_delivery_rates_object_check/);
  });
  it('the other readers obey the same law: a corrupt delivery schedule prices from the defaults (nothing recorded yet) and the class multipliers refuse a zero', async () => {
    await raw(`UPDATE "country_configs" SET "deliveryRates" = '{"baseFee": -500}'::jsonb WHERE "code" = '${ZZ}'`);
    const rates = await new CountryConfigService(app.prisma).getDeliveryRates(ZZ);
    expect(rates).toEqual(pricingDefaults('DELIVERY_RATES'));
    await raw(`UPDATE "country_configs" SET "taxiClassRates" = '{"ECONOMY": 1, "COMFORT": 0, "XL": 1.8, "GROUP": 2.5}'::jsonb WHERE "code" = '${ZZ}'`);
    const tiers = await svc().estimateTiers(P, Q, ZZ);
    expect(tiers.tiers.find((t) => t.rideClass === 'COMFORT')!.multiplier).toBe(1.35); // the defaults, never a free tier
    expect(tiers.tiers.every((t) => Number.isFinite(t.fare) && t.fare > 0)).toBe(true);
  });
  it('a GY quote is unchanged by all of this: its seeded config is valid, the shadow agrees, and version 1 was recorded on first read', async () => {
    const read = await readPricingConfig(app.prisma, 'GY', 'TAXI_RATES');
    expect(read.source).toBe('config');
    expect(read.payload).toEqual({ base: 1000, perKm: 300, perMin: 25, minimum: 1500 });
    expect(read.version).toBeGreaterThanOrEqual(1);
    const classes = await readPricingConfig(app.prisma, 'GY', 'TAXI_CLASS_RATES');
    expect(classes.payload).toEqual({ ECONOMY: 1, COMFORT: 1.35, XL: 1.8, GROUP: 2.5 });
  });
});
