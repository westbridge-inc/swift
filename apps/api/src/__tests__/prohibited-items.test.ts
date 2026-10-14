/**
 * [GUARDRAILS §8] Banned outright, permanently: alcohol, tobacco and cigarettes, vapes, every other 18+ item,
 * all medicines (over-the-counter included), cooking gas (LPG) and fuel.
 *
 * Owner, 13 Oct 2026. A banned platform category or a person's removal is
 * refused outright ("Swift doesn't allow this item: …"). A banned WORD in the
 * partner's own text saves the item but holds it hidden — not shown, searched,
 * carted or ordered — until a person checks it in the admin console; approval
 * is bound to the words seen, so any edit brings the check back. Every
 * "hidden" assertion has a positive control on the same surface, so an empty
 * answer can never pass for a hidden one.
 *
 * Legacy rows — items saved before this rule existed, or through a path that
 * forgot it — are inserted directly, so the read side is proven independently
 * of the write side.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { marketRoutes } from '../modules/market/market.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { discoveryRoutes, resetDiscoveryCacheForTests, CATEGORY_DISCOVERY_FLAG } from '../modules/discovery/discovery.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { OrderService } from '../modules/order/order.service';
import { PickingService } from '../modules/order/picking.service';
import { mergeGuestCart } from '../modules/user/cart-merge.service';

// The index engine is the only thing replaced: what it returns is decided per
// test, so the signed-in (index) path and the database fallback are both run.
const engine = vi.hoisted(() => ({ itemHits: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock('../modules/search/search.service', () => ({ SearchService: class {
  async initialize() {}
  async syncAllVendors() { return 0; }
  async syncAllItems() { return 0; }
  async syncVendorItems() { return 0; }
  async removeItemDoc() {}
  async searchVendors() { if (engine.fail) throw new Error('index down'); return { hits: [], estimatedTotalHits: 0, processingTimeMs: 1 }; }
  async searchItems() { if (engine.fail) throw new Error('index down'); return { hits: engine.itemHits, estimatedTotalHits: engine.itemHits.length, processingTimeMs: 1 }; }
} }));

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const TENANT = 'swift-default';
const TOP = 9_000_000; // ranks every fixture above anything else in a shared test database
const REASON = 'Checked the listing against the prohibited-items rule';

let app: FastifyInstance;
let orders: OrderService;
let picking: PickingService;
let seq = 0;
const users: string[] = [];
const vendorIds: string[] = [];
const createdCategoryIds: string[] = [];
let priorPlatformFlag: unknown = undefined;

let vendor: { id: string; slug: string; token: string; ownerUserId: string; shelfId: string; legacySectionId: string };
let customer: { id: string; token: string };
let admin: { token: string };
let control: { id: string; name: string };
type Legacy = 'rum' | 'combo' | 'bottle' | 'relief' | 'removed';
const legacy = {} as Record<Legacy, { id: string; name: string }>;
let pharmacyCategory: { id: string; slug: string };
let snacksCategory: { id: string; slug: string };

const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'prohibited-items-test');

async function userWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+59266${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Prohibited', lastName: `User${seq}`,
    roles, activeRole, countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'prohibited-test', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) } });
  return { id: user.id, token };
}

async function discoveryCategory(slug: string, kind: 'RETAIL' | 'AISLE') {
  const existing = await system(() => app.prisma.discoveryCategory.findUnique({ where: { tenantId_slug: { tenantId: TENANT, slug } } }));
  if (existing) {
    if (existing.status !== 'ACTIVE') throw new Error(`fixture category ${slug} is ${existing.status} in this database`);
    return existing;
  }
  const c = await system(() => app.prisma.discoveryCategory.create({ data: { tenantId: TENANT, slug, name: slug === 'pharmacy' ? 'Pharmacy & Health' : 'Snacks', kind, vertical: kind === 'AISLE' ? 'GROCERY' : 'RETAIL', emoji: '🧪', status: 'ACTIVE' } }));
  createdCategoryIds.push(c.id);
  return c;
}

const item = (data: { name: string; categoryId?: string; options?: readonly string[]; removed?: { readonly cls: string; readonly reason: string } }) => app.prisma.item.create({ data: {
  vendorId: vendor.id, categoryId: data.categoryId ?? vendor.shelfId, name: data.name, basePrice: 1500, totalOrdered: TOP,
  ...(data.options ? { optionGroups: { create: [{ name: 'Drink', minSelect: 0, maxSelect: 1, options: { create: data.options.map((name, i) => ({ name, sortOrder: i })) } }] } } : {}),
  ...(data.removed ? { prohibitedAt: new Date(), prohibitedClass: data.removed.cls, prohibitedReason: data.removed.reason } : {}),
} });

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const hiddenIds = () => Object.values(legacy).map((l) => l.id);
const visibleOn = async (read: () => Promise<string[]>, show: string[], hide: string[]) => {
  const seen = await read();
  for (const id of show) expect(seen, `expected ${id} to be shown`).toContain(id);
  for (const id of hide) expect(seen, `expected ${id} to be hidden`).not.toContain(id);
};

async function storefrontItemIds(): Promise<string[]> {
  const res = await inject('GET', `/api/v1/customer/vendors/${vendor.id}`, customer.token);
  expect(res.statusCode).toBe(200);
  return (res.json().data.categories as Array<{ items: Array<{ id: string }> }>).flatMap((c) => ids(c.items));
}
async function publicStorefront() {
  const res = await inject('GET', `/api/v1/public/storefronts/${vendor.slug}`);
  expect(res.statusCode).toBe(200);
  return res.json().data as { categories: Array<{ name: string; items: Array<{ id: string }> }> };
}
async function marketItemIds(): Promise<string[]> {
  const res = await inject('GET', '/api/v1/market/items?limit=50&sort=popular', customer.token);
  expect(res.statusCode).toBe(200);
  return ids(res.json().data.items);
}
async function searchItemIds(): Promise<string[]> {
  const res = await inject('GET', `/api/v1/search?q=${RUN}&limit=50`, customer.token);
  expect(res.statusCode).toBe(200);
  return ids(res.json().data.items);
}
const createItem = (body: Record<string, unknown>) => inject('POST', '/api/v1/vendor/items', vendor.token, { categoryId: vendor.shelfId, basePrice: 500, ...body });
const queue = async () => {
  const res = await inject('GET', '/api/v1/admin/catalogue-review', admin.token);
  expect(res.statusCode).toBe(200);
  return res.json().data.items as Array<{ itemId: string; wordsHash: string; state: string; prohibitedClass: string; field: string; term: string }>;
};
const approve = (itemId: string, wordsHash: string, reason: string | null = REASON) =>
  inject('POST', `/api/v1/admin/catalogue-review/${itemId}/approve`, admin.token, { wordsHash }, reason ? { 'x-swift-reason': reason } : {});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  vi.stubEnv('PUBLIC_TENANT_ID', TENANT);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.register(discoveryRoutes, { prefix: '/api/v1/discovery' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const io = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orders = new OrderService(app.prisma, io);
  picking = new PickingService(app.prisma, io);

  const owner = await userWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const v = await app.prisma.vendor.create({ data: {
    ownerId: vendorOwner.id, name: `Prohibited Test Shop ${RUN}`, slug: `prohibited-shop-${RUN}`, vendorType: 'STORE', phone: `+59267${NUM}01`,
    addressLine1: '1 Rule Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
    averageRating: 5, // first in the Home scan of a shared test database
  } });
  vendorIds.push(v.id);
  const shelf = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Shelf', sortOrder: 0 } });
  // A partner's own section name, free text — a banned word in it holds its items for a check.
  const legacySection = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Beers & Wines', sortOrder: 1 } });
  vendor = { id: v.id, slug: v.slug, token: owner.token, ownerUserId: owner.id, shelfId: shelf.id, legacySectionId: legacySection.id };

  customer = await userWithSession(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({ data: { userId: customer.id, label: 'Home', addressLine1: '9 Rule Close', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
  admin = await userWithSession(['SUPER_ADMIN'], 'SUPER_ADMIN');

  pharmacyCategory = await discoveryCategory('pharmacy', 'RETAIL');
  snacksCategory = await discoveryCategory('snacks', 'AISLE');

  const c = await item({ name: `Legacy Pepperpot ${RUN}` });
  control = { id: c.id, name: c.name };
  for (const [key, data] of [
    ['rum', { name: `Legacy Rum ${RUN}` }],
    ['combo', { name: `Legacy Combo ${RUN}`, options: ['Coke', 'Carib Lager'] }],
    ['bottle', { name: `Legacy Bottle ${RUN}`, categoryId: legacySection.id }],
    ['relief', { name: `Legacy Relief ${RUN}` }],
    ['removed', { name: `Legacy Tonic ${RUN}`, removed: { cls: 'MEDICINE', reason: 'Sold as a cure for fever' } }],
  ] as const) {
    const row = await item(data);
    legacy[key] = { id: row.id, name: row.name };
  }
  // Filed under Pharmacy directly, as the demo seed does — no gate ran.
  await app.prisma.itemDiscoveryCategory.create({ data: { tenantId: TENANT, itemId: legacy.relief.id, categoryId: pharmacyCategory.id, source: 'VENDOR' } });
  engine.itemHits = [control, ...Object.values(legacy)].map((r) => ({ entityId: r.id, id: `${TENANT}:${r.id}`, name: r.name, vendorId: vendor.id, vendorName: `Prohibited Test Shop ${RUN}`, basePrice: 1500 }));
  // Let the background index warm-up finish, so the signed-in path is the index path.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await system(async () => {
    if (priorPlatformFlag === null) await app.prisma.platformConfig.deleteMany({ where: { key: CATEGORY_DISCOVERY_FLAG } });
    else if (priorPlatformFlag !== undefined) await app.prisma.platformConfig.update({ where: { key: CATEGORY_DISCOVERY_FLAG }, data: { value: priorPlatformFlag as never } });
    await app.prisma.order.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.cart.deleteMany({ where: { customerId: { in: users } } }).catch(() => {});
    await app.prisma.cartMergeReceipt.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    const itemIds = (await app.prisma.item.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((i) => i.id);
    await app.prisma.discoveryCategorySuggestion.deleteMany({ where: { itemId: { in: itemIds } } });
    await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } });
    await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.discoveryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } }).catch(() => {});
    await app.prisma.address.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[§8] a partner saving and editing items', () => {
  it('a banned word saves the item but holds it for a quick check; an ordinary item is simply saved', async () => {
    const beer = await createItem({ name: `Banks Beer 275ml ${RUN}` });
    expect(beer.statusCode).toBe(200);
    expect(beer.json().data.catalogueCheck).toEqual({ status: 'WAITING_FOR_CHECK', message: 'Waiting for a quick check', prohibitedClass: 'ALCOHOL', field: 'name', term: 'beer' });
    const combo = await createItem({ name: `Chicken combo ${RUN}`, optionGroups: [{ name: 'Add a drink', options: [{ name: 'Coke' }, { name: 'Carib Lager' }] }] });
    expect(combo.json().data.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', field: 'option' });
    const gas = await createItem({ name: `Gas stove ${RUN}` });
    expect(gas.json().data.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', prohibitedClass: 'LPG' });
    const plain = await createItem({ name: `Cheese roll ${RUN}` });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().data.catalogueCheck).toBeNull();
    await visibleOn(storefrontItemIds, [plain.json().data.id], [beer.json().data.id, combo.json().data.id, gas.json().data.id]);
  });

  it('every edit is judged again: ordinary → banned word is held; an approved item renamed is held again', async () => {
    const created = await createItem({ name: `Sorrel drink ${RUN}` });
    const id = created.json().data.id as string;
    const toRum = await inject('PUT', `/api/v1/vendor/items/${id}`, vendor.token, { name: `Rum punch ${RUN}` });
    expect(toRum.statusCode).toBe(200);
    expect(toRum.json().data.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', term: 'rum' });
    await visibleOn(storefrontItemIds, [control.id], [id]);

    const cake = await createItem({ name: `Rum cake ${RUN}` });
    const cakeId = cake.json().data.id as string;
    const row = (await queue()).find((q) => q.itemId === cakeId)!;
    expect((await approve(cakeId, row.wordsHash)).statusCode).toBe(200);
    await visibleOn(storefrontItemIds, [cakeId], []);
    const renamed = await inject('PUT', `/api/v1/vendor/items/${cakeId}`, vendor.token, { name: `Rum cake (large) ${RUN}` });
    expect(renamed.json().data.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK' });
    await visibleOn(storefrontItemIds, [control.id], [cakeId]);
    // A new option is an edit too.
    const back = (await queue()).find((q) => q.itemId === cakeId)!;
    expect((await approve(cakeId, back.wordsHash)).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/vendor/items/${cakeId}/option-groups`, vendor.token, { name: 'Extras', options: [{ name: 'Brandy butter' }] })).statusCode).toBe(200);
    await visibleOn(storefrontItemIds, [control.id], [cakeId]);
  });

  it('an item Swift does not allow (banned category, or removed) cannot be edited, switched on or given options', async () => {
    const relief = await inject('PUT', `/api/v1/vendor/items/${legacy.relief.id}`, vendor.token, { basePrice: 900 });
    expect(relief.statusCode).toBe(409);
    expect(relief.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', message: 'Swift doesn\'t allow this item: medicines.' });
    expect((await inject('PUT', `/api/v1/vendor/items/${legacy.removed.id}`, vendor.token, { name: `Tonic water ${RUN}` })).statusCode).toBe(409);
    expect((await inject('PUT', `/api/v1/vendor/items/${legacy.removed.id}/availability`, vendor.token, { isAvailable: true })).statusCode).toBe(409);
    expect((await inject('PUT', `/api/v1/vendor/items/${legacy.removed.id}/availability`, vendor.token, { isAvailable: false })).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/vendor/items/${legacy.removed.id}/option-groups`, vendor.token, { name: 'Size', options: [{ name: 'Small' }] })).statusCode).toBe(409);
    expect(await app.prisma.item.findUniqueOrThrow({ where: { id: legacy.removed.id }, select: { name: true } })).toEqual({ name: legacy.removed.name });
  });

  it('CSV import: every valid row imports; rows a banned word holds are listed by row', async () => {
    const csv = [
      'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl',
      `Shelf,Banks Beer ${RUN},,400,,,,,,`,
      `Shelf,Mauby ${RUN},Bark brew,300,,,,,,`,
      `Pharmacy ${RUN},Vitamin C ${RUN},,900,,,,,,`,
      `Shelf,Cough syrup ${RUN},,700,,,,,,`,
    ].join('\n');
    const res = await inject('POST', '/api/v1/vendor/items/import', vendor.token, { csv });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ imported: 4, failedCount: 0, waitingForCheckCount: 3 });
    expect(data.waitingForCheck.map((w: { row: number }) => w.row).sort()).toEqual([2, 4, 5]);
    const mauby = await app.prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: `Mauby ${RUN}` } });
    const beer = await app.prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: `Banks Beer ${RUN}` } });
    await visibleOn(storefrontItemIds, [mauby.id], [beer.id]);
  });

  it('a banned platform category is refused outright: tag, accepted suggestion, store category', async () => {
    const itemId = (await item({ name: `Plantain chips ${RUN}` })).id;
    const tag = await inject('POST', `/api/v1/vendor/items/${itemId}/categories`, vendor.token, { slug: 'pharmacy' });
    expect(tag.statusCode).toBe(409);
    expect(tag.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', message: 'Swift doesn\'t allow this item: medicines.' });
    const suggestion = await app.prisma.discoveryCategorySuggestion.create({ data: { tenantId: TENANT, itemId, categoryId: pharmacyCategory.id, confidence: 0.7, stage: 'MATCHER', status: 'PENDING' } });
    expect((await inject('POST', `/api/v1/vendor/category-suggestions/${suggestion.id}/accept`, vendor.token, {})).statusCode).toBe(409);
    expect(await app.prisma.itemDiscoveryCategory.count({ where: { itemId } })).toBe(0);
    const store = await inject('PUT', '/api/v1/vendor/store-categories', vendor.token, { primarySlug: 'pharmacy', secondarySlugs: [] });
    expect(store.statusCode).toBe(409);
    expect(store.json().error.message).toBe('Swift doesn\'t allow this category: medicines.');
    expect((await inject('PUT', '/api/v1/vendor/store-categories', vendor.token, { primarySlug: snacksCategory.slug, secondarySlugs: [] })).statusCode).toBe(200);
  });
});

describe('[§8] nobody sees a hidden item', () => {
  it('storefront (app) and public storefront (website): the control shows; every hidden item does not', async () => {
    await visibleOn(storefrontItemIds, [control.id], hiddenIds());
    const web = await publicStorefront();
    const webIds = web.categories.flatMap((c) => ids(c.items));
    expect(webIds).toContain(control.id);
    for (const id of hiddenIds()) expect(webIds).not.toContain(id);
  });

  it('Market, search (index path and database fallback), suggestions, trending and the Home rail', async () => {
    await visibleOn(marketItemIds, [control.id], hiddenIds());
    engine.fail = false;
    await visibleOn(searchItemIds, [control.id], hiddenIds());
    engine.fail = true;
    try { await visibleOn(searchItemIds, [control.id], hiddenIds()); } finally { engine.fail = false; }

    const suggestions = await inject('GET', `/api/v1/search/suggestions?q=${RUN}`, customer.token);
    const words = (suggestions.json().data as Array<{ text: string }>).map((s) => s.text);
    expect(words).toContain(control.name);
    for (const l of Object.values(legacy)) expect(words).not.toContain(l.name);

    await visibleOn(async () => ids((await inject('GET', '/api/v1/search/trending', customer.token)).json().data), [control.id], hiddenIds());

    const home = await inject('GET', `/api/v1/customer/home?lat=6.8${NUM}&lng=-58.15`, customer.token);
    expect(home.statusCode).toBe(200);
    const popular = ids(home.json().data.popularItems);
    expect(popular).toContain(control.id);
    for (const id of hiddenIds()) expect(popular).not.toContain(id);
    const chips = (home.json().data.categories as Array<{ name: string }>).map((c) => c.name);
    expect(chips).toContain('Shelf');
    expect(chips).not.toContain('Beers & Wines');
  });

  it('the category rail never offers Pharmacy', async () => {
    const row = await system(() => app.prisma.platformConfig.findUnique({ where: { key: CATEGORY_DISCOVERY_FLAG } }));
    priorPlatformFlag = row ? row.value : null;
    await system(() => app.prisma.platformConfig.upsert({ where: { key: CATEGORY_DISCOVERY_FLAG }, create: { key: CATEGORY_DISCOVERY_FLAG, value: true }, update: { value: true } }));
    await system(() => app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: vendor.id } }));
    await system(() => app.prisma.vendorDiscoveryCategory.createMany({ data: [
      { tenantId: TENANT, vendorId: vendor.id, categoryId: snacksCategory.id, role: 'PRIMARY', source: 'ADMIN' },
      { tenantId: TENANT, vendorId: vendor.id, categoryId: pharmacyCategory.id, role: 'SECONDARY', source: 'ADMIN' },
    ] }));
    resetDiscoveryCacheForTests();
    const res = await inject('GET', '/api/v1/discovery/categories', customer.token);
    expect(res.statusCode).toBe(200);
    const slugs = (res.json().data.categories as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).toContain(snacksCategory.slug);
    expect(slugs).not.toContain('pharmacy');
  });

  it('store browse: a banned category lists no store; a category count leaves hidden items out', async () => {
    // The store is a member of both (the rail case above filed it). Snacks holds an
    // ordinary item and a held one; only the ordinary one is counted.
    await system(() => app.prisma.itemDiscoveryCategory.createMany({ data: [
      { tenantId: TENANT, itemId: control.id, categoryId: snacksCategory.id, source: 'VENDOR' },
      { tenantId: TENANT, itemId: legacy.bottle.id, categoryId: snacksCategory.id, source: 'VENDOR' },
    ] }));
    const browse = async (slug: string) => {
      const res = await inject('GET', `/api/v1/customer/vendors?category=${slug}&limit=50`, customer.token);
      expect(res.statusCode).toBe(200);
      return res.json().data as Array<{ id: string; itemsInCategory?: number | null }>;
    };
    const snacks = await browse(snacksCategory.slug);
    expect(snacks.find((v) => v.id === vendor.id)?.itemsInCategory).toBe(1);
    expect(await browse('pharmacy')).toEqual([]);
  });

  it('the partner and the admin read WHY an item is hidden', async () => {
    const own = await inject('GET', '/api/v1/vendor/items', vendor.token);
    expect(own.statusCode).toBe(200);
    const rows = own.json().data as Array<{ id: string; catalogueCheck: unknown }>;
    expect(rows.find((r) => r.id === legacy.rum.id)?.catalogueCheck).toEqual({ status: 'WAITING_FOR_CHECK', message: 'Waiting for a quick check', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });
    expect(rows.find((r) => r.id === legacy.relief.id)?.catalogueCheck).toEqual({ status: 'NOT_ALLOWED', message: 'Swift doesn\'t allow this item: medicines.', prohibitedClass: 'MEDICINE', reason: null });
    expect(rows.find((r) => r.id === legacy.removed.id)?.catalogueCheck).toMatchObject({ status: 'NOT_ALLOWED', reason: 'Sold as a cure for fever' });
    expect(rows.find((r) => r.id === control.id)?.catalogueCheck).toBeNull();
    const detail = await inject('GET', `/api/v1/admin/vendors/${vendor.id}`, admin.token);
    expect(detail.statusCode).toBe(200);
    const flagged = detail.json().data.prohibitedItems as Array<{ id: string; state: string; source?: string; field?: string; term: string | null }>;
    for (const id of hiddenIds()) expect(flagged.map((f) => f.id)).toContain(id);
    expect(flagged.find((f) => f.id === legacy.combo.id)).toMatchObject({ state: 'WAITING', field: 'option', term: 'lager' });
    expect(flagged.find((f) => f.id === legacy.relief.id)).toMatchObject({ state: 'BANNED', source: 'category' });
    expect(flagged.map((f) => f.id)).not.toContain(control.id);
  });
});

describe('[§8] the admin catalogue check', () => {
  it('the queue holds the waiting items only; approval needs a reason, the words seen, and never lifts a ban', async () => {
    const q = await queue();
    const queued = q.map((r) => r.itemId);
    for (const id of [legacy.rum.id, legacy.combo.id, legacy.bottle.id]) expect(queued).toContain(id);
    for (const id of [legacy.relief.id, legacy.removed.id, control.id]) expect(queued).not.toContain(id);
    const rum = q.find((r) => r.itemId === legacy.rum.id)!;
    expect(rum).toMatchObject({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });

    expect((await approve(legacy.rum.id, rum.wordsHash, null)).statusCode).toBe(400);
    const stale = await approve(legacy.rum.id, '0'.repeat(64));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ITEM_CHANGED');
    const ban = await approve(legacy.relief.id, '0'.repeat(64));
    expect(ban.statusCode).toBe(409);
    expect(ban.json().error.message).toBe('Approval never lifts a ban. Swift doesn\'t allow this item: medicines.');
    expect((await approve(control.id, '0'.repeat(64))).json().error.code).toBe('NOTHING_TO_CHECK');

    const ok = await approve(legacy.rum.id, rum.wordsHash);
    expect(ok.statusCode).toBe(200);
    await visibleOn(storefrontItemIds, [legacy.rum.id], [legacy.combo.id]);
    expect((await queue()).map((r) => r.itemId)).not.toContain(legacy.rum.id);
  });

  it('a partner edit after the reviewer opened the item: that approval is refused and the item stays hidden; the current words can be approved', async () => {
    const fudge = await createItem({ name: `Rum fudge ${RUN}` });
    const fudgeId = fudge.json().data.id as string;
    const seen = (await queue()).find((q) => q.itemId === fudgeId)!;
    // The partner changes the words while the reviewer is reading the old ones.
    expect((await inject('PUT', `/api/v1/vendor/items/${fudgeId}`, vendor.token, { name: `Rum 1L ${RUN}` })).statusCode).toBe(200);
    const stale = await approve(fudgeId, seen.wordsHash);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'ITEM_CHANGED', message: 'This item changed — review it again.' });
    await visibleOn(storefrontItemIds, [control.id], [fudgeId]);
    const current = (await queue()).find((q) => q.itemId === fudgeId)!;
    expect(current.wordsHash).not.toBe(seen.wordsHash);
    expect((await approve(fudgeId, current.wordsHash)).statusCode).toBe(200);
    await visibleOn(storefrontItemIds, [fudgeId], []);
  });

  it('remove bans an item for good, with the reason the partner reads; it cannot be removed twice', async () => {
    const res = await inject('POST', `/api/v1/admin/catalogue-review/${legacy.combo.id}/remove`, admin.token, { prohibitedClass: 'ALCOHOL' }, { 'x-swift-reason': 'Sells beer as a combo option' });
    expect(res.statusCode).toBe(200);
    const row = await app.prisma.item.findUniqueOrThrow({ where: { id: legacy.combo.id }, select: { prohibitedAt: true, prohibitedClass: true, prohibitedReason: true, isAvailable: true } });
    expect(row).toMatchObject({ prohibitedClass: 'ALCOHOL', prohibitedReason: 'Sells beer as a combo option', isAvailable: false });
    expect(row.prohibitedAt).toBeInstanceOf(Date);
    expect((await inject('PUT', `/api/v1/vendor/items/${legacy.combo.id}`, vendor.token, { basePrice: 100 })).json().error.code).toBe('PROHIBITED_ITEM');
    expect((await inject('POST', `/api/v1/admin/catalogue-review/${legacy.combo.id}/remove`, admin.token, { prohibitedClass: 'ALCOHOL' }, { 'x-swift-reason': 'Sells beer as a combo option' })).json().error.code).toBe('ALREADY_REMOVED');
    expect((await queue()).map((r) => r.itemId)).not.toContain(legacy.combo.id);
    const audit = await system(() => app.prisma.auditLog.findMany({ where: { entityId: { in: [legacy.combo.id, legacy.rum.id] } } }));
    expect(audit.map((a) => a.entityId).sort()).toEqual(expect.arrayContaining([legacy.combo.id, legacy.rum.id]));
  });
});

describe('[§8] nobody can cart or order a hidden item', () => {
  it('cart add is refused in the sold-out shape every app handles; an approved item and an ordinary one add', async () => {
    const bottle = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendor.id, itemId: legacy.bottle.id, quantity: 1 });
    expect(bottle.statusCode).toBe(409);
    expect(bottle.json().error).toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { itemId: legacy.bottle.id, reason: 'PROHIBITED' } });
    expect(bottle.json().error.message).toBe(`${legacy.bottle.name} isn't available on Swift. Remove it from your cart to continue.`);
    expect((await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendor.id, itemId: control.id, quantity: 1 })).statusCode).toBe(201);
    expect((await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendor.id, itemId: legacy.rum.id, quantity: 1 })).statusCode).toBe(201);
  });

  it('an existing cart line: marked unavailable, cannot grow, blocks checkout — and can always be removed', async () => {
    const cart = await app.prisma.cart.findUniqueOrThrow({ where: { customerId: customer.id } });
    const line = await app.prisma.cartItem.create({ data: { cartId: cart.id, itemId: legacy.relief.id, quantity: 1, selectedOptions: {} } });
    const view = await inject('GET', '/api/v1/customer/cart', customer.token);
    expect(view.statusCode).toBe(200);
    const data = view.json().data;
    expect(data.unavailableItemIds).toEqual([line.id]);
    expect(data.items.find((i: { id: string }) => i.id === line.id)).toMatchObject({ isAvailable: false });
    expect(data.items.find((i: { itemId: string }) => i.itemId === control.id)).toMatchObject({ isAvailable: true });
    expect((await inject('PUT', `/api/v1/customer/cart/items/${line.id}`, customer.token, { quantity: 2 })).statusCode).toBe(409);
    const ordersBefore = await app.prisma.order.count({ where: { vendorId: vendor.id } });
    await expect(runWithTenant(TENANT, () => orders.checkout({ userId: customer.id, paymentMethod: 'CASH', fulfillmentSelections: { [vendor.id]: 'PICKUP' } })))
      .rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { itemId: legacy.relief.id, reason: 'PROHIBITED' } });
    expect(await app.prisma.order.count({ where: { vendorId: vendor.id } })).toBe(ordersBefore);
    expect((await inject('DELETE', `/api/v1/customer/cart/items/${line.id}`, customer.token)).statusCode).toBe(200);
    // With the hidden line gone, the same cart (an approved item and an ordinary one) is ordered.
    const placed = await runWithTenant(TENANT, () => orders.checkout({ userId: customer.id, paymentMethod: 'CASH', fulfillmentSelections: { [vendor.id]: 'PICKUP' } }));
    expect(placed.order.id).toBeTruthy();
  });

  it('reorder brings back only what may be sold; a basket upload and a substitution refuse a hidden item', async () => {
    const lineOf = (i: { id: string; name: string }) => ({ itemId: i.id, name: i.name, quantity: 1, basePrice: 1500, markedUpPrice: 1500, markupAmount: 0, totalBase: 1500, totalMarkup: 0, totalCustomer: 1500 });
    const order = (status: 'DELIVERED' | 'PREPARING', lines: Array<{ id: string; name: string }>) => app.prisma.order.create({ data: {
      orderNumber: `PRHB-${status}-${RUN}`, orderType: 'GROCERY_DELIVERY', customerId: customer.id, vendorId: vendor.id, status,
      fulfillment: 'PICKUP', deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1500 * lines.length, subtotalMarkup: 0, subtotalCustomer: 1500 * lines.length, deliveryFee: 0, totalAmount: 1500 * lines.length, paymentMethod: 'CASH',
      items: { create: lines.map(lineOf) },
    }, include: { items: true } });
    // An order placed before this rule, holding a line it now hides.
    const past = await order('DELIVERED', [control, legacy.bottle]);
    const reorder = await inject('POST', `/api/v1/customer/orders/${past.id}/reorder`, customer.token, {});
    expect(reorder.statusCode).toBe(200);
    expect(reorder.json().data).toMatchObject({ itemsAdded: 1, unavailableItems: 1 });
    const cart = await app.prisma.cart.findUniqueOrThrow({ where: { customerId: customer.id }, include: { items: true } });
    expect(cart.items.map((i) => i.itemId)).toEqual([control.id]);

    const merged = await runWithTenant(TENANT, () => mergeGuestCart(app.prisma, customer.id, `prohibited-${RUN}`, { lines: [{ clientLineId: 'line-a', vendorId: vendor.id, itemId: legacy.bottle.id, quantity: 1, expectedUnitPrice: 1500 }] }));
    expect(merged).toEqual({ applied: false, verdicts: [{ clientLineId: 'line-a', status: 'UNAVAILABLE' }] });
    const mergedOk = await runWithTenant(TENANT, () => mergeGuestCart(app.prisma, customer.id, `ordinary-${RUN}`, { lines: [{ clientLineId: 'line-b', vendorId: vendor.id, itemId: control.id, quantity: 1, expectedUnitPrice: 1500 }] }));
    expect(mergedOk.applied).toBe(true);

    const picked = await order('PREPARING', [control]);
    await expect(runWithTenant(TENANT, () => picking.proposeSubstitution(picked.id, picked.items[0]!.id, legacy.bottle.id, vendor.ownerUserId)))
      .rejects.toMatchObject({ code: 'SUBSTITUTE_UNAVAILABLE', message: 'That substitute isn\'t available on Swift' });
  });
});
