/**
 * [TENANT-WALL · 1 Nov 2026] A guest finds service providers under
 * production's CONTRACT tenant posture.
 *
 * GET /api/v1/services/providers is a browse surface a guest calls before
 * signing up. The route resolved the guest's marketplace but never BOUND it,
 * and it reads providers (a model with no tenant of its own) through their
 * accounts. Under the posture (the app's own client on a least-privilege login
 * that does not bypass row security, system work on its own bypass-member
 * login, TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny) an unbound read
 * sees no account at all, so every guest got an empty list. The route's other
 * suites run with no posture, where the same read sees every account.
 *
 * Measured here through the app's own client on a per-suite walled login,
 * with the same request context boundary as server.ts:
 *  - a guest sees a verified provider of the trade, and still not an
 *    unverified one;
 *  - a signed-in customer of ANOTHER operator still sees their own operator's
 *    providers only (the guest binding never reaches them);
 *  - the guest browse is bound, never system work;
 *  - the wall still binds the app: its login neither bypasses row security
 *    nor joins the bypass role.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { sessionCredentialDigest } from '../lib/session-credential';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
/** The guest marketplace (the route's own resolution) and an operator of this suite's own. */
const GUEST_TENANT = 'swift-default';
const OTHER = `gpwall-${RUN}`;
const TRADE = 'photographer';
const DAY = 86_400_000;

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;

const userIds: string[] = [];
const ids = { verified: '', unverified: '', otherOperator: '' };
let otherCustomerToken = '';

/** A provider of `tenantId`; `verified` gives them every document the trade's checklist names, approved. */
async function provider(tenantId: string, verified: boolean): Promise<string> {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Pro', lastName: `Wall${RUN}`, tenantId, isPhoneVerified: true, status: 'ACTIVE',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', selfieCapturedAt: new Date(), avatar: 'storage://test/provider-selfie.jpg',
    customer: { create: {} },
  } });
  userIds.push(user.id);
  const row = await owner.serviceProvider.create({ data: { userId: user.id, trade: TRADE, bio: `Wall ${RUN}` } });
  for (const docType of verified ? ['national_id', 'police_clearance'] : ['national_id']) {
    await owner.verificationDocument.create({ data: {
      userId: user.id, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}-${RUN}.jpg`, status: 'APPROVED',
      consentAt: new Date(), privacyNoticeVersion: 'v1', expiresAt: new Date(Date.now() + 200 * DAY),
    } });
  }
  return row.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.tenant.create({ data: { id: OTHER, name: 'Guest providers wall tenant', slug: OTHER, isActive: true } });
  ids.verified = await provider(GUEST_TENANT, true);
  ids.unverified = await provider(GUEST_TENANT, false);
  ids.otherOperator = await provider(OTHER, true);

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { servicesRoutes } = await import('../modules/services/services.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.ready();

  // A signed-in customer of the OTHER operator (sessions are stored as digests).
  const customer = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Cust', lastName: `Wall${RUN}`, tenantId: OTHER, isPhoneVerified: true,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} },
  } });
  userIds.push(customer.id);
  otherCustomerToken = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await owner.session.create({ data: {
    userId: customer.id, token: sessionCredentialDigest(otherCustomerToken), refreshToken: sessionCredentialDigest(nanoid(48)),
    deviceId: `gpwall-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } });
    await owner.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await owner.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await owner.customer.deleteMany({ where: { userId: { in: userIds } } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: OTHER } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const browse = (token?: string) => app.inject({
  method: 'GET', url: `/api/v1/services/providers?trade=${TRADE}&limit=50`,
  ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
});
const listed = (res: { json: () => { data: { providers: Array<{ id: string }> } } }) => res.json().data.providers.map((p) => p.id);

/** System reads by model and capability, from the wall's own counter. */
async function systemReads(): Promise<Map<string, number>> {
  const { tenantUnscopedAccessCounter } = await import('../plugins/observability');
  const out = new Map<string, number>();
  for (const v of (await tenantUnscopedAccessCounter.get()).values) {
    if (v.labels['mode'] !== 'system') continue;
    const key = `${v.labels['capability']}|${v.labels['model']}.${v.labels['operation']}`;
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}

describe('[TENANT-WALL] guest provider search under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a guest sees a verified provider of the trade, and still not an unverified one', async () => {
    const res = await browse();
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(listed(res)).toContain(ids.verified);
    expect(listed(res)).not.toContain(ids.unverified);
    expect(listed(res)).not.toContain(ids.otherOperator);
  });

  it('a signed-in customer of ANOTHER operator sees their own operator’s providers only', async () => {
    const res = await browse(otherCustomerToken);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(listed(res)).toContain(ids.otherOperator);
    expect(listed(res)).not.toContain(ids.verified);
  });

  it('the guest browse is bound to its marketplace, never system work', async () => {
    const before = await systemReads();
    expect(listed(await browse())).toContain(ids.verified);
    const after = await systemReads();
    expect([...after].filter(([key, n]) => n !== (before.get(key) ?? 0)).map(([key]) => key)).toEqual([]);
  });
});
