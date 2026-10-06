import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Row 77. The public storefront (GET /customer/vendors/:id) is a guest read.
// Categories, items, options, images and hours ship an explicit allowlist:
// no tenant ids, owner ids, exact stock counts or thresholds, SKUs, barcodes,
// the internal load integer or audit timestamps. (Per-item `totalOrdered`
// stays: the app build under store review sorts its best-seller row by it.)
// ---------------------------------------------------------------------------

const CATEGORY_KEYS = ['description', 'id', 'imageUrl', 'items', 'name', 'sortOrder'];
const ITEM_KEYS = [
  'allergens', 'basePrice', 'bookingConfig', 'customerPrice', 'description', 'dietaryTags', 'fulfillment',
  'id', 'imageUrl', 'isAvailable', 'isPopular', 'name', 'optionGroups', 'sortOrder', 'stockQuantity', 'totalOrdered', 'unit',
];
const OPTION_GROUP_KEYS = ['id', 'isRequired', 'maxSelect', 'minSelect', 'name', 'options', 'sortOrder'];
const OPTION_KEYS = ['additionalPrice', 'id', 'isAvailable', 'isDefault', 'name', 'sortOrder'];
const IMAGE_KEYS = ['caption', 'id', 'sortOrder', 'url'];
const HOURS_KEYS = ['closeTime', 'dayOfWeek', 'id', 'isClosed', 'openTime'];

let app: FastifyInstance;
let userId: string;
let vendorOwnerId: string;
let vendorId: string;
let tenantId: string;
let countedItemId: string;
let soldOutItemId: string;
let hiddenCategoryId: string;
let hiddenItemId: string;

const SKU = `SKU-${nanoid(8)}`;
const BARCODE = `BC${nanoid(10)}`;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const rnd = 592_717_000_000 + Math.floor(Math.random() * 200_000_000);
  const user = await app.prisma.user.create({
    data: { phone: `+${rnd}`, firstName: 'Shelf', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userId = user.id;
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  vendorOwnerId = owner.id;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Shelf Store ${nanoid(6)}`, slug: `shelf-${nanoid(8).toLowerCase()}`, vendorType: 'STORE',
      phone: `+${rnd + 1}`, addressLine1: '1 Shelf St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  tenantId = vendor.tenantId;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Shelf', sortOrder: 0 } });
  const counted = await app.prisma.item.create({
    data: {
      vendorId, categoryId: cat.id, name: 'Counted Rice', basePrice: 1200, isAvailable: true,
      sku: SKU, barcode: BARCODE, unit: 'bag', bulkUnits: 7, stockQuantity: 37, lowStockThreshold: 5, totalOrdered: 912,
      substitutionGroup: 'rice-internal', dietaryTags: ['vegan'], allergens: [],
    },
  });
  countedItemId = counted.id;
  const soldOut = await app.prisma.item.create({
    data: { vendorId, categoryId: cat.id, name: 'Sold Out Flour', basePrice: 900, isAvailable: true, stockQuantity: 0 },
  });
  soldOutItemId = soldOut.id;
  const group = await app.prisma.optionGroup.create({ data: { itemId: counted.id, name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1 } });
  await app.prisma.option.create({ data: { optionGroupId: group.id, name: 'Large', additionalPrice: 200, isDefault: false } });
  await app.prisma.vendorImage.create({ data: { vendorId, url: 'https://example.invalid/shelf.jpg', caption: 'Front' } });
  await app.prisma.operatingHours.create({ data: { vendorId, dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' } });
  const hiddenCat = await app.prisma.category.create({ data: { vendorId, name: 'Switched Off Shelf', sortOrder: 1, isActive: false } });
  hiddenCategoryId = hiddenCat.id;
  hiddenItemId = (await app.prisma.item.create({
    data: { vendorId, categoryId: hiddenCat.id, name: 'Hidden Shelf Item', basePrice: 500, isAvailable: true },
  })).id;
});

afterAll(async () => {
  await app.prisma.option.deleteMany({ where: { optionGroup: { item: { vendorId } } } });
  await app.prisma.optionGroup.deleteMany({ where: { item: { vendorId } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendorImage.deleteMany({ where: { vendorId } });
  await app.prisma.operatingHours.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.delete({ where: { id: vendorId } });
  await app.prisma.vendorOwner.delete({ where: { id: vendorOwnerId } });
  await app.prisma.user.delete({ where: { id: userId } });
  await app.close();
});

const sorted = (o: object) => Object.keys(o).sort();

describe('[row 77] guest storefront projection', () => {
  it('ships exactly the allowlisted keys for category, item, option group, option, image and hours', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      categories: Array<Record<string, unknown> & { items: Array<Record<string, unknown> & { optionGroups: Array<Record<string, unknown> & { options: object[] }> }> }>;
      images: object[];
      operatingHours: object[];
    };

    expect(data.categories.length).toBe(1);
    for (const cat of data.categories) {
      expect(sorted(cat)).toEqual(CATEGORY_KEYS);
      expect(cat.items.length).toBe(2);
      for (const item of cat.items) {
        expect(sorted(item)).toEqual(ITEM_KEYS);
        for (const group of item.optionGroups) {
          expect(sorted(group)).toEqual(OPTION_GROUP_KEYS);
          for (const option of group.options) expect(sorted(option)).toEqual(OPTION_KEYS);
        }
      }
    }
    expect(data.images.length).toBe(1);
    for (const img of data.images) expect(sorted(img)).toEqual(IMAGE_KEYS);
    expect(data.operatingHours.length).toBe(1);
    for (const h of data.operatingHours) expect(sorted(h)).toEqual(HOURS_KEYS);
  });

  it('carries no internal value anywhere in the payload, and stock only as sold-out or not', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
    const text = res.body;
    for (const secret of [tenantId, SKU, BARCODE, 'rice-internal', vendorOwnerId, userId]) {
      expect(text, secret).not.toContain(secret);
    }
    for (const key of ['tenantId', 'vendorId', 'categoryId', 'sku', 'barcode', 'bulkUnits', 'lowStockThreshold', 'autoHiddenAt', 'substitutionGroup', 'createdAt', 'updatedAt', 'optionGroupId', 'itemId']) {
      expect(text, key).not.toContain(`"${key}"`);
    }

    const items = (res.json().data.categories as Array<{ items: Array<{ id: string; stockQuantity: number | null; basePrice: number; customerPrice: number }> }>)[0]!.items;
    const counted = items.find((i) => i.id === countedItemId)!;
    const soldOut = items.find((i) => i.id === soldOutItemId)!;
    expect(counted.stockQuantity).toBeNull(); // 37 in the row: the count is the store's business
    expect(soldOut.stockQuantity).toBe(0);
    expect(counted.basePrice).toBe(1200);
    expect(counted.customerPrice).toBe(1200);
  });

  it('a category the store switched off, and its items, are not on the public page', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(hiddenCategoryId);
    expect(res.body).not.toContain(hiddenItemId);
    expect(res.body).not.toContain('Switched Off Shelf');
  });
});
