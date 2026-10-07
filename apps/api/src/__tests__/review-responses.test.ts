import { publicVendorReviewId } from '../modules/rating/vendor-review-visibility';
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
import { moderationRoutes } from '../modules/moderation/moderation.routes';
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

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
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
  await app.register(moderationRoutes, { prefix: '/api/v1' });
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
      // Double-blind released — the public feed only lists visible ratings.
      visibleAt: new Date(),
    },
  });
  ratingId = rating.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.ratingReport.deleteMany({ where: { reporterId: { in: createdUserIds } } });
    await app.prisma.contentReport.deleteMany({ where: { reporterId: { in: createdUserIds } } });
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
    const review = res.json().data.reviews.find((r: any) => r.id === publicVendorReviewId(ratingId));
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

// ---------------------------------------------------------------------------
// Row 52 (review half): the store's own review list shows what was said and
// never who said it, and never lists a review that is not yet released.
// ---------------------------------------------------------------------------
describe('Store review list projection', () => {
  const ALLOWED_KEYS = ['comment', 'createdAt', 'id', 'respondedAt', 'response', 'score', 'tags', 'type'];

  it('returns only the allowlisted fields, no reviewer identity, no unreleased review', async () => {
    const hidden = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const hiddenOrder = await app.prisma.order.create({
      data: {
        orderNumber: `RR-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: hidden.userId,
        vendorId,
        status: 'DELIVERED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    const unreleased = await app.prisma.rating.create({
      data: {
        orderId: hiddenOrder.id,
        raterId: hidden.userId,
        vendorId,
        type: 'CUSTOMER_TO_VENDOR',
        score: 1,
        comment: 'still inside the blind window',
        visibleAt: null,
      },
    });
    const released = await app.prisma.rating.findUniqueOrThrow({ where: { id: ratingId } });
    const reviewer = await app.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });

    const res = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>>; summary: { totalReviews: number } };

    expect(body.data.map((r) => r['id'])).toEqual([publicVendorReviewId(ratingId)]);
    expect(body.summary.totalReviews).toBe(1);
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(ALLOWED_KEYS);
    }
    const text = res.body;
    expect(text).not.toContain(unreleased.id);
    expect(text).not.toContain(customer.userId);
    expect(text).not.toContain(released.orderId);
    expect(text).not.toContain(reviewer.lastName as string);
  });

  it('the reply door answers with the same fields (plus the replying team member), never the reviewer or moderation state', async () => {
    const author = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `RR-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: author.userId,
        vendorId,
        status: 'DELIVERED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    const review = await app.prisma.rating.create({
      data: {
        orderId: order.id, raterId: author.userId, vendorId, type: 'CUSTOMER_TO_VENDOR',
        score: 5, comment: 'Lovely bake', tags: ['tasty'], visibleAt: new Date(),
        flagReason: 'sweep-note-for-staff-only', stateReason: 'internal-only',
      },
    });
    const authorRow = await app.prisma.user.findUniqueOrThrow({ where: { id: author.userId } });
    const REPLY_KEYS = [...ALLOWED_KEYS, 'respondedBy'].sort();

    for (const response of ['Thank you, come again!', 'Thank you — see you soon!']) {
      const res = await inject('POST', `/api/v1/vendor/reviews/${review.id}/respond`, { response }, owner.token);
      expect(res.statusCode).toBe(200);
      const data = res.json().data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(REPLY_KEYS);
      expect(data['id']).toBe(publicVendorReviewId(review.id));
      expect(data['respondedBy']).toBe(owner.userId);
      expect(res.body).not.toContain(author.userId);
      expect(res.body).not.toContain(order.id);
      expect(res.body).not.toContain(authorRow.lastName as string);
      expect(res.body).not.toContain('sweep-note-for-staff-only');
      expect(res.body).not.toContain('internal-only');
    }
  });
});

// ---------------------------------------------------------------------------
// Account deletion keeps a review's score and tags but removes its comment and
// any store reply. A store must not then add text to that de-identified review.
// ---------------------------------------------------------------------------
describe('A review whose author deleted their account', () => {
  it('refuses a new store reply and leaves the review and the inbox untouched', async () => {
    const author = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `RR-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: author.userId,
        vendorId,
        status: 'DELIVERED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    const review = await app.prisma.rating.create({
      data: {
        orderId: order.id, raterId: author.userId, vendorId, type: 'CUSTOMER_TO_VENDOR',
        score: 3, comment: null, tags: ['slow'], visibleAt: new Date(),
      },
    });
    // The state the deletion flow leaves behind.
    await app.prisma.user.update({
      where: { id: author.userId },
      data: { status: 'DEACTIVATED', phone: `deleted:${author.userId}` },
    });
    const notesBefore = await app.prisma.notification.count({ where: { userId: author.userId } });

    const res = await inject('POST', `/api/v1/vendor/reviews/${review.id}/respond`, { response: 'Thanks for the feedback' }, owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REVIEW_AUTHOR_DELETED');

    const after = await app.prisma.rating.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.response).toBeNull();
    expect(after.respondedAt).toBeNull();
    expect(after.respondedBy).toBeNull();
    expect(await app.prisma.notification.count({ where: { userId: author.userId } })).toBe(notesBefore);
  });
});

describe('Store review privacy across blocks and dates', () => {
  it('blocking and unblocking a customer changes neither the store list nor the reply-edit outcome', async () => {
    const response = 'Thanks for the feedback.';
    const reply = () => inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, { response }, owner.token);
    const beforeReply = await reply();
    expect(beforeReply.statusCode, beforeReply.body).toBe(200);
    const beforeList = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
    expect(beforeList.statusCode).toBe(200);

    // Exercise the actual caller-controlled action, not a planted block row.
    const block = await inject('POST', '/api/v1/blocks', { blockedUserId: customer.userId }, owner.token);
    expect(block.statusCode, block.body).toBe(201);
    try {
      const blockedList = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
      expect(blockedList.statusCode).toBe(200);
      expect(blockedList.json()).toEqual(beforeList.json());
      const blockedReply = await reply();
      expect(blockedReply.statusCode, blockedReply.body).toBe(200);
      expect(blockedReply.json().data).toEqual({
        ...beforeReply.json().data, respondedAt: expect.any(String),
      });
      expect(blockedReply.body).not.toContain(customer.userId);
    } finally {
      const unblock = await inject('PUT', `/api/v1/blocks/${customer.userId}`, undefined, owner.token);
      expect(unblock.statusCode, unblock.body).toBe(200);
    }
    const unblockedList = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
    expect(unblockedList.json().summary).toEqual(beforeList.json().summary);
    expect(unblockedList.json().data.map((r: { id: string }) => r.id))
      .toEqual(beforeList.json().data.map((r: { id: string }) => r.id));
    const afterReply = await reply();
    expect(afterReply.statusCode, afterReply.body).toBe(200);
    expect(afterReply.json().data).toEqual({ ...beforeReply.json().data, respondedAt: expect.any(String) });
  });

  it('an author-side block keeps the list intact but prevents a reply and a notification', async () => {
    const beforeList = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
    const beforeReview = await app.prisma.rating.findUniqueOrThrow({ where: { id: ratingId } });
    const notesBefore = await app.prisma.notification.count({ where: { userId: customer.userId } });
    const block = await inject('POST', '/api/v1/blocks', { blockedUserId: owner.userId }, customer.token);
    expect(block.statusCode, block.body).toBe(201);
    try {
      const afterList = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
      expect(afterList.json()).toEqual(beforeList.json());
      const reply = await inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, { response: 'A new reply' }, owner.token);
      expect(reply.statusCode, reply.body).toBe(403);
      expect(reply.json().error.code).toBe('USER_BLOCKED');
      expect(await app.prisma.rating.findUniqueOrThrow({ where: { id: ratingId } })).toEqual(beforeReview);
      expect(await app.prisma.notification.count({ where: { userId: customer.userId } })).toBe(notesBefore);
    } finally {
      await inject('PUT', `/api/v1/blocks/${owner.userId}`, undefined, customer.token);
    }
  });

  it('list and reply dates expose only the Guyana calendar day, while the stored creation instant stays exact', async () => {
    for (const [instant, day] of [
      ['2026-10-07T03:59:59.987Z', '2026-10-06T04:00:00.000Z'],
      ['2026-10-07T04:00:00.123Z', '2026-10-07T04:00:00.000Z'],
    ] as const) {
      await app.prisma.rating.update({ where: { id: ratingId }, data: { createdAt: new Date(instant) } });
      const list = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
      expect(list.statusCode).toBe(200);
      expect(list.json().data.find((r: { id: string }) => r.id === publicVendorReviewId(ratingId)).createdAt).toBe(day);
      const reply = await inject('POST', `/api/v1/vendor/reviews/${ratingId}/respond`, { response: 'Thanks again.' }, owner.token);
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json().data.createdAt).toBe(day);
      const stored = await app.prisma.rating.findUniqueOrThrow({ where: { id: ratingId }, select: { createdAt: true } });
      expect(stored.createdAt.toISOString()).toBe(instant);
    }
  });
});

describe('Anonymous reviews across every public entry point', () => {
  it('the customer and guest feed cannot identify a reviewer through blocks, names, avatars or exact times', async () => {
    const url = `/api/v1/customer/vendors/${vendorId}/reviews`;
    const read = (token?: string) => inject('GET', url, undefined, token);
    const before = await read(owner.token);
    expect(before.statusCode).toBe(200);
    const block = await inject('POST', '/api/v1/blocks', { blockedUserId: customer.userId }, owner.token);
    expect(block.statusCode).toBe(201);
    try {
      const during = await read(owner.token);
      expect(during.statusCode).toBe(200);
      expect(during.json()).toEqual(before.json());
      const guest = await read();
      expect(guest.json()).toEqual(before.json());
      for (const row of guest.json().data.reviews) {
        expect(row.reviewer).toEqual({ firstName: 'Customer', avatar: null });
        expect(new Date(row.createdAt).toISOString().slice(11)).toBe('04:00:00.000Z');
      }
      expect(guest.body).not.toContain(customer.userId);
      expect(guest.body).not.toContain('Reply');
    } finally {
      await inject('PUT', `/api/v1/blocks/${customer.userId}`, undefined, owner.token);
    }
    expect((await read(owner.token)).json()).toEqual(before.json());
    // Another account or another active role is not an anonymity bypass.
    const other = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const alternateBefore = await read(other.token);
    expect((await inject('POST', '/api/v1/blocks', { blockedUserId: customer.userId }, other.token)).statusCode).toBe(201);
    try { expect((await read(other.token)).json()).toEqual(alternateBefore.json()); }
    finally { await inject('PUT', `/api/v1/blocks/${customer.userId}`, undefined, other.token); }
  });

  it('existing timestamp-bearing rating IDs are opaque on list, customer feed and reply, and the returned ID is usable', async () => {
    const instant = new Date('2026-10-07T14:07:31.123Z');
    const oldId = `c${instant.getTime().toString(36)}0123456789abcdef`;
    expect(new Date(parseInt(oldId.slice(1, 9), 36))).toEqual(instant);
    const author = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const existing = await app.prisma.rating.findUniqueOrThrow({ where: { id: ratingId } });
    await app.prisma.rating.create({ data: {
      id: oldId, orderId: existing.orderId, raterId: author.userId, vendorId,
      type: 'CUSTOMER_TO_VENDOR', score: 2, comment: 'Opaque identifier fixture', visibleAt: instant, createdAt: instant,
    } });
    const store = await inject('GET', '/api/v1/vendor/reviews', undefined, owner.token);
    const row = store.json().data.find((r: { comment: string }) => r.comment === 'Opaque identifier fixture');
    expect(row.id).toMatch(/^rv_[A-Za-z0-9_-]{43}$/);
    expect(row.id).not.toBe(oldId);
    expect(new Date(parseInt(row.id.slice(1, 9), 36))).not.toEqual(instant);
    expect(row.createdAt).toBe('2026-10-07T04:00:00.000Z');
    const publicFeed = await inject('GET', `/api/v1/customer/vendors/${vendorId}/reviews`);
    expect(publicFeed.json().data.reviews.find((r: { comment: string }) => r.comment === 'Opaque identifier fixture')).toMatchObject({ id: row.id, createdAt: row.createdAt });
    expect(store.body).not.toContain(oldId);
    expect(publicFeed.body).not.toContain(oldId);
    const reply = await inject('POST', `/api/v1/vendor/reviews/${row.id}/respond`, { response: 'Thanks for the feedback.' }, owner.token);
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json().data.id).toBe(row.id);
    expect(reply.body).not.toContain(oldId);
    expect((await app.prisma.rating.findUniqueOrThrow({ where: { id: oldId } })).response).toBe('Thanks for the feedback.');
    // Build 9 may have a cached old ID: accept it as an input, never emit it.
    const legacy = await inject('POST', `/api/v1/vendor/reviews/${oldId}/respond`, { response: 'Thanks again.' }, owner.token);
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json().data.id).toBe(row.id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const report = await inject('POST', `/api/v1/customer/ratings/${row.id}/report`, { reason: 'PRIVATE_INFO' }, owner.token);
      expect(report.statusCode, report.body).toBe(200);
      expect(report.json().data.ratingId).toBe(row.id);
      expect(report.body).not.toContain(oldId);
    }
    const generic = await inject('POST', '/api/v1/reports', { targetType: 'RATING', targetId: row.id, reason: 'OTHER' }, owner.token);
    expect(generic.statusCode, generic.body).toBe(201);
    expect(generic.body).not.toContain(oldId);
    expect(await app.prisma.contentReport.findFirst({ where: { reporterId: owner.userId, targetType: 'RATING', targetId: oldId } })).not.toBeNull();
  });
});
