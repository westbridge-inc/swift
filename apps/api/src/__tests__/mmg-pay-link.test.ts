import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// MMG Phase 1: a vendor / taxi driver attaches their OWN MMG "pay me" link
// (opt-in) so customers can pay them directly. Owner-scoped set/clear.

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const userIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200721${String(seq).padStart(2, '0')}`,
      firstName: 'Mmg', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'mmg-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeVendor(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'MMG Diner', slug: `mmg-diner-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920072100', addressLine1: '5 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  return vendor.id;
}

async function makeDriver(userId: string) {
  const driver = await app.prisma.driver.create({
    data: {
      userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
      licensePlate: `PMG${seq}`, driverLicenseUrl: '/uploads/x.jpg', vehicleInsuranceUrl: '/uploads/y.jpg',
    },
  });
  return driver.id;
}

function inject(method: 'GET' | 'PUT' | 'POST', url: string, token: string, payload?: unknown, vendorId?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

let vendorOwner: { userId: string; token: string };
let vendorId: string;
let driver: { userId: string; token: string };
let customer: { userId: string; token: string };

async function makeOrder(payment: 'CASH' | 'MOBILE_MONEY') {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `MMG-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.userId, vendorId, status: 'ACCEPTED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
      paymentMethod: payment,
    },
  });
  return order.id;
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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  vendorOwner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorId = await makeVendor(vendorOwner.userId);
  driver = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  await makeDriver(driver.userId);
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('MMG pay link — vendor', () => {
  const LINK = 'https://mmg.gy/pay/mmg-diner';

  it('an owner attaches their MMG link and it comes back', async () => {
    const res = await inject('PUT', '/api/v1/vendor/profile', vendorOwner.token, { mmgPayUrl: LINK }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mmgPayUrl).toBe(LINK);
    const got = await inject('GET', '/api/v1/vendor/profile', vendorOwner.token, undefined, vendorId);
    const v = got.json().data.vendors.find((x: any) => x.id === vendorId);
    expect(v.mmgPayUrl).toBe(LINK);
  });

  it('clears the link with an empty string (back to cash-only)', async () => {
    const res = await inject('PUT', '/api/v1/vendor/profile', vendorOwner.token, { mmgPayUrl: '' }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mmgPayUrl).toBeNull();
  });

  it('rejects a bearer-less request', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', payload: { mmgPayUrl: LINK }, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('MMG pay link — taxi driver', () => {
  const LINK = 'https://mmg.gy/pay/driver42';

  it('a driver attaches + clears their MMG link', async () => {
    const set = await inject('PUT', '/api/v1/driver/profile', driver.token, { mmgPayUrl: LINK });
    expect(set.statusCode).toBe(200);
    expect(set.json().data.mmgPayUrl).toBe(LINK);

    const clear = await inject('PUT', '/api/v1/driver/profile', driver.token, { mmgPayUrl: '' });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().data.mmgPayUrl).toBeNull();
  });
});

describe('MMG payment — vendor confirms received', () => {
  it('marks an MMG order paid (CAPTURED) and is idempotent', async () => {
    const id = await makeOrder('MOBILE_MONEY');
    const res = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, vendorOwner.token, {}, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.paymentStatus).toBe('CAPTURED');
    // double-tap safe
    const again = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, vendorOwner.token, {}, vendorId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.paymentStatus).toBe('CAPTURED');
  });

  it('refuses to "confirm payment" on a cash order (cash is settled at handover)', async () => {
    const id = await makeOrder('CASH');
    const res = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, vendorOwner.token, {}, vendorId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_MMG');
  });

  it("a different owner can't confirm this vendor's order", async () => {
    const id = await makeOrder('MOBILE_MONEY');
    const res = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, driver.token, {});
    expect([403, 404]).toContain(res.statusCode);
  });
});
