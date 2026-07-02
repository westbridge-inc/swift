import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';

// ---------------------------------------------------------------------------
// Inventory engine (master plan §4.2). Failure paths first: overselling is
// impossible under concurrency (conditional decrement), items auto-hide at 0
// and reappear on restock/cancellation, the owner is alerted exactly once at
// the low-stock crossing, and the cart refuses more than the shelf holds.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let orderService: OrderService;

const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200238${String(seq).padStart(2, '0')}`,
      firstName: 'Inv',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/inv.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'inv-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeCustomer() {
  const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: {
      userId: u.userId, label: 'Home', addressLine1: '1 Inventory Lane',
      city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, isDefault: true,
    },
  });
  return u;
}

let vendorCtx: { token: string; userId: string; vendorId: string; categoryId: string; ownerUserId: string };

async function makeItem(name: string, opts: { stock?: number | null; threshold?: number | null; price?: number } = {}) {
  return app.prisma.item.create({
    data: {
      vendorId: vendorCtx.vendorId,
      categoryId: vendorCtx.categoryId,
      name,
      basePrice: opts.price ?? 1000,
      stockQuantity: opts.stock ?? null,
      lowStockThreshold: opts.threshold ?? null,
    },
  });
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
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

async function addToCart(token: string, itemId: string, quantity: number) {
  return inject('POST', '/api/v1/customer/cart/items', { vendorId: vendorCtx.vendorId, itemId, quantity }, token);
}

async function checkout(token: string) {
  return inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, token);
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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orderService = new OrderService(app.prisma, ioStub);

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `Inventory Mart ${nanoid(4)}`,
      slug: `inventory-mart-${nanoid(6)}`,
      vendorType: 'SUPERMARKET',
      phone: '+5920023900',
      addressLine1: '2 Stock Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  const category = await app.prisma.category.create({
    data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 },
  });
  vendorCtx = { token: owner.token, userId: owner.userId, vendorId: vendor.id, categoryId: category.id, ownerUserId: owner.userId };
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

describe('Checkout decrements tracked stock', () => {
  it('sells down a tracked item; untracked items are untouched', async () => {
    const customer = await makeCustomer();
    const tracked = await makeItem('Tracked Rice', { stock: 10 });
    const untracked = await makeItem('Untracked Bread');

    expect((await addToCart(customer.token, tracked.id, 3)).statusCode).toBeLessThan(300);
    expect((await addToCart(customer.token, untracked.id, 2)).statusCode).toBeLessThan(300);
    const res = await checkout(customer.token);
    expect(res.statusCode).toBe(200);

    const t = await app.prisma.item.findUniqueOrThrow({ where: { id: tracked.id } });
    const u = await app.prisma.item.findUniqueOrThrow({ where: { id: untracked.id } });
    expect(t.stockQuantity).toBe(7);
    expect(u.stockQuantity).toBeNull();
    expect(t.isAvailable).toBe(true);
  });

  it('the cart refuses more than the shelf holds', async () => {
    const customer = await makeCustomer();
    const item = await makeItem('Scarce Sugar', { stock: 2 });

    const res = await addToCart(customer.token, item.id, 3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('checkout rejects when stock dropped after the cart was built', async () => {
    const customer = await makeCustomer();
    const item = await makeItem('Vanishing Milk', { stock: 5 });

    expect((await addToCart(customer.token, item.id, 4)).statusCode).toBeLessThan(300);
    // Someone else buys most of it in the meantime
    await app.prisma.item.update({ where: { id: item.id }, data: { stockQuantity: 1 } });

    const res = await checkout(customer.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK');

    // Nothing was decremented — the transaction rolled back whole
    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.stockQuantity).toBe(1);
  });

  it('two racers for the last unit: exactly one order wins', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const item = await makeItem('Last Cassava', { stock: 1 });

    expect((await addToCart(a.token, item.id, 1)).statusCode).toBeLessThan(300);
    expect((await addToCart(b.token, item.id, 1)).statusCode).toBeLessThan(300);

    const [ra, rb] = await Promise.all([checkout(a.token), checkout(b.token)]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.stockQuantity).toBe(0);
    expect(after.isAvailable).toBe(false); // auto-hidden at zero
    expect(after.autoHiddenAt).not.toBeNull();
  });
});

describe('Auto-hide, alerts, and restock', () => {
  it('hides the item at zero, hides it from browse, and alerts the owner', async () => {
    const customer = await makeCustomer();
    const item = await makeItem('Final Flour', { stock: 2, threshold: 5 });

    expect((await addToCart(customer.token, item.id, 2)).statusCode).toBeLessThan(300);
    expect((await checkout(customer.token)).statusCode).toBe(200);

    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.stockQuantity).toBe(0);
    expect(after.isAvailable).toBe(false);
    expect(after.autoHiddenAt).not.toBeNull();

    // Sold-out alert reached the owner
    const note = await app.prisma.notification.findFirst({
      where: { userId: vendorCtx.ownerUserId, type: 'LOW_STOCK', body: { contains: 'Final Flour' } },
    });
    expect(note).not.toBeNull();

    // A hidden item can't be carted
    const blocked = await addToCart(customer.token, item.id, 1);
    expect(blocked.statusCode).toBe(404);
  });

  it('alerts once at the low-stock crossing, not on every order below it', async () => {
    const item = await makeItem('Crossing Cheese', { stock: 6, threshold: 4 });

    const c1 = await makeCustomer();
    expect((await addToCart(c1.token, item.id, 3)).statusCode).toBeLessThan(300);
    expect((await checkout(c1.token)).statusCode).toBe(200); // 6 -> 3, crosses 4

    const c2 = await makeCustomer();
    expect((await addToCart(c2.token, item.id, 1)).statusCode).toBeLessThan(300);
    expect((await checkout(c2.token)).statusCode).toBe(200); // 3 -> 2, already below

    const notes = await app.prisma.notification.findMany({
      where: { userId: vendorCtx.ownerUserId, type: 'LOW_STOCK', body: { contains: 'Crossing Cheese' } },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain('3');
  });

  it('cancellation restocks and un-hides a pure auto-hide', async () => {
    const customer = await makeCustomer();
    const item = await makeItem('Comeback Corn', { stock: 1 });

    expect((await addToCart(customer.token, item.id, 1)).statusCode).toBeLessThan(300);
    const placed = await checkout(customer.token);
    expect(placed.statusCode).toBe(200);
    const orderId = placed.json().data.orders[0].id as string;

    const sold = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(sold.stockQuantity).toBe(0);
    expect(sold.isAvailable).toBe(false);

    await orderService.updateStatus(orderId, 'CANCELLED', 'vendor-test', 'out of hours');

    const back = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(back.stockQuantity).toBe(1);
    expect(back.isAvailable).toBe(true); // auto-hide undone
    expect(back.autoHiddenAt).toBeNull();
  });

  it('the owner restocking above zero un-hides an auto-hidden item — but a manual hide stays', async () => {
    const auto = await makeItem('Restocked Rum Cake', { stock: 0 });
    await app.prisma.item.update({
      where: { id: auto.id },
      data: { isAvailable: false, autoHiddenAt: new Date() },
    });

    const res = await inject('PUT', `/api/v1/vendor/items/${auto.id}`, { stockQuantity: 12 }, vendorCtx.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.isAvailable).toBe(true);
    expect(res.json().data.stockQuantity).toBe(12);

    // Owner-hidden (no autoHiddenAt marker): restocking must NOT flip it back on
    const manual = await makeItem('Manually Hidden Pepper', { stock: 0 });
    await app.prisma.item.update({ where: { id: manual.id }, data: { isAvailable: false } });

    const res2 = await inject('PUT', `/api/v1/vendor/items/${manual.id}`, { stockQuantity: 12 }, vendorCtx.token);
    expect(res2.statusCode).toBe(200);
    expect(res2.json().data.isAvailable).toBe(false);
  });
});
