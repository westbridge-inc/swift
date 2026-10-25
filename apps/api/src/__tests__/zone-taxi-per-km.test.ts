import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { FareService, formulaFare, ratesForTrip } from '../modules/rides/fare.service';
import { zonePerKmOf, zoneTaxiPerKm, DEFAULT_TENANT_ID, type ZonePick } from '../modules/rides/fare-zones';
import { readTaxiRates, DEFAULT_TAXI_RATES, type TaxiRates } from '../modules/country/pricing-config';
import { desiredPlatformConfig, AIRPORT_TAXI_PER_KM } from '../modules/ops/platform-config';
import { pointInPolygon, polygonsOverlap } from '../utils/geo';
import type { MapsProvider, LatLng, RouteLegsEstimate } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// [ZONE-FARES] A zone's own taxi per-km rate (owner, 1 Oct 2026).
//
// An airport prices PER KILOMETRE, never as a fixed zone-to-zone fare: a fixed
// fare is unfair to people who live near the airport. A zone may carry its own
// taxi per-km rate; when the pickup OR the dropoff resolves to a zone that sets
// one, the market's formula charges it for every kilometre beyond the included
// ones — the higher of the two ends when both set one. The base, the included
// kilometres, the per-minute and the minimum stay the market's; a fixed fare
// for the pair still wins; the kill switch rolls every ride back to the
// market's formula. The seed carries CJIA and Ogle at 295 and NO fixed fare.
//
// Every expectation here is computed from Guyana's LIVE rates through the same
// formula the engine uses, so it holds whatever the market's formula is; the
// owner's worked examples (41 km → 12,000, 9 km → 2,600, 2 km → 800, in town
// 175 a km) are pinned as literal numbers in the last block, against the
// October formula a fresh database is seeded with.
// ---------------------------------------------------------------------------

const box = (lng1: number, lat1: number, lng2: number, lat2: number) => ({ type: 'Polygon', coordinates: [[[lng1, lat1], [lng2, lat1], [lng2, lat2], [lng1, lat2], [lng1, lat1]]] });
// This suite's own zones: far east of every seeded zone and of every other
// suite's fixture (fare-zones.test.ts draws between lng -58.05 and -57.63).
const P295 = box(-57.30, 6.60, -57.26, 6.64);
const P400 = box(-57.24, 6.60, -57.20, 6.64);
const PLAIN = box(-57.18, 6.60, -57.14, 6.64);
const CORNER = box(-57.30, 6.60, -57.29, 6.61); // inside P295, a higher priority, no rate
const IN_295 = { lat: 6.62, lng: -57.28 };
const IN_400 = { lat: 6.62, lng: -57.22 };
const IN_PLAIN = { lat: 6.62, lng: -57.16 };
const IN_CORNER = { lat: 6.605, lng: -57.295 };
const NOWHERE = { lat: 6.70, lng: -57.28 };
const TENANT_B = 'zone-perkm-tenant-b';
const TAG = `ZPK${nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

// The seeded zones (platform-config): Georgetown and the two airports.
const GEORGETOWN_CENTRAL = { lat: 6.81, lng: -58.155 };
const GEORGETOWN_SOUTH = { lat: 6.755, lng: -58.155 };
const CJIA_TERMINAL = { lat: 6.4985, lng: -58.2541 };
const OGLE_TERMINAL = { lat: 6.806, lng: -58.105 };

/** A road of exactly `km` kilometres and `minutes` minutes, whatever the points. */
function road(km: number, minutes: number): MapsProvider {
  return {
    routeKm: async () => ({ km, minutes, source: 'osrm' as const }),
    routeLegs: async (points: LatLng[]): Promise<RouteLegsEstimate> => ({
      legs: points.slice(1).map(() => ({ km: km / (points.length - 1), minutes: minutes / (points.length - 1) })),
      km, minutes, source: 'osrm', degraded: false,
    }),
  } as unknown as MapsProvider;
}

let app: FastifyInstance;
let gy: TaxiRates;
const zoneIds: string[] = [];

async function zone(name: string, boundary: unknown, opts: { taxiPerKm?: number | null; priority?: number; tenantId?: string; countryCode?: string } = {}) {
  const z = await runWithoutTenant(() => app.prisma.zone.create({
    data: {
      name: `${TAG} ${name}`, boundary: boundary as never, tenantId: opts.tenantId ?? DEFAULT_TENANT_ID,
      countryCode: opts.countryCode ?? 'GY', priority: opts.priority ?? 0, taxiPerKm: opts.taxiPerKm ?? null,
    },
  }));
  zoneIds.push(z.id);
  return z;
}

/** The engine's own answer for a trip on a road of `km` / `minutes`. */
const quote = (from: { lat: number; lng: number }, to: { lat: number; lng: number }, km = 10, minutes = 20, tenantId = DEFAULT_TENANT_ID) =>
  new FareService(app.prisma, road(km, minutes)).estimate(from, to, 'GY', tenantId);
/** What the market's formula charges at a given per-km rate. */
const atRate = (perKm: number, km = 10, minutes = 20) => formulaFare({ ...gy, perKm }, km, minutes);
const national = (km = 10, minutes = 20) => formulaFare(gy, km, minutes);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  // orphans from an interrupted run
  await runWithoutTenant(() => app.prisma.zone.deleteMany({ where: { name: { startsWith: 'ZPK' } } }));
  await app.prisma.tenant.upsert({ where: { id: TENANT_B }, update: {}, create: { id: TENANT_B, name: 'Per-km B', slug: `zone-perkm-b-${nanoid(5).toLowerCase()}` } });
  gy = (await readTaxiRates(app.prisma as unknown as PrismaClient, 'GY')).payload;
  // The suite's rates must differ from Guyana's, or "the zone rate applied"
  // could not be told apart from "the market's rate applied".
  expect([295, 400]).not.toContain(gy.perKm);
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.zone.deleteMany({ where: { id: { in: zoneIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
  await app.close();
});

describe('the law, pure', () => {
  const pick = (taxiPerKm: unknown): ZonePick => ({ zone: { id: 'z', name: 'z', boundary: null, priority: 0, version: 1, taxiPerKm: taxiPerKm as never }, ambiguous: false, contenders: 1 });
  const none: ZonePick = { zone: null, ambiguous: false, contenders: 0 };

  it('either end sets it; both ends: the higher; neither: no override', () => {
    expect(zoneTaxiPerKm(pick(295), none)).toBe(295);
    expect(zoneTaxiPerKm(none, pick(295))).toBe(295);
    expect(zoneTaxiPerKm(pick(295), pick(400))).toBe(400);
    expect(zoneTaxiPerKm(pick(400), pick(295))).toBe(400);
    expect(zoneTaxiPerKm(pick(null), pick(null))).toBeNull();
    expect(zoneTaxiPerKm(none, none)).toBeNull();
    expect(zoneTaxiPerKm(pick(null), pick(295))).toBe(295);
  });

  it('the database Decimal reads as its number; a value that is not a positive number is no rate, never a price', () => {
    expect(zonePerKmOf({ id: 'z', name: 'z', boundary: null, priority: 0, version: 1, taxiPerKm: { toString: () => '295.00' } })).toBe(295);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, { toString: () => 'abc' }]) {
      expect(zonePerKmOf({ id: 'z', name: 'z', boundary: null, priority: 0, version: 1, taxiPerKm: bad as never }), String(bad)).toBeNull();
    }
    expect(zonePerKmOf(null)).toBeNull();
    expect(zonePerKmOf({ id: 'z', name: 'z', boundary: null, priority: 0, version: 1 })).toBeNull();
  });

  it('only the per-km moves: the base, the included kilometres, the per-minute and the minimum stay the market\'s', () => {
    const market = { ...DEFAULT_TAXI_RATES };
    expect(ratesForTrip(market, null)).toBe(market);
    expect(ratesForTrip(market, 295)).toEqual({ ...market, perKm: 295 });
    expect(market.perKm).toBe(DEFAULT_TAXI_RATES.perKm); // never mutated
  });
});

describe('a zone\'s per-km rate, through the fare engine (this suite\'s zones)', () => {
  beforeAll(async () => {
    await zone('rate 295', P295, { taxiPerKm: 295 });
    await zone('rate 400', P400, { taxiPerKm: 400 });
    await zone('no rate', PLAIN);
    await zone('corner above 295', CORNER, { priority: 1 });
    // the same polygons for another operator, and in another market, with a
    // far higher rate: neither may ever price a Guyana trip of this operator
    await zone('B rate', P295, { taxiPerKm: 9000, tenantId: TENANT_B });
    await zone('other market rate', P295, { taxiPerKm: 9000, countryCode: 'TT' });
  });

  it('the pickup in a zone with a rate: every kilometre beyond the included ones at that rate', async () => {
    const est = await quote(IN_295, NOWHERE);
    expect(est).toMatchObject({ fare: atRate(295), source: 'formula', billableKm: 10, durationMin: 20 });
    expect(est.fare).not.toBe(national());
  });

  it('the dropoff in a zone with a rate: the same', async () => {
    expect((await quote(NOWHERE, IN_295)).fare).toBe(atRate(295));
  });

  it('both ends set one: the higher, in either direction', async () => {
    expect((await quote(IN_295, IN_400)).fare).toBe(atRate(400));
    expect((await quote(IN_400, IN_295)).fare).toBe(atRate(400));
  });

  it('a zone with no rate, or no zone at all: the market\'s formula, unchanged', async () => {
    expect((await quote(IN_PLAIN, NOWHERE)).fare).toBe(national());
    expect((await quote(NOWHERE, { lat: 6.72, lng: -57.28 })).fare).toBe(national());
  });

  it('the precedence law picks the zone: a higher-priority zone without a rate over the rated one means no rate', async () => {
    const est = await quote(IN_CORNER, NOWHERE);
    expect(est.fare).toBe(national());
    expect(est.fromZoneId).not.toBe(undefined);
  });

  it('every tier is the class multiple of the overridden fare', async () => {
    const tiers = await new FareService(app.prisma, road(10, 20)).estimateTiers(IN_295, NOWHERE, 'GY', DEFAULT_TENANT_ID);
    expect(tiers.tiers.find((t) => t.rideClass === 'ECONOMY')?.fare).toBe(atRate(295));
  });

  it('another operator\'s rate, or another market\'s, never prices this operator\'s Guyana trip', async () => {
    expect((await quote(IN_295, NOWHERE)).fare).toBe(atRate(295));
    // and operator B's own trip there is priced by B's zone
    const b = await runWithoutTenant(() => quote(IN_295, NOWHERE, 10, 20, TENANT_B));
    expect(b.fare).toBe(atRate(9000));
  });

  it('a fixed fare for the pair still wins over the zones\' rates; the reverse direction, with no fixed fare, takes the rate', async () => {
    const rated = zoneIds[0]!; const plain = zoneIds[2]!;
    await runWithoutTenant(() => app.prisma.zoneFare.create({ data: { fromZoneId: rated, toZoneId: plain, fare: 5000 } }));
    try {
      expect(await quote(IN_295, IN_PLAIN)).toMatchObject({ fare: 5000, source: 'zone_table' });
      expect(await quote(IN_PLAIN, IN_295)).toMatchObject({ fare: atRate(295), source: 'formula' });
    } finally {
      await runWithoutTenant(() => app.prisma.zoneFare.deleteMany({ where: { fromZoneId: rated, toZoneId: plain } }));
    }
  });

  it('FARE_ZONE_TABLE_KILL=1 rolls the rates back too: every ride prices by the market\'s formula', async () => {
    process.env['FARE_ZONE_TABLE_KILL'] = '1';
    try {
      expect((await quote(IN_295, IN_400)).fare).toBe(national());
    } finally {
      delete process.env['FARE_ZONE_TABLE_KILL'];
    }
  });
});

describe('a ride with stops: the pickup\'s and the destination\'s zones set the rate, a stop never does', () => {
  // Service-free: the zone read is a fake that answers this suite's polygons
  // (all inside Guyana's launch-market box, so the route is judged on price).
  const rows = [
    { id: 'rated', name: 'rated', boundary: P295, priority: 0, version: 1, taxiPerKm: 295 },
    { id: 'plain', name: 'plain', boundary: PLAIN, priority: 0, version: 1, taxiPerKm: null },
  ];
  const price = async (pickup: { lat: number; lng: number }, stops: Array<{ lat: number; lng: number; address: string }>, dropoff: { lat: number; lng: number }) => {
    const reads: string[] = [];
    const prisma = {
      zone: { findMany: async () => { reads.push('zone'); return rows; } },
      zoneFare: { findMany: async () => { reads.push('zoneFare'); return []; } },
      countryConfig: { findUnique: async () => { reads.push('countryConfig'); return { code: 'GY', currencyCode: 'GYD', taxiRates: null, taxiClassRates: null }; } },
    } as unknown as PrismaClient;
    const est = await new FareService(prisma, road(10, 20)).estimateItineraryTiers(pickup, stops, dropoff, 'GY');
    return { fare: est.tiers.find((t) => t.rideClass === 'ECONOMY')!.fare, zoneReads: reads.filter((r) => r === 'zone').length };
  };
  const STOP_OUTSIDE = { lat: 6.66, lng: -57.28, address: 'Coast Road' };
  const STOP_RATED = { ...IN_295, address: 'Rated Road' };
  // service-free: the market's rate is the declared default (a null taxiRates column)
  const at295 = formulaFare({ ...DEFAULT_TAXI_RATES, perKm: 295 }, 10, 20);
  const plain = formulaFare(DEFAULT_TAXI_RATES, 10, 20);

  it('a pickup or a destination in a rated zone prices the whole route at its rate, from ONE zone read', async () => {
    expect(at295).not.toBe(plain);
    expect(await price(IN_295, [STOP_OUTSIDE], NOWHERE)).toEqual({ fare: at295, zoneReads: 1 });
    expect(await price(NOWHERE, [STOP_OUTSIDE], IN_295)).toEqual({ fare: at295, zoneReads: 1 });
  });

  it('a stop in a rated zone does not set the rate; a zone with no rate does not either', async () => {
    expect(await price(NOWHERE, [STOP_RATED], { lat: 6.72, lng: -57.28 })).toEqual({ fare: plain, zoneReads: 1 });
    expect(await price(IN_PLAIN, [STOP_OUTSIDE], NOWHERE)).toEqual({ fare: plain, zoneReads: 1 });
  });
});

describe('the seed: CJIA and Ogle at 295 a kilometre, and no fixed fare at all', () => {
  const desired = desiredPlatformConfig();
  const zonesById = new Map(desired.zones.map((z) => [z.id, z.create as { name: string; boundary: unknown; taxiPerKm?: number }]));

  it('a fresh install seeds the two airport zones with the airport rate, around the airports', () => {
    expect(AIRPORT_TAXI_PER_KM).toBe(295);
    const cjia = zonesById.get('cjia-airport');
    const ogle = zonesById.get('ogle-airport');
    expect(cjia).toMatchObject({ name: 'CJIA Airport', taxiPerKm: 295, boundary: { type: 'Polygon', coordinates: [[[-58.268, 6.488], [-58.238, 6.488], [-58.238, 6.512], [-58.268, 6.512], [-58.268, 6.488]]] } });
    expect(ogle).toMatchObject({ name: 'Ogle Airport', taxiPerKm: 295, boundary: { type: 'Polygon', coordinates: [[[-58.114, 6.799], [-58.096, 6.799], [-58.096, 6.814], [-58.114, 6.814], [-58.114, 6.799]]] } });
    expect(pointInPolygon(CJIA_TERMINAL, cjia!.boundary)).toBe(true);
    expect(pointInPolygon(OGLE_TERMINAL, ogle!.boundary)).toBe(true);
    // Georgetown's own zones set no rate: in town, the market's per-km
    expect(zonesById.get('georgetown-central')?.taxiPerKm).toBeUndefined();
    expect(zonesById.get('georgetown-south')?.taxiPerKm).toBeUndefined();
  });

  it('neither airport touches a Georgetown zone or the other (all at the default priority)', () => {
    for (const airport of ['cjia-airport', 'ogle-airport']) {
      for (const [id, other] of zonesById) {
        if (id === airport) continue;
        expect(polygonsOverlap(zonesById.get(airport)!.boundary, other.boundary), `${airport} × ${id}`).toBe(false);
      }
    }
  });

  it('no fixed fare is seeded: not the old Georgetown Central ↔ South 2,000, and none for an airport', () => {
    expect(desired.zoneFares).toEqual([]);
    expect(desired.zoneFares.some((f) => [f.fromZoneId, f.toZoneId].includes('georgetown-south'))).toBe(false);
    expect(desired.zoneFares.some((f) => /airport/.test(f.fromZoneId) || /airport/.test(f.toZoneId))).toBe(false);
    expect(desired.version).not.toBe('2026-09-29.1');
  });

  it('this database was seeded from that plan: the airports carry 295, and no fixed fare names an airport or the old Georgetown pair', async () => {
    const seeded = await runWithoutTenant(() => app.prisma.zone.findMany({ where: { id: { in: ['cjia-airport', 'ogle-airport'] } }, orderBy: { id: 'asc' } }));
    expect(seeded.map((z) => ({ id: z.id, perKm: Number(z.taxiPerKm), active: z.isActive, tenant: z.tenantId, country: z.countryCode, priority: z.priority })))
      .toEqual([
        { id: 'cjia-airport', perKm: 295, active: true, tenant: DEFAULT_TENANT_ID, country: 'GY', priority: 0 },
        { id: 'ogle-airport', perKm: 295, active: true, tenant: DEFAULT_TENANT_ID, country: 'GY', priority: 0 },
      ]);
    const pairs = await runWithoutTenant(() => app.prisma.zoneFare.findMany({
      where: { OR: [
        { fromZoneId: { in: ['cjia-airport', 'ogle-airport'] } }, { toZoneId: { in: ['cjia-airport', 'ogle-airport'] } },
        { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' }, { fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central' },
      ] },
    }));
    expect(pairs).toEqual([]);
  });
});

describe('the seeded airports price per kilometre at 295; town does not', () => {
  it('Georgetown → CJIA and back, Georgetown South → CJIA: 295 a kilometre beyond the included ones', async () => {
    for (const [from, to] of [[GEORGETOWN_CENTRAL, CJIA_TERMINAL], [CJIA_TERMINAL, GEORGETOWN_CENTRAL], [GEORGETOWN_SOUTH, CJIA_TERMINAL], [CJIA_TERMINAL, GEORGETOWN_SOUTH]] as const) {
      const est = await quote(from, to, 41, 50);
      expect(est, `${JSON.stringify(from)} → ${JSON.stringify(to)}`).toMatchObject({ fare: atRate(295, 41, 50), source: 'formula' });
    }
  });

  it('Georgetown → Ogle and back: 295 a kilometre', async () => {
    for (const [from, to] of [[GEORGETOWN_CENTRAL, OGLE_TERMINAL], [OGLE_TERMINAL, GEORGETOWN_CENTRAL], [GEORGETOWN_SOUTH, OGLE_TERMINAL]] as const) {
      expect((await quote(from, to, 9, 15)).fare).toBe(atRate(295, 9, 15));
    }
  });

  it('Ogle ↔ CJIA: no fixed fare between them, both ends at 295 — the formula at 295', async () => {
    expect(await quote(OGLE_TERMINAL, CJIA_TERMINAL, 45, 55)).toMatchObject({ fare: atRate(295, 45, 55), source: 'formula', fromZoneId: 'ogle-airport', toZoneId: 'cjia-airport' });
    expect((await quote(CJIA_TERMINAL, OGLE_TERMINAL, 45, 55)).fare).toBe(atRate(295, 45, 55));
  });

  it('a short hop from an airport (2 km) is the airport rate on a 2 km road — inside the included kilometres it is the base alone', async () => {
    expect((await quote(CJIA_TERMINAL, { lat: 6.51, lng: -58.23 }, 2, 5)).fare).toBe(atRate(295, 2, 5));
    expect((await quote(OGLE_TERMINAL, { lat: 6.82, lng: -58.09 }, 2, 5)).fare).toBe(atRate(295, 2, 5));
  });

  it('in town — Georgetown Central → South, no fixed fare any more — the market\'s own per-km', async () => {
    expect(await quote(GEORGETOWN_CENTRAL, GEORGETOWN_SOUTH, 8, 20)).toMatchObject({ fare: national(8, 20), source: 'formula', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' });
  });
});

describe('the owner\'s worked examples, as literal numbers (October formula: 800 includes 3 km, then 175 a km; airports 295)', () => {
  it('this database prices Guyana by the October formula', () => {
    expect(gy).toMatchObject({ base: 800, includedKm: 3, perKm: 175, perMin: 0, minimum: 800 });
  });

  it('Georgetown → CJIA, 41 km: 800 + 295 × 38 = 12,010 → 12,000, both directions, from Central or South', async () => {
    for (const [from, to] of [[GEORGETOWN_CENTRAL, CJIA_TERMINAL], [CJIA_TERMINAL, GEORGETOWN_CENTRAL], [GEORGETOWN_SOUTH, CJIA_TERMINAL], [CJIA_TERMINAL, GEORGETOWN_SOUTH]] as const) {
      expect((await quote(from, to, 41, 50)).fare).toBe(12_000);
    }
  });

  it('Georgetown → Ogle, 9 km: 800 + 295 × 6 = 2,570 → 2,600, both directions', async () => {
    for (const [from, to] of [[GEORGETOWN_CENTRAL, OGLE_TERMINAL], [OGLE_TERMINAL, GEORGETOWN_CENTRAL], [GEORGETOWN_SOUTH, OGLE_TERMINAL]] as const) {
      expect((await quote(from, to, 9, 15)).fare).toBe(2_600);
    }
  });

  it('2 km from an airport: inside the included kilometres, 800', async () => {
    expect((await quote(CJIA_TERMINAL, { lat: 6.51, lng: -58.23 }, 2, 5)).fare).toBe(800);
    expect((await quote({ lat: 6.82, lng: -58.09 }, OGLE_TERMINAL, 2, 5)).fare).toBe(800);
  });

  it('in town, 175 a km: Georgetown Central → South, 8 km: 800 + 175 × 5 = 1,675 → 1,700 (it was a fixed 2,000)', async () => {
    expect(await quote(GEORGETOWN_CENTRAL, GEORGETOWN_SOUTH, 8, 20)).toMatchObject({ fare: 1_700, source: 'formula' });
  });

  it('the same 41 km with no airport at either end is the town rate: 800 + 175 × 38 = 7,450 → 7,500', async () => {
    expect((await quote(GEORGETOWN_CENTRAL, { lat: 6.70, lng: -57.28 }, 41, 50)).fare).toBe(7_500);
  });
});
