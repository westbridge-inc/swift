import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';

// ---------------------------------------------------------------------------
// Delivery→pickup conversion (availability spec §4.2): the ONE additive
// transition. Only while unassigned; rider money (fee + tip) comes off;
// a rider claiming mid-race wins.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let customerId: string;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorId: string;
let riderId: string;

async function makeOrder(opts: { riderAssigned?: boolean } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CVT-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId,
      vendorId,
      ...(opts.riderAssigned ? { riderId } : {}),
      status: 'PREPARING' as never,
      fulfillment: 'DELIVERY' as never,
      deliveryAddress: '7 Conversion Close', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 4000, subtotalMarkup: 0, subtotalCustomer: 4000,
      deliveryFee: 600, tipAmount: 300, totalAmount: 4900,
      paymentMethod: 'CASH' as never,
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const me = await app.prisma.user.create({
    data: {
      phone: `+59253${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Con', lastName: 'Vert',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  customerId = me.id;
  userIds.push(me.id);
  token = app.jwt.sign({ userId: me.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: me.id, token, refreshToken: nanoid(48),
      deviceId: 'cvt-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } });
  vendorId = vendor.id;

  const riderUser = await app.prisma.user.create({
    data: {
      phone: `+59252${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Busy', lastName: 'Rider',
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(riderUser.id);
  const rider = await app.prisma.rider.create({
    data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  riderId = rider.id;
});

afterAll(async () => {
  delete process.env['DISPATCH_EXHAUSTION'];
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  if (userIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

const convert = (id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/customer/orders/${id}/convert-to-pickup`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {},
  });

describe('POST /orders/:id/convert-to-pickup', () => {
  it('is invisible with the flag off', async () => {
    delete process.env['DISPATCH_EXHAUSTION'];
    const order = await makeOrder();
    const res = await convert(order.id);
    expect(res.statusCode).toBe(404);
  });

  it('converts an unassigned delivery: fee + tip come off, pickup code issued', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeOrder();
    const res = await convert(order.id);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.fulfillment).toBe('PICKUP');
    expect(String(d.pickupCode)).toMatch(/^\d{6}$/);
    expect(Number(d.deliveryFee)).toBe(0);
    expect(Number(d.tipAmount)).toBe(0);
    expect(Number(d.totalAmount)).toBe(4000); // 4900 − 600 fee − 300 tip

    const log = await app.prisma.orderStatusLog.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.note).toContain('switched to pickup');
  });

  it('refuses once a rider owns the order — the race is honest', async () => {
    process.env['DISPATCH_EXHAUSTION'] = '1';
    const order = await makeOrder({ riderAssigned: true });
    const res = await convert(order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RIDER_ALREADY_ASSIGNED');

    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.fulfillment).toBe('DELIVERY');
    expect(Number(untouched.totalAmount)).toBe(4900);
  });
});
