import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// auth & accounts: role+country signup (OTP-mandatory), password
// login with lockout, reset that kills sessions, real logout (SEC-8), and
// role-crossing denial. The failure paths come first wherever possible.
// ---------------------------------------------------------------------------

const MOVER_PHONE = '+5920001111';
const VENDOR_PHONE = '+5920002222';
// Outside the Caribbean footprint (UK) — the dial prefix derives no market,
// and the claimed country has no config row, so signup hits the waitlist gate.
const WAITLIST_PHONE = '+4477009003333';
const CROSSING_PHONE = '+5920003334';
const REFRESH_LOGOUT_WIN_PHONE = '+5920003341';
const REFRESH_ROTATE_WIN_PHONE = '+5920003342';
const REFRESH_PUSH_OWNER_PHONE = '+5920003343';
const ROLE_AUTHORITY_PHONE = '+5920003344';
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;

async function cleanupUsers() {
  await app.prisma.user.deleteMany({
    where: {
      phone: {
        in: [
          MOVER_PHONE,
          VENDOR_PHONE,
          WAITLIST_PHONE,
          CROSSING_PHONE,
          REFRESH_LOGOUT_WIN_PHONE,
          REFRESH_ROTATE_WIN_PHONE,
          REFRESH_PUSH_OWNER_PHONE,
          ROLE_AUTHORITY_PHONE,
        ],
      },
    },
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
  for (const phone of [
    MOVER_PHONE,
    VENDOR_PHONE,
    WAITLIST_PHONE,
    CROSSING_PHONE,
    REFRESH_LOGOUT_WIN_PHONE,
    REFRESH_ROTATE_WIN_PHONE,
    REFRESH_PUSH_OWNER_PHONE,
    ROLE_AUTHORITY_PHONE,
  ]) {
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_hr:${phone}`, `otp_attempt:${phone}`, `otp_verified:${phone}`);
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

async function ensureMoverProfiles(userId: string) {
  const rider = await app.prisma.rider.upsert({
    where: { userId },
    create: {
      userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      isAvailable: true,
    },
    update: {},
  });
  const driver = await app.prisma.driver.upsert({
    where: { userId },
    create: {
      userId,
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleYear: 2020,
      vehicleColor: 'Silver',
      licensePlate: `AUTH-${userId.slice(-8)}`,
      driverLicenseUrl: 'storage://auth-test/license.jpg',
      vehicleInsuranceUrl: 'storage://auth-test/insurance.jpg',
      documentsVerified: true,
      isOnline: true,
      isAvailable: true,
    },
    update: {},
  });
  return { rider, driver };
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

  it('rejects signup for a market Swift is not in (whole Caribbean IS live)', async () => {
    await loginWithOtp(app, WAITLIST_PHONE);
    const res = await inject('POST', '/api/v1/auth/register', {
      phone: WAITLIST_PHONE, // UK prefix — derives no Caribbean market
      firstName: 'Wait',
      lastName: 'List',
      role: 'CUSTOMER',
      countryCode: 'US', // no config row → waitlist
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
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } });
    const session = await app.prisma.session.findUniqueOrThrow({ where: { token: preReset } });
    const profiles = await ensureMoverProfiles(user.id);
    await Promise.all([
      app.prisma.rider.update({
        where: { id: profiles.rider.id },
        data: { locationSessionId: session.id, isOnline: true, isAvailable: true },
      }),
      app.prisma.driver.update({
        where: { id: profiles.driver.id },
        data: { locationSessionId: session.id, isOnline: true, isAvailable: true },
      }),
    ]);

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
    const [rider, driver] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: profiles.rider.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: profiles.driver.id } }),
    ]);
    expect({
      riderOwner: rider.locationSessionId,
      riderOnline: rider.isOnline,
      riderAvailable: rider.isAvailable,
      driverOwner: driver.locationSessionId,
      driverOnline: driver.isOnline,
      driverAvailable: driver.isAvailable,
    }).toEqual({
      riderOwner: null,
      riderOnline: false,
      riderAvailable: false,
      driverOwner: null,
      driverOnline: false,
      driverAvailable: false,
    });
  });
});

describe('Token lifecycle — replay and expiry', () => {
  it('refresh-credential logout wins a paused refresh and exposes no credential oracle', async () => {
    const registration = await signup(REFRESH_LOGOUT_WIN_PHONE, 'MOVER');
    expect(registration.statusCode).toBe(201);
    const tokens = registration.json().data.tokens as { accessToken: string; refreshToken: string };
    const [user, session] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { phone: REFRESH_LOGOUT_WIN_PHONE } }),
      app.prisma.session.findUniqueOrThrow({ where: { token: tokens.accessToken } }),
    ]);
    const profiles = await ensureMoverProfiles(user.id);
    await Promise.all([
      app.prisma.rider.update({
        where: { id: profiles.rider.id },
        data: { locationSessionId: session.id },
      }),
      app.prisma.driver.update({
        where: { id: profiles.driver.id },
        data: { locationSessionId: session.id },
      }),
    ]);
    const pushToken = 'ExponentPushToken[refresh-logout-wins]';
    await app.prisma.deviceToken.upsert({
      where: { token: pushToken },
      create: { token: pushToken, userId: user.id, platform: 'ios', isActive: true },
      update: { userId: user.id, platform: 'ios', isActive: true },
    });

    // Pause refresh immediately after its non-authoritative credential lookup.
    // Logout then obtains User -> Session locks first and deletes the row;
    // refresh must re-check under those locks and fail rather than resurrect it.
    let reachedLookup!: () => void;
    let resumeLookup!: () => void;
    const atLookup = new Promise<void>((resolve) => { reachedLookup = resolve; });
    const resume = new Promise<void>((resolve) => { resumeLookup = resolve; });
    const originalFindFirst = app.prisma.session.findFirst.bind(app.prisma.session);
    const lookup = vi.spyOn(app.prisma.session, 'findFirst').mockImplementationOnce((async (...args: unknown[]) => {
      const found = await originalFindFirst(...(args as [Parameters<typeof originalFindFirst>[0]]));
      reachedLookup();
      await resume;
      return found;
    }) as never);
    const socketRoom = vi.spyOn(app.io, 'in');

    let logoutResponse!: Awaited<ReturnType<typeof app.inject>>;
    let refreshResponse!: Awaited<ReturnType<typeof app.inject>>;
    let disconnectedSessionRoom = false;
    try {
      const refreshPromise = inject('POST', '/api/v1/auth/refresh', { refreshToken: tokens.refreshToken });
      await atLookup;
      logoutResponse = await inject('POST', '/api/v1/auth/logout/refresh', {
        refreshToken: tokens.refreshToken,
        pushToken,
      });
      disconnectedSessionRoom = socketRoom.mock.calls.some(([room]) => room === `session:${session.id}`);
      resumeLookup();
      refreshResponse = await refreshPromise;
    } finally {
      resumeLookup();
      lookup.mockRestore();
      socketRoom.mockRestore();
    }

    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json()).toEqual({ success: true });
    expect(refreshResponse.statusCode).toBe(401);
    expect(disconnectedSessionRoom).toBe(true);

    const [afterRider, afterDriver, afterPush, deletedSession] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: profiles.rider.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: profiles.driver.id } }),
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token: pushToken } }),
      app.prisma.session.findUnique({ where: { id: session.id } }),
    ]);
    expect(afterRider.locationSessionId).toBeNull();
    expect(afterDriver.locationSessionId).toBeNull();
    expect(afterPush.isActive).toBe(false);
    expect(deletedSession).toBeNull();

    const [accessReplay, refreshReplay, invalidLogout] = await Promise.all([
      inject('POST', '/api/v1/auth/logout', {}, tokens.accessToken),
      inject('POST', '/api/v1/auth/refresh', { refreshToken: tokens.refreshToken }),
      inject('POST', '/api/v1/auth/logout/refresh', { refreshToken: 'not-a-real-refresh-credential' }),
    ]);
    expect(accessReplay.statusCode).toBe(401);
    expect(refreshReplay.statusCode).toBe(401);
    expect(invalidLogout.statusCode).toBe(logoutResponse.statusCode);
    expect(invalidLogout.json()).toEqual(logoutResponse.json());
  });

  it('refresh may rotate first, then logout revokes via previous token without touching another user push token', async () => {
    const registration = await signup(REFRESH_ROTATE_WIN_PHONE, 'MOVER');
    const otherRegistration = await signup(REFRESH_PUSH_OWNER_PHONE, 'CUSTOMER');
    expect(registration.statusCode).toBe(201);
    expect(otherRegistration.statusCode).toBe(201);
    const captured = registration.json().data.tokens as { accessToken: string; refreshToken: string };
    const [user, otherUser, session] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { phone: REFRESH_ROTATE_WIN_PHONE } }),
      app.prisma.user.findUniqueOrThrow({ where: { phone: REFRESH_PUSH_OWNER_PHONE } }),
      app.prisma.session.findUniqueOrThrow({ where: { token: captured.accessToken } }),
    ]);
    const profiles = await ensureMoverProfiles(user.id);
    await Promise.all([
      app.prisma.rider.update({
        where: { id: profiles.rider.id },
        data: { locationSessionId: session.id },
      }),
      app.prisma.driver.update({
        where: { id: profiles.driver.id },
        data: { locationSessionId: session.id },
      }),
    ]);

    const pushToken = 'ExponentPushToken[refresh-logout-reassigned]';
    await app.prisma.deviceToken.upsert({
      where: { token: pushToken },
      create: { token: pushToken, userId: user.id, platform: 'android', isActive: true },
      update: { userId: user.id, platform: 'android', isActive: true },
    });
    await app.prisma.deviceToken.update({
      where: { token: pushToken },
      data: { userId: otherUser.id, isActive: true },
    });

    // Pause logout after it resolves the current credential. Refresh rotates
    // under User -> Session locks, moving the captured token to
    // previousRefreshToken. Logout resumes, re-checks that locked row, and
    // revokes the same session using the previous credential.
    let reachedLookup!: () => void;
    let resumeLookup!: () => void;
    const atLookup = new Promise<void>((resolve) => { reachedLookup = resolve; });
    const resume = new Promise<void>((resolve) => { resumeLookup = resolve; });
    const originalFindFirst = app.prisma.session.findFirst.bind(app.prisma.session);
    const lookup = vi.spyOn(app.prisma.session, 'findFirst').mockImplementationOnce((async (...args: unknown[]) => {
      const found = await originalFindFirst(...(args as [Parameters<typeof originalFindFirst>[0]]));
      reachedLookup();
      await resume;
      return found;
    }) as never);
    const socketRoom = vi.spyOn(app.io, 'in');

    let rotated!: { accessToken: string; refreshToken: string };
    let logoutResponse!: Awaited<ReturnType<typeof app.inject>>;
    let disconnectedSessionRoom = false;
    try {
      const logoutPromise = inject('POST', '/api/v1/auth/logout/refresh', {
        refreshToken: captured.refreshToken,
        pushToken,
      });
      await atLookup;
      const refreshResponse = await inject('POST', '/api/v1/auth/refresh', {
        refreshToken: captured.refreshToken,
      });
      expect(refreshResponse.statusCode).toBe(200);
      rotated = refreshResponse.json().data;
      resumeLookup();
      logoutResponse = await logoutPromise;
      disconnectedSessionRoom = socketRoom.mock.calls.some(([room]) => room === `session:${session.id}`);
    } finally {
      resumeLookup();
      lookup.mockRestore();
      socketRoom.mockRestore();
    }

    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json()).toEqual({ success: true });
    expect(disconnectedSessionRoom).toBe(true);
    const [afterRider, afterDriver, reassignedPush, deletedSession] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: profiles.rider.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: profiles.driver.id } }),
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token: pushToken } }),
      app.prisma.session.findUnique({ where: { id: session.id } }),
    ]);
    expect(afterRider.locationSessionId).toBeNull();
    expect(afterDriver.locationSessionId).toBeNull();
    expect({ userId: reassignedPush.userId, isActive: reassignedPush.isActive }).toEqual({
      userId: otherUser.id,
      isActive: true,
    });
    expect(deletedSession).toBeNull();

    const invalidated = await Promise.all([
      inject('POST', '/api/v1/auth/logout', {}, captured.accessToken),
      inject('POST', '/api/v1/auth/logout', {}, rotated.accessToken),
      inject('POST', '/api/v1/auth/refresh', { refreshToken: captured.refreshToken }),
      inject('POST', '/api/v1/auth/refresh', { refreshToken: rotated.refreshToken }),
    ]);
    expect(invalidated.map((response) => response.statusCode)).toEqual([401, 401, 401, 401]);
  });

  it('logout invalidates the access token immediately (SEC-8 regression)', async () => {
    const login = await loginWithOtp(app, MOVER_PHONE);
    const token = login.json().data.tokens.accessToken;
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } });
    const pushToken = 'ExponentPushToken[auth-current-owner]';
    await app.prisma.deviceToken.upsert({
      where: { token: pushToken },
      create: { token: pushToken, userId: user.id, platform: 'android', isActive: true },
      update: { userId: user.id, platform: 'android', isActive: true },
    });

    const out = await inject('POST', '/api/v1/auth/logout', { pushToken }, token);
    expect(out.statusCode).toBe(200);
    expect((await app.prisma.deviceToken.findUniqueOrThrow({ where: { token: pushToken } })).isActive).toBe(false);

    const replay = await inject('POST', '/api/v1/auth/logout', {}, token);
    expect(replay.statusCode).toBe(401);
  });

  it('revokes only its location generation and cannot deactivate a push token reassigned to another account', async () => {
    const firstLogin = await loginWithOtp(app, MOVER_PHONE);
    const ownerLogin = await loginWithOtp(app, MOVER_PHONE);
    expect(firstLogin.statusCode).toBe(200);
    expect(ownerLogin.statusCode).toBe(200);
    const firstToken = firstLogin.json().data.tokens.accessToken as string;
    const ownerToken = ownerLogin.json().data.tokens.accessToken as string;
    const [user, otherUser, firstSession, ownerSession] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } }),
      app.prisma.user.findUniqueOrThrow({ where: { phone: VENDOR_PHONE } }),
      app.prisma.session.findUniqueOrThrow({ where: { token: firstToken } }),
      app.prisma.session.findUniqueOrThrow({ where: { token: ownerToken } }),
    ]);
    const profiles = await ensureMoverProfiles(user.id);
    await Promise.all([
      app.prisma.rider.update({
        where: { id: profiles.rider.id },
        data: { locationSessionId: ownerSession.id, isOnline: true, isAvailable: true },
      }),
      app.prisma.driver.update({
        where: { id: profiles.driver.id },
        data: { locationSessionId: ownerSession.id, isOnline: true, isAvailable: true },
      }),
    ]);

    const pushToken = 'ExponentPushToken[auth-account-reassignment]';
    await app.prisma.deviceToken.upsert({
      where: { token: pushToken },
      create: { token: pushToken, userId: user.id, platform: 'ios', isActive: true },
      update: { userId: user.id, platform: 'ios', isActive: true },
    });
    // Account B signs in on the same phone before account A's captured logout
    // reaches the API. A may revoke only rows it still owns.
    await app.prisma.deviceToken.update({
      where: { token: pushToken },
      data: { userId: otherUser.id, isActive: true },
    });

    const firstLogout = await inject('POST', '/api/v1/auth/logout', { pushToken }, firstToken);
    expect(firstLogout.statusCode).toBe(200);
    const [afterFirstRider, afterFirstDriver, reassignedPush, firstSessionAfter, ownerSessionAfter] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: profiles.rider.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: profiles.driver.id } }),
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token: pushToken } }),
      app.prisma.session.findUnique({ where: { id: firstSession.id } }),
      app.prisma.session.findUnique({ where: { id: ownerSession.id } }),
    ]);
    expect(afterFirstRider.locationSessionId).toBe(ownerSession.id);
    expect(afterFirstDriver.locationSessionId).toBe(ownerSession.id);
    expect({
      riderOnline: afterFirstRider.isOnline,
      riderAvailable: afterFirstRider.isAvailable,
      driverOnline: afterFirstDriver.isOnline,
      driverAvailable: afterFirstDriver.isAvailable,
    }).toEqual({
      riderOnline: true,
      riderAvailable: true,
      driverOnline: true,
      driverAvailable: true,
    });
    expect({ userId: reassignedPush.userId, isActive: reassignedPush.isActive }).toEqual({
      userId: otherUser.id,
      isActive: true,
    });
    expect(firstSessionAfter).toBeNull();
    expect(ownerSessionAfter).not.toBeNull();

    // Omitted body remains compatible, and revoking the actual owner clears
    // both mover profile generations.
    const ownerLogout = await inject('POST', '/api/v1/auth/logout', undefined, ownerToken);
    expect(ownerLogout.statusCode).toBe(200);
    const [afterOwnerRider, afterOwnerDriver] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: profiles.rider.id } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: profiles.driver.id } }),
    ]);
    expect({
      riderOwner: afterOwnerRider.locationSessionId,
      riderOnline: afterOwnerRider.isOnline,
      riderAvailable: afterOwnerRider.isAvailable,
      driverOwner: afterOwnerDriver.locationSessionId,
      driverOnline: afterOwnerDriver.isOnline,
      driverAvailable: afterOwnerDriver.isAvailable,
    }).toEqual({
      riderOwner: null,
      riderOnline: false,
      riderAvailable: false,
      driverOwner: null,
      driverOnline: false,
      driverAvailable: false,
    });
  });

  it('clears the owning mover generation when refresh-token reuse revokes that session', async () => {
    const previousGrace = process.env['REFRESH_REUSE_GRACE_MS'];
    process.env['REFRESH_REUSE_GRACE_MS'] = '0';
    try {
      const login = await loginWithOtp(app, MOVER_PHONE);
      expect(login.statusCode).toBe(200);
      const tokens = login.json().data.tokens as { accessToken: string; refreshToken: string };
      const session = await app.prisma.session.findUniqueOrThrow({ where: { token: tokens.accessToken } });
      const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } });
      const profiles = await ensureMoverProfiles(user.id);
      await Promise.all([
        app.prisma.rider.update({
          where: { id: profiles.rider.id },
          data: { locationSessionId: session.id },
        }),
        app.prisma.driver.update({
          where: { id: profiles.driver.id },
          data: { locationSessionId: session.id },
        }),
      ]);

      const rotate = await inject('POST', '/api/v1/auth/refresh', { refreshToken: tokens.refreshToken });
      expect(rotate.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const replay = await inject('POST', '/api/v1/auth/refresh', { refreshToken: tokens.refreshToken });
      expect(replay.statusCode).toBe(401);

      const [rider, driver, revoked] = await Promise.all([
        app.prisma.rider.findUniqueOrThrow({ where: { id: profiles.rider.id } }),
        app.prisma.driver.findUniqueOrThrow({ where: { id: profiles.driver.id } }),
        app.prisma.session.findUnique({ where: { id: session.id } }),
      ]);
      expect(rider.locationSessionId).toBeNull();
      expect(driver.locationSessionId).toBeNull();
      expect(revoked).toBeNull();
    } finally {
      if (previousGrace === undefined) delete process.env['REFRESH_REUSE_GRACE_MS'];
      else process.env['REFRESH_REUSE_GRACE_MS'] = previousGrace;
    }
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

  it('uses current server role immediately after SUPER_ADMIN switches to customer', async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: ROLE_AUTHORITY_PHONE,
        firstName: 'Role',
        lastName: 'Authority',
        roles: ['SUPER_ADMIN', 'CUSTOMER'],
        activeRole: 'SUPER_ADMIN',
        status: 'ACTIVE',
        isPhoneVerified: true,
      },
    });
    const token = app.jwt.sign({
      userId: user.id,
      role: 'SUPER_ADMIN',
      jti: nanoid(8),
    });
    const session = await app.prisma.session.create({
      data: {
        userId: user.id,
        token,
        refreshToken: nanoid(64),
        authMethod: 'OTP',
        deviceId: 'role-authority-test',
        deviceType: 'test',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    const before = await inject('GET', '/api/v1/admin/dashboard/overview', undefined, token);
    expect(before.statusCode).toBe(200);

    const switched = await inject(
      'POST',
      '/api/v1/customer/switch-role',
      { role: 'CUSTOMER' },
      token,
    );
    expect(switched.statusCode).toBe(200);
    expect(switched.json().data.activeRole).toBe('CUSTOMER');

    // The same still-live token contains SUPER_ADMIN, but its stale claim is
    // no longer authority for the very next protected request.
    const after = await inject('GET', '/api/v1/admin/dashboard/overview', undefined, token);
    expect(after.statusCode).toBe(403);
    expect(await app.prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
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

  it('switching away from an idle mover atomically removes them from dispatch supply', async () => {
    const login = await loginWithOtp(app, MOVER_PHONE);
    const token = login.json().data.tokens.accessToken;
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } });
    const rider = await app.prisma.rider.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        documentsVerified: true,
        isOnline: true,
        isAvailable: true,
      },
      update: {
        currentOrderId: null,
        isOnline: true,
        isAvailable: true,
      },
    });

    const switched = await inject('POST', '/api/v1/customer/switch-role', { role: 'CUSTOMER' }, token);
    expect(switched.statusCode).toBe(200);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect({ online: after.isOnline, available: after.isAvailable }).toEqual({
      online: false,
      available: false,
    });
  });

  it('resolves generic MOVER to the durable Rider/Driver choice in shared authority', async () => {
    const login = await loginWithOtp(app, MOVER_PHONE);
    const token = login.json().data.tokens.accessToken;
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } });
    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: user.id } });
    const driver = await app.prisma.driver.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        vehicleMake: 'Toyota',
        vehicleModel: 'Allion',
        vehicleYear: 2020,
        vehicleColor: 'Silver',
        licensePlate: 'ROLE-MEMORY',
        driverLicenseUrl: 'verified',
        vehicleInsuranceUrl: 'verified',
        documentsVerified: true,
        isOnline: true,
        isAvailable: true,
      },
      update: { currentRideId: null, isOnline: true, isAvailable: true },
    });

    try {
      await app.prisma.user.update({
        where: { id: user.id },
        data: {
          roles: ['CUSTOMER', 'MOVER', 'RIDER', 'DRIVER'],
          activeRole: 'CUSTOMER',
          lastMoverRole: 'RIDER',
        },
      });
      const toRider = await inject('POST', '/api/v1/customer/switch-role', { role: 'MOVER' }, token);
      expect(toRider.statusCode).toBe(200);
      expect(toRider.json().data).toMatchObject({
        role: 'MOVER',
        activeRole: 'RIDER',
        lastMoverRole: 'RIDER',
      });
      expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).isOnline)
        .toBe(false);

      await Promise.all([
        app.prisma.user.update({
          where: { id: user.id },
          data: { activeRole: 'CUSTOMER', lastMoverRole: 'DRIVER' },
        }),
        app.prisma.rider.update({
          where: { id: rider.id },
          data: { currentOrderId: null, isOnline: true, isAvailable: true },
        }),
      ]);
      const toDriver = await inject('POST', '/api/v1/customer/switch-role', { role: 'MOVER' }, token);
      expect(toDriver.statusCode).toBe(200);
      expect(toDriver.json().data).toMatchObject({
        role: 'MOVER',
        activeRole: 'DRIVER',
        lastMoverRole: 'DRIVER',
      });
      expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).isOnline)
        .toBe(false);
    } finally {
      await app.prisma.driver.deleteMany({ where: { id: driver.id } });
      await app.prisma.rider.update({
        where: { id: rider.id },
        data: { currentOrderId: null, isOnline: false, isAvailable: false },
      });
      await app.prisma.user.update({
        where: { id: user.id },
        data: {
          roles: ['MOVER', 'CUSTOMER'],
          activeRole: 'MOVER',
          lastMoverRole: null,
        },
      });
    }
  });

  it('keeps an active mover in the mover app instead of marooning their job', async () => {
    const login = await loginWithOtp(app, MOVER_PHONE);
    const token = login.json().data.tokens.accessToken;
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: MOVER_PHONE } });
    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: user.id } });
    await inject('POST', '/api/v1/customer/switch-role', { role: 'MOVER' }, token);
    await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: true, isAvailable: false, currentOrderId: 'active-role-switch-job' },
    });

    const blocked = await inject('POST', '/api/v1/customer/switch-role', { role: 'CUSTOMER' }, token);
    expect(blocked.statusCode).toBe(409);
    const [afterUser, afterRider] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }),
    ]);
    expect(afterUser.activeRole).toBe('MOVER');
    expect(afterRider.isOnline).toBe(true);

    await app.prisma.rider.update({
      where: { id: rider.id },
      data: { currentOrderId: null, isOnline: false, isAvailable: false },
    });
  });
});
