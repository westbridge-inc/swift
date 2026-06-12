import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { requestOtp, loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// Step 3 — auth & accounts: role+country signup (OTP-mandatory), password
// login with lockout, reset that kills sessions, real logout (SEC-8), and
// role-crossing denial. The failure paths come first wherever possible.
// ---------------------------------------------------------------------------

const MOVER_PHONE = '+5920001111';
const VENDOR_PHONE = '+5920002222';
const WAITLIST_PHONE = '+5920003333';
const CROSSING_PHONE = '+5920003334';
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;

async function cleanupUsers() {
  await app.prisma.user.deleteMany({
    where: { phone: { in: [MOVER_PHONE, VENDOR_PHONE, WAITLIST_PHONE, CROSSING_PHONE] } },
  });
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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  await cleanupUsers();
  for (const phone of [MOVER_PHONE, VENDOR_PHONE, WAITLIST_PHONE, CROSSING_PHONE]) {
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_attempt:${phone}`, `otp_verified:${phone}`);
  }
});

afterAll(async () => {
  await cleanupUsers();
  await app.close();
});

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** Full signup: OTP flow then register with role + country. */
async function signup(phone: string, role: 'CUSTOMER' | 'MOVER' | 'VENDOR', countryCode = 'GY') {
  await loginWithOtp(app, phone); // unknown phone -> isNewUser + registration window
  return inject('POST', '/api/v1/auth/register', {
    phone,
    firstName: 'Step3',
    lastName: role,
    role,
    countryCode,
  });
}

describe('Country picker', () => {
  it('lists Guyana as an active country before signup (public)', async () => {
    const res = await inject('GET', '/api/v1/auth/countries');
    expect(res.statusCode).toBe(200);
    const codes = res.json().data.map((c: { code: string }) => c.code);
    expect(codes).toContain('GY');
  });
});

describe('Signup — OTP mandatory, role + country aware', () => {
  it('rejects registration without a verified OTP', async () => {
    const res = await inject('POST', '/api/v1/auth/register', {
      phone: MOVER_PHONE,
      firstName: 'No',
      lastName: 'Otp',
      role: 'MOVER',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OTP_REQUIRED');
  });

  it('rejects signup for a country that is not live', async () => {
    await loginWithOtp(app, WAITLIST_PHONE);
    const res = await inject('POST', '/api/v1/auth/register', {
      phone: WAITLIST_PHONE,
      firstName: 'Wait',
      lastName: 'List',
      role: 'CUSTOMER',
      countryCode: 'TT',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('COUNTRY_NOT_ACTIVE');
  });

  it('signs up a MOVER: multi-role, L1, verification onboarding from config', async () => {
    const res = await signup(MOVER_PHONE, 'MOVER');
    const body = res.json();
    expect(res.statusCode).toBe(201);
    expect(body.data.user.roles).toContain('MOVER');
    expect(body.data.user.roles).toContain('CUSTOMER'); // a mover can order too
    expect(body.data.user.activeRole).toBe('MOVER');
    expect(body.data.user.trustLevel).toBe('L1');
    expect(body.data.user.countryCode).toBe('GY');
    expect(body.data.tokens.accessToken).toBeDefined();
    expect(body.data.onboarding.next).toBe('VERIFICATION');
    expect(body.data.onboarding.requiredDocuments).toContain('national_id');
  });

  it('signs up a VENDOR: vendor owner record + setup onboarding', async () => {
    const res = await signup(VENDOR_PHONE, 'VENDOR');
    const body = res.json();
    expect(res.statusCode).toBe(201);
    expect(body.data.user.roles).toContain('VENDOR_OWNER');
    expect(body.data.user.activeRole).toBe('VENDOR_OWNER');
    expect(body.data.user.vendorOwner).toBeTruthy();
    expect(body.data.onboarding.next).toBe('VENDOR_SETUP');
  });

  it('the registration window is single-use', async () => {
    // MOVER_PHONE's window was consumed by the successful signup
    const res = await inject('POST', '/api/v1/auth/register', {
      phone: MOVER_PHONE,
      firstName: 'Replay',
      lastName: 'Attempt',
    });
    expect(res.statusCode).toBe(409); // duplicate phone — and no window either
  });
});

describe('Email + password login with lockout', () => {
  let moverToken: string;

  beforeAll(async () => {
    const login = await loginWithOtp(app, MOVER_PHONE);
    moverToken = login.json().data.tokens.accessToken;
  });

  it('sets a password (authenticated)', async () => {
    const res = await inject('POST', '/api/v1/auth/password/set', { password: PASSWORD }, moverToken);
    expect(res.statusCode).toBe(200);
  });

  it('logs in with phone + password', async () => {
    const res = await inject('POST', '/api/v1/auth/password/login', {
      phone: MOVER_PHONE,
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.tokens.accessToken).toBeDefined();
  });

  it('rejects a wrong password without leaking whether the account exists', async () => {
    const wrong = await inject('POST', '/api/v1/auth/password/login', {
      phone: MOVER_PHONE,
      password: 'wrong-password-1',
    });
    const unknown = await inject('POST', '/api/v1/auth/password/login', {
      phone: '+5929990000',
      password: 'wrong-password-1',
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
  });

  it('locks the account after 5 failures — even the right password is refused', async () => {
    for (let i = 0; i < 5; i++) {
      const attempt = await inject('POST', '/api/v1/auth/password/login', {
        phone: MOVER_PHONE,
        password: `wrong-password-${i}`,
      });
      expect([401, 423]).toContain(attempt.statusCode);
    }
    const locked = await inject('POST', '/api/v1/auth/password/login', {
      phone: MOVER_PHONE,
      password: PASSWORD,
    });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('password reset via OTP unlocks the account and kills every session', async () => {
    // Token that must die with the reset
    const preReset = moverToken;

    const code = await requestOtp(app, MOVER_PHONE);
    const reset = await inject('POST', '/api/v1/auth/password/reset', {
      phone: MOVER_PHONE,
      code,
      newPassword: `${PASSWORD}-2`,
    });
    expect(reset.statusCode).toBe(200);

    // Lock cleared, new password works
    const login = await inject('POST', '/api/v1/auth/password/login', {
      phone: MOVER_PHONE,
      password: `${PASSWORD}-2`,
    });
    expect(login.statusCode).toBe(200);

    // Old session is dead (SEC-8: session-backed auth)
    const replay = await inject('POST', '/api/v1/auth/logout', {}, preReset);
    expect(replay.statusCode).toBe(401);
  });
});

describe('Token lifecycle — replay and expiry', () => {
  it('logout invalidates the access token immediately (SEC-8 regression)', async () => {
    const login = await loginWithOtp(app, MOVER_PHONE);
    const token = login.json().data.tokens.accessToken;

    const out = await inject('POST', '/api/v1/auth/logout', {}, token);
    expect(out.statusCode).toBe(200);

    const replay = await inject('POST', '/api/v1/auth/logout', {}, token);
    expect(replay.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expired = app.jwt.sign({ userId: 'whoever', role: 'CUSTOMER' }, { expiresIn: '1ms' });
    await new Promise((r) => setTimeout(r, 20));
    const res = await inject('POST', '/api/v1/auth/logout', {}, expired);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged token that was never issued as a session', async () => {
    const forged = app.jwt.sign({ userId: 'attacker', role: 'SUPER_ADMIN' });
    const res = await inject('GET', '/api/v1/admin/dashboard/overview', undefined, forged);
    expect(res.statusCode).toBe(401);
  });
});

describe('Role-crossing authorization', () => {
  let customerToken: string;

  beforeAll(async () => {
    // Own customer — never touch seeded phones from a parallel file
    const res = await signup(CROSSING_PHONE, 'CUSTOMER');
    customerToken = res.json().data.tokens.accessToken;
  });

  it('a customer cannot call admin endpoints', async () => {
    const res = await inject('GET', '/api/v1/admin/dashboard/overview', undefined, customerToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
  });

  it('a customer cannot read vendor data', async () => {
    const res = await inject('GET', '/api/v1/vendor/profile', undefined, customerToken);
    expect([401, 403, 404]).toContain(res.statusCode);
    expect(res.json().success).not.toBe(true);
  });

  it('switching to VENDOR works for vendor owners (enum-mapping regression)', async () => {
    const login = await loginWithOtp(app, VENDOR_PHONE);
    const vendorToken = login.json().data.tokens.accessToken;

    const toCustomer = await inject('POST', '/api/v1/customer/switch-role', { role: 'CUSTOMER' }, vendorToken);
    expect(toCustomer.statusCode).toBe(200);

    const backToVendor = await inject('POST', '/api/v1/customer/switch-role', { role: 'VENDOR' }, vendorToken);
    expect(backToVendor.statusCode).toBe(200);
    expect(backToVendor.json().data.role).toBe('VENDOR');
  });

  it('a customer cannot switch into a role they do not hold', async () => {
    const res = await inject('POST', '/api/v1/customer/switch-role', { role: 'VENDOR' }, customerToken);
    expect(res.statusCode).toBe(403);
  });
});
