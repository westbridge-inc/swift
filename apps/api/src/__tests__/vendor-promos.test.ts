import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Operator promotions (master plan §4.2). Failure paths first: a vendor's code
// is refused on another store's cart, discounts ONLY that vendor's order in a
// multi-vendor checkout, respects staff/manager gates, and platform-wide
// (admin) codes keep their old behavior.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const CODE = `TEAM${nanoid(4).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200318${String(seq).padStart(2, '0')}`,
      firstName: 'Promo',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/promo.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'promo-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, phone: user.phone };
}

async function makeVendor(ownerUserId: string, name: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: `+59200319${String(seq).padStart(2, '0')}`,
      addressLine1: '5 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  return { vendorId: vendor.id, categoryId: category.id };
}

async function makeItem(vendorId: string, categoryId: string, name: string, price: number) {
  return app.prisma.item.create({ data: { vendorId, categoryId, name, basePrice: price } });
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, token?: string, vendorId?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

let owner: { userId: string; token: string };
let customer: { userId: string; token: string };
let shopA: { vendorId: string; categoryId: string };
let shopB: { vendorId: string; categoryId: string };
let itemA: { id: string };
let itemB: { id: string };

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: {
      userId: customer.userId, label: 'Home', addressLine1: '1 Deal Close',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true,
    },
  });

  shopA = await makeVendor(owner.userId, 'Deal Diner');
  const ownerB = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  shopB = await makeVendor(ownerB.userId, 'Other Grill');
  itemA = await makeItem(shopA.vendorId, shopA.categoryId, 'Deal Bowl', 2000);
  itemB = await makeItem(shopB.vendorId, shopB.categoryId, 'Other Wrap', 3000);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Vendor promo CRUD', () => {
  it('creates a 20% code; over-100% and duplicate codes are refused', async () => {
    const until = new Date(Date.now() + 7 * DAY).toISOString();

    const bad = await inject('POST', '/api/v1/vendor/promos', {
      code: 'WAYTOOMUCH', description: 'nope', discountType: 'PERCENTAGE', discountValue: 150, validUntil: until,
    }, owner.token);
    expect(bad.statusCode).toBe(400);

    const res = await inject('POST', '/api/v1/vendor/promos', {
      code: CODE, description: '20% off this week', discountType: 'PERCENTAGE', discountValue: 20, validUntil: until,
    }, owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.vendorId).toBe(shopA.vendorId);

    const dupe = await inject('POST', '/api/v1/vendor/promos', {
      code: CODE, description: 'again', discountType: 'PERCENTAGE', discountValue: 10, validUntil: until,
    }, owner.token);
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('CODE_TAKEN');
  });

  it('shows live codes on the public storefront', async () => {
    const res = await inject('GET', `/api/v1/customer/vendors/${shopA.vendorId}`, undefined, customer.token);
    expect(res.statusCode).toBe(200);
    const promos = res.json().data.promos;
    expect(promos.some((p: any) => p.code === CODE)).toBe(true);
  });
});

describe('Checkout scoping', () => {
  async function cartUp(items: Array<{ vendorId: string; itemId: string }>) {
    for (const it of items) {
      const res = await inject('POST', '/api/v1/customer/cart/items', { vendorId: it.vendorId, itemId: it.itemId, quantity: 1 }, customer.token);
      expect([200, 201]).toContain(res.statusCode);
    }
  }

  it("a vendor's code is refused on a cart without their items", async () => {
    await cartUp([{ vendorId: shopB.vendorId, itemId: itemB.id }]);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: CODE }, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PROMO_WRONG_VENDOR');
    // clear the cart for the next test
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: customer.userId } } });
    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });

  it('multi-vendor checkout: the discount lands on the promo vendor’s order only', async () => {
    await cartUp([
      { vendorId: shopB.vendorId, itemId: itemB.id },
      { vendorId: shopA.vendorId, itemId: itemA.id },
    ]);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: CODE }, customer.token);
    expect(res.statusCode).toBe(200);
    const orders = res.json().data.orders as Array<{ subtotal: number; discount: number }>;
    expect(orders).toHaveLength(2);

    const discounted = orders.find((o) => o.discount > 0)!;
    const other = orders.find((o) => o.discount === 0)!;
    expect(discounted.subtotal).toBe(2000); // Deal Diner's order
    expect(discounted.discount).toBe(400);  // 20% of 2000 — NOT of the 5000 basket
    expect(other.subtotal).toBe(3000);
  });

  it('pausing the code kills it at checkout', async () => {
    const list = await inject('GET', '/api/v1/vendor/promos', undefined, owner.token);
    const promo = list.json().data.find((p: any) => p.code === CODE);
    const paused = await inject('PUT', `/api/v1/vendor/promos/${promo.id}`, { isActive: false }, owner.token);
    expect(paused.statusCode).toBe(200);

    await cartUp([{ vendorId: shopA.vendorId, itemId: itemA.id }]);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: CODE }, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PROMO');
  });

  it('platform-wide (admin) codes still discount the whole basket', async () => {
    await app.prisma.promoCode.create({
      data: {
        code: `PLAT${nanoid(4).replace(/[^A-Za-z0-9]/g, 'Y').toUpperCase()}`,
        description: 'platform code',
        discountType: 'FIXED_AMOUNT',
        discountValue: 500,
        applicableTo: [],
        validFrom: new Date(Date.now() - DAY),
        validUntil: new Date(Date.now() + DAY),
        maxUsesPerUser: 5,
      },
    }).then(async (platform) => {
      // cart already holds Deal Bowl from the previous test
      const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: platform.code }, customer.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.orders[0].discount).toBe(500);
      await app.prisma.order.updateMany({ where: { promoCodeId: platform.id }, data: { promoCodeId: null } });
      await app.prisma.promoCode.delete({ where: { id: platform.id } });
    });
  });

  it('a STAFF member cannot manage promotions', async () => {
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({
      data: { vendorId: shopA.vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId },
    });
    const res = await inject('GET', '/api/v1/vendor/promos', undefined, staff.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_FORBIDDEN');
  });
});
