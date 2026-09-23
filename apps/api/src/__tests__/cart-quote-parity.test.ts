import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [E01 · E09] Multi-vendor cart quote ↔ per-vendor checkout parity.
//
// A multi-vendor cart becomes one order per vendor at checkout: each vendor's
// lines are priced against ITS OWN distance (its own delivery fee), ITS OWN
// minimum, and the tip/discount rules of the whole basket. The cart quote used
// to price the basket as one vendor's order — one fee from `cart.vendor`, one
// minimum, a tip that never disappeared for pickup — so the screen and the
// charge disagreed silently. The quote and the charge now share one planner
// (cart-plans.ts); these tests pin the numbers end to end.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200670';
// Vendor A is near the address, vendor B farther — under the default schedule
// the two fees differ, which is the whole point: fee(B) > fee(A).
const VENDOR_A = { lat: 6.8015, lng: -58.1560 };
const VENDOR_B = { lat: 6.8300, lng: -58.1550 };
const DROP = { lat: 6.8100, lng: -58.1700 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Parity', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/parity.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'parity', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeShop(ownerUserId: string, name: string, minOrderAmount: number, at: { lat: number; lng: number }) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `parity-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}98`, addressLine1: '9 Water Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: at.lat, longitude: at.lng, deliveryRadius: 25,
      minOrderAmount,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  return { vendorId: vendor.id, categoryId: category.id };
}

async function makeItem(vendorId: string, categoryId: string, name: string, basePrice: number) {
  return app.prisma.item.create({ data: { vendorId, categoryId, name, basePrice } });
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

let ownerA: { userId: string };
let ownerB: { userId: string };
let shopA: Awaited<ReturnType<typeof makeShop>>;
let shopB: Awaited<ReturnType<typeof makeShop>>;
let itemA1: { id: string };
let itemA2: { id: string };
let itemB1: { id: string };

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vos.map((v) => v.id);
    await app.prisma.item.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.category.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: voIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: voIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  ownerA = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  ownerB = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  // A's minimum is its item's price so A MEETS while B is short — the
  // per-vendor discrimination the spec wants to demonstrate. (The spec's
  // fixture asserted A meets with a 2,000 minimum on a 1,200 item, which no
  // correct implementation can produce; see DRAFT-NOTES.md.)
  shopA = await makeShop(ownerA.userId, 'Parity Near', 1200, VENDOR_A);
  shopB = await makeShop(ownerB.userId, 'Parity Far', 5000, VENDOR_B);
  itemA1 = await makeItem(shopA.vendorId, shopA.categoryId, 'Near Bowl', 1200);
  itemA2 = await makeItem(shopA.vendorId, shopA.categoryId, 'Near Side', 1200);
  itemB1 = await makeItem(shopB.vendorId, shopB.categoryId, 'Far Wrap', 3000);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdVendorIds.length) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

/** A fresh shopper with a default address at DROP, and both vendors' items in
 *  the cart — B added last so `cart.vendorId` tracks the far vendor (the exact
 *  trap the old single-vendor quote fell into). */
async function shopper() {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: {
      userId: customer.userId, label: 'Home', addressLine1: '3 Camp Street',
      city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: DROP.lat, longitude: DROP.lng, isDefault: true,
    },
  });
  const addA = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shopA.vendorId, itemId: itemA1.id, quantity: 1 }, customer.token);
  expect([200, 201], addA.body).toContain(addA.statusCode);
  const addB = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shopB.vendorId, itemId: itemB1.id, quantity: 1 }, customer.token);
  expect([200, 201], addB.body).toContain(addB.statusCode);
  return customer;
}

const cartUrl = (selections: Record<string, 'DELIVERY' | 'PICKUP'>, extra = '') =>
  `/api/v1/customer/cart?fulfillment=${Object.entries(selections).map(([k, v]) => `${k}=${v}`).join(',')}${extra}`;

describe('E01 — the quote and the per-vendor charge agree', () => {
  it('T1 — both delivered: the quoted fee and total are the per-vendor sums', async () => {
    const customer = await shopper();

    const bothDelivery = cartUrl({ [shopA.vendorId]: 'DELIVERY', [shopB.vendorId]: 'DELIVERY' });
    const quote = await inject('GET', bothDelivery, undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;

    // Per-vendor rows (absent today — the response had no `vendors`).
    expect(q.vendors).toHaveLength(2);
    expect(q.vendors.map((v: { vendorId: string }) => v.vendorId).sort()).toEqual([shopA.vendorId, shopB.vendorId].sort());
    const qA = q.vendors.find((v: { vendorId: string }) => v.vendorId === shopA.vendorId);
    const qB = q.vendors.find((v: { vendorId: string }) => v.vendorId === shopB.vendorId);
    // Different distances → different fees: this is the fixture's premise.
    expect(Number(qB.deliveryFee)).toBeGreaterThan(Number(qA.deliveryFee));
    expect(Number(q.subtotalCustomer)).toBe(4200);

    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      fulfillmentSelections: { [shopA.vendorId]: 'DELIVERY', [shopB.vendorId]: 'DELIVERY' },
    }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const orders = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    expect(orders).toHaveLength(2);

    const oA = await app.prisma.order.findUniqueOrThrow({ where: { id: orders.find((o: { vendorId: string }) => o.vendorId === shopA.vendorId).id } });
    const oB = await app.prisma.order.findUniqueOrThrow({ where: { id: orders.find((o: { vendorId: string }) => o.vendorId === shopB.vendorId).id } });

    // Durable state, not just status codes: each row is internally coherent…
    for (const o of [oA, oB]) {
      expect(Number(o.totalAmount), `${o.vendorId} internal total`).toBe(
        Number(o.subtotalCustomer) + Number(o.deliveryFee) + Number(o.tipAmount) - Number(o.discount),
      );
    }
    // …and the quoted fee/total equal the charged per-vendor sums. Today the
    // quote priced only cart.vendor (B), so deliveryFee was fee(B) and
    // totalAmount omitted fee(A).
    expect(Number(q.deliveryFee), 'quote fee = per-vendor fee sum').toBe(Number(oA.deliveryFee) + Number(oB.deliveryFee));
    expect(Number(qA.deliveryFee)).toBe(Number(oA.deliveryFee));
    expect(Number(qB.deliveryFee)).toBe(Number(oB.deliveryFee));
    expect(Number(q.totalAmount), 'quote total = charged grand total').toBe(Number(oA.totalAmount) + Number(oB.totalAmount));
  });

  it('T2 — mixed: pickup is quoted per vendor, not as a whole-basket fee subtraction', async () => {
    const customer = await shopper();

    const mixed = cartUrl({ [shopA.vendorId]: 'PICKUP', [shopB.vendorId]: 'DELIVERY' });
    const quote = await inject('GET', mixed, undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;
    const qA = q.vendors.find((v: { vendorId: string }) => v.vendorId === shopA.vendorId);
    const qB = q.vendors.find((v: { vendorId: string }) => v.vendorId === shopB.vendorId);
    expect(Number(qA.deliveryFee)).toBe(0);
    expect(qA.fulfillment).toBe('PICKUP');
    expect(qB.fulfillment).toBe('DELIVERY');

    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      fulfillmentSelections: { [shopA.vendorId]: 'PICKUP', [shopB.vendorId]: 'DELIVERY' },
    }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const orders = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const oA = await app.prisma.order.findUniqueOrThrow({ where: { id: orders.find((o: { vendorId: string }) => o.vendorId === shopA.vendorId).id } });
    const oB = await app.prisma.order.findUniqueOrThrow({ where: { id: orders.find((o: { vendorId: string }) => o.vendorId === shopB.vendorId).id } });
    expect(oA.fulfillment).toBe('PICKUP');
    expect(Number(oA.deliveryFee)).toBe(0);
    // Today GET ignores the query entirely: q.deliveryFee was fee(A)+fee(B)
    // and the pickup plan didn't exist.
    expect(Number(q.deliveryFee)).toBe(Number(oB.deliveryFee));
    expect(Number(qB.deliveryFee)).toBe(Number(oB.deliveryFee));
    expect(Number(q.totalAmount)).toBe(Number(oA.totalAmount) + Number(oB.totalAmount));
  });

  it('T5 — express: the express quote equals the express charge, per vendor', async () => {
    const customer = await shopper();

    const expressUrl = cartUrl({ [shopA.vendorId]: 'DELIVERY', [shopB.vendorId]: 'DELIVERY' }, '&express=true');
    const quote = await inject('GET', expressUrl, undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;
    // When the quote itself is express, expressTotal IS the quoted total.
    expect(Number(q.expressTotal)).toBe(Number(q.totalAmount));

    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      express: true,
      fulfillmentSelections: { [shopA.vendorId]: 'DELIVERY', [shopB.vendorId]: 'DELIVERY' },
    }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const orders = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const oA = await app.prisma.order.findUniqueOrThrow({ where: { id: orders.find((o: { vendorId: string }) => o.vendorId === shopA.vendorId).id } });
    const oB = await app.prisma.order.findUniqueOrThrow({ where: { id: orders.find((o: { vendorId: string }) => o.vendorId === shopB.vendorId).id } });
    expect(oA.isExpress).toBe(true);
    expect(oB.isExpress).toBe(true);
    // Today GET ignores the express query (and the preview is computed from a
    // single fee): the express quote could not equal the express charge.
    expect(Number(q.deliveryFee), 'express quote fee = per-vendor express fee sum').toBe(Number(oA.deliveryFee) + Number(oB.deliveryFee));
    expect(Number(q.totalAmount), 'express quote total = express charged total').toBe(Number(oA.totalAmount) + Number(oB.totalAmount));
  });
});

describe('E09 — a second vendor below its minimum is quoted early and refuses', () => {
  it('T3 — per-vendor minimums: B is short, the whole checkout refuses, nothing is written', async () => {
    const customer = await shopper(); // A1=1200 (min 1200 ✓), B1=3000 (min 5000 ✗)

    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;
    // Today `vendors` is undefined, so this is red before anything else.
    const qA = q.vendors.find((v: { vendorId: string }) => v.vendorId === shopA.vendorId);
    const qB = q.vendors.find((v: { vendorId: string }) => v.vendorId === shopB.vendorId);
    expect(qA.meetsMinimum).toBe(true);
    expect(qB.meetsMinimum).toBe(false);
    expect(qB.minOrderAmount).toBe(5000);
    expect(qB.subtotal).toBe(3000);
    // The legacy conjunction is the honest whole-basket verdict (today it is
    // the combined 4200 judged against cart.vendor=B's 5000 — a coincidence
    // of add order).
    expect(q.meetsMinimum).toBe(false);

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('MIN_ORDER');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('T3b — the verdict is add-order independent, and stays false while B alone is short', async () => {
    // Reverse order: B first, then A → cart.vendorId tracks the NEAR vendor.
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({
      data: {
        userId: customer.userId, label: 'Home', addressLine1: '3 Camp Street',
        city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: DROP.lat, longitude: DROP.lng, isDefault: true,
      },
    });
    const addB = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shopB.vendorId, itemId: itemB1.id, quantity: 1 }, customer.token);
    expect([200, 201], addB.body).toContain(addB.statusCode);
    const addA = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shopA.vendorId, itemId: itemA1.id, quantity: 1 }, customer.token);
    expect([200, 201], addA.body).toContain(addA.statusCode);

    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    const q = quote.json().data;
    expect(q.meetsMinimum).toBe(false);
    expect(q.vendors.find((v: { vendorId: string }) => v.vendorId === shopB.vendorId).meetsMinimum).toBe(false);
    expect(q.vendors.find((v: { vendorId: string }) => v.vendorId === shopA.vendorId).meetsMinimum).toBe(true);

    // Combined subtotal now exceeds B's minimum — today's combined check flips
    // to true even though B alone (3000 < 5000) would still be refused.
    const addA2 = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shopA.vendorId, itemId: itemA2.id, quantity: 1 }, customer.token);
    expect([200, 201], addA2.body).toContain(addA2.statusCode);
    const quote2 = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    const q2 = quote2.json().data;
    expect(q2.subtotalCustomer).toBe(5400);
    expect(q2.meetsMinimum).toBe(false);
    expect(q2.vendors.find((v: { vendorId: string }) => v.vendorId === shopB.vendorId).meetsMinimum).toBe(false);
    expect(q2.vendors.find((v: { vendorId: string }) => v.vendorId === shopA.vendorId).meetsMinimum).toBe(true);

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('MIN_ORDER');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('T4 — an all-pickup basket never charges (or quotes) the rider tip', async () => {
    const customer = await shopper();
    const tipRes = await inject('PUT', '/api/v1/customer/cart/tip', { amount: 200 }, customer.token);
    expect(tipRes.statusCode).toBe(200);

    const allPickup = cartUrl({ [shopA.vendorId]: 'PICKUP', [shopB.vendorId]: 'PICKUP' });
    const quote = await inject('GET', allPickup, undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;
    expect(Number(q.tipAmount)).toBe(200); // the stored cart tip, for the chips
    // …but the tip is not inside the pickup total: subtotal − discount only.
    expect(Number(q.totalAmount)).toBe(Number(q.subtotalCustomer) - Number(q.discount));
    expect(Number(q.totalAmount)).toBe(4200);

    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      tipAmount: 200,
      fulfillmentSelections: { [shopA.vendorId]: 'PICKUP', [shopB.vendorId]: 'PICKUP' },
    }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const orders = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    for (const order of orders) {
      const o = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(o.tipAmount)).toBe(0);
    }
    const sum = await app.prisma.order.findMany({
      where: { customerId: customer.userId },
      select: { totalAmount: true },
    });
    expect(sum.reduce((s, o) => s + Number(o.totalAmount), 0), 'all-pickup grand total').toBe(Number(q.totalAmount));
  });
});
