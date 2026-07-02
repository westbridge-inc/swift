import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Review responses (master plan §4.1): operators reply publicly; the reviewer
// is notified once (edits don't re-notify); replies surface on the customer
// reviews feed; other stores' reviews are untouchable; STAFF can't reply.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200328${String(seq).padStart(2, '0')}`,
      firstName: 'Reply',
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
      deviceId: 'reply-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
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

let owner: { userId: string; token: string };
let customer: { userId: string; token: string };
let vendorId: string;
let ratingId: string;

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: `Reply Cafe ${nanoid(4)}`,
      slug: `reply-cafe-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: '+5920032900',
      addressLine1: '7 Reply Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `RR-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: 'DELIVERED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
    },
  });
  const rating = await app.prisma.rating.create({
    data: {
      orderId: order.id,
      raterId: customer.userId,
      vendorId,
      type: 'CUSTOMER_TO_VENDOR',
      score: 4,
      comment: 'Great pepperpot, slow delivery',
    },
  });
  ratingId = rating.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.rating.deleteMany({ where: { raterId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Operator replies to a review', () => {
  it('posts a public reply and notifies the reviewer once', async () => {
    const res = await inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, {
      response: 'Thanks! We have added a second delivery rider for weekends.',
    }, owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.response).toContain('second delivery rider');
    expect(res.json().data.respondedBy).toBe(owner.userId);

    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: { contains: 'replied to your review' } },
    });
    expect(note).not.toBeNull();

    // Edit: response updates, but no second notification
    const edit = await inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, {
      response: 'Thanks! Weekend deliveries are faster now.',
    }, owner.token);
    expect(edit.statusCode).toBe(200);
    const notes = await app.prisma.notification.count({
      where: { userId: customer.userId, title: { contains: 'replied to your review' } },
    });
    expect(notes).toBe(1);
  });

  it('the reply shows on the customer-facing reviews feed', async () => {
    const res = await inject('GET', `/api/v1/customer/vendors/${vendorId}/reviews`, undefined, customer.token);
    expect(res.statusCode).toBe(200);
    const review = res.json().data.reviews.find((r: any) => r.id === ratingId);
    expect(review.response).toContain('faster now');
    expect(review.respondedAt).toBeTruthy();
  });

  it("another store's owner cannot touch the review; STAFF cannot reply", async () => {
    const stranger = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const svo = await app.prisma.vendorOwner.create({ data: { userId: stranger.userId } });
    await app.prisma.vendor.create({
      data: {
        ownerId: svo.id,
        name: `Stranger Shop ${nanoid(4)}`,
        slug: `stranger-shop-${nanoid(6)}`,
        vendorType: 'STORE',
        phone: '+5920032901',
        addressLine1: '1 Away St', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    const res = await inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, { response: 'not mine' }, stranger.token);
    expect(res.statusCode).toBe(404);

    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({
      data: { vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId },
    });
    const forbidden = await inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, { response: 'from the floor' }, staff.token);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('STAFF_FORBIDDEN');
  });
});
