import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { NotificationService } from '../modules/notification/notification.service';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [CHAINS · owner 29 Oct 2026] One owner runs many branches from one phone. A
// "New Order!" that does not say WHICH branch sends the owner hunting through
// the switcher; so when the owner runs more than one store, the alert names the
// branch, and every alert carries the store's id so a tap opens that branch
// (the phone router already switches to a payload's vendorId when the order is
// that store's). A one-store owner reads exactly what they read today.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let notifications: NotificationService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const orderIds: string[] = [];

async function user(roles: Array<'VENDOR_OWNER' | 'CUSTOMER'>) {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Chain', lastName: `Alert${userIds.length}`, roles, activeRole: roles[0]!,
    isPhoneVerified: true, ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
  } });
  userIds.push(u.id);
  return u;
}

async function store(ownerId: string, name: string) {
  const v = await app.prisma.vendor.create({ data: {
    ownerId, name, slug: `chain-alert-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Alert Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorIds.push(v.id);
  return v;
}

async function pendingOrder(vendorId: string, customerId: string) {
  const o = await app.prisma.order.create({ data: {
    orderNumber: `CHN-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'PENDING', fulfillment: 'PICKUP',
    deliveryAddress: 'counter', deliveryLat: 6.81, deliveryLng: -58.16, pickupAddress: 'counter', pickupLat: 6.81, pickupLng: -58.16,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
  } });
  orderIds.push(o.id);
  return o;
}

const alertOf = (userId: string, orderId: string) => app.prisma.notification.findFirst({
  where: { userId, AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: orderId } }] },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  notifications = new NotificationService(app.prisma, app.io);
});

afterAll(async () => {
  await app.prisma.alertDelivery.deleteMany({ where: { subjectId: { in: orderIds } } }).catch(() => {});
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[CHAINS] the new-order alert names the branch', () => {
  it('an owner of several stores reads which branch the order is for, and the tap carries that store', async () => {
    const owner = await user(['VENDOR_OWNER']);
    const customer = await user(['CUSTOMER']);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    ownerIds.push(vo.id);
    await store(vo.id, `Royal Castle Camp ${wordFreeTag(5)}`);
    const north = await store(vo.id, `Royal Castle North ${wordFreeTag(5)}`);
    const order = await pendingOrder(north.id, customer.id);
    await notifications.newOrderForVendor(owner.id, order.orderNumber, 2, 1500, order.id);
    const row = await alertOf(owner.id, order.id);
    expect(row, 'the alert row').toBeTruthy();
    expect(row!.body).toContain(north.name);
    expect(row!.body).toContain(order.orderNumber);
    expect(row!.data).toMatchObject({ orderId: order.id, kind: 'vendor_order_alert', vendorId: north.id });
  });

  it('a one-store owner reads today\'s words; the tap still carries the store', async () => {
    const owner = await user(['VENDOR_OWNER']);
    const customer = await user(['CUSTOMER']);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    ownerIds.push(vo.id);
    const only = await store(vo.id, `Solo Kitchen ${wordFreeTag(5)}`);
    const order = await pendingOrder(only.id, customer.id);
    await notifications.newOrderForVendor(owner.id, order.orderNumber, 2, 1500, order.id);
    const row = await alertOf(owner.id, order.id);
    expect(row!.body).toBe(`Order ${order.orderNumber} — 2 item(s), $1,500 GYD`);
    expect(row!.data).toMatchObject({ orderId: order.id, vendorId: only.id });
  });
});
