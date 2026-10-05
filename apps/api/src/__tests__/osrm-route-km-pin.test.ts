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
import { planVendorGroup } from '../modules/order/cart-plans';
import { DEFAULT_DELIVERY_RATES } from '../utils/markup';
import { HaversineMapsProvider, OsrmMapsProvider } from '../providers/maps/maps-provider';
import { osrmOutcomeCounter } from '../plugins/observability';
import { pinLegacyGuyanaTaxiCard } from './helpers/legacy-taxi-card';
import { plantGeorgetownPair } from './helpers/zone-fare-fixture';

// ---------------------------------------------------------------------------
// [money] The single-leg route as it prices TODAY, pinned before a present but
// invalid OSRM number is refused, and never edited after. Every valid OSRM
// answer, and every way OSRM fails to answer (the deterministic fallback),
// must price exactly as it does now, byte for byte, through every caller of
// routeKm: the taxi fare, the courier quote and the delivery planner.
//
// The OSRM body is TEXT read through a real Response, as the provider reads it.
// Every number was derived by hand from the default GY rates (taxi: base 1000,
// perKm 300, perMin 25, minimum 1500; Comfort ×1.35, Group ×2.5. Courier: base
// 1000, perKm 300, MEDIUM +500. Delivery: base 500, 200/km after 2 km) and
// the seeded Central → South zone fare (2000). Phone prefix +5923419 (grepped:
// unused elsewhere).
//
// [PRICING-GY-OCT] The owner's October fares changed those defaults. Taxi: this
// file puts the card its taxi bytes were derived from — which names no
// included kilometres — on the Guyana row and restores the seeded card after,
// so every taxi byte below stands unchanged (the October fare is pinned in
// fares-georgetown-defaults.test.ts). Courier and delivery price from the new
// defaults, re-derived by hand: courier base 800, perKm 120, MEDIUM +500;
// delivery base 500, 100/km after 3 km.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = '+5923419';
const OSRM = 'http://osrm.test';

// Outside every zone: the formula prices it.
const PICKUP = { lat: 6.90, lng: -58.10 };
const DROPOFF = { lat: 6.95, lng: -58.05 };
// The Central → South zone fare (2000): no longer seeded, planted by this suite (helpers/zone-fare-fixture).
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };

/** One OSRM /route body, as text: distance (m) and, when given, duration (s). */
const body = (distance: string, duration?: string) =>
  `{"code":"Ok","routes":[{"distance":${distance}${duration === undefined ? '' : `,"duration":${duration}`}}]}`;
/** A fetch that answers every call with this text, through a real Response. */
const answer = (text: string, status = 200) =>
  vi.fn(async (_url: unknown) => new Response(text, { status, headers: { 'content-type': 'application/json' } }));

async function counted(outcome: string): Promise<number> {
  const metric = await osrmOutcomeCounter.get();
  return metric.values.find((v) => v.labels['op'] === 'route' && v.labels['outcome'] === outcome)?.value ?? 0;
}

const tiers = (source: string, economy: number, comfort: number, group: number) => [
  { rideClass: 'ECONOMY', multiplier: 1, fare: economy, capacity: 4, source },
  { rideClass: 'COMFORT', multiplier: 1.35, fare: comfort, capacity: 4, source },
  { rideClass: 'GROUP', multiplier: 2.5, fare: group, capacity: 14, source },
];

/** The exact bytes each route answers today. */
const TAXI_OSRM_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":4700,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":6300,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":11800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":10.2,"durationMin":27,"billableKm":10.15,"routeSource":"osrm"}}';
const TAXI_FALLBACK_BODY = '{"success":true,"data":{"tiers":[{"rideClass":"ECONOMY","multiplier":1,"fare":4700,"capacity":4,"source":"formula"},{"rideClass":"COMFORT","multiplier":1.35,"fare":6300,"capacity":4,"source":"formula"},{"rideClass":"GROUP","multiplier":2.5,"fare":11800,"capacity":14,"source":"formula"}],"currencyCode":"GYD","distanceKm":10.2,"durationMin":25,"billableKm":10.18,"routeSource":"haversine"}}';
// 10.15 km: 800 + 1218 + 500 = 2518. The fallback's 10.18 km: 800 + 1221.6 + 500 = 2521.6 → 2522.
const COURIER_OSRM_BODY = '{"success":true,"data":{"baseFee":800,"distanceFee":1218,"sizeSurcharge":500,"speedMultiplier":1,"totalFee":2518,"estimatedMinutes":51,"currency":"GYD","distanceKm":10.2}}';
const COURIER_FALLBACK_BODY = '{"success":true,"data":{"baseFee":800,"distanceFee":1222,"sizeSurcharge":500,"speedMultiplier":1,"totalFee":2522,"estimatedMinutes":51,"currency":"GYD","distanceKm":10.2}}';

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
      firstName: 'Route',
      lastName: `Pin${seq}`,
      roles: ['CUSTOMER'] as UserRole[],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  const jwt = on.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await on.prisma.session.create({
    data: { userId: user.id, token: jwt, refreshToken: nanoid(48), deviceId: 'route-pin', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return jwt;
}

function post(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  // The routes build their maps provider when they are registered (rides) or
  // imported (courier): point both at an OSRM the tests answer, for this app.
  process.env['MAPS_PROVIDER'] = 'osrm';
  process.env['OSRM_URL'] = OSRM;
  try {
    const { default: courierRoutes } = await import('../modules/courier/courier.routes');
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerEmptyJsonBodyParser(app);
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
    await app.register(courierRoutes, { prefix: '/api/v1/courier' });
    await app.ready();
  } finally {
    delete process.env['MAPS_PROVIDER'];
    delete process.env['OSRM_URL'];
  }
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
});

describe('routeKm: a valid OSRM answer, as today', () => {
  it.each([
    ['metres and seconds', body('10150', '1620'), { km: 10.15, minutes: 27, source: 'osrm' }],
    ['no duration key: minutes are null (the caller applies its speed model)', body('10150'), { km: 10.15, minutes: null, source: 'osrm' }],
    ['a null duration: the same', body('10150', 'null'), { km: 10.15, minutes: null, source: 'osrm' }],
    ['a route of 0 m and 0 s', body('0', '0'), { km: 0, minutes: 0, source: 'osrm' }],
    ['a duration that is not whole minutes', body('5200', '781'), { km: 5.2, minutes: 13.016666666666667, source: 'osrm' }],
    ['fields it does not read are ignored',
      '{"code":"Ok","waypoints":[{"name":"a"},{"name":"b"}],"routes":[{"distance":10150,"duration":1620,"weight":1700,"weight_name":"routability","legs":[{"distance":10150,"duration":1620,"steps":[],"summary":""}]}]}',
      { km: 10.15, minutes: 27, source: 'osrm' }],
  ])('%s', async (_label, text, expected) => {
    const f = answer(text);
    vi.stubGlobal('fetch', f);
    const okBefore = await counted('ok');
    expect(await new OsrmMapsProvider(OSRM).routeKm(PICKUP, DROPOFF)).toStrictEqual(expected);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe('http://osrm.test/route/v1/driving/-58.1,6.9;-58.05,6.95?overview=false');
    expect(await counted('ok')).toBe(okBefore + 1);
  });
});

describe('routeKm: OSRM fails to answer, so today the deterministic estimate prices it', () => {
  it.each([
    ['the request throws', () => vi.fn(async () => { throw new Error('ECONNREFUSED'); })],
    ['HTTP 500', () => answer('{}', 500)],
    ['a code that is not Ok', () => answer('{"code":"NoRoute","routes":[]}')],
    ['no route', () => answer('{"code":"Ok","routes":[]}')],
    ['no distance key', () => answer('{"code":"Ok","routes":[{"duration":1620}]}')],
    ['a null distance', () => answer('{"code":"Ok","routes":[{"distance":null,"duration":1620}]}')],
    ['a body that is not JSON', () => answer('not json')],
  ])('%s', async (_label, stub) => {
    vi.stubGlobal('fetch', stub());
    const fallbackBefore = await counted('fallback');
    expect(await new OsrmMapsProvider(OSRM).routeKm(PICKUP, DROPOFF)).toStrictEqual(await new HaversineMapsProvider().routeKm(PICKUP, DROPOFF));
    expect(await counted('fallback')).toBe(fallbackBefore + 1);
  });
});

describe('the taxi fare service over OSRM, as today', () => {
  const svc = () => new FareService(app.prisma, new OsrmMapsProvider(OSRM));

  it('10.15 km / 27 min → 4720 → Economy 4700', async () => {
    vi.stubGlobal('fetch', answer(body('10150', '1620')));
    expect(await svc().estimate(PICKUP, DROPOFF, 'GY')).toStrictEqual({
      fare: 4700, currencyCode: 'GYD', distanceKm: 10.2, billableKm: 10.15, routeSource: 'osrm',
      durationMin: 27, source: 'formula', fromZoneId: undefined, toZoneId: undefined,
    });
    expect(await svc().estimateTiers(PICKUP, DROPOFF, 'GY')).toStrictEqual({
      tiers: tiers('formula', 4700, 6300, 11800), currencyCode: 'GYD', distanceKm: 10.2, durationMin: 27, billableKm: 10.15, routeSource: 'osrm',
    });
  });

  it('no duration: the speed model, 10.15 km → 25 min → 4670 → 4700', async () => {
    vi.stubGlobal('fetch', answer(body('10150')));
    expect(await svc().estimate(PICKUP, DROPOFF, 'GY')).toMatchObject({ fare: 4700, durationMin: 25, billableKm: 10.15, routeSource: 'osrm' });
  });

  it('a route of 0 m and 0 s: the minimum, 1500', async () => {
    vi.stubGlobal('fetch', answer(body('0', '0')));
    expect(await svc().estimate(PICKUP, DROPOFF, 'GY')).toStrictEqual({
      fare: 1500, currencyCode: 'GYD', distanceKm: 0, billableKm: 0, routeSource: 'osrm',
      durationMin: 0, source: 'formula', fromZoneId: undefined, toZoneId: undefined,
    });
  });

  it('the zone table: Central → South is 2000, with the OSRM distance beside it', async () => {
    vi.stubGlobal('fetch', answer(body('7950', '1200')));
    expect(await svc().estimate(CENTRAL, SOUTH, 'GY')).toStrictEqual({
      fare: 2000, currencyCode: 'GYD', distanceKm: 8, billableKm: 7.95, routeSource: 'osrm',
      durationMin: 20, source: 'zone_table', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south',
      fromZoneVersion: 1, toZoneVersion: 1,
    });
  });

  it('OSRM down: the deterministic estimate, 10.18 km / 25 min → Economy 4700', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await svc().estimate(PICKUP, DROPOFF, 'GY')).toStrictEqual({
      fare: 4700, currencyCode: 'GYD', distanceKm: 10.2, billableKm: 10.18, routeSource: 'haversine',
      durationMin: 25, source: 'formula', fromZoneId: undefined, toZoneId: undefined,
    });
  });
});

describe('every caller of routeKm answers the same bytes, as today', () => {
  it('POST /rides/estimate', async () => {
    vi.stubGlobal('fetch', answer(body('10150', '1620')));
    const res = await post('/api/v1/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(TAXI_OSRM_BODY);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect((await post('/api/v1/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF })).body).toBe(TAXI_FALLBACK_BODY);
  });

  it('POST /courier/estimate (MEDIUM, STANDARD)', async () => {
    const parcel = { pickup: PICKUP, dropoff: DROPOFF, packageSize: 'MEDIUM', speed: 'STANDARD' };
    vi.stubGlobal('fetch', answer(body('10150', '1620')));
    const res = await post('/api/v1/courier/estimate', parcel);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(COURIER_OSRM_BODY);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect((await post('/api/v1/courier/estimate', parcel)).body).toBe(COURIER_FALLBACK_BODY);
  });

  it('the delivery planner (the cart quote and checkout): 10.15 km → 1215, express 1823', async () => {
    vi.stubGlobal('fetch', answer(body('10150', '1620')));
    const osrm = new OsrmMapsProvider(OSRM);
    const plan = await planVendorGroup({
      vendor: { id: 'v-pin', name: 'Pin Kitchen', latitude: PICKUP.lat, longitude: PICKUP.lng, minOrderAmount: 0 },
      lines: [],
      fulfillment: 'DELIVERY',
      destination: DROPOFF,
      deliveryRates: DEFAULT_DELIVERY_RATES,
      express: false,
      routeKm: (from, to) => osrm.routeKm(from, to),
    });
    expect(plan).toMatchObject({ distanceKm: 10.15, distanceSource: 'osrm', standardDeliveryFee: 1215, deliveryFee: 1215, expressSurcharge: 608 });
  });
});
