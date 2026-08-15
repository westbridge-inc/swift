import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { loginWithOtp } from './helpers/otp';

const PRIVILEGED_PHONE = '+5920003371';
const PROMOTION_RACE_PHONE = '+5920003372';
const CUSTOMER_PHONE = '+5920003373';
const LEGACY_ADMIN_PHONE = '+5920003374';
const ACTIVE_ROLE_DRIFT_PHONE = '+5920003375';
const CONCURRENT_PROMOTION_PHONE = '+5920003376';
const LEGACY_CUSTOMER_PHONE = '+5920003377';
const PASSWORD = 'privileged-password-disabled';
const TEST_PHONES = [
  PRIVILEGED_PHONE,
  PROMOTION_RACE_PHONE,
  CUSTOMER_PHONE,
  LEGACY_ADMIN_PHONE,
  ACTIVE_ROLE_DRIFT_PHONE,
  CONCURRENT_PROMOTION_PHONE,
  LEGACY_CUSTOMER_PHONE,
];

let app: FastifyInstance;

async function cleanupFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { in: TEST_PHONES } },
    select: { id: true },
  });
  if (users.length > 0) {
    await app.prisma.moverRevocationOutbox.deleteMany({
      where: { userId: { in: users.map((user) => user.id) } },
    });
  }
  await app.prisma.user.deleteMany({
    where: { phone: { in: TEST_PHONES } },
  });
  await app.redis.del(...TEST_PHONES.flatMap((phone) => [
    `otp:${phone}`,
    `otp_rate:${phone}`,
    `otp_hr:${phone}`,
    `otp_attempt:${phone}`,
  ]));
}

function passwordLogin(phone: string, password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/password/login',
    payload: { phone, password },
    headers: { 'content-type': 'application/json' },
  });
}

function probe(accessToken: string) {
  return app.inject({
    method: 'GET',
    url: '/privileged-session-probe',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function refresh(refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refreshToken },
    headers: { 'content-type': 'application/json' },
  });
}

async function createLegacySession(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId,
      token,
      refreshToken: nanoid(64),
      deviceId: `legacy-${nanoid(8)}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
      // authMethod is deliberately omitted: the database default proves the
      // pre-cutover row behavior rather than merely spelling LEGACY in a test.
    },
  });
  expect(session.authMethod).toBe('LEGACY');
  return session;
}

function genericPasswordFailure(response: Awaited<ReturnType<typeof passwordLogin>>) {
  return {
    statusCode: response.statusCode,
    error: response.json().error,
  };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  app.get('/privileged-session-probe', { preHandler: [app.authenticate] }, async (request) => ({
    success: true,
    role: request.user.role,
    sessionId: request.authSessionId,
  }));
  await app.ready();
  await cleanupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
  await app.close();
});

describe('ADR-001 privileged password gate', () => {
  it('returns one generic failure for every privileged password attempt', async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: PRIVILEGED_PHONE,
        firstName: 'Privileged',
        lastName: 'Operator',
        roles: ['SUPER_ADMIN', 'CUSTOMER'],
        activeRole: 'SUPER_ADMIN',
        isPhoneVerified: true,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });

    const activeAdminCorrect = await passwordLogin(PRIVILEGED_PHONE);
    const activeAdminWrong = await passwordLogin(PRIVILEGED_PHONE, 'wrong-privileged-password');
    const expectedFailure = {
      statusCode: 401,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid phone/email or password',
      },
    };
    expect(genericPasswordFailure(activeAdminCorrect)).toEqual(expectedFailure);
    expect(genericPasswordFailure(activeAdminWrong)).toEqual(expectedFailure);

    // A privileged role cannot be hidden behind customer mode to obtain a
    // password-authenticated session that might later inherit live DB authority.
    await app.prisma.user.update({
      where: { id: user.id },
      data: { activeRole: 'CUSTOMER' },
    });
    const customerMode = await passwordLogin(PRIVILEGED_PHONE);
    expect(genericPasswordFailure(customerMode)).toEqual(expectedFailure);
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('mints PASSWORD assurance for a normal customer and preserves it through refresh', async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: CUSTOMER_PHONE,
        firstName: 'Password',
        lastName: 'Customer',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        isPhoneVerified: true,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });

    const login = await passwordLogin(CUSTOMER_PHONE);
    expect(login.statusCode).toBe(200);
    const tokens = login.json().data.tokens as { accessToken: string; refreshToken: string };
    const persisted = await app.prisma.session.findUniqueOrThrow({
      where: { token: tokens.accessToken },
    });
    expect(persisted.authMethod).toBe('PASSWORD');
    expect((await probe(tokens.accessToken)).statusCode).toBe(200);

    const rotated = await refresh(tokens.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const afterRefresh = await app.prisma.session.findUniqueOrThrow({ where: { id: persisted.id } });
    expect(afterRefresh.authMethod).toBe('PASSWORD');
    expect(afterRefresh.userId).toBe(user.id);
  });

  it('preserves the production admin phone-OTP path and creates a live server session', async () => {
    await app.prisma.user.update({
      where: { phone: PRIVILEGED_PHONE },
      data: { activeRole: 'SUPER_ADMIN' },
    });

    const login = await loginWithOtp(app, PRIVILEGED_PHONE);
    expect(login.statusCode).toBe(200);
    const tokens = login.json().data.tokens as { accessToken: string; refreshToken: string };

    const session = await app.prisma.session.findUniqueOrThrow({
      where: { token: tokens.accessToken },
    });
    expect(session.authMethod).toBe('OTP');

    const authorized = await probe(tokens.accessToken);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ success: true, role: 'SUPER_ADMIN' });
    expect(authorized.json().sessionId).toBeTruthy();

    const rotated = await refresh(tokens.refreshToken);
    expect(rotated.statusCode).toBe(200);
    expect((await app.prisma.session.findUniqueOrThrow({ where: { id: session.id } })).authMethod)
      .toBe('OTP');
  });

  it('revokes a pre-promotion PASSWORD session when privileged authority appears in roles', async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: CONCURRENT_PROMOTION_PHONE,
        firstName: 'Promoted',
        lastName: 'Password',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        isPhoneVerified: true,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    const login = await passwordLogin(CONCURRENT_PROMOTION_PHONE);
    const tokens = login.json().data.tokens as { accessToken: string; refreshToken: string };
    const session = await app.prisma.session.findUniqueOrThrow({
      where: { token: tokens.accessToken },
    });
    expect(session.authMethod).toBe('PASSWORD');

    await app.prisma.user.update({
      where: { id: user.id },
      data: { roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] }, activeRole: 'CUSTOMER' },
    });

    // Start both paths before awaiting either. The canonical User -> Session
    // locks must make concurrent revocation idempotent, never let one path mint
    // a privileged token, and leave no live session generation behind.
    const [access, rotate] = await Promise.all([
      probe(tokens.accessToken),
      refresh(tokens.refreshToken),
    ]);
    expect(access.statusCode).toBe(401);
    expect(access.json().error.code).toBe('UNAUTHORIZED');
    expect(rotate.statusCode).toBe(401);
    expect(rotate.json().error.code).toBe('INVALID_TOKEN');
    expect(await app.prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it('fails closed when activeRole is privileged even if the roles array is inconsistent', async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: ACTIVE_ROLE_DRIFT_PHONE,
        firstName: 'ActiveRole',
        lastName: 'Drift',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        isPhoneVerified: true,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    const login = await passwordLogin(ACTIVE_ROLE_DRIFT_PHONE);
    const refreshToken = login.json().data.tokens.refreshToken as string;
    const session = await app.prisma.session.findFirstOrThrow({ where: { userId: user.id } });

    // Bypass the normal role transition on purpose to characterize a repaired
    // or interrupted legacy row. The session gate must inspect both sources.
    await app.prisma.$executeRaw`
      UPDATE "users"
      SET "activeRole" = 'ADMIN'::"UserRole", "roles" = ARRAY['CUSTOMER']::"UserRole"[]
      WHERE "id" = ${user.id}
    `;

    const rotate = await refresh(refreshToken);
    expect(rotate.statusCode).toBe(401);
    expect(rotate.json().error.code).toBe('INVALID_TOKEN');
    expect(await app.prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it('revokes an existing LEGACY privileged session but keeps a legacy customer session valid', async () => {
    const [admin, customer] = await Promise.all([
      app.prisma.user.create({
        data: {
          phone: LEGACY_ADMIN_PHONE,
          firstName: 'Legacy',
          lastName: 'Admin',
          roles: ['ADMIN', 'CUSTOMER'],
          activeRole: 'ADMIN',
          isPhoneVerified: true,
        },
      }),
      app.prisma.user.create({
        data: {
          phone: LEGACY_CUSTOMER_PHONE,
          firstName: 'Legacy',
          lastName: 'Customer',
          roles: ['CUSTOMER'],
          activeRole: 'CUSTOMER',
          isPhoneVerified: true,
        },
      }),
    ]);
    const [adminSession, customerSession] = await Promise.all([
      createLegacySession(admin.id, 'ADMIN'),
      createLegacySession(customer.id, 'CUSTOMER'),
    ]);

    const [adminProbe, customerProbe] = await Promise.all([
      probe(adminSession.token),
      probe(customerSession.token),
    ]);
    expect(adminProbe.statusCode).toBe(401);
    expect(customerProbe.statusCode).toBe(200);
    expect(await app.prisma.session.findUnique({ where: { id: adminSession.id } })).toBeNull();
    expect(await app.prisma.session.findUnique({ where: { id: customerSession.id } })).not.toBeNull();
  });

  it('rechecks roles under the User lock after a paused password comparison', async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: PROMOTION_RACE_PHONE,
        firstName: 'Promotion',
        lastName: 'Race',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        isPhoneVerified: true,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });

    let comparisonReached!: () => void;
    let resumeComparison!: () => void;
    const atComparison = new Promise<void>((resolve) => { comparisonReached = resolve; });
    const resume = new Promise<void>((resolve) => { resumeComparison = resolve; });
    const originalCompare = bcrypt.compare.bind(bcrypt);
    const comparison = vi.spyOn(bcrypt, 'compare').mockImplementationOnce((async (
      plain: string,
      hash: string,
    ) => {
      const matches = await originalCompare(plain, hash);
      comparisonReached();
      await resume;
      return matches;
    }) as never);

    let response!: Awaited<ReturnType<typeof passwordLogin>>;
    try {
      const pending = passwordLogin(PROMOTION_RACE_PHONE);
      await atComparison;
      await app.prisma.user.update({
        where: { id: user.id },
        data: {
          roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] },
          activeRole: 'SUPER_ADMIN',
        },
      });
      resumeComparison();
      response = await pending;
    } finally {
      resumeComparison();
      comparison.mockRestore();
    }

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid phone/email or password',
    });
    expect(await app.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });
});
