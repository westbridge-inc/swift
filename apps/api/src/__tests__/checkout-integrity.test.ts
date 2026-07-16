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
// Pre-launch audit gaps: (1) checkout money math was only asserted "> 0" —
// a rounding/percentage regression could ship green; here we pin exact
// discount + express arithmetic. (2) IDOR was proven live but not guarded by
// an automated wrong-owner test in CI — one here so a refactor that drops an
// ownership predicate goes red.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_600_000_000 + Math.floor(Math.random() * 300_000_000);
let vendorId: string;
let itemId: string;
const ITEM_PRICE = 2000;
const PROMO = `INTG${nanoid(5).toUpperCase()}`;
let promoId: string;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Intg', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'intg', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  // Address very close to the vendor so the delivery fee is the deterministic minimum.
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Intg', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8014, longitude: -58.1552, isDefault: true } });
  return { userId: user.id, token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

async function cartAndCheckout(c: { token: string; addressId: string }, body: Record<string, unknown>) {
  await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
  await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
  return inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', ...body }, c.token);
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

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Intg', lastName: 'Vend', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Intg Diner', slug: `intg-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 901}`, addressLine1: '1 Intg', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Intg Plate', basePrice: ITEM_PRICE, isAvailable: true } });
  itemId = item.id;
  const promo = await app.prisma.promoCode.create({ data: { code: PROMO, description: '10% off', discountType: 'PERCENTAGE', discountValue: 10, validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() + 3600000), maxUses: 100, maxUsesPerUser: 5, isActive: true } });
  promoId = promo.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  if (promoId) await app.prisma.promoCode.deleteMany({ where: { id: promoId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('checkout money math', () => {
  it('applies an exact 10% discount on the subtotal', async () => {
    const c = await makeCustomer();
    const res = await cartAndCheckout(c, { promoCode: PROMO });
    expect(res.statusCode).toBe(200);
    const order = res.json().data.orders[0];
    // 10% of 2000 = 200 (ceil). total = subtotal + fee - discount.
    expect(order.discount).toBe(200);
    expect(order.total).toBe(order.subtotal + order.deliveryFee - 200);
  });

  it('express multiplies the delivery fee by exactly 1.5', async () => {
    const std = await makeCustomer();
    const stdRes = await cartAndCheckout(std, {});
    const stdFee = stdRes.json().data.orders[0].deliveryFee;

    const exp = await makeCustomer();
    const expRes = await cartAndCheckout(exp, { express: true });
    const expOrder = expRes.json().data.orders[0];
    expect(expOrder.isExpress).toBe(true);
    expect(expOrder.deliveryFee).toBe(Math.round(stdFee * 1.5));
  });

  it('passes the tip through untouched into the total', async () => {
    const c = await makeCustomer();
    const res = await cartAndCheckout(c, { tipAmount: 500 });
    const order = res.json().data.orders[0];
    expect(order.tip).toBe(500);
    expect(order.total).toBe(order.subtotal + order.deliveryFee + 500 - (order.discount ?? 0));
  });
});

describe('IDOR — wrong owner (CI guard for the live-proven protection)', () => {
  it('a customer cannot read or cancel another customer’s order', async () => {
    const victim = await makeCustomer();
    const attacker = await makeCustomer();
    const placed = await cartAndCheckout(victim, {});
    const orderId = placed.json().data.orders[0].id;

    const read = await inject('GET', `/api/v1/customer/orders/${orderId}`, undefined, attacker.token);
    expect(read.statusCode).toBe(404);
    const cancel = await inject('POST', `/api/v1/customer/orders/${orderId}/cancel`, { reason: 'hijack' }, attacker.token);
    expect(cancel.statusCode).toBeGreaterThanOrEqual(400);

    // the victim still can
    const ok = await inject('GET', `/api/v1/customer/orders/${orderId}`, undefined, victim.token);
    expect(ok.statusCode).toBe(200);
  });
});
