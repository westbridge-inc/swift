import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { requestOtp, loginWithOtp, wrongCode } from './helpers/otp';
import { LEGAL_VERSION } from '../modules/legal/legal.routes';

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
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_hr:${phone}`, `otp_attempt:${phone}`);
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
      await app.redis.del('otp_rate:+5926003000', 'otp_hr:+5926003000');
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

    it('SWIFT-107: the advertised expiresIn equals the token\'s real TTL (900s)', async () => {
      const code = await requestOtp(app, '+5926003000');
      const res = await inject('POST', '/api/v1/auth/verify-otp', { phone: '+5926003000', code });
      const { accessToken, expiresIn } = res.json().data.tokens;
      const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
      // RED before SWIFT-107: expiresIn advertised 1800 while the token really
      // lived 900s, so clients refreshed 15 minutes too late (a window of 401s).
      expect(expiresIn).toBe(900);
      expect(payload.exp - payload.iat).toBe(expiresIn);
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
      const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
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
      const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
        phone: '+5926003000', // Existing test customer
        firstName: 'Dup',
        lastName: 'User',
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('USER_EXISTS');
    });

    // SWIFT-AUD-D9-03: DPA-2023 consent must be demonstrable — the acceptance
    // is recorded server-side with the legal version it covered. Optional in
    // the schema so shipped clients keep working; CONSENT_REQUIRED=1 flips
    // enforcement once updated clients are out.
    describe('consent recording [SWIFT-AUD-D9-03]', () => {
      const consentPhone = '+5929998866';
      const noConsentPhone = '+5929998855';

      afterAll(async () => {
        delete process.env['CONSENT_REQUIRED'];
        for (const phone of [consentPhone, noConsentPhone]) {
          const u = await app.prisma.user.findUnique({ where: { phone } });
          if (u) {
            await app.prisma.session.deleteMany({ where: { userId: u.id } });
            await app.prisma.customer.deleteMany({ where: { userId: u.id } });
            await app.prisma.user.delete({ where: { id: u.id } });
          }
        }
      });

      it('stamps acceptedTermsAt + the served legal version when the client accepts', async () => {
        await loginWithOtp(app, consentPhone);
        const res = await inject('POST', '/api/v1/auth/register', {
          phone: consentPhone,
          firstName: 'Consent',
          lastName: 'Given',
          acceptTerms: true,
        });
        expect(res.statusCode).toBe(201);
        const row = await app.prisma.user.findUnique({ where: { phone: consentPhone } });
        expect(row?.acceptedTermsAt).toBeInstanceOf(Date);
        expect(row?.tosVersion).toBe(LEGAL_VERSION);

        // [DCR-1 NR1-02] The same transaction wrote the LEDGER rows: one per
        // required document, anchored to the sha256 of the exact served text.
        const ledger = await app.prisma.consentRecord.findMany({
          where: { subjectType: 'customer', subjectId: row!.id },
          orderBy: { documentType: 'asc' },
        });
        expect(ledger.map((r) => [r.documentType, r.action, r.documentVersion])).toEqual([
          ['privacy_policy', 'granted', LEGAL_VERSION],
          ['terms_of_service', 'granted', LEGAL_VERSION],
        ]);
        const tos = await app.prisma.legalDocument.findUniqueOrThrow({
          where: {
            documentType_version_locale: {
              documentType: 'terms_of_service', version: LEGAL_VERSION, locale: 'en-GY',
            },
          },
        });
        expect(ledger.find((r) => r.documentType === 'terms_of_service')?.documentContentHash)
          .toBe(tos.contentHash);
        expect(tos.publishedAt).toBeInstanceOf(Date);
      });

      it('[F-021-05] consent is required BY DEFAULT — a consent-less registration is refused', async () => {
        await loginWithOtp(app, noConsentPhone);
        const res = await inject('POST', '/api/v1/auth/register', {
          phone: noConsentPhone,
          firstName: 'Old',
          lastName: 'Client',
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('CONSENT_REQUIRED');
      });

      it('the compat kill-switch (CONSENT_REQUIRED=0) admits old clients and fabricates nothing', async () => {
        process.env['CONSENT_REQUIRED'] = '0';
        try {
          const res = await inject('POST', '/api/v1/auth/register', {
            phone: noConsentPhone,
            firstName: 'Old',
            lastName: 'Client',
          });
          expect(res.statusCode).toBe(201);
          const row = await app.prisma.user.findUnique({ where: { phone: noConsentPhone } });
          expect(row?.acceptedTermsAt).toBeNull();
          expect(row?.tosVersion).toBeNull();
          // No consent claimed → no ledger rows fabricated.
          expect(await app.prisma.consentRecord.count({
            where: { subjectType: 'customer', subjectId: row!.id },
          })).toBe(0);
        } finally {
          delete process.env['CONSENT_REQUIRED'];
        }
      });

      it('CONSENT_REQUIRED=1 refuses a consent-less registration', async () => {
        process.env['CONSENT_REQUIRED'] = '1';
        try {
          const phone = '+5929998844'; // never registers → nothing to clean up
          await loginWithOtp(app, phone);
          const res = await inject('POST', '/api/v1/auth/register', {
            phone,
            firstName: 'No',
            lastName: 'Consent',
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().error.code).toBe('CONSENT_REQUIRED');
        } finally {
          delete process.env['CONSENT_REQUIRED'];
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // Sensitive fields never leave the API on a user object
  // -----------------------------------------------------------------------

  describe('User serialization', () => {
    const SENSITIVE = ['passwordHash', 'failedLoginAttempts', 'lockedUntil', 'lastKnownLat', 'lastKnownLng'];

    it('login response carries no credential or lockout internals', async () => {
      const res = await loginWithOtp(app, '+5926002000');
      const user = res.json().data.user;
      expect(user).toBeDefined();
      for (const field of SENSITIVE) {
        expect(user, `user.${field} must not be serialized`).not.toHaveProperty(field);
      }
      // The shape the app routes on is intact
      expect(user.roles).toBeDefined();
    });

    it('registration response carries no credential or lockout internals', async () => {
      const phone = '+5929998866';
      try {
        await loginWithOtp(app, phone);
        const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
          phone,
          firstName: 'Sanitize',
          lastName: 'Check',
        });
        expect(res.statusCode).toBe(201);
        const user = res.json().data.user;
        for (const field of SENSITIVE) {
          expect(user, `user.${field} must not be serialized`).not.toHaveProperty(field);
        }
      } finally {
        const u = await app.prisma.user.findUnique({ where: { phone } });
        if (u) {
          await app.prisma.session.deleteMany({ where: { userId: u.id } });
          await app.prisma.customer.deleteMany({ where: { userId: u.id } });
          await app.prisma.user.delete({ where: { id: u.id } });
        }
      }
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
      // SWIFT-107: advertised expiry now matches the real 15-minute JWT TTL (was 1800).
      expect(body.data.expiresIn).toBe(900);
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

    // Rotation theft detection: replaying a refresh token that was already
    // rotated away is how a stolen token surfaces. Outside the race-grace
    // window the whole session dies (both holders re-authenticate) and the
    // event is audited.
    it('reuse of a rotated refresh token revokes the session and audits it', async () => {
      const prevGrace = process.env['REFRESH_REUSE_GRACE_MS'];
      process.env['REFRESH_REUSE_GRACE_MS'] = '0';
      try {
        const loginRes = await loginWithOtp(app, '+5926002000');
        const r1 = loginRes.json().data.tokens.refreshToken;

        const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: r1 });
        expect(rotate.statusCode).toBe(200);
        const r2 = rotate.json().data.refreshToken;

        // Replay the consumed token — same 401 shape as any bad token (no oracle)
        const replay = await inject('POST', '/api/v1/auth/refresh', { refreshToken: r1 });
        expect(replay.statusCode).toBe(401);

        // The theft response killed the session: the CURRENT token is dead too
        const afterKill = await inject('POST', '/api/v1/auth/refresh', { refreshToken: r2 });
        expect(afterKill.statusCode).toBe(401);

        const audit = await app.prisma.auditLog.findFirst({
          where: { action: 'REFRESH_TOKEN_REUSE' },
          orderBy: { createdAt: 'desc' },
        });
        expect(audit).not.toBeNull();
      } finally {
        if (prevGrace === undefined) delete process.env['REFRESH_REUSE_GRACE_MS'];
        else process.env['REFRESH_REUSE_GRACE_MS'] = prevGrace;
      }
    });

    it('keeps the uniform 401 and revoked state when the reuse audit sink fails', async () => {
      const prevGrace = process.env['REFRESH_REUSE_GRACE_MS'];
      process.env['REFRESH_REUSE_GRACE_MS'] = '0';
      const auditWrite = vi.spyOn(app.prisma.auditLog, 'create')
        .mockRejectedValueOnce(new Error('simulated audit sink outage'));
      try {
        const loginRes = await loginWithOtp(app, '+5926002000');
        const firstRefresh = loginRes.json().data.tokens.refreshToken as string;
        const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: firstRefresh });
        expect(rotate.statusCode).toBe(200);
        const currentRefresh = rotate.json().data.refreshToken as string;

        const replay = await inject('POST', '/api/v1/auth/refresh', { refreshToken: firstRefresh });
        expect(replay.statusCode).toBe(401);
        expect(replay.json().error.code).toBe('INVALID_TOKEN');

        // The already-committed security action is not undone or hidden behind
        // a 500 merely because its audit delivery failed.
        const currentAfterAuditFailure = await inject('POST', '/api/v1/auth/refresh', {
          refreshToken: currentRefresh,
        });
        expect(currentAfterAuditFailure.statusCode).toBe(401);
        expect(auditWrite).toHaveBeenCalledTimes(1);
      } finally {
        auditWrite.mockRestore();
        if (prevGrace === undefined) delete process.env['REFRESH_REUSE_GRACE_MS'];
        else process.env['REFRESH_REUSE_GRACE_MS'] = prevGrace;
      }
    });

    it('concurrent double-fire within the grace window is idempotent, not theft', async () => {
      // The mobile interceptor can legitimately re-send the same refresh token
      // when two requests 401 at once — that must return the already-rotated
      // pair, not kill the session.
      const loginRes = await loginWithOtp(app, '+5926002000');
      const r1 = loginRes.json().data.tokens.refreshToken;

      // Start both requests before awaiting either result. This forces the two
      // refresh transactions to contend for the same locked Session row rather
      // than merely exercising a sequential grace-window replay.
      const [first, retry] = await Promise.all([
        inject('POST', '/api/v1/auth/refresh', { refreshToken: r1 }),
        inject('POST', '/api/v1/auth/refresh', { refreshToken: r1 }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(retry.statusCode).toBe(200);
      const pair = first.json().data;
      expect(retry.json().data.refreshToken).toBe(pair.refreshToken);
      expect(retry.json().data.accessToken).toBe(pair.accessToken);

      // Session is still alive: the current pair keeps working
      const next = await inject('POST', '/api/v1/auth/refresh', { refreshToken: pair.refreshToken });
      expect(next.statusCode).toBe(200);
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
