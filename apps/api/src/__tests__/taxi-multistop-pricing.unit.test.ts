import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { FareService, formulaFare } from '../modules/rides/fare.service';
import { planTaxiStops, taxiMaxStops } from '../modules/rides/taxi-stops-flag';
import { LEGACY_GY_TAXI_CARD } from './helpers/legacy-taxi-card';
import { OsrmMapsProvider, type LatLng, type MapsProvider, type RouteLeg, type RouteLegsEstimate, type RouteSource } from '../providers/maps/maps-provider';
// [VERIFY-DOCS · owner ruling 9, 6 Oct 2026 — a DELIBERATE change] no GROUP tier while both buses are hidden at launch.

// ---------------------------------------------------------------------------
// [TAXI multi-stop 2/8] Pricing a ride with stops, service-free: the WHOLE
// route is one trip. Its kilometres are rounded once, its minutes once, the
// base fare and the minimum apply once, and there is no fee per stop and none
// for waiting. A route the configured engine could not road-route is refused
// (503), never priced from a guess; a route the zone table prices is refused
// (409) before anything is routed. Default GY rates throughout: base 1000,
// perKm 300, perMin 25, minimum 1500; Comfort ×1.35, Group ×2.5.
//
// [PRICING-GY-OCT] Guyana's default is now the owner's October fare (pinned in
// fares-georgetown-defaults.test.ts, its included kilometres once per trip
// with stops too). The fake Guyana row below carries the card these numbers
// were derived from (LEGACY_GY_TAXI_CARD, which names no included kilometres):
// the formula with included kilometres must price every one of them unchanged.
// ---------------------------------------------------------------------------

const PICKUP = { lat: 6.90, lng: -58.10 };
const STOP_1 = { lat: 6.91, lng: -58.09 };
const STOP_2 = { lat: 6.92, lng: -58.08 };
const STOP_3 = { lat: 6.93, lng: -58.07 };
const DESTINATION = { lat: 6.95, lng: -58.05 };

/** A routing engine that answers whatever legs the test gives it, and
 *  remembers every itinerary it was asked for. */
function engine(legs: RouteLeg[], opts: { km?: number; minutes?: number | null; source?: RouteSource; degraded?: boolean } = {}) {
  const asked: LatLng[][] = [];
  const knownMinutes = legs.every((l) => l.minutes != null);
  const maps = {
    routeLegs: async (points: LatLng[]): Promise<RouteLegsEstimate> => {
      asked.push(points);
      return {
        legs,
        km: opts.km ?? legs.reduce((sum, l) => sum + l.km, 0),
        minutes: opts.minutes !== undefined ? opts.minutes : knownMinutes ? legs.reduce((sum, l) => sum + (l.minutes ?? 0), 0) : null,
        source: opts.source ?? 'osrm',
        degraded: opts.degraded ?? false,
      };
    },
  } as unknown as MapsProvider;
  return { maps, asked };
}

/** The slice of Prisma the pricing path reads, with no zones by default and
 *  GY on the legacy card (a valid column, recorded as a version on first read). */
function fakePrisma(zones: { rows?: unknown[]; fares?: Array<{ fromZoneId: string; toZoneId: string }> } = {}) {
  const reads: string[] = [];
  const prisma = {
    zone: { findMany: async () => { reads.push('zone'); return zones.rows ?? []; } },
    zoneFare: { findMany: async () => { reads.push('zoneFare'); return zones.fares ?? []; } },
    countryConfig: {
      findUnique: async () => { reads.push('countryConfig'); return { code: 'GY', currencyCode: 'GYD', taxiRates: LEGACY_GY_TAXI_CARD, taxiClassRates: null }; },
    },
    pricingConfigVersion: { findFirst: async () => null, create: async (args: { data: unknown }) => args.data },
  } as unknown as PrismaClient;
  return { prisma, reads };
}

function price(stops: LatLng[], maps: MapsProvider, prisma = fakePrisma().prisma) {
  return new FareService(prisma, maps).estimateItineraryTiers(PICKUP, stops, DESTINATION, 'GY');
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got a price');
}

const fares = (est: { tiers: Array<{ rideClass: string; fare: number }> }) => Object.fromEntries(est.tiers.map((t) => [t.rideClass, t.fare]));

describe('the formula is applied once, to the whole route', () => {
  it('the plan’s worked example: 10.15 km / 27 min → 4720 → Economy 4700, Comfort 6345 → 6300', async () => {
    const { maps } = engine([{ km: 4, minutes: 10 }, { km: 6.15, minutes: 17 }], { km: 10.15, minutes: 27 });
    const est = await price([STOP_1], maps);
    expect(fares(est)).toEqual({ ECONOMY: 4700, COMFORT: 6300 });
    expect(est).toMatchObject({ billableKm: 10.15, distanceKm: 10.2, durationMin: 27, routeSource: 'osrm', currencyCode: 'GYD' });
    expect(est.tiers.every((t) => t.source === 'formula')).toBe(true);
    // Pricing each leg as its own trip would have charged 2500 + 3300.
    expect(formulaFare(LEGACY_GY_TAXI_CARD, 4, 10) + formulaFare(LEGACY_GY_TAXI_CARD, 6.15, 17)).toBe(5800);
  });

  it('the base fare once: four short legs are one 2 km trip (1700), not four trips (4 × 1500)', async () => {
    const leg = { km: 0.5, minutes: 1 };
    const { maps } = engine([leg, leg, leg, leg]);
    const est = await price([STOP_1, STOP_2, STOP_3], maps);
    expect(fares(est)).toEqual({ ECONOMY: 1700, COMFORT: 2300 });
    expect(est).toMatchObject({ billableKm: 2, durationMin: 4 });
  });

  it('the minimum once: a short trip with a stop costs the minimum, once', async () => {
    const { maps } = engine([{ km: 0.1, minutes: 0.3 }, { km: 0.1, minutes: 0.3 }]);
    const est = await price([STOP_1], maps);
    expect(fares(est)).toEqual({ ECONOMY: 1500, COMFORT: 2000 });
  });

  it('no fee per stop: the same road with more stops on it costs the same', async () => {
    const two = await price([STOP_1], engine([{ km: 3, minutes: 6 }, { km: 3, minutes: 6 }]).maps);
    const four = await price([STOP_1, STOP_2, STOP_3], engine([{ km: 1.5, minutes: 3 }, { km: 1.5, minutes: 3 }, { km: 1.5, minutes: 3 }, { km: 1.5, minutes: 3 }]).maps);
    expect(fares(four)).toEqual(fares(two));
    expect(fares(two)['ECONOMY']).toBe(formulaFare(LEGACY_GY_TAXI_CARD, 6, 12)); // 1000 + 1800 + 300 = 3100
  });
});

describe('each quantity is rounded once, from the whole route', () => {
  it('kilometres: 3 × 1.004 km is 3.01 billable, not 3 × 1.00', async () => {
    const leg = { km: 1.004, minutes: null };
    const est = await price([STOP_1, STOP_2], engine([leg, leg, leg]).maps);
    expect(est.billableKm).toBe(3.01);
    expect(est.distanceKm).toBe(3);
    // No engine minutes: the speed model runs once, on the whole 3.01 km (7.2 → 8 min).
    expect(est.durationMin).toBe(8);
  });

  it('minutes: 3 × 5.2 min is ceil(15.6) = 16, not 3 × 6 = 18 — and the fare follows (2300, not 2400)', async () => {
    const leg = { km: 1, minutes: 5.2 };
    const est = await price([STOP_1, STOP_2], engine([leg, leg, leg]).maps);
    expect(est.durationMin).toBe(16);
    expect(fares(est)['ECONOMY']).toBe(2300);
  });

  it('the kilometres priced are the engine’s whole-route total, not a re-sum of its legs', async () => {
    const { maps } = engine([{ km: 5, minutes: 10 }, { km: 5, minutes: 10 }], { km: 10.07, minutes: 20 });
    expect((await price([STOP_1], maps)).billableKm).toBe(10.07);
  });
});

describe('the legs are for reading, never for money', () => {
  it('names each leg by the itinerary’s place codes, in whole metres and seconds', async () => {
    const { maps } = engine([{ km: 4, minutes: 10 }, { km: 2.5004, minutes: 7.51 }, { km: 3.64, minutes: 9 }]);
    const est = await price([STOP_1, STOP_2], maps);
    expect(est.legs).toEqual([
      { from: 'PICKUP', to: 'STOP_1', meters: 4000, seconds: 600 },
      { from: 'STOP_1', to: 'STOP_2', meters: 2500, seconds: 451 },
      { from: 'STOP_2', to: 'DESTINATION', meters: 3640, seconds: 540 },
    ]);
  });

  it('a leg without engine minutes says so (null), never a made-up duration', async () => {
    const est = await price([STOP_1], engine([{ km: 2, minutes: null }, { km: 2, minutes: null }], { source: 'haversine' }).maps);
    expect(est.legs.map((l) => l.seconds)).toEqual([null, null]);
    expect(est.routeSource).toBe('haversine');
  });

  it('routes the itinerary in the passenger’s order, in one call', async () => {
    const { maps, asked } = engine([{ km: 1, minutes: 2 }, { km: 1, minutes: 2 }, { km: 1, minutes: 2 }]);
    await price([STOP_2, STOP_1], maps);
    expect(asked).toEqual([[PICKUP, STOP_2, STOP_1, DESTINATION]]);
  });
});

describe('fails closed: never a price from a guess', () => {
  it('a degraded route (the configured engine failed) is 503 ROUTE_UNAVAILABLE', async () => {
    const { maps } = engine([{ km: 2, minutes: null }, { km: 2, minutes: null }], { source: 'haversine', degraded: true });
    const err = await refusal(price([STOP_1], maps));
    expect([err.statusCode, err.code, err.details]).toEqual([503, 'ROUTE_UNAVAILABLE', { stopCount: 1 }]);
  });

  it('an engine answer with the wrong number of legs is refused, not priced', async () => {
    const err = await refusal(price([STOP_1, STOP_2], engine([{ km: 2, minutes: 4 }, { km: 2, minutes: 4 }]).maps));
    expect(err.code).toBe('ROUTE_UNAVAILABLE');
  });

  it('a whole-route distance that is not a real distance is refused — a route of 0 km routed nothing, so no minimum fare for it', async () => {
    for (const km of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      const err = await refusal(price([STOP_1], engine([{ km: 0, minutes: 0 }, { km: 0, minutes: 0 }], { km }).maps));
      expect([km, err.statusCode, err.code]).toEqual([km, 503, 'ROUTE_UNAVAILABLE']);
    }
  });

  it('a leg that is not a real distance or duration is refused, whatever the total says', async () => {
    for (const bad of [{ km: Number.NaN, minutes: 2 }, { km: -1, minutes: 2 }, { km: Number.POSITIVE_INFINITY, minutes: 2 }, { km: 1, minutes: Number.NaN }, { km: 1, minutes: -1 }]) {
      const err = await refusal(price([STOP_1], engine([{ km: 3, minutes: 6 }, bad], { km: 4, minutes: 8 }).maps));
      expect(err.code).toBe('ROUTE_UNAVAILABLE');
    }
  });

  it('a whole-route duration that is not a real one is refused, whatever engine gave it (never a lower fare)', async () => {
    for (const minutes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const err = await refusal(price([STOP_1], engine([{ km: 3, minutes: 6 }, { km: 1, minutes: 2 }], { km: 4, minutes }).maps));
      expect([minutes, err.statusCode, err.code]).toEqual([minutes, 503, 'ROUTE_UNAVAILABLE']);
    }
  });

  it('one leg of 0 m is real (two points across one road snap to one node): the route is priced', async () => {
    const est = await price([STOP_1], engine([{ km: 2, minutes: 4 }, { km: 0, minutes: 0 }]).maps);
    expect(fares(est)).toEqual({ ECONOMY: 1700, COMFORT: 2300 }); // 1000 + 600 + 100
    expect(est.legs[1]).toEqual({ from: 'STOP_1', to: 'DESTINATION', meters: 0, seconds: 0 });
  });

  it('a zone-priced route is refused before anything is routed or read further', async () => {
    const everywhere = { type: 'Polygon', coordinates: [[[-59, 6], [-57, 6], [-57, 8], [-59, 8], [-59, 6]]] };
    const { prisma, reads } = fakePrisma({ rows: [{ id: 'z', name: 'z', boundary: everywhere, priority: 0, version: 1 }], fares: [{ fromZoneId: 'z', toZoneId: 'z' }] });
    const { maps, asked } = engine([{ km: 1, minutes: 2 }, { km: 1, minutes: 2 }]);
    const err = await refusal(price([STOP_1], maps, prisma));
    expect([err.statusCode, err.code, err.details]).toEqual([409, 'MULTI_STOP_ZONE_PRICED', { from: 'PICKUP', to: 'STOP_1', fromZoneId: 'z', toZoneId: 'z' }]);
    expect(asked).toEqual([]);
    expect(reads).toEqual(['zone', 'zoneFare']);
  });

  it('a point outside the launch market is refused (400 STOP_OUT_OF_MARKET) before anything is read or routed', async () => {
    const { prisma, reads } = fakePrisma();
    const { maps, asked } = engine([{ km: 1, minutes: 2 }, { km: 1, minutes: 2 }]);
    const portOfSpain = { lat: 10.6596, lng: -61.5089 };
    const err = await refusal(price([portOfSpain], maps, prisma));
    expect([err.statusCode, err.code, err.details]).toEqual([400, 'STOP_OUT_OF_MARKET', { place: 'STOP_1' }]);
    expect([asked, reads]).toEqual([[], []]);
  });

  it('a ride without stops is not priced here — estimateTiers prices it, exactly as before', async () => {
    await expect(price([], engine([]).maps)).rejects.toThrow(/without stops is priced by estimateTiers/);
  });
});

describe('provider → fare: a RAW OSRM body, parsed as the provider parses it (AX290 R1)', () => {
  // The body is text, read through a real Response, so JSON itself makes the
  // values: 1e309 parses to Infinity, which a parsed-object stub never shows.
  // (JSON has no NaN; maps-provider.test.ts covers NaN on the parsed object.)
  afterEach(() => vi.unstubAllGlobals());
  const body = (leg1: string, leg2: string, total: string) =>
    `{"code":"Ok","routes":[{"distance":10150,"duration":${total},"legs":[{"distance":4000,"duration":${leg1}},{"distance":6150,"duration":${leg2}}]}]}`;
  const osrmPrice = (raw: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })));
    return new FareService(fakePrisma().prisma, new OsrmMapsProvider('http://osrm.test')).estimateItineraryTiers(PICKUP, [STOP_1], DESTINATION, 'GY');
  };

  it('a valid body prices the worked example: the raw path is live (4700 / 6300)', async () => {
    const est = await osrmPrice(body('600', '1020', '1620'));
    expect(fares(est)).toEqual({ ECONOMY: 4700, COMFORT: 6300 });
    expect(est.legs.map((l) => l.seconds)).toEqual([600, 1020]);
  });

  it.each([
    ['a leg duration of 1e309 (JSON parses it to Infinity)', body('1e309', '1020', '1620')],
    ['a leg duration of -1e309 (-Infinity)', body('600', '-1e309', '1620')],
    ['a negative leg duration (it would lower the fare)', body('-600', '1020', '1620')],
    ['a leg duration that is a string', body('"600"', '1020', '1620')],
    ['a whole-route duration of 1e309 (Infinity)', body('600', '1020', '1e309')],
    ['a negative whole-route duration (it would lower the fare)', body('600', '1020', '-1620')],
    ['a whole-route duration that is a string', body('600', '1020', '"1620"')],
  ])('%s → 503 ROUTE_UNAVAILABLE, never a price', async (_label, raw) => {
    const err = await refusal(osrmPrice(raw));
    expect([err.statusCode, err.code]).toEqual([503, 'ROUTE_UNAVAILABLE']);
  });

  it('ABSENT durations (null, or no key at all) fall back to the speed model, as today: 10.15 km → 25 min → 4670 → 4700', async () => {
    const est = await osrmPrice('{"code":"Ok","routes":[{"distance":10150,"duration":null,"legs":[{"distance":4000,"duration":null},{"distance":6150}]}]}');
    expect(est).toMatchObject({ billableKm: 10.15, durationMin: 25, routeSource: 'osrm' });
    expect(fares(est)).toEqual({ ECONOMY: 4700, COMFORT: 6300 });
    expect(est.legs.map((l) => l.seconds)).toEqual([null, null]);
  });
});

describe('TAXI_MAX_STOPS: off unless it says a whole number', () => {
  it.each([
    [undefined, 0], ['', 0], ['0', 0], ['1', 1], ['2', 2], ['3', 3], [' 2 ', 2],
    ['4', 3], ['10', 3], ['-1', 0], ['2.5', 0], ['abc', 0], ['yes', 0], ['0x2', 0], ['1e1', 0],
  ])('%j → %i', (raw, expected) => {
    expect(taxiMaxStops(raw === undefined ? {} : { TAXI_MAX_STOPS: raw })).toBe(expected);
  });
});

describe('planTaxiStops: the switch, then the itinerary rules', () => {
  const pickup = { lat: 6.8013, lng: -58.1553 };
  const dropoff = { lat: 6.84, lng: -58.13 };
  const stop = { lat: 6.81, lng: -58.16, address: 'Stabroek Market' };
  const other = { lat: 6.82, lng: -58.15, address: 'Bourda Market' };
  const OFF = {};
  const ON = { TAXI_MAX_STOPS: '3' };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a ride without stops plans nothing, whatever the switch says', () => {
    for (const env of [OFF, ON, { TAXI_MAX_STOPS: 'garbage' }]) {
      expect(planTaxiStops({ pickup, dropoff }, env)).toEqual([]);
      expect(planTaxiStops({ pickup, dropoff, stops: null }, env)).toEqual([]);
      expect(planTaxiStops({ pickup, dropoff, stops: [] }, env)).toEqual([]);
    }
  });

  it('switched off, a stop is refused as MULTI_STOP_UNAVAILABLE (409) before it is looked at', () => {
    for (const stops of [[stop], [{ lat: 999, lng: 999, address: '' }], [stop, other, stop, other, stop]]) {
      let caught: unknown;
      try { planTaxiStops({ pickup, dropoff, stops }, OFF); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(AppError);
      expect([(caught as AppError).statusCode, (caught as AppError).code, (caught as AppError).details]).toEqual([409, 'MULTI_STOP_UNAVAILABLE', { maxStops: 0, stopCount: stops.length }]);
    }
  });

  it('reads the process environment by default', () => {
    vi.stubEnv('TAXI_MAX_STOPS', '');
    expect(() => planTaxiStops({ pickup, dropoff, stops: [stop] })).toThrow(expect.objectContaining({ code: 'MULTI_STOP_UNAVAILABLE' }));
    vi.stubEnv('TAXI_MAX_STOPS', '1');
    expect(planTaxiStops({ pickup, dropoff, stops: [stop] })).toHaveLength(1);
  });

  it('switched on, the itinerary rules judge and number the stops', () => {
    expect(planTaxiStops({ pickup, dropoff, stops: [other, stop] }, ON)).toEqual([
      { sequence: 1, lat: other.lat, lng: other.lng, address: 'Bourda Market' },
      { sequence: 2, lat: stop.lat, lng: stop.lng, address: 'Stabroek Market' },
    ]);
    expect(() => planTaxiStops({ pickup, dropoff, stops: [stop, other] }, { TAXI_MAX_STOPS: '1' }))
      .toThrow(expect.objectContaining({ code: 'TOO_MANY_STOPS', details: { maxStops: 1, stopCount: 2 } }));
    expect(() => planTaxiStops({ pickup, dropoff, stops: [{ ...stop, lat: 91 }] }, ON)).toThrow(ZodError);
    expect(() => planTaxiStops({ pickup, dropoff, stops: [{ ...pickup, address: 'Right here' }] }, ON))
      .toThrow(expect.objectContaining({ code: 'STOP_TOO_CLOSE' }));
  });

  describe('every point of a route with stops lies where Swift works (DS282 F3)', () => {
    const abroad = { lat: 10.6596, lng: -61.5089 }; // Port of Spain: a routing engine would snap it onto a Guyana road
    const refused = (fn: () => unknown) => {
      try { fn(); } catch (err) { if (err instanceof AppError) return [err.statusCode, err.code, err.details, err.message]; throw err; }
      throw new Error('expected a refusal');
    };

    it('names the place outside the launch market: a stop, the destination, the pickup', () => {
      expect(refused(() => planTaxiStops({ pickup, dropoff, stops: [stop, { ...abroad, address: 'Port of Spain' }] }, ON)))
        .toEqual([400, 'STOP_OUT_OF_MARKET', { place: 'STOP_2' }, 'Stop 2 is outside Guyana, where Swift works today. Choose a place in Guyana.']);
      expect(refused(() => planTaxiStops({ pickup, dropoff: abroad, stops: [stop] }, ON)))
        .toEqual([400, 'STOP_OUT_OF_MARKET', { place: 'DESTINATION' }, 'Your destination is outside Guyana, where Swift works today. Choose a place in Guyana.']);
      expect(refused(() => planTaxiStops({ pickup: abroad, dropoff, stops: [stop] }, ON)))
        .toEqual([400, 'STOP_OUT_OF_MARKET', { place: 'PICKUP' }, 'Your pickup is outside Guyana, where Swift works today. Choose a place in Guyana.']);
    });

    it('accepts every real Guyana place, border towns included (the coarse launch box)', () => {
      const lethem = { lat: 3.3803, lng: -59.7968, address: 'Lethem' };
      const corriverton = { lat: 5.9, lng: -57.1667, address: 'Corriverton' };
      expect(planTaxiStops({ pickup, dropoff: { lat: 8.2, lng: -59.7833 }, stops: [lethem, corriverton] }, ON)).toHaveLength(2);
    });

    it('a ride without stops is never judged here: its pickup and destination keep the rules of today', () => {
      expect(planTaxiStops({ pickup: abroad, dropoff: abroad }, ON)).toEqual([]);
      expect(planTaxiStops({ pickup: abroad, dropoff: abroad, stops: [] }, ON)).toEqual([]);
    });

    it('the switch is still judged first: switched off, a stop abroad is MULTI_STOP_UNAVAILABLE', () => {
      expect(refused(() => planTaxiStops({ pickup, dropoff, stops: [{ ...abroad, address: 'Port of Spain' }] }, OFF))[1]).toBe('MULTI_STOP_UNAVAILABLE');
    });
  });
});
