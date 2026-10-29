import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';

const storage = new LocalStorageProvider();
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] "Copy the menu from another branch" + "export the menu".
//  - POST /vendor/menu/copy { fromStoreId, copyKey } into the SELECTED branch: sections, items, option groups and
//    options; prices exactly as stored (Decimal); photos kept again in this branch's own folder (the public door
//    serves a store's photo only from its own folder); stock starts untracked; never what Swift does not allow;
//    into an empty menu only; the same copyKey answers the first copy; the same business only (one owner, a
//    caller who manages both stores); a store the caller does not work in is a 404.
//  - GET /vendor/menu/export: the live menu as a formula-safe CSV (managers and owners).
//  - GET /vendor/stores says which branch is waiting for Swift's approval (the switcher).
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Menu', lastName: `Person${userIds.length}`, roles, activeRole, isPhoneVerified: true,
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chains-menu', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function makeOwner() {
  const u = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: u.userId } });
  ownerIds.push(vo.id);
  return { ...u, ownerId: vo.id };
}

async function store(ownerId: string, name: string, status: 'ACTIVE' | 'PENDING_APPROVAL' = 'ACTIVE') {
  const v = await app.prisma.vendor.create({ data: {
    ownerId, name: `${name} ${wordFreeTag(5)}`, slug: `chain-menu-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Menu Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status, acceptingOrders: status === 'ACTIVE', isCurrentlyOpen: true, isVerified: status === 'ACTIVE',
  } });
  vendorIds.push(v.id);
  return v;
}

async function photoFor(vendorId: string): Promise<string> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  return (await storage.upload({ buffer: png, filename: 'photo.png', mimeType: 'image/png', folder: `items/${vendorId}` })).url;
}

/** The source menu: two sections (one switched off), Decimal prices, options, a photo, stock, an auto-hidden item, a
 *  switched-off item, an archived item and one item Swift does not allow. */
async function buildMenu(vendorId: string) {
  const photo = await photoFor(vendorId);
  const mains = await app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0, imageUrl: photo } });
  const late = await app.prisma.category.create({ data: { vendorId, name: 'Late night', sortOrder: 1, isActive: false } });
  await app.prisma.item.create({ data: {
    vendorId, categoryId: mains.id, name: 'Quarter chicken', description: 'Fried, two pieces', basePrice: '1234.56', imageUrl: photo,
    sortOrder: 0, stockQuantity: 12, lowStockThreshold: 3, sku: 'QC-1', dietaryTags: ['halal'], allergens: ['gluten'],
    optionGroups: { create: [{ name: 'Side', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0, options: { create: [
      { name: 'Fries', additionalPrice: '0.00', isDefault: true, sortOrder: 0 },
      { name: 'Mac and cheese', additionalPrice: '99.99', sortOrder: 1 },
    ] } }] },
  } });
  await app.prisma.item.create({ data: { vendorId, categoryId: mains.id, name: 'Sold out wings', basePrice: '800.10', sortOrder: 1, isAvailable: false, autoHiddenAt: new Date(), stockQuantity: 0 } });
  await app.prisma.item.create({ data: { vendorId, categoryId: mains.id, name: 'Off today pie', basePrice: '500', sortOrder: 2, isAvailable: false } });
  await app.prisma.item.create({ data: { vendorId, categoryId: mains.id, name: 'Old dish', basePrice: '100', sortOrder: 3, isAvailable: false, archivedAt: new Date() } });
  await app.prisma.item.create({ data: { vendorId, categoryId: late.id, name: '=HYPERLINK("x") wrap', basePrice: '650.5', sortOrder: 0 } });
  await app.prisma.item.create({ data: { vendorId, categoryId: late.id, name: 'Hennessy VS', basePrice: '9000', sortOrder: 1 } });
  return { photo };
}

const send = (method: 'GET' | 'POST', token: string, url: string, vendorId?: string, payload?: object) => app.inject({
  method, url, headers: { authorization: `Bearer ${token}`, ...(vendorId ? { 'x-vendor-id': vendorId } : {}) }, ...(payload ? { payload } : {}),
});
const copy = (token: string, targetId: string, fromStoreId: string, copyKey = `copy-${nanoid(10)}`) =>
  send('POST', token, '/api/v1/vendor/menu/copy', targetId, { fromStoreId, copyKey });

const liveMenu = (vendorId: string) => app.prisma.category.findMany({
  where: { vendorId, archivedAt: null }, orderBy: { sortOrder: 'asc' },
  include: { items: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' }, include: { optionGroups: { include: { options: { orderBy: { sortOrder: 'asc' } } } } } } },
});

let owner: Awaited<ReturnType<typeof makeOwner>>;
let north: { id: string };
let camp: { id: string };
let sourcePhoto = '';

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  owner = await makeOwner();
  north = await store(owner.ownerId, 'Royal North');
  camp = await store(owner.ownerId, 'Royal Camp');
  sourcePhoto = (await buildMenu(north.id)).photo;
});

afterAll(async () => {
  await purgeFixtureAuditTrail(app.prisma, userIds, 'chains-menu-copy');
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[CHAINS] POST /vendor/menu/copy', () => {
  it('copies sections, items, options and photos into the empty branch; prices exact; stock its own; never banned goods', async () => {
    const res = await copy(owner.token, camp.id, north.id);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ fromStoreId: north.id, categories: 2, items: 4, options: 2, replayed: false, photosNotCopied: 0 });
    expect(data.photos).toBe(2);
    expect(data.notAllowed).toEqual([{ name: 'Hennessy VS' }]);

    const menu = await liveMenu(camp.id);
    expect(menu.map((c) => [c.name, c.isActive])).toEqual([['Mains', true], ['Late night', false]]);
    const [mains, late] = menu;
    expect(mains!.items.map((i) => i.name)).toEqual(['Quarter chicken', 'Sold out wings', 'Off today pie']);
    const chicken = mains!.items[0]!;
    expect(chicken.basePrice.toFixed(2)).toBe('1234.56');
    expect(chicken.optionGroups[0]!.options.map((o) => [o.name, o.additionalPrice.toFixed(2), o.isDefault])).toEqual([['Fries', '0.00', true], ['Mac and cheese', '99.99', false]]);
    expect(chicken).toMatchObject({ description: 'Fried, two pieces', sku: 'QC-1', dietaryTags: ['halal'], allergens: ['gluten'] });
    expect(chicken.optionGroups[0]).toMatchObject({ name: 'Side', isRequired: true, minSelect: 1, maxSelect: 1 });
    // A branch's stock is its own: untracked, and an item hidden only by the other branch's count is available here.
    expect(chicken.stockQuantity).toBeNull();
    expect(mains!.items[1]).toMatchObject({ stockQuantity: null, isAvailable: true, autoHiddenAt: null });
    expect(mains!.items[2]!.isAvailable, 'the store\'s own switch stays off').toBe(false);
    expect(late!.items.map((i) => i.name)).toEqual(['=HYPERLINK("x") wrap']);
    expect(late!.items[0]!.basePrice.toFixed(2)).toBe('650.50');
    // Photos: kept again in THIS branch's folder (never the other branch's address), and readable.
    for (const url of [mains!.imageUrl, chicken.imageUrl]) {
      expect(url).toContain(`items/${camp.id}/`);
      expect(url).not.toBe(sourcePhoto);
      expect((await storage.getObject(url!.replace(/^\/uploads\//, ''))).length).toBeGreaterThan(0);
    }
    expect(mains!.imageUrl).toBe(chicken.imageUrl);
    // The source is untouched.
    expect((await liveMenu(north.id)).flatMap((c) => c.items).length).toBe(5);
  });

  it('the same copy sent again answers the first one and writes nothing; a new copy into a menu that has items is refused', async () => {
    const target = await store(owner.ownerId, 'Royal East');
    const key = `copy-${nanoid(10)}`;
    const first = await copy(owner.token, target.id, north.id, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await copy(owner.token, target.id, north.id, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ ...first.json().data, replayed: true });
    expect((await liveMenu(target.id)).flatMap((c) => c.items).length).toBe(4);
    const other = await copy(owner.token, target.id, north.id);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('MENU_NOT_EMPTY');
    expect((await liveMenu(target.id)).flatMap((c) => c.items).length).toBe(4);
  });

  it('two copies at the same moment into one empty branch: one menu, never two', async () => {
    const target = await store(owner.ownerId, 'Royal West');
    const [a, b] = await Promise.all([copy(owner.token, target.id, north.id), copy(owner.token, target.id, north.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await liveMenu(target.id)).flatMap((c) => c.items).length).toBe(4);
  });

  it('the empty-menu check is made under the target store\'s lock: a section written meanwhile is seen, never a second menu', async () => {
    const target = await store(owner.ownerId, 'Royal Lock');
    let pending: ReturnType<typeof copy> | null = null;
    await app.prisma.$transaction(async (tx) => {
      // Someone else holds the store row and is adding a section by hand.
      await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${target.id} FOR UPDATE`;
      await tx.category.create({ data: { vendorId: target.id, name: 'Hand made', sortOrder: 0 } });
      pending = copy(owner.token, target.id, north.id);
      await new Promise((r) => setTimeout(r, 1500));
    }, { timeout: 20_000 });
    const res = await pending!;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('MENU_NOT_EMPTY');
    expect((await liveMenu(target.id)).map((c) => c.name)).toEqual(['Hand made']);
  });

  it('the same business only: another owner\'s store is a 404, the same store a 400', async () => {
    const stranger = await makeOwner();
    const theirs = await store(stranger.ownerId, 'Other Chicken');
    await buildMenu(theirs.id);
    const target = await store(owner.ownerId, 'Royal South');
    const res = await copy(owner.token, target.id, theirs.id);
    expect(res.statusCode).toBe(404);
    const reverse = await copy(stranger.token, theirs.id, north.id);
    expect(reverse.statusCode).toBe(404);
    const same = await copy(owner.token, north.id, north.id);
    expect(same.statusCode).toBe(400);
    expect(same.json().error.code).toBe('SAME_STORE');
    expect((await liveMenu(target.id)).length).toBe(0);
  });

  it('a manager at both branches may copy; staff, or a manager at only the target, may not', async () => {
    const a = await store(owner.ownerId, 'Royal Bay');
    const b = await store(owner.ownerId, 'Royal Hill');
    const both = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const onlyTarget = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.createMany({ data: [
      { vendorId: north.id, userId: both.userId, role: 'MANAGER', invitedBy: owner.userId }, { vendorId: a.id, userId: both.userId, role: 'MANAGER', invitedBy: owner.userId },
      { vendorId: north.id, userId: onlyTarget.userId, role: 'STAFF', invitedBy: owner.userId }, { vendorId: b.id, userId: onlyTarget.userId, role: 'MANAGER', invitedBy: owner.userId },
      { vendorId: north.id, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId }, { vendorId: b.id, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId },
    ] });
    const staffRes = await copy(staff.token, b.id, north.id);
    expect(staffRes.statusCode).toBe(403);
    const halfRes = await copy(onlyTarget.token, b.id, north.id);
    expect(halfRes.statusCode).toBe(403);
    expect((await liveMenu(b.id)).length).toBe(0);
    const ok = await copy(both.token, a.id, north.id);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a manager of the target who does not work at the source branch: 404 (the source is not named to them)', async () => {
    const target = await store(owner.ownerId, 'Royal Dock');
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: target.id, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const res = await copy(manager.token, target.id, north.id);
    expect(res.statusCode).toBe(404);
    expect((await liveMenu(target.id)).length).toBe(0);
  });

  it('a manager at two different businesses never copies one business\'s menu into the other', async () => {
    const stranger = await makeOwner();
    const theirs = await store(stranger.ownerId, 'Other Grill');
    const both = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.createMany({ data: [
      { vendorId: north.id, userId: both.userId, role: 'MANAGER', invitedBy: owner.userId },
      { vendorId: theirs.id, userId: both.userId, role: 'MANAGER', invitedBy: stranger.userId },
    ] });
    const res = await copy(both.token, theirs.id, north.id);
    expect(res.statusCode).toBe(404);
    expect((await liveMenu(theirs.id)).length).toBe(0);
  });
});

describe('[CHAINS] GET /vendor/menu/export', () => {
  it('the live menu as CSV: template columns + options, exact prices, formula-safe text; staff refused', async () => {
    const res = await send('GET', owner.token, '/api/v1/vendor/menu/export', north.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.split('\n');
    expect(lines[0]).toBe('category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,options');
    expect(lines).toContain('Mains,Quarter chicken,"Fried, two pieces",1234.56,QC-1,,12,true,DELIVERY,"Side: Fries (+0.00), Mac and cheese (+99.99)"');
    expect(res.body).not.toContain('Old dish');
    expect(lines.some((l) => l.startsWith('Late night,"\'=HYPERLINK(""x"") wrap"'))).toBe(true);
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
    expect((await send('GET', staff.token, '/api/v1/vendor/menu/export', north.id)).statusCode).toBe(403);
  });
});

describe('[CHAINS] GET /vendor/stores — the switcher', () => {
  it('a branch waiting for Swift\'s approval says so', async () => {
    const waiting = await store(owner.ownerId, 'Royal New', 'PENDING_APPROVAL');
    const res = await send('GET', owner.token, '/api/v1/vendor/stores', north.id);
    const rows = res.json().data.stores as Array<{ id: string; awaitingApproval: boolean }>;
    expect(rows.find((s) => s.id === waiting.id)?.awaitingApproval).toBe(true);
    expect(rows.find((s) => s.id === north.id)?.awaitingApproval).toBe(false);
  });
});
