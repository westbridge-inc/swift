import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, OrderStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { isKitchenAtCapacity, KITCHEN_ACTIVE_STATUSES } from '../modules/fulfillment/kitchen-capacity';

// ---------------------------------------------------------------------------
// FUL-007: vendor kitchen-capacity guard (Part 5D — protect the kitchen).
// A vendor can cap how many orders it holds at once; the server refuses new
// orders past that cap. Failure path first: a full kitchen turns a customer
// away with a clear error rather than silently drowning the vendor. Null cap
// (every vendor's default) means unlimited intake — behavior is unchanged.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];
let vendorId = '';
let categoryId = '';
let itemId = '';

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200711${String(seq).padStart(2, '0')}`,
      firstName: 'Cap', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true,
      selfieCapturedAt: new Date(), avatar: '/uploads/avatars/cap.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'cap-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeCustomer() {
  const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: { userId: u.userId, label: 'Home', addressLine1: '1 Capacity Rd', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true },
  });
  return u;
}

function inject(method: 'POST', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}
const addToCart = (token: string, qty: number) => inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: qty }, token);
const checkout = (token: string) => inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, token);

async function setCap(cap: number | null) {
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { maxConcurrentOrders: cap } });
}

// A live order sitting in the kitchen, tied to this vendor, in a given state.
async function seedOrder(status: OrderStatus) {
  const c = await makeCustomer();
  await app.prisma.order.create({
    data: {
      orderNumber: `CAP-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId: c.userId, vendorId, status,
      deliveryAddress: '1 Capacity Rd', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH',
    },
  });
}

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

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Capacity Diner ${nanoid(4)}`, slug: `capacity-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920071900', addressLine1: '2 Kitchen St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  categoryId = cat.id;
  const item = await app.prisma.item.create({ data: { vendorId, categoryId, name: 'Roti', basePrice: 1000 } });
  itemId = item.id;
});

afterEach(async () => {
  await setCap(null);
  // Each test controls the kitchen's live load — clear orders between tests so
  // seeded/checked-out orders from one case don't count against the next.
  await app.prisma.order.deleteMany({ where: { vendorId } });
});

afterAll(async () => {
  await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('isKitchenAtCapacity (pure)', () => {
  it('a null/undefined cap is never at capacity (unlimited intake)', () => {
    expect(isKitchenAtCapacity(0, null)).toBe(false);
    expect(isKitchenAtCapacity(999, null)).toBe(false);
    expect(isKitchenAtCapacity(5, undefined)).toBe(false);
  });
  it('at or over the cap is full; under is open', () => {
    expect(isKitchenAtCapacity(3, 3)).toBe(true);
    expect(isKitchenAtCapacity(4, 3)).toBe(true);
    expect(isKitchenAtCapacity(2, 3)).toBe(false);
  });
  it('the kitchen-active set is the still-in-kitchen states only (not picked-up onward)', () => {
    expect(KITCHEN_ACTIVE_STATUSES).toEqual(['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
    expect(KITCHEN_ACTIVE_STATUSES).not.toContain('PICKED_UP');
    expect(KITCHEN_ACTIVE_STATUSES).not.toContain('DELIVERED');
  });
});

describe('checkout capacity gate (FUL-007)', () => {
  it('refuses a new order when the kitchen is already at its cap', async () => {
    await setCap(1);
    await seedOrder('PREPARING'); // one order already in the kitchen — at cap
    const customer = await makeCustomer();
    expect((await addToCart(customer.token, 1)).statusCode).toBeLessThan(300);

    const res = await checkout(customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_AT_CAPACITY');
  });

  it('a null cap is unlimited — a busy kitchen still accepts', async () => {
    await setCap(null);
    await seedOrder('PREPARING');
    await seedOrder('ACCEPTED');
    const customer = await makeCustomer();
    expect((await addToCart(customer.token, 1)).statusCode).toBeLessThan(300);

    const res = await checkout(customer.token);
    expect(res.statusCode).toBe(200);
  });

  it('only still-in-kitchen orders count — a picked-up order frees a slot', async () => {
    await setCap(1);
    await seedOrder('PICKED_UP'); // off the kitchen's hands — should NOT count
    const customer = await makeCustomer();
    expect((await addToCart(customer.token, 1)).statusCode).toBeLessThan(300);

    const res = await checkout(customer.token);
    expect(res.statusCode).toBe(200);
  });
});
