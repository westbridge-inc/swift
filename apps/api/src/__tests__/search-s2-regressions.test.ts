import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { marketRoutes } from '../modules/market/market.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [S2] Guest catalogue search — the two findings PR #1264's R2 review blocked on.
//
// S2-1: hidden-only items ranked ahead of a listable one used to consume the
// raw page/window cap, so Market limit=1 returned [] with no cursor and guest
// search/suggestions came back empty; meta.total and /market/depth counted raw
// rows. Eligibility now lives in the item where-clause, so the page, the
// cursor and the counts all see the same population.
//
// S2-2: nearby's rating-first `take` ran before any radius predicate, so a
// five-star vendor outside the radius crowded a four-star vendor at the
// caller's coordinates out of the window and the post-filter returned [].
//
// These are DATABASE tests: the in-memory double does not implement orderBy,
// and every reproduction here depends on ranked fetch order.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT = `s2-guest-${RUN}`;
const NEEDLE = `hammer-${RUN}`;
// Unique prefix, grep-proven: no other test file uses +5920052, and it is
// not the live Digicel range (+592600…).
const PHONE_PREFIX = '+5920052';
const userIds: string[] = [];
const vendorIds: string[] = [];
const itemIds: string[] = [];
const shelfIds: string[] = [];
const discoveryIds: string[] = [];
const hiddenNames: string[] = [];
const hiddenIds: string[] = [];
let activeId = '';
let activeName = '';
let untaggedId = '';
let storeVendorId = '';
let cornerVendorId = '';

const restoreEnv = process.env['PUBLIC_TENANT_ID'];

beforeAll(async () => {
  // The index is provably unavailable, so every search request runs the DB
  // fallback the S2 findings were reported against.
  process.env['MEILISEARCH_URL'] = 'http://127.0.0.1:9';
  process.env['PUBLIC_TENANT_ID'] = TENANT;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.ready();

  await app.prisma.tenant.create({ data: { id: TENANT, name: `S2 Guest ${RUN}`, slug: TENANT } });
  const owner = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}001`, firstName: 'S2', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      countryCode: 'GY', tenantId: TENANT,
    },
  });
  userIds.push(owner.id);
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });

  // The in-radius STORE the market and nearby surfaces should serve.
  const store = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: `S2 Store ${RUN}`, slug: `s2-store-${RUN}`,
      vendorType: 'STORE', phone: `${PHONE_PREFIX}002`, addressLine1: '1 S2 Lane', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, averageRating: 4,
      tenantId: TENANT,
    },
  });
  vendorIds.push(store.id);
  storeVendorId = store.id;
  const shelf = await app.prisma.category.create({ data: { vendorId: store.id, name: 'S2 shelf', sortOrder: 0, tenantId: TENANT } });
  shelfIds.push(shelf.id);

  const hiddenCat = await app.prisma.discoveryCategory.create({
    data: { tenantId: TENANT, slug: `s2-hidden-${RUN}`, name: 'S2 hidden', kind: 'RETAIL', vertical: 'RETAIL', emoji: '\u{1F576}', status: 'HIDDEN' },
  });
  const activeCat = await app.prisma.discoveryCategory.create({
    data: { tenantId: TENANT, slug: `s2-active-${RUN}`, name: 'S2 active', kind: 'RETAIL', vertical: 'RETAIL', emoji: '\u{1F528}', status: 'ACTIVE' },
  });
  discoveryIds.push(hiddenCat.id, activeCat.id);

  const item = async (name: string, totalOrdered: number) => {
    const row = await app.prisma.item.create({
      data: { vendorId: store.id, categoryId: shelf.id, name, basePrice: 1200, isAvailable: true, totalOrdered, tenantId: TENANT },
    });
    itemIds.push(row.id);
    return row;
  };
  // Twenty-two hidden-only rows FIRST — enough to saturate trending's take-20
  // window AND the suggestion take-5 window, and they outrank the active item
  // on totalOrdered and precede it in physical order, so every raw window on
  // main is filled with hidden rows.
  for (let n = 1; n <= 22; n += 1) {
    const row = await item(`${NEEDLE} hidden ${n}`, 130 - n);
    hiddenNames.push(row.name);
    hiddenIds.push(row.id);
    await app.prisma.itemDiscoveryCategory.create({ data: { tenantId: TENANT, itemId: row.id, categoryId: hiddenCat.id, source: 'ADMIN' } });
  }
  const active = await item(`${NEEDLE} active`, 50);
  activeId = active.id;
  activeName = active.name;
  await app.prisma.itemDiscoveryCategory.create({ data: { tenantId: TENANT, itemId: active.id, categoryId: activeCat.id, source: 'ADMIN' } });
  const untagged = await item(`${NEEDLE} untagged`, 40);
  untaggedId = untagged.id;

  // The S2-2 decoy: higher-rated and OUTSIDE the radius, with an orderable
  // item so it passes nearby's "not an empty store" clause.
  const far = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: `S2 Far ${RUN}`, slug: `s2-far-${RUN}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}003`, addressLine1: '9 S2 Far Lane', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.9, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, averageRating: 5,
      tenantId: TENANT,
    },
  });
  vendorIds.push(far.id);
  const farShelf = await app.prisma.category.create({ data: { vendorId: far.id, name: 'S2 far shelf', sortOrder: 0, tenantId: TENANT } });
  shelfIds.push(farShelf.id);
  const rice = await app.prisma.item.create({
    data: { vendorId: far.id, categoryId: farShelf.id, name: `rice ${RUN}`, basePrice: 900, isAvailable: true, totalOrdered: 1, tenantId: TENANT },
  });
  itemIds.push(rice.id);

  // The S2-2 corner decoy: INSIDE the latitude/longitude box a 1 km radius
  // spans (the box is a square, the radius a circle inscribed in it) but about
  // 1.33 km out, and better rated than the store at the caller's coordinates.
  // A box alone does not stop it winning a rating-first window of `limit`.
  const corner = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: `S2 Corner ${RUN}`, slug: `s2-corner-${RUN}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}004`, addressLine1: '4 S2 Corner Lane', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8085, longitude: -58.1415,
      status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, averageRating: 5,
      tenantId: TENANT,
    },
  });
  vendorIds.push(corner.id);
  cornerVendorId = corner.id;
  const cornerShelf = await app.prisma.category.create({ data: { vendorId: corner.id, name: 'S2 corner shelf', sortOrder: 0, tenantId: TENANT } });
  shelfIds.push(cornerShelf.id);
  const roti = await app.prisma.item.create({
    data: { vendorId: corner.id, categoryId: cornerShelf.id, name: `roti ${RUN}`, basePrice: 700, isAvailable: true, totalOrdered: 1, tenantId: TENANT },
  });
  itemIds.push(roti.id);
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } }).catch(() => {});
    await app.prisma.item.deleteMany({ where: { id: { in: itemIds } } }).catch(() => {});
    await app.prisma.category.deleteMany({ where: { id: { in: shelfIds } } }).catch(() => {});
    await app.prisma.discoveryCategory.deleteMany({ where: { id: { in: discoveryIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
  }, 'test-cleanup:s2-guest-search');
  if (restoreEnv === undefined) delete process.env['PUBLIC_TENANT_ID'];
  else process.env['PUBLIC_TENANT_ID'] = restoreEnv;
  await app.close();
});

const market = (url: string) => app.inject({ method: 'GET', url: `/api/v1/market${url}` });
const search = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });
const idsOf = (res: { json: () => { data: { items: Array<{ id: string }> } } }) => res.json().data.items.map((i) => i.id);

describe('[S2-1] hidden-only rows cannot consume the page or the fixed windows', () => {
  it('Market limit=1 returns the active item, a live cursor, and only eligible totals', async () => {
    const res = await market('/items?limit=1');
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([activeId]);
    expect(body.nextCursor).toBeTruthy();
    expect(body.meta.total).toBe(2);
  });

  it('the Market cursor leads to the next eligible item, never an empty page', async () => {
    const first = await market('/items?limit=1');
    const cursor = first.json().data.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await market(`/items?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(second.statusCode).toBe(200);
    expect(idsOf(second)).toEqual([untaggedId]);
  });

  it('/market/depth counts the eligible population the feed shows', async () => {
    const res = await market('/depth');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items).toBe(2);
    expect(res.json().data.vendors).toBe(1);
  });

  it('guest text search limit=1 returns the active item', async () => {
    const res = await search(`/search?q=${NEEDLE}&limit=1`);
    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([activeId]);
  });

  it('suggestions surface the active item, not the hidden-only rows', async () => {
    const res = await search(`/search/suggestions?q=${NEEDLE}`);
    expect(res.statusCode).toBe(200);
    const texts = res.json().data.map((s: { text: string }) => s.text);
    expect(texts).toContain(activeName);
    for (const hidden of hiddenNames) expect(texts).not.toContain(hidden);
  });

  it('trending keeps the active item and drops hidden-only rows', async () => {
    const res = await search('/search/trending');
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((i: { id: string }) => i.id);
    expect(ids).toContain(activeId);
    for (const hidden of hiddenIds) expect(ids).not.toContain(hidden);
  });
});

describe('[S2-2] nearby cannot let an out-of-radius high rating crowd the radius empty', () => {
  it('limit=1 returns the in-radius vendor, not the higher-rated one outside', async () => {
    const res = await search('/search/nearby?lat=6.8&lng=-58.15&radius=1&limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((v: { id: string }) => v.id)).toEqual([storeVendorId]);
  });

  it('a higher-rated vendor in the box corner, outside the circle, cannot take the window either', async () => {
    const res = await search('/search/nearby?lat=6.8&lng=-58.15&radius=1&limit=1');
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((v: { id: string }) => v.id);
    expect(ids).toEqual([storeVendorId]);
    expect(ids).not.toContain(cornerVendorId);
    // With room for both, the corner vendor is still outside the radius.
    const wide = await search('/search/nearby?lat=6.8&lng=-58.15&radius=1&limit=10');
    expect(wide.json().data.map((v: { id: string }) => v.id)).toEqual([storeVendorId]);
    // …and inside a 2 km radius it is served, nearest first.
    const two = await search('/search/nearby?lat=6.8&lng=-58.15&radius=2&limit=10');
    expect(two.json().data.map((v: { id: string }) => v.id)).toEqual([storeVendorId, cornerVendorId]);
  });
});
