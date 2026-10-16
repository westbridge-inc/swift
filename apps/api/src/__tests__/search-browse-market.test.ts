import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { launchMarketAt, launchMarketWhere } from '../modules/auth/launch-market';

// ---------------------------------------------------------------------------
// [Review S3-PRE] The store-list search (/customer/vendors?search=, the app's
// Shops and Services chips) had no launch-market check: #1563 put the rule
// on every /search rail ("a store outside the launch market is never found")
// but this door listed a store pinned outside Guyana. The rule is applied IN
// the query (the market is a box), so the page, its total and its tier choice
// all agree. Fixtures are invented.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TENANT = `sfm-${RUN}`;
const PHONE_PREFIX = '+59200766';
const WORD = 'zandravel';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const vendorIds: string[] = [];
const ids: Record<string, string> = {};

let seq = 0;
async function store(key: string, name: string, at: { latitude: number; longitude: number }) {
  seq += 1;
  const owner = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Sfm', lastName: `Owner${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, tenantId: TENANT },
  });
  userIds.push(owner.id);
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, tenantId: TENANT, name, slug: `sfm-${RUN}-${seq}`, vendorType: 'STORE',
      phone: `${PHONE_PREFIX}${String(500 + seq)}`, addressLine1: '1 Fake Row', city: 'Somewhere', region: 'Somewhere',
      ...at, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true,
    },
  });
  vendorIds.push(vendor.id);
  const shelf = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } });
  await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: shelf.id, name: `${name} goods`, basePrice: 900, isAvailable: true } });
  ids[key] = vendor.id;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.addHook('onRequest', (_request, _reply, done) => { beginRequestTenantContext(); done(); });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await app.prisma.tenant.create({ data: { id: TENANT, name: `Sfm ${RUN}`, slug: TENANT } });
  await store('georgetown', `${WORD} Hardware Georgetown`, { latitude: 6.801, longitude: -58.156 });
  await store('abroad', `${WORD} Hardware Abroad`, { latitude: 25.76, longitude: -80.19 });
  await store('sea', `${WORD} Hardware Offshore`, { latitude: 12.5, longitude: -58.2 });
  const customer = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}999`, firstName: 'Sfm', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: TENANT, isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  userIds.push(customer.id);
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: customer.id, token, refreshToken: nanoid(48), deviceId: 'sfm-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: TENANT } });
  await app.close();
});

async function browse(q: string, signedIn: boolean) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors?search=${encodeURIComponent(q)}&limit=50`, headers: signedIn ? { authorization: `Bearer ${token}` } : {} });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return { ids: (body.data as Array<{ id: string }>).map((v) => v.id).filter((id) => vendorIds.includes(id)), total: body.pagination?.total ?? body.meta?.total };
}

describe('the store-list search keeps to the launch market', () => {
  it.each([true, false])('a store pinned outside the market is never listed (signed in: %s)', async (signedIn) => {
    const r = await browse(`${WORD} hardware`, signedIn);
    expect(r.ids).toEqual([ids['georgetown']]);
    expect(r.total).toBe(1); // the total agrees with the page: the market is in the query, not a filter after it
  });

  it('a search whose only match lies outside the market finds nothing', async () => {
    const r = await browse('abroad', true);
    expect(r.ids).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('when the exact match lies only outside the market, the page falls through to the matches inside it (the tier is chosen with the market applied)', async () => {
    // "zandravel abroad": every word matches only the store abroad; any word matches the Georgetown store
    expect((await browse(`${WORD} abroad`, true)).ids).toEqual([ids['georgetown']]);
  });

  it('the SQL rule is the same as the in-memory one (#1563) at the box edges', () => {
    const where = launchMarketWhere();
    const inBox = (lat: number, lng: number) => (where.OR as Array<{ latitude: { gte: number; lte: number }; longitude: { gte: number; lte: number } }>)
      .some((b) => lat >= b.latitude.gte && lat <= b.latitude.lte && lng >= b.longitude.gte && lng <= b.longitude.lte);
    for (const [lat, lng] of [[6.8, -58.15], [1, -62], [9, -56], [0.999, -58], [9.001, -58], [5, -62.001], [5, -55.999], [25.76, -80.19]] as const) {
      expect(inBox(lat, lng), `${lat},${lng}`).toBe(launchMarketAt(lat, lng) !== null);
    }
  });
});
