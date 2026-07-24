import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { resolveDeliveryMode } from '../modules/fulfillment/fulfillment-mode';
import { registerErrorHandler } from '../middleware/error-handler';

// FUL-005: WHEN a delivery order dispatches to riders is per-deployment config
// (Part 5.1). Default ON_ACCEPT (dispatch as the vendor accepts — current
// behavior). ON_READY defers dispatch to the Mark-ready transition. This drives
// the REAL vendor routes with a spy on the dispatch queue and asserts the job
// fires at the right moment for each trigger.

let app: FastifyInstance;
const added: Array<{ name: string; data: { orderId: string } }> = [];
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';

async function mkUser(roles: UserRole[], activeRole: UserRole) {
  const u = await app.prisma.user.create({
    data: { phone: `+59200905${String(userIds.length).padStart(2, '0')}`, firstName: 'Trig', lastName: 'Ger', roles, activeRole, isPhoneVerified: true },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'tg', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

async function mkOrder(status: 'PENDING' | 'PREPARING') {
  const o = await app.prisma.order.create({
    data: {
      orderNumber: `TRG-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH',
    },
  });
  return o.id;
}

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
  // spy on the dispatch queue
  app.decorate('dispatchQueue', { add: async (name: string, data: { orderId: string }) => { added.push({ name, data }); } } as never);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await mkUser(['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], 'VENDOR_OWNER' as UserRole);
  vendorToken = owner.token;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Trigger Diner', slug: `trigger-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920090500', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;
  customerId = (await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole)).id;
});

afterEach(async () => {
  added.length = 0;
  delete process.env['DISPATCH_TRIGGER'];
  // reset self-delivery so the trigger cases (which assume platform-rider) are isolated
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { selfDeliveryEnabled: false } });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const put = (url: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor${url}`, headers: { authorization: `Bearer ${vendorToken}` } });

describe('dispatch trigger (FUL-005)', () => {
  it('DEFAULT ON_ACCEPT: accepting a DELIVERY order dispatches immediately', async () => {
    const id = await mkOrder('PENDING');
    const res = await put(`/orders/${id}/accept`);
    expect(res.statusCode).toBe(200);
    expect(added.filter((j) => j.name === 'dispatch-order' && j.data.orderId === id)).toHaveLength(1);
  });

  it('ON_READY: accepting does NOT dispatch (the rider waits for the food to be ready)', async () => {
    process.env['DISPATCH_TRIGGER'] = 'ON_READY';
    const id = await mkOrder('PENDING');
    const res = await put(`/orders/${id}/accept`);
    expect(res.statusCode).toBe(200);
    expect(added.filter((j) => j.name === 'dispatch-order')).toHaveLength(0);
  });

  it('ON_READY: marking ready dispatches (the rider is sent when the food is done)', async () => {
    process.env['DISPATCH_TRIGGER'] = 'ON_READY';
    const id = await mkOrder('PREPARING');
    const res = await put(`/orders/${id}/ready`);
    expect(res.statusCode).toBe(200);
    expect(added.filter((j) => j.name === 'dispatch-order' && j.data.orderId === id)).toHaveLength(1);
  });
});

const readMode = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id }, select: { fulfillmentMode: true } });

describe('FUL-004b: fulfillment-mode resolution at the dispatch decision', () => {
  it('a self-delivery vendor: accepting sets VENDOR_DELIVERY and does NOT dispatch a platform rider', async () => {
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { selfDeliveryEnabled: true } });
    const id = await mkOrder('PENDING');
    const res = await put(`/orders/${id}/accept`);
    expect(res.statusCode).toBe(200);
    expect(added.filter((j) => j.name === 'dispatch-order')).toHaveLength(0);
    expect((await readMode(id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
  });

  it('a platform-rider vendor (default): accepting sets PLATFORM_RIDER and dispatches', async () => {
    const id = await mkOrder('PENDING'); // vendor selfDeliveryEnabled reset to false in afterEach
    const res = await put(`/orders/${id}/accept`);
    expect(res.statusCode).toBe(200);
    expect(added.filter((j) => j.name === 'dispatch-order' && j.data.orderId === id)).toHaveLength(1);
    expect((await readMode(id)).fulfillmentMode).toBe('PLATFORM_RIDER');
  });
});

describe('resolveDeliveryMode (FUL-004b pure logic)', () => {
  it('an explicit order choice wins over the vendor default', () => {
    expect(resolveDeliveryMode('VENDOR_DELIVERY', false)).toBe('VENDOR_DELIVERY');
    expect(resolveDeliveryMode('PLATFORM_RIDER', true)).toBe('PLATFORM_RIDER');
  });
  it('with no explicit choice, a self-delivery-capable vendor self-delivers; otherwise a platform rider', () => {
    expect(resolveDeliveryMode(null, true)).toBe('VENDOR_DELIVERY');
    expect(resolveDeliveryMode(null, false)).toBe('PLATFORM_RIDER');
    expect(resolveDeliveryMode(undefined, false)).toBe('PLATFORM_RIDER');
  });
});

describe('FUL-004d: vendor fulfillment-mode override + the get-a-rider fallback', () => {
  const putMode = (id: string, mode: string) =>
    app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${id}/fulfillment-mode`, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: { mode } });

  it('a self-delivery vendor can switch an order to VENDOR_DELIVERY — no rider dispatched', async () => {
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { selfDeliveryEnabled: true } });
    const id = await mkOrder('PENDING');
    const res = await putMode(id, 'VENDOR_DELIVERY');
    expect(res.statusCode).toBe(200);
    expect((await readMode(id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
    expect(added.filter((j) => j.name === 'dispatch-order')).toHaveLength(0);
  });

  it('"get a rider instead" (→ PLATFORM_RIDER) dispatches a rider — the kitchen-rescue fallback', async () => {
    const id = await mkOrder('PENDING'); // no rider assigned yet
    const res = await putMode(id, 'PLATFORM_RIDER');
    expect(res.statusCode).toBe(200);
    expect((await readMode(id)).fulfillmentMode).toBe('PLATFORM_RIDER');
    expect(added.filter((j) => j.name === 'dispatch-order' && j.data.orderId === id)).toHaveLength(1);
  });

  it('a vendor WITHOUT self-delivery cannot choose VENDOR_DELIVERY', async () => {
    const id = await mkOrder('PENDING'); // selfDeliveryEnabled reset to false in afterEach
    const res = await putMode(id, 'VENDOR_DELIVERY');
    expect(res.statusCode).toBe(400);
  });
});
