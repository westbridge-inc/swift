/**
 * The weekly fee a mover is owed is born on the mover's OWN request when they save a vehicle or press GO, where before
 * it was only ever born on a reviewer's request or a job. Measured through the app's own client on per-suite logins in
 * the production posture (a walled request login in swift_owner_wall, TENANT_RLS_BIND=1, TENANT_UNSCOPED_ACCESS=deny,
 * OWNER_RLS_BIND=1, system work on its own bypass login): the save and GO answer, and the fee row is really there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient, VehicleType } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { cleanupBillingClocks, cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { CountryConfigService } from '../modules/country/country-config.service';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;
const GO = { latitude: 6.8013, longitude: -58.1551 };

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma');
const users: string[] = [];

async function signedUpMover() {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Door', lastName: `Wall${RUN}`, roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY', tenantId: PRODUCTION, customer: { create: {} },
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await owner.session.create({ data: {
    userId: user.id, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP',
    deviceId: `door-${RUN}-${user.id.slice(-4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token };
}

async function approvePapers(userId: string, vehicleType: VehicleType) {
  const list = await new CountryConfigService(owner).getMoverChecklist('GY', vehicleType);
  for (const docType of list) await owner.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/door/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'door-test',
    reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY),
    ...(docType === 'vehicle_insurance' ? { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } : {}),
  } });
}

const call = (method: 'POST', url: string, token: string, payload: unknown) => app.inject({
  method, url, payload: payload as object, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});
const fees = (userId: string) => owner.subscription.findMany({ where: { OR: [{ rider: { userId } }, { driver: { userId } }] } });

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${decodeURIComponent(new URL(logins.requestUrl).username)}`);
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { partnerRoutes } = await import('../modules/partner/partner.routes');
  const { riderRoutes } = await import('../modules/rider/rider.routes');
  const { driverRoutes } = await import('../modules/driver/driver.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
});

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    if (users.length) {
      const subIds = (await owner.subscription.findMany({ where: { OR: [{ rider: { userId: { in: users } } }, { driver: { userId: { in: users } } }] }, select: { id: true } })).map((s) => s.id);
      await cleanupPayerBillingClocks(owner, users);
      await cleanupBillingClocks(owner, subIds);
      await owner.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await owner.customer.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } });
      await owner.subscription.deleteMany({ where: { id: { in: subIds } } });
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

describe('on the mover\'s own request, in the production posture', () => {
  it('the harness is really walled: the app\'s client on this login sees no user without a tenant', async () => {
    await expect(app.prisma.user.count()).rejects.toThrow();
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      expect(await raw.user.count()).toBe(0);
    } finally {
      await raw.$disconnect();
    }
  });

  it('a rider saves the vehicle: the trial is born on that request, and GO stands on it', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    const saved = await call('POST', '/api/v1/partner/become', mover.token, { role: 'MOVER', acceptAgreement: true, vehicleType: 'MOTORCYCLE' });
    expect(saved.statusCode, saved.body).toBe(201);
    const subs = await fees(mover.userId);
    expect(subs.map((s) => s.status)).toEqual(['TRIAL']);
    const go = await call('POST', '/api/v1/rider/go-online', mover.token, GO);
    expect(go.statusCode, go.body).toBe(200);
  });

  it('a taxi driver saves the vehicle: the trial and the plate key are born on that request', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'CAR');
    const licensePlate = `HAA${RUN.slice(0, 5).toUpperCase()}`;
    const saved = await call('POST', '/api/v1/partner/become', mover.token, {
      role: 'MOVER', acceptAgreement: true, vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'White', licensePlate },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect((await fees(mover.userId)).map((s) => [s.type, s.status])).toEqual([['TAXI_DRIVER', 'TRIAL']]);
    expect(await owner.identityKey.count({ where: { accountId: mover.userId, type: 'PLATE' } })).toBe(1);
    const go = await call('POST', '/api/v1/driver/go-online', mover.token, GO);
    expect(go.statusCode, go.body).toBe(200);
  });

  it('a rider the old order left with no fee presses GO: the trial is born on that request', async () => {
    const mover = await signedUpMover();
    await owner.rider.create({ data: { userId: mover.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } });
    await owner.user.update({ where: { id: mover.userId }, data: { roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' } });
    await approvePapers(mover.userId, 'MOTORCYCLE');
    const go = await call('POST', '/api/v1/rider/go-online', mover.token, GO);
    expect(go.statusCode, go.body).toBe(200);
    expect((await fees(mover.userId)).map((s) => s.status)).toEqual(['TRIAL']);
  });
});
