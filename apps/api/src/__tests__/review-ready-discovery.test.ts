import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { discoveryRoutes, resetDiscoveryCacheForTests, CATEGORY_DISCOVERY_FLAG } from '../modules/discovery/discovery.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [REVIEW-READY] What an App Store reviewer abroad sees on Home.
//
// Measured on staging, 1 Oct 2026: from Apple Park every store card said
// 9,422.5 km, 22,650 minutes and a GY$1,884,603 delivery fee; the category
// rail's radius filter left every category with no store; and Home's
// "Recommended for you" said "Nothing's open right now" beside five open stores,
// because no store has 10 orders yet. A point in no launch market now reads
// exactly as no point, and the featured rail falls back to the open stores
// until one qualifies.
// ---------------------------------------------------------------------------

const ABROAD = { lat: 37.3349, lng: -122.009 }; // Apple Park, California
const GEORGETOWN = { lat: 6.8013, lng: -58.1551 };
const STORE = { lat: 6.806, lng: -58.152 };

let app: FastifyInstance;
let token: string;
let userId: string;
let vendorId: string;
let itemId: string;
const tenantId = `rr-tenant-${nanoid(8).toLowerCase()}`;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let discoveryCategoryId: string;
let priorRailFlag: { value: unknown } | null = null;
let seq = 0;

const auth = () => ({ authorization: `Bearer ${token}` });
const at = (p: { lat: number; lng: number }) => `lat=${p.lat}&lng=${p.lng}`;
const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url, headers: auth() });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json() as { data: any };
};

async function makeStore(opts: { averageRating?: number; totalOrders?: number }) {
  seq += 1;
  const ownerUser = await app.prisma.user.create({
    data: {
      phone: `+59200772${String(seq).padStart(2, '0')}`,
      firstName: 'Ready', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId,
    },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, tenantId,
      name: `Ready Store ${seq}`,
      slug: `ready-store-${nanoid(6).toLowerCase()}-${seq}`,
      vendorType: 'RESTAURANT',
      phone: `+59200773${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Ready Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      averageRating: opts.averageRating ?? 0, totalOrders: opts.totalOrders ?? 0,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0, tenantId } });
  const item = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: category.id, name: `Ready dish ${seq}`, basePrice: 1200, isAvailable: true, tenantId },
  });
  return { vendorId: vendor.id, itemId: item.id };
}

async function clearHomeCache() {
  const keys = await app.redis.keys(`*home:${userId}:*`);
  if (keys.length) await app.redis.del(...keys);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(discoveryRoutes, { prefix: '/api/v1/discovery' });
  await app.ready();

  // A crashed earlier run must not leave its fixtures behind.
  const stale = await app.prisma.user.findMany({
    where: { OR: [{ phone: { startsWith: '+59200771' } }, { phone: { startsWith: '+59200772' } }] }, select: { id: true },
  });
  if (stale.length) {
    const staleOwners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: stale.map((u) => u.id) } }, select: { id: true } });
    const staleVendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: staleOwners.map((o) => o.id) } }, select: { id: true } });
    const ids = staleVendors.map((v) => v.id);
    await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: ids } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: stale.map((u) => u.id) } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: ids } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: ids } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: staleOwners.map((o) => o.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  }
  await app.prisma.discoveryCategory.deleteMany({ where: { tenantId: { startsWith: 'rr-tenant-' } } });
  await app.prisma.tenant.deleteMany({ where: { id: { startsWith: 'rr-tenant-' } } });

  await app.prisma.tenant.create({ data: { id: tenantId, name: 'Review-ready test operator', slug: tenantId } });

  const user = await app.prisma.user.create({
    data: {
      phone: `+59200771${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Ready', lastName: 'Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId,
      customer: { create: {} },
    },
  });
  userId = user.id;
  createdUserIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: `rr-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  // One open, verified store with no rating and no orders: a store on launch day.
  ({ vendorId, itemId } = await makeStore({}));

  // The category rail (flag-gated), with the store tagged into one category.
  priorRailFlag = await app.prisma.platformConfig.findUnique({ where: { key: CATEGORY_DISCOVERY_FLAG }, select: { value: true } });
  await app.prisma.platformConfig.upsert({
    where: { key: CATEGORY_DISCOVERY_FLAG },
    create: { key: CATEGORY_DISCOVERY_FLAG, value: true },
    update: { value: true },
  });
  const dc = await app.prisma.discoveryCategory.create({
    data: { tenantId, slug: `rr-cat-${nanoid(5).toLowerCase()}`, name: 'Ready Food', kind: 'CUISINE', vertical: 'FOOD', emoji: '🍲', aliases: [] },
  });
  discoveryCategoryId = dc.id;
  await app.prisma.vendorDiscoveryCategory.create({
    data: { tenantId, vendorId, categoryId: dc.id, role: 'PRIMARY', source: 'ADMIN' },
  });
  resetDiscoveryCacheForTests();

  // Warm-up. In this inject-only harness (no app.ts tenant plumbing) the FIRST
  // signed-in request of a session is served before the customer's tenant is
  // bound, so it reads every operator's seeded stores; from the second request
  // on, only this tenant's. The real app binds from the first request (live
  // check on staging, 1 Oct: the reviewer's first Home showed exactly the five
  // demo stores). Every comparison below runs in the bound, steady state.
  await get('/api/v1/customer/home');
});

afterAll(async () => {
  await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  if (discoveryCategoryId) await app.prisma.discoveryCategory.deleteMany({ where: { id: discoveryCategoryId } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: tenantId } });
  if (priorRailFlag) {
    await app.prisma.platformConfig.update({ where: { key: CATEGORY_DISCOVERY_FLAG }, data: { value: priorRailFlag.value as never } });
  } else {
    await app.prisma.platformConfig.deleteMany({ where: { key: CATEGORY_DISCOVERY_FLAG } });
  }
  resetDiscoveryCacheForTests();
  await app.close();
});

type Card = { id: string; distanceKm: number | null; etaMin: number | null; deliveryFee: number | null };
const priced = (cards: Card[]) => cards.map((c) => ({ id: c.id, distanceKm: c.distanceKm, etaMin: c.etaMin, deliveryFee: c.deliveryFee }));

describe('a location in no launch market reads exactly as no location', () => {
  it('Home: the same cards, ETAs and fees as location-off, and nothing "nearby"', async () => {
    await clearHomeCache();
    const off = (await get('/api/v1/customer/home')).data;
    await clearHomeCache();
    const abroad = (await get(`/api/v1/customer/home?${at(ABROAD)}`)).data;
    expect(priced(abroad.openVendors)).toEqual(priced(off.openVendors));
    expect(abroad.popularItems.map((i: { id: string; etaMin: number | null }) => [i.id, i.etaMin]))
      .toEqual(off.popularItems.map((i: { id: string; etaMin: number | null }) => [i.id, i.etaMin]));
    expect(abroad.nearby).toEqual([]);
    const card = (abroad.openVendors as Card[]).find((v) => v.id === vendorId);
    expect(card).toBeDefined();
    expect([card!.distanceKm, card!.etaMin, card!.deliveryFee]).toEqual([null, null, null]);
  });

  it('browse, a store page and favourites: no distance, ETA or fee priced across an ocean', async () => {
    const offList = (await get('/api/v1/customer/vendors')).data as Card[];
    const abroadList = (await get(`/api/v1/customer/vendors?${at(ABROAD)}`)).data as Card[];
    expect(priced(abroadList)).toEqual(priced(offList));
    expect(priced(abroadList).find((c) => c.id === vendorId)).toEqual({ id: vendorId, distanceKm: null, etaMin: null, deliveryFee: null });

    const offStore = (await get(`/api/v1/customer/vendors/${vendorId}`)).data;
    const abroadStore = (await get(`/api/v1/customer/vendors/${vendorId}?${at(ABROAD)}`)).data;
    expect({ d: abroadStore.distanceKm, e: abroadStore.etaMin, f: abroadStore.deliveryFee })
      .toEqual({ d: offStore.distanceKm, e: offStore.etaMin, f: offStore.deliveryFee });
    expect(abroadStore.distanceKm ?? null).toBeNull();

    const fav = await app.inject({ method: 'POST', url: `/api/v1/customer/favorites/${vendorId}`, headers: auth(), payload: {} });
    expect(fav.statusCode, fav.body).toBeLessThan(300);
    const offFav = (await get('/api/v1/customer/favorites')).data as Card[];
    const abroadFav = (await get(`/api/v1/customer/favorites?${at(ABROAD)}`)).data as Card[];
    expect(priced(abroadFav)).toEqual(priced(offFav));
  });

  it('the cart preview: the same delivery fee and times as location-off', async () => {
    const add = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items', headers: auth(),
      payload: { vendorId, itemId, quantity: 1 },
    });
    expect(add.statusCode, add.body).toBeLessThan(300);
    const pick = (c: any) => ({
      deliveryFee: c.deliveryFee, deliveryDistanceKm: c.deliveryDistanceKm,
      estimatedDeliveryMin: c.estimatedDeliveryMin, estimatedTotalMin: c.estimatedTotalMin, totalAmount: c.totalAmount,
    });
    const off = pick((await get('/api/v1/customer/cart')).data);
    const abroad = pick((await get(`/api/v1/customer/cart?${at(ABROAD)}`)).data);
    expect(abroad).toEqual(off);
  });

  it('the category rail: a category keeps its open store instead of emptying', async () => {
    resetDiscoveryCacheForTests();
    const off = (await get('/api/v1/discovery/categories?vertical=FOOD')).data;
    resetDiscoveryCacheForTests();
    const abroad = (await get(`/api/v1/discovery/categories?vertical=FOOD&${at(ABROAD)}`)).data;
    expect(off.enabled).toBe(true);
    expect(off.categories.length).toBeGreaterThan(0);
    expect(abroad).toEqual(off);
  });

  it('inside Guyana nothing changes: Georgetown still gets a real distance, ETA and fee', async () => {
    const list = (await get(`/api/v1/customer/vendors?${at(GEORGETOWN)}`)).data as Card[];
    const card = list.find((c) => c.id === vendorId)!;
    expect(card.distanceKm).not.toBeNull();
    expect(card.distanceKm!).toBeLessThan(5);
    expect(card.etaMin).not.toBeNull();
    expect(card.deliveryFee).not.toBeNull();
    resetDiscoveryCacheForTests();
    const rail = (await get(`/api/v1/discovery/categories?vertical=FOOD&${at(GEORGETOWN)}`)).data;
    expect(rail.categories.length).toBeGreaterThan(0);
  });
});

describe('Home never says nothing is open while stores are open', () => {
  it('with no store at the featured bar, the open stores fill "featured"', async () => {
    await clearHomeCache();
    const home = (await get('/api/v1/customer/home')).data;
    expect((home.openVendors as Card[]).map((v) => v.id)).toContain(vendorId);
    expect((home.featured as Card[]).map((v) => v.id)).toContain(vendorId);
  });

  it('once one store meets the bar, only qualifying stores are featured', async () => {
    const earned = await makeStore({ averageRating: 4.6, totalOrders: 12 });
    await clearHomeCache();
    const home = (await get('/api/v1/customer/home')).data;
    const featured = (home.featured as Card[]).map((v) => v.id);
    expect(featured).toEqual([earned.vendorId]);
    expect((home.openVendors as Card[]).map((v) => v.id)).toEqual(expect.arrayContaining([vendorId, earned.vendorId]));
  });
});

describe('every discovery door passes the customer point through customerPoint', () => {
  // A source census: a new route (or a refactor) that parses lat/lng straight
  // from the query would quietly re-open the ocean-priced card.
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
  it('customer, discovery and search routes', () => {
    const customer = read('modules/user/customer.routes.ts');
    expect(customer).not.toMatch(/=\s*(latLngQuerySchema|vendorsBrowseQuerySchema|cartQuerySchema)\.parse\(/);
    expect(customer.match(/customerPoint\((latLngQuerySchema|vendorsBrowseQuerySchema|cartQuerySchema)\.parse\(request\.query\)\)/g)?.length).toBe(5);
    expect(read('modules/discovery/discovery.routes.ts')).toMatch(/const query = customerPoint\(z\.object\(/);
    expect(read('modules/search/search.routes.ts')).toMatch(/= customerPoint\(searchQuerySchema\.parse\(request\.query\)\)/);
  });
});
