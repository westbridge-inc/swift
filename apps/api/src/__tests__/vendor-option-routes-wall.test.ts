/**
 * [Row 300 matrix · T3 finding] The menu option routes answer "not found" to
 * another tenant's store on the WALLED login too.
 *
 * The cross-tenant matrix (owner + walled logins) found that a second
 * tenant's store owner got 500, not 404, from five option routes on the walled
 * login only. Each read the row with its REQUIRED item relation included;
 * under the tenant wall the other tenant's item is invisible, so the read
 * itself failed before the route's own "not yours" check could answer.
 *
 * Measured through the app's own client on a per-suite walled request login
 * (NOBYPASSRLS, TENANT_RLS_BIND=1, deny), system work on its own login:
 *  - tenant B's owner gets 404 from all five routes for the production
 *    store's option group and option, and nothing about them changes;
 *  - control: the production store's own owner still edits them (200).
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// [R048-001] creates only this suite's temporary request/system LOGIN roles by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
// Store names are read by the prohibited-items checker: digits only (checked-names.test.ts).
const NAME_TAG = wordFreeTag();
const PRODUCTION = 'swift-default';
const TENANT_B = `optwall-b-${RUN}`;
const DAY = 86_400_000;

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { aOwnerUser: '', bOwnerUser: '', aVendorOwner: '', bVendorOwner: '', group: '', option: '' };
const tokens = { a: '', b: '' };

async function sessionFor(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await owner.session.create({ data: {
    userId, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP',
    deviceId: `optwall-${RUN}-${userId.slice(-4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return token;
}

async function store(tenantId: string, label: string) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: label, lastName: `Optwall${RUN}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, tenantId,
  } });
  const vendorOwner = await owner.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await owner.vendor.create({ data: {
    ownerId: vendorOwner.id, name: `${label} Store ${NAME_TAG}`, slug: `optwall-${label.toLowerCase()}-${RUN}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: 'Synthetic Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', tenantId,
  } });
  return { user, vendorOwner, vendor };
}

const snapshot = async () => ({
  group: await owner.optionGroup.findUnique({ where: { id: ids.group } }),
  options: await owner.option.findMany({ where: { optionGroupId: ids.group }, orderBy: { id: 'asc' } }),
});

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.tenant.create({ data: { id: TENANT_B, name: 'Option wall tenant B', slug: TENANT_B, isActive: true } });

  const a = await store(PRODUCTION, 'Alpha');
  const b = await store(TENANT_B, 'Bravo');
  ids.aOwnerUser = a.user.id; ids.aVendorOwner = a.vendorOwner.id;
  ids.bOwnerUser = b.user.id; ids.bVendorOwner = b.vendorOwner.id;
  const category = await owner.category.create({ data: { vendorId: a.vendor.id, name: 'Synthetic Menu' } });
  const item = await owner.item.create({ data: { vendorId: a.vendor.id, categoryId: category.id, name: 'Synthetic Pepperpot', basePrice: 1500 } });
  const group = await owner.optionGroup.create({
    data: { itemId: item.id, name: 'Synthetic Spice', options: { create: [{ name: 'Synthetic Hot', additionalPrice: 100 }] } },
    include: { options: true },
  });
  ids.group = group.id;
  ids.option = group.options[0]!.id;

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { vendorRoutes } = await import('../modules/vendor/vendor.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  tokens.a = await sessionFor(ids.aOwnerUser, 'VENDOR_OWNER');
  tokens.b = await sessionFor(ids.bOwnerUser, 'VENDOR_OWNER');
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
    const users = [ids.aOwnerUser, ids.bOwnerUser].filter(Boolean);
    const vendorOwners = [ids.aVendorOwner, ids.bVendorOwner].filter(Boolean);
    await owner.option.deleteMany({ where: { optionGroup: { item: { vendor: { ownerId: { in: vendorOwners } } } } } });
    await owner.optionGroup.deleteMany({ where: { item: { vendor: { ownerId: { in: vendorOwners } } } } });
    await owner.item.deleteMany({ where: { vendor: { ownerId: { in: vendorOwners } } } });
    await owner.category.deleteMany({ where: { vendor: { ownerId: { in: vendorOwners } } } });
    await owner.vendor.deleteMany({ where: { ownerId: { in: vendorOwners } } });
    await owner.vendorOwner.deleteMany({ where: { id: { in: vendorOwners } } });
    await owner.session.deleteMany({ where: { userId: { in: users } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.tenant.deleteMany({ where: { id: TENANT_B } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1/vendor${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });

describe('[Row 300 · T3] option routes on the walled login: another tenant gets 404, never 500', () => {
  it.each([
    ['PUT /option-groups/:id', 'PUT', () => `/option-groups/${ids.group}`, { name: 'Renamed by tenant B' }],
    ['DELETE /option-groups/:id', 'DELETE', () => `/option-groups/${ids.group}`, undefined],
    ['POST /option-groups/:groupId/options', 'POST', () => `/option-groups/${ids.group}/options`, { name: 'Added by tenant B', additionalPrice: 1 }],
    ['PUT /options/:id', 'PUT', () => `/options/${ids.option}`, { name: 'Renamed by tenant B' }],
    ['DELETE /options/:id', 'DELETE', () => `/options/${ids.option}`, undefined],
  ] as const)('%s', async (_label, method, url, payload) => {
    const before = await snapshot();

    const res = await call(method, url(), tokens.b, payload);

    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('control: the store\'s own owner still edits its option group and option', async () => {
    const group = await call('PUT', `/option-groups/${ids.group}`, tokens.a, { name: 'Synthetic Heat' });
    expect(group.statusCode, group.body).toBe(200);
    expect(group.json().data.name).toBe('Synthetic Heat');
    const option = await call('PUT', `/options/${ids.option}`, tokens.a, { additionalPrice: 150 });
    expect(option.statusCode, option.body).toBe(200);
    expect(Number(option.json().data.additionalPrice)).toBe(150);
  });
});
