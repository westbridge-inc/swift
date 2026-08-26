import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// NEXT-UP #2 (2026-08-25): the Home "Popular right now" rail must carry the
// SAME vendor-visibility predicate as the vendors query beside it — status
// ACTIVE **and** isVerified **and** tenant.isActive. Before the fix it
// filtered on status alone, so a platform-deactivated operator's STORE was
// hidden while their DISH sat above the fold. A guest request is unscoped
// ([F-028-07]), so the relational predicate is the only wall.
// ---------------------------------------------------------------------------

let app: FastifyInstance;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdTenantIds: string[] = [];

// Rail is a global top-10 by totalOrdered: park fixture counts far above any
// other row in the shared test database so exclusion is provably the
// predicate, never the cap.
const BASE_ORDERED = 5_000_000;

let seq = 0;
async function makeVendorWithItem(opts: {
  status?: 'ACTIVE' | 'SUSPENDED';
  isVerified: boolean;
  tenantId: string;
  totalOrdered: number;
}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200795${String(seq).padStart(2, '0')}`,
      firstName: 'Rail', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      tenantId: opts.tenantId,
      name: `Rail Vendor ${seq}`,
      slug: `rail-vendor-${nanoid(6).toLowerCase()}-${seq}`,
      vendorType: 'RESTAURANT',
      phone: `+59200796${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Rail Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: opts.status ?? 'ACTIVE',
      acceptingOrders: true, isCurrentlyOpen: true,
      isVerified: opts.isVerified,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({
    data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 },
  });
  const item = await app.prisma.item.create({
    data: {
      vendorId: vendor.id, categoryId: category.id,
      name: `Rail Dish ${seq}`, basePrice: 1000,
      isAvailable: true, totalOrdered: opts.totalOrdered,
    },
  });
  return { vendorId: vendor.id, itemId: item.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  // Idempotent purge of a prior interrupted run (house pattern: unique
  // fixture phone prefix per file).
  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200795' } }, select: { id: true } });
  if (stale.length) {
    const staleOwners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: stale.map((u) => u.id) } }, select: { id: true } });
    const staleVendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: staleOwners.map((o) => o.id) } }, select: { id: true, tenantId: true } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: staleOwners.map((o) => o.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
    await app.prisma.tenant.deleteMany({ where: { slug: { startsWith: 'rail-tenant-' } } });
  }
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await app.close();
});

describe('Home popular rail carries the full vendor-visibility predicate', () => {
  it('a deactivated operator, an unverified store, and a suspended store cannot place a dish on Home', async () => {
    const activeTenant = `rail-tenant-${nanoid(8).toLowerCase()}`;
    const deadTenant = `rail-tenant-${nanoid(8).toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id: activeTenant, name: 'Rail Active', slug: activeTenant } });
    await app.prisma.tenant.create({ data: { id: deadTenant, name: 'Rail Dead', slug: deadTenant, isActive: false } });
    createdTenantIds.push(activeTenant, deadTenant);

    const good = await makeVendorWithItem({ isVerified: true, tenantId: activeTenant, totalOrdered: BASE_ORDERED });
    // Each excluded case OUT-RANKS the good dish — if the predicate misses a
    // dimension, the leaked dish provably lands above the fold.
    const unverified = await makeVendorWithItem({ isVerified: false, tenantId: activeTenant, totalOrdered: BASE_ORDERED + 3 });
    const deadOperator = await makeVendorWithItem({ isVerified: true, tenantId: deadTenant, totalOrdered: BASE_ORDERED + 2 });
    const suspended = await makeVendorWithItem({ status: 'SUSPENDED', isVerified: true, tenantId: activeTenant, totalOrdered: BASE_ORDERED + 1 });

    // /home is Redis-cached for HOME_CACHE_TTL under the tenant-prefixed key
    // `t:<tenant>:home:guest:x:x`. A residual entry from any earlier run would
    // answer this request from cache and the rail assertions would grade a
    // stale feed — the exact way this test first went green-then-red. Clear
    // every guest home key so the request provably re-queries Postgres.
    const guestHomeKeys = await app.redis.keys('*home:guest:*');
    if (guestHomeKeys.length) await app.redis.del(...guestHomeKeys);

    // Guest request — no tenant context, the exact unscoped shape of the bug.
    const res = await app.inject({ method: 'GET', url: '/api/v1/customer/home' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { popularItems: { id: string }[] } };
    const railIds = body.data.popularItems.map((i) => i.id);

    expect(railIds).toContain(good.itemId);
    expect(railIds).not.toContain(unverified.itemId);
    expect(railIds).not.toContain(deadOperator.itemId);
    expect(railIds).not.toContain(suspended.itemId);
  });
});
