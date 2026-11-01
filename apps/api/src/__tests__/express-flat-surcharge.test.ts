import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { OrderService } from '../modules/order/order.service';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { cashMathForOffer } from '../modules/dispatch/dispatch.service';
import { fixtureTag, testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [Owner ruling, 1 Nov 2026] Store/food EXPRESS = the normal delivery fee + a
// flat GYD 1,000, any distance; all of the extra goes to the rider.
//
// End to end through the real routes, near and far: the cart quote says
// +1,000, the express quote's total is the standard total + 1,000, checkout
// charges exactly that quote, the order keeps it in its delivery fee, and the
// rider's delivery pay (createEarnings) and offer card (youKeep) are that whole
// fee. The amounts are written out (1,000), not read from markup.ts, so this
// file grades the behaviour rather than the constant. The pure half (every
// distance, parcels unchanged, the words) is express-flat-surcharge.unit.test.ts.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let orders: OrderService;
const userIds: string[] = [];
const orderIds: string[] = [];
const riderIds: string[] = [];
let seq = 0;
const VENDOR = { latitude: 6.8013, longitude: -58.1551 };
let vendorId: string;
let itemId: string;
const ITEM_PRICE = 1800;

async function makeCustomer(at: { latitude: number; longitude: number }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Flat', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'flat', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Flat', city: 'Georgetown', region: 'Demerara-Mahaica', ...at, isDefault: true } });
  return { token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

async function makeRider() {
  seq += 1;
  const ru = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Flat', lastName: 'Rider', roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(ru.id);
  const rider = await app.prisma.rider.create({ data: { userId: ru.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderIds.push(rider.id);
  return rider.id;
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
  orders = new OrderService(app.prisma, app.io);

  const ownerUser = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Flat', lastName: 'Vend', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Flat Express Diner', slug: `flat-${fixtureTag()}`, vendorType: 'RESTAURANT', phone: testPhone(), addressLine1: '1 Flat', city: 'Georgetown', region: 'Demerara-Mahaica', ...VENDOR, deliveryRadius: 25, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Flat Plate', basePrice: ITEM_PRICE, isAvailable: true } });
  itemId = item.id;
});

afterAll(async () => {
  if (orderIds.length) await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  if (userIds.length) await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  if (riderIds.length) await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
  if (userIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('express = the delivery fee + GYD 1,000, quoted, charged and paid to the rider [owner 1 Nov 2026]', () => {
  it.each([
    // [where the customer is, what that does to the standard fee]
    ['next door', { latitude: 6.8014, longitude: -58.1552 }, 'base'],
    ['across town', { latitude: 6.8613, longitude: -58.1551 }, 'distance'],
  ] as const)('%s: quote +1,000 → checkout charges that quote → the rider is paid the whole fee', async (_where, at, feeKind) => {
    const c = await makeCustomer(at);
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token)).statusCode).toBe(201);
    expect((await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token)).statusCode).toBe(200);

    // The standard quote: the toggle's "+GYD 1,000", and what the express total would be.
    const stdRes = await inject('GET', '/api/v1/customer/cart', undefined, c.token);
    expect(stdRes.statusCode, stdRes.body).toBe(200);
    const std = stdRes.json().data;
    const standardFee: number = std.standardDeliveryFee;
    if (feeKind === 'base') expect(standardFee).toBe(500);
    else expect(standardFee).toBeGreaterThan(500); // further away costs more; the premium does not
    expect(std).toMatchObject({ express: false, deliveryFee: standardFee, expressSurcharge: 1000, expressTotal: std.totalAmount + 1000 });

    // The express quote: the fee and the total are each exactly 1,000 more.
    const fastRes = await inject('GET', '/api/v1/customer/cart?express=true', undefined, c.token);
    expect(fastRes.statusCode, fastRes.body).toBe(200);
    const fast = fastRes.json().data;
    expect(fast).toMatchObject({ express: true, standardDeliveryFee: standardFee, deliveryFee: standardFee + 1000, expressSurcharge: 1000, totalAmount: std.totalAmount + 1000, expressTotal: std.totalAmount + 1000 });
    expect(fast.vendors).toHaveLength(1);
    expect(fast.vendors[0]).toMatchObject({ standardDeliveryFee: standardFee, deliveryFee: standardFee + 1000, expressSurcharge: 1000, totalAmount: fast.totalAmount });

    // Checkout charges exactly the express quote.
    const placed = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', express: true }, c.token);
    expect(placed.statusCode, placed.body).toBe(200);
    const answer = placed.json().data.orders[0];
    orderIds.push(answer.id);
    expect(answer).toMatchObject({ isExpress: true, subtotal: ITEM_PRICE, deliveryFee: standardFee + 1000, total: fast.totalAmount });
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: answer.id } });
    expect(row.isExpress).toBe(true);
    expect(Number(row.deliveryFee)).toBe(standardFee + 1000);
    expect(Number(row.totalAmount)).toBe(ITEM_PRICE + standardFee + 1000);

    // All of the extra goes to the rider: the offer card's "you keep" and the
    // delivery-pay earning are the whole express fee.
    const riderId = await makeRider();
    const assigned = await app.prisma.order.update({ where: { id: row.id }, data: { riderId } });
    expect(cashMathForOffer(assigned)?.youKeep).toBe(standardFee + 1000);
    await orders.createEarnings(row.id, app.prisma, false);
    const pay = await app.prisma.earning.findMany({ where: { orderId: row.id }, select: { type: true, amount: true, riderId: true } });
    expect(pay.map((e) => ({ ...e, amount: Number(e.amount) }))).toEqual([{ type: 'DELIVERY_FEE', amount: standardFee + 1000, riderId }]);
  });
});
