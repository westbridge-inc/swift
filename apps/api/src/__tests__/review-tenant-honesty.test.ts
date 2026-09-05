/**
 * [STA-1 RLS-N3 / RLS-N6 / DL-4 / DL-7] The fiction is seen only by the
 * reviewer, and counted by nobody.
 *
 * N3: an authenticated REVIEW session browsing the public vendor surfaces
 * (/vendors, /home, /vendors?category=) receives only review-tenant vendors,
 * and a production session never receives a review vendor. The category
 * taxonomy and the rating tags follow the caller's tenant, not a literal.
 * N6: every aggregate of people or money in the dashboard's stats module
 * names PRODUCTION rows explicitly, and those predicates — run with no tenant
 * context at all — exclude the fiction's rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant, beginRequestTenantContext } from '../plugins/tenant-context';
import { PRODUCTION_TENANT, REAL_PEOPLE } from '../lib/production-only';
import { platformStats } from '../modules/admin/platform-stats';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const phone = (n: number) => `+59279${NUM}${n}`;
const REVIEW = `review-honest-${RUN}`;
const PRODUCTION = 'swift-default';
const SLUG = `fiction-cat-${RUN}`;

let app: FastifyInstance;
const ids = { reviewCustomer: '', prodCustomer: '', reviewOwner: '', prodOwner: '', reviewVendor: '', prodVendor: '', reviewOrder: '', prodOrder: '', category: '' };
let reviewToken = '';
let prodToken = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sta1-honesty-test');

async function bearerFor(userId: string): Promise<string> {
  const token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(64), authMethod: 'OTP',
    deviceId: `sta1-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return token;
}
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

async function visibleVendor(tenantId: string, ownerPhone: string, isSynthetic: boolean) {
  const owner = await app.prisma.user.create({ data: { phone: ownerPhone, firstName: 'O', lastName: 'W', activeRole: 'VENDOR_OWNER', tenantId, isSynthetic } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    tenantId, isSynthetic, ownerId: vo.id, name: `Vendor ${RUN} ${tenantId === REVIEW ? 'fiction' : 'real'}`, slug: `v-${RUN}-${tenantId === REVIEW ? 'f' : 'r'}`,
    vendorType: 'RESTAURANT', phone: ownerPhone, addressLine1: '1 Main St', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true,
  } });
  const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu' } });
  await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Plate', basePrice: 1500, isAvailable: true } });
  return { ownerId: owner.id, vendorId: vendor.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // As server.ts does: a fresh tenant store per request BEFORE any auth hook,
  // so a bound tenant is visible to the handler (an enterWith inside an
  // awaited hook is not).
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Honesty fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    const rv = await visibleVendor(REVIEW, phone(1), true);
    const pv = await visibleVendor(PRODUCTION, phone(2), false);
    ids.reviewOwner = rv.ownerId; ids.reviewVendor = rv.vendorId; ids.prodOwner = pv.ownerId; ids.prodVendor = pv.vendorId;
    ids.reviewCustomer = (await app.prisma.user.create({ data: { phone: phone(3), firstName: 'F', lastName: 'C', activeRole: 'CUSTOMER', tenantId: REVIEW, isSynthetic: true } })).id;
    ids.prodCustomer = (await app.prisma.user.create({ data: { phone: phone(4), firstName: 'R', lastName: 'C', activeRole: 'CUSTOMER', tenantId: PRODUCTION } })).id;
    const order = (tenantId: string, customerId: string, vendorId: string, tag: string) => app.prisma.order.create({ data: {
      tenantId, orderNumber: `HN-${RUN}-${tag}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'DELIVERED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
      deliveryFee: 300, totalAmount: 1800, paymentMethod: 'CASH',
    } });
    ids.reviewOrder = (await order(REVIEW, ids.reviewCustomer, ids.reviewVendor, 'f')).id;
    ids.prodOrder = (await order(PRODUCTION, ids.prodCustomer, ids.prodVendor, 'r')).id;
    // The fiction's own taxonomy: one category, the review vendor in it.
    const cat = await app.prisma.discoveryCategory.create({ data: { tenantId: REVIEW, slug: SLUG, name: 'Fiction food', kind: 'CUISINE', vertical: 'FOOD', emoji: '🍛', status: 'ACTIVE' } });
    ids.category = cat.id;
    // Tenant-scoped child rows created in system mode carry the default tenant
    // unless told otherwise — the fiction's membership must say it is the fiction's.
    await app.prisma.vendorDiscoveryCategory.create({ data: { tenantId: REVIEW, vendorId: ids.reviewVendor, categoryId: cat.id, role: 'PRIMARY', source: 'VENDOR' } });
  });
  reviewToken = await bearerFor(ids.reviewCustomer);
  prodToken = await bearerFor(ids.prodCustomer);
  // The review gate needs a live session for the fiction's customer.
  await system(() => app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + 86_400_000), status: 'ANCHORED', anchorLat: 6.8, anchorLng: -58.15, anchorSource: 'DEVICE_GPS', anchoredAt: new Date() } }));
});

afterAll(async () => {
  await system(async () => {
    const users = [ids.reviewCustomer, ids.prodCustomer, ids.reviewOwner, ids.prodOwner];
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.order.deleteMany({ where: { id: { in: [ids.reviewOrder, ids.prodOrder] } } });
    await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.discoveryCategory.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: [ids.reviewVendor, ids.prodVendor] } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: [ids.reviewOwner, ids.prodOwner] } } });
    await app.prisma.ratingTagDef.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[RLS-N3] the public vendor surfaces show each session its own tenant', () => {
  it('/vendors: the reviewer sees the fiction and never a real vendor; a real customer sees the reverse', async () => {
    const r = await get('/api/v1/customer/vendors', reviewToken);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(ids.reviewVendor);
    expect(r.body).not.toContain(ids.prodVendor);
    const p = await get('/api/v1/customer/vendors', prodToken);
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain(ids.prodVendor);
    expect(p.body).not.toContain(ids.reviewVendor);
  });

  it('/home: the reviewer’s home never lists a real vendor; a real customer’s never lists the fiction', async () => {
    const r = await get(`/api/v1/customer/home?lat=6.8&lng=-58.15&_=${RUN}`, reviewToken);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(ids.prodVendor);
    const p = await get(`/api/v1/customer/home?lat=6.8&lng=-58.15&_=${RUN}`, prodToken);
    expect(p.statusCode).toBe(200);
    expect(p.body).not.toContain(ids.reviewVendor);
  });

  it('[DL-7] a GUEST’s home is the truth: every active production operator, never the fiction', async () => {
    const guest = await app.inject({ method: 'GET', url: `/api/v1/customer/home?lat=6.8&lng=-58.15&g=${RUN}` });
    expect(guest.statusCode).toBe(200);
    expect(guest.body).not.toContain(ids.reviewVendor);
    expect(guest.body).toContain(ids.prodVendor);
  });

  it('[4.1] under TENANT_UNSCOPED_ACCESS=deny a guest still browses (as audited public-browse work) and still never sees the fiction; the reviewer still sees only the fiction', async () => {
    const prior = process.env['TENANT_UNSCOPED_ACCESS'];
    process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
    try {
      const guest = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors?d=${RUN}` });
      expect(guest.statusCode).toBe(200);
      expect(guest.body).toContain(ids.prodVendor);
      expect(guest.body).not.toContain(ids.reviewVendor);
      const reviewer = await get(`/api/v1/customer/vendors?d=${RUN}`, reviewToken);
      expect(reviewer.statusCode).toBe(200);
      expect(reviewer.body).toContain(ids.reviewVendor);
      expect(reviewer.body).not.toContain(ids.prodVendor);
    } finally {
      if (prior === undefined) delete process.env['TENANT_UNSCOPED_ACCESS']; else process.env['TENANT_UNSCOPED_ACCESS'] = prior;
    }
  });

  it('[DL-7] browsing by category resolves the CALLER’s taxonomy: the fiction’s slug lists the fiction; production has no such category and is told so honestly', async () => {
    const r = await get(`/api/v1/customer/vendors?category=${SLUG}`, reviewToken);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(ids.reviewVendor);
    const p = await get(`/api/v1/customer/vendors?category=${SLUG}`, prodToken);
    expect(p.statusCode).toBe(200);
    expect(p.body).not.toContain(ids.reviewVendor);
    expect(p.body).not.toContain(ids.prodVendor);
  });

  it('rating tags follow the caller’s tenant: the fiction gets its own seeded set, in its own tenant', async () => {
    const r = await get('/api/v1/customer/rating-tags', reviewToken);
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).toMatch(/"slug"/);
    expect(await system(() => app.prisma.ratingTagDef.count({ where: { tenantId: REVIEW } }))).toBeGreaterThan(0);
  });
});

describe('[RLS-N6 / DL-4] the fiction is counted by nobody', () => {
  it('the predicates, run with NO tenant context, exclude the fiction’s people, vendors and orders', async () => {
    await system(async () => {
      expect(await app.prisma.user.count({ where: { id: { in: [ids.reviewCustomer, ids.prodCustomer] }, ...REAL_PEOPLE } })).toBe(1);
      expect(await app.prisma.vendor.count({ where: { id: { in: [ids.reviewVendor, ids.prodVendor] }, ...REAL_PEOPLE } })).toBe(1);
      expect(await app.prisma.order.count({ where: { id: { in: [ids.reviewOrder, ids.prodOrder] }, ...PRODUCTION_TENANT } })).toBe(1);
      const sum = await app.prisma.order.aggregate({ where: { id: { in: [ids.reviewOrder, ids.prodOrder] }, ...PRODUCTION_TENANT }, _sum: { totalAmount: true }, _count: true });
      expect(sum._count).toBe(1);
      expect(Number(sum._sum.totalAmount)).toBe(1800);
    });
  });

  it('every aggregate of people or money in the stats module carries an explicit production predicate — belt as well as braces', () => {
    const src = readFileSync(join(__dirname, '..', 'modules', 'admin', 'platform-stats.ts'), 'utf8');
    const calls = [...src.matchAll(/prisma\.(user|order|vendor|rider|driver)\.(count|aggregate|groupBy)\(([\s\S]*?)\),\n/g)];
    expect(calls.length).toBeGreaterThanOrEqual(10);
    const bare = calls.filter((m) => !/PRODUCTION_TENANT|REAL_PEOPLE/.test(m[3]!)).map((m) => `${m[1]}.${m[2]}`);
    expect(bare).toEqual([]);
  });

  it('the stats function runs as a job would — no tenant context — and returns every figure', async () => {
    const stats = await system(() => platformStats(app.prisma, { tenantId: PRODUCTION, today: new Date(0), subscriptionScope: {} }));
    expect(Object.keys(stats).sort()).toEqual(['activeDrivers', 'activeRiders', 'activeSubscriptions', 'activeVendors', 'pastDueSubs', 'pendingVendors', 'todayNewUsers', 'todayOrders', 'todayRevenue', 'totalOrders', 'totalUsers', 'totalVendors', 'unassignedOrders']);
    expect(stats.totalUsers).toBeGreaterThanOrEqual(1);
  });
});
