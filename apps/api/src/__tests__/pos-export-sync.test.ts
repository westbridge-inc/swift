import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { TENANT_TABLES, TENANT_LINEAGE_TABLES } from '../lib/tenant-rls';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { reconcileItemStock, applyStockMovement, applyStockMovements } from '../modules/inventory/stock';
import { OrderService } from '../modules/order/order.service';
import ExcelJS from 'exceljs';
import type { Server } from 'socket.io';
import { rateLimitKey } from '../utils/rate-limit-key';

// ---------------------------------------------------------------------------
// [POS-SYNC] Re-uploading a till export updates the store.
//
// The import used to CREATE every row it was given, so the second upload of
// the same till export doubled the catalogue. The sync matches rows to items by
// SKU (trimmed, case-insensitive, inside the one store), shows a preview that
// writes nothing, and applies on confirm: stock through the ledger as POS_IMPORT
// movements, prices listed, sold-out by the existing rules with the owner's own
// switch winning, one audit row, and the same file never applied twice.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const PHONE_BASE = 592_007_100_000 + Math.floor(Math.random() * 800_000);
const FOREIGN_TENANT = `pos-sync-foreign-${RUN}`;

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;

const HEADER = 'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl';
const row = (sku: string, name: string, price: string, stock: string, category = 'Groceries') =>
  [category, name, '', price, sku, '', stock, '', '', ''].join(',');
const csvOf = (...rows: string[]) => [HEADER, ...rows].join('\n');

async function makeUser(roles: UserRole[], activeRole: UserRole, tenantId?: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${PHONE_BASE + seq}`,
      firstName: 'Till', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(tenantId ? { tenantId } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pos-sync-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeStore(opts: { verified?: boolean; tenantId?: string } = {}) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', opts.tenantId);
  seq += 1;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Till Store ${seq}`, slug: `till-store-${RUN}-${seq}`, vendorType: 'STORE',
      phone: `+5920071${String(seq).padStart(3, '0')}`, addressLine1: '1 Regent Street', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
      acceptingOrders: true, isCurrentlyOpen: true, isVerified: opts.verified ?? true,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
  });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Groceries', sortOrder: 0 } });
  return { owner, vendorId: vendor.id, categoryId: category.id };
}

type Store = Awaited<ReturnType<typeof makeStore>>;

/** An item born the way the item editor makes one: the opening balance is in the ledger. */
async function makeItem(store: Store, sku: string | null, stock: number | null, price: number, extra: { isAvailable?: boolean; name?: string } = {}) {
  const item = await app.prisma.item.create({
    data: {
      vendorId: store.vendorId, categoryId: store.categoryId, name: extra.name ?? `Item ${sku ?? nanoid(4)}`,
      basePrice: price, sku, isAvailable: extra.isAvailable ?? true,
    },
  });
  if (stock !== null) {
    const { recordOpeningBalance } = await import('../modules/inventory/stock');
    await app.prisma.$transaction((tx) => recordOpeningBalance(tx, item.id, stock, store.owner.userId));
  }
  return item;
}

function post(url: string, token: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url: `/api/v1/vendor${url}`, payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
  });
}

async function preview(store: Store, csv: string, missing?: 'LEAVE' | 'SOLD_OUT', token = store.owner.token) {
  const res = await post('/items/import/sync/preview', token, { csv, ...(missing ? { missing } : {}) });
  return res;
}

async function previewOk(store: Store, csv: string, missing?: 'LEAVE' | 'SOLD_OUT') {
  const res = await preview(store, csv, missing);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as PreviewData;
}

async function confirm(store: Store, csv: string, p: PreviewData, token = store.owner.token) {
  return post('/items/import/sync/confirm', token, {
    csv, uploadId: p.uploadId, contentHash: p.contentHash, planDigest: p.planDigest, missing: p.missingPolicy,
  });
}

async function syncOk(store: Store, csv: string, missing?: 'LEAVE' | 'SOLD_OUT') {
  const p = await previewOk(store, csv, missing);
  const res = await confirm(store, csv, p);
  expect(res.statusCode, res.body).toBe(200);
  return { preview: p, result: res.json().data as ConfirmData };
}

interface PreviewChange {
  row: number; sku: string; itemId: string; name: string; fileName: string;
  stock: { from: number | null; to: number | null } | null;
  price: { from: number; to: number } | null;
  soldOut: 'BECOMES_SOLD_OUT' | 'BACK_ON_SALE' | 'STAYS_SWITCHED_OFF' | null;
  notes: string[];
}
interface PreviewData {
  storeId: string; uploadId: string; contentHash: string; planDigest: string;
  missingPolicy: 'LEAVE' | 'SOLD_OUT';
  alreadyApplied: { uploadId: string; appliedAt: string } | null;
  changes: PreviewChange[];
  unchanged: number;
  newItems: Array<{ row: number; sku: string; name: string; price: number; stock: number | null }>;
  needsAttention: Array<{ row: number; sku: string; name: string; reason: string }>;
  missing: Array<{ itemId: string; sku: string; name: string; action: 'LEAVE' | 'SWITCH_OFF' | 'ALREADY_OFF' }>;
  notOnSku: number;
  totals: Record<string, number>;
}
interface ConfirmData extends PreviewData { replayed: boolean; appliedAt: string }

const itemOf = (id: string) => app.prisma.item.findUniqueOrThrow({ where: { id } });
const movementsOf = (itemId: string) => app.prisma.stockMovement.findMany({ where: { itemId }, orderBy: { occurredAt: 'asc' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382/15';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // The global limiter, as the app registers it: route configs tighten it.
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute', keyGenerator: rateLimitKey((token) => app.jwt.verify(token)) });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    const placed = await app.prisma.order.findMany({ where: { customerId: { in: createdUserIds } }, select: { id: true } }).catch(() => []);
    createdOrderIds.push(...placed.map((o) => o.id));
    if (createdOrderIds.length) {
      await app.prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
      await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
    }
    if (createdUserIds.length) {
      await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } }).catch(() => undefined);
      await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
      await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    }
    await app.prisma.tenant.deleteMany({ where: { id: FOREIGN_TENANT } }).catch(() => undefined);
  }, 'test-fixture:pos-export-sync');
  await app.close();
});

describe('re-uploading a till export updates matching items and never duplicates them', () => {
  it('matches by SKU (trimmed, any case), updates stock and price, adds only the new SKU', async () => {
    const store = await makeStore();
    const rice = await makeItem(store, 'RICE-5KG', 40, 3500, { name: 'Basmati Rice 5kg' });
    const oil = await makeItem(store, 'oil-1l', 10, 1800, { name: 'Cooking Oil 1L' });

    const monday = csvOf(
      row('  rice-5kg ', 'Rice 5kg', '3600', '35'),
      row('OIL-1L', 'Oil 1L', '1800', '10'),
      row('SUGAR-2KG', 'Brown Sugar 2kg', '900', '12'),
    );
    const { result } = await syncOk(store, monday);
    expect(result.totals['newItems']).toBe(1);

    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId } })).toBe(3);
    const riceAfter = await itemOf(rice.id);
    expect(riceAfter.stockQuantity).toBe(35);
    expect(Number(riceAfter.basePrice)).toBe(3600);
    expect(riceAfter.name).toBe('Basmati Rice 5kg'); // the store's own wording is kept
    const oilAfter = await itemOf(oil.id);
    expect(oilAfter.stockQuantity).toBe(10);
    expect(Number(oilAfter.basePrice)).toBe(1800);

    // Tuesday's export: same SKUs, new counts. Still three items.
    const tuesday = csvOf(
      row('RICE-5KG', 'Rice 5kg', '3600', '30'),
      row('OIL-1L', 'Oil 1L', '1850', '8'),
      row('SUGAR-2KG', 'Brown Sugar 2kg', '900', '11'),
    );
    await syncOk(store, tuesday);
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId } })).toBe(3);
    expect((await itemOf(rice.id)).stockQuantity).toBe(30);
    expect(Number((await itemOf(oil.id)).basePrice)).toBe(1850);
    const sugar = await app.prisma.item.findFirstOrThrow({ where: { vendorId: store.vendorId, sku: 'SUGAR-2KG' } });
    expect(sugar.stockQuantity).toBe(11);
    // Born with an opening balance, then moved by the ledger: the ledger explains the count.
    expect(await reconcileItemStock(app.prisma, sugar.id)).toMatchObject({ tracked: true, counter: 11, ledger: 11, drift: 0 });
  });

  it('the old add-only import no longer duplicates an item whose SKU is already in the store', async () => {
    const store = await makeStore();
    const file = csvOf(row('BEANS-1', 'Red Beans', '700', '9'), row('', 'No Sku Snack', '300', ''));
    const first = await post('/items/import', store.owner.token, { csv: file });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.imported).toBe(2);

    const again = await post('/items/import', store.owner.token, { csv: csvOf(row('beans-1 ', 'Red Beans', '700', '9')) });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.imported).toBe(0);
    expect(again.json().data.failures[0].errors.join(' ')).toMatch(/already/i);
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId, sku: { equals: 'BEANS-1', mode: 'insensitive' } } })).toBe(1);
  });

  it('the old add-only import never turns a blank price into a free item, and its stock is explained by the ledger', async () => {
    const store = await makeStore();
    const res = await post('/items/import', store.owner.token, {
      csv: csvOf(row('BLANK-PRICE', 'Mystery Box', '', '3'), row('GOOD-1', 'Soap', '250', '6')),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.imported).toBe(1);
    expect(res.json().data.failures.map((f: { row: number }) => f.row)).toEqual([2]);
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId, sku: 'BLANK-PRICE' } })).toBe(0);

    const soap = await app.prisma.item.findFirstOrThrow({ where: { vendorId: store.vendorId, sku: 'GOOD-1' } });
    expect(soap.stockQuantity).toBe(6);
    const drift = await reconcileItemStock(app.prisma, soap.id);
    expect(drift).toMatchObject({ tracked: true, counter: 6, ledger: 6, drift: 0 });
  });
});

describe('the preview', () => {
  it('writes nothing, and shows old → new for stock and price, sold-out, new items, problems and missing items', async () => {
    const store = await makeStore();
    const a = await makeItem(store, 'A-1', 5, 1000, { name: 'Alpha' });
    const b = await makeItem(store, 'B-1', 3, 2000, { name: 'Bravo' });
    const c = await makeItem(store, 'C-1', 0, 500, { name: 'Charlie', isAvailable: false });
    await app.prisma.item.update({ where: { id: c.id }, data: { autoHiddenAt: new Date() } }); // hidden by the engine at zero
    const d = await makeItem(store, 'D-1', 7, 700, { name: 'Delta (not in file)' });
    await makeItem(store, null, null, 100, { name: 'No SKU on Swift' });

    const file = csvOf(
      row('A-1', 'Alpha', '1100', '4'), // stock + price
      row('B-1', 'Bravo', '2000', '0'), // becomes sold out
      row('C-1', 'Charlie', '500', '6'), // back on sale
      row('E-1', 'Echo', '450', '2'), // new
      row('', 'Nameless', '100', '1'), // no SKU
    );

    const before = {
      items: await app.prisma.item.findMany({ where: { vendorId: store.vendorId }, orderBy: { id: 'asc' } }),
      movements: await app.prisma.stockMovement.count({ where: { itemId: { in: [a.id, b.id, c.id, d.id] } } }),
      audits: await app.prisma.auditLog.count({ where: { entityId: store.vendorId } }),
    };

    const p = await previewOk(store, file, 'SOLD_OUT');

    const after = {
      items: await app.prisma.item.findMany({ where: { vendorId: store.vendorId }, orderBy: { id: 'asc' } }),
      movements: await app.prisma.stockMovement.count({ where: { itemId: { in: [a.id, b.id, c.id, d.id] } } }),
      audits: await app.prisma.auditLog.count({ where: { entityId: store.vendorId } }),
    };
    expect(after).toEqual(before);
    expect(await app.prisma.posImport.count({ where: { vendorId: store.vendorId } })).toBe(0);

    const byId = new Map(p.changes.map((ch) => [ch.itemId, ch]));
    expect(byId.get(a.id)).toMatchObject({ stock: { from: 5, to: 4 }, price: { from: 1000, to: 1100 }, soldOut: null });
    expect(byId.get(b.id)).toMatchObject({ stock: { from: 3, to: 0 }, price: null, soldOut: 'BECOMES_SOLD_OUT' });
    expect(byId.get(c.id)).toMatchObject({ stock: { from: 0, to: 6 }, soldOut: 'BACK_ON_SALE' });
    expect(p.newItems).toEqual([expect.objectContaining({ sku: 'E-1', name: 'Echo', price: 450, stock: 2 })]);
    expect(p.needsAttention).toEqual([expect.objectContaining({ row: 6, reason: expect.stringMatching(/SKU/) })]);
    expect(p.missing).toEqual([expect.objectContaining({ itemId: d.id, action: 'SWITCH_OFF' })]);
    expect(p.notOnSku).toBe(1);
    expect(p.totals).toMatchObject({ rows: 5, matched: 3, stockChanges: 3, priceChanges: 1, becomeSoldOut: 1, backOnSale: 1, newItems: 1, needsAttention: 1, missing: 1 });
    expect(p.alreadyApplied).toBeNull();
    expect(p.uploadId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never guesses a value: zero or unreadable prices and fractional or negative stock need attention; a blank cell changes nothing', async () => {
    const store = await makeStore();
    const items = await Promise.all(['P2', 'P3', 'S1', 'S2', 'P1', 'OK1', 'OK2'].map((sku) => makeItem(store, sku, 10, 1000)));
    const file = csvOf(
      row('P1', 'x', '', ''),
      row('P2', 'x', '0', '10'),
      row('P3', 'x', 'about 900', '10'),
      row('S1', 'x', '1000', '2.5'),
      row('S2', 'x', '1000', '-3'),
      row('OK1', 'x', '"GYD 1,500.00"', '"1,200"'),
      row('OK2', 'x', '$1250', '12.000'),
    );
    const p = await previewOk(store, file);
    expect(p.needsAttention.map((n) => n.sku).sort()).toEqual(['P2', 'P3', 'S1', 'S2']);
    expect(p.changes.find((ch) => ch.sku === 'P1')).toBeUndefined(); // blank = no information = no change
    expect(p.unchanged).toBe(1);
    const ok1 = p.changes.find((ch) => ch.sku === 'OK1')!;
    expect(ok1).toMatchObject({ price: { from: 1000, to: 1500 }, stock: { from: 10, to: 1200 } });
    const ok2 = p.changes.find((ch) => ch.sku === 'OK2')!;
    expect(ok2).toMatchObject({ price: { from: 1000, to: 1250 }, stock: { from: 10, to: 12 } });

    await confirm(store, file, p).then((res) => expect(res.statusCode, res.body).toBe(200));
    for (const item of items.slice(0, 5)) {
      const fresh = await itemOf(item.id);
      expect(fresh.stockQuantity).toBe(10);
      expect(Number(fresh.basePrice)).toBe(1000);
    }
  });
});

describe('confirm', () => {
  it('writes one POS_IMPORT ledger movement per stock change, with the right delta and the upload id', async () => {
    const store = await makeStore();
    const a = await makeItem(store, 'L-A', 20, 100);
    const b = await makeItem(store, 'L-B', 4, 100);
    const c = await makeItem(store, 'L-C', 9, 100); // unchanged

    const { preview: p, result } = await syncOk(store, csvOf(row('L-A', 'a', '100', '17'), row('L-B', 'b', '100', '10'), row('L-C', 'c', '120', '9')));
    expect(result.replayed).toBe(false);

    const ma = (await movementsOf(a.id)).filter((m) => m.reason !== 'OPENING_BALANCE');
    const mb = (await movementsOf(b.id)).filter((m) => m.reason !== 'OPENING_BALANCE');
    const mc = (await movementsOf(c.id)).filter((m) => m.reason !== 'OPENING_BALANCE');
    expect(ma).toHaveLength(1);
    expect(ma[0]).toMatchObject({ delta: -3, balanceAfter: 17, reason: 'POS_IMPORT', actorId: store.owner.userId });
    expect(ma[0]!.note).toContain(p.uploadId);
    expect(mb).toHaveLength(1);
    expect(mb[0]).toMatchObject({ delta: 6, balanceAfter: 10, reason: 'POS_IMPORT' });
    expect(mc).toHaveLength(0); // a price change is not a stock movement
    for (const id of [a.id, b.id, c.id]) {
      expect((await reconcileItemStock(app.prisma, id)).drift).toBe(0);
    }

    // One audit row for the upload, naming it.
    const audits = await app.prisma.auditLog.findMany({ where: { action: 'POS_IMPORT_APPLIED', entityId: store.vendorId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(store.owner.userId);
    expect(audits[0]!.changes).toMatchObject({ uploadId: p.uploadId, contentHash: p.contentHash, stockChanges: 2, priceChanges: 1 });
    // The price change is listed in the confirmation.
    expect(result.changes.find((ch) => ch.itemId === c.id)).toMatchObject({ price: { from: 100, to: 120 }, stock: null });
  });

  it('zero stock hides an item and a restock brings it back', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'Z-1', 3, 400);
    await syncOk(store, csvOf(row('Z-1', 'z', '400', '0')));
    const hidden = await itemOf(item.id);
    expect(hidden.isAvailable).toBe(false);
    expect(hidden.autoHiddenAt).not.toBeNull();

    await syncOk(store, csvOf(row('Z-1', 'z', '400', '5')));
    const back = await itemOf(item.id);
    expect(back.isAvailable).toBe(true);
    expect(back.autoHiddenAt).toBeNull();
    expect(back.stockQuantity).toBe(5);
  });

  it('the owner’s own sold-out switch survives a re-upload with stock', async () => {
    const store = await makeStore();
    const switched = await makeItem(store, 'M-1', 4, 300);
    const toggle = await app.inject({
      method: 'PUT', url: `/api/v1/vendor/items/${switched.id}/availability`, payload: { isAvailable: false },
      headers: { authorization: `Bearer ${store.owner.token}`, 'content-type': 'application/json' },
    });
    expect(toggle.statusCode).toBe(200);

    // And the harder case: the engine hid it at zero, THEN the owner switched it off themselves.
    const engineThenOwner = await makeItem(store, 'M-2', 2, 300);
    await syncOk(store, csvOf(row('M-1', 'm', '300', '4'), row('M-2', 'm', '300', '0')));
    expect((await itemOf(engineThenOwner.id)).autoHiddenAt).not.toBeNull();
    const toggle2 = await app.inject({
      method: 'PUT', url: `/api/v1/vendor/items/${engineThenOwner.id}/availability`, payload: { isAvailable: false },
      headers: { authorization: `Bearer ${store.owner.token}`, 'content-type': 'application/json' },
    });
    expect(toggle2.statusCode).toBe(200);

    const { preview: p } = await syncOk(store, csvOf(row('M-1', 'm', '300', '20'), row('M-2', 'm', '300', '8')));
    expect(p.changes.find((ch) => ch.itemId === switched.id)?.soldOut).toBe('STAYS_SWITCHED_OFF');
    expect(p.changes.find((ch) => ch.itemId === engineThenOwner.id)?.soldOut).toBe('STAYS_SWITCHED_OFF');
    for (const id of [switched.id, engineThenOwner.id]) {
      const fresh = await itemOf(id);
      expect(fresh.isAvailable).toBe(false);
    }
    expect((await itemOf(switched.id)).stockQuantity).toBe(20);
    expect((await itemOf(engineThenOwner.id)).stockQuantity).toBe(8);
  });

  it('the same file twice is applied once: a retry replays, a second upload is refused', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'I-1', 10, 500);
    const file = csvOf(row('I-1', 'i', '500', '6'));
    const p = await previewOk(store, file);

    // A double-click: two confirms of one preview at once.
    const [r1, r2] = await Promise.all([confirm(store, file, p), confirm(store, file, p)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect([r1.json().data.replayed, r2.json().data.replayed].sort()).toEqual([false, true]);
    expect((await itemOf(item.id)).stockQuantity).toBe(6);
    expect((await movementsOf(item.id)).filter((m) => m.reason === 'POS_IMPORT')).toHaveLength(1);

    // A sale happens, then the same file is uploaded again.
    await app.prisma.$transaction(async (tx) => {
      const { applyStockMovement } = await import('../modules/inventory/stock');
      await applyStockMovement(tx, { itemId: item.id, delta: -2, reason: 'SALE' });
    });
    const again = await previewOk(store, file);
    expect(again.alreadyApplied).toMatchObject({ uploadId: p.uploadId });
    const refused = await confirm(store, file, again);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ALREADY_APPLIED');
    expect((await itemOf(item.id)).stockQuantity).toBe(4); // the sale was not undone
    expect((await movementsOf(item.id)).filter((m) => m.reason === 'POS_IMPORT')).toHaveLength(1);
    expect(await app.prisma.auditLog.count({ where: { action: 'POS_IMPORT_APPLIED', entityId: store.vendorId } })).toBe(1);
    expect(await app.prisma.posImport.count({ where: { vendorId: store.vendorId } })).toBe(1);
  });

  it('refuses a stale preview: what is applied is exactly what was previewed', async () => {
    const store = await makeStore();
    await makeItem(store, 'S-1', 5, 100);
    const file = csvOf(row('S-1', 's', '100', '4'), row('NEW-1', 'Fresh', '300', '2'));
    const p = await previewOk(store, file);
    // Someone adds NEW-1 by hand between preview and confirm: the plan is no longer "add NEW-1".
    await makeItem(store, 'new-1', 9, 300);
    const res = await confirm(store, file, p);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PREVIEW_STALE');
    expect(await app.prisma.posImport.count({ where: { vendorId: store.vendorId } })).toBe(0);
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId, sku: { equals: 'NEW-1', mode: 'insensitive' } } })).toBe(1);
  });

  it('a changed file under an old preview is refused', async () => {
    const store = await makeStore();
    await makeItem(store, 'H-1', 5, 100);
    const p = await previewOk(store, csvOf(row('H-1', 'h', '100', '4')));
    const res = await confirm(store, csvOf(row('H-1', 'h', '100', '1')), p);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PREVIEW_STALE');

    // Changed only where Swift does not look (a matched item's description): still not the file that
    // was previewed, and the store's record of applied files must name the file actually applied.
    const quiet = csvOf(row('H-1', 'h', '100', '4')).replace(',h,,', ',h,new words,');
    expect(quiet).not.toBe(csvOf(row('H-1', 'h', '100', '4')));
    const res2 = await confirm(store, quiet, p);
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error.code).toBe('PREVIEW_STALE');
    expect(await app.prisma.posImport.count({ where: { vendorId: store.vendorId } })).toBe(0);
  });
});

describe('items missing from the file', () => {
  it('are left as they are by default, and switched off only when the store asks', async () => {
    const store = await makeStore();
    const kept = await makeItem(store, 'K-1', 6, 100);
    const gone = await makeItem(store, 'G-1', 6, 100);
    const noSku = await makeItem(store, null, 6, 100);

    await syncOk(store, csvOf(row('K-1', 'k', '100', '6')));
    for (const id of [gone.id, noSku.id]) {
      const fresh = await itemOf(id);
      expect(fresh.isAvailable).toBe(true);
      expect(fresh.stockQuantity).toBe(6);
    }

    const { result } = await syncOk(store, csvOf(row('K-1', 'k', '100', '5')), 'SOLD_OUT');
    expect(result.missing).toEqual([expect.objectContaining({ itemId: gone.id, action: 'SWITCH_OFF' })]);
    const goneAfter = await itemOf(gone.id);
    expect(goneAfter.isAvailable).toBe(false);
    expect(goneAfter.autoHiddenAt).toBeNull(); // the store's own choice: a restock does not undo it
    expect(goneAfter.stockQuantity).toBe(6); // no count was given, so none was invented
    expect((await movementsOf(gone.id)).filter((m) => m.reason === 'POS_IMPORT')).toHaveLength(0);
    expect((await itemOf(noSku.id)).isAvailable).toBe(true); // never matched, never touched
    expect((await itemOf(kept.id)).stockQuantity).toBe(5);
  });
});

describe('duplicates and rows without a SKU are never guessed', () => {
  it('refuses a SKU that appears twice in the file or twice in the store, and creates nothing without a SKU', async () => {
    const store = await makeStore();
    const twinA = await makeItem(store, 'TWIN', 5, 100);
    const twinB = await makeItem(store, 'twin ', 5, 100);
    const single = await makeItem(store, 'DUP-FILE', 5, 100);

    const file = csvOf(
      row('TWIN', 'twin', '150', '1'),
      row('DUP-FILE', 'd', '150', '1'),
      row('dup-file', 'd', '150', '2'),
      row('', 'No Code Juice', '200', '4'),
    );
    const p = await previewOk(store, file);
    expect(p.needsAttention.map((n) => n.row).sort()).toEqual([2, 3, 4, 5]);
    expect(p.changes).toHaveLength(0);
    expect(p.newItems).toHaveLength(0);
    expect(p.missing).toHaveLength(0); // a SKU that needs attention is not "missing"

    const res = await confirm(store, file, p);
    expect(res.statusCode, res.body).toBe(200);
    for (const id of [twinA.id, twinB.id, single.id]) {
      const fresh = await itemOf(id);
      expect(fresh.stockQuantity).toBe(5);
      expect(Number(fresh.basePrice)).toBe(100);
    }
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId, name: 'No Code Juice' } })).toBe(0);
  });
});

describe('who can sync', () => {
  it('a staff member gets 403; a manager may; someone with no store gets 403', async () => {
    const store = await makeStore();
    await makeItem(store, 'W-1', 5, 100);
    const file = csvOf(row('W-1', 'w', '100', '4'));

    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: store.vendorId, userId: staff.userId, role: 'STAFF', invitedBy: store.owner.userId } });
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: store.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: store.owner.userId } });
    const outsider = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const p = await previewOk(store, file);
    for (const who of [staff, outsider]) {
      const pv = await preview(store, file, undefined, who.token);
      expect(pv.statusCode).toBe(403);
      const cf = await confirm(store, file, p, who.token);
      expect(cf.statusCode).toBe(403);
    }
    expect(await app.prisma.posImport.count({ where: { vendorId: store.vendorId } })).toBe(0);

    const asManager = await preview(store, file, undefined, manager.token);
    expect(asManager.statusCode, asManager.body).toBe(200);
    expect(asManager.json().data.storeId).toBe(store.vendorId);
  });

  it('refuses a store that is not the caller’s, across tenants, and never matches another store’s SKUs', async () => {
    const victim = await makeStore();
    const victimItem = await makeItem(victim, 'X-1', 5, 100);
    await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: FOREIGN_TENANT, name: 'POS sync foreign', slug: FOREIGN_TENANT } }), 'test-fixture:pos-export-sync');
    const foreign = await runWithoutTenant(() => makeStore({ tenantId: FOREIGN_TENANT }), 'test-fixture:pos-export-sync');
    const file = csvOf(row('X-1', 'x', '999', '0'));

    const res = await post('/items/import/sync/preview', foreign.owner.token, { csv: file }, { 'x-vendor-id': victim.vendorId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STORE_NOT_YOURS');

    // Without the header the foreign owner syncs THEIR store: X-1 is a new item there, not the victim's.
    const own = await previewOk(foreign, file);
    expect(own.storeId).toBe(foreign.vendorId);
    expect(own.changes).toHaveLength(0);
    expect(own.newItems.map((n) => n.sku)).toEqual(['X-1']);
    // Read as the system: the foreign caller's request bound this test's async context to its tenant.
    const fresh = await runWithoutTenant(() => itemOf(victimItem.id), 'test-fixture:pos-export-sync');
    expect(fresh.stockQuantity).toBe(5);
    expect(Number(fresh.basePrice)).toBe(100);
  });

  it('a store still waiting for verification can update its items but not list new ones', async () => {
    const store = await makeStore({ verified: false });
    const item = await makeItem(store, 'U-1', 5, 100);
    const file = csvOf(row('U-1', 'u', '100', '3'), row('U-NEW', 'Unlisted', '100', '3'));
    const { preview: p } = await syncOk(store, file);
    expect(p.newItems).toHaveLength(0);
    expect(p.needsAttention).toEqual([expect.objectContaining({ sku: 'U-NEW', reason: expect.stringMatching(/verif/i) })]);
    expect((await itemOf(item.id)).stockQuantity).toBe(3);
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId, sku: 'U-NEW' } })).toBe(0);
  });

  it('confirm is rate-limited per caller', async () => {
    const store = await makeStore();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await post('/items/import/sync/confirm', store.owner.token, { csv: csvOf(row('R-1', 'r', '100', '1')), uploadId: `rate-${RUN}-${i}-padpadpad`, contentHash: '0'.repeat(64), planDigest: '0'.repeat(64), missing: 'LEAVE' });
      statuses.push(res.statusCode);
    }
    expect(statuses).toContain(429);
  });

  it('keeps the import caps: too many rows is refused before anything is read', async () => {
    const store = await makeStore();
    const rows = Array.from({ length: 5001 }, (_, i) => row(`CAP-${i}`, 'cap', '100', '1'));
    const res = await preview(store, csvOf(...rows));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TOO_MANY_ROWS');
  });
});

describe('prices and orders', () => {
  it('a price change never alters an order already placed; an open cart shows the new price when it is next read', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'PR-1', 50, 1000, { name: 'Priced Thing' });
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const order = await app.prisma.order.create({
      data: {
        orderNumber: `POS-${RUN}-${seq}`, orderType: 'GROCERY_DELIVERY', customerId: customer.userId, vendorId: store.vendorId,
        status: 'PENDING', fulfillment: 'DELIVERY', pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
        deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.14,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
        items: { create: [{ itemId: item.id, name: 'Priced Thing', quantity: 2, basePrice: 1000, markedUpPrice: 1000, markupAmount: 0, totalBase: 2000, totalMarkup: 0, totalCustomer: 2000 }] },
      },
      include: { items: true },
    });
    createdOrderIds.push(order.id);

    const add = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items', payload: { vendorId: store.vendorId, itemId: item.id, quantity: 1 },
      headers: { authorization: `Bearer ${customer.token}`, 'content-type': 'application/json' },
    });
    expect(add.statusCode, add.body).toBe(201);

    await syncOk(store, csvOf(row('PR-1', 'Priced Thing', '1400', '50')));

    const placed = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(Number(placed.totalAmount)).toBe(2500);
    expect(Number(placed.subtotalBase)).toBe(2000);
    expect(Number(placed.items[0]!.basePrice)).toBe(1000);
    expect(Number(placed.items[0]!.totalCustomer)).toBe(2000);
    expect(placed.updatedAt.getTime()).toBe(order.updatedAt.getTime());

    const cart = await app.inject({ method: 'GET', url: '/api/v1/customer/cart', headers: { authorization: `Bearer ${customer.token}` } });
    expect(cart.statusCode, cart.body).toBe(200);
    const line = (cart.json().data.items as Array<{ itemId: string; basePrice: number }>).find((l) => l.itemId === item.id)!;
    expect(Number(line.basePrice)).toBe(1400);
  });
});

describe('automap for a till export', () => {
  it('a stock-count export with only a SKU and a quantity column maps for a sync', async () => {
    const store = await makeStore();
    const res = await post('/items/import/automap', store.owner.token, { csv: 'SKU,Qty on hand\nRICE-5KG,12', mode: 'sync' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.mapping).toMatchObject({ sku: 'SKU', stockQuantity: 'Qty on hand' });
  });

  it('a selling price column wins over a cost column, whichever comes first', async () => {
    const store = await makeStore();
    const res = await post('/items/import/automap', store.owner.token, { csv: 'Item,Cost,Price,Category,SKU\nRice,2800,3500,Groceries,R-1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.mapping.basePrice).toBe('Price');
  });
});

// ---------------------------------------------------------------------------
// [POS-SYNC F1] Till exports Guyana stores use, read by their documented
// column layouts (Loyverse items export; QuickBooks Desktop item listing).
// Every value below is invented for the test; no store's file is used.
// ---------------------------------------------------------------------------

const LOYVERSE_HEADER = [
  'Handle', 'SKU', 'Name', 'Category', 'Description', 'Sold by weight',
  'Option 1 name', 'Option 1 value', 'Option 2 name', 'Option 2 value', 'Option 3 name', 'Option 3 value',
  'Cost', 'Barcode', 'SKU of included item', 'Quantity of included item', 'Track stock',
  'Available for sale [Main Store]', 'Price [Main Store]', 'In stock [Main Store]', 'Low stock [Main Store]',
].join(',');
const loyverseRow = (handle: string, sku: string, name: string, category: string, cost: string, track: string, forSale: string, price: string, inStock: string) =>
  [handle, sku, name, category, '', 'N', '', '', '', '', '', '', cost, '', '', '', track, forSale, price, inStock, '2'].join(',');
const LOYVERSE_FILE = [
  LOYVERSE_HEADER,
  loyverseRow('rice-5kg', '10001', 'Rice 5kg', 'Groceries', '2800', 'Y', 'Y', '3500', '40'),
  loyverseRow('fried-rice', '10002', 'Fried Rice', 'Meals', '900', 'N', 'Y', '1800', '0'),
  loyverseRow('old-biscuit', '10003', 'Old Biscuit', 'Snacks', '300', 'Y', 'N', '450', '12'),
].join('\n');

const QUICKBOOKS_FILE = [
  'Item,Description,Type,Cost,Price,Preferred Vendor,Reorder Point,On Hand',
  'Rice 5kg,Long grain rice,Inventory Part,"2,800.00","3,500.00",Rice Supplier Ltd,10,40',
  'Delivery charge,Delivery,Service,0.00,500.00,,,',
].join('\n');

describe('till export profiles (F1): cost is never the price', () => {
  it('reads a Loyverse items export by its own columns', async () => {
    const store = await makeStore();
    const res = await post('/items/import/automap', store.owner.token, { csv: LOYVERSE_FILE, mode: 'sync' });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.profile.id).toBe('loyverse');
    expect(data.mapping).toMatchObject({
      sku: 'SKU', name: 'Name', category: 'Category',
      basePrice: 'Price [Main Store]', stockQuantity: 'In stock [Main Store]', isAvailable: 'Available for sale [Main Store]',
    });
    expect(Object.values(data.mapping)).not.toContain('Cost');
    expect(Object.values(data.mapping)).not.toContain('Quantity of included item');
    const [rice, friedRice, biscuit] = data.preview as Array<Record<string, string>>;
    expect(rice).toMatchObject({ sku: '10001', basePrice: '3500', stockQuantity: '40', isAvailable: 'true' });
    // "Track stock = N": the till does not count fried rice, so its 0 is not a count.
    expect(friedRice).toMatchObject({ sku: '10002', stockQuantity: '' });
    expect(biscuit).toMatchObject({ sku: '10003', isAvailable: 'false' });
  });

  it('asks which till store a multi-store Loyverse export belongs to, then reads only that store', async () => {
    const store = await makeStore();
    const header = [
      'Handle', 'SKU', 'Name', 'Category', 'Cost', 'Track stock',
      'Available for sale [Main Store]', 'Price [Main Store]', 'In stock [Main Store]',
      'Available for sale [Bourda]', 'Price [Bourda]', 'In stock [Bourda]',
    ].join(',');
    const csv = [header, 'rice-5kg,10001,Rice 5kg,Groceries,2800,Y,Y,3500,40,Y,3600,7'].join('\n');
    const ask = await post('/items/import/automap', store.owner.token, { csv, mode: 'sync' });
    expect(ask.statusCode).toBe(422);
    expect(ask.json().error.code).toBe('CHOOSE_TILL_STORE');
    expect(ask.json().error.details.stores).toEqual(['Main Store', 'Bourda']);

    const chosen = await post('/items/import/automap', store.owner.token, { csv, mode: 'sync', tillStore: 'Bourda' });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json().data.mapping).toMatchObject({ basePrice: 'Price [Bourda]', stockQuantity: 'In stock [Bourda]' });
    expect(chosen.json().data.preview[0]).toMatchObject({ basePrice: '3600', stockQuantity: '7' });
  });

  it('reads a QuickBooks item listing: Item is the code, Price the price, On Hand the count; Type and Preferred Vendor are not used', async () => {
    const store = await makeStore();
    const res = await post('/items/import/automap', store.owner.token, { csv: QUICKBOOKS_FILE, mode: 'sync' });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.profile.id).toBe('quickbooks-item-listing');
    expect(data.mapping).toMatchObject({ sku: 'Item', name: 'Item', basePrice: 'Price', stockQuantity: 'On Hand' });
    for (const wrong of ['Cost', 'Type', 'Preferred Vendor', 'Reorder Point']) expect(Object.values(data.mapping)).not.toContain(wrong);
    expect(data.preview[0]).toMatchObject({ sku: 'Rice 5kg', basePrice: '3,500.00', stockQuantity: '40' });
  });

  it('a generic till export: the selling price wins over a cost price, and short words are not found inside others', async () => {
    const store = await makeStore();
    const generic = await post('/items/import/automap', store.owner.token, {
      csv: 'Product,Barcode,Department,Cost Price,Selling Price,Qty on Hand\nRice 5kg,123,Groceries,2800,3500,40',
    });
    expect(generic.statusCode, generic.body).toBe(200);
    expect(generic.json().data.mapping).toMatchObject({ name: 'Product', sku: 'Barcode', category: 'Department', basePrice: 'Selling Price', stockQuantity: 'Qty on Hand' });

    // Read by the words inside a header: a cost price and a low-stock alert come first and are passed over.
    const inside = await post('/items/import/automap', store.owner.token, {
      csv: 'Product,Cost Price,Retail Price (VAT incl),Low Stock Alert,Stock On Hand,Category\nRice 5kg,2800,3500,5,40,Groceries',
    });
    expect(inside.statusCode, inside.body).toBe(200);
    expect(inside.json().data.mapping).toMatchObject({ basePrice: 'Retail Price (VAT incl)', stockQuantity: 'Stock On Hand' });

    const location = await post('/items/import/automap', store.owner.token, { csv: 'Name,Price,Location,Preferred Vendor,SKU\nRice,3500,Shelf 2,Acme,R-1', mode: 'sync' });
    expect(location.statusCode, location.body).toBe(200);
    expect(location.json().data.mapping.category).toBeUndefined();
    expect(location.json().data.mapping.sku).toBe('SKU');

    // No code column at all: the supplier is never taken for one (pREFerred, VENDOR).
    const noCode = await post('/items/import/automap', store.owner.token, { csv: 'Item,Price,Category,Preferred Vendor,Qty\nRice,3500,Groceries,Acme,4', mode: 'sync' });
    expect(noCode.statusCode).toBe(422);
    expect(noCode.json().error.code).toBe('UNMAPPED_COLUMNS');
    expect(noCode.json().error.details.mapping.sku).toBeUndefined();
  });

  it('the store can change any column in the preview; a column the file does not have is refused', async () => {
    const store = await makeStore();
    const csv = 'Name,Price,Location,SKU,Qty\nRice,3500,Shelf 2,R-1,4';
    const chosen = await post('/items/import/automap', store.owner.token, { csv, mapping: { category: 'Location', stockQuantity: '' } });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json().data.mapping.category).toBe('Location');
    expect(chosen.json().data.mapping.stockQuantity).toBeUndefined();
    expect(chosen.json().data.preview[0]).toMatchObject({ category: 'Shelf 2', stockQuantity: '' });

    const wrong = await post('/items/import/automap', store.owner.token, { csv, mapping: { category: 'Aisle' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('UNKNOWN_COLUMN');
  });

  it('a Loyverse re-upload end to end: price and count from the store columns, "not for sale" switches off, an uncounted till item is left alone', async () => {
    const store = await makeStore();
    const rice = await makeItem(store, '10001', 50, 3400);
    const friedRice = await makeItem(store, '10002', 5, 1800);
    const biscuit = await makeItem(store, '10003', 12, 450);

    const mapped = await post('/items/import/automap', store.owner.token, { csv: LOYVERSE_FILE, mode: 'sync' });
    expect(mapped.statusCode, mapped.body).toBe(200);
    const csv = mapped.json().data.normalizedCsv as string;
    const { preview: p } = await syncOk(store, csv);
    expect(p.changes.find((c) => c.itemId === rice.id)).toMatchObject({ price: { from: 3400, to: 3500 }, stock: { from: 50, to: 40 } });
    expect(p.changes.find((c) => c.itemId === biscuit.id)).toMatchObject({ soldOut: 'SWITCHED_OFF_BY_TILL', stock: null });
    expect(p.changes.find((c) => c.itemId === friedRice.id)).toBeUndefined();

    const riceAfter = await itemOf(rice.id);
    expect(Number(riceAfter.basePrice)).toBe(3500); // never the 2800 cost
    expect(riceAfter.stockQuantity).toBe(40);
    const fried = await itemOf(friedRice.id);
    expect(fried.stockQuantity).toBe(5);
    expect(fried.isAvailable).toBe(true);
    const off = await itemOf(biscuit.id);
    expect(off.isAvailable).toBe(false);
    expect(off.autoHiddenAt).toBeNull();
  });
});

describe('the quick sold-out switch (F5)', () => {
  it('writes an audit row and keeps its answer the same shape', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'Q-1', 3, 100);
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/vendor/items/${item.id}/availability`, payload: { isAvailable: false },
      headers: { authorization: `Bearer ${store.owner.token}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data).sort()).toEqual(['id', 'isAvailable', 'name']);
    const audits = await app.prisma.auditLog.findMany({ where: { entity: 'Item', entityId: item.id, action: 'ITEM_AVAILABILITY_SET' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(store.owner.userId);
    expect(audits[0]!.changes).toMatchObject({ from: true, to: false });
  });
});

describe('pos_imports is walled like every tenant table', () => {
  it('is in both registries, with a lineage rule to its store', () => {
    expect(TENANT_TABLES).toContain('pos_imports');
    expect(TENANT_MODEL_NAMES).toContain('posImport');
    expect(TENANT_LINEAGE_TABLES.find((r) => r.table === 'pos_imports')).toMatchObject({
      trigger: 'pos_imports_tenant_matches_vendor', parent: 'vendors', fk: 'vendorId',
    });
  });

  it('RLS is enabled and forced, its triggers exist, and an applied import can never be edited', async () => {
    const [rls] = await app.prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(`
      SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'pos_imports'`);
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const triggers = await app.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.pos_imports'::regclass AND NOT tgisinternal ORDER BY 1`);
    expect(triggers.map((t) => t.tgname)).toEqual(['pos_imports_frozen', 'pos_imports_tenant_matches_vendor']);

    const store = await makeStore();
    await makeItem(store, 'F-1', 2, 100);
    const { preview: p } = await syncOk(store, csvOf(row('F-1', 'f', '100', '1')));
    const applied = await app.prisma.posImport.findUniqueOrThrow({ where: { id: p.uploadId } });
    expect(applied).toMatchObject({ vendorId: store.vendorId, contentHash: p.contentHash, planDigest: p.planDigest, actorId: store.owner.userId });
    await expect(app.prisma.posImport.update({ where: { id: p.uploadId }, data: { missingPolicy: 'SOLD_OUT' } })).rejects.toThrow(/never changes/);
  });
});

// ---------------------------------------------------------------------------
// [POS-SYNC review] Availability under load, units promised to open orders,
// and the smaller edges (digest, missing items, Excel codes, lock order).
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeCustomer() {
  const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: { userId: c.userId, label: 'Home', addressLine1: '1 Till Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true },
  });
  return c;
}
const asCustomer = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({
  method, url: `/api/v1/customer${url}`,
  ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
});

/** An order whose goods are (or are not) still at the store, with its sale in the ledger. */
async function openOrderHolding(store: Store, itemId: string, units: number, status: 'PENDING' | 'PREPARING' | 'DELIVERED') {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `POSH-${RUN}-${seq}-${nanoid(4)}`, orderType: 'GROCERY_DELIVERY', customerId: customer.userId, vendorId: store.vendorId,
      status, fulfillment: 'DELIVERY', pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.14,
      subtotalBase: 100 * units, subtotalMarkup: 0, subtotalCustomer: 100 * units, deliveryFee: 0, totalAmount: 100 * units, paymentMethod: 'CASH',
      items: { create: [{ itemId, name: 'Held', quantity: units, basePrice: 100, markedUpPrice: 100, markupAmount: 0, totalBase: 100 * units, totalMarkup: 0, totalCustomer: 100 * units }] },
    },
  });
  createdOrderIds.push(order.id);
  await app.prisma.$transaction((tx) => applyStockMovement(tx, { itemId, delta: -units, reason: 'SALE', orderId: order.id }));
  return Object.assign(order, { customerToken: customer.token });
}

describe('availability: a big file never turns a checkout into a server error (S2)', () => {
  it('a checkout that meets a store busy applying a file is told to try again (409), not a 500', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'BUSY-1', 20, 500);
    const customer = await makeCustomer();
    expect((await asCustomer(customer.token, 'POST', '/cart/items', { vendorId: store.vendorId, itemId: item.id, quantity: 1 })).statusCode).toBe(201);

    // Hold the store's lock the way an apply does, for longer than checkout may wait.
    let releaseAt = 0;
    const holder = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${store.vendorId} FOR UPDATE`;
      await sleep(6_000);
      releaseAt = Date.now();
    }, { timeout: 30_000 });
    await sleep(200);
    const res = await asCustomer(customer.token, 'POST', '/checkout', { paymentMethod: 'CASH' });
    const answeredAt = Date.now();
    await holder;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STORE_BUSY');
    expect(answeredAt).toBeLessThan(releaseAt); // answered while the store was still busy, not after
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
    // And the cart is still there to try again.
    expect((await asCustomer(customer.token, 'POST', '/checkout', { paymentMethod: 'CASH' })).statusCode).toBe(200);
  }, 60_000);

  it('a 5,000-row file confirmed between a checkout’s pricing and its commit: both finish, nothing is a server error', async () => {
    const store = await makeStore();
    const N = 5000;
    await app.prisma.item.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        vendorId: store.vendorId, categoryId: store.categoryId, name: `Bulk ${i}`, basePrice: 100,
        sku: `BULK-${String(i).padStart(4, '0')}`, isAvailable: true, stockQuantity: 50,
      })),
    });
    const bulk = await app.prisma.item.findMany({ where: { vendorId: store.vendorId }, select: { id: true, sku: true } });
    const first = bulk.find((b) => b.sku === 'BULK-0000')!;
    const customer = await makeCustomer();
    expect((await asCustomer(customer.token, 'POST', '/cart/items', { vendorId: store.vendorId, itemId: first.id, quantity: 1 })).statusCode).toBe(201);

    const file = csvOf(...Array.from({ length: N }, (_, i) => row(`BULK-${String(i).padStart(4, '0')}`, 'b', '110', '40')));
    const p = await previewOk(store, file);
    expect(p.totals['stockChanges']).toBe(N);

    // [Sol S3] An explicit barrier, not a delay: the checkout has priced the
    // cart (at 100) when the whole file is confirmed, and only then begins its
    // transaction.
    const t0 = Date.now();
    let applied!: { r: Awaited<ReturnType<typeof confirm>>; ms: number };
    const checkout = await new OrderService(app.prisma, app.io).checkout({
      userId: customer.userId, paymentMethod: 'CASH',
      beforeTransaction: async () => {
        const r = await confirm(store, file, p);
        applied = { r, ms: Date.now() - t0 };
        expect(r.statusCode, r.body).toBe(200);
      },
    }).then(
      () => ({ statusCode: 200, code: '' }),
      (error) => {
        if (!error.statusCode) throw error;
        return { statusCode: error.statusCode as number, code: error.code as string };
      },
    );
    expect(applied.r.statusCode, applied.r.body).toBe(200);
    // On this branch the order is placed at the price the customer saw (100):
    // checkout does not yet re-read prices where it commits. (The price lock,
    // #1493, refuses this snapshot instead; this assertion moves with it.)
    expect(checkout).toEqual({ statusCode: 200, code: '' });
    const placed = await app.prisma.orderItem.findFirstOrThrow({ where: { order: { customerId: customer.userId } } });
    expect(Number(placed.markedUpPrice)).toBe(100);
    // The whole file landed set-based (about 1.7 s end to end locally; row by
    // row it took over 20 s).
    expect(applied.ms).toBeLessThan(10_000);
    expect(await app.prisma.stockMovement.count({ where: { itemId: { in: bulk.map((b) => b.id) }, reason: 'POS_IMPORT' } })).toBe(N);
    expect(await app.prisma.item.count({ where: { vendorId: store.vendorId, basePrice: 110 } })).toBe(N);
    // The file set 40 before the order existed; the order then took its unit.
    const firstAfter = await itemOf(first.id);
    expect(firstAfter.stockQuantity).toBe(39);
    // The fixture set 50 without a ledger row; every movement after it is in the ledger.
    expect((await reconcileItemStock(app.prisma, first.id)).drift).toBe(50);
  }, 240_000);
});

describe('explicit checkout and till ordering (Sol S3)', () => {
  it('a file confirmed while an order is committing waits for it, then keeps that order’s unit held', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'ORDER-FIRST', 50, 100);
    const customer = await makeCustomer();
    expect((await asCustomer(customer.token, 'POST', '/cart/items', { vendorId: store.vendorId, itemId: item.id, quantity: 1 })).statusCode).toBe(201);
    const file = csvOf(row('ORDER-FIRST', 'o', '110', '40'));
    const p = await previewOk(store, file);
    let sync: ReturnType<typeof confirm> | undefined;
    let syncSettled = false;
    const placed = await new OrderService(app.prisma, app.io).checkout({
      userId: customer.userId, paymentMethod: 'CASH',
      afterDurableTail: async () => {
        // The order is written and its store and item are locked, but it has
        // not committed: the store confirms its file now, and must wait.
        sync = confirm(store, file, p).finally(() => { syncSettled = true; });
        await sleep(500);
        expect(syncSettled).toBe(false);
      },
    });
    const applied = await sync!;
    expect(applied.statusCode, applied.body).toBe(200);
    expect(placed.orders).toHaveLength(1);
    const ordered = await app.prisma.orderItem.findFirstOrThrow({ where: { order: { customerId: customer.userId } } });
    expect(Number(ordered.markedUpPrice)).toBe(100);
    const after = await itemOf(item.id);
    // 40 on the till, less the one unit the open order still holds.
    expect(after.stockQuantity).toBe(39);
    expect(Number(after.basePrice)).toBe(110);
  });
});

describe('units sold on Swift but not yet collected (S3)', () => {
  it('are taken off the till count, shown in the preview, and only while the goods are still at the store', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'HELD-1', 10, 100);
    await openOrderHolding(store, item.id, 3, 'PENDING'); // 10 -> 7, the 3 still on the shelf
    await openOrderHolding(store, item.id, 2, 'DELIVERED'); // 7 -> 5, gone
    expect((await itemOf(item.id)).stockQuantity).toBe(5);

    // The till counts what is physically there: 5 + the 3 not yet collected, plus 4 received = 12.
    const { preview: p } = await syncOk(store, csvOf(row('HELD-1', 'h', '100', '12')));
    const change = p.changes.find((c) => c.itemId === item.id)!;
    expect(change.stock).toEqual({ from: 5, to: 9, till: 12, held: 3 });
    expect(change.notes.join(' ')).toMatch(/3 of the till's 12 are in Swift orders not yet collected/);
    expect((await itemOf(item.id)).stockQuantity).toBe(9);

    // Fewer on the till than are promised: Swift shows 0, never a negative.
    const { preview: p2 } = await syncOk(store, csvOf(row('HELD-1', 'h', '100', '2')));
    expect(p2.changes.find((c) => c.itemId === item.id)!.stock).toEqual({ from: 9, to: 0, till: 2, held: 3 });
    expect((await itemOf(item.id)).stockQuantity).toBe(0);
  });
});

describe('units given back at the store are not held (refund movements carry their order)', () => {
  const asStore = (store: Store, url: string, payload?: unknown) => app.inject({
    method: 'POST', url: `/api/v1/vendor${url}`,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { authorization: `Bearer ${store.owner.token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });

  it('a return from an order placed before the item tracked stock never cancels another order’s hold (Sol S2)', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'HELD-UNTRACKED', null, 100);
    const oldOrder = await openOrderHolding(store, item.id, 3, 'PREPARING'); // untracked: took nothing from a count
    const { recordOpeningBalance } = await import('../modules/inventory/stock');
    await app.prisma.$transaction((tx) => recordOpeningBalance(tx, item.id, 10, store.owner.userId));
    await openOrderHolding(store, item.id, 3, 'PREPARING'); // tracked: 10 -> 7, these 3 are held
    expect((await itemOf(item.id)).stockQuantity).toBe(7);
    const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: oldOrder.id } });
    const refund = await asStore(store, `/orders/${oldOrder.id}/items/${line.id}/refund-line`);
    expect(refund.statusCode, refund.body).toBe(200);
    // Nothing is given back in the old order's name: it took nothing.
    expect(await app.prisma.stockMovement.count({ where: { orderId: oldOrder.id, reason: 'PICK_REFUND' } })).toBe(0);
    const { unitsHeldByOpenOrders } = await import('../modules/inventory/pos-sync');
    expect((await unitsHeldByOpenOrders(app.prisma, store.vendorId, [item.id])).get(item.id)).toBe(3);
    // The till counts 10; Swift keeps the tracked order's 3 back from what it sells.
    const p = await previewOk(store, csvOf(row('HELD-UNTRACKED', 'h', '100', '10')));
    expect(p.changes.find((c) => c.itemId === item.id)?.stock).toMatchObject({ to: 7, till: 10, held: 3 });
  });

  it('two lines of one item: refunding one gives back only its own units, and the other line stays held', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'HELD-TWO', 10, 100);
    const order = await openOrderHolding(store, item.id, 2, 'PREPARING'); // 10 -> 8
    const second = await app.prisma.orderItem.create({
      data: { orderId: order.id, itemId: item.id, name: 'Held', quantity: 3, basePrice: 100, markedUpPrice: 100, markupAmount: 0, totalBase: 300, totalMarkup: 0, totalCustomer: 300, specialInstructions: 'second line' },
    });
    await app.prisma.$transaction((tx) => applyStockMovement(tx, { itemId: item.id, delta: -3, reason: 'SALE', orderId: order.id })); // 8 -> 5
    const first = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id, id: { not: second.id } } });
    const refund = await asStore(store, `/orders/${order.id}/items/${first.id}/refund-line`);
    expect(refund.statusCode, refund.body).toBe(200);
    expect((await itemOf(item.id)).stockQuantity).toBe(7);
    const { unitsHeldByOpenOrders } = await import('../modules/inventory/pos-sync');
    expect((await unitsHeldByOpenOrders(app.prisma, store.vendorId, [item.id])).get(item.id)).toBe(3);
  });

  it('a historical positive order balance cannot cancel another order hold', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'HELD-LEGACY', 10, 100);
    const a = await openOrderHolding(store, item.id, 1, 'PREPARING');
    const b = await openOrderHolding(store, item.id, 3, 'PREPARING');
    await app.prisma.$transaction((tx) => applyStockMovement(tx, { itemId: item.id, delta: 4, reason: 'PICK_REFUND', orderId: a.id }));
    const { unitsHeldByOpenOrders } = await import('../modules/inventory/pos-sync');
    expect((await unitsHeldByOpenOrders(app.prisma, store.vendorId, [item.id])).get(item.id)).toBe(3);
    expect(await app.prisma.stockMovement.count({ where: { orderId: b.id, reason: 'SALE' } })).toBe(1);
  });

  it('a line the store refunds (back on the shelf) holds nothing: its refund nets its sale', async () => {
    const store = await makeStore();
    const item = await makeItem(store, 'HELD-R', 10, 100);
    const order = await openOrderHolding(store, item.id, 3, 'PREPARING'); // 10 -> 7
    const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const refund = await asStore(store, `/orders/${order.id}/items/${line.id}/refund-line`);
    expect(refund.statusCode, refund.body).toBe(200);
    expect((await itemOf(item.id)).stockQuantity).toBe(10);
    // The till counts the 10 on the shelf less 5 sold over the counter: 5, and Swift holds none of them.
    const { preview: p } = await syncOk(store, csvOf(row('HELD-R', 'h', '100', '5')));
    expect(p.changes.find((c) => c.itemId === item.id)!.stock).toEqual({ from: 10, to: 5, till: 5, held: 0 });
    expect((await itemOf(item.id)).stockQuantity).toBe(5);
  });

  it('an approved substitute: the original back on the shelf holds nothing; the substitute taken holds its units', async () => {
    const store = await makeStore();
    const original = await makeItem(store, 'HELD-A', 10, 100);
    const substitute = await makeItem(store, 'HELD-B', 10, 100);
    const order = await openOrderHolding(store, original.id, 3, 'PREPARING'); // A 10 -> 7
    const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const proposed = await asStore(store, `/orders/${order.id}/items/${line.id}/substitute`, { substituteItemId: substitute.id });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const approved = await asCustomer(order.customerToken, 'POST', `/orders/${order.id}/items/${line.id}/substitution`, { approve: true });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await itemOf(original.id)).stockQuantity).toBe(10); // back on the shelf
    expect((await itemOf(substitute.id)).stockQuantity).toBe(7); // 3 taken for the order, still in the store
    const { preview: p } = await syncOk(store, csvOf(row('HELD-A', 'a', '100', '5'), row('HELD-B', 'b', '100', '8')));
    expect(p.changes.find((c) => c.itemId === original.id)!.stock).toEqual({ from: 10, to: 5, till: 5, held: 0 });
    expect(p.changes.find((c) => c.itemId === substitute.id)!.stock).toEqual({ from: 7, to: 5, till: 8, held: 3 });
  });
});

describe('smaller edges from the review (S4)', () => {
  it('the preview is stale if a missing item it would switch off was switched off by hand meanwhile', async () => {
    const store = await makeStore();
    await makeItem(store, 'KEEP-1', 5, 100);
    const gone = await makeItem(store, 'GONE-1', 5, 100);
    const file = csvOf(row('KEEP-1', 'k', '100', '5'));
    const p = await previewOk(store, file, 'SOLD_OUT');
    expect(p.missing).toEqual([expect.objectContaining({ itemId: gone.id, action: 'SWITCH_OFF' })]);
    const toggle = await app.inject({
      method: 'PUT', url: `/api/v1/vendor/items/${gone.id}/availability`, payload: { isAvailable: false },
      headers: { authorization: `Bearer ${store.owner.token}`, 'content-type': 'application/json' },
    });
    expect(toggle.statusCode).toBe(200);
    const res = await confirm(store, file, p);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PREVIEW_STALE');
  });

  it('"mark them sold out" also covers an item the engine hid at zero, so a later restock does not bring it back', async () => {
    const store = await makeStore();
    await makeItem(store, 'KEEP-2', 5, 100);
    const hidden = await makeItem(store, 'HID-2', 0, 100, { isAvailable: false });
    await app.prisma.item.update({ where: { id: hidden.id }, data: { autoHiddenAt: new Date() } });
    const { result } = await syncOk(store, csvOf(row('KEEP-2', 'k', '100', '5')), 'SOLD_OUT');
    expect(result.missing).toEqual([expect.objectContaining({ itemId: hidden.id, action: 'SWITCH_OFF' })]);
    expect((await itemOf(hidden.id)).autoHiddenAt).toBeNull();
    const restock = await app.inject({
      method: 'POST', url: `/api/v1/vendor/items/${hidden.id}/adjust`, payload: { delta: 5, reason: 'RECEIVED' },
      headers: { authorization: `Bearer ${store.owner.token}`, 'content-type': 'application/json' },
    });
    expect(restock.statusCode, restock.body).toBe(200);
    expect((await itemOf(hidden.id)).isAvailable).toBe(false);
  });

  it('an Excel code typed as a zero-padded number keeps its leading zeros', async () => {
    const store = await makeStore();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Till');
    sheet.addRow(['SKU', 'Name', 'Price', 'Qty']);
    sheet.addRow([123, 'Rice 5kg', 3500, 4]);
    sheet.getCell('A2').numFmt = '00000';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const boundary = `----pos${nanoid(8)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="till.xlsx"\r\ncontent-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
      buffer, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/vendor/items/import/xlsx?mode=sync', payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${store.owner.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.preview[0].sku).toBe('00123');
    expect(res.json().data.preview[0].basePrice).toBe('3500'); // an ordinary number is untouched
  });

  it('a cancellation restocks its items in id order, so it cannot deadlock with a holder taking them the same way', async () => {
    const store = await makeStore();
    const one = await makeItem(store, 'ORD-1', 5, 100);
    const two = await makeItem(store, 'ORD-2', 5, 100);
    const [lo, hi] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1)) as [typeof one, typeof one];
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `POSD-${RUN}-${nanoid(4)}`, orderType: 'GROCERY_DELIVERY', customerId: customer.userId, vendorId: store.vendorId,
        status: 'PENDING', fulfillment: 'DELIVERY', pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
        deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.14,
        subtotalBase: 200, subtotalMarkup: 0, subtotalCustomer: 200, deliveryFee: 0, totalAmount: 200, paymentMethod: 'CASH',
      },
    });
    createdOrderIds.push(order.id);
    // The HIGHER id is the first line, so restocking line by line takes hi, then lo.
    for (const it of [hi, lo]) {
      await app.prisma.orderItem.create({ data: { orderId: order.id, itemId: it.id, name: it.name, quantity: 1, basePrice: 100, markedUpPrice: 100, markupAmount: 0, totalBase: 100, totalMarkup: 0, totalCustomer: 100 } });
    }
    const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
    const orders = new OrderService(app.prisma as never, ioStub);

    // A holder takes lo, then (while the cancellation runs) hi — the till sync's order.
    const holder = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "items" WHERE id = ${lo.id} FOR UPDATE`;
      await sleep(400);
      await tx.$queryRaw`SELECT id FROM "items" WHERE id = ${hi.id} FOR UPDATE`;
      await sleep(100);
    }, { timeout: 20_000 });
    await sleep(100);
    const cancel = app.prisma.$transaction((tx) => orders.restockCancelledOrder(order.id, tx), { timeout: 20_000 });
    const outcome = await Promise.allSettled([holder, cancel]);
    expect(outcome.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await itemOf(lo.id)).stockQuantity).toBe(6);
    expect((await itemOf(hi.id)).stockQuantity).toBe(6);
  }, 60_000);
});

describe('the batch stock writer (S2)', () => {
  it('is all or nothing: one row that would go below zero moves nothing and writes no ledger row', async () => {
    const store = await makeStore();
    const a = await makeItem(store, 'BAT-A', 5, 100);
    const b = await makeItem(store, 'BAT-B', 5, 100);
    const tenantId = (await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.vendorId }, select: { tenantId: true } })).tenantId;
    await expect(app.prisma.$transaction((tx) => applyStockMovements(tx, {
      vendorId: store.vendorId, tenantId, reason: 'POS_IMPORT', note: 'batch test',
      entries: [{ itemId: a.id, delta: 1 }, { itemId: b.id, delta: -99 }],
    }))).rejects.toThrow(/Stock changed while/);
    expect((await itemOf(a.id)).stockQuantity).toBe(5);
    expect((await itemOf(b.id)).stockQuantity).toBe(5);
    expect(await app.prisma.stockMovement.count({ where: { itemId: { in: [a.id, b.id] }, note: 'batch test' } })).toBe(0);
  });

  it('a checkout takes its items in id order, so it cannot deadlock with a holder taking them the same way', async () => {
    const store = await makeStore();
    const one = await makeItem(store, 'CHK-1', 5, 300);
    const two = await makeItem(store, 'CHK-2', 5, 300);
    const [lo, hi] = [one, two].sort((x, y) => (x.id < y.id ? -1 : 1)) as [typeof one, typeof one];
    const customer = await makeCustomer();
    // The HIGHER id goes in the cart first, so line-by-line decrements take hi, then lo.
    for (const it of [hi, lo]) {
      expect((await asCustomer(customer.token, 'POST', '/cart/items', { vendorId: store.vendorId, itemId: it.id, quantity: 1 })).statusCode).toBe(201);
    }
    const holder = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "items" WHERE id = ${lo.id} FOR UPDATE`;
      await sleep(1_500); // long enough for the checkout to reach its stock moves
      await tx.$queryRaw`SELECT id FROM "items" WHERE id = ${hi.id} FOR UPDATE`;
      await sleep(100);
    }, { timeout: 20_000 });
    await sleep(100);
    const checkout = asCustomer(customer.token, 'POST', '/checkout', { paymentMethod: 'CASH' });
    const [held, placed] = await Promise.allSettled([holder, checkout]);
    expect(held.status).toBe('fulfilled');
    expect(placed.status === 'fulfilled' ? placed.value.statusCode : 0).toBe(200);
    expect((await itemOf(lo.id)).stockQuantity).toBe(4);
    expect((await itemOf(hi.id)).stockQuantity).toBe(4);
  }, 60_000);
});
