import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, TrustLevel } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';

// ---------------------------------------------------------------------------
// Trust-tier completion (master plan §5): L2 before the FIRST taxi ride; L3
// is EARNED automatically on completed history (the dead maybePromoteToL3 is
// now wired to order completion); auto-approved KYC documents always carry an
// expiry so the daily sweep + reminders have a date to act on.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };

let app: FastifyInstance;
let orderService: OrderService;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { trustLevel?: TrustLevel; ageDays?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200338${String(seq).padStart(2, '0')}`,
      firstName: 'Tier',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: opts.trustLevel ?? 'L1',
      ...(opts.ageDays ? { createdAt: new Date(Date.now() - opts.ageDays * DAY) } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'tier-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();

  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orderService = new OrderService(app.prisma, ioStub);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('L2 before the first taxi ride (§5)', () => {
  const body = {
    pickup: CENTRAL, dropoff: SOUTH,
    pickupAddress: 'Tier Street 1', dropoffAddress: 'Tier Street 2',
  };

  it('an L1 account cannot request ANY ride, however cheap', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('POST', '/api/v1/rides/request', body, u.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ID_VERIFICATION_REQUIRED');
    expect(res.json().error.details?.reason).toBe('first_ride_l2');
  });

  it('an L2 account rides', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L2' });
    const res = await inject('POST', '/api/v1/rides/request', body, u.token);
    expect(res.statusCode).toBe(201);
  });
});

describe('L3 is earned on completed history', () => {
  it('the qualifying delivery promotes an L2 customer with a clean record', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L2', ageDays: 45 });

    // 19 completed paid orders in history…
    for (let i = 0; i < 19; i++) {
      await app.prisma.order.create({
        data: {
          orderNumber: `L3-${nanoid(8)}`,
          orderType: 'FOOD_DELIVERY',
          customerId: u.userId,
          status: 'DELIVERED',
          paymentStatus: 'CAPTURED',
          deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
          subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
          deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
        },
      });
    }
    // …and the 20th completes through the real transition.
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `L3-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: u.userId,
        status: 'EN_ROUTE_DELIVERY',
        paymentStatus: 'CAPTURED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    await orderService.updateStatus(order.id, 'DELIVERED', 'tier-test');

    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(after.trustLevel).toBe('L3');

    const note = await app.prisma.notification.findFirst({
      where: { userId: u.userId, title: 'Trusted status earned' },
    });
    expect(note).not.toBeNull();
  });

  it('a strike blocks the promotion', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER', { trustLevel: 'L2', ageDays: 45 });
    await app.prisma.strike.create({
      data: { userId: u.userId, reason: 'no_show', orderId: null },
    });
    for (let i = 0; i < 20; i++) {
      await app.prisma.order.create({
        data: {
          orderNumber: `L3S-${nanoid(8)}`,
          orderType: 'FOOD_DELIVERY',
          customerId: u.userId,
          status: 'DELIVERED',
          paymentStatus: 'CAPTURED',
          deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
          subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
          deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
        },
      });
    }
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `L3S-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: u.userId,
        status: 'EN_ROUTE_DELIVERY',
        paymentStatus: 'CAPTURED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    await orderService.updateStatus(order.id, 'DELIVERED', 'tier-test');

    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(after.trustLevel).toBe('L2');
  });
});

describe('Auto-approved KYC documents lapse', () => {
  it('kyc:auto approval stamps a default expiry on expiring doc types', async () => {
    const u = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'police_clearance',
      fileUrl: 'storage://t/auto-approve/clearance.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, u.token);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('APPROVED');
    const expiresAt = new Date(res.json().data.expiresAt);
    const days = (expiresAt.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });

  it('non-expiring types (business registration) stay open-ended', async () => {
    const u = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'RESTAURANT',
      docType: 'business_registration',
      fileUrl: 'storage://t/auto-approve/bizreg.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, u.token);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('APPROVED');
    expect(res.json().data.expiresAt).toBeNull();
  });
});
