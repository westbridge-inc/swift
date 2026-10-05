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
// [E01-B] Removing the applied promo from the cart. The quote discounts with
// the cart's STORED promo (cart.promoCodeId) while checkout discounts only for
// the `promoCode` the request body carries, so a phone customer could see the
// discounted total and be charged full price — with no way back. DELETE
// /customer/cart/promo clears the stored pointer: the quote re-prices without
// the code and the checkout body no longer carries one.
//
// DB-backed; the Claude engineer runs this against the real local test
// database (see DRAFT-NOTES.md).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Phone prefix verified unused across the repo (+59202077).
const PHONE_PREFIX = '+59202077';
const CODE = `CARTREM${nanoid(4).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Promo',
      lastName: `Remover${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/remove-promo.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP',
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'remove-promo-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, phone: user.phone };
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

let owner: { userId: string; token: string };
let customerA: { userId: string; token: string };
let customerB: { userId: string; token: string };
let shop: { vendorId: string; categoryId: string };
let item: { id: string };
let promoId: string;

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
  customerA = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customerB = await makeUser(['CUSTOMER'], 'CUSTOMER');

  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: 'Remove Promo Grill',
      slug: `remove-promo-grill-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}99`,
      addressLine1: '7 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  shop = { vendorId: vendor.id, categoryId: category.id };
  item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Removable Bowl', basePrice: 2000 } });

  const promo = await app.prisma.promoCode.create({
    data: {
      code: CODE,
      description: '500 off the basket',
      discountType: 'FIXED_AMOUNT',
      discountValue: 500,
      applicableTo: [],
      validFrom: new Date(Date.now() - DAY),
      validUntil: new Date(Date.now() + DAY),
      maxUsesPerUser: 5,
    },
  });
  promoId = promo.id;
});

afterAll(async () => {
  await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  if (promoId) await app.prisma.promoCode.deleteMany({ where: { id: promoId } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('DELETE /customer/cart/promo (E01-B)', () => {
  it('clears the stored promo: the quote re-prices undiscounted and the charge is the code-free total', async () => {
    const added = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: item.id, quantity: 1 }, customerA.token);
    // A first add creates the line and answers 201; a later merge of the same
    // line answers 200 (customer.routes.ts: `reply.code(existing ? 200 : 201)`).
    expect([200, 201]).toContain(added.statusCode);

    const applied = await inject('POST', '/api/v1/customer/promo/validate', { code: CODE }, customerA.token);
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data.applied).toBe(true);

    const quoted = await inject('GET', '/api/v1/customer/cart', undefined, customerA.token);
    expect(quoted.statusCode).toBe(200);
    expect(quoted.json().data.promoCode.code).toBe(CODE);
    expect(quoted.json().data.discount).toBeGreaterThan(0);

    const removed = await inject('DELETE', '/api/v1/customer/cart/promo', undefined, customerA.token);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.message).toBe('Promo removed');
    expect(removed.json().data.cart.promoCode).toBeNull();
    expect(removed.json().data.cart.discount).toBe(0);

    // Durable DB state, not just the response: the stored pointer is gone and
    // the lines are untouched.
    const row = await app.prisma.cart.findUnique({ where: { customerId: customerA.userId } });
    expect(row?.promoCodeId).toBeNull();
    expect(await app.prisma.cartItem.count({ where: { cartId: row!.id } })).toBe(1);

    // The charge is the code-free total: checkout WITHOUT promoCode prices the
    // same basket undiscounted, and the order records no promo.
    const checkout = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } }, customerA.token);
    expect(checkout.statusCode).toBe(200);
    const order = checkout.json().data.orders[0];
    expect(order.discount).toBe(0);
    const orderRow = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderRow.promoCodeId).toBeNull();
  });

  it("is the caller's own cart: another customer cannot clear it, and a cartless caller gets the existing NO_CART", async () => {
    // A re-applies the promo for this case.
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: item.id, quantity: 1 }, customerA.token);
    const applied = await inject('POST', '/api/v1/customer/promo/validate', { code: CODE }, customerA.token);
    expect(applied.statusCode).toBe(200);

    // B has no cart: the same refusal the other cart writes use.
    const refused = await inject('DELETE', '/api/v1/customer/cart/promo', undefined, customerB.token);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('NO_CART');

    // B's call never touched A's promo.
    const row = await app.prisma.cart.findUnique({ where: { customerId: customerA.userId } });
    expect(row?.promoCodeId).toBe(promoId);

    // Leave A's cart clean for teardown.
    await inject('DELETE', '/api/v1/customer/cart/promo', undefined, customerA.token);
  });
});
