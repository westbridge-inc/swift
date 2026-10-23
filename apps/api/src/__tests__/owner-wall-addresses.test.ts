/**
 * [item 20 · owner wall] Saved addresses have no tenantId: before this, the
 * tenant wall could not hold them, and an unscoped address query leaked on
 * the WALLED login too (#1801 T3 note a). The owner wall walls them to the
 * person (migration 20261018220000_owner_wall_addresses, lib/owner-rls.ts).
 *
 * Measured through the app's OWN client on a per-suite walled request login
 * (NOBYPASSRLS, TENANT_RLS_BIND=1, deny) that is a member of swift_owner_wall
 * with OWNER_RLS_BIND=1, system work on its own bypass-member login:
 *  - fail closed: an unbound app connection, a job bound to a tenant but to no
 *    person, and another person's request see ZERO of a person's addresses;
 *  - every owner path in the census still returns its rows: the address
 *    routes (list, create, update, delete), the profile and the data export,
 *    a read inside the person's own interactive and batch transactions (the
 *    checkout's shape), and the erasure (a named system capability);
 *  - the admin user detail keeps a person's addresses through ONE named,
 *    audited system capability: one audit row per read;
 *  - inert while switched off: a login that is not a member, with
 *    OWNER_RLS_BIND unset, sees every row as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { ownerWallRefusal, readOwnerWallFacts } from '../lib/owner-rls';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;
const CAPABILITY = 'admin:user-detail-addresses';

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let requestRole = '';
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { alice: '', bob: '', admin: '', carol: '', aliceHome: '', aliceWork: '', bobHome: '' };
const tokens = { alice: '', bob: '', admin: '' };

async function sessionFor(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await owner.session.create({ data: {
    // [#1865] A raw client stores what the app stores: the credential digests.
    userId, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP', deviceId: `ow-${RUN}-${role}-${userId.slice(-4)}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  return token;
}
const address = (userId: string, label: string) => owner.address.create({ data: {
  userId, label, addressLine1: `${label} ${RUN}`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
} });

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  requestRole = decodeURIComponent(new URL(logins.requestUrl).username);
  // The switch, ON for this suite's request login only.
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);

  const mk = (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => owner.user.create({ data: {
    phone: testPhone(), firstName: 'Owner', lastName: `Wall${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } });
  ids.alice = (await mk(['CUSTOMER'], 'CUSTOMER')).id;
  ids.bob = (await mk(['CUSTOMER'], 'CUSTOMER')).id;
  ids.admin = (await mk(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } })).id;
  ids.aliceHome = (await address(ids.alice, 'Home')).id;
  ids.aliceWork = (await address(ids.alice, 'Work')).id;
  ids.bobHome = (await address(ids.bob, 'Home')).id;

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { customerRoutes } = await import('../modules/user/customer.routes');
  const { adminRoutes } = await import('../modules/admin/admin.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  tokens.alice = await sessionFor(ids.alice, 'CUSTOMER');
  tokens.bob = await sessionFor(ids.bob, 'CUSTOMER');
  tokens.admin = await sessionFor(ids.admin, 'SUPER_ADMIN');
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
    const users = [ids.alice, ids.bob, ids.admin, ids.carol].filter(Boolean);
    if (users.length) {
      await purgeSensitiveReadLogs(owner, { actorUserId: { in: users } }, 'owner-wall test fixtures');
      await owner.address.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } });
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
/** A flow bound the way a request is: its tenant, and the person it acts for.
 *  (Awaited INSIDE the context: a Prisma query is lazy and runs when awaited.) */
const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());

describe('[item 20] the owner wall fails closed', () => {
  it('an unbound app connection, a job bound to a tenant only, and another person see none of a person\'s addresses', async () => {
    // Unbound: the walled login with no person bound (raw, and through the app's own client).
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      expect(await raw.address.count({ where: { userId: ids.alice } })).toBe(0);
    } finally { await raw.$disconnect(); }
    // A job bound to the tenant but to no person (runWithTenant, as the erasure retry runs).
    expect(await tenant.runWithTenant(PRODUCTION, () => app.prisma.address.count({ where: { userId: ids.alice } }))).toBe(0);
    // Another person's request: Bob cannot see Alice's rows, even by id.
    expect(await asPerson(ids.bob, () => app.prisma.address.findUnique({ where: { id: ids.aliceHome } }))).toBeNull();
    expect(await asPerson(ids.bob, () => app.prisma.address.count({ where: { userId: ids.alice } }))).toBe(0);
    // ...nor write one under Alice's name (WITH CHECK).
    await expect(asPerson(ids.bob, () => app.prisma.address.create({ data: {
      userId: ids.alice, label: 'Planted', addressLine1: 'x', city: 'Georgetown', region: 'x', latitude: 6.8, longitude: -58.15,
    } }))).rejects.toThrow();
    // The attestation sees the posture this suite runs under.
    const facts = await readOwnerWallFacts(app.prisma);
    expect(facts).toEqual({ walledLogin: true, bypassLogin: false, unwalledTables: [], walledActions: [] });
    expect(ownerWallRefusal(facts, process.env)).toBeNull();
  });
});

describe('[item 20] every owner path in the census still returns its rows', () => {
  it('the address routes: list, create, update and delete are the person\'s own', async () => {
    const list = await call('GET', '/api/v1/customer/addresses', tokens.alice);
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).map((a) => a.id).sort()).toEqual([ids.aliceHome, ids.aliceWork].sort());
    const created = await call('POST', '/api/v1/customer/addresses', tokens.alice, {
      label: 'Gym', addressLine1: `Gym ${RUN}`, city: 'Georgetown', latitude: 6.81, longitude: -58.16,
    });
    expect(created.statusCode).toBe(201);
    const gym = created.json().data.id as string;
    const updated = await call('PUT', `/api/v1/customer/addresses/${gym}`, tokens.alice, { label: 'Gym 2' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.label).toBe('Gym 2');
    // Bob's request cannot touch it: the app guard answers first, the wall behind it.
    expect((await call('PUT', `/api/v1/customer/addresses/${gym}`, tokens.bob, { label: 'Mine' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/customer/addresses/${gym}`, tokens.alice)).statusCode).toBe(200);
    expect(await owner.address.count({ where: { id: gym } })).toBe(0);
  });

  it('the profile and the data export carry the person\'s addresses', async () => {
    const profile = await call('GET', '/api/v1/customer/profile', tokens.alice);
    expect(profile.statusCode).toBe(200);
    expect(JSON.stringify(profile.json())).toContain(`Home ${RUN}`);
    const exported = await call('GET', '/api/v1/customer/account/export', tokens.alice);
    expect(exported.statusCode).toBe(200);
    const body = JSON.stringify(exported.json());
    expect(body).toContain(`Home ${RUN}`);
    expect(body).toContain(`Work ${RUN}`);
  });

  it('the person\'s own transactions read their address (the checkout reads it inside one)', async () => {
    const inTx = await asPerson(ids.alice, () => app.prisma.$transaction((tx) => tx.address.findUnique({ where: { id: ids.aliceHome } })));
    expect(inTx?.id).toBe(ids.aliceHome);
    const [batch] = await asPerson(ids.alice, () => app.prisma.$transaction([app.prisma.address.findMany({ where: { userId: ids.alice } })]));
    expect(batch).toHaveLength(2);
    // ...and a default-address lookup by the person (order.service's fallback).
    expect(await asPerson(ids.alice, () => app.prisma.address.count({ where: { userId: ids.alice } }))).toBe(2);
  });

  it('places (the local provider) suggests and resolves the person\'s own saved addresses', async () => {
    const { getPlacesProvider } = await import('../providers/places/places-provider');
    const places = getPlacesProvider(app.prisma);
    const suggestions = await asPerson(ids.alice, () => places.autocomplete(`Home ${RUN}`, { userId: ids.alice }));
    expect(suggestions.map((s) => s.placeId)).toContain(`addr:${ids.aliceHome}`);
    expect((await asPerson(ids.alice, () => places.details(`addr:${ids.aliceHome}`, { userId: ids.alice })))?.placeId).toBe(`addr:${ids.aliceHome}`);
  });

  it('system work reads through the bypass login, and the erasure deletes the person\'s addresses for whoever runs it', async () => {
    expect(await tenant.runAsSystem('test:owner-wall-system-read', () => app.prisma.address.count({ where: { userId: ids.bob } }))).toBe(1);
    // The erasure's own step, as the retry job runs it (a tenant bound, no person): a named capability, never a silent zero.
    const extra = await address(ids.bob, 'Spare');
    const deleted = await tenant.runWithTenant(PRODUCTION, () => tenant.runAsSystem('account:erasure-addresses', () => app.prisma.address.deleteMany({ where: { id: extra.id } })));
    expect(deleted.count).toBe(1);
  });

  it('an account erasure run by the retry job (a tenant bound, no person) still drops every saved address', async () => {
    const carol = (await owner.user.create({ data: {
      phone: testPhone(), firstName: 'Erase', lastName: `Wall${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, tenantId: PRODUCTION,
    } })).id;
    ids.carol = carol;
    await address(carol, 'Home');
    await address(carol, 'Work');
    const { AccountService } = await import('../modules/user/account.service');
    await tenant.runWithTenant(PRODUCTION, () => new AccountService(app).deleteAccount(carol));
    expect(await owner.address.count({ where: { userId: carol } })).toBe(0);
  });
});

describe('[item 20] the admin user detail keeps addresses through one audited capability', () => {
  it('support sees the person\'s addresses, and each read leaves one audit row naming who, whose and why', async () => {
    const before = await owner.sensitiveReadLog.count({ where: { actorUserId: ids.admin, capability: CAPABILITY } });
    const res = await call('GET', `/api/v1/admin/users/${ids.alice}`, tokens.admin);
    expect(res.statusCode).toBe(200);
    expect((res.json().data.addresses as Array<{ id: string }>).map((a) => a.id).sort()).toEqual([ids.aliceHome, ids.aliceWork].sort());
    const rows = await owner.sensitiveReadLog.findMany({ where: { actorUserId: ids.admin, capability: CAPABILITY }, orderBy: { at: 'asc' } });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ subjectId: ids.alice, action: 'READ addresses (GET /users/:id)' });
    expect(rows.at(-1)!.purpose).toMatch(/delivery disputes/);
    // The admin's own request, outside that capability, sees none of them.
    expect(await asPerson(ids.admin, () => app.prisma.address.count({ where: { userId: ids.alice } }))).toBe(0);
  });
});

describe('[item 20] the wall is inert while switched off', () => {
  it('a login that is not a member, with OWNER_RLS_BIND unset, sees every row as before', async () => {
    await owner.$executeRawUnsafe(`REVOKE swift_owner_wall FROM ${requestRole}`);
    const prior = process.env['OWNER_RLS_BIND'];
    delete process.env['OWNER_RLS_BIND'];
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      expect(await raw.address.count({ where: { userId: { in: [ids.alice, ids.bob] } } })).toBe(3);
      expect(await asPerson(ids.bob, () => app.prisma.address.count({ where: { userId: ids.alice } }))).toBe(2);
      const facts = await readOwnerWallFacts(raw);
      expect(facts.walledLogin).toBe(false);
      expect(ownerWallRefusal(facts, {})).toBeNull();
      // Half a switch is refused: the database walled, the app not binding — every read would see nothing.
      expect(ownerWallRefusal({ ...facts, walledLogin: true }, {})).toMatch(/OWNER_RLS_BIND is not 1/);
      expect(ownerWallRefusal(facts, { OWNER_RLS_BIND: '1', TENANT_RLS_BIND: '1' })).toMatch(/not a member of swift_owner_wall/);
      expect(ownerWallRefusal({ ...facts, walledLogin: true }, { OWNER_RLS_BIND: '1' })).toMatch(/without TENANT_RLS_BIND=1/);
    } finally {
      await raw.$disconnect();
      if (prior === undefined) delete process.env['OWNER_RLS_BIND']; else process.env['OWNER_RLS_BIND'] = prior;
      await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);
    }
  });
});

describe('[item 20 · S4-1] the person binding is transaction-local', () => {
  it('a pooled connection that served one person shows the next unbound query nothing', async () => {
    // ONE connection, through the app's own scoped construction: whatever a bound
    // query left on it, the next query on it sees. A session-scoped setting would
    // carry Alice into an unbound read and leak instead of failing closed.
    const one = prismaModule.createScopedProcessClient({ datasourceUrl: logins!.singleConnectionUrl });
    try {
      expect(await asPerson(ids.alice, () => one.address.count({ where: { userId: ids.alice } }))).toBe(2);
      expect(await one.address.count({ where: { userId: ids.alice } })).toBe(0);
      expect(await asPerson(ids.alice, () => one.$transaction((tx) => tx.address.count({ where: { userId: ids.alice } })))).toBe(2);
      expect(await one.address.count({ where: { userId: ids.alice } })).toBe(0);
      expect(await asPerson(ids.alice, () => one.$transaction([one.address.count({ where: { userId: ids.alice } })]))).toEqual([2]);
      expect(await one.address.count({ where: { userId: ids.alice } })).toBe(0);
      expect(await tenant.runWithTenant(PRODUCTION, () => one.address.count({ where: { userId: ids.alice } }))).toBe(0);
    } finally { await one.$disconnect(); }
  });
});
