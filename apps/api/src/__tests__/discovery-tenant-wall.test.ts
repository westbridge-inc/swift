import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { beginRequestTenantContext, runAsSystem } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { CATEGORY_DISCOVERY_FLAG, discoveryRoutes, resetDiscoveryCacheForTests } from '../modules/discovery/discovery.routes';

// AX343 finding 2: exercise the real guest binding, SQL counts, tenant-scoped
// taxonomy and cache. Both tenants have the same slug, but REVIEW has two
// vendors and an extra category that must never enter the public rail.
const run = `dl7-rail-${nanoid(10)}`;
const production = `${run}-production`;
const review = `${run}-review`;
const sharedSlug = `${run}-shared`;
const reviewOnlySlug = `${run}-review-only`;
const tenantIds = [production, review];
const userIds: string[] = [];
const vendorIds: string[] = [];
const categoryIds: string[] = [];
let app: FastifyInstance;
let reviewToken: string;
let priorFlag: { value: unknown } | null;
let seq = 0;
const phone = () => `+5926479${String(++seq).padStart(3, '0')}`;
const system = <T>(fn: () => Promise<T>) => runAsSystem('dl7-discovery-fixtures', fn);

async function category(tenantId: string, slug: string, name: string) {
  const row = await app.prisma.discoveryCategory.create({ data: {
    tenantId, slug, name, kind: 'CUISINE', vertical: 'FOOD', emoji: '🍲', aliases: [],
  } });
  categoryIds.push(row.id);
  return row.id;
}

async function member(tenantId: string, categories: string[]) {
  const isSynthetic = tenantId === review;
  const user = await app.prisma.user.create({ data: {
    tenantId, isSynthetic, phone: phone(), firstName: 'DL7', lastName: 'Rail Owner',
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
  } });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    tenantId, isSynthetic, ownerId: owner.id, name: `${run}-${seq}`, slug: `${run}-${seq}`,
    phone: phone(), vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true,
    addressLine1: '1 Test Street', city: 'Georgetown', region: 'Demerara',
    latitude: 6.8, longitude: -58.15, isCurrentlyOpen: true, acceptingOrders: true,
  } });
  vendorIds.push(vendor.id);
  for (const [index, categoryId] of categories.entries()) {
    await app.prisma.vendorDiscoveryCategory.create({ data: {
      tenantId, vendorId: vendor.id, categoryId,
      role: index === 0 ? 'PRIMARY' : 'SECONDARY', source: 'VENDOR',
    } });
  }
}

beforeAll(async () => {
  vi.stubEnv('PUBLIC_TENANT_ID', production);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(discoveryRoutes, { prefix: '/api/v1/discovery' });
  await app.ready();
  await system(async () => {
    for (const tenantId of tenantIds) {
      await app.prisma.tenant.create({ data: {
        id: tenantId, slug: tenantId, name: tenantId,
        kind: tenantId === production ? 'PRODUCTION' : 'REVIEW', isActive: true,
      } });
    }
    const liveCategory = await category(production, sharedSlug, 'Production food');
    const reviewCategory = await category(review, sharedSlug, 'Review food');
    const reviewOnly = await category(review, reviewOnlySlug, 'Review only');
    await member(production, [liveCategory]);
    await member(review, [reviewCategory, reviewOnly]);
    await member(review, [reviewCategory, reviewOnly]);
    const user = await app.prisma.user.create({ data: {
      tenantId: review, isSynthetic: true, phone: phone(), firstName: 'DL7', lastName: 'Rail Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      selfieCapturedAt: new Date(), customer: { create: {} },
    } });
    userIds.push(user.id);
    reviewToken = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid() });
    await app.prisma.session.create({ data: {
      userId: user.id, token: reviewToken, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: run, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
    } });
    await app.prisma.reviewSession.create({ data: {
      tenantId: review, status: 'ANCHORED', expiresAt: new Date(Date.now() + 3_600_000),
      anchorLat: 6.8, anchorLng: -58.15, anchorSource: 'DEVICE_GPS', anchoredAt: new Date(),
    } });
    priorFlag = await app.prisma.platformConfig.findUnique({ where: { key: CATEGORY_DISCOVERY_FLAG }, select: { value: true } });
    await app.prisma.platformConfig.upsert({
      where: { key: CATEGORY_DISCOVERY_FLAG },
      create: { key: CATEGORY_DISCOVERY_FLAG, value: true }, update: { value: true },
    });
  });
});

afterAll(async () => {
  await system(async () => {
    if (priorFlag) {
      await app.prisma.platformConfig.update({ where: { key: CATEGORY_DISCOVERY_FLAG }, data: { value: priorFlag.value as never } });
    } else {
      await app.prisma.platformConfig.deleteMany({ where: { key: CATEGORY_DISCOVERY_FLAG } });
    }
    await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.discoveryCategory.deleteMany({ where: { id: { in: categoryIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: review } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });
  resetDiscoveryCacheForTests();
  await app.close();
  vi.unstubAllEnvs();
});

async function rail(token?: string) {
  const response = await app.inject({
    method: 'GET', url: '/api/v1/discovery/categories?vertical=FOOD',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.enabled).toBe(true);
  return response.json().data.categories as Array<{ slug: string; name: string; availableVendors: number }>;
}

describe.each(['log', 'deny'])('AX343 discovery tenant wall with unscoped access=%s', (mode) => {
  it('excludes REVIEW categories and their vendor counts from guests, cold and after a reviewer warms the cache', async () => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    resetDiscoveryCacheForTests();
    const publicRail = [expect.objectContaining({ slug: sharedSlug, name: 'Production food', availableVendors: 1 })];
    const reviewRail = [
      expect.objectContaining({ slug: sharedSlug, name: 'Review food', availableVendors: 2 }),
      expect.objectContaining({ slug: reviewOnlySlug, name: 'Review only', availableVendors: 2 }),
    ];
    // A real REVIEW session proves the hidden categories and both counted
    // vendors are live. The exact public array also forbids duplicate slugs.
    expect(await rail()).toEqual(publicRail);
    expect(await rail(reviewToken)).toEqual(reviewRail);
    expect(await rail()).toEqual(publicRail);
    resetDiscoveryCacheForTests();
    expect(await rail(reviewToken)).toEqual(reviewRail);
    expect(await rail()).toEqual(publicRail);
    expect(await rail(reviewToken)).toEqual(reviewRail);
  });
});
