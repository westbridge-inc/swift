import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { requestOtp, loginWithOtp, wrongCode } from './helpers/otp';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.ready();
  return server;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();

  // NOTE: no session wiping here. Tokens carry a jti nonce so they never
  // collide, and deleting seeded users' sessions kills parallel test files
  // mid-flight (auth is session-backed since SEC-8).

  // Reset OTP state from prior runs so send/verify flows are deterministic
  const otpPhones = ['+5926003000', '+5926002000', '+5926004000', '+5929999999', '+5928887777'];
  for (const phone of otpPhones) {
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_attempt:${phone}`);
  }
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers?: Record<string, string>) {
  return app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth Routes', () => {
  // -----------------------------------------------------------------------
  // POST /api/v1/auth/send-otp
  // -----------------------------------------------------------------------

  describe('POST /api/v1/auth/send-otp', () => {
    it('returns success with expiresIn for valid phone', async () => {
      await app.redis.del('otp_rate:+5926003000');
      const res = await inject('POST', '/api/v1/auth/send-otp', {
        phone: '+5926003000',
      });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.expiresIn).toBe(300);
    });

    it('rejects an immediate resend for the same phone (cooldown)', async () => {
      // Previous test just sent one — the 60s per-phone cooldown must block this
      const res = await inject('POST', '/api/v1/auth/send-otp', {
        phone: '+5926003000',
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMITED');
    });

    it('rejects invalid phone (too short)', async () => {
      const res = await inject('POST', '/api/v1/auth/send-otp', {
        phone: '123',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/verify-otp
  // -----------------------------------------------------------------------

  describe('POST /api/v1/auth/verify-otp', () => {
    it('returns tokens for existing user (customer)', async () => {
      const code = await requestOtp(app, '+5926003000');
      const res = await inject('POST', '/api/v1/auth/verify-otp', {
        phone: '+5926003000',
        code,
      });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.isNewUser).toBe(false);
      expect(body.data.tokens).toBeDefined();
      expect(body.data.tokens.accessToken).toBeDefined();
      expect(body.data.tokens.refreshToken).toBeDefined();
      expect(body.data.user).toBeDefined();
    });

    it('returns isNewUser true for unknown phone', async () => {
      const code = await requestOtp(app, '+5929999999');
      const res = await inject('POST', '/api/v1/auth/verify-otp', {
        phone: '+5929999999',
        code,
      });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.data.isNewUser).toBe(true);
    });

    it('rejects invalid OTP code', async () => {
      const code = await requestOtp(app, '+5926003000');
      const res = await inject('POST', '/api/v1/auth/verify-otp', {
        phone: '+5926003000',
        code: wrongCode(code),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
    });

    it('locks out after 5 failed attempts even with the correct code (SEC-6)', async () => {
      const phone = '+5928887777';
      const code = await requestOtp(app, phone);
      const bad = wrongCode(code);

      for (let i = 0; i < 5; i++) {
        const res = await inject('POST', '/api/v1/auth/verify-otp', { phone, code: bad });
        expect(res.statusCode).toBe(400);
      }

      // Attempts are exhausted — the real code must be refused too
      const res = await inject('POST', '/api/v1/auth/verify-otp', { phone, code });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/too many attempts/i);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/register
  // -----------------------------------------------------------------------

  describe('POST /api/v1/auth/register', () => {
    const testPhone = '+5929998877';

    afterAll(async () => {
      // Cleanup: delete test user and related records
      const user = await app.prisma.user.findUnique({ where: { phone: testPhone } });
      if (user) {
        await app.prisma.session.deleteMany({ where: { userId: user.id } });
        await app.prisma.customer.deleteMany({ where: { userId: user.id } });
        await app.prisma.user.delete({ where: { id: user.id } });
      }
    });

    it('creates a new user and returns tokens', async () => {
      // OTP at signup is mandatory — prove phone ownership first
      await loginWithOtp(app, testPhone);
      const res = await inject('POST', '/api/v1/auth/register', {
        phone: testPhone,
        firstName: 'Test',
        lastName: 'User',
      });
      const body = res.json();
      expect(res.statusCode).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.user).toBeDefined();
      expect(body.data.user.phone).toBe(testPhone);
      expect(body.data.user.firstName).toBe('Test');
      expect(body.data.user.customer).toBeDefined();
      expect(body.data.tokens.accessToken).toBeDefined();
      expect(body.data.tokens.refreshToken).toBeDefined();
    });

    it('rejects duplicate phone', async () => {
      const res = await inject('POST', '/api/v1/auth/register', {
        phone: '+5926003000', // Existing test customer
        firstName: 'Dup',
        lastName: 'User',
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('USER_EXISTS');
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/refresh
  // -----------------------------------------------------------------------

  describe('POST /api/v1/auth/refresh', () => {
    it('returns new tokens for valid refresh token', async () => {
      // Use a different user (vendor) to avoid token collision with earlier login
      const loginRes = await loginWithOtp(app, '+5926002000');
      const loginBody = loginRes.json();
      expect(loginBody.data.tokens).toBeDefined();
      const { refreshToken } = loginBody.data.tokens;

      const res = await inject('POST', '/api/v1/auth/refresh', { refreshToken });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.accessToken).toBeDefined();
      expect(body.data.refreshToken).toBeDefined();
      // SEC-3: access tokens are 30 minutes now, not 24h
      expect(body.data.expiresIn).toBe(1800);
    });

    it('rejects invalid refresh token', async () => {
      const res = await inject('POST', '/api/v1/auth/refresh', {
        refreshToken: 'invalid-token-that-does-not-exist',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects malformed body — missing refreshToken (SEC-4)', async () => {
      const res = await inject('POST', '/api/v1/auth/refresh', {});
      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/logout
  // -----------------------------------------------------------------------

  describe('POST /api/v1/auth/logout', () => {
    it('invalidates the token', async () => {
      // Use rider user to avoid token collision with earlier logins
      const loginRes = await loginWithOtp(app, '+5926004000');
      const loginBody = loginRes.json();
      expect(loginBody.data.tokens).toBeDefined();
      const { accessToken } = loginBody.data.tokens;

      // Logout
      const res = await inject('POST', '/api/v1/auth/logout', {}, {
        authorization: `Bearer ${accessToken}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('rejects logout without auth token', async () => {
      const res = await inject('POST', '/api/v1/auth/logout', {}, {});
      // Without a Bearer token, the authenticate preHandler returns 401.
      // The route requires auth (preHandler: [app.authenticate]).
      // Fastify sends 401 from the authenticate decorator.
      expect(res.statusCode).toBe(401);
    });
  });
});
