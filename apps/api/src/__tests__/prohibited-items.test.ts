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
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
import { partnerRoutes } from '../modules/partner/partner.routes';
import ts from 'typescript';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { OrderService } from '../modules/order/order.service';
import { PickingService } from '../modules/order/picking.service';
import { mergeGuestCart } from '../modules/user/cart-merge.service';
import { catalogueChecksFor, HIDDEN_IDS_CACHE_MS, hiddenItemIds, movesTowardCustomer, resetHiddenItemIdsCacheForTests, settleProhibitedCachesForTests, unhideRestocked, wordsFor } from '../modules/compliance/prohibited-gate';
import { judgedWordsHash, STORE_WAITING_FOR_CHECK, STORE_WAITING_MESSAGE } from '../modules/compliance/prohibited-items';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { lockUserRoleAuthority } from '../modules/mover-authority';
import { wordFreeTag } from './helpers/fixture-ids';

// The index engine is the only thing replaced: what it returns is decided per
// test, so the signed-in (index) path and the database fallback are both run.
const engine = vi.hoisted(() => ({ itemHits: [] as Array<Record<string, unknown>>, vendorHits: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock('../modules/search/search.service', () => ({ SearchService: class {
  async initialize() {}
  async syncAllVendors() { return 0; }
  async syncAllItems() { return 0; }
  async syncVendorItems() { return 0; }
  async removeItemDoc() {}
  async searchVendors() { if (engine.fail) throw new Error('index down'); return { hits: engine.vendorHits, estimatedTotalHits: engine.vendorHits.length, processingTimeMs: 1 }; }
  async searchItems() { if (engine.fail) throw new Error('index down'); return { hits: engine.itemHits, estimatedTotalHits: engine.itemHits.length, processingTimeMs: 1 }; }
} }));

const RUN = wordFreeTag(8);
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
const inFlightOrderIds: string[] = [];

let vendor: { id: string; slug: string; token: string; ownerUserId: string; shelfId: string; legacySectionId: string };
let customer: { id: string; token: string };
let admin: { id: string; token: string };
let control: { id: string; name: string };
type Legacy = 'rum' | 'cake' | 'combo' | 'bottle' | 'relief' | 'removed' | 'accent';
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

/** [DS1267 S4] Every object literal that switches an item on AND clears its auto-hide, named by the statement it is
 *  written in (and its enclosing function, when it has a name). */
function unhideWrites(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const keyOf = (p: ts.ObjectLiteralElementLike) => (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name: string) => node.properties.find((p) => keyOf(p) === name);
      const on = prop('isAvailable');
      const cleared = prop('autoHiddenAt');
      if (on && cleared && ts.isPropertyAssignment(on) && ts.isPropertyAssignment(cleared)
        && on.initializer.kind === ts.SyntaxKind.TrueKeyword && cleared.initializer.kind === ts.SyntaxKind.NullKeyword) {
        let statement: ts.Node = node;
        while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) statement = statement.parent;
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
        const name = fn && ts.isFunctionDeclaration(fn) && fn.name ? `${fn.name.text}: ` : '';
        out.push(`${name}${statement.getText(source).replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
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
  const data = res.json().data as { items: Array<{ itemId: string; wordsHash: string; state: string; prohibitedClass: string; field: string; term: string }>; total: number };
  expect(data.total).toBeGreaterThanOrEqual(data.items.length);
  return data.items;
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
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
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
  // [Opus S3-9] Showing a held item needs the explicit catalogue-approver grant; this admin is given it on the record.
  const granted = await inject('PUT', `/api/v1/admin/staff/${admin.id}/catalogue-approver`, admin.token, { grant: true }, { 'x-swift-reason': 'Runs the prohibited-items check' });
  if (granted.statusCode !== 200) throw new Error(`catalogue-approver grant failed: ${granted.body}`);

  pharmacyCategory = await discoveryCategory('pharmacy', 'RETAIL');
  snacksCategory = await discoveryCategory('snacks', 'AISLE');

  const c = await item({ name: `Legacy Pepperpot ${RUN}` });
  control = { id: c.id, name: c.name };
  for (const [key, data] of [
    // [#55] A bottle of rum by name is refused outright, never approvable ("Legacy Rum" is the goods);
    // a rum cake is held for a person. The run tag LEADS where a goods noun must stay the last word.
    ['rum', { name: `${RUN} Legacy Rum` }],
    ['cake', { name: `Legacy Rum cake ${RUN}` }],
    ['combo', { name: `Legacy Combo ${RUN}`, options: ['Coke', 'Beer-battered fries'] }],
    ['bottle', { name: `Legacy Bottle ${RUN}`, categoryId: legacySection.id }],
    ['relief', { name: `Legacy Relief ${RUN}` }],
    ['removed', { name: `Legacy Tonic ${RUN}`, removed: { cls: 'MEDICINE', reason: 'Sold as a cure for fever' } }],
    // [DS1100 S2] A banned word written with an accent the plain pattern does not spell
    // (precomposed "Ś", and a combining acute inside "be\u0301er"): judged exactly like "stout".
    ['accent', { name: `Legacy \u015Atout be\u0301er mug ${RUN}` }],
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
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: inFlightOrderIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.address.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[§8] a partner saving and editing items', () => {
  it('a banned word saves the item but holds it for a quick check; an ordinary item is simply saved', async () => {
    const beer = await createItem({ name: `Beer batter fish ${RUN}` });
    expect(beer.statusCode).toBe(200);
    expect(beer.json().data.catalogueCheck).toEqual({ status: 'WAITING_FOR_CHECK', message: 'Waiting for a quick check', prohibitedClass: 'ALCOHOL', field: 'name', term: 'beer' });
    const combo = await createItem({ name: `Chicken combo ${RUN}`, optionGroups: [{ name: 'Add a side', options: [{ name: 'Coke' }, { name: 'Beer-battered fries' }] }] });
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
    const toRum = await inject('PUT', `/api/v1/vendor/items/${id}`, vendor.token, { name: `Rum glazed wings ${RUN}` });
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
      `Shelf,${RUN} Banks Beer,,400,,,,,,`,
      `Shelf,Mauby ${RUN},Bark brew,300,,,,,,`,
      `Pharmacy ${RUN},Vitamin C ${RUN},,900,,,,,,`,
      `Shelf,Cough syrup ${RUN},,700,,,,,,`,
      `Shelf,Beer batter mix ${RUN},,450,,,,,,`,
    ].join('\n');
    const res = await inject('POST', '/api/v1/vendor/items/import', vendor.token, { csv });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    // [#55] A row that IS banned goods (a beer, a cough syrup) is refused and listed; a word only holds the row.
    expect(data).toMatchObject({ imported: 3, failedCount: 2, waitingForCheckCount: 2 });
    expect(data.failures).toEqual([
      { row: 2, errors: ['Swift doesn\'t allow this item: alcohol.'] },
      { row: 5, errors: ['Swift doesn\'t allow this item: medicines.'] },
    ]);
    expect(data.waitingForCheck.map((w: { row: number }) => w.row).sort()).toEqual([4, 6]);
    expect(await app.prisma.item.count({ where: { vendorId: vendor.id, name: { in: [`${RUN} Banks Beer`, `Cough syrup ${RUN}`] } } })).toBe(0);
    const mauby = await app.prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: `Mauby ${RUN}` } });
    const batter = await app.prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: `Beer batter mix ${RUN}` } });
    await visibleOn(storefrontItemIds, [mauby.id], [batter.id]);
  });

  // [#55/#56 · Opus S1-LAUNCH-2] A name or an option that IS beer, wine, spirits, tobacco, a vape or a branded
  // medicine is refused outright — on create, rename and options — never held for a reviewer.
  it('a name or an option that IS banned goods is refused outright; an item banned by its own name can be renamed out of it', async () => {
    const before = await app.prisma.item.count({ where: { vendorId: vendor.id } });
    for (const body of [
      { name: `${RUN} Hennessy VS` },
      { name: `${RUN} Red Wine 750ml` },
      { name: `${RUN} Cooking wine` },
      { name: `Wings combo ${RUN}`, optionGroups: [{ name: 'Add a drink', options: [{ name: 'Coke' }, { name: 'Carib Lager' }] }] },
    ]) {
      const res = await createItem(body);
      expect(res.statusCode, body.name).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', message: 'Swift doesn\'t allow this item: alcohol.' });
    }
    expect(await app.prisma.item.count({ where: { vendorId: vendor.id } })).toBe(before);

    const plain = (await createItem({ name: `Garlic pork ${RUN}` })).json().data.id as string;
    const toWine = await inject('PUT', `/api/v1/vendor/items/${plain}`, vendor.token, { name: `${RUN} House wine` });
    expect(toWine.statusCode).toBe(409);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: plain } })).name).toBe(`Garlic pork ${RUN}`);
    const drinks = await inject('POST', `/api/v1/vendor/items/${plain}/option-groups`, vendor.token, { name: 'Add a drink', options: [{ name: 'Coke' }, { name: 'Heineken 0.0' }] });
    expect(drinks.statusCode).toBe(409);
    const group = await inject('POST', `/api/v1/vendor/items/${plain}/option-groups`, vendor.token, { name: 'Add a drink', options: [{ name: 'Coke' }] });
    expect(group.statusCode).toBe(200);
    const groupId = group.json().data.id as string;
    expect((await inject('POST', `/api/v1/vendor/option-groups/${groupId}/options`, vendor.token, { name: 'Shot of rum' })).statusCode).toBe(409);
    const coke = group.json().data.options[0].id as string;
    expect((await inject('PUT', `/api/v1/vendor/options/${coke}`, vendor.token, { name: 'Stag 12oz beer' })).statusCode).toBe(409);
    expect((await inject('PUT', `/api/v1/vendor/option-groups/${groupId}`, vendor.token, { name: 'Beers' })).statusCode).toBe(409);
    expect((await inject('PUT', `/api/v1/vendor/options/${coke}`, vendor.token, { name: 'Sprite' })).statusCode).toBe(200);

    // A legacy row banned by its own name: never switched on, but it can be renamed out of the ban.
    const legacyBottle = await item({ name: `${RUN} Old Rum` });
    expect((await inject('PUT', `/api/v1/vendor/items/${legacyBottle.id}/availability`, vendor.token, { isAvailable: true })).statusCode).toBe(409);
    const renamed = await inject('PUT', `/api/v1/vendor/items/${legacyBottle.id}`, vendor.token, { name: `Rum cake slice ${RUN}` });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', term: 'rum' });
  });

  // [R4 · owner 15 Oct] The expanded permanent list answers exactly like the old classes, through the real routes.
  it('the expanded list: goods refused outright in the partner\'s words, a mention held, legal services refused', async () => {
    const before = await app.prisma.item.count({ where: { vendorId: vendor.id } });
    for (const [name, words] of [
      [`${RUN} Fireworks 10 pack`, 'fireworks and explosives'],
      [`${RUN} Weed killer 1L`, 'pesticides and toxic chemicals'],
      [`${RUN} Raw gold`, 'raw gold, diamonds and precious stones'],
      [`${RUN} Toy pistol`, 'firearms, ammunition and replicas'],
      [`${RUN} Twa twa`, 'protected wildlife'],
      [`Counterfeit Rolex ${RUN}`, 'counterfeit goods'],
      [`Prepaid Visa ${RUN}`, 'currency and payment cards'],
      [`Legal consultation ${RUN}`, 'legal services'],
    ] as const) {
      const res = await createItem({ name });
      expect(res.statusCode, name).toBe(409);
      expect(res.json().error, name).toMatchObject({ code: 'PROHIBITED_ITEM', message: `Swift doesn't allow this item: ${words}.` });
    }
    expect(await app.prisma.item.count({ where: { vendorId: vendor.id } })).toBe(before);
    const held = await createItem({ name: `Gun ${RUN}` });
    expect(held.statusCode).toBe(200);
    expect(held.json().data.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', prohibitedClass: 'WEAPONS', term: 'gun' });
    const tool = await createItem({ name: `Hot glue gun ${RUN}` });
    expect(tool.statusCode).toBe(200);
    expect(tool.json().data.catalogueCheck ?? null).toBeNull();
    // A person can remove a held item as one of the new classes; the partner reads the class in plain words.
    const removed = await inject('POST', `/api/v1/admin/catalogue-review/${held.json().data.id}/remove`, admin.token, { prohibitedClass: 'WEAPONS' }, { 'x-swift-reason': 'Sells a firearm' });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await app.prisma.item.findUniqueOrThrow({ where: { id: held.json().data.id }, select: { prohibitedClass: true } })).toEqual({ prohibitedClass: 'WEAPONS' });
  });

  // [Opus S3-1] The item editor never switches on an item still banned by its own words: the item AFTER the edit is
  // judged, in the same transaction. Renamed out of the ban in the same request, it may be switched on; a restock
  // never switches a banned item back on, and its stock count is still saved.
  it('the item editor never switches on an item still banned by its words; a restock leaves it off', async () => {
    const off = async (name: string, extra: Record<string, unknown> = {}) => {
      const row = await item({ name });
      // Ranked last, so the items this test switches on never crowd the Home rail the surface tests read.
      return app.prisma.item.update({ where: { id: row.id }, data: { isAvailable: false, totalOrdered: 0, ...extra } });
    };
    const row = (id: string) => app.prisma.item.findUniqueOrThrow({ where: { id } });

    const bottle = await off(`${RUN} Spare Rum`);
    const on = await inject('PUT', `/api/v1/vendor/items/${bottle.id}`, vendor.token, { isAvailable: true, description: 'Cold' });
    expect(on.statusCode).toBe(409);
    expect(on.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', message: 'Swift doesn\'t allow this item: alcohol.' });
    expect(await row(bottle.id)).toMatchObject({ isAvailable: false, description: null });

    const out = await inject('PUT', `/api/v1/vendor/items/${bottle.id}`, vendor.token, { name: `Coconut cake ${RUN}`, isAvailable: true });
    expect(out.statusCode).toBe(200);
    expect(await row(bottle.id)).toMatchObject({ isAvailable: true, name: `Coconut cake ${RUN}` });

    const shelved = await off(`${RUN} Spare Vodka`, { autoHiddenAt: new Date(), stockQuantity: 0 });
    const restock = await inject('PUT', `/api/v1/vendor/items/${shelved.id}`, vendor.token, { stockQuantity: 5 });
    expect(restock.statusCode).toBe(200);
    expect(await row(shelved.id)).toMatchObject({ isAvailable: false, stockQuantity: 5 });

    // Control: an ordinary auto-hidden item comes back on with its restock.
    const bread = await off(`Coconut bread ${RUN}`, { autoHiddenAt: new Date(), stockQuantity: 0 });
    expect((await inject('PUT', `/api/v1/vendor/items/${bread.id}`, vendor.token, { stockQuantity: 5 })).statusCode).toBe(200);
    expect(await row(bread.id)).toMatchObject({ isAvailable: true, autoHiddenAt: null, stockQuantity: 5 });
  });

  // [DS1266 S3 · the rule of Opus S3-1] Stock coming back un-hides only an item Swift allows: the stock adjust route,
  // an order cancelled before pickup and a picking restock all go through one guard (unhideRestocked).
  it('stock coming back never switches on a banned item; an ordinary auto-hidden item comes back', async () => {
    const shelf = async (name: string, stockQuantity: number) => {
      const created = await item({ name });
      return app.prisma.item.update({ where: { id: created.id }, data: { isAvailable: false, autoHiddenAt: new Date(), stockQuantity, totalOrdered: 0 } });
    };
    const row = (id: string) => app.prisma.item.findUniqueOrThrow({ where: { id } });

    const gin = await shelf(`${RUN} Spare Gin`, 0);
    expect((await inject('POST', `/api/v1/vendor/items/${gin.id}/adjust`, vendor.token, { delta: 5, reason: 'RECEIVED' })).statusCode).toBe(200);
    expect(await row(gin.id)).toMatchObject({ isAvailable: false, stockQuantity: 5 });
    const bun = await shelf(`Coconut bun ${RUN}`, 0);
    expect((await inject('POST', `/api/v1/vendor/items/${bun.id}/adjust`, vendor.token, { delta: 5, reason: 'RECEIVED' })).statusCode).toBe(200);
    expect(await row(bun.id)).toMatchObject({ isAvailable: true, autoHiddenAt: null, stockQuantity: 5 });

    const whisky = await shelf(`${RUN} Spare Whisky`, 3);
    await unhideRestocked(app.prisma, whisky.id);
    expect(await row(whisky.id)).toMatchObject({ isAvailable: false });
    const roll = await shelf(`Coconut roll ${RUN}`, 3);
    await unhideRestocked(app.prisma, roll.id);
    expect(await row(roll.id)).toMatchObject({ isAvailable: true, autoHiddenAt: null });
  });

  // [DS1267 S4] Read as code, not as one way of formatting it: any object that sets `isAvailable: true` AND
  // `autoHiddenAt: null` — in either order, across lines, quoted or not, with other fields between — is a site.
  it('no code un-hides a restocked item except through the guard (or the item editor, which judges the item first)', () => {
    const root = join(__dirname, '..', 'modules');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.includes('.test.') ? [join(dir, e.name)] : []));
    })(root);
    expect(files.length).toBeGreaterThan(300);
    const sites = files.flatMap((file) => unhideWrites(file, readFileSync(file, 'utf8')).map((at) => `${relative(root, file)}: ${at}`));
    expect(sites).toEqual([
      expect.stringMatching(/^compliance\/prohibited-gate\.ts: unhideRestocked: await tx\.item\.updateMany/),
      expect.stringMatching(/^vendor\/vendor\.routes\.ts: vendorRoutes: return banned \? updated : tx\.item\.update/),
    ]);
  });

  it('the census reads every way of writing it (in-test cases)', () => {
    const found = (code: string) => unhideWrites('case.ts', code).length;
    expect(found('db.item.update({ data: {\n  autoHiddenAt: null,\n  isAvailable: true,\n} });')).toBe(1); // reordered, across lines
    expect(found('db.item.update({ data: { "isAvailable": true, \'autoHiddenAt\': null } });')).toBe(1); // quoted keys
    expect(found('db.item.update({ data: { isAvailable: true, stockQuantity: 5, autoHiddenAt: null } });')).toBe(1); // a field between
    expect(found('function f() { return { autoHiddenAt: null, isAvailable: true }; }')).toBe(1);
    expect(found('db.item.update({ data: { isAvailable: false, autoHiddenAt: null } });')).toBe(0);
    expect(found('db.item.update({ data: { isAvailable: true } });')).toBe(0);
    expect(found('db.item.update({ data: { autoHiddenAt: null } });')).toBe(0);
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
    resetHiddenItemIdsCacheForTests();
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

  it('a stale exclusion list never shows a hidden item: the exact last pass on every surface catches it', async () => {
    // Prime every tenant's list as if nothing were hidden, then read every browse surface.
    const { hiddenItemIds } = await import('../modules/compliance/prohibited-gate');
    resetHiddenItemIdsCacheForTests();
    const nothingHidden = { item: { findMany: async () => [] }, itemDiscoveryCategory: { findMany: async () => [] }, discoveryCategory: { findMany: async () => [] }, vendor: { findMany: async () => [] }, $queryRaw: async () => [] };
    expect(await hiddenItemIds(nothingHidden as never, TENANT)).toEqual([]);
    try {
      await visibleOn(marketItemIds, [control.id], hiddenIds());
      engine.fail = false;
      await visibleOn(searchItemIds, [control.id], hiddenIds());
      engine.fail = true;
      try { await visibleOn(searchItemIds, [control.id], hiddenIds()); } finally { engine.fail = false; }
      await visibleOn(async () => ids((await inject('GET', '/api/v1/search/trending', customer.token)).json().data), [control.id], hiddenIds());
      const words = ((await inject('GET', `/api/v1/search/suggestions?q=${RUN}`, customer.token)).json().data as Array<{ text: string }>).map((x) => x.text);
      for (const l of Object.values(legacy)) expect(words).not.toContain(l.name);
    } finally { resetHiddenItemIdsCacheForTests(); }
  });

  it('signed in, the database top-up of a short index answer never brings a hidden item back, even on a stale exclusion list', async () => {
    // The index answers nothing here (it has not caught up yet, or cannot match
    // inside a word), so every row on the page comes from the index path's
    // database top-up — the control proves the top-up ran and found rows.
    const { hiddenItemIds } = await import('../modules/compliance/prohibited-gate');
    const indexAnswer = engine.itemHits;
    engine.itemHits = [];
    engine.fail = false;
    const topUpIds = async () => {
      const res = await inject('GET', `/api/v1/search?q=${RUN}&limit=50`, customer.token);
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { items: Array<{ id: string }>; meta: { processingTimeMs?: number } };
      expect(data.meta.processingTimeMs, 'the index path answered, not the database fallback').toBeTypeOf('number');
      return ids(data.items);
    };
    try {
      resetHiddenItemIdsCacheForTests();
      await visibleOn(topUpIds, [control.id], hiddenIds());
      // A stale list: only the exact last pass inside the top-up stands between a hidden row and the page.
      resetHiddenItemIdsCacheForTests();
      const nothingHidden = { item: { findMany: async () => [] }, itemDiscoveryCategory: { findMany: async () => [] }, discoveryCategory: { findMany: async () => [] }, vendor: { findMany: async () => [] }, $queryRaw: async () => [] };
      expect(await hiddenItemIds(nothingHidden as never, TENANT)).toEqual([]);
      await visibleOn(topUpIds, [control.id], hiddenIds());
    } finally {
      engine.itemHits = indexAnswer;
      resetHiddenItemIdsCacheForTests();
    }
  });

  it('the category rail never offers Pharmacy', async () => {
    const row = await system(() => app.prisma.platformConfig.findUnique({ where: { key: CATEGORY_DISCOVERY_FLAG } }));
    priorPlatformFlag = row ? row.value : null;
    await system(() => app.prisma.platformConfig.upsert({ where: { key: CATEGORY_DISCOVERY_FLAG }, create: { key: CATEGORY_DISCOVERY_FLAG, value: true }, update: { value: true } }));
    await system(() => app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: vendor.id } }));
    await system(() => app.prisma.vendorDiscoveryCategory.createMany({ data: [
      { tenantId: TENANT, vendorId: vendor.id, categoryId: snacksCategory.id, role: 'PRIMARY', source: 'ADMIN' },
      // Derived by the machine from its Pharmacy-tagged item (legacy.relief) — the rail must still never offer it.
      // A store CHOSEN into Pharmacy is hidden outright (#54, the last describe below).
      { tenantId: TENANT, vendorId: vendor.id, categoryId: pharmacyCategory.id, role: 'SECONDARY', source: 'DERIVED' },
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
    expect(rows.find((r) => r.id === legacy.rum.id)?.catalogueCheck).toEqual({ status: 'NOT_ALLOWED', message: 'Swift doesn\'t allow this item: alcohol.', prohibitedClass: 'ALCOHOL', reason: null });
    expect(rows.find((r) => r.id === legacy.cake.id)?.catalogueCheck).toEqual({ status: 'WAITING_FOR_CHECK', message: 'Waiting for a quick check', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });
    expect(rows.find((r) => r.id === legacy.relief.id)?.catalogueCheck).toEqual({ status: 'NOT_ALLOWED', message: 'Swift doesn\'t allow this item: medicines.', prohibitedClass: 'MEDICINE', reason: null });
    expect(rows.find((r) => r.id === legacy.removed.id)?.catalogueCheck).toMatchObject({ status: 'NOT_ALLOWED', reason: 'Sold as a cure for fever' });
    expect(rows.find((r) => r.id === control.id)?.catalogueCheck).toBeNull();
    const detail = await inject('GET', `/api/v1/admin/vendors/${vendor.id}`, admin.token);
    expect(detail.statusCode).toBe(200);
    const flagged = detail.json().data.prohibitedItems as Array<{ id: string; state: string; source?: string; field?: string; term: string | null }>;
    for (const id of hiddenIds()) expect(flagged.map((f) => f.id)).toContain(id);
    expect(flagged.find((f) => f.id === legacy.combo.id)).toMatchObject({ state: 'WAITING', field: 'option', term: 'beer' });
    expect(flagged.find((f) => f.id === legacy.rum.id)).toMatchObject({ state: 'BANNED', source: 'word', term: 'rum' });
    expect(flagged.find((f) => f.id === legacy.relief.id)).toMatchObject({ state: 'BANNED', source: 'category' });
    expect(flagged.map((f) => f.id)).not.toContain(control.id);
  });
});

describe('[§8] the admin catalogue check', () => {
  it('the queue holds the waiting items only; approval needs a reason, the words seen, and never lifts a ban', async () => {
    const q = await queue();
    const queued = q.map((r) => r.itemId);
    for (const id of [legacy.cake.id, legacy.combo.id, legacy.bottle.id]) expect(queued).toContain(id);
    // [#55] "Legacy Rum" IS a bottle of rum: never in the queue, never approvable.
    for (const id of [legacy.rum.id, legacy.relief.id, legacy.removed.id, control.id]) expect(queued).not.toContain(id);
    const cake = q.find((r) => r.itemId === legacy.cake.id)!;
    expect(cake).toMatchObject({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });

    expect((await approve(legacy.cake.id, cake.wordsHash, null)).statusCode).toBe(400);
    const stale = await approve(legacy.cake.id, '0'.repeat(64));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ITEM_CHANGED');
    const ban = await approve(legacy.relief.id, '0'.repeat(64));
    expect(ban.statusCode).toBe(409);
    expect(ban.json().error.message).toBe('Approval never lifts a ban. Swift doesn\'t allow this item: medicines.');
    expect((await approve(control.id, '0'.repeat(64))).json().error.code).toBe('NOTHING_TO_CHECK');
    const rumWords = (await wordsFor(app.prisma, [legacy.rum.id])).get(legacy.rum.id)!;
    const rum = await approve(legacy.rum.id, judgedWordsHash(rumWords));
    expect(rum.statusCode).toBe(409);
    expect(rum.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', message: 'Approval never lifts a ban. Swift doesn\'t allow this item: alcohol.' });
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: legacy.rum.id }, select: { reviewApprovedHash: true } })).reviewApprovedHash).toBeNull();

    const ok = await approve(legacy.cake.id, cake.wordsHash);
    expect(ok.statusCode).toBe(200);
    await visibleOn(storefrontItemIds, [legacy.cake.id], [legacy.combo.id, legacy.rum.id]);
    expect((await queue()).map((r) => r.itemId)).not.toContain(legacy.cake.id);
  });

  // [Opus S3-9] Showing a held item is a criminal-liability decision: it needs an explicit grant that `*` and the
  // role defaults never imply, and its record is written in the same transaction as the approval.
  it('approving needs the catalogue-approver grant; the record is written with the approval', async () => {
    const toffee = (await createItem({ name: `Rum toffee ${RUN}` })).json().data.id as string;
    const row = (await queue()).find((q) => q.itemId === toffee)!;
    const second = await userWithSession(['SUPER_ADMIN'], 'SUPER_ADMIN');
    const refused = await inject('POST', `/api/v1/admin/catalogue-review/${toffee}/approve`, second.token, { wordsHash: row.wordsHash }, { 'x-swift-reason': REASON });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: 'CATALOGUE_APPROVER_REQUIRED', message: 'You need the catalogue-approver permission to show a held item. Ask a super-admin to grant it to you. You can still remove an item.' });
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: toffee }, select: { reviewApprovedHash: true } })).reviewApprovedHash).toBeNull();
    // Without the grant a moderator still REMOVES (the strict direction).
    const scratch = await item({ name: `Rum glaze ${RUN}` });
    expect((await inject('POST', `/api/v1/admin/catalogue-review/${scratch.id}/remove`, second.token, { prohibitedClass: 'ALCOHOL' }, { 'x-swift-reason': REASON })).statusCode).toBe(200);

    expect((await inject('PUT', `/api/v1/admin/staff/${second.id}/catalogue-approver`, admin.token, { grant: true })).statusCode).toBe(400); // a reason is owed
    expect((await inject('PUT', `/api/v1/admin/staff/${second.id}/catalogue-approver`, admin.token, { grant: true }, { 'x-swift-reason': 'Joins the catalogue check' })).statusCode).toBe(200);
    const staff = (await inject('GET', '/api/v1/admin/staff/document-reviewers', admin.token)).json().data as Array<{ userId: string; catalogueApprover: boolean; documentReviewer: boolean }>;
    expect(staff.find((u) => u.userId === second.id)).toMatchObject({ catalogueApprover: true, documentReviewer: false });
    const ok = await inject('POST', `/api/v1/admin/catalogue-review/${toffee}/approve`, second.token, { wordsHash: row.wordsHash }, { 'x-swift-reason': REASON });
    expect(ok.statusCode).toBe(200);
    const records = await system(() => app.prisma.auditLog.findMany({ where: { entityId: toffee, userId: second.id } }));
    expect(records.filter((r) => (r.changes as { approvedWordsHash?: string } | null)?.approvedWordsHash === row.wordsHash)).toHaveLength(1);
  });

  // [Opus S3-10] A disguised word reaches a person: the database pre-filter reads each column as the
  // classifier does (format characters, look-alikes, fullwidth, spelled-out letters, "rosé").
  it('a disguised word reaches the queue', async () => {
    const ids: string[] = [];
    for (const description of ['R\u200Bum truffles', 'Rцm truffles', 'Ｒｕｍ truffles', 'R.U.M truffles', 'Rosé jelly', 'Неineken glaze',
      // [evasion] l33t, a brand plural, a split word
      'v4pe flavour', 'Heinekens glaze', 'Hen nessy glaze']) {
      const row = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: vendor.shelfId, name: `Gift box ${ids.length} ${RUN}`, description, basePrice: 900 } });
      ids.push(row.id);
    }
    const queued = await queue();
    for (const id of ids) expect(queued.find((r) => r.itemId === id), id).toMatchObject({ state: 'WAITING', field: 'description' });
    await visibleOn(storefrontItemIds, [control.id], ids);
  });

  it('a partner edit after the reviewer opened the item: that approval is refused and the item stays hidden; the current words can be approved', async () => {
    const fudge = await createItem({ name: `Rum fudge ${RUN}` });
    const fudgeId = fudge.json().data.id as string;
    const seen = (await queue()).find((q) => q.itemId === fudgeId)!;
    // The partner changes the words while the reviewer is reading the old ones.
    expect((await inject('PUT', `/api/v1/vendor/items/${fudgeId}`, vendor.token, { name: `Rum fudge (1kg) ${RUN}` })).statusCode).toBe(200);
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
    const audit = await system(() => app.prisma.auditLog.findMany({ where: { entityId: { in: [legacy.combo.id, legacy.cake.id] } } }));
    expect(audit.map((a) => a.entityId).sort()).toEqual(expect.arrayContaining([legacy.combo.id, legacy.cake.id]));
  });
});

describe('[§8] nobody can cart or order a hidden item', () => {
  it('cart add is refused in the sold-out shape every app handles; an approved item and an ordinary one add', async () => {
    const bottle = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendor.id, itemId: legacy.bottle.id, quantity: 1 });
    expect(bottle.statusCode).toBe(409);
    expect(bottle.json().error).toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { itemId: legacy.bottle.id, reason: 'PROHIBITED' } });
    expect(bottle.json().error.message).toBe(`${legacy.bottle.name} isn't available on Swift. Remove it from your cart to continue.`);
    expect((await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendor.id, itemId: control.id, quantity: 1 })).statusCode).toBe(201);
    expect((await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: vendor.id, itemId: legacy.cake.id, quantity: 1 })).statusCode).toBe(201);
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

describe('[§8] an order already placed with a line Swift no longer allows never moves toward the customer', () => {
  // An order placed before this rule existed — or whose item a person removed, or whose words changed,
  // after it was placed. The store cannot accept, prepare or hand it over and no rider can be assigned
  // to it; rejecting or cancelling it is never refused. (Checkout already refuses such a line.)
  const lineOf = (i: { id: string; name: string }) => ({ itemId: i.id, name: i.name, quantity: 1, basePrice: 1500, markedUpPrice: 1500, markupAmount: 0, totalBase: 1500, totalMarkup: 0, totalCustomer: 1500 });
  let n = 0;
  const placed = async (status: 'PENDING' | 'ACCEPTED' | 'READY_FOR_PICKUP', lines: Array<{ id: string; name: string }>, fulfillment: 'PICKUP' | 'DELIVERY' = 'PICKUP') => {
    n += 1;
    const o = await app.prisma.order.create({ data: {
      orderNumber: `PRHB-FLIGHT-${n}-${RUN}`, orderType: 'GROCERY_DELIVERY', customerId: customer.id, vendorId: vendor.id, status, fulfillment,
      ...(fulfillment === 'DELIVERY' ? { fulfillmentMode: 'PLATFORM_RIDER' as const, readyAt: new Date(), pickupAddress: '1 Rule Street', pickupLat: 6.801, pickupLng: -58.156 } : {}),
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1500 * lines.length, subtotalMarkup: 0, subtotalCustomer: 1500 * lines.length, deliveryFee: 0, totalAmount: 1500 * lines.length, paymentMethod: 'CASH',
      items: { create: lines.map(lineOf) },
    } });
    inFlightOrderIds.push(o.id);
    return o;
  };
  const statusOf = async (id: string) => (await app.prisma.order.findUniqueOrThrow({ where: { id } })).status;
  const rider = async () => {
    const user = await userWithSession(['RIDER'], 'RIDER');
    const session = await app.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    const row = await app.prisma.rider.create({ data: { userId: user.id, isOnline: true, isAvailable: true, documentsVerified: true, locationSessionId: session.id,
      currentLat: 6.801, currentLng: -58.156, lastLocationUpdate: new Date(), riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', floatLimit: 100_000 } });
    return { userId: user.id, riderId: row.id };
  };

  it('which moves are held back: only those taking the goods toward the customer while they are still at the store', () => {
    for (const [from, to] of [['PENDING', 'ACCEPTED'], ['ACCEPTED', 'PREPARING'], ['PREPARING', 'READY_FOR_PICKUP'], ['READY_FOR_PICKUP', 'RIDER_ASSIGNED'],
      ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP'], ['RIDER_ARRIVED_PICKUP', 'PICKED_UP'], ['READY_FOR_PICKUP', 'COMPLETED'], ['READY_FOR_PICKUP', 'DELIVERED']] as const) {
      expect(movesTowardCustomer(from, to), `${from} → ${to}`).toBe(true);
    }
    // Never a cancellation or a step back, and never once a rider holds the goods: a delivery under way is not stranded.
    for (const [from, to] of [['PENDING', 'CANCELLED'], ['PREPARING', 'CANCELLED'], ['RIDER_ASSIGNED', 'CANCELLED'], ['DELIVERED', 'REFUNDED'],
      ['PICKED_UP', 'EN_ROUTE_DELIVERY'], ['EN_ROUTE_DELIVERY', 'ARRIVED'], ['ARRIVED', 'DELIVERED'], ['PICKED_UP', 'DELIVERED'], ['ARRIVED', 'FAILED'],
      ['RIDER_ASSIGNED', 'READY_FOR_PICKUP'], ['DELIVERED', 'COMPLETED']] as const) {
      expect(movesTowardCustomer(from, to), `${from} → ${to}`).toBe(false);
    }
  });

  it('the store cannot accept it — removed, banned category, held by a word, or a line whose own name is banned — and can always reject it', async () => {
    const removed = await placed('PENDING', [control, legacy.removed]);
    const res = await inject('PUT', `/api/v1/vendor/orders/${removed.id}/accept`, vendor.token, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', details: { itemId: legacy.removed.id, reason: 'PROHIBITED' } });
    expect(res.json().error.message).toBe(`This order can't go ahead: ${legacy.removed.name} isn't allowed on Swift. Reject the order, or ask Swift support to cancel it — the customer is told.`);
    expect(await statusOf(removed.id)).toBe('PENDING');

    const pharmacy = await placed('PENDING', [legacy.relief]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${pharmacy.id}/accept`, vendor.token, {})).json().error).toMatchObject({ code: 'PROHIBITED_ITEM' });
    const waiting = await placed('PENDING', [legacy.bottle]);
    const held = await inject('PUT', `/api/v1/vendor/orders/${waiting.id}/accept`, vendor.token, {});
    expect(held.statusCode).toBe(409);
    expect(held.json().error.message).toBe(`This order can't go ahead yet: ${legacy.bottle.name} is waiting for a quick check by Swift. Reject the order, or wait for the check.`);
    // The line's own words count too: the item behind it may have been renamed since.
    const renamed = await placed('PENDING', [{ id: control.id, name: 'Paracetamol 500mg' }]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${renamed.id}/accept`, vendor.token, {})).statusCode).toBe(409);
    expect(await statusOf(renamed.id)).toBe('PENDING');

    // Rejecting is never refused, and an ordinary order is accepted as before.
    expect((await inject('PUT', `/api/v1/vendor/orders/${removed.id}/reject`, vendor.token, { reason: 'Item not allowed on Swift' })).statusCode).toBe(200);
    expect(await statusOf(removed.id)).toBe('CANCELLED');
    const ordinary = await placed('PENDING', [control]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${ordinary.id}/accept`, vendor.token, {})).statusCode).toBe(200);
    expect(await statusOf(ordinary.id)).toBe('ACCEPTED');
    // A word a person approved (the catalogue check above approved this rum line's words) goes ahead.
    const approvedWords = await placed('PENDING', [legacy.cake]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${approvedWords.id}/accept`, vendor.token, {})).statusCode).toBe(200);
  });

  it('nor prepare it: an accepted order whose item was removed afterwards stops there', async () => {
    const accepted = await placed('ACCEPTED', [legacy.relief]);
    const res = await inject('PUT', `/api/v1/vendor/orders/${accepted.id}/preparing`, vendor.token, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROHIBITED_ITEM');
    expect(await statusOf(accepted.id)).toBe('ACCEPTED');
    const ordinary = await placed('ACCEPTED', [control]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${ordinary.id}/preparing`, vendor.token, {})).statusCode).toBe(200);
  });

  it('no rider is assigned to it — offer card or board grab — and an ordinary order is still assigned', async () => {
    const redis = new Proxy({}, { get: () => vi.fn(async () => null) });
    const io = { to: () => ({ emit: vi.fn() }), emit: vi.fn() };
    const dispatch = new DispatchService(app.prisma, redis as never, io as never, new HaversineMapsProvider());
    const offerRider = await rider();
    const boardRider = await rider();
    const board = (orderId: string, r: { userId: string; riderId: string }) => app.prisma.$transaction(async (tx) => {
      await lockUserRoleAuthority(tx, r.userId);
      return orders.stageDirectRiderAssignment(tx, { orderId, riderId: r.riderId, moverUserId: r.userId, changedBy: r.userId });
    });
    const banned = await placed('READY_FOR_PICKUP', [control, legacy.removed], 'DELIVERY');
    for (const door of [() => dispatch.claimOrder(banned.id, offerRider.riderId, 'RIDER'), () => board(banned.id, boardRider)]) {
      await expect(door()).rejects.toMatchObject({ statusCode: 409, code: 'JOB_UNAVAILABLE', message: 'This job isn\'t available — Swift has paused it. Take another job.', details: { reason: 'PROHIBITED' } });
      expect(await app.prisma.order.findUniqueOrThrow({ where: { id: banned.id } })).toMatchObject({ status: 'READY_FOR_PICKUP', riderId: null });
    }
    const ordinaryOffer = await placed('READY_FOR_PICKUP', [control], 'DELIVERY');
    await dispatch.claimOrder(ordinaryOffer.id, offerRider.riderId, 'RIDER');
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: ordinaryOffer.id } })).toMatchObject({ status: 'RIDER_ASSIGNED', riderId: offerRider.riderId });
    const ordinaryBoard = await placed('READY_FOR_PICKUP', [control], 'DELIVERY');
    await board(ordinaryBoard.id, boardRider);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: ordinaryBoard.id } })).toMatchObject({ status: 'RIDER_ASSIGNED', riderId: boardRider.riderId });
  });

  // [DS1106 S2] The goods on a line are the substitute once the customer approved it.
  it('a substitute is judged again when the customer approves it, and an approved substitute is what the order carries', async () => {
    const clean = await item({ name: `Plain Bread ${RUN}` });
    const pending = async (substitute: { id: string; name: string }) => {
      const o = await placed('ACCEPTED', [control]);
      const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
      await app.prisma.orderItem.update({ where: { id: line.id }, data: { subStatus: 'PENDING', substituteItemId: substitute.id, substituteName: substitute.name, substitutePrice: 1500 } });
      return { orderId: o.id, lineId: line.id };
    };
    // Proposed while it was clean; a person removed it before the customer said yes.
    const removedSince = await pending(legacy.removed);
    await expect(runWithTenant(TENANT, () => picking.decideSubstitution(removedSince.orderId, removedSince.lineId, customer.id, true)))
      .rejects.toMatchObject({ code: 'SUBSTITUTE_UNAVAILABLE', message: 'That substitute isn\'t available on Swift' });
    expect((await app.prisma.orderItem.findUniqueOrThrow({ where: { id: removedSince.lineId } })).subStatus).toBe('PENDING');
    const ok = await pending({ id: clean.id, name: clean.name });
    await runWithTenant(TENANT, () => picking.decideSubstitution(ok.orderId, ok.lineId, customer.id, true));
    expect((await app.prisma.orderItem.findUniqueOrThrow({ where: { id: ok.lineId } })).subStatus).toBe('APPROVED');
    expect((await inject('PUT', `/api/v1/vendor/orders/${ok.orderId}/preparing`, vendor.token, {})).statusCode).toBe(200);
    // A clean substitute for an approved word: the line reads "Plain Bread (sub for … Rum …)", and the goods are the bread.
    const forRum = await placed('ACCEPTED', [legacy.cake]);
    const rumLine = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: forRum.id } });
    await app.prisma.orderItem.update({ where: { id: rumLine.id }, data: { subStatus: 'PENDING', substituteItemId: clean.id, substituteName: clean.name, substitutePrice: 1500 } });
    await runWithTenant(TENANT, () => picking.decideSubstitution(forRum.id, rumLine.id, customer.id, true));
    expect((await app.prisma.orderItem.findUniqueOrThrow({ where: { id: rumLine.id } })).name).toContain('sub for');
    expect((await inject('PUT', `/api/v1/vendor/orders/${forRum.id}/preparing`, vendor.token, {})).statusCode).toBe(200);

    // An order already carrying an approved substitute that is now banned does not move — even when the
    // original it replaced is an approved word (whose name the line still carries).
    for (const original of [control, legacy.cake]) {
      const o = await placed('ACCEPTED', [original]);
      const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
      await app.prisma.orderItem.update({ where: { id: line.id }, data: {
        subStatus: 'APPROVED', substituteItemId: legacy.removed.id, substituteName: legacy.removed.name, substitutePrice: 1500,
        name: `${legacy.removed.name} (sub for ${original.name})`,
      } });
      const res = await inject('PUT', `/api/v1/vendor/orders/${o.id}/preparing`, vendor.token, {});
      expect(res.statusCode, original.name).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', details: { itemId: legacy.removed.id } });
    }
  });

  // [Opus S3-6/S3-7] The store's own courier already has the goods: "delivered" is never held. And once the store
  // cannot reject (ready, or MMG money already moved), a refusal never tells it to.
  it('a store-delivered order can always be marked delivered; a refusal never says "Reject" when the store cannot', async () => {
    const own = await placed('READY_FOR_PICKUP', [control, legacy.removed], 'DELIVERY');
    await app.prisma.order.update({ where: { id: own.id }, data: { fulfillmentMode: 'VENDOR_DELIVERY' } });
    const delivered = await inject('PUT', `/api/v1/vendor/orders/${own.id}/delivered`, vendor.token, {});
    expect(delivered.statusCode).toBe(200);
    expect(await statusOf(own.id)).toBe('DELIVERED');

    const counter = await placed('READY_FOR_PICKUP', [legacy.removed]);
    await expect(runWithTenant(TENANT, () => orders.updateStatus(counter.id, 'COMPLETED', vendor.ownerUserId, 'Collected at the counter')))
      .rejects.toMatchObject({ code: 'PROHIBITED_ITEM', message: `This order can't go ahead: ${legacy.removed.name} isn't allowed on Swift. Ask Swift support to cancel it — the customer is told.` });
    expect(await statusOf(counter.id)).toBe('READY_FOR_PICKUP');

    const mmg = await placed('ACCEPTED', [legacy.bottle]);
    await app.prisma.order.update({ where: { id: mmg.id }, data: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' } });
    const held = await inject('PUT', `/api/v1/vendor/orders/${mmg.id}/preparing`, vendor.token, {});
    expect(held.statusCode).toBe(409);
    expect(held.json().error.message).toBe(`This order can't go ahead yet: ${legacy.bottle.name} is waiting for a quick check by Swift. Wait for the check, or ask Swift support to cancel the order — the customer is told.`);
    // Where the store CAN reject, it is told so.
    const cash = await placed('ACCEPTED', [legacy.bottle]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${cash.id}/preparing`, vendor.token, {})).json().error.message)
      .toBe(`This order can't go ahead yet: ${legacy.bottle.name} is waiting for a quick check by Swift. Reject the order, or wait for the check.`);
  });

  // [DS1106 S3] A line the store refunded, or a substitution the customer rejected, is no longer on the order.
  it('a refunded or rejected line no longer holds the order back', async () => {
    for (const subStatus of ['REFUNDED', 'REJECTED'] as const) {
      const o = await placed('ACCEPTED', [control, legacy.removed]);
      await app.prisma.orderItem.updateMany({ where: { orderId: o.id, itemId: legacy.removed.id }, data: { subStatus } });
      expect((await inject('PUT', `/api/v1/vendor/orders/${o.id}/preparing`, vendor.token, {})).statusCode, subStatus).toBe(200);
    }
    const still = await placed('ACCEPTED', [control, legacy.removed]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${still.id}/preparing`, vendor.token, {})).statusCode).toBe(409);
  });

  // [DS1106 S4] A rider's own legs read the rider's words, never the goods or the store's instructions.
  it('a rider leg on an order already assigned is refused in the rider\'s words', async () => {
    const r = await rider();
    const o = await placed('READY_FOR_PICKUP', [control, legacy.removed], 'DELIVERY');
    await app.prisma.order.update({ where: { id: o.id }, data: { status: 'RIDER_ASSIGNED', riderId: r.riderId } });
    await expect(orders.updateStatus(o.id, 'RIDER_EN_ROUTE_PICKUP', r.userId, 'Rider heading to the store'))
      .rejects.toMatchObject({ statusCode: 409, code: 'JOB_UNAVAILABLE', message: 'This job isn\'t available — Swift has paused it. Take another job.' });
    expect(await statusOf(o.id)).toBe('RIDER_ASSIGNED');
  });
});

// [GUARDRAILS §8 · owner #54 · Opus S3-8] A store FILED under a banned category (Pharmacy, a liquor category) is
// hidden from every list, search, storefront and Home, and every item it carries counts as banned. Nothing is
// deleted, and the partner cannot file itself out of it — only Swift can (as with an item's banned tag, S3-5).
describe('[§8 · #54] a store filed under a banned category', () => {
  it('is hidden from Home, browse, favourites, its storefront, the website and every search; its items are banned; nothing is deleted', async () => {
    const lat = Number(`6.8${NUM}`);
    const lng = -58.15;
    const owner = await userWithSession(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const b = await app.prisma.vendor.create({ data: {
      ownerId: vendorOwner.id, name: `Prohibited Corner Store ${RUN}`, slug: `prohibited-corner-${RUN}`, vendorType: 'STORE', phone: `+59267${NUM}02`,
      addressLine1: '2 Rule Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: lat, longitude: lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0, averageRating: 5,
    } });
    vendorIds.push(b.id);
    const shelf = await app.prisma.category.create({ data: { vendorId: b.id, name: 'Personal care', sortOrder: 0 } });
    const shampoo = await app.prisma.item.create({ data: { vendorId: b.id, categoryId: shelf.id, name: `Coconut shampoo ${RUN}`, basePrice: 800, totalOrdered: TOP } });
    await app.prisma.customer.update({ where: { userId: customer.id }, data: { favoriteVendors: { connect: [{ id: b.id }, { id: vendor.id }] } } });
    engine.fail = false;
    engine.vendorHits = [vendor, b].map((v) => ({ entityId: v.id, id: `${TENANT}:${v.id}`, name: `x ${RUN}`, vendorType: 'STORE', latitude: lat, longitude: lng, isCurrentlyOpen: true }));

    let homeCall = 0;
    const surfaces: Record<string, () => Promise<string[]>> = {
      home: async () => {
        homeCall += 1; // a fresh cache key per read
        const res = await inject('GET', `/api/v1/customer/home?lat=${lat}&lng=${lng + homeCall / 100_000}`, customer.token);
        expect(res.statusCode).toBe(200);
        const data = res.json().data as { openVendors: Array<{ id: string }>; closedVendors: Array<{ id: string }> };
        return ids([...data.openVendors, ...data.closedVendors]);
      },
      browse: async () => ids((await inject('GET', `/api/v1/customer/vendors?search=${RUN}&limit=50`, customer.token)).json().data),
      favourites: async () => ids((await inject('GET', '/api/v1/customer/favorites', customer.token)).json().data),
      website: async () => ids((await inject('GET', `/api/v1/public/storefronts?q=${RUN}`)).json().data),
      searchIndex: async () => { engine.fail = false; return ids((await inject('GET', `/api/v1/search?q=${RUN}&limit=50`, customer.token)).json().data.vendors); },
      searchDatabase: async () => { engine.fail = true; try { return ids((await inject('GET', `/api/v1/search?q=${RUN}&limit=50`, customer.token)).json().data.vendors); } finally { engine.fail = false; } },
      nearby: async () => ids((await inject('GET', `/api/v1/search/nearby?lat=${lat}&lng=${lng}&radius=2`, customer.token)).json().data),
    };
    const suggestions = async () => ((await inject('GET', `/api/v1/search/suggestions?q=${RUN}`, customer.token)).json().data as Array<{ text: string; type: string }>)
      .filter((sg) => sg.type === 'vendor').map((sg) => sg.text);

    // Positive control: before it is filed under Pharmacy, the store shows on every surface.
    for (const [surface, read] of Object.entries(surfaces)) expect(await read(), `${surface} shows the store`).toContain(b.id);
    expect(await suggestions()).toContain(b.name);
    expect((await inject('GET', `/api/v1/customer/vendors/${b.id}`, customer.token)).statusCode).toBe(200);
    expect((await inject('GET', `/api/v1/customer/vendors/${b.id}/reviews`, customer.token)).statusCode).toBe(200);
    expect((await inject('GET', `/api/v1/public/storefronts/${b.slug}`)).statusCode).toBe(200);

    await app.prisma.vendorDiscoveryCategory.create({ data: { tenantId: TENANT, vendorId: b.id, categoryId: pharmacyCategory.id, role: 'PRIMARY', source: 'ADMIN' } });
    resetHiddenItemIdsCacheForTests();

    for (const [surface, read] of Object.entries(surfaces)) {
      const seen = await read();
      expect(seen, `${surface} hides the store`).not.toContain(b.id);
      if (surface !== 'favourites' && surface !== 'nearby') expect(seen, `${surface} still shows an ordinary store`).toContain(vendor.id);
    }
    expect(await suggestions()).not.toContain(b.name);
    expect((await inject('GET', `/api/v1/customer/vendors/${b.id}`, customer.token)).statusCode).toBe(404);
    expect((await inject('GET', `/api/v1/customer/vendors/${b.id}/reviews`, customer.token)).statusCode).toBe(404);
    expect((await inject('GET', `/api/v1/public/storefronts/${b.slug}`)).statusCode).toBe(404);
    expect((await inject('GET', `/api/v1/customer/vendors/${vendor.id}`, customer.token)).statusCode).toBe(200);

    // Its items are banned, whatever their words — and say why to the partner.
    expect((await catalogueChecksFor(app.prisma, [shampoo.id])).get(shampoo.id)).toMatchObject({
      state: 'BANNED', source: 'store', prohibitedClass: 'MEDICINE',
      reason: 'Your store is filed under Pharmacy & Health, which Swift doesn\'t allow. Ask Swift support to change your store\'s category.',
    });
    const cart = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: b.id, itemId: shampoo.id, quantity: 1 });
    expect(cart.json().error).toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { reason: 'PROHIBITED' } });
    const own = await inject('GET', '/api/v1/vendor/items', owner.token);
    expect((own.json().data as Array<{ id: string; catalogueCheck: { status: string; reason: string } }>).find((i) => i.id === shampoo.id)?.catalogueCheck)
      .toMatchObject({ status: 'NOT_ALLOWED', reason: expect.stringContaining('Your store is filed under Pharmacy & Health') });
    const create = await inject('POST', '/api/v1/vendor/items', owner.token, { categoryId: shelf.id, basePrice: 500, name: `Bar soap ${RUN}` });
    expect(create.statusCode).toBe(409);
    expect(create.json().error.message).toBe('Your store is filed under Pharmacy & Health, which Swift doesn\'t allow. Ask Swift support to change your store\'s category.');
    // The partner cannot file itself out of the banned category; only Swift can.
    const refile = await inject('PUT', '/api/v1/vendor/store-categories', owner.token, { primarySlug: snacksCategory.slug, secondarySlugs: [] });
    expect(refile.statusCode).toBe(409);
    expect(await app.prisma.vendorDiscoveryCategory.count({ where: { vendorId: b.id, categoryId: pharmacyCategory.id } })).toBe(1);
    // Nothing deleted.
    expect(await app.prisma.vendor.count({ where: { id: b.id } })).toBe(1);
    expect(await app.prisma.item.count({ where: { id: shampoo.id } })).toBe(1);
  });

  it('Home cards show no section named for banned goods', async () => {
    const res = await inject('GET', `/api/v1/customer/home?lat=6.801&lng=-58.156`, customer.token);
    const card = (res.json().data.openVendors as Array<{ id: string; categories: Array<{ name: string }> }>).find((v) => v.id === vendor.id);
    expect(card, 'the ordinary store is on Home').toBeTruthy();
    const names = card!.categories.map((c) => c.name);
    expect(names).toContain('Shelf');
    expect(names).not.toContain('Beers & Wines');
  });

  // [Opus S3-5] An item's banned category tag is a certain ban; a partner removing it would lift the ban.
  it('a partner cannot untag an item from a banned category; an ordinary tag can be removed', async () => {
    const untag = await inject('DELETE', `/api/v1/vendor/items/${legacy.relief.id}/categories/pharmacy`, vendor.token);
    expect(untag.statusCode).toBe(409);
    expect(untag.json().error).toMatchObject({ code: 'PROHIBITED_ITEM', message: 'This item is filed under Pharmacy & Health, which Swift doesn\'t allow. Ask Swift support to check it.' });
    expect(await app.prisma.itemDiscoveryCategory.count({ where: { itemId: legacy.relief.id, categoryId: pharmacyCategory.id } })).toBe(1);
    expect((await catalogueChecksFor(app.prisma, [legacy.relief.id])).get(legacy.relief.id)).toMatchObject({ state: 'BANNED', source: 'category' });
    expect((await inject('DELETE', `/api/v1/vendor/items/${control.id}/categories/${snacksCategory.slug}`, vendor.token)).statusCode).toBe(200);
  });
});

// [Opus S3-11] The minute-old exclusion list is served at once; the rebuild runs behind the request, never in it.
describe('[§8] the browse exclusion lists are rebuilt behind the request', () => {
  it('a stale list is served at once while one read refreshes it; the next read has the new item', async () => {
    resetHiddenItemIdsCacheForTests();
    const t0 = Date.now();
    const first = await runWithTenant(TENANT, () => hiddenItemIds(app.prisma, TENANT, t0));
    const added = await item({ name: `Rum fudge bites ${RUN}` });
    const stale = await runWithTenant(TENANT, () => hiddenItemIds(app.prisma, TENANT, t0 + HIDDEN_IDS_CACHE_MS + 1));
    expect(stale).toEqual(first); // served without waiting for a rebuild — a rebuild would carry the new item
    expect(stale).not.toContain(added.id);
    await settleProhibitedCachesForTests();
    expect(await runWithTenant(TENANT, () => hiddenItemIds(app.prisma, TENANT))).toContain(added.id);
  });
});

// ── Follow-ups, 14 Oct 2026 (after #1678) ─────────────────────────────────────

// [owner 14 Oct] Store names about banned goods ("X Liquor Store", "Rum Shop", a pharmacy name) are HELD for a person
// automatically — not left to vendor approval. Held = hidden from every list, search and storefront with every item it
// sells, until someone holding the catalogue-approver grant approves exactly those words. Never a ban by words.
describe('[§8 · store names] a store whose own words mention banned goods is held for a person', () => {
  const storeAt = async (name: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => {
    const owner = await userWithSession(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    seq += 1;
    const v = await app.prisma.vendor.create({ data: {
      ownerId: vendorOwner.id, name, slug: `prohibited-held-${RUN}-${seq}`, vendorType: 'STORE', phone: `+59267${NUM}${String(seq).padStart(2, '0')}`,
      addressLine1: '3 Rule Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: lat, longitude: lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0, averageRating: 5, ...extra,
    } });
    vendorIds.push(v.id);
    const shelf = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Bakery', sortOrder: 0 } });
    const bread = await app.prisma.item.create({ data: { vendorId: v.id, categoryId: shelf.id, name: `Coconut bread ${RUN} ${seq}`, basePrice: 800, totalOrdered: TOP } });
    return { id: v.id, slug: v.slug, name: v.name, token: owner.token, shelfId: shelf.id, breadId: bread.id };
  };
  const surfacesFor = (store: { id: string; name: string }, lat: number, lng: number) => {
    let homeCall = 0;
    const read: Record<string, () => Promise<string[]>> = {
      home: async () => {
        homeCall += 1;
        const res = await inject('GET', `/api/v1/customer/home?lat=${lat}&lng=${lng + homeCall / 100_000}`, customer.token);
        expect(res.statusCode).toBe(200);
        const data = res.json().data as { openVendors: Array<{ id: string }>; closedVendors: Array<{ id: string }> };
        return ids([...data.openVendors, ...data.closedVendors]);
      },
      browse: async () => ids((await inject('GET', `/api/v1/customer/vendors?search=${RUN}&limit=50`, customer.token)).json().data),
      favourites: async () => ids((await inject('GET', '/api/v1/customer/favorites', customer.token)).json().data),
      website: async () => ids((await inject('GET', `/api/v1/public/storefronts?q=${RUN}`)).json().data),
      searchIndex: async () => { engine.fail = false; return ids((await inject('GET', `/api/v1/search?q=${RUN}&limit=50`, customer.token)).json().data.vendors); },
      searchDatabase: async () => { engine.fail = true; try { return ids((await inject('GET', `/api/v1/search?q=${RUN}&limit=50`, customer.token)).json().data.vendors); } finally { engine.fail = false; } },
      nearby: async () => ids((await inject('GET', `/api/v1/search/nearby?lat=${lat}&lng=${lng}&radius=2`, customer.token)).json().data),
      suggestions: async () => ((await inject('GET', `/api/v1/search/suggestions?q=${RUN}`, customer.token)).json().data as Array<{ text: string; type: string }>)
        .filter((sg) => sg.type === 'vendor' && sg.text === store.name).map(() => store.id),
    };
    return read;
  };
  const pages = async (store: { id: string; slug: string }) => [
    (await inject('GET', `/api/v1/customer/vendors/${store.id}`, customer.token)).statusCode,
    (await inject('GET', `/api/v1/customer/vendors/${store.id}/reviews`, customer.token)).statusCode,
    (await inject('GET', `/api/v1/public/storefronts/${store.slug}`)).statusCode,
  ];
  const queueStores = async () => {
    const res = await inject('GET', '/api/v1/admin/catalogue-review', admin.token);
    expect(res.statusCode).toBe(200);
    return res.json().data.stores as Array<{ vendorId: string; name: string; field: string; term: string; prohibitedClass: string; state: string; wordsHash: string }>;
  };
  const approveStore = (token: string, vendorId: string, wordsHash: string, reason: string | null = REASON) =>
    inject('POST', `/api/v1/admin/catalogue-review/stores/${vendorId}/approve`, token, { wordsHash }, reason ? { 'x-swift-reason': reason } : {});
  const approvedHashOf = async (vendorId: string) => (await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { nameReviewApprovedHash: true } })).nameReviewApprovedHash;

  it('an existing store named for banned goods is hidden with its items everywhere until a person with the grant approves its exact words; a rename brings the check back', async () => {
    const lat = Number(`6.82${NUM}`);
    const lng = -58.14;
    const held = await storeAt(`Rum Shop ${RUN}`, lat, lng);
    await app.prisma.customer.update({ where: { userId: customer.id }, data: { favoriteVendors: { connect: [{ id: held.id }] } } });
    engine.fail = false;
    engine.vendorHits = [vendor, held].map((v) => ({ entityId: v.id, id: `${TENANT}:${v.id}`, name: `x ${RUN}`, vendorType: 'STORE', latitude: lat, longitude: lng, isCurrentlyOpen: true }));
    resetHiddenItemIdsCacheForTests();
    const surfaces = surfacesFor(held, lat, lng);

    // Held: no list, search or page shows it; an ordinary store still shows.
    for (const [surface, read] of Object.entries(surfaces)) {
      const seen = await read();
      expect(seen, `${surface} hides the held store`).not.toContain(held.id);
      if (!['favourites', 'nearby', 'suggestions'].includes(surface)) expect(seen, `${surface} still shows an ordinary store`).toContain(vendor.id);
    }
    expect(await pages(held)).toEqual([404, 404, 404]);
    expect((await inject('GET', `/api/v1/customer/vendors/${vendor.id}`, customer.token)).statusCode).toBe(200);
    // …and so is every item it sells, whatever the item's words.
    expect((await catalogueChecksFor(app.prisma, [held.breadId])).get(held.breadId)).toEqual({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'store', term: 'rum' });
    const cart = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: held.id, itemId: held.breadId, quantity: 1 });
    expect(cart.json().error).toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { reason: 'PROHIBITED' } });
    // The partner reads why, and can still work: a hold, not a ban.
    const own = (await inject('GET', '/api/v1/vendor/items', held.token)).json().data as Array<{ id: string; catalogueCheck: { status: string; message: string } | null }>;
    expect(own.find((i) => i.id === held.breadId)?.catalogueCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', message: STORE_WAITING_FOR_CHECK });
    const profile = (await inject('GET', '/api/v1/vendor/profile', held.token)).json().data.vendors as Array<{ id: string; storeCheck: unknown; nameReviewApprovedHash?: unknown }>;
    expect(profile.find((v) => v.id === held.id)?.storeCheck).toEqual({ status: 'WAITING_FOR_CHECK', message: STORE_WAITING_MESSAGE, prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });
    expect(profile.find((v) => v.id === held.id)?.nameReviewApprovedHash).toBeUndefined();
    expect((await inject('POST', '/api/v1/vendor/items', held.token, { categoryId: held.shelfId, basePrice: 500, name: `Cassava pone ${RUN}` })).statusCode).toBe(200);

    // The catalogue check lists the store (not its items one by one); an item of it cannot be approved alone.
    const listed = (await queueStores()).find((q) => q.vendorId === held.id)!;
    expect(listed).toMatchObject({ name: held.name, state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });
    expect((await queue()).map((q) => q.itemId)).not.toContain(held.breadId);
    const alone = await approve(held.breadId, '0'.repeat(64));
    expect(alone.statusCode).toBe(409);
    expect(alone.json().error).toMatchObject({ code: 'STORE_WAITING', message: 'This item\'s store is waiting for a check. Check the store first.' });

    // A changed word is refused; the words seen are approved, with the record in the same step.
    expect((await approveStore(admin.token, held.id, '0'.repeat(64))).json().error.code).toBe('STORE_CHANGED');
    expect(await approvedHashOf(held.id)).toBeNull();
    expect((await approveStore(admin.token, held.id, listed.wordsHash)).statusCode).toBe(200);
    const records = await system(() => app.prisma.auditLog.findMany({ where: { entityId: held.id, userId: admin.id } }));
    expect(records.filter((r) => (r.changes as { approvedWordsHash?: string } | null)?.approvedWordsHash === listed.wordsHash)).toHaveLength(1);

    // Approved: shown everywhere again (the positive control for every surface above), its items judged by their own words.
    resetHiddenItemIdsCacheForTests();
    for (const [surface, read] of Object.entries(surfaces)) expect(await read(), `${surface} shows the approved store`).toContain(held.id);
    expect(await pages(held)).toEqual([200, 200, 200]);
    expect((await catalogueChecksFor(app.prisma, [held.breadId])).get(held.breadId)).toEqual({ state: 'CLEAR' });
    expect((await queueStores()).map((q) => q.vendorId)).not.toContain(held.id);

    // A rename by the partner is judged at once: held again, the old approval no longer matches.
    const renamed = await inject('PUT', '/api/v1/vendor/profile', held.token, { name: `Gin Corner ${RUN}` });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.storeCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', term: 'gin' });
    expect(await pages(held)).toEqual([404, 404, 404]);
    expect((await queueStores()).find((q) => q.vendorId === held.id)?.wordsHash).not.toBe(listed.wordsHash);
    // Renamed out of the word: nothing left to check.
    const out = await inject('PUT', '/api/v1/vendor/profile', held.token, { name: `Coconut Corner ${RUN}` });
    expect(out.json().data.storeCheck).toBeNull();
    expect(await pages(held)).toEqual([200, 200, 200]);
  });

  // [Opus S3-9, coordinator 14 Oct] Showing a held store is the same criminal-liability decision as showing a held item:
  // the explicit catalogue-approver grant (never `*`, a wildcard or a role default), a stated reason, the record in
  // the same transaction. Holding or suspending a store — the strict direction — stays open to moderators.
  it('approving a store needs the catalogue-approver grant and a reason; a moderator without it can still suspend the store', async () => {
    const held = await storeAt(`Bourda Pharmacy ${RUN}`, Number(`6.83${NUM}`), -58.13);
    const row = (await queueStores()).find((q) => q.vendorId === held.id)!;
    expect(row).toMatchObject({ prohibitedClass: 'MEDICINE', term: 'pharmacy' });

    const superStar = await userWithSession(['SUPER_ADMIN'], 'SUPER_ADMIN'); // the role default, `*`
    const starRow = await userWithSession(['ADMIN'], 'ADMIN');
    await app.prisma.admin.create({ data: { userId: starRow.id, permissions: ['*'] } });
    const moderator = await userWithSession(['ADMIN'], 'ADMIN');
    await app.prisma.admin.create({ data: { userId: moderator.id, permissions: ['moderation.read', 'moderation.decide', 'vendor.suspend'] } });
    for (const who of [superStar, starRow, moderator]) {
      const refused = await approveStore(who.token, held.id, row.wordsHash);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('CATALOGUE_APPROVER_REQUIRED');
    }
    expect(await approvedHashOf(held.id)).toBeNull();
    // With the grant, a reason is still owed.
    expect((await approveStore(admin.token, held.id, row.wordsHash, null)).statusCode).toBe(400);
    expect(await approvedHashOf(held.id)).toBeNull();
    expect(await pages(held)).toEqual([404, 404, 404]);

    // The strict direction needs no grant: the moderator suspends the store.
    const suspended = await inject('PUT', `/api/v1/admin/vendors/${held.id}/suspend`, moderator.token, { reason: 'Sells medicines' }, { 'x-swift-reason': 'Sells medicines' });
    expect(suspended.statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: held.id }, select: { status: true } })).status).toBe('SUSPENDED');

    // A store filed under a banned category is a ban: approving its words never lifts it.
    const filed = await storeAt(`Wine Cellar ${RUN}`, Number(`6.84${NUM}`), -58.12);
    await app.prisma.vendorDiscoveryCategory.create({ data: { tenantId: TENANT, vendorId: filed.id, categoryId: pharmacyCategory.id, role: 'PRIMARY', source: 'ADMIN' } });
    const filedRow = (await queueStores()).find((q) => q.vendorId === filed.id)!;
    const ban = await approveStore(admin.token, filed.id, filedRow.wordsHash);
    expect(ban.statusCode).toBe(409);
    expect(ban.json().error.message).toBe('Approval never lifts a ban. Swift doesn\'t allow this category: medicines.');
    expect(await approvedHashOf(filed.id)).toBeNull();
  });

  it('a store opened through the real sign-up is judged from the start; a personal name is held, never banned', async () => {
    const opened: Array<{ id: string; token: string }> = [];
    for (const name of [`Ron's Liquor Store ${RUN}`, `Ron's Variety ${RUN}`]) {
      const owner = await userWithSession(['CUSTOMER'], 'CUSTOMER');
      const res = await inject('POST', '/api/v1/partner/become', owner.token, { acceptAgreement: true, role: 'VENDOR', business: {
        name, vendorType: 'STORE', phone: `+59267${NUM}9${opened.length}`, addressLine1: '4 Rule Street', city: 'Georgetown', latitude: 6.8013, longitude: -58.1551,
      } });
      expect(res.statusCode, res.body).toBe(201);
      const v = await app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: owner.id } }, select: { id: true, slug: true } });
      vendorIds.push(v.id);
      // Approved as a business the way the console does (documents checked): its NAME is still held.
      await app.prisma.vendor.update({ where: { id: v.id }, data: { status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true } });
      expect(await pages(v)).toEqual([404, 404, 404]);
      opened.push({ id: v.id, token: owner.token });
    }
    const [liquor, variety] = opened as [{ id: string; token: string }, { id: string; token: string }];
    const terms = Object.fromEntries((await queueStores()).filter((q) => opened.some((o) => o.id === q.vendorId)).map((q) => [q.vendorId, q.term]));
    expect(terms).toEqual({ [liquor.id]: 'liquor', [variety.id]: 'ron' });
    // A hold, not a ban: the owner of "Ron's Variety" adds and edits items; each waits with the store, none is banned.
    const shelf = await app.prisma.category.create({ data: { vendorId: variety.id, name: 'Shelf', sortOrder: 0 } });
    const created = await inject('POST', '/api/v1/vendor/items', variety.token, { categoryId: shelf.id, basePrice: 500, name: `Plantain chips ${RUN}` });
    expect(created.statusCode).toBe(200);
    const itemId = created.json().data.id as string;
    expect((await inject('PUT', `/api/v1/vendor/items/${itemId}`, variety.token, { basePrice: 600 })).statusCode).toBe(200);
    expect((await catalogueChecksFor(app.prisma, [itemId])).get(itemId)).toMatchObject({ state: 'WAITING', field: 'store', term: 'ron' });
  });
});

// [DS1265 S4 · joined spellings] The database pre-filter reads words written together apart, exactly where the
// classifier does, so such an item reaches the catalogue check (or the browse exclusion list) instead of waiting unseen.
describe('[§8 · DS1265 S4] joined spellings reach the catalogue check', () => {
  it('"Camel20s" and "RumCake" are queued; "Rum750ml" is on the exclusion list', async () => {
    const camel = await item({ name: `Camel20s gift ${RUN}` });
    const cake = await item({ name: `RumCake slice ${RUN}` });
    const bottle = await item({ name: `${RUN} Rum750ml` });
    const queued = await queue();
    expect(queued.find((r) => r.itemId === camel.id), 'Camel20s').toMatchObject({ state: 'WAITING', term: 'camel' });
    expect(queued.find((r) => r.itemId === cake.id), 'RumCake').toMatchObject({ state: 'WAITING', term: 'rum' });
    expect((await catalogueChecksFor(app.prisma, [bottle.id])).get(bottle.id)).toMatchObject({ state: 'BANNED', source: 'word' });
    resetHiddenItemIdsCacheForTests();
    expect(await runWithTenant(TENANT, () => hiddenItemIds(app.prisma, TENANT))).toEqual(expect.arrayContaining([camel.id, cake.id, bottle.id]));
    await visibleOn(storefrontItemIds, [control.id], [camel.id, cake.id, bottle.id]);
  });
});

// [DS1267 S4] The restock un-hide judges and writes as one step, under the item's row lock: an edit that bans the item
// while the un-hide runs is waited for, and the item stays off.
describe('[§8 · DS1267 S4] stock coming back is judged under the item\'s lock', () => {
  it('a ban committed while the un-hide runs is seen; the item stays off', async () => {
    const created = await item({ name: `Coconut drops ${RUN}` });
    await app.prisma.item.update({ where: { id: created.id }, data: { isAvailable: false, autoHiddenAt: new Date(), stockQuantity: 4, totalOrdered: 0 } });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let renamed!: () => void;
    const isRenamed = new Promise<void>((resolve) => { renamed = resolve; });
    // An edit that makes the item banned goods, holding the row until it commits.
    const edit = app.prisma.$transaction(async (tx) => {
      await tx.item.update({ where: { id: created.id }, data: { name: `${RUN} Spare Rum` } });
      renamed();
      await released;
    }, { timeout: 15_000 });
    await isRenamed;
    const unhide = unhideRestocked(app.prisma, created.id);
    await new Promise((resolve) => setTimeout(resolve, 750)); // the un-hide is now waiting on the row (or, unlocked, has judged the old name)
    release();
    await edit;
    await unhide;
    expect(await app.prisma.item.findUniqueOrThrow({ where: { id: created.id }, select: { isAvailable: true, autoHiddenAt: true } }))
      .toMatchObject({ isAvailable: false });
    expect((await catalogueChecksFor(app.prisma, [created.id])).get(created.id)).toMatchObject({ state: 'BANNED' });
  });

  it('the stock adjust route moves the stock and un-hides it in one transaction', () => {
    const source = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'vendor.routes.ts'), 'utf8');
    const route = source.slice(source.indexOf("app.post<{ Params: IdParam }>('/items/:id/adjust'"));
    const body = route.slice(0, route.indexOf('\n  });\n'));
    expect(body).toMatch(/\$transaction\(async \(tx\) => \{[\s\S]*applyStockMovement\(tx,[\s\S]*unhideRestocked\(tx, item\.id\);[\s\S]*\}\)\.catch/);
    expect(body).not.toMatch(/unhideRestocked\(app\.prisma/);
  });
});
