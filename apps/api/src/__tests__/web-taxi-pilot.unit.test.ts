import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authPlugin } from '../plugins/auth';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { ACCESS_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';

const fakes = vi.hoisted(() => ({
  session: vi.fn(), createRide: vi.fn(), gates: vi.fn(), queueCreate: vi.fn(), queueUpdate: vi.fn(),
}));
vi.mock('../plugins/prisma', () => ({ enterTenant: vi.fn(), getTenantId: () => 'tenant-test' }));
vi.mock('../modules/auth/auth.service', () => ({ AuthService: class {} }));
vi.mock('../modules/review/gate', () => ({ reviewGate: vi.fn() }));
vi.mock('../modules/rides/fare.service', () => ({ FareService: class {} }));
vi.mock('../modules/order/order.service', () => ({ OrderService: class {} }));
vi.mock('../modules/safety/sos.service', () => ({ SosService: class {} }));
vi.mock('../modules/dispatch/dispatch.service', () => ({ makeDispatchService: () => ({}) }));
vi.mock('../modules/rides/rides.service', () => ({
  createRideRequest: fakes.createRide, assertRideGates: fakes.gates, assertL2: vi.fn(),
}));
vi.mock('../modules/rides/queue.service', () => ({
  getSupplySnapshot: vi.fn(), queueStatusFor: vi.fn().mockResolvedValue({ id: 'queue-test' }),
  presenceNear: vi.fn(), RIDE_QUEUE_TTL_MIN: () => 20,
}));
vi.mock('../modules/user/home-cache', () => ({ invalidateHomeCache: vi.fn() }));

let app: FastifyInstance;
let token: string;
const trip = {
  pickup: { lat: 6.8, lng: -58.1 }, dropoff: { lat: 6.9, lng: -58.2 },
  pickupAddress: 'Test pickup', dropoffAddress: 'Test dropoff',
};

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', 'synthetic-web-taxi-unit-test-key');
  vi.stubEnv('CORS_ORIGIN', 'https://swift.example');
  resetBrowserOriginsForTests();
  vi.clearAllMocks();
  fakes.session.mockResolvedValue({
    id: 'session-test', expiresAt: new Date(Date.now() + 60_000), authMethod: 'OTP',
    user: { id: 'customer-test', tenantId: 'tenant-test', tenant: { kind: 'STANDARD' },
      status: 'ACTIVE', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
  });
  fakes.createRide.mockResolvedValue({
    order: { id: 'ride-test', orderNumber: 'TEST', status: 'REQUESTED' },
    estimate: { fare: 1000, currencyCode: 'GYD' },
  });
  fakes.gates.mockResolvedValue({ id: 'customer-test', tenantId: 'tenant-test' });
  fakes.queueCreate.mockResolvedValue({ id: 'queue-test' });
  fakes.queueUpdate.mockResolvedValue({ count: 0 });
  app = Fastify();
  app.decorate('prisma', {
    session: { findUnique: fakes.session },
    rideQueueEntry: { updateMany: fakes.queueUpdate, create: fakes.queueCreate },
    supplyWatch: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
  } as never);
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; code?: string; message: string };
    reply.code(err.statusCode ?? 500).send({ success: false, error: { code: err.code, message: err.message } });
  });
  await app.register(authPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  app.get('/optional-source', { preHandler: [app.authenticateOptional] }, async (request) => ({
    source: request.authCredentialSource, session: request.authSessionId,
  }));
  await app.ready();
  token = app.jwt.sign({ userId: 'customer-test', role: 'CUSTOMER' });
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  resetBrowserOriginsForTests();
});

function cookieHeaders(client = 'web') {
  return { cookie: `${ACCESS_COOKIE}=${token}`, origin: 'https://swift.example', 'x-swift-client': client };
}
function post(path: string, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url: `/api/v1/rides${path}`, headers, payload: trip });
}

describe('web taxi pilot: verified credential transport, never the client label', () => {
  it.each(['/request', '/queue/join'])('refuses cookie-authenticated creation at %s before side effects', async (path) => {
    const res = await post(path, cookieHeaders());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TAXI_MOBILE_APP_REQUIRED');
    expect(fakes.session).toHaveBeenCalledWith(expect.objectContaining({ where: { token } }));
    expect(fakes.createRide).not.toHaveBeenCalled();
    expect(fakes.gates).not.toHaveBeenCalled();
    expect(fakes.queueCreate).not.toHaveBeenCalled();
    expect(fakes.queueUpdate).not.toHaveBeenCalled();
  });

  it.each(['/request', '/queue/join'])('preserves mobile bearer creation at %s', async (path) => {
    const res = await post(path, { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(201);
    expect(path === '/request' ? fakes.createRide : fakes.queueCreate).toHaveBeenCalledTimes(1);
  });

  it('changing the cookie client label cannot reopen booking', async () => {
    expect((await post('/request', cookieHeaders('admin-web'))).statusCode).toBe(403);
    expect((await post('/request', cookieHeaders('mobile'))).statusCode).toBe(401);
    expect(fakes.createRide).not.toHaveBeenCalled();
  });

  it('a browser label alone never blocks a verified bearer request', async () => {
    expect((await post('/request', { authorization: `Bearer ${token}`, 'x-swift-client': 'web' })).statusCode).toBe(201);
  });

  it('keeps bearer precedence when a cookie is also present', async () => {
    expect((await post('/request', { ...cookieHeaders(), authorization: `Bearer ${token}` })).statusCode).toBe(201);
  });

  it('does not let an invalid bearer fall back to a valid cookie', async () => {
    expect((await post('/request', { ...cookieHeaders(), authorization: 'Bearer invalid' })).statusCode).toBe(401);
    expect(fakes.createRide).not.toHaveBeenCalled();
  });

  it('does not mistake a forged cookie for authenticated browser provenance', async () => {
    expect((await post('/request', { ...cookieHeaders(), cookie: `${ACCESS_COOKIE}=invalid` })).statusCode).toBe(401);
    expect(fakes.session).not.toHaveBeenCalled();
  });

  it('keeps revoked sessions and disallowed origins unauthorized', async () => {
    expect((await post('/request', { ...cookieHeaders(), origin: 'https://untrusted.example' })).statusCode).toBe(401);
    fakes.session.mockResolvedValue(null);
    expect((await post('/request', cookieHeaders())).statusCode).toBe(401);
    expect(fakes.createRide).not.toHaveBeenCalled();
  });

  it('does not relabel a session-store outage as a channel refusal', async () => {
    fakes.session.mockRejectedValue(new Error('synthetic session-store outage'));
    const res = await post('/request', cookieHeaders());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AUTH_UNAVAILABLE');
  });


  it('optional authentication records verified transport and never leaks it to the next request', async () => {
    const cookie = await app.inject({ url: '/optional-source', headers: cookieHeaders() });
    expect(cookie.json()).toEqual({ source: 'cookie', session: 'session-test' });
    const bearer = await app.inject({ url: '/optional-source', headers: { authorization: `Bearer ${token}` } });
    expect(bearer.json()).toEqual({ source: 'bearer', session: 'session-test' });
    const guest = await app.inject({ url: '/optional-source' });
    expect(guest.json()).toEqual({ source: null, session: null });
  });

  it('optional authentication publishes no source for revoked or unavailable sessions', async () => {
    fakes.session.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('synthetic outage'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await app.inject({ url: '/optional-source', headers: cookieHeaders() });
      expect(res.json()).toEqual({ source: null, session: null });
    }
  });

  it('keeps existing ride reads accessible through the cookie session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/rides/active', headers: cookieHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });
});
