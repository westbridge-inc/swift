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
import { pinLegacyGuyanaTaxiCard } from './helpers/legacy-taxi-card';
import { plantGeorgetownPair } from './helpers/zone-fare-fixture';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 2/8] POST /rides/estimate with stops, through the real
// route, the real zone table and the real rates (GY defaults: base 1000, perKm
// 300, perMin 25, minimum 1500; Comfort ×1.35, Group ×2.5). A ride with stops
// is ONE trip over its whole road; it is refused while TAXI_MAX_STOPS is 0,
// refused when the zone table prices any part of it, and refused when the
// configured routing engine cannot route it. The same ride without stops is
// today's estimate (pinned byte for byte in taxi-estimate-single-leg-pin).
// Phone prefix +5923418 (grepped: unused elsewhere).
//
// [PRICING-GY-OCT] Guyana's default is now the owner's October fare (pinned in
// fares-georgetown-defaults.test.ts, its included kilometres once per trip
// with stops too). This file puts the card these bytes were derived from —
// which names no included kilometres — on the Guyana row and restores the
// seeded card after: every byte below must stand unchanged under it.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = '+5923418';

// Georgetown Central (seeded zone; Central → Central has no zone fare).
const PICKUP = { lat: 6.8013, lng: -58.1553 };
const STOP_1 = { lat: 6.8143, lng: -58.1443, address: 'Camp Street' };
const STOP_2 = { lat: 6.825, lng: -58.15, address: 'Sheriff Street' };
const STOP_3 = { lat: 6.805, lng: -58.17, address: 'Stabroek Market' };
const DESTINATION = { lat: 6.82, lng: -58.16 };
// The Central ↔ South zone fare (2000, planted by this suite: helpers/zone-fare-fixture), and a point in neither zone.
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };
const EAST_OF_ZONES = { lat: 6.78, lng: -58.10, address: 'East Bank Road' };
// Outside every zone, for the OSRM cases.
const FAR_PICKUP = { lat: 6.90, lng: -58.10 };
const FAR_STOP = { lat: 6.92, lng: -58.08, address: 'Coast Road' };
const FAR_DESTINATION = { lat: 6.95, lng: -58.05 };

/** P → S1 → F on the deterministic estimate: legs 2454 m + 2399 m, one trip of
 *  4.85 km / 12 min → 2755 → Economy 2800. Priced leg by leg it would be
 *  1900 + 1900 = 3800: the base fare twice. */
const ONE_STOP_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":2800,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":3800,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":7000,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":4.9,"durationMin":12,"billableKm":4.85,"routeSource":"haversine","legs":[{"from":"PICKUP","to":"STOP_1","meters":2454,"seconds":null},{"from":"STOP_1","to":"DESTINATION","meters":2399,"seconds":null}],"maxStops":3,"stopCount":1}}';
/** The plan's worked example over a real OSRM route: legs 4000 m / 600 s and
 *  6150 m / 1020 s, the route 10 150 m / 1620 s → 10.15 km / 27 min → 4720 →
 *  Economy 4700; Comfort 6345 → 6300. */
const WORKED_EXAMPLE_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":4700,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":6300,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":11800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":10.2,"durationMin":27,"billableKm":10.15,"routeSource":"osrm","legs":[{"from":"PICKUP","to":"STOP_1","meters":4000,"seconds":600},{"from":"STOP_1","to":"DESTINATION","meters":6150,"seconds":1020}],"maxStops":3,"stopCount":1}}';

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
      firstName: 'Stops',
      lastName: `Rider${seq}`,
      roles: ['CUSTOMER'] as UserRole[],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  const jwt = on.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await on.prisma.session.create({
    data: { userId: user.id, token: jwt, refreshToken: nanoid(48), deviceId: 'multistop', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return jwt;
}

function estimate(on: FastifyInstance, jwt: string, payload: unknown) {
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('switched off (TAXI_MAX_STOPS=0, the default): inert', () => {
  it('a request carrying stops is refused, 409 MULTI_STOP_UNAVAILABLE, before a stop is looked at', async () => {
    for (const stops of [[STOP_1], [{ lat: 999, lng: 999, address: '' }]]) {
      const res = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'MULTI_STOP_UNAVAILABLE', details: { maxStops: 0, stopCount: 1 } });
    }
  });

  it('a request without stops says nothing about stops', async () => {
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data)).toEqual(['tiers', 'currencyCode', 'distanceKm', 'durationMin', 'billableKm', 'routeSource']);
  });
});

describe('a ride without stops answers the same bytes with the switch off AND on (AX290 R2)', () => {
  // The exact bytes taxi-estimate-single-leg-pin pinned against unmodified
  // main: the formula, the Central → South zone fare, the minimum fare.
  const PINNED: Array<[string, { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number } }, string]> = [
    ['formula', { pickup: { lat: 6.8013, lng: -58.1553 }, dropoff: { lat: 6.8143, lng: -58.1443 } },
      '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":1900,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":2600,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":4800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":2.5,"durationMin":6,"billableKm":2.45,"routeSource":"haversine"}}'],
    ['zone table', { pickup: { lat: 6.81, lng: -58.155 }, dropoff: { lat: 6.755, lng: -58.155 } },
      '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":2000,"capacity":4,"source":"zone_table"},{"rideClass":"COMFORT","multiplier":1.35,"fare":2700,"capacity":4,"source":"zone_table"},{"rideClass":"GROUP","multiplier":2.5,"fare":5000,"capacity":14,"source":"zone_table"}],"currencyCode":"GYD","distanceKm":8,"durationMin":20,"billableKm":7.95,"routeSource":"haversine"}}'],
    ['minimum', { pickup: { lat: 6.81, lng: -58.155 }, dropoff: { lat: 6.8105, lng: -58.155 } },
      '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":1500,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":2000,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":3800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":0.1,"durationMin":1,"billableKm":0.07,"routeSource":"haversine"}}'],
  ];

  it.each(['', '0', '1', '2', '3', 'garbage'])('TAXI_MAX_STOPS=%j: the pinned bytes, for absent, null and empty stops alike', async (flag) => {
    vi.stubEnv('TAXI_MAX_STOPS', flag);
    for (const [name, trip, pinned] of PINNED) {
      for (const noStops of [{}, { stops: null }, { stops: [] }]) {
        const res = await estimate(app, token, { ...trip, ...noStops });
        expect(res.body, `${name} ${JSON.stringify(noStops)}`).toBe(pinned);
      }
    }
  });
});

describe('switched on (TAXI_MAX_STOPS=3)', () => {
  it('without stops: exactly the estimate of today, byte for byte — the switch adds nothing (AX290 R2)', async () => {
    const off = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION });
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    for (const noStops of [{}, { stops: [] }, { stops: null }]) {
      const on = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, ...noStops });
      expect(on.statusCode).toBe(200);
      expect(on.body).toBe(off.body);
    }
  });

  it('one stop: the whole route priced once — maxStops, stopCount, billableKm, routeSource and the legs, byte for byte', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [STOP_1] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ONE_STOP_BODY);
  });

  it('three stops: one trip of 10.88 km / 27 min (4939 → 4900), not four trips (8100)', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [STOP_1, STOP_2, STOP_3] });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.tiers.map((t: { fare: number }) => t.fare)).toEqual([4900, 6600, 12300]);
    expect(data).toMatchObject({ billableKm: 10.88, distanceKm: 10.9, durationMin: 27, routeSource: 'haversine', maxStops: 3, stopCount: 3 });
    expect(data.legs.map((l: { from: string; to: string; meters: number }) => [l.from, l.to, l.meters])).toEqual([
      ['PICKUP', 'STOP_1', 2454], ['STOP_1', 'STOP_2', 1750], ['STOP_2', 'STOP_3', 4074], ['STOP_3', 'DESTINATION', 2600],
    ]);
  });

  it('a round trip is a real itinerary (DS282 F6): out to a stop and back to the pickup, priced as the whole road (4.91 km / 12 min → 2773 → 2800)', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: PICKUP, stops: [STOP_1] });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.tiers.map((t: { fare: number }) => t.fare)).toEqual([2800, 3800, 7000]);
    expect(data).toMatchObject({ billableKm: 4.91, durationMin: 12, stopCount: 1 });
    expect(data.legs.map((l: { from: string; to: string; meters: number }) => [l.from, l.to, l.meters])).toEqual([['PICKUP', 'STOP_1', 2454], ['STOP_1', 'DESTINATION', 2454]]);
    // A stop revisited later in the trip (errands, a drop-and-return) is allowed too.
    const revisit = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [STOP_1, STOP_2, STOP_1] });
    expect(revisit.statusCode).toBe(200);
    expect(revisit.json().data).toMatchObject({ stopCount: 3 });
  });

  it('the configured maximum binds: 400 TOO_MANY_STOPS', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '1');
    const one = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [STOP_1, STOP_2] });
    expect(one.statusCode).toBe(400);
    expect(one.json().error).toMatchObject({ code: 'TOO_MANY_STOPS', details: { maxStops: 1, stopCount: 2 } });
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const four = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [STOP_1, STOP_2, STOP_3, STOP_1] });
    expect(four.json().error).toMatchObject({ code: 'TOO_MANY_STOPS', details: { maxStops: 3, stopCount: 4 } });
  });

  it('a stop under 50 m from the point before it: 400 STOP_TOO_CLOSE', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const nextDoor = { lat: PICKUP.lat + 20 / 111_195, lng: PICKUP.lng, address: 'Next door' };
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [nextDoor] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'STOP_TOO_CLOSE', details: { stopSequence: 1, from: 'PICKUP', to: 'STOP_1', minMeters: 50 } });
  });

  it('a stop that is not a real place, or a stop list that is not a list: 400 VALIDATION_ERROR', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const bad = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [{ ...STOP_1, lat: 91 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(bad.json().error.details)).toEqual(['stops.0.lat']);
    const noAddress = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [{ lat: STOP_1.lat, lng: STOP_1.lng }] });
    expect(Object.keys(noAddress.json().error.details)).toEqual(['stops.0.address']);
    const notAList = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: 'Camp Street' });
    expect([notAList.statusCode, notAList.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });
});

describe('every point of a route with stops lies where Swift works (400 STOP_OUT_OF_MARKET)', () => {
  // A routing engine snaps a point far off its map onto the nearest road it
  // knows and answers Ok, so a stop abroad would be priced as somewhere here.
  const PORT_OF_SPAIN = { lat: 10.6596, lng: -61.5089 };

  it('a stop outside the launch market is refused, named, before anything is priced', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: DESTINATION, stops: [STOP_1, { ...PORT_OF_SPAIN, address: 'Port of Spain' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'STOP_OUT_OF_MARKET', details: { place: 'STOP_2' } });
  });

  it('with stops, the final destination is judged too', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: PORT_OF_SPAIN, stops: [STOP_1] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'STOP_OUT_OF_MARKET', details: { place: 'DESTINATION' } });
  });

  it('without stops the same outside destination is also refused before quoting', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: PICKUP, dropoff: PORT_OF_SPAIN });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'ROUTE_OUT_OF_MARKET', details: { place: 'DESTINATION' } });
  });
});

describe('zone-priced routes are refused with stops (409 MULTI_STOP_ZONE_PRICED)', () => {
  it('a leg the zone table prices: Central → Central → South', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: CENTRAL, dropoff: SOUTH, stops: [{ ...DESTINATION, address: 'Lamaha Street' }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'MULTI_STOP_ZONE_PRICED',
      details: { from: 'STOP_1', to: 'DESTINATION', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' },
    });
  });

  it('the direct pair: South → (a stop outside every zone) → Central — a stop cannot step around the fixed fare', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const res = await estimate(app, token, { pickup: SOUTH, dropoff: CENTRAL, stops: [EAST_OF_ZONES] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'MULTI_STOP_ZONE_PRICED',
      details: { from: 'PICKUP', to: 'DESTINATION', fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central' },
    });
    // Without the stop the same trip is today's zone fare.
    const single = await estimate(app, token, { pickup: SOUTH, dropoff: CENTRAL });
    expect(single.json().data.tiers[0]).toMatchObject({ rideClass: 'ECONOMY', fare: 2000, source: 'zone_table' });
  });

  it('FARE_ZONE_TABLE_KILL=1 bypasses the table, as everywhere: the whole route prices by the formula (17.69 km / 43 min → 7382 → 7400)', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    vi.stubEnv('FARE_ZONE_TABLE_KILL', '1');
    const res = await estimate(app, token, { pickup: SOUTH, dropoff: CENTRAL, stops: [EAST_OF_ZONES] });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.tiers.map((t: { fare: number; source: string }) => [t.fare, t.source])).toEqual([[7400, 'formula'], [10000, 'formula'], [18500, 'formula']]);
    expect(data).toMatchObject({ billableKm: 17.69, durationMin: 43, stopCount: 1 });
    expect(data.legs.map((l: { meters: number }) => l.meters)).toEqual([8683, 9007]);
  });
});

describe('with MAPS_PROVIDER=osrm', () => {
  let osrmApp: FastifyInstance;
  let osrmToken: string;
  beforeAll(async () => {
    process.env['MAPS_PROVIDER'] = 'osrm';
    process.env['OSRM_URL'] = 'http://osrm.test';
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

  it('prices the plan’s worked example from ONE route call through every point', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const f = vi.fn(async (_url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 'Ok', routes: [{ distance: 10_150, duration: 1620, legs: [{ distance: 4000, duration: 600 }, { distance: 6150, duration: 1020 }] }] }),
    }));
    vi.stubGlobal('fetch', f);
    const res = await estimate(osrmApp, osrmToken, { pickup: FAR_PICKUP, dropoff: FAR_DESTINATION, stops: [FAR_STOP] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(WORKED_EXAMPLE_BODY);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe('http://osrm.test/route/v1/driving/-58.1,6.9;-58.08,6.92;-58.05,6.95?overview=false');
  });

  it('OSRM down: a ride with stops fails closed (503 ROUTE_UNAVAILABLE); the same ride without stops keeps today’s fallback', async () => {
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const withStops = await estimate(osrmApp, osrmToken, { pickup: FAR_PICKUP, dropoff: FAR_DESTINATION, stops: [FAR_STOP] });
    expect(withStops.statusCode).toBe(503);
    expect(withStops.json().error).toMatchObject({ code: 'ROUTE_UNAVAILABLE', details: { stopCount: 1 } });
    const single = await estimate(osrmApp, osrmToken, { pickup: FAR_PICKUP, dropoff: FAR_DESTINATION });
    expect(single.statusCode).toBe(200);
    // The fallback is the deterministic estimate: the same bytes the haversine app answers.
    expect(single.body).toBe((await estimate(app, token, { pickup: FAR_PICKUP, dropoff: FAR_DESTINATION })).body);
    expect(single.json().data.routeSource).toBe('haversine');
  });
});
