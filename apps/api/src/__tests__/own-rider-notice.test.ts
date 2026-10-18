/**
 * [R14 · legal research D12 · owner 15 Oct 2026] When the store delivers an order itself (its per-order
 * "We'll deliver" choice: fulfillmentMode VENDOR_DELIVERY), the customer's order screen says, verbatim:
 * "This order is delivered by the store's own rider, not a Swift rider."
 *
 * The notice is the server's reading of THAT order's current fulfilment mode — never a client guess — so it
 * appears the moment the store chooses to deliver, and goes when the order is handed back to a Swift rider.
 */
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
import { testPhone } from './helpers/fixture-ids';

/** Legal research D12, verbatim (owner 15 Oct 2026). */
const NOTICE = "This order is delivered by the store's own rider, not a Swift rider.";
const DAY = 86_400_000;
const PHONE_PREFIX = testPhone();
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0');

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
let vendorId = '';
let itemId = '';
let customer = { userId: '', token: '' };

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'OwnRider', lastName: `User${seq}`, roles, activeRole,
    isPhoneVerified: true, selfieCapturedAt: new Date(), ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'own-rider-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function makeOrder(over: { fulfillmentMode?: 'PLATFORM_RIDER' | 'VENDOR_DELIVERY' | 'PICKUP' | null; fulfillment?: 'DELIVERY' | 'PICKUP'; orderType?: 'FOOD_DELIVERY' | 'COURIER'; status?: 'ACCEPTED' | 'PICKED_UP' } = {}) {
  const order = await app.prisma.order.create({ data: {
    orderNumber: `OR-${nanoid(10)}`, orderType: over.orderType ?? 'FOOD_DELIVERY', customerId: customer.userId, vendorId,
    status: over.status ?? 'ACCEPTED', fulfillment: over.fulfillment ?? 'DELIVERY', fulfillmentMode: over.fulfillmentMode ?? null,
    deliveryAddress: '4 Notice Street, Georgetown', deliveryLat: 6.81, deliveryLng: -58.16, pickupLat: 6.8, pickupLng: -58.15, pickupAddress: 'Store counter',
    subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH', paymentStatus: 'PENDING',
    items: { create: { itemId, name: 'Plate', quantity: 1, basePrice: 2000, markedUpPrice: 2000, markupAmount: 0, totalBase: 2000, totalMarkup: 0, totalCustomer: 2000, selectedOptions: {} } },
  } });
  orderIds.push(order.id);
  return order;
}

const detail = async (orderId: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { authorization: `Bearer ${customer.token}` } });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: 'Own Rider Diner', slug: `own-rider-${RUN}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}990`, addressLine1: '1 Store Street',
    city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
    selfDeliveryEnabled: true,
  } });
  vendorId = vendor.id;
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  itemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Plate', basePrice: 2000 } })).id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[R14] the own-rider notice follows the order, as the server reads it', () => {
  it('a delivery the store makes itself carries the notice, verbatim', async () => {
    const order = await makeOrder({ fulfillmentMode: 'VENDOR_DELIVERY', status: 'PICKED_UP' });
    expect((await detail(order.id)).ownRiderNotice).toBe(NOTICE);
  });

  it('a Swift-rider delivery, or one whose rider is not chosen yet, carries none', async () => {
    expect((await detail((await makeOrder({ fulfillmentMode: 'PLATFORM_RIDER' })).id)).ownRiderNotice).toBeNull();
    expect((await detail((await makeOrder({ fulfillmentMode: null })).id)).ownRiderNotice).toBeNull();
  });

  it('appears when the store chooses to deliver, and goes when the order is handed back to a Swift rider', async () => {
    const order = await makeOrder({ fulfillmentMode: 'PLATFORM_RIDER' });
    expect((await detail(order.id)).ownRiderNotice).toBeNull();
    await app.prisma.order.update({ where: { id: order.id }, data: { fulfillmentMode: 'VENDOR_DELIVERY', fulfillmentModeVersion: { increment: 1 } } });
    expect((await detail(order.id)).ownRiderNotice).toBe(NOTICE);
    await app.prisma.order.update({ where: { id: order.id }, data: { fulfillmentMode: 'PLATFORM_RIDER', fulfillmentModeVersion: { increment: 1 } } });
    expect((await detail(order.id)).ownRiderNotice).toBeNull();
  });

  it('a pickup order is never "delivered", so it never carries the notice — even with a stale delivery mode on the row', async () => {
    expect((await detail((await makeOrder({ fulfillment: 'PICKUP', fulfillmentMode: 'PICKUP' })).id)).ownRiderNotice).toBeNull();
    expect((await detail((await makeOrder({ fulfillment: 'PICKUP', fulfillmentMode: 'VENDOR_DELIVERY' })).id)).ownRiderNotice).toBeNull();
  });

  it('a courier parcel is not a store delivery, so it never carries the notice', async () => {
    expect((await detail((await makeOrder({ orderType: 'COURIER', fulfillmentMode: 'VENDOR_DELIVERY' })).id)).ownRiderNotice).toBeNull();
  });
});
