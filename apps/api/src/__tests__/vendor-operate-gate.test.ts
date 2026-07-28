import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// A vendor may only DRIVE an order forward while ELIGIBLE to operate. The
// doc-expiry sweep sets isVerified=false but leaves status ACTIVE, so a lapsed
// store's board keeps rendering — without a server gate on the transitions, its
// in-flight orders could be fully accepted/prepared/handed over. This proves the
// gate: an ineligible vendor is refused at accept; an eligible one is not.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await app.prisma.user.create({
    data: { phone: `+59200907${String(Math.floor(Math.random() * 90) + 10)}`, firstName: 'Gate', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(owner.id);
  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'g', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Gate Diner', slug: `gate-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920090700', addressLine1: '3 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;

  const cust = await app.prisma.user.create({
    // Distinct prefix from the owner (+59200907xx) — both randoming the same 10-99
    // range collided ~1/90 of runs (a flake #483 got lucky on).
    data: { phone: `+59200908${String(Math.floor(Math.random() * 90) + 10)}`, firstName: 'Gate', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cust.id);
  customerId = cust.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

async function makePendingOrder() {
  return app.prisma.order.create({
    data: {
      orderNumber: `VOG-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId, vendorId,
      status: 'PENDING' as never,
      fulfillment: 'DELIVERY' as never,
      pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.15,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH' as never,
    },
  });
}

const accept = (orderId: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${orderId}/accept`, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: {} });

async function setVendor(data: Record<string, unknown>) {
  await app.prisma.vendor.update({ where: { id: vendorId }, data });
}

describe('Vendor operate-gate — a store must be eligible to work an order', () => {
  it('an ACTIVE, verified store accepts a pending order (the gate lets eligible work through)', async () => {
    await setVendor({ status: 'ACTIVE', isVerified: true });
    const order = await makePendingOrder();
    const res = await accept(order.id);
    expect(res.statusCode).toBe(200);
  });

  it('a store whose documents lapsed (isVerified=false, status still ACTIVE) is REFUSED at accept', async () => {
    // The expiry sweep sets isVerified=false but leaves status ACTIVE — the exact
    // hole. The owner has no approved verification docs, so isRoleVerified is false.
    await setVendor({ status: 'ACTIVE', isVerified: false });
    const order = await makePendingOrder();
    const res = await accept(order.id);
    // RED before the gate: the board still rendered and the server accepted it.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
    // The order was NOT moved — still PENDING.
    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(db.status).toBe('PENDING');
    await setVendor({ isVerified: true });
  });

  it('a SUSPENDED store is REFUSED at accept', async () => {
    await setVendor({ status: 'SUSPENDED', isVerified: true });
    const order = await makePendingOrder();
    const res = await accept(order.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VENDOR_SUSPENDED');
    await setVendor({ status: 'ACTIVE' });
  });
});
