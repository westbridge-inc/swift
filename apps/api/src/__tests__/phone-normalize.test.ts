import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { normalizePhone } from '../utils/phone';

// System-wide phone-entry fix: a customer/driver/rider/vendor/admin who types
// their number with spaces (or a paste) must still match the stored E.164, on
// EVERY auth surface. Normalization happens server-side so it fixes all clients
// at once. Failure path first: a spaced phone used to yield "no account".

describe('normalizePhone (pure)', () => {
  it('strips spaces, dashes, parens and dots; preserves the leading +', () => {
    expect(normalizePhone('+592 600 1000')).toBe('+5926001000');
    expect(normalizePhone('+592-600-1000')).toBe('+5926001000');
    expect(normalizePhone(' +592 (600) 1000 ')).toBe('+5926001000');
    expect(normalizePhone('+592.600.1000')).toBe('+5926001000');
    expect(normalizePhone('+5926001000')).toBe('+5926001000'); // already clean → unchanged
  });
});

let app: FastifyInstance;
const digits = String(Math.floor(1000 + Math.random() * 8999));
const CLEAN = `+592600${digits}`;         // as stored
const SPACED = `+592 600 ${digits}`;      // as a human might type it
let userId = '';

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/v1/auth${url}`, headers: { 'content-type': 'application/json' }, payload: payload as Record<string, unknown> });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DEV_OTP_BYPASS'] = '1'; // so code 000000 verifies
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();

  const u = await app.prisma.user.create({
    data: { phone: CLEAN, firstName: 'Norm', lastName: 'Alize', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userId = u.id;
});

afterAll(async () => {
  await app.prisma.session.deleteMany({ where: { userId } });
  await app.prisma.customer.deleteMany({ where: { userId } });
  await app.prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
});

describe('spaced phone works across the auth surface (system-wide fix)', () => {
  it('send-otp accepts a spaced phone', async () => {
    const res = await post('/send-otp', { phone: SPACED });
    expect(res.statusCode).toBe(200);
  });

  it('verify-otp with a SPACED phone logs into the SAME account as the clean number', async () => {
    const res = await post('/verify-otp', { phone: SPACED, code: '000000' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    // It matched the existing user (not treated as a new/unknown number)…
    expect(data.isNewUser).not.toBe(true);
    expect(data.user?.id).toBe(userId);
    // …and it's the same account whose stored phone is the CLEAN form.
    expect(data.user?.phone).toBe(CLEAN);
    expect(data.tokens?.accessToken).toBeTruthy();
  });
});
