import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { bulkUnitsForChoice, bulkChoiceForUnits, BULK_CHOICES } from '../utils/load';

// ---------------------------------------------------------------------------
// [G2] "Surface it in the vendor item editor as a three-way choice (normal /
// bulky / very bulky), never as a raw integer — a shopkeeper should not be
// asked to think in units."
//
// So the integer never crosses the wire in EITHER direction. The API accepts a
// word and stores units; it returns the word beside the row. The mapping has
// one home (utils/load.ts), because a client that invented its own would make
// two shops' "bulky" mean two different loads to dispatch.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200648';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Bulk', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true,
      selfieCapturedAt: new Date(), avatar: '/uploads/avatars/bulk.jpg',
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'bulk-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Bulk Mart', slug: `bulk-mart-${nanoid(6)}`, vendorType: 'SUPERMARKET',
      phone: `${PHONE_PREFIX}99`, addressLine1: '1 Water Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Groceries', sortOrder: 0 } });
  return { vendorId: vendor.id, categoryId: category.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string, vendorId: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-vendor-id': vendorId },
  });
}

let owner: { userId: string; token: string };
let shop: { vendorId: string; categoryId: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vos.map((v) => v.id);
    await app.prisma.item.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.category.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: voIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: voIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  shop = await makeVendor(owner.userId);
});

afterAll(async () => {
  if (createdVendorIds.length) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('the mapping has one home and round-trips', () => {
  it('every word maps to units and back to itself', () => {
    for (const w of BULK_CHOICES) expect(bulkChoiceForUnits(bulkUnitsForChoice(w))).toBe(w);
  });

  it('normal is stored as NULL — exactly what every pre-existing row already is', () => {
    // If "normal" stored a 1, the migration's promise that NULL rows behave
    // unchanged would still hold, but two spellings of ordinary would exist.
    expect(bulkUnitsForChoice('normal')).toBeNull();
  });

  it('a very bulky item is the spec’s 20 kg rice bag, at 8', () => {
    expect(bulkUnitsForChoice('very_bulky')).toBe(8);
  });

  it('a hand-edited value rounds to a word rather than breaking a menu', () => {
    expect(bulkChoiceForUnits(3)).toBe('bulky');
    expect(bulkChoiceForUnits(50)).toBe('very_bulky');
    expect(bulkChoiceForUnits(0)).toBe('normal');
    expect(bulkChoiceForUnits(-4)).toBe('normal');
  });
});

describe('the shopkeeper sends a word and reads a word', () => {
  let itemId: string;

  it('creating a very bulky item stores the units and answers with the word', async () => {
    const res = await inject('POST', '/api/v1/vendor/items', {
      categoryId: shop.categoryId, name: 'Rice 20kg', basePrice: 6500, bulk: 'very_bulky',
    }, owner.token, shop.vendorId);
    expect(res.statusCode, res.body).toBe(200);
    const item = res.json().data;
    expect(item.bulkUnits, 'the integer never crosses the wire').toBeUndefined();
    itemId = item.id;
    expect(item.bulk).toBe('very_bulky');
    const row = await app.prisma.item.findUnique({ where: { id: itemId }, select: { bulkUnits: true } });
    expect(row?.bulkUnits).toBe(8);
  });

  it('the menu read carries the word on every item', async () => {
    const res = await inject('GET', '/api/v1/vendor/items', undefined, owner.token, shop.vendorId);
    expect(res.statusCode).toBe(200);
    const mine = res.json().data.find((i: any) => i.id === itemId);
    expect(mine.bulk).toBe('very_bulky');
    expect(mine.bulkUnits).toBeUndefined();
  });

  it('changing it back to normal clears the units to NULL', async () => {
    const res = await inject('PUT', `/api/v1/vendor/items/${itemId}`, { bulk: 'normal' }, owner.token, shop.vendorId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.bulk).toBe('normal');
    const row = await app.prisma.item.findUnique({ where: { id: itemId }, select: { bulkUnits: true } });
    expect(row?.bulkUnits).toBeNull();
  });

  it('an item saved without the field is normal, and an update that omits it leaves it alone', async () => {
    const create = await inject('POST', '/api/v1/vendor/items', {
      categoryId: shop.categoryId, name: 'Seasoning sachet', basePrice: 120,
    }, owner.token, shop.vendorId);
    expect(create.statusCode).toBe(200);
    expect(create.json().data.bulk).toBe('normal');

    await inject('PUT', `/api/v1/vendor/items/${itemId}`, { bulk: 'bulky' }, owner.token, shop.vendorId);
    const rename = await inject('PUT', `/api/v1/vendor/items/${itemId}`, { name: 'Rice 20 kg' }, owner.token, shop.vendorId);
    expect(rename.json().data.bulk, 'a rename must not reset the load hint').toBe('bulky');
  });

  it('a raw integer on the wire is refused as a word and ignored as a number', async () => {
    // Neither a made-up word nor the integer itself is a way in.
    const word = await inject('PUT', `/api/v1/vendor/items/${itemId}`, { bulk: 'enormous' }, owner.token, shop.vendorId);
    expect(word.statusCode).toBe(400);
    const num = await inject('PUT', `/api/v1/vendor/items/${itemId}`, { bulkUnits: 99 }, owner.token, shop.vendorId);
    expect(num.statusCode).toBe(200);
    const row = await app.prisma.item.findUnique({ where: { id: itemId }, select: { bulkUnits: true } });
    expect(row?.bulkUnits, 'bulkUnits is not a client-writable field').toBe(4);
  });
});
