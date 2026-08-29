import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { marketRoutes } from '../modules/market/market.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// THE MARKET FEED [MKT G1] — items across stores, by category.
//
// The Market tab shipped as a SHOP DIRECTORY: vendor cards that opened a store.
// The ask was a CATALOGUE — items by category, spanning every store, "like
// Amazon". One lists shops; the other lists things.
//
// Everything that difference needed already existed except the endpoint that
// joins them. So the risk in this build is not "does it work" — it is that a
// connection job quietly becomes a construction job, or that it filters on the
// WRONG CATEGORY SYSTEM. That second one is the highest-risk mistake available
// here, because it returns plausible data:
//
//   Item.categoryId          → the VENDOR's own shelf ("City Hardware · Power
//                              Tools"), cascade-deleted with the vendor
//   ItemDiscoveryCategory    → the CROSS-VENDOR shopper's taxonomy
//
// A feed filtered on the first looks correct and silently returns one shop's
// aisle wearing a category's name. The test below is built so that mistake
// cannot pass: two vendors both have an item on the SAME discovery category,
// and each item ALSO sits in a differently-named vendor-scoped category.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdVendorIds: string[] = [];
const createdUserIds: string[] = [];
const createdItemIds: string[] = [];
const createdCategoryIds: string[] = [];
const PHONE_PREFIX = '+59200941';
const SLUG = `mkt-tools-${nanoid(6)}`;

let seq = 0;
async function makeVendor(name: string, opts: { visible?: boolean; type?: 'STORE' | 'RESTAURANT' | 'SERVICE' | 'SUPERMARKET' } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Mkt', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid(6)}`,
      vendorType: opts.type ?? 'STORE',
      // The visibility predicate is the subject of one test below; an invisible
      // vendor is made invisible the way the platform actually does it.
      status: opts.visible === false ? 'SUSPENDED' : 'ACTIVE',
      isVerified: opts.visible !== false,
      addressLine1: '1 Market Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551,
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function makeItem(vendorId: string, name: string, opts: {
  price?: number; available?: boolean; totalOrdered?: number; createdAt?: Date;
  shelf?: string;              // the VENDOR-scoped category name
  discovery?: string | null;   // the CROSS-VENDOR category id
} = {}) {
  // Every item gets a vendor-scoped category too — that is the decoy.
  const shelf = await app.prisma.category.create({
    data: { vendorId, name: opts.shelf ?? 'Misc', sortOrder: 0 },
  });
  const item = await app.prisma.item.create({
    data: {
      vendorId,
      categoryId: shelf.id,
      name,
      basePrice: opts.price ?? 1000,
      isAvailable: opts.available !== false,
      totalOrdered: opts.totalOrdered ?? 0,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  createdItemIds.push(item.id);
  if (opts.discovery) {
    await app.prisma.itemDiscoveryCategory.create({
      data: { itemId: item.id, categoryId: opts.discovery, source: 'ADMIN' },
    });
  }
  return item;
}

const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1/market${url}` });
const names = (body: any): string[] => (body?.data?.items ?? []).map((i: any) => i.name);

let categoryId = '';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.ready();

  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (stale.length) {
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: stale.map((u) => u.id) } }, select: { id: true } });
    const vendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: owners.map((o) => o.id) } }, select: { id: true } });
    const vids = vendors.map((v) => v.id);
    const items = await app.prisma.item.findMany({ where: { vendorId: { in: vids } }, select: { id: true } });
    await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vids } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vids } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vids } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  }

  const cat = await app.prisma.discoveryCategory.create({
    data: { slug: SLUG, name: 'Hardware & tools', kind: 'RETAIL', vertical: 'RETAIL', emoji: '\u{1F528}', status: 'ACTIVE', sortWeight: 1 },
  });
  createdCategoryIds.push(cat.id);
  categoryId = cat.id;
});

afterAll(async () => {
  await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: createdItemIds } } });
  await app.prisma.item.deleteMany({ where: { id: { in: createdItemIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.discoveryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await app.close();
});

describe('it lists THINGS, across stores — not shops', () => {
  it('one category returns items from DIFFERENT vendors', async () => {
    // The whole point. A shop directory cannot produce this shape.
    const a = await makeVendor('Alpha Hardware');
    const b = await makeVendor('Beta Tools');
    await makeItem(a.id, `Hammer ${nanoid(4)}`, { discovery: categoryId, shelf: 'Alpha Aisle 3' });
    await makeItem(b.id, `Wrench ${nanoid(4)}`, { discovery: categoryId, shelf: 'Beta Bay 1' });

    const res = await get(`/items?category=${SLUG}&limit=50`);

    expect(res.statusCode).toBe(200);
    const items = res.json().data.items;
    const vendors = new Set(items.map((i: any) => i.vendorId));
    expect(vendors.size, 'a category must span stores, or it is a shop shelf').toBeGreaterThanOrEqual(2);
    expect(items.every((i: any) => i.vendorName)).toBe(true);
  });

  it('filters on the CROSS-VENDOR taxonomy, never the store shelf', async () => {
    // THE highest-risk mistake. Each item's vendor-scoped category is named
    // differently from the discovery slug, and an untagged item exists on a
    // shelf whose name would tempt a `categoryId` filter. Only the tagged ones
    // may come back.
    const v = await makeVendor('Gamma Supplies');
    const tagged = await makeItem(v.id, `Chisel ${nanoid(4)}`, { discovery: categoryId, shelf: 'Gamma Shelf' });
    const untagged = await makeItem(v.id, `Decoy ${nanoid(4)}`, { discovery: null, shelf: 'Hardware & tools' });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    const ids = res.json().data.items.map((i: any) => i.id);

    expect(ids).toContain(tagged.id);
    expect(
      ids,
      'this item is only in a VENDOR category that happens to share the name — it is one shop\'s shelf',
    ).not.toContain(untagged.id);
  });

  it('an unknown category is a 404, not a silently empty grid', async () => {
    // An empty grid reads as "Swift sells nothing", which is a lie about the
    // catalogue rather than an answer about the slug.
    const res = await get('/items?category=not-a-real-category');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CATEGORY_NOT_FOUND');
  });
});

describe('the Market is GOODS — not dishes, not services', () => {
  // SHIPPED BROKEN AND CAUGHT ON A DEVICE. `vertical` was parsed and then never
  // used in the query, so the goods tab filled with restaurant dishes — Dhal
  // Puri, Pork Chops, Margherita — beside service listings. A parameter that
  // filters nothing is the same lie this feed refuses `lat`/`lng` for.
  //
  // It returned PLAUSIBLE data, which is why it survived review: real items,
  // real stores, real prices, correctly paginated. Only the wrong ones.
  it('a restaurant dish never reaches the market tab', async () => {
    const kitchen = await makeVendor('Royal Roti Hut', { type: 'RESTAURANT' });
    // Tagged into the fixture category so the assertion is about the VERTICAL
    // filter and not about which page a busy catalogue put the row on. An
    // earlier version queried the unfiltered feed at limit=50 and passed
    // vacuously — the dish was simply not on page one.
    const dish = await makeItem(kitchen.id, `Dhal Puri ${nanoid(4)}`, { discovery: categoryId, shelf: 'Roti' });

    const res = await get(`/items?category=${SLUG}&limit=50`);

    expect(res.statusCode).toBe(200);
    expect(
      res.json().data.items.map((i: any) => i.id),
      'a dish is a real catalogue item with its own tab — it is not this one',
    ).not.toContain(dish.id);
  });

  it('a service listing never reaches it either', async () => {
    const trade = await makeVendor('Kingston Electrical', { type: 'SERVICE' });
    const job = await makeItem(trade.id, `Rewire ${nanoid(4)}`, { discovery: categoryId, shelf: 'Jobs' });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.items.map((i: any) => i.id)).not.toContain(job.id);
  });

  it('a supermarket aisle is not the market either', async () => {
    const shop = await makeVendor('Bounty Super', { type: 'SUPERMARKET' });
    const tin = await makeItem(shop.id, `Milk ${nanoid(4)}`, { discovery: categoryId, shelf: 'Dairy' });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.items.map((i: any) => i.id)).not.toContain(tin.id);
  });

  it("but a STORE's goods do (guards the guard)", async () => {
    // Without this the three assertions above pass on a feed that returns
    // nothing at all.
    const store = await makeVendor('Ogle Hardware', { type: 'STORE' });
    const hammer = await makeItem(store.id, `Claw hammer ${nanoid(4)}`, { discovery: categoryId, shelf: 'Tools' });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.items.map((i: any) => i.id)).toContain(hammer.id);
  });

  it('the category filter is scoped to goods too', async () => {
    // A tagged DISH must not appear under a market category either — the tag
    // says what a thing is, the vertical says whose tab it belongs on.
    const kitchen = await makeVendor('Demerara Grill House', { type: 'RESTAURANT' });
    const dish = await makeItem(kitchen.id, `Pork Chops ${nanoid(4)}`, { discovery: categoryId, shelf: 'Grill' });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.items.map((i: any) => i.id)).not.toContain(dish.id);
  });
});

describe('the feed is PUBLIC on purpose, and earns it', () => {
  // It is exempt from the authz matrix, and an exemption is a claim that has to
  // be true: a shopper must be able to see what is for sale before they have an
  // account, which is the entire point of a marketplace tab.
  //
  // Every `get()` in this file already sends no Authorization header — this
  // states that explicitly, because the exemption now rests on it.
  it('answers with no session at all', async () => {
    const res = await get('/items?limit=1');
    expect(res.statusCode, 'browsing must not require signing up first').toBe(200);
  });

  it('returns nothing that is not already public', async () => {
    // The exemption's other half: no user data in the shape, so an anonymous
    // caller learns only what a store page would already tell them.
    const res = await get(`/items?category=${SLUG}&limit=1`);
    const item = res.json().data.items[0];
    for (const leaked of ['customerId', 'userId', 'phone', 'email', 'ownerId', 'cost', 'margin']) {
      expect(Object.keys(item ?? {}), `${leaked} must never reach an anonymous browser`).not.toContain(leaked);
    }
  });
});

describe('it inherits the platform rules rather than restating them', () => {
  it('an unavailable item never appears', async () => {
    // The inventory engine auto-hides at zero stock and auto-returns on
    // restock; the feed inherits that and must not defeat it.
    const v = await makeVendor('Delta Depot');
    const gone = await makeItem(v.id, `Sold out ${nanoid(4)}`, { discovery: categoryId, available: false });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.items.map((i: any) => i.id)).not.toContain(gone.id);
  });

  it('an invisible vendor takes its items with it', async () => {
    // The ONE visibility predicate, imported — not a seventh copy. A suspended
    // operator's goods must not answer a browse.
    const hidden = await makeVendor('Epsilon Hidden', { visible: false });
    const item = await makeItem(hidden.id, `Hidden ${nanoid(4)}`, { discovery: categoryId });

    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.items.map((i: any) => i.id)).not.toContain(item.id);
  });
});

describe('sorting and paging hold under duplicates', () => {
  it('price_asc actually sorts ascending', async () => {
    const v = await makeVendor('Zeta Prices');
    const cheap = `Cheap ${nanoid(4)}`;
    const dear = `Dear ${nanoid(4)}`;
    await makeItem(v.id, dear, { discovery: categoryId, price: 9000 });
    await makeItem(v.id, cheap, { discovery: categoryId, price: 5 });

    const res = await get(`/items?category=${SLUG}&sort=price_asc&limit=50`);
    const list = names(res.json());
    expect(list.indexOf(cheap)).toBeLessThan(list.indexOf(dear));
  });

  it('pages without repeating or skipping, even when the sort column ties', async () => {
    // Every price and every totalOrdered has duplicates in a real catalogue.
    // Without `id` as a tiebreaker, keyset paging silently drops and repeats
    // rows — the classic browse-feed corruption.
    const v = await makeVendor('Eta Ties');
    const tag = nanoid(5);
    for (let i = 0; i < 6; i += 1) {
      await makeItem(v.id, `Tie ${tag} ${i}`, { discovery: categoryId, price: 100, totalOrdered: 7 });
    }

    const first = await get(`/items?category=${SLUG}&sort=price_asc&limit=3`);
    const cursor = first.json().data.nextCursor;
    expect(cursor, 'more rows exist, so a cursor must be offered').toBeTruthy();

    const second = await get(`/items?category=${SLUG}&sort=price_asc&limit=3&cursor=${encodeURIComponent(cursor)}`);
    const a = first.json().data.items.map((i: any) => i.id);
    const b = second.json().data.items.map((i: any) => i.id);

    expect(a.filter((id: string) => b.includes(id)), 'a row served on two pages').toEqual([]);
  });

  it('the ordering carries `id` as a tiebreaker on EVERY sort', () => {
    // STRUCTURAL, and deliberately so. Without a tiebreaker the order of tied
    // rows is UNDEFINED, not reliably wrong — Postgres may well return them
    // consistently within one session, so the behavioural test above passes
    // whether or not the tiebreaker exists. (Verified: removing it left that
    // test green.) The invariant that makes keyset paging defined at all is
    // therefore asserted directly.
    const src = readFileSync(join(process.cwd(), 'src/modules/market/market.routes.ts'), 'utf8');
    const orderFn = src.split('function orderFor')[1]?.split('\n}')[0] ?? '';
    const returns = orderFn.match(/return \[[^\]]*\]/g) ?? [];
    expect(returns.length, 'one return per sort family').toBeGreaterThanOrEqual(3);
    for (const r of returns) {
      expect(r, `an ordering without an id tiebreaker: ${r}`).toMatch(/id:\s*'asc'/);
    }
  });

  it('refuses a cursor minted under a different sort', async () => {
    // Replaying it would page through one ordering using another's position —
    // a nonsense page that looks like real data.
    const first = await get(`/items?category=${SLUG}&sort=price_asc&limit=1`);
    const cursor = first.json().data.nextCursor;
    const res = await get(`/items?category=${SLUG}&sort=popular&limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_CURSOR');
  });

  it('offers no cursor on the last page', async () => {
    const res = await get(`/items?category=${SLUG}&limit=50`);
    expect(res.json().data.nextCursor, 'a cursor to an empty page is a dead end').toBeNull();
  });
});

describe('the response is the EXISTING item shape', () => {
  it('returns ItemHit, not a new market-only model', async () => {
    // "One catalogue, one cart, one search index" — a second item shape is the
    // first crack in that. A client that renders a search result renders this.
    const res = await get(`/items?category=${SLUG}&limit=1`);
    const item = res.json().data.items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['basePrice', 'categoryName', 'id', 'imageUrl', 'name', 'vendorId', 'vendorName'].sort(),
    );
    expect(typeof item.basePrice, 'price is a number, never a Decimal string').toBe('number');
  });

  it('reports the honest total for the category', async () => {
    const res = await get(`/items?category=${SLUG}&limit=1`);
    const { meta, items } = res.json().data;
    expect(meta.category).toBe(SLUG);
    expect(meta.total).toBeGreaterThan(items.length);
  });
});
