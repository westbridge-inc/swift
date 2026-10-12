import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { TenantKind } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { beginRequestTenantContext, runAsSystem } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { publicRoutes } from '../modules/public/public.routes';

// DL-7 / AX324: real queries and real session authentication, with the same
// request context boundary as server.ts. No vendor/tenant/auth doubles.
const run = `dl7-${nanoid(10)}`;
const production = 'swift-default';
const tenants = ['REVIEW', 'CRAWLER', 'INACTIVE'] as const;
type Store = { id: string; slug: string; itemId: string; tenantId: string; oldSlug: string };
const stores: Record<string, Store> = {};
const userIds: string[] = [];
const vendorIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;
let app: FastifyInstance;
let customerId: string;
let token: string;
let reviewToken: string;
const system = <T>(fn: () => Promise<T>) => runAsSystem('dl7-fixtures', fn);
// This prefix is unused by the other suites; cleanup is scoped to created IDs.
const phone = () => `+5926478${String(++seq).padStart(3, '0')}`;
const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

async function customer(tenantId: string, isSynthetic = false) {
  const user = await app.prisma.user.create({ data: {
    phone: phone(), firstName: 'DL7', lastName: 'Customer', tenantId, isSynthetic,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userIds.push(user.id);
  const bearer = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid() });
  await app.prisma.session.create({ data: {
    userId: user.id, token: bearer, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: run, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return { id: user.id, token: bearer };
}

async function store(label: string, tenantId: string, isSynthetic: boolean) {
  const user = await app.prisma.user.create({ data: {
    phone: phone(), firstName: 'DL7', lastName: 'Owner', tenantId, isSynthetic,
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
  } });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, tenantId, isSynthetic, name: `${run}-${label}`, slug: `${run}-${label}`,
    phone: phone(), vendorType: 'SERVICE', status: 'ACTIVE', isVerified: true,
    addressLine1: '1 Test Street', city: 'Georgetown', region: 'Demerara', latitude: 6.8, longitude: -58.15,
    isCurrentlyOpen: true, acceptingOrders: true, averageRating: 4, totalRatings: 7,
  } });
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { tenantId, vendorId: vendor.id, name: `${label} menu` } });
  const item = await app.prisma.item.create({ data: {
    tenantId, vendorId: vendor.id, categoryId: category.id, name: `${label} appointment`,
    basePrice: 1000, isAvailable: true, fulfillment: 'APPOINTMENT',
    bookingConfig: { durationMinutes: 30, slots: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })) },
  } });
  const oldSlug = `${vendor.slug}-old`;
  // Even a public-tenant redirect pointing at another tenant must not reveal it.
  await app.prisma.slugRedirect.create({ data: { tenantId: production, entityType: 'VENDOR', entityId: vendor.id, oldSlug } });
  stores[label] = { id: vendor.id, slug: vendor.slug, itemId: item.id, tenantId, oldSlug };
}

beforeAll(async () => {
  vi.stubEnv('PUBLIC_TENANT_ID', production);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
  await system(async () => {
    await store('PRODUCTION', production, false);
    for (const label of tenants) {
      const tenantId = `${run}-${label}`;
      await app.prisma.tenant.create({ data: {
        id: tenantId, slug: tenantId, name: tenantId,
        kind: (label === 'INACTIVE' ? 'PRODUCTION' : label) as TenantKind,
        isActive: label !== 'INACTIVE',
      } });
      tenantIds.push(tenantId);
      await store(label, tenantId, label !== 'INACTIVE');
    }
    const prodCustomer = await customer(production);
    customerId = prodCustomer.id;
    token = prodCustomer.token;
    reviewToken = (await customer(stores['REVIEW']!.tenantId, true)).token;
    await app.prisma.reviewSession.create({ data: {
      tenantId: stores['REVIEW']!.tenantId, status: 'ANCHORED',
      expiresAt: new Date(Date.now() + 3_600_000), anchorLat: 6.8, anchorLng: -58.15,
      anchorSource: 'DEVICE_GPS', anchoredAt: new Date(),
    } });
    // Historical cross-tenant favorites must be filtered at the nested read.
    await app.prisma.customer.update({ where: { userId: customerId }, data: {
      favoriteVendors: { connect: vendorIds.map((id) => ({ id })) },
    } });
  });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.slugRedirect.deleteMany({ where: { entityId: { in: vendorIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });
  await app.close();
  vi.unstubAllEnvs();
});

const routes = [
  { name: 'detail, menu, categories, availability and ratings', path: (s: Store) => `/api/v1/customer/vendors/${s.id}`, key: 'id' },
  { name: 'reviews and rating distribution', path: (s: Store) => `/api/v1/customer/vendors/${s.id}/reviews`, key: 'id' },
  { name: 'public slug and menu', path: (s: Store) => `/api/v1/public/storefronts/${s.slug}`, key: 'slug' },
  { name: 'retired public slug', path: (s: Store) => `/api/v1/public/storefronts/${s.oldSlug}`, key: 'oldSlug' },
] as const;
const get = (url: string, bearer?: string) => app.inject({ method: 'GET', url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
// Missing-id errors echo the supplied identifier. Normalize only that echo;
// status, code, complete body shape and all remaining text must be identical.
const normalized = (body: string, id: string) => JSON.parse(body.replaceAll(id, '<requested>'));

describe.each(['log', 'deny'])('DL-7 vendor read wall with unscoped access=%s', (mode) => {
  for (const caller of ['guest', 'customer'] as const) {
    for (const route of routes) {
      it.each(tenants)(`${caller}: ${route.name} hides %s exactly like a missing store`, async (label) => {
        vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
        const s = stores[label]!;
        const missing = { ...s, [route.key]: `${run}-missing` };
        const bearer = caller === 'customer' ? token : undefined;
        const absent = await get(route.path(missing), bearer);
        const hidden = await get(route.path(s), bearer);
        expect(absent.statusCode).toBe(404);
        expect(hidden.statusCode).toBe(404);
        expect(normalized(hidden.body, s[route.key])).toEqual(normalized(absent.body, missing[route.key]));
        expect(hidden.json().error.code).toBe('NOT_FOUND');
        expect(hidden.json()).not.toHaveProperty('data');
        const live = await get(route.path(stores['PRODUCTION']!), bearer);
        expect(live.statusCode, live.body).toBe(200);
        expect(live.json().data[route.key === 'id' && route.name.startsWith('reviews') ? 'vendor' : 'id']).toBeDefined();
      });
    }
  }

  it.each(tenants)('authenticated item slots hide %s like a missing listing', async (label) => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    const s = stores[label]!;
    const slots = (id: string) => `/api/v1/customer/items/${id}/slots?date=${date}`;
    const absent = await get(slots(`${run}-missing`), token);
    const hidden = await get(slots(s.itemId), token);
    expect(absent.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    expect(normalized(hidden.body, s.itemId)).toEqual(normalized(absent.body, `${run}-missing`));
    const live = await get(slots(stores['PRODUCTION']!.itemId), token);
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json().data.slots.length).toBeGreaterThan(0);
  });

  it('guest slots retain the authentication wall for every listing', async () => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    const slots = (id: string) => `/api/v1/customer/items/${id}/slots?date=${date}`;
    const absent = await get(slots(`${run}-missing`));
    expect(absent.statusCode).toBe(401);
    for (const s of Object.values(stores)) {
      const response = await get(slots(s.itemId));
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(absent.json());
    }
  });

  it('favorites reveal only stores in the customer tenant, including pre-existing links', async () => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    const response = await get('/api/v1/customer/favorites', token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.map((s: { id: string }) => s.id)).toEqual([stores['PRODUCTION']!.id]);
  });

  it('a reviewer still reads their own store, reviews and slots', async () => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    const s = stores['REVIEW']!;
    for (const url of [routes[0].path(s), routes[1].path(s), `/api/v1/customer/items/${s.itemId}/slots?date=${date}`]) {
      const response = await get(url, reviewToken);
      expect(response.statusCode, response.body).toBe(200);
    }
  });
});
