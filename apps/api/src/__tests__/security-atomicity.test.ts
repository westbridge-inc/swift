import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { requestOtp } from './helpers/otp';

const ADMIN_PHONE = '+5927009190';
const RESET_PHONE = '+5927009191';
const SUSPEND_PHONE = '+5927009192';
const BAN_PHONE = '+5927009193';
const PASSWORD_RACE_PHONE = '+5927009194';
const CONCURRENT_FAILURE_PHONE = '+5927009195';
const WRONG_PASSWORD_RESET_RACE_PHONE = '+5927009196';
const SUSPENDED_LOGIN_PHONE = '+5927009197';
const BANNED_LOGIN_PHONE = '+5927009198';
const DEACTIVATED_LOGIN_PHONE = '+5927009199';
const STATUS_RACE_LOGIN_PHONE = '+5927009189';
const SET_PASSWORD_RESET_RACE_PHONE = '+5927009188';
const TEST_PHONES = [
  ADMIN_PHONE,
  RESET_PHONE,
  SUSPEND_PHONE,
  BAN_PHONE,
  PASSWORD_RACE_PHONE,
  CONCURRENT_FAILURE_PHONE,
  WRONG_PASSWORD_RESET_RACE_PHONE,
  SUSPENDED_LOGIN_PHONE,
  BANNED_LOGIN_PHONE,
  DEACTIVATED_LOGIN_PHONE,
  STATUS_RACE_LOGIN_PHONE,
  SET_PASSWORD_RESET_RACE_PHONE,
];
const OLD_PASSWORD = 'old-atomicity-password';
const NEW_PASSWORD = 'new-atomicity-password';

interface MoverFixture {
  userId: string;
  riderId: string;
  ownerSessionId: string;
  sessionIds: string[];
  deviceToken: string;
  passwordHash: string;
  lockedUntil: Date;
}

let app: FastifyInstance;
let adminToken: string;
let sequence = 0;

function transactionClientWithFailure(
  transactionClient: any,
  delegateName: string,
  methodName: string,
  failure: Error,
) {
  return new Proxy(transactionClient, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === delegateName) {
        return new Proxy(value, {
          get(delegate, delegateProperty) {
            if (delegateProperty === methodName) {
              return async () => { throw failure; };
            }
            const delegateValue = Reflect.get(delegate, delegateProperty, delegate);
            return typeof delegateValue === 'function'
              ? delegateValue.bind(delegate)
              : delegateValue;
          },
        });
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Run the next real interactive transaction with one delegate method replaced
 * by a deterministic fault. PostgreSQL still owns begin/commit/rollback, so
 * these tests prove actual rollback rather than mocked call ordering. */
function failNextTransactionDelegate(
  delegateName: string,
  methodName: string,
  message: string,
) {
  const originalTransaction = app.prisma.$transaction.bind(app.prisma) as (...args: any[]) => any;
  return vi.spyOn(app.prisma, '$transaction').mockImplementationOnce(((operation: any, options?: any) => {
    if (typeof operation !== 'function') return originalTransaction(operation, options);
    return originalTransaction(
      (tx: any) => operation(transactionClientWithFailure(
        tx,
        delegateName,
        methodName,
        new Error(message),
      )),
      options,
    );
  }) as never);
}

async function cleanupFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { in: TEST_PHONES } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  if (userIds.length > 0) {
    await app.prisma.auditLog.deleteMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          { entity: 'User', entityId: { in: userIds } },
        ],
      },
    });
    await app.prisma.moverRevocationOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

async function createSession(userId: string, role: 'CUSTOMER' | 'MOVER' | 'SUPER_ADMIN') {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  return app.prisma.session.create({
    data: {
      userId,
      token,
      refreshToken: nanoid(64),
      authMethod: role === 'SUPER_ADMIN' ? 'OTP' : 'LEGACY',
      deviceId: `atomicity-device-${nanoid(6)}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
}

async function createMoverFixture(phone: string): Promise<MoverFixture> {
  sequence += 1;
  const passwordHash = await bcrypt.hash(OLD_PASSWORD, 4);
  const lockedUntil = new Date(Date.now() + 15 * 60_000);
  const user = await app.prisma.user.create({
    data: {
      phone,
      firstName: 'Atomicity',
      lastName: `Mover${sequence}`,
      roles: ['MOVER', 'CUSTOMER'],
      activeRole: 'MOVER',
      status: 'ACTIVE',
      isPhoneVerified: true,
      passwordHash,
      failedLoginAttempts: 4,
      lockedUntil,
    },
  });
  const [ownerSession, otherSession] = await Promise.all([
    createSession(user.id, 'MOVER'),
    createSession(user.id, 'MOVER'),
  ]);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      isAvailable: true,
      locationSessionId: ownerSession.id,
    },
  });
  const deviceToken = `ExponentPushToken[security-atomicity-${sequence}]`;
  await app.prisma.deviceToken.create({
    data: { userId: user.id, token: deviceToken, platform: 'ios', isActive: true },
  });
  return {
    userId: user.id,
    riderId: rider.id,
    ownerSessionId: ownerSession.id,
    sessionIds: [ownerSession.id, otherSession.id],
    deviceToken,
    passwordHash,
    lockedUntil,
  };
}

async function createPasswordUser(
  phone: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED' = 'ACTIVE',
) {
  sequence += 1;
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Atomicity',
      lastName: `Password${sequence}`,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status,
      isPhoneVerified: true,
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 4),
    },
  });
}

function passwordLogin(phone: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/password/login',
    payload: { phone, password },
    headers: { 'content-type': 'application/json' },
  });
}

async function resetPassword(phone: string, newPassword = NEW_PASSWORD) {
  const code = await requestOtp(app, phone);
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/password/reset',
    payload: { phone, code, newPassword },
    headers: { 'content-type': 'application/json' },
  });
}

async function expectResetStateUnchanged(fixture: MoverFixture) {
  const [user, sessions, token, rider, outboxes] = await Promise.all([
    app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
    app.prisma.session.findMany({ where: { userId: fixture.userId }, select: { id: true } }),
    app.prisma.deviceToken.findUniqueOrThrow({ where: { token: fixture.deviceToken } }),
    app.prisma.rider.findUniqueOrThrow({ where: { id: fixture.riderId } }),
    app.prisma.moverRevocationOutbox.count({ where: { userId: fixture.userId } }),
  ]);
  expect(user.passwordHash).toBe(fixture.passwordHash);
  expect(user.failedLoginAttempts).toBe(4);
  expect(user.lockedUntil?.getTime()).toBe(fixture.lockedUntil.getTime());
  expect(sessions.map((session) => session.id).sort()).toEqual([...fixture.sessionIds].sort());
  expect(token.isActive).toBe(true);
  expect({
    owner: rider.locationSessionId,
    online: rider.isOnline,
    available: rider.isAvailable,
  }).toEqual({ owner: fixture.ownerSessionId, online: true, available: true });
  expect(outboxes).toBe(0);
}

async function putAdminStatus(
  userId: string,
  action: 'suspend' | 'ban',
  reason: string,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/admin/users/${userId}/${action}`,
    payload: { reason },
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
      'user-agent': 'swift-security-atomicity-test',
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await cleanupFixtures();

  const admin = await app.prisma.user.create({
    data: {
      phone: ADMIN_PHONE,
      firstName: 'Atomicity',
      lastName: 'Admin',
      roles: ['SUPER_ADMIN', 'CUSTOMER'],
      activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE',
      isPhoneVerified: true,
    },
  });
  adminToken = (await createSession(admin.id, 'SUPER_ADMIN')).token;
});

afterAll(async () => {
  await cleanupFixtures();
  await app.close();
});

describe('password-login security transaction', () => {
  it('serializes concurrent wrong-password failures without losing an attempt', async () => {
    const user = await createPasswordUser(CONCURRENT_FAILURE_PHONE);

    let comparisons = 0;
    let bothComparisonsReached!: () => void;
    let resumeComparisons!: () => void;
    const atBothComparisons = new Promise<void>((resolve) => { bothComparisonsReached = resolve; });
    const resume = new Promise<void>((resolve) => { resumeComparisons = resolve; });
    const comparePassword = bcrypt.compare as (plain: string, hash: string) => Promise<boolean>;
    const originalCompare = comparePassword.bind(bcrypt);
    const comparison = vi.spyOn(bcrypt, 'compare').mockImplementation((async (
      plain: string,
      hash: string,
    ) => {
      const matches = await originalCompare(plain, hash);
      comparisons += 1;
      if (comparisons === 2) bothComparisonsReached();
      await resume;
      return matches;
    }) as never);

    let attempts!: Awaited<ReturnType<typeof passwordLogin>>[];
    try {
      const pending = [
        passwordLogin(CONCURRENT_FAILURE_PHONE, 'wrong-concurrent-password-a'),
        passwordLogin(CONCURRENT_FAILURE_PHONE, 'wrong-concurrent-password-b'),
      ];
      await atBothComparisons;
      resumeComparisons();
      attempts = await Promise.all(pending);
    } finally {
      resumeComparisons();
      comparison.mockRestore();
    }

    expect(attempts.map((attempt) => attempt.statusCode)).toEqual([401, 401]);
    const persisted = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect({ failed: persisted.failedLoginAttempts, locked: persisted.lockedUntil }).toEqual({
      failed: 2,
      locked: null,
    });
  });

  it.each([
    ['SUSPENDED', SUSPENDED_LOGIN_PHONE],
    ['BANNED', BANNED_LOGIN_PHONE],
    ['DEACTIVATED', DEACTIVATED_LOGIN_PHONE],
  ] as const)('does not mint a password session for a %s account', async (status, phone) => {
    const user = await createPasswordUser(phone, status);

    const login = await passwordLogin(phone, OLD_PASSWORD);

    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('revalidates blocked status under the lock after a successful comparison', async () => {
    const user = await createPasswordUser(STATUS_RACE_LOGIN_PHONE);

    let comparisonReached!: () => void;
    let resumeComparison!: () => void;
    const atComparison = new Promise<void>((resolve) => { comparisonReached = resolve; });
    const resume = new Promise<void>((resolve) => { resumeComparison = resolve; });
    const comparePassword = bcrypt.compare as (plain: string, hash: string) => Promise<boolean>;
    const originalCompare = comparePassword.bind(bcrypt);
    const comparison = vi.spyOn(bcrypt, 'compare').mockImplementationOnce((async (
      plain: string,
      hash: string,
    ) => {
      const matches = await originalCompare(plain, hash);
      comparisonReached();
      await resume;
      return matches;
    }) as never);

    let login!: Awaited<ReturnType<typeof passwordLogin>>;
    try {
      const pendingLogin = passwordLogin(STATUS_RACE_LOGIN_PHONE, OLD_PASSWORD);
      await atComparison;
      await app.prisma.user.update({
        where: { id: user.id },
        data: { status: 'BANNED' },
      });
      resumeComparison();
      login = await pendingLogin;
    } finally {
      resumeComparison();
      comparison.mockRestore();
    }

    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('password-reset security transaction', () => {
  it('does not let a previously authenticated password change overwrite a completed recovery', async () => {
    const user = await createPasswordUser(SET_PASSWORD_RESET_RACE_PHONE);
    const session = await createSession(user.id, 'CUSTOMER');
    const attackerPassword = 'attacker-chosen-password';

    let passwordHashReached!: () => void;
    let resumePasswordHash!: () => void;
    const atPasswordHash = new Promise<void>((resolve) => { passwordHashReached = resolve; });
    const resume = new Promise<void>((resolve) => { resumePasswordHash = resolve; });
    const hashPassword = bcrypt.hash as (plain: string, rounds: number) => Promise<string>;
    const originalHash = hashPassword.bind(bcrypt);
    const hashing = vi.spyOn(bcrypt, 'hash').mockImplementation((async (
      plain: string,
      rounds: number,
    ) => {
      const hash = await originalHash(plain, rounds);
      if (plain === attackerPassword) {
        passwordHashReached();
        await resume;
      }
      return hash;
    }) as never);

    let staleChange!: Awaited<ReturnType<typeof app.inject>>;
    try {
      const pendingChange = app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/set',
        payload: { password: attackerPassword },
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': 'application/json',
        },
      });
      await atPasswordHash;
      const reset = await resetPassword(SET_PASSWORD_RESET_RACE_PHONE);
      expect(reset.statusCode).toBe(200);
      resumePasswordHash();
      staleChange = await pendingChange;
    } finally {
      resumePasswordHash();
      hashing.mockRestore();
    }

    expect(staleChange.statusCode).toBe(401);
    expect(staleChange.json().error.code).toBe('UNAUTHORIZED');
    const [persisted, sessions] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      app.prisma.session.count({ where: { userId: user.id } }),
    ]);
    expect(await bcrypt.compare(NEW_PASSWORD, persisted.passwordHash!)).toBe(true);
    expect(await bcrypt.compare(attackerPassword, persisted.passwordHash!)).toBe(false);
    expect(sessions).toBe(0);
  });

  it('rolls password, mover authority, outbox, sessions, and device tokens back on every revocation-tail failure', async () => {
    const fixture = await createMoverFixture(RESET_PHONE);

    // The durable outbox itself fails after the new password and mover state
    // have been written inside the transaction.
    let code = await requestOtp(app, RESET_PHONE);
    let fault = failNextTransactionDelegate(
      'moverRevocationOutbox',
      'upsert',
      'injected outbox persistence failure',
    );
    try {
      const failed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/reset',
        payload: { phone: RESET_PHONE, code, newPassword: NEW_PASSWORD },
        headers: { 'content-type': 'application/json' },
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      fault.mockRestore();
    }
    await expectResetStateUnchanged(fixture);

    // A tail write fails after the outbox and session deletion have executed.
    // The inserted outbox row must roll back with every other security write.
    code = await requestOtp(app, RESET_PHONE);
    fault = failNextTransactionDelegate(
      'deviceToken',
      'updateMany',
      'injected device revocation failure',
    );
    try {
      const failed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/reset',
        payload: { phone: RESET_PHONE, code, newPassword: NEW_PASSWORD },
        headers: { 'content-type': 'application/json' },
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      fault.mockRestore();
    }
    await expectResetStateUnchanged(fixture);

    const retry = await resetPassword(RESET_PHONE);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({
      success: true,
      data: { message: 'Password reset. All sessions logged out.' },
    });

    const [user, sessions, token, rider, outboxes] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
      app.prisma.session.count({ where: { userId: fixture.userId } }),
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token: fixture.deviceToken } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: fixture.riderId } }),
      app.prisma.moverRevocationOutbox.findMany({ where: { userId: fixture.userId } }),
    ]);
    expect(await bcrypt.compare(NEW_PASSWORD, user.passwordHash!)).toBe(true);
    expect({ failed: user.failedLoginAttempts, locked: user.lockedUntil }).toEqual({
      failed: 0,
      locked: null,
    });
    expect(sessions).toBe(0);
    expect(token.isActive).toBe(false);
    expect({ owner: rider.locationSessionId, online: rider.isOnline, available: rider.isAvailable })
      .toEqual({ owner: null, online: false, available: false });
    expect(outboxes).toHaveLength(1);
  });

  it('does not let an in-flight old-password comparison mint a session after reset', async () => {
    const fixture = await createMoverFixture(PASSWORD_RACE_PHONE);
    await app.prisma.user.update({
      where: { id: fixture.userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    let comparisonReached!: () => void;
    let resumeComparison!: () => void;
    const atComparison = new Promise<void>((resolve) => { comparisonReached = resolve; });
    const resume = new Promise<void>((resolve) => { resumeComparison = resolve; });
    const comparePassword = bcrypt.compare as (plain: string, hash: string) => Promise<boolean>;
    const originalCompare = comparePassword.bind(bcrypt);
    const comparison = vi.spyOn(bcrypt, 'compare').mockImplementationOnce((async (
      plain: string,
      hash: string,
    ) => {
      const matches = await originalCompare(plain, hash);
      comparisonReached();
      await resume;
      return matches;
    }) as never);

    let oldPasswordLogin!: Awaited<ReturnType<typeof app.inject>>;
    try {
      const pendingLogin = app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/login',
        payload: { phone: PASSWORD_RACE_PHONE, password: OLD_PASSWORD },
        headers: { 'content-type': 'application/json' },
      });
      await atComparison;
      const reset = await resetPassword(PASSWORD_RACE_PHONE);
      expect(reset.statusCode).toBe(200);
      resumeComparison();
      oldPasswordLogin = await pendingLogin;
    } finally {
      resumeComparison();
      comparison.mockRestore();
    }

    expect(oldPasswordLogin.statusCode).toBe(401);
    expect(oldPasswordLogin.json().error.code).toBe('INVALID_CREDENTIALS');
    const [user, sessions] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
      app.prisma.session.count({ where: { userId: fixture.userId } }),
    ]);
    expect(await bcrypt.compare(NEW_PASSWORD, user.passwordHash!)).toBe(true);
    expect(sessions).toBe(0);
  });

  it('does not let an in-flight wrong-password comparison dirty a completed reset', async () => {
    const fixture = await createMoverFixture(WRONG_PASSWORD_RESET_RACE_PHONE);
    await app.prisma.user.update({
      where: { id: fixture.userId },
      data: { failedLoginAttempts: 4, lockedUntil: null },
    });

    let comparisonReached!: () => void;
    let resumeComparison!: () => void;
    const atComparison = new Promise<void>((resolve) => { comparisonReached = resolve; });
    const resume = new Promise<void>((resolve) => { resumeComparison = resolve; });
    const comparePassword = bcrypt.compare as (plain: string, hash: string) => Promise<boolean>;
    const originalCompare = comparePassword.bind(bcrypt);
    const comparison = vi.spyOn(bcrypt, 'compare').mockImplementationOnce((async (
      plain: string,
      hash: string,
    ) => {
      const matches = await originalCompare(plain, hash);
      comparisonReached();
      await resume;
      return matches;
    }) as never);

    let wrongPasswordLogin!: Awaited<ReturnType<typeof passwordLogin>>;
    try {
      const pendingLogin = passwordLogin(
        WRONG_PASSWORD_RESET_RACE_PHONE,
        'wrong-password-before-reset',
      );
      await atComparison;
      const reset = await resetPassword(WRONG_PASSWORD_RESET_RACE_PHONE);
      expect(reset.statusCode).toBe(200);
      resumeComparison();
      wrongPasswordLogin = await pendingLogin;
    } finally {
      resumeComparison();
      comparison.mockRestore();
    }

    expect(wrongPasswordLogin.statusCode).toBe(401);
    expect(wrongPasswordLogin.json().error.code).toBe('INVALID_CREDENTIALS');
    const [user, sessions] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
      app.prisma.session.count({ where: { userId: fixture.userId } }),
    ]);
    expect(await bcrypt.compare(NEW_PASSWORD, user.passwordHash!)).toBe(true);
    expect({ failed: user.failedLoginAttempts, locked: user.lockedUntil }).toEqual({
      failed: 0,
      locked: null,
    });
    expect(sessions).toBe(0);
  });
});

describe('admin status evidence transaction', () => {
  it('rolls a suspension back when its required audit fails, then retries once with complete evidence', async () => {
    const fixture = await createMoverFixture(SUSPEND_PHONE);
    const reason = 'identity review required';
    const fault = failNextTransactionDelegate('auditLog', 'create', 'injected suspend audit failure');
    try {
      const failed = await putAdminStatus(fixture.userId, 'suspend', reason);
      expect(failed.statusCode).toBe(500);
    } finally {
      fault.mockRestore();
    }

    const [failedUser, failedRider, failedAudit] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: fixture.riderId } }),
      app.prisma.auditLog.count({
        where: { action: 'SUSPEND_USER', entity: 'User', entityId: fixture.userId },
      }),
    ]);
    expect(failedUser.status).toBe('ACTIVE');
    expect({ online: failedRider.isOnline, available: failedRider.isAvailable })
      .toEqual({ online: true, available: true });
    expect(failedAudit).toBe(0);

    const retry = await putAdminStatus(fixture.userId, 'suspend', reason);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.status).toBe('SUSPENDED');
    const audits = await app.prisma.auditLog.findMany({
      where: { action: 'SUSPEND_USER', entity: 'User', entityId: fixture.userId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userAgent: 'swift-security-atomicity-test',
      changes: { reason, previousStatus: 'ACTIVE' },
    });
  });

  it('rolls status, sessions, tokens, and mover supply back when ban evidence fails, then commits exactly once on retry', async () => {
    const fixture = await createMoverFixture(BAN_PHONE);
    const reason = 'confirmed account takeover';
    const fault = failNextTransactionDelegate('auditLog', 'create', 'injected ban audit failure');
    try {
      const failed = await putAdminStatus(fixture.userId, 'ban', reason);
      expect(failed.statusCode).toBe(500);
    } finally {
      fault.mockRestore();
    }

    const [failedUser, failedRider, failedSessions, failedToken, failedAudit] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: fixture.riderId } }),
      app.prisma.session.count({ where: { userId: fixture.userId } }),
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token: fixture.deviceToken } }),
      app.prisma.auditLog.count({
        where: { action: 'BAN_USER', entity: 'User', entityId: fixture.userId },
      }),
    ]);
    expect(failedUser.status).toBe('ACTIVE');
    expect({ online: failedRider.isOnline, available: failedRider.isAvailable })
      .toEqual({ online: true, available: true });
    expect(failedSessions).toBe(fixture.sessionIds.length);
    expect(failedToken.isActive).toBe(true);
    expect(failedAudit).toBe(0);

    const retry = await putAdminStatus(fixture.userId, 'ban', reason);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.status).toBe('BANNED');
    const [user, rider, sessions, token, audits] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: fixture.riderId } }),
      app.prisma.session.count({ where: { userId: fixture.userId } }),
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token: fixture.deviceToken } }),
      app.prisma.auditLog.findMany({
        where: { action: 'BAN_USER', entity: 'User', entityId: fixture.userId },
      }),
    ]);
    expect(user.status).toBe('BANNED');
    expect({ online: rider.isOnline, available: rider.isAvailable })
      .toEqual({ online: false, available: false });
    expect(sessions).toBe(0);
    expect(token.isActive).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userAgent: 'swift-security-atomicity-test',
      changes: { reason, previousStatus: 'ACTIVE' },
    });
  });
});
