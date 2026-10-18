import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authPlugin } from '../plugins/auth';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { ACCESS_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { webTaxiBookingEnabled } from '../modules/rides/web-taxi-booking';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026 20:40Z] Web taxi booking is built behind
// WEB_TAXI_BOOKING, which stays OFF until the owner switches it on.
//
//   OFF (unset, or anything but "1"): a browser session is refused at the
//       booking door exactly as before; the phone is untouched.
//   ON ("1"): a browser session may book at POST /rides/request — through the
//       same core, gates and fare as the phone — only with the fare it showed
//       and an Idempotency-Key. The ride queue stays phone-only, and the
//       capabilities answer tells a browser (and only a browser) it may book.
//
// The pilot's own regressions (web-taxi-pilot.unit.test.ts) keep running with
// the switch unset.
// ---------------------------------------------------------------------------

const fakes = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), createRide: vi.fn(), gates: vi.fn(), queueCreate: vi.fn(), queueUpdate: vi.fn(),
  receipt: vi.fn(), redisSet: vi.fn(), redisGet: vi.fn(), redisEval: vi.fn(),
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
  rideRequestReceiptKey: (key: string) => `taxi-request:${key}`,
  rideRequestClaimKey: (userId: string, key: string) => `ride-request:idem:${userId}:${key}`,
  replayRideRequestAnswer: (result: unknown) => result,
  RideRequestOutcomeUnknownError: class extends Error {},
}));
vi.mock('../modules/rides/queue.service', () => ({
  getSupplySnapshot: vi.fn(), queueStatusFor: vi.fn().mockResolvedValue({ id: 'queue-test' }),
  presenceNear: vi.fn(), RIDE_QUEUE_TTL_MIN: () => 20,
}));
vi.mock('../modules/user/home-cache', () => ({ invalidateHomeCache: vi.fn() }));

let app: FastifyInstance;
let token: string;
const trip = {
  pickup: { lat: 6.8065, lng: -58.1626 }, dropoff: { lat: 6.8164, lng: -58.1416 },
  pickupAddress: 'Test pickup', dropoffAddress: 'Test dropoff',
};
const quoted = { ...trip, rideClass: 'ECONOMY', passengerCount: 1, expectedFare: 1300 };
const KEY = 'web-taxi-key-0001';

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', 'synthetic-web-taxi-switch-unit-test-key');
  vi.stubEnv('CORS_ORIGIN', 'https://swift.example');
  vi.stubEnv('TAXI_MAX_STOPS', '');
  vi.stubEnv('TAXI_WAITING_CHARGE', '');
  resetBrowserOriginsForTests();
  vi.clearAllMocks();
  fakes.session.mockResolvedValue({
    id: 'session-test', userId: 'customer-test', expiresAt: new Date(Date.now() + 60_000), authMethod: 'OTP',
  });
  fakes.user.mockResolvedValue({
    id: 'customer-test', tenantId: 'tenant-test', tenant: { kind: 'STANDARD' },
    status: 'ACTIVE', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
  });
  fakes.createRide.mockResolvedValue({
    answer: { order: { id: 'ride-test', orderNumber: 'TEST', status: 'REQUESTED' }, estimate: { fare: 1300, currencyCode: 'GYD' } },
  });
  fakes.queueCreate.mockResolvedValue({ id: 'queue-test' });
  fakes.queueUpdate.mockResolvedValue({ count: 0 });
  fakes.receipt.mockResolvedValue(null);
  fakes.redisSet.mockResolvedValue('OK');
  fakes.redisGet.mockResolvedValue(null);
  fakes.redisEval.mockResolvedValue(1);
  app = Fastify();
  app.decorate('prisma', {
    session: { findUnique: fakes.session },
    user: { findUnique: fakes.user },
    rideQueueEntry: { updateMany: fakes.queueUpdate, create: fakes.queueCreate },
    supplyWatch: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    checkoutReceipt: { findUnique: fakes.receipt },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
  } as never);
  app.decorate('redis', { set: fakes.redisSet, get: fakes.redisGet, eval: fakes.redisEval } as never);
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; code?: string; message: string };
    reply.code(err.statusCode ?? 500).send({ success: false, error: { code: err.code, message: err.message } });
  });
  await app.register(authPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
  token = app.jwt.sign({ userId: 'customer-test', role: 'CUSTOMER' });
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  resetBrowserOriginsForTests();
});

const browser = (extra: Record<string, string> = {}) => ({ cookie: `${ACCESS_COOKIE}=${token}`, origin: 'https://swift.example', 'x-swift-client': 'web', ...extra });
const phone = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (path: string, headers: Record<string, string>, payload: object = quoted) =>
  app.inject({ method: 'POST', url: `/api/v1/rides${path}`, headers, payload });
const capabilities = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/v1/rides/capabilities', headers });

describe('WEB_TAXI_BOOKING reads ON only at exactly "1"', () => {
  it.each([[undefined, false], ['', false], ['0', false], ['true', false], ['on', false], ['yes', false], ['11', false], ['1', true], [' 1 ', true]])(
    '%j -> %s', (value, on) => {
      expect(webTaxiBookingEnabled(value === undefined ? {} : { WEB_TAXI_BOOKING: value })).toBe(on);
    },
  );
});

describe('switch OFF: the browser booking door stays shut, before any side effect', () => {
  it.each([undefined, '', '0', 'true', 'yes'])('WEB_TAXI_BOOKING=%j refuses a quoted, keyed browser booking', async (value) => {
    if (value !== undefined) vi.stubEnv('WEB_TAXI_BOOKING', value);
    const res = await post('/request', browser({ 'idempotency-key': KEY }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TAXI_MOBILE_APP_REQUIRED');
    expect(fakes.createRide).not.toHaveBeenCalled();
    expect(fakes.receipt).not.toHaveBeenCalled();
    expect(fakes.redisSet).not.toHaveBeenCalled();
  });

  it('the capabilities answer is today’s, byte for byte, for a browser and a phone', async () => {
    for (const headers of [browser(), phone()]) {
      expect((await capabilities(headers)).json()).toEqual({ success: true, data: { maxStops: 0 } });
    }
  });
});

describe('switch ON: a browser books through the phone’s own core, only at the fare it showed and under one key', () => {
  beforeEach(() => { vi.stubEnv('WEB_TAXI_BOOKING', '1'); });

  it('a quoted, keyed browser booking reaches the same booking core as the phone, once', async () => {
    const res = await post('/request', browser({ 'idempotency-key': KEY }));
    expect(res.statusCode).toBe(201);
    expect(res.json().data.order.id).toBe('ride-test');
    expect(fakes.createRide).toHaveBeenCalledTimes(1);
    const [, , , userId, ride, , , options] = fakes.createRide.mock.calls[0];
    expect(userId).toBe('customer-test');
    expect(ride).toEqual({
      pickup: trip.pickup, dropoff: trip.dropoff, pickupAddress: trip.pickupAddress, dropoffAddress: trip.dropoffAddress,
      passengerCount: 1, rideClass: 'ECONOMY', expectedFare: 1300,
    });
    expect(options.idempotency.key).toBe(`taxi-request:${KEY}`);
    expect(fakes.redisSet).toHaveBeenCalledWith(`ride-request:idem:customer-test:${KEY}`, expect.any(String), 'EX', 86_400, 'NX');
  });

  it('without the fare it showed: refused in plain words, nothing read, claimed or booked', async () => {
    const unquoted: Partial<typeof quoted> = { ...quoted };
    delete unquoted.expectedFare;
    const res = await post('/request', browser({ 'idempotency-key': KEY }), unquoted);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EXPECTED_FARE_REQUIRED');
    expect(fakes.createRide).not.toHaveBeenCalled();
    expect(fakes.receipt).not.toHaveBeenCalled();
    expect(fakes.redisSet).not.toHaveBeenCalled();
  });

  it.each([['no key', {}], ['a key too short to be one', { 'idempotency-key': 'short' }]])(
    'with %s: refused, nothing read, claimed or booked', async (_name, extra) => {
      const res = await post('/request', browser(extra as Record<string, string>));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(fakes.createRide).not.toHaveBeenCalled();
      expect(fakes.redisSet).not.toHaveBeenCalled();
    },
  );

  it('the phone is untouched: an unquoted, unkeyed bearer booking books as before', async () => {
    const unquoted: Partial<typeof quoted> = { ...quoted };
    delete unquoted.expectedFare;
    const res = await post('/request', phone(), unquoted);
    expect(res.statusCode).toBe(201);
    expect(fakes.createRide).toHaveBeenCalledTimes(1);
  });

  it('the ride queue stays phone-only', async () => {
    const res = await post('/queue/join', browser({ 'idempotency-key': KEY }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TAXI_MOBILE_APP_REQUIRED');
    expect(fakes.queueCreate).not.toHaveBeenCalled();
    // (The phone's queue join is pinned by web-taxi-pilot.unit.test.ts.)
  });

  it('a forged or revoked browser session is still no session', async () => {
    expect((await post('/request', browser({ cookie: `${ACCESS_COOKIE}=invalid`, 'idempotency-key': KEY }))).statusCode).toBe(401);
    fakes.session.mockResolvedValue(null);
    expect((await post('/request', browser({ 'idempotency-key': KEY }))).statusCode).toBe(401);
    expect(fakes.createRide).not.toHaveBeenCalled();
  });

  it('capabilities tell a browser it may book; a phone’s answer stays today’s', async () => {
    expect((await capabilities(browser())).json()).toEqual({ success: true, data: { maxStops: 0, webBooking: true } });
    expect((await capabilities(phone())).json()).toEqual({ success: true, data: { maxStops: 0 } });
  });
});
