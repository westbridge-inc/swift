import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { collapseBrands, type BrandFact } from '../modules/vendor/brand';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [CHAINS PR3 · owner 29 Oct 2026] "One brand card ('Royal Castle') opening the nearest open branch that delivers to
// them; customer can pick another branch." A brand is an owner whose name Swift set (VendorOwner.brandName). On Home,
// browse and search a brand's branches are ONE card, opening: open + taking orders + delivers to the customer, else
// open + taking orders, else the nearest. The storefront lists the brand's branches the customer may switch to (best
// first). A branch Swift lists on its own keeps its own card; a store with no brand is untouched; nothing a list may
// not show is ever shown (a suspended branch, another owner's store).
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TENANT = `brand-${RUN}`;
const WORD = 'zorvette';
const DAY = 864e5;
const HERE = { lat: 6.8, lng: -58.15 };
let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const ids: Record<string, string> = {};
const restoreEnv = process.env['PUBLIC_TENANT_ID'];
const restoreSearchUrl = process.env['MEILISEARCH_URL'];

async function owner(brandName: string | null) {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Brand', lastName: `Owner${userIds.length}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, tenantId: TENANT,
  } });
  userIds.push(u.id);
  const o = await app.prisma.vendorOwner.create({ data: { userId: u.id, brandName } });
  ownerIds.push(o.id);
  return o.id;
}

async function store(key: string, ownerId: string, opts: { lat: number; open?: boolean; radius?: number; status?: 'ACTIVE' | 'SUSPENDED'; alone?: boolean }) {
  const v = await app.prisma.vendor.create({ data: {
    ownerId, tenantId: TENANT, name: `${WORD} ${key}`, slug: `brand-${RUN}-${key.toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: `${key} Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: opts.lat, longitude: HERE.lng,
    status: opts.status ?? 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: opts.open ?? true,
    deliveryRadius: opts.radius ?? 10, averageRating: 4.9, brandListedAlone: opts.alone ?? false,
  } });
  vendorIds.push(v.id);
  const shelf = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Menu', sortOrder: 0 } });
  await app.prisma.item.create({ data: { vendorId: v.id, categoryId: shelf.id, name: `${WORD} ${key} plate`, basePrice: 1500, isAvailable: true } });
  ids[key] = v.id;
}

let brandOwner = '';

beforeAll(async () => {
  process.env['MEILISEARCH_URL'] = 'http://127.0.0.1:9';
  process.env['PUBLIC_TENANT_ID'] = TENANT;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
  await app.prisma.tenant.create({ data: { id: TENANT, name: `Brand ${RUN}`, slug: TENANT } });
  brandOwner = await owner('Royal Zorvette');
  // ~111 m per 0.001 degree of latitude.
  await store('Far', brandOwner, { lat: HERE.lat + 0.027, radius: 1 }); // ~3 km, open, does NOT deliver here
  await store('Near', brandOwner, { lat: HERE.lat + 0.0045 }); // ~0.5 km, open, delivers
  await store('Shut', brandOwner, { lat: HERE.lat + 0.0018, open: false }); // nearest, closed
  await store('Alone', brandOwner, { lat: HERE.lat + 0.009, alone: true }); // listed on its own
  await store('Gone', brandOwner, { lat: HERE.lat + 0.001, status: 'SUSPENDED' }); // never shown
  await store('Other', await owner(null), { lat: HERE.lat + 0.002 }); // another business, no brand
  // The chain sells the same dish at two branches (and the other business sells one of the same name).
  for (const key of ['Near', 'Far', 'Other']) {
    const shelf = await app.prisma.category.findFirstOrThrow({ where: { vendorId: ids[key]! } });
    await app.prisma.item.create({ data: { vendorId: ids[key]!, categoryId: shelf.id, name: `${WORD} Two Piece`, basePrice: 1800, isAvailable: true, totalOrdered: key === 'Far' ? 9_000_001 : 9_000_000 } });
  }
  const customer = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Brand', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    tenantId: TENANT, isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userIds.push(customer.id);
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: customer.id, token, refreshToken: nanoid(48), deviceId: 'brand-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: TENANT } });
  await app.close();
  if (restoreEnv === undefined) delete process.env['PUBLIC_TENANT_ID']; else process.env['PUBLIC_TENANT_ID'] = restoreEnv;
  if (restoreSearchUrl === undefined) delete process.env['MEILISEARCH_URL']; else process.env['MEILISEARCH_URL'] = restoreSearchUrl;
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const at = `lat=${HERE.lat}&lng=${HERE.lng}`;
type Card = { id: string; brand: { name: string; branches: number } | null };
const mine = (cards: Card[]) => cards.filter((c) => Object.values(ids).includes(c.id));
const flush = () => app.redis.flushdb();

describe('[CHAINS] collapseBrands (the rule)', () => {
  const row = (id: string, open: boolean, km: number, radius = 10, accepting = true) =>
    ({ id, isCurrentlyOpen: open, acceptingOrders: accepting, latitude: 6.8 + km / 111, longitude: -58.15, deliveryRadius: radius });
  const facts = (rows: ReturnType<typeof row>[]) => new Map<string, BrandFact>(rows.map((r) => [r.id, { ownerId: 'o1', name: 'Royal', row: r }]));
  it('open + delivers beats a nearer closed or paused branch and a nearer open branch that does not deliver', () => {
    const rows = [row('shut', false, 0.1), row('paused', true, 0.2, 10, false), row('short', true, 0.3, 0.1), row('good', true, 2)];
    expect(collapseBrands(rows, facts(rows), { lat: 6.8, lng: -58.15 }).map((r) => [r.id, r.brand?.branches])).toEqual([['good', 4]]);
  });
  it('none delivers: the nearest open; none open: the nearest; no place: the list\'s own first', () => {
    const open = [row('a', true, 3, 1), row('b', true, 2, 1), row('c', false, 0.1)];
    expect(collapseBrands(open, facts(open), { lat: 6.8, lng: -58.15 })[0]!.id).toBe('b');
    const shut = [row('x', false, 3), row('y', false, 1)];
    expect(collapseBrands(shut, facts(shut), { lat: 6.8, lng: -58.15 })[0]!.id).toBe('y');
    expect(collapseBrands(shut, facts(shut), {})[0]!.id).toBe('x');
  });
  it('the brand keeps its first place in the list; stores with no brand are untouched', () => {
    const rows = [row('plain1', true, 1), row('b1', true, 5), row('plain2', true, 1), row('b2', true, 0.5)];
    const f = facts(rows.filter((r) => r.id.startsWith('b')));
    expect(collapseBrands(rows, f, { lat: 6.8, lng: -58.15 }).map((r) => [r.id, r.brand])).toEqual([
      ['plain1', null], ['b2', { name: 'Royal', branches: 2 }], ['plain2', null],
    ]);
  });
});

describe('[CHAINS] one brand card on Home, browse and search', () => {
  it('Home: the brand once (its open branch that delivers here); the branch listed alone and the other business stay', async () => {
    await flush();
    const res = await get(`/api/v1/customer/home?${at}`);
    expect(res.statusCode, res.body).toBe(200);
    const feed = res.json().data as { openVendors: Card[]; closedVendors: Card[]; nearby: Card[] };
    const open = mine(feed.openVendors);
    expect(open.map((c) => c.id).sort()).toEqual([ids['Near'], ids['Alone'], ids['Other']].sort());
    expect(open.find((c) => c.id === ids['Near'])!.brand).toEqual({ name: 'Royal Zorvette', branches: 3 });
    expect(open.find((c) => c.id === ids['Alone'])!.brand).toBeNull();
    expect(open.find((c) => c.id === ids['Other'])!.brand).toBeNull();
    expect(mine(feed.closedVendors).map((c) => c.id), 'the closed branch is inside the brand card').toEqual([]);
    expect(mine(feed.nearby).filter((c) => c.id === ids['Far'] || c.id === ids['Shut'])).toEqual([]);
  });

  it('Home "popular": a chain\'s dish sold at several branches shows once (the most-ordered); another business\'s keeps its own', async () => {
    await flush();
    const items = (await get(`/api/v1/customer/home?${at}`)).json().data.popularItems as Array<{ name: string; vendorId: string }>;
    const twoPiece = items.filter((i) => i.name === `${WORD} Two Piece`);
    expect(twoPiece.map((i) => i.vendorId).sort()).toEqual([ids['Far'], ids['Other']].sort());
  });

  it('browse: one card per brand on the page', async () => {
    const res = await get(`/api/v1/customer/vendors?search=${WORD}&sort=distance&${at}&limit=50`);
    expect(res.statusCode, res.body).toBe(200);
    const cards = mine(res.json().data as Card[]);
    expect(cards.filter((c) => c.brand !== null).map((c) => c.id)).toEqual([ids['Near']]);
    expect(cards.map((c) => c.id)).not.toContain(ids['Far']);
    expect(cards.map((c) => c.id)).not.toContain(ids['Shut']);
  });

  it('search (the database path, signed in and as a guest): one card per brand', async () => {
    for (const headers of [{ authorization: `Bearer ${token}` }, {}]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/search?q=${WORD}&limit=20&${at}`, headers });
      expect(res.statusCode, res.body).toBe(200);
      const vendors = mine(res.json().data.vendors as Card[]);
      expect(vendors.filter((c) => c.brand !== null).map((c) => [c.id, c.brand!.branches])).toEqual([[ids['Near'], 3]]);
      expect(vendors.map((c) => c.id)).toEqual(expect.arrayContaining([ids['Alone'], ids['Other']]));
    }
  });

  it('nearby: one card per brand', async () => {
    const res = await get(`/api/v1/search/nearby?${at}&radius=10&limit=50`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = mine(res.json().data as Card[]);
    expect(rows.filter((c) => c.brand !== null).map((c) => c.id)).toEqual([ids['Near']]);
  });

  it('no brand set: every branch on its own card, exactly as before', async () => {
    await app.prisma.vendorOwner.update({ where: { id: brandOwner }, data: { brandName: null } });
    try {
      await flush();
      const feed = (await get(`/api/v1/customer/home?${at}`)).json().data as { openVendors: Card[]; closedVendors: Card[] };
      expect(mine(feed.openVendors).map((c) => c.id).sort()).toEqual([ids['Near'], ids['Far'], ids['Alone'], ids['Other']].sort());
      expect(mine(feed.closedVendors).map((c) => c.id)).toEqual([ids['Shut']]);
      expect(mine(feed.openVendors).every((c) => c.brand === null)).toBe(true);
    } finally {
      await app.prisma.vendorOwner.update({ where: { id: brandOwner }, data: { brandName: 'Royal Zorvette' } });
    }
  });
});

describe('[CHAINS] the storefront lets the customer pick another branch', () => {
  it('the brand\'s branches the customer may see, best first, this one marked; never a suspended branch, one listed alone, or another business', async () => {
    const res = await get(`/api/v1/customer/vendors/${ids['Far']}?${at}`);
    expect(res.statusCode, res.body).toBe(200);
    const brand = res.json().data.brand as { name: string; branches: Array<{ id: string; current: boolean; delivers: boolean | null; isCurrentlyOpen: boolean }> };
    expect(brand.name).toBe('Royal Zorvette');
    expect(brand.branches.map((b) => b.id)).toEqual([ids['Near'], ids['Far'], ids['Shut']]);
    expect(brand.branches.find((b) => b.id === ids['Far'])).toMatchObject({ current: true, delivers: false });
    expect(brand.branches.find((b) => b.id === ids['Near'])).toMatchObject({ current: false, delivers: true });
  });

  it('a branch listed alone, or a store with no brand: no switcher', async () => {
    expect((await get(`/api/v1/customer/vendors/${ids['Alone']}`)).json().data.brand).toBeNull();
    expect((await get(`/api/v1/customer/vendors/${ids['Other']}`)).json().data.brand).toBeNull();
  });

  it('the website\'s store page carries the same switcher (no place known: the list keeps its order)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/brand-${RUN}-near` });
    expect(res.statusCode, res.body).toBe(200);
    const brand = res.json().data.brand as { name: string; branches: Array<{ id: string; slug: string }> };
    expect(brand.name).toBe('Royal Zorvette');
    expect(brand.branches.map((b) => b.id).sort()).toEqual([ids['Near'], ids['Far'], ids['Shut']].sort());
    expect(brand.branches.every((b) => typeof b.slug === 'string')).toBe(true);
  });
});
