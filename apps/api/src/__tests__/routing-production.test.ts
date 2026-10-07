import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { FareService } from '../modules/rides/fare.service';
import { HaversineMapsProvider, OsrmMapsProvider } from '../providers/maps/maps-provider';

const PICKUP = { lat: 6.8013, lng: -58.1551 };
const DROPOFF = { lat: 6.8149, lng: -58.1631 };
const payload = { pickup: PICKUP, dropoff: DROPOFF, packageSize: 'MEDIUM', speed: 'STANDARD' };
let app: FastifyInstance;
let token: string;
let userId: string;

beforeAll(async () => {
  vi.stubEnv('MAPS_PROVIDER', 'osrm');
  vi.stubEnv('OSRM_URL', 'http://osrm.test');
  const { default: courierRoutes } = await import('../modules/courier/courier.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('dispatchQueue', { add: vi.fn(async () => ({})) } as never);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  const user = await app.prisma.user.create({ data: {
    phone: `+592${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
    firstName: 'Routing', lastName: 'Fixture', syntheticRunId: 'l08-routing-test',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    trustLevel: 'L2', selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userId = user.id;
  token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), deviceId: 'routing-fixture', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  vi.unstubAllEnvs();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  // A red run may have written the very job this test forbids. Keep its
  // synthetic history intact; a passing run has nothing to retain.
  if (userId && await app.prisma.order.count({ where: { customerId: userId } }) === 0) {
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.delete({ where: { id: userId } });
  }
  await app?.close();
});
const post = (url: string, body: unknown = payload) => app.inject({ method: 'POST', url,
  headers: { authorization: `Bearer ${token}` }, payload: body as Record<string, unknown> });
const outage = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
const road = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 8100, duration: 900 }] }))));

describe('production taxi and courier need a road route', () => {
  it.each(['/api/v1/rides/estimate', '/api/v1/courier/estimate'])('%s refuses unreachable OSRM without persisting a fare', async (url) => {
    vi.stubEnv('NODE_ENV', 'production'); outage();
    const before = await app.prisma.order.count({ where: { customerId: userId } });
    const res = await post(url);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'ROUTE_UNAVAILABLE', message: expect.stringMatching(/rout.*try again/i) } });
    expect(await app.prisma.order.count({ where: { customerId: userId } })).toBe(before);
  });
  it.each(['development', 'test'])('%s keeps the deterministic fallback for both quotes', async (mode) => {
    vi.stubEnv('NODE_ENV', mode); outage();
    for (const url of ['/api/v1/rides/estimate', '/api/v1/courier/estimate']) {
      const res = await post(url);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.distanceKm).toBeGreaterThan(0);
    }
  });
  it('production keeps successful road quote shapes', async () => {
    vi.stubEnv('NODE_ENV', 'production'); road();
    const taxi = await post('/api/v1/rides/estimate');
    const courier = await post('/api/v1/courier/estimate');
    expect(taxi.statusCode).toBe(200);
    expect(taxi.json().data).toMatchObject({ distanceKm: 8.1, tiers: expect.any(Array), currencyCode: 'GYD' });
    expect(courier.statusCode).toBe(200);
    expect(courier.json().data).toMatchObject({ distanceKm: 8.1, totalFee: expect.any(Number) });
  });
  it('a configured straight-line provider cannot price production taxi fares either', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(new FareService(app.prisma, new HaversineMapsProvider()).estimate(PICKUP, DROPOFF, 'GY'))
      .rejects.toMatchObject({ statusCode: 503, code: 'ROUTE_UNAVAILABLE' });
  });
  it.each([
    ['HTTP failure', () => new Response('{}', { status: 500 })],
    ['no route', () => new Response('{"code":"NoRoute","routes":[]}')],
    ['missing distance', () => new Response('{"code":"Ok","routes":[{}]}')],
    ['malformed body', () => new Response('{')],
  ])('%s cannot reach taxi pricing in production', async (_label, response) => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubGlobal('fetch', vi.fn(async () => response()));
    await expect(new FareService(app.prisma, new OsrmMapsProvider('http://osrm.test')).estimate(PICKUP, DROPOFF, 'GY'))
      .rejects.toMatchObject({ statusCode: 503, code: 'ROUTE_UNAVAILABLE' });
  });
  it.each(['/api/v1/courier/order', '/api/v1/rides/request'])('production %s refuses before it can write or dispatch', async (url) => {
    vi.stubEnv('NODE_ENV', 'production'); outage();
    vi.mocked(app.dispatchQueue!.add).mockClear();
    const before = await app.prisma.order.count({ where: { customerId: userId } });
    const res = await post(url, { ...payload, pickupAddress: 'Test pickup', dropoffAddress: 'Test destination', recipientName: 'Test recipient', recipientPhone: '0000000' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ROUTE_UNAVAILABLE');
    expect(app.dispatchQueue!.add).not.toHaveBeenCalled();
    expect(await app.prisma.order.count({ where: { customerId: userId } })).toBe(before);
  });
});
