import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { requestOtp } from './helpers/otp';

// Unique phone prefix per file (parallel-test gotcha).
const BIKE_PHONE = '+59200199001';
const CAR_PHONE = '+59200199002';

let app: FastifyInstance;
let bikeToken = '';
let carToken = '';

async function cleanup() {
  await app.prisma.user.deleteMany({ where: { phone: { in: [BIKE_PHONE, CAR_PHONE] } } });
}

async function signupCustomer(phone: string): Promise<string> {
  const code = await requestOtp(app, phone);
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-otp',
    payload: { phone, code },
    headers: { 'content-type': 'application/json' },
  });
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { phone, firstName: 'Test', lastName: 'Partner', countryCode: 'GY', role: 'CUSTOMER' },
    headers: { 'content-type': 'application/json' },
  });
  return JSON.parse(reg.body).data.tokens.accessToken;
}

function post(url: string, payload: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}
function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();

  await cleanup();
  for (const p of [BIKE_PHONE, CAR_PHONE]) {
    await app.redis.del(`otp:${p}`, `otp_rate:${p}`, `otp_attempt:${p}`, `otp_verified:${p}`);
  }
  bikeToken = await signupCustomer(BIKE_PHONE);
  carToken = await signupCustomer(CAR_PHONE);
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('partner provisioning — failure paths', () => {
  it('rejects unauthenticated /become', async () => {
    const res = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' });
    expect(res.statusCode).toBe(401);
  });

  it('a fresh customer 404s on /driver before provisioning', async () => {
    const res = await get('/api/v1/driver/profile', carToken);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a car driver with no vehicle details', async () => {
    const res = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'CAR' }, carToken);
    expect(res.statusCode).toBe(400);
  });
});

describe('partner provisioning — happy paths', () => {
  it('provisions a Driver with vehicle details and unblocks /driver', async () => {
    const res = await post(
      '/api/v1/partner/become',
      { role: 'MOVER', vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: 'PXX 1234' } },
      carToken,
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('DRIVER');
    const profile = await get('/api/v1/driver/profile', carToken);
    expect(profile.statusCode).toBe(200);
  });

  it('is idempotent — re-provisioning a Driver returns 200, no duplicate', async () => {
    const res = await post(
      '/api/v1/partner/become',
      { role: 'MOVER', vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: 'PXX 1234' } },
      carToken,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.created).toBe(false);
    const count = await app.prisma.driver.count({ where: { user: { phone: CAR_PHONE } } });
    expect(count).toBe(1);
  });

  it('provisions a Rider for a bike mover and unblocks /rider', async () => {
    const res = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' }, bikeToken);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('RIDER');
    const profile = await get('/api/v1/rider/profile', bikeToken);
    expect(profile.statusCode).toBe(200);
  });

  it('appends MOVER + RIDER roles exactly once', async () => {
    await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' }, bikeToken);
    const user = await app.prisma.user.findUnique({ where: { phone: BIKE_PHONE }, select: { roles: true } });
    expect(user?.roles.filter((r) => r === 'MOVER')).toHaveLength(1);
    expect(user?.roles).toContain('RIDER');
  });
});
