import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { publicRoutes } from '../modules/public/public.routes';

// ---------------------------------------------------------------------------
// Preview drafts (gated-trials spec §B2): with PREVIEW_MODE on, a store that
// has NEVER been live builds its menu as drafts — invisible to every customer
// surface until ACTIVE. Flag off = the hard gate, byte-identical. A SUSPENDED
// store never drafts: suspension means suspended.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
const marker = `pvdraft${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
let pendingVendorId: string;
let pendingSlug: string;
let suspendedVendorId: string;
let userId: string;
let ownerId: string;
const vendorIds: string[] = [];

async function makeVendor(overrides: Record<string, unknown>) {
  const suffix = nanoid(6).toLowerCase();
  const v = await app.prisma.vendor.create({
    data: {
      ownerId,
      name: `${marker} ${suffix}`,
      slug: `${marker}-${suffix}`,
      vendorType: 'RESTAURANT',
      phone: '+5926991111',
      addressLine1: '2 Draft Lane',
      city: 'Georgetown',
      region: 'Demerara',
      latitude: 6.81,
      longitude: -58.17,
      ...overrides,
    },
  });
  vendorIds.push(v.id);
  return v;
}

const createItem = (vendorId: string, categoryId: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/vendor/items',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-vendor-id': vendorId },
    payload: { categoryId, name: `${marker} dhal puri`, basePrice: 800 },
  });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['PREVIEW_MODE'];

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();

  const user = await app.prisma.user.create({
    data: {
      phone: `+59268${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Draft', lastName: 'Owner',
      roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never,
      isPhoneVerified: true,
    },
  });
  userId = user.id;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  ownerId = owner.id;
  token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'pvdraft-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  const pending = await makeVendor({ status: 'PENDING_APPROVAL', isVerified: false });
  pendingVendorId = pending.id;
  pendingSlug = pending.slug;
  // Was live once, now suspended — must never regain listing through the flag.
  const suspended = await makeVendor({ status: 'SUSPENDED', isVerified: false });
  suspendedVendorId = suspended.id;
});

afterAll(async () => {
  delete process.env['PREVIEW_MODE'];
  if (vendorIds.length > 0) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  }
  if (ownerId) await app.prisma.vendorOwner.deleteMany({ where: { id: ownerId } });
  if (userId) {
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  }
  await app.close();
});

describe('preview drafts (§B2)', () => {
  let categoryId: string;

  it('categories were never gated — the pending store organizes freely', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vendor/categories',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-vendor-id': pendingVendorId },
      payload: { name: 'Mains' },
    });
    expect(res.statusCode).toBe(200);
    categoryId = res.json().data.id;
  });

  it('flag OFF: item creation stays hard-gated (regression)', async () => {
    delete process.env['PREVIEW_MODE'];
    const res = await createItem(pendingVendorId, categoryId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
  });

  it('flag ON: the pending store drafts its menu', async () => {
    process.env['PREVIEW_MODE'] = '1';
    const res = await createItem(pendingVendorId, categoryId);
    expect(res.statusCode).toBe(200);
    const item = await app.prisma.item.findFirst({ where: { vendorId: pendingVendorId } });
    expect(item?.name).toContain('dhal puri');
  });

  it('drafts leak nowhere: the pending store stays invisible to the public surface', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts?q=${marker}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(0);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/${pendingSlug}` });
    expect(detail.statusCode).toBe(404);
  });

  it('a SUSPENDED store never drafts — suspension means suspended', async () => {
    process.env['PREVIEW_MODE'] = '1';
    const cat = await app.prisma.category.create({
      data: { vendorId: suspendedVendorId, name: 'Mains', sortOrder: 0 },
    });
    const res = await createItem(suspendedVendorId, cat.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
  });
});
