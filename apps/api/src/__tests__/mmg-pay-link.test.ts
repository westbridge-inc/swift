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
import { grantStepUp } from './helpers/step-up';
import { applyDueMmgLinkChanges } from '../modules/integrity/money-surface';

// [W-25] A store's attestation now carries the provider reference from its own
// wallet message — a bare tap is refused (REFERENCE_REQUIRED), and one reference
// cannot mark two orders paid. The refusal cases are graded in
// mmg-vendor-attestation.test.ts; these suites keep grading the lifecycle.
const mmgRef = () => `MMGT${Math.random().toString(36).slice(2, 12).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;


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
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.example.com';

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
  const LINK = 'https://pay.example.com/pay/mmg-diner';

  it('an owner attaches their MMG link: staged behind the cool-off, live once it passes [ALG-INV-14]', async () => {
    const cold = await inject('PUT', '/api/v1/vendor/profile', vendorOwner.token, { mmgPayUrl: LINK }, vendorId);
    expect(cold.statusCode).toBe(403);
    expect(cold.json().error.code).toBe('STEP_UP_REQUIRED');

    await grantStepUp(app, vendorOwner.token);
    const res = await inject('PUT', '/api/v1/vendor/profile', vendorOwner.token, { mmgPayUrl: LINK }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mmgPayUrl).toBeNull(); // nothing was live before, nothing is live yet
    expect(res.json().data.mmgPayUrlPending).toBe(LINK);
    expect(typeof res.json().data.mmgPayUrlApplyAt).toBe('string');

    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrlApplyAt: new Date(Date.now() - 1000) } });
    expect((await applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io })).applied).toBeGreaterThanOrEqual(1);
    const got = await inject('GET', '/api/v1/vendor/profile', vendorOwner.token, undefined, vendorId);
    const v = got.json().data.vendors.find((x: any) => x.id === vendorId);
    expect(v.mmgPayUrl).toBe(LINK);
    expect(v.mmgPayUrlPending).toBeNull();
  });

  it('clears the link with an empty string (back to cash-only) — immediate, it redirects nothing', async () => {
    await grantStepUp(app, vendorOwner.token);
    const res = await inject('PUT', '/api/v1/vendor/profile', vendorOwner.token, { mmgPayUrl: '' }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mmgPayUrl).toBeNull();
  });

  it('rejects a bearer-less request', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', payload: { mmgPayUrl: LINK }, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    'http://pay.example.com/pay/mmg-diner',
    'https://user:secret@pay.example.com/pay/mmg-diner',
    'https://pay.example.com/pay/mmg-diner#confirmation',
    'https://127.0.0.1/pay/mmg-diner',
    'https://evil.example/pay/mmg-diner',
    'not a url',
  ])('rejects an unsafe or unapproved destination: %s', async (mmgPayUrl) => {
    const res = await inject('PUT', '/api/v1/vendor/profile', vendorOwner.token, { mmgPayUrl }, vendorId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_MMG_PAY_URL');
  });

  it('redacts an unsafe legacy value at the owner profile read boundary', async () => {
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrl: 'https://evil.example/pay/legacy' } });
    const got = await inject('GET', '/api/v1/vendor/profile', vendorOwner.token, undefined, vendorId);
    const v = got.json().data.vendors.find((x: any) => x.id === vendorId);
    expect(v.mmgPayUrl).toBeNull();
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrl: null } });
  });
});

describe('MMG pay link — taxi driver', () => {
  const LINK = 'https://pay.example.com/pay/driver42';

  it('a driver attaches (staged, then live after the cool-off) + clears their MMG link', async () => {
    expect((await inject('PUT', '/api/v1/driver/profile', driver.token, { mmgPayUrl: LINK })).statusCode).toBe(403);
    await grantStepUp(app, driver.token);
    const set = await inject('PUT', '/api/v1/driver/profile', driver.token, { mmgPayUrl: LINK });
    expect(set.statusCode).toBe(200);
    expect(set.json().data.mmgPayUrl).toBeNull();
    expect(set.json().data.mmgPayUrlPending).toBe(LINK);
    await app.prisma.driver.update({ where: { userId: driver.userId }, data: { mmgPayUrlApplyAt: new Date(Date.now() - 1000) } });
    await applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io });
    expect((await inject('GET', '/api/v1/driver/profile', driver.token)).json().data.mmgPayUrl).toBe(LINK);

    const clear = await inject('PUT', '/api/v1/driver/profile', driver.token, { mmgPayUrl: '' });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().data.mmgPayUrl).toBeNull();
  });

  it('rejects disallowed writes and redacts an unsafe legacy profile value', async () => {
    const rejected = await inject('PUT', '/api/v1/driver/profile', driver.token, { mmgPayUrl: 'https://evil.example/pay/driver42' });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_MMG_PAY_URL');

    await app.prisma.driver.update({ where: { userId: driver.userId }, data: { mmgPayUrl: 'https://evil.example/pay/legacy' } });
    const profile = await inject('GET', '/api/v1/driver/profile', driver.token);
    expect(profile.json().data.mmgPayUrl).toBeNull();
    await app.prisma.driver.update({ where: { userId: driver.userId }, data: { mmgPayUrl: null } });
  });
});

describe('MMG payment — vendor confirms received', () => {
  it('marks an MMG order paid (CAPTURED) and is idempotent', async () => {
    const id = await makeOrder('MOBILE_MONEY');
    const res = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.paymentStatus).toBe('CAPTURED');
    // double-tap safe
    const again = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.paymentStatus).toBe('CAPTURED');
  });

  it('refuses to "confirm payment" on a cash order (cash is settled at handover)', async () => {
    const id = await makeOrder('CASH');
    const res = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, vendorOwner.token, { reference: mmgRef() }, vendorId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_MMG');
  });

  it("a different owner can't confirm this vendor's order", async () => {
    const id = await makeOrder('MOBILE_MONEY');
    const res = await inject('POST', `/api/v1/vendor/orders/${id}/confirm-payment`, driver.token, { reference: mmgRef() });
    expect([403, 404]).toContain(res.statusCode);
  });
});
