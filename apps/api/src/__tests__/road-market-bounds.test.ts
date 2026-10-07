import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { ridesRoutes } from '../modules/rides/rides.routes';

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
  // Retain this suite's synthetic history, but never leave its successful
  // requests competing on another suite's 20-item live driver board.
  await app.prisma.order.updateMany({ where: { customer: { syntheticRunId: 'l08-market-test' }, status: { in: ['PENDING', 'READY_FOR_PICKUP'] } }, data: { status: 'CANCELLED' } });
});
beforeEach(async () => {
  road();
  const user = await app.prisma.user.create({ data: {
    phone: `+592${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
    firstName: 'Market', lastName: 'Fixture', syntheticRunId: 'l08-market-test',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    trustLevel: 'L2', selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userId = user.id;
  token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), deviceId: 'market-fixture', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (userId) await app.prisma.order.updateMany({ where: { customerId: userId, status: { in: ['PENDING', 'READY_FOR_PICKUP'] } }, data: { status: 'CANCELLED' } });
  await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: userId } });
  // A red run may have written the very job this test forbids. Keep its
  // synthetic history intact; a passing run has nothing to retain.
  if (userId && await app.prisma.order.count({ where: { customerId: userId } }) === 0) {
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.delete({ where: { id: userId } });
  }
});
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });
const post = (url: string, body: unknown = payload) => app.inject({ method: 'POST', url,
  headers: { authorization: `Bearer ${token}` }, payload: body as Record<string, unknown> });
const road = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 8100, duration: 900 }] }))));


const boundaryPairs = [
  { name: 'north', inside: { lat: 8.9999, lng: -58.15 }, outside: { lat: 9.0001, lng: -58.15 } },
  { name: 'south', inside: { lat: 1.0001, lng: -58.15 }, outside: { lat: 0.9999, lng: -58.15 } },
  { name: 'west', inside: { lat: 6.8, lng: -61.9999 }, outside: { lat: 6.8, lng: -62.0001 } },
  { name: 'east', inside: { lat: 6.8, lng: -56.0001 }, outside: { lat: 6.8, lng: -55.9999 } },
];
const paths = ['/api/v1/rides/estimate', '/api/v1/courier/estimate', '/api/v1/rides/request', '/api/v1/courier/order'];
const bodyFor = (point: { lat: number; lng: number }, end: 'pickup' | 'dropoff') => ({
  ...payload, [end]: point, pickupAddress: 'Test pickup', dropoffAddress: 'Test destination', recipientName: 'Test recipient', recipientPhone: '0000000',
});
for (const url of paths) describe(url, () => {
  it.each(boundaryPairs.flatMap((boundary) => (['pickup', 'dropoff'] as const).map((end) => ({ ...boundary, end }))))('refuses $end just outside $name before routing or writing', async ({ outside, end }) => {
    vi.mocked(app.dispatchQueue!.add).mockClear();
    const res = await post(url, bodyFor(outside, end));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'ROUTE_OUT_OF_MARKET', message: expect.stringMatching(/outside Guyana/) });
    expect(fetch).not.toHaveBeenCalled();
    expect(app.dispatchQueue!.add).not.toHaveBeenCalled();
    expect(await app.prisma.order.count({ where: { customerId: userId } })).toBe(0);
  });
  it.each(boundaryPairs)('still accepts just inside $name', async ({ inside }) => {
    const res = await post(url, bodyFor(inside, 'pickup'));
    expect(res.statusCode, res.body).toBe(url.endsWith('/estimate') ? 200 : 201);
  });
});
it.each(['pickup', 'dropoff'] as const)('the taxi waitlist cannot defer an out-of-market %s into a later booking', async (end) => {
  const res = await post('/api/v1/rides/queue/join', bodyFor(boundaryPairs[0]!.outside, end));
  expect(res.statusCode, res.body).toBe(400);
  expect(res.json().error.code).toBe('ROUTE_OUT_OF_MARKET');
  expect(await app.prisma.rideQueueEntry.count({ where: { customerId: userId } })).toBe(0);
});
