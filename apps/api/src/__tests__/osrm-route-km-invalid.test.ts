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
import { AppError } from '../utils/errors';
import { plantGeorgetownPair } from './helpers/zone-fare-fixture';

// ---------------------------------------------------------------------------
// [money] A single-leg route that OSRM answers with a PRESENT but invalid
// number is refused: 503 ROUTE_UNAVAILABLE, never priced, and never swapped
// for the deterministic estimate. On main it was priced. A negative duration
// LOWERED the taxi fare (4700 → 3400); a negative distance priced the taxi at
// the minimum, quoted a NEGATIVE courier fee (−1545) and charged delivery its
// base fee only; Infinity or NaN surfaced as a different error; a string was
// coerced into a number. An ABSENT duration still falls back to the speed
// model, and OSRM failing to answer still falls back to the deterministic
// estimate (both pinned in osrm-route-km-pin.test.ts). A missing distance
// falls back only beside a valid or absent duration: beside a present invalid
// one it is refused too, so the fallback never launders it [AX336 R1].
//
// Every OSRM body is TEXT read through a real Response, as the provider reads
// it, so JSON itself makes 1e309 Infinity. JSON has no NaN, so NaN comes from
// a parsed-object stub. Phone prefix +5923421 (grepped: unused elsewhere).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = '+5923421';
const OSRM = 'http://osrm.test';
const PICKUP = { lat: 6.90, lng: -58.10 };
const DROPOFF = { lat: 6.95, lng: -58.05 };
// [ZONE-FARES] Central → South carries a 2000 zone fare this suite plants for
// itself (helpers/zone-fare-fixture); the seed no longer does.
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };

const body = (distance: string, duration: string) => `{"code":"Ok","routes":[{"distance":${distance},"duration":${duration}}]}`;
const answer = (text: string) =>
  vi.fn(async (_url: unknown) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }));
/** A parsed body the provider reads as-is: the only way to hand it a NaN. */
const parsed = (route: Record<string, unknown>) => vi.fn(async (_url: unknown) => ({ ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [route] }) }));

/** Every present but invalid number: on the distance, then on the duration. */
const INVALID_TEXT: Array<[string, string]> = [
  ['a negative distance', body('-10150', '1620')],
  ['a distance of 1e309 (JSON makes it Infinity)', body('1e309', '1620')],
  ['a distance of -1e309 (-Infinity)', body('-1e309', '1620')],
  ['a distance that is a string', body('"10150"', '1620')],
  ['a distance that is a boolean', body('true', '1620')],
  ['a negative duration (it lowered the fare)', body('10150', '-1620')],
  ['a duration of 1e309 (Infinity)', body('10150', '1e309')],
  ['a duration of -1e309 (-Infinity)', body('10150', '-1e309')],
  ['a duration that is a string', body('10150', '"1620"')],
];

/** [AX336 R1] No distance (the key omitted, or null) beside a PRESENT invalid
 *  duration. On the first cut of this fix it took the missing-distance
 *  fallback before the duration was judged, and was priced. */
const NO_DISTANCE_INVALID_DURATION: Array<[string, string]> = [
  ['no distance key, a negative duration', '{"code":"Ok","routes":[{"duration":-1620}]}'],
  ['no distance key, a duration of 1e309 (Infinity)', '{"code":"Ok","routes":[{"duration":1e309}]}'],
  ['no distance key, a duration of -1e309 (-Infinity)', '{"code":"Ok","routes":[{"duration":-1e309}]}'],
  ['no distance key, a duration that is a string', '{"code":"Ok","routes":[{"duration":"1620"}]}'],
  ['no distance key, a duration that is a boolean', '{"code":"Ok","routes":[{"duration":true}]}'],
  ['a null distance, a negative duration', body('null', '-1620')],
  ['a null distance, a duration of 1e309 (Infinity)', body('null', '1e309')],
  ['a null distance, a duration of -1e309 (-Infinity)', body('null', '-1e309')],
  ['a null distance, a duration that is a string', body('null', '"1620"')],
  ['a null distance, a duration that is a boolean', body('null', 'true')],
];

async function counted(outcome: string): Promise<number> {
  const metric = await osrmOutcomeCounter.get();
  return metric.values.find((v) => v.labels['op'] === 'route' && v.labels['outcome'] === outcome)?.value ?? 0;
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

let app: FastifyInstance;
let token: string;
let seq = 0;
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
      lastName: `Refused${seq}`,
      roles: ['CUSTOMER'] as UserRole[],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  const jwt = on.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await on.prisma.session.create({
    data: { userId: user.id, token: jwt, refreshToken: nanoid(48), deviceId: 'route-refused', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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
  await purgeFixtures(app);
  token = await makeCustomer(app);
  removeGeorgetownPair = await plantGeorgetownPair(app.prisma);
});

afterAll(async () => {
  await removeGeorgetownPair();
  await purgeFixtures(app);
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routeKm refuses a present but invalid number: 503 ROUTE_UNAVAILABLE, never the fallback', () => {
  it.each([...INVALID_TEXT, ...NO_DISTANCE_INVALID_DURATION])('%s', async (_label, text) => {
    vi.stubGlobal('fetch', answer(text));
    const [fallbackBefore, refusedBefore] = [await counted('fallback'), await counted('refused')];
    const err = await refusal(new OsrmMapsProvider(OSRM).routeKm(PICKUP, DROPOFF));
    expect([err.statusCode, err.code]).toEqual([503, 'ROUTE_UNAVAILABLE']);
    // Not an outage: the estimate is not quietly priced instead, and the refusal is counted as such.
    expect(await counted('fallback')).toBe(fallbackBefore);
    expect(await counted('refused')).toBe(refusedBefore + 1);
  });

  it.each([
    ['a distance that is NaN', { distance: Number.NaN, duration: 1620 }],
    ['a duration that is NaN', { distance: 10150, duration: Number.NaN }],
    ['no distance key, a duration that is NaN', { duration: Number.NaN }],
    ['a null distance, a duration that is NaN', { distance: null, duration: Number.NaN }],
  ])('%s', async (_label, route) => {
    vi.stubGlobal('fetch', parsed(route));
    const err = await refusal(new OsrmMapsProvider(OSRM).routeKm(PICKUP, DROPOFF));
    expect([err.statusCode, err.code]).toEqual([503, 'ROUTE_UNAVAILABLE']);
  });
});

describe('[AX336 R1] a missing distance still falls back beside a valid or absent duration', () => {
  // A valid duration beside no distance is pinned in osrm-route-km-pin.test.ts;
  // these are the absent-duration side, which must stay an outage, not a refusal.
  it.each([
    ['no distance key and no duration key', '{"code":"Ok","routes":[{}]}'],
    ['a null distance and a null duration', body('null', 'null')],
  ])('%s → the deterministic estimate, counted as a fallback', async (_label, text) => {
    vi.stubGlobal('fetch', answer(text));
    const [fallbackBefore, refusedBefore] = [await counted('fallback'), await counted('refused')];
    expect(await new OsrmMapsProvider(OSRM).routeKm(PICKUP, DROPOFF)).toStrictEqual(await new HaversineMapsProvider().routeKm(PICKUP, DROPOFF));
    expect(await counted('fallback')).toBe(fallbackBefore + 1);
    expect(await counted('refused')).toBe(refusedBefore);
  });
});

describe('the taxi fare service: never a price from an invalid OSRM number', () => {
  const svc = () => new FareService(app.prisma, new OsrmMapsProvider(OSRM));

  it.each([...INVALID_TEXT, ...NO_DISTANCE_INVALID_DURATION])('%s → estimate and estimateTiers refuse', async (_label, text) => {
    vi.stubGlobal('fetch', answer(text));
    const one = await refusal(svc().estimate(PICKUP, DROPOFF, 'GY'));
    const tiered = await refusal(svc().estimateTiers(PICKUP, DROPOFF, 'GY'));
    expect([one.statusCode, one.code, tiered.statusCode, tiered.code]).toEqual([503, 'ROUTE_UNAVAILABLE', 503, 'ROUTE_UNAVAILABLE']);
  });

  it('the zone table does not launder it: Central → South with a negative distance is refused, not 2000 beside -7.9 km', async () => {
    vi.stubGlobal('fetch', answer(body('-7950', '1200')));
    const err = await refusal(svc().estimate(CENTRAL, SOUTH, 'GY'));
    expect([err.statusCode, err.code]).toEqual([503, 'ROUTE_UNAVAILABLE']);
  });
});

describe('every caller of routeKm refuses it, end to end', () => {
  it('POST /rides/estimate: a negative duration is 503, not a lowered 3400; a negative distance is 503, not the 1500 minimum', async () => {
    for (const text of [body('10150', '-1620'), body('-10150', '1620')]) {
      vi.stubGlobal('fetch', answer(text));
      const res = await post('/api/v1/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('ROUTE_UNAVAILABLE');
    }
  });

  it('POST /rides/estimate: no distance (null, or the key omitted) beside a negative duration is 503, not the estimate priced [AX336 R1]', async () => {
    for (const text of [body('null', '-1620'), '{"code":"Ok","routes":[{"duration":-1620}]}']) {
      vi.stubGlobal('fetch', answer(text));
      const res = await post('/api/v1/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('ROUTE_UNAVAILABLE');
    }
  });

  it('POST /courier/estimate: a negative distance is 503, not a negative fee (−1545)', async () => {
    vi.stubGlobal('fetch', answer(body('-10150', '1620')));
    const res = await post('/api/v1/courier/estimate', { pickup: PICKUP, dropoff: DROPOFF, packageSize: 'MEDIUM', speed: 'STANDARD' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ROUTE_UNAVAILABLE');
  });

  it('the delivery planner (the cart quote and checkout): a negative distance is refused, not the 500 base fee', async () => {
    vi.stubGlobal('fetch', answer(body('-10150', '1620')));
    const osrm = new OsrmMapsProvider(OSRM);
    const err = await refusal(planVendorGroup({
      vendor: { id: 'v-refused', name: 'Refused Kitchen', latitude: PICKUP.lat, longitude: PICKUP.lng, minOrderAmount: 0 },
      lines: [],
      fulfillment: 'DELIVERY',
      destination: DROPOFF,
      deliveryRates: DEFAULT_DELIVERY_RATES,
      express: false,
      routeKm: (from, to) => osrm.routeKm(from, to),
    }));
    expect([err.statusCode, err.code]).toEqual([503, 'ROUTE_UNAVAILABLE']);
  });
});
