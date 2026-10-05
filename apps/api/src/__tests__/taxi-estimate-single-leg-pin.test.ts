import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { FareService } from '../modules/rides/fare.service';
import { HaversineMapsProvider, OsrmMapsProvider } from '../providers/maps/maps-provider';
import { pinLegacyGuyanaTaxiCard } from './helpers/legacy-taxi-card';
import { plantGeorgetownPair } from './helpers/zone-fare-fixture';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 2/8] Today's single-leg estimate, pinned BEFORE multi-stop
// pricing was written, and never edited after. A ride without stops must price
// exactly as it did: the same numbers, the same fields, the same bytes on the
// wire — through the formula, the zone table, the minimum fare, a real OSRM
// route, the OSRM-down fallback and the zone-table kill switch.
//
// Every number here was derived by hand from the default GY rates (base 1000,
// perKm 300, perMin 25, minimum 1500; Comfort ×1.35, Group ×2.5) and the seeded
// Georgetown zones (Central → South = 2000), then confirmed against the code
// as it stood. Phone prefix +5923417 (grepped: unused elsewhere).
//
// [PRICING-GY-OCT] Guyana's default is now the owner's October fare (pinned in
// fares-georgetown-defaults.test.ts). This file puts the card these bytes were
// derived from — which names no included kilometres — on the Guyana row and
// restores the seeded card after: the formula with included kilometres must
// answer every byte below unchanged for a config that names none.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = '+5923417';

// Fixtures. Both ends of A and C sit in Georgetown Central; B runs Central →
// South (the 2000 zone fare, planted by this suite: helpers/zone-fare-fixture); D leaves the zones; E is outside every zone.
const A = { pickup: { lat: 6.8013, lng: -58.1553 }, dropoff: { lat: 6.8143, lng: -58.1443 } };
const B = { pickup: { lat: 6.81, lng: -58.155 }, dropoff: { lat: 6.755, lng: -58.155 } };
const C = { pickup: { lat: 6.81, lng: -58.155 }, dropoff: { lat: 6.8105, lng: -58.155 } };
const D = { pickup: { lat: 6.8013, lng: -58.1553 }, dropoff: { lat: 6.70, lng: -58.20 } };
const E = { pickup: { lat: 6.90, lng: -58.10 }, dropoff: { lat: 6.95, lng: -58.05 } };

/** A: 2.4544 km straight-line ×1.3 → 2.45 km, 6 min → 1885 → 1900. */
const A_ESTIMATE = {
  fare: 1900, currencyCode: 'GYD', distanceKm: 2.5, billableKm: 2.45, routeSource: 'haversine',
  durationMin: 6, source: 'formula', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-central',
};
/** B: the Central → South zone fare wins over the formula (7.95 km, 20 min). */
const B_ESTIMATE = {
  fare: 2000, currencyCode: 'GYD', distanceKm: 8, billableKm: 7.95, routeSource: 'haversine',
  durationMin: 20, source: 'zone_table', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south',
  fromZoneVersion: 1, toZoneVersion: 1,
};
/** C: a 70 m hop — 1046 rounds to 1000, the minimum lifts it to 1500. */
const C_ESTIMATE = {
  fare: 1500, currencyCode: 'GYD', distanceKm: 0.1, billableKm: 0.07, routeSource: 'haversine',
  durationMin: 1, source: 'formula', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-central',
};
/** D: 15.99 km, 39 min → 6772 → 6800; the destination is in no zone. */
const D_ESTIMATE = {
  fare: 6800, currencyCode: 'GYD', distanceKm: 16, billableKm: 15.99, routeSource: 'haversine',
  durationMin: 39, source: 'formula', fromZoneId: 'georgetown-central', toZoneId: undefined,
};
/** E over a real OSRM route of 10 150 m / 1620 s: 10.15 km, 27 min → 4720 → 4700. */
const E_OSRM_ESTIMATE = {
  fare: 4700, currencyCode: 'GYD', distanceKm: 10.2, billableKm: 10.15, routeSource: 'osrm',
  durationMin: 27, source: 'formula', fromZoneId: undefined, toZoneId: undefined,
};
/** B with FARE_ZONE_TABLE_KILL=1: the formula prices it — 3885 → 3900. */
const B_KILLED_ESTIMATE = {
  fare: 3900, currencyCode: 'GYD', distanceKm: 8, billableKm: 7.95, routeSource: 'haversine',
  durationMin: 20, source: 'formula', fromZoneId: undefined, toZoneId: undefined,
};

const tiers = (source: string, economy: number, comfort: number, group: number) => [
  { rideClass: 'ECONOMY', multiplier: 1, fare: economy, capacity: 4, source },
  { rideClass: 'COMFORT', multiplier: 1.35, fare: comfort, capacity: 4, source },
  { rideClass: 'GROUP', multiplier: 2.5, fare: group, capacity: 14, source },
];

/** The exact bytes POST /rides/estimate answers today. */
const A_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":1900,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":2600,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":4800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":2.5,"durationMin":6,"billableKm":2.45,"routeSource":"haversine"}}';
const B_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":2000,"capacity":4,"source":"zone_table"},{"rideClass":"COMFORT","multiplier":1.35,"fare":2700,"capacity":4,"source":"zone_table"},{"rideClass":"GROUP","multiplier":2.5,"fare":5000,"capacity":14,"source":"zone_table"}],"currencyCode":"GYD","distanceKm":8,"durationMin":20,"billableKm":7.95,"routeSource":"haversine"}}';
const C_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":1500,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":2000,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":3800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":0.1,"durationMin":1,"billableKm":0.07,"routeSource":"haversine"}}';
const INVALID_PICKUP_BODY = '{"success":false,"error":{"code":"VALIDATION_ERROR","message":"Invalid request data","details":{"pickup.lat":["Number must be less than or equal to 90"]}}}';

/** A fetch stub that answers one OSRM route and records the URL it was asked. */
function osrmRoute(distanceM: number, durationS: number) {
  return vi.fn(async (_url: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 'Ok', routes: [{ distance: distanceM, duration: durationS }] }),
  }));
}

async function buildApp(): Promise<FastifyInstance> {
  const built = Fastify({ logger: false });
  registerErrorHandler(built);
  registerEmptyJsonBodyParser(built);
  await built.register(prismaPlugin);
  await built.register(redisPlugin);
  await built.register(authPlugin);
  await built.register(socketPlugin);
  await built.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await built.ready();
  return built;
}

let app: FastifyInstance;
let token: string;
let seq = 0;
let restoreTaxiCard: () => Promise<void> = async () => {};
let removeGeorgetownPair: () => Promise<void> = async () => {};

async function purgeFixtures(on: FastifyInstance) {
  const users = await on.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  await on.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await on.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await on.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeCustomer(on: FastifyInstance): Promise<string> {
  seq += 1;
  const user = await on.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`,
      firstName: 'Pin',
      lastName: `Rider${seq}`,
      roles: ['CUSTOMER'] as UserRole[],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  const jwt = on.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await on.prisma.session.create({
    data: { userId: user.id, token: jwt, refreshToken: nanoid(48), deviceId: 'estimate-pin', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return jwt;
}

function postEstimate(on: FastifyInstance, jwt: string, payload: unknown) {
  return on.inject({
    method: 'POST',
    url: '/api/v1/rides/estimate',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  delete process.env['MAPS_PROVIDER'];
  delete process.env['OSRM_URL'];
  app = await buildApp();
  restoreTaxiCard = await pinLegacyGuyanaTaxiCard(app.prisma);
  removeGeorgetownPair = await plantGeorgetownPair(app.prisma);
  await purgeFixtures(app);
  token = await makeCustomer(app);
});

afterAll(async () => {
  await restoreTaxiCard();
  await removeGeorgetownPair();
  await purgeFixtures(app);
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['FARE_ZONE_TABLE_KILL'];
});

describe('single-leg estimate: the fare service, pinned', () => {
  const haversine = () => new FareService(app.prisma, new HaversineMapsProvider());

  it('A — the formula inside one zone', async () => {
    expect(await haversine().estimate(A.pickup, A.dropoff, 'GY')).toStrictEqual(A_ESTIMATE);
  });

  it('B — the zone table (Central → South) wins over the formula', async () => {
    expect(await haversine().estimate(B.pickup, B.dropoff, 'GY')).toStrictEqual(B_ESTIMATE);
  });

  it('C — the minimum fare lifts a short hop', async () => {
    expect(await haversine().estimate(C.pickup, C.dropoff, 'GY')).toStrictEqual(C_ESTIMATE);
  });

  it('D — a destination outside every zone prices by the formula', async () => {
    expect(await haversine().estimate(D.pickup, D.dropoff, 'GY')).toStrictEqual(D_ESTIMATE);
  });

  it('E — a real OSRM route: one /route call, its metres and seconds priced (10.15 km / 27 min → 4700)', async () => {
    const f = osrmRoute(10_150, 1620);
    vi.stubGlobal('fetch', f);
    const svc = new FareService(app.prisma, new OsrmMapsProvider('http://osrm.test'));
    expect(await svc.estimate(E.pickup, E.dropoff, 'GY')).toStrictEqual(E_OSRM_ESTIMATE);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe('http://osrm.test/route/v1/driving/-58.1,6.9;-58.05,6.95?overview=false');
  });

  it('OSRM down — the single-leg fallback prices exactly as the deterministic estimate, zone fares included', async () => {
    const down = new FareService(app.prisma, new OsrmMapsProvider('http://127.0.0.1:0'));
    expect(await down.estimate(A.pickup, A.dropoff, 'GY')).toStrictEqual(A_ESTIMATE);
    expect(await down.estimate(B.pickup, B.dropoff, 'GY')).toStrictEqual(B_ESTIMATE);
  });

  it('FARE_ZONE_TABLE_KILL=1 — the zone route prices by the formula', async () => {
    process.env['FARE_ZONE_TABLE_KILL'] = '1';
    expect(await haversine().estimate(B.pickup, B.dropoff, 'GY')).toStrictEqual(B_KILLED_ESTIMATE);
  });

  it('the tiers — Economy, Comfort, Group from the one base fare', async () => {
    expect(await haversine().estimateTiers(A.pickup, A.dropoff, 'GY')).toStrictEqual({
      tiers: tiers('formula', 1900, 2600, 4800), currencyCode: 'GYD', distanceKm: 2.5, durationMin: 6, billableKm: 2.45, routeSource: 'haversine',
    });
    expect(await haversine().estimateTiers(B.pickup, B.dropoff, 'GY')).toStrictEqual({
      tiers: tiers('zone_table', 2000, 2700, 5000), currencyCode: 'GYD', distanceKm: 8, durationMin: 20, billableKm: 7.95, routeSource: 'haversine',
    });
    vi.stubGlobal('fetch', osrmRoute(10_150, 1620));
    const osrm = new FareService(app.prisma, new OsrmMapsProvider('http://osrm.test'));
    expect(await osrm.estimateTiers(E.pickup, E.dropoff, 'GY')).toStrictEqual({
      tiers: tiers('formula', 4700, 6300, 11800), currencyCode: 'GYD', distanceKm: 10.2, durationMin: 27, billableKm: 10.15, routeSource: 'osrm',
    });
  });
});

describe('single-leg estimate: POST /rides/estimate, byte for byte', () => {
  it('answers the same bytes for the formula, the zone table and the minimum', async () => {
    const a = await postEstimate(app, token, A);
    expect(a.statusCode).toBe(200);
    expect(a.body).toBe(A_BODY);
    expect((await postEstimate(app, token, B)).body).toBe(B_BODY);
    expect((await postEstimate(app, token, C)).body).toBe(C_BODY);
  });

  it('an empty or null stop list is a ride without stops — the same bytes', async () => {
    expect((await postEstimate(app, token, { ...A, stops: [] })).body).toBe(A_BODY);
    expect((await postEstimate(app, token, { ...A, stops: null })).body).toBe(A_BODY);
  });

  it('refuses a broken pickup with the same validation error', async () => {
    const res = await postEstimate(app, token, { pickup: { lat: 91, lng: 0 }, dropoff: A.dropoff });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(INVALID_PICKUP_BODY);
  });

  describe('with MAPS_PROVIDER=osrm and OSRM unreachable', () => {
    let osrmApp: FastifyInstance;
    let osrmToken: string;
    beforeAll(async () => {
      // The route builds its fare service at registration: point it at an
      // unroutable OSRM for this app only.
      process.env['MAPS_PROVIDER'] = 'osrm';
      process.env['OSRM_URL'] = 'http://127.0.0.1:0';
      try {
        osrmApp = await buildApp();
      } finally {
        delete process.env['MAPS_PROVIDER'];
        delete process.env['OSRM_URL'];
      }
      osrmToken = await makeCustomer(osrmApp);
    });
    afterAll(async () => {
      await osrmApp.close();
    });

    it('a single-leg ride keeps today’s fallback: the same bytes as the deterministic estimate', async () => {
      const a = await postEstimate(osrmApp, osrmToken, A);
      expect(a.statusCode).toBe(200);
      expect(a.body).toBe(A_BODY);
      expect((await postEstimate(osrmApp, osrmToken, B)).body).toBe(B_BODY);
    });
  });
});
