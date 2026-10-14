/**
 * [REVIEW-PARTNER · REPORT-072 OTA-016] The review tenant under production's
 * strict tenant posture — FIXED by the pre-auth identity capability (L04 R1).
 *
 * The dependency chain, measured here:
 *  1. A REVIEW tenant is a second active tenant. On a NODE_ENV=production host
 *     the tenant wall then refuses to run without the CONTRACT posture
 *     (rls-attestation assertTenantWall, called by review:provision and boot):
 *     the app on a NOBYPASSRLS login, TENANT_RLS_BIND=1, TENANT_UNSCOPED_ACCESS=deny,
 *     and audited system work on its own bypass-member login.
 *  2. Under that posture nobody — the review partners included — could sign
 *     in or use a session, because authentication read the tenant-owned User
 *     row BEFORE any tenant was bound:
 *       - verify-otp (auth.service verifyOtp) looks the account up by phone in
 *         request mode with no tenant → TENANT_CONTEXT_REQUIRED (500);
 *       - every authenticated request (plugins/auth.ts authenticate) reads
 *         Session → nested User on the walled login before enterTenant → the
 *         database shows no user → 503 AUTH_UNAVAILABLE.
 *
 * Staging runs NODE_ENV=loadtest, where the wall check is a no-op, so the demo
 * partners work there (review-partner-demo.test.ts proves the whole flow under
 * the default posture). This suite boots the app's OWN client as the walled
 * login — the exact topology the contract names — and proves, through the
 * real routes, that both now succeed: every pre-auth read resolves the
 * credential to {id, tenantId} through ONE named system capability and binds
 * that tenant before reading anything else (modules/auth/preauth-identity.ts;
 * every surface is covered in preauth-identity-posture.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { appRoleDdl } from '../lib/tenant-rls';
import { assertTenantWall, attestationOf, readRlsFacts, appSideWallGaps } from '../lib/rls-attestation';
import { hashReviewCode } from '../modules/review/credentials';
import { installDdl } from './helpers/install-ddl';

// [R048-001] this suite creates the NOLOGIN probe group and two LOGIN roles by raw DDL, exactly as tenant-wall-binds-app does.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const PROBE_LOGIN = 'swift_rls_probe_login';
const PROBE_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${PROBE_LOGIN}:probe@`);
const SYSTEM_LOGIN = 'swift_rls_system_login';
const SYSTEM_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${SYSTEM_LOGIN}:probe@`);
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REVIEW = `review-strict-${RUN}`;
const PHONE = `+59200094${String(Math.floor(Math.random() * 90) + 10)}`;
const CODE = '864213';
const CREDENTIAL_ID = `rc-${RUN}-strict`;
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let owner: PrismaClient;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let userId = '';

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  // The fixture writer: the suite's own privileged connection (never the app's client).
  owner = new PrismaClient({ datasourceUrl: TEST_URL });
  await installDdl(owner, [
    ...appRoleDdl(),
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_rls_probe') THEN CREATE ROLE swift_rls_probe NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO swift_rls_probe`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_rls_probe`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_rls_probe`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_LOGIN}') THEN CREATE ROLE ${PROBE_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${PROBE_LOGIN}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_LOGIN}') THEN CREATE ROLE ${SYSTEM_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${SYSTEM_LOGIN}`,
    `GRANT swift_bypass_rls TO ${SYSTEM_LOGIN}`,
  ]);

  // The fiction, as provision would leave it: a REVIEW tenant, a live session, a rider login.
  await owner.tenant.create({ data: { id: REVIEW, name: 'Strict posture fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
  await owner.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + 86_400_000) } });
  userId = (await owner.user.create({ data: {
    phone: PHONE, firstName: 'Demo', lastName: 'Rider', roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER',
    tenantId: REVIEW, isPhoneVerified: true,
  } })).id;
  await owner.reviewCredential.create({ data: { id: CREDENTIAL_ID, tenantId: REVIEW, role: 'RIDER', identifier: PHONE, staticOtpHash: hashReviewCode(CREDENTIAL_ID, CODE) } });

  // The app's OWN client on the walled login, system work on the bypass-member login, and the
  // contract's two application settings — set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = PROBE_URL;
  process.env['SYSTEM_DATABASE_URL'] = SYSTEM_URL;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const { prismaPlugin } = prismaModule;
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { authRoutes } = await import('../modules/auth/auth.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(async () => {
  await app?.redis.del(`otp_rate:${PHONE}`, `otp_hr:${PHONE}`, `review_otp:${PHONE}`, `review_otp_fail:${PHONE}`).catch(() => {});
  await app?.close();
  // The system login's client is cached by the module: close it before its URL leaves the environment.
  await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
  prismaModule?.setSystemPrismaClient(null);
  for (const k of ENV_KEYS) {
    if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
  }
  await owner.session.deleteMany({ where: { userId } });
  await owner.reviewCredential.deleteMany({ where: { id: CREDENTIAL_ID } });
  await owner.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
  await owner.user.deleteMany({ where: { id: userId } });
  await owner.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
  await owner.tenant.deleteMany({ where: { id: REVIEW } });
  await owner.$disconnect();
});

describe('[OTA-016] the review tenant under the production CONTRACT posture', () => {
  it('the dependency: on a production host a second active tenant (the review fiction) refuses to run unless the wall binds — and the contract is exactly bind + deny', async () => {
    const facts = await readRlsFacts(owner); // the suite's privileged login: the wall does not bind it
    expect(() => assertTenantWall(attestationOf(facts), 2, { NODE_ENV: 'production' })).toThrow(/2 active tenants/);
    expect(appSideWallGaps({ NODE_ENV: 'production', TENANT_RLS_BIND: '1', TENANT_UNSCOPED_ACCESS: 'deny' })).toEqual([]);
    // And this suite's app really runs on that wall: its own login does not bypass it.
    const appFacts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([appFacts.isSuperuser, appFacts.hasBypassRls, appFacts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('send-otp answers (the credential lookup is audited system work on the system login) and verify-otp signs the review account in: one session', async () => {
    await app.redis.del(`otp_rate:${PHONE}`, `review_otp:${PHONE}`, `review_otp_fail:${PHONE}`);
    const sent = await app.inject({ method: 'POST', url: '/api/v1/auth/send-otp', payload: { phone: PHONE } });
    expect(sent.statusCode, sent.body).toBe(200);
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', payload: { phone: PHONE, code: CODE } });
    // Was OTA-016's first failure (TENANT_CONTEXT_REQUIRED): the account lookup now goes through the
    // pre-auth identity capability, and the sign-in runs bound to the review tenant.
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.user.id).toBe(userId);
    expect(verified.json().data.user.tenant.kind).toBe('REVIEW');
    expect(await owner.session.count({ where: { userId } })).toBe(1);
  });

  it('a session that already exists is accepted at the auth decorator: the account is read bound to its own tenant', async () => {
    const token = app.jwt.sign({ userId, role: 'RIDER', jti: nanoid(8) });
    await owner.session.create({ data: {
      userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `strict-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    // Was OTA-016's second failure (503 AUTH_UNAVAILABLE): the session's account and tenant come from the
    // pre-auth identity capability, and the account is then read bound to that tenant.
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(userId);
    expect(me.json().data.user.tenant.kind).toBe('REVIEW');
  });
});
