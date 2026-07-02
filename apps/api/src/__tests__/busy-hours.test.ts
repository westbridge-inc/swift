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

// ---------------------------------------------------------------------------
// Busy-hours analytics (master plan §4.1): orders bucket by GUYANA-local hour
// (UTC-4), cancellations don't count, and the view is manager-gated.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200358${String(seq).padStart(2, '0')}`,
      firstName: 'Busy',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'busy-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

let owner: { userId: string; token: string };
let customer: { userId: string; token: string };
let vendorId: string;

/** placedAt for a given GUYANA-local hour (UTC-4) yesterday. */
function atLocalHour(localHour: number): Date {
  const d = new Date(Date.now() - DAY);
  d.setUTCHours((localHour + 4) % 24, 30, 0, 0);
  return d;
}

async function makeOrder(placedAt: Date, status: 'DELIVERED' | 'CANCELLED') {
  return app.prisma.order.create({
    data: {
      orderNumber: `BH-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status,
      placedAt,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
    },
  });
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
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: `Busy Bar ${nanoid(4)}`,
      slug: `busy-bar-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: '+5920035900',
      addressLine1: '2 Rush Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('GET /vendor/analytics/busy-hours', () => {
  it('buckets by Guyana-local hour, skips cancellations, names the peak', async () => {
    await makeOrder(atLocalHour(12), 'DELIVERED');
    await makeOrder(atLocalHour(12), 'DELIVERED');
    await makeOrder(atLocalHour(18), 'DELIVERED');
    await makeOrder(atLocalHour(18), 'CANCELLED'); // must not count

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/analytics/busy-hours',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.hours).toHaveLength(24);
    expect(data.hours[12].orders).toBe(2);
    expect(data.hours[18].orders).toBe(1);
    expect(data.peak.hour).toBe(12);
    expect(data.total).toBe(3);
  });

  it('is manager-gated — floor STAFF cannot read business analytics', async () => {
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({
      data: { vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/analytics/busy-hours',
      headers: { authorization: `Bearer ${staff.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_FORBIDDEN');
  });
});
