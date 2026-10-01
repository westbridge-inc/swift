import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { marketRoutes } from '../modules/market/market.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [REVIEW-READY] The Market tab bound the PUBLIC catalogue for every request,
// signed in or not. A store reviewer lives in a REVIEW tenant (the fiction;
// DL-9: never production data), yet on staging, 1 Oct 2026, the reviewer's
// Market showed the operator's catalogue ("IMP-staging-…" items of
// "TEST-Pharma-One"), and in production it would show real stores' goods.
// The Market now binds like search and the Home category rail: a signed-in
// customer's own tenant, a guest the public catalogue.
// ---------------------------------------------------------------------------

const PUBLIC = 'swift-default';
let app: FastifyInstance;
let token: string;
const reviewTenant = `review-mkt-${nanoid(6).toLowerCase()}`;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let publicItemId: string;
let reviewItemId: string;
let priorPublicTenantEnv: string | undefined;
let seq = 0;

async function makeShop(tenantId: string, itemName: string) {
  seq += 1;
  const ownerUser = await app.prisma.user.create({
    data: {
      phone: `+59200776${String(seq).padStart(2, '0')}`,
      firstName: 'Market', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId,
    },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, tenantId,
      name: `Market Shop ${seq}`,
      slug: `market-shop-${nanoid(6).toLowerCase()}-${seq}`,
      vendorType: 'STORE',
      phone: `+59200778${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Market Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.806, longitude: -58.152,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Goods', sortOrder: 0, tenantId } });
  const item = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: category.id, name: itemName, basePrice: 2500, isAvailable: true, tenantId, totalOrdered: 9_000_000 + seq },
  });
  return item.id;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  priorPublicTenantEnv = process.env['PUBLIC_TENANT_ID'];
  process.env['PUBLIC_TENANT_ID'] = PUBLIC;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.ready();

  const stale = await app.prisma.user.findMany({
    where: { OR: [{ phone: { startsWith: '+59200776' } }, { phone: { startsWith: '+59200777' } }] }, select: { id: true },
  });
  if (stale.length) {
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: stale.map((u) => u.id) } }, select: { id: true } });
    const vendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: owners.map((o) => o.id) } }, select: { id: true } });
    const ids = vendors.map((v) => v.id);
    await app.prisma.item.deleteMany({ where: { vendorId: { in: ids } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: ids } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  }
  await app.prisma.reviewSession.deleteMany({ where: { tenantId: { startsWith: 'review-mkt-' } } });
  await app.prisma.tenant.deleteMany({ where: { id: { startsWith: 'review-mkt-' } } });

  const pub = await app.prisma.tenant.findUnique({ where: { id: PUBLIC }, select: { kind: true, isActive: true } });
  expect(pub, 'the seeded public tenant').toMatchObject({ kind: 'PRODUCTION', isActive: true });
  await app.prisma.tenant.create({ data: { id: reviewTenant, slug: reviewTenant, name: 'Market review fiction', kind: 'REVIEW', isActive: true } });
  // A live review session, as review:provision creates one: the strict sign-in
  // path runs the review gate, which refuses a reviewer whose demo has ended.
  await app.prisma.reviewSession.create({ data: { tenantId: reviewTenant, expiresAt: new Date(Date.now() + 86_400_000) } });

  publicItemId = await makeShop(PUBLIC, 'Public Lamp');
  reviewItemId = await makeShop(reviewTenant, 'Review Soap');

  const user = await app.prisma.user.create({
    data: {
      phone: `+59200777${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Market', lastName: 'Reviewer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId: reviewTenant,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: `mkt-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.reviewSession.deleteMany({ where: { tenantId: reviewTenant } });
  await app.prisma.tenant.deleteMany({ where: { id: reviewTenant } });
  if (priorPublicTenantEnv === undefined) delete process.env['PUBLIC_TENANT_ID'];
  else process.env['PUBLIC_TENANT_ID'] = priorPublicTenantEnv;
  await app.close();
});

const itemIds = (body: any): string[] => (body.data?.items ?? []).map((i: { id: string }) => i.id);
const allPages = async (headers: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/market/items?limit=50&sort=popular', headers });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return res.json();
};

describe('the Market binds the signed-in customer\'s own tenant', () => {
  it('a guest still sees the public catalogue, and never the review fiction', async () => {
    const ids = itemIds(await allPages({}));
    expect(ids).toContain(publicItemId);
    expect(ids).not.toContain(reviewItemId);
  });

  it('a store reviewer sees only the review tenant\'s goods, never the public catalogue', async () => {
    const ids = itemIds(await allPages({ authorization: `Bearer ${token}` }));
    expect(ids).toContain(reviewItemId);
    expect(ids).not.toContain(publicItemId);
  });

  it('the depth gate counts the reviewer\'s own catalogue, so the tab follows it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/depth', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const depth = res.json().data as { items: number; vendors: number };
    // The review tenant is fresh: this test's one shop with its one item.
    expect(depth.items).toBe(1);
    expect(depth.vendors).toBe(1);
  });

  it('a credential that does not verify is refused, as on every signed-in surface', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/items', headers: { authorization: 'Bearer not-a-real-token' } });
    expect(res.statusCode).toBe(401);
  });
});
