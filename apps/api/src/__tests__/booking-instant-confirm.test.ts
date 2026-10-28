import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { INSTANT_CONFIRM_NOTE } from '../modules/booking/instant-booking';
import { APPOINTMENT_FREE_CANCEL_BEFORE_MIN } from '../modules/order/cancel-policy';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { DARK_FEATURES } from '../modules/ops/dark-features';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-S3 · owner rulings 28 Oct 2026 A3, A4, B1, C2] INSTANT CONFIRM, behind
// INSTANT_BOOKING.
//
// A business chooses, per bookable service, "Confirm bookings automatically"
// (bookingConfig.instantBooking; new bookable services start ON, with two
// hours' minimum notice). With the switch ON, a CASH booking of such a listing
// is reserved AND confirmed in the checkout's own commit: the booking is
// CONFIRMED and the order moves PENDING -> ACCEPTED through the canonical
// transition, as the business's standing acceptance (changedBy 'system', the
// status log naming the listing's setting). It is given only by a business
// that could accept the booking itself at that moment; otherwise there is no
// order at all. The business is TOLD ("New booking (confirmed)"), never asked
// to accept. An MMG booking stays "the business confirms" (A3).
//
// [B1] With the switch ON an appointment cancels free until two hours before
// it starts (never less than the one-minute window after it is confirmed);
// the preview and the cancel give the same answer.
//
// [REVIEW-G S4-2 on #2192] A request placed while the switch was OFF and
// accepted after it is ON takes its booking under the per-customer cap.
//
// With the switch OFF everything is today's behaviour (the control cases).
// Real mounted routes, real PostgreSQL, LIFECYCLE_V2 on.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920866nnn): no other file uses it.
const PHONE_PREFIX = '+5920866';
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;

let app: FastifyInstance;
let seq = 0;
const userIds: string[] = [];
const vendorIds: string[] = [];

type Actor = { userId: string; token: string };

function gyDay(offset: number): string {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
}
/** The TRUE instant of a Guyana wall-clock time on that date. */
function gy(dayKey: string, hour: number, minute = 0): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d!, hour, minute)));
}
/** Each case books its own hour, days ahead, so no case meets another's booking. */
let hourSeq = 0;
function nextSlot(): Date {
  hourSeq += 1;
  return gy(gyDay(3 + Math.floor(hourSeq / 20)), 2 + (hourSeq % 20), 0);
}

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `S3-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `s3-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}
const customer = (name = 'Cy') => makeUser(name, ['CUSTOMER'], 'CUSTOMER');

const everyHour = { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '24:00' })) };
/** What a business can save through the API (the editor's times end at 23:59). */
const apiHours = { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '08:00', end: '18:00' })) };

type Business = { owner: Actor; vendorId: string; instantId: string; requestId: string; categoryId: string };

/** A Services store with two 60-minute listings bookable every hour: one that
 *  confirms bookings automatically, one where the business confirms. */
async function makeBusiness(name: string, extra: { serviceMode?: 'AT_BUSINESS' | 'MOBILE' } = {}): Promise<Business> {
  const owner = await makeUser(`${name}Owner`, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const v = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `S3 ${name}`, slug: `s3-${name.toLowerCase()}-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}${String(900 - vendorIds.length).padStart(3, '0')}`, addressLine1: '7 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      // MMG by the store's pay link only (no phone number fixture needed).
      mmgPayUrl: 'https://pay.example.com/pay/s3-studio',
    },
  });
  vendorIds.push(v.id);
  const category = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Chair', sortOrder: 0 } });
  const mode = extra.serviceMode ? { serviceMode: extra.serviceMode } : {};
  const instantId = (await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `S3 ${name} Cut`, basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: { ...everyHour, ...mode, instantBooking: true } },
  })).id;
  const requestId = (await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `S3 ${name} Colour`, basePrice: 3000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: { ...everyHour, ...mode } },
  })).id;
  return { owner, vendorId: v.id, instantId, requestId, categoryId: category.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** The build-9 checkout body, word for word: an empty cart, the listing, checkout with the slot. */
async function book(who: Actor, itemId: string, slot: Date, payment: Record<string, unknown> = { paymentMethod: 'CASH' }) {
  expect((await call('DELETE', '/api/v1/customer/cart', who.token)).statusCode).toBe(200);
  const { vendorId: itemVendorId } = await app.prisma.item.findUniqueOrThrow({ where: { id: itemId }, select: { vendorId: true } });
  const added = await call('POST', '/api/v1/customer/cart/items', who.token, { vendorId: itemVendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  return call('POST', '/api/v1/customer/checkout', who.token, { ...payment, appointments: [{ itemId, slotStart: slot.toISOString() }] });
}
async function booked(who: Actor, itemId: string, slot: Date): Promise<{ id: string; status: string }> {
  const res = await book(who, itemId, slot);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.order as { id: string; status: string };
}
const bookingsOf = (orderId: string) => app.prisma.booking.findMany({ where: { orderId }, select: { id: true, status: true, slotStart: true } });
const orderRow = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id } });
const ordersOf = (who: Actor) => app.prisma.order.count({ where: { customerId: who.userId } });
const liveAt = (vendorId: string, slot: Date) => app.prisma.booking.count({ where: { vendorId, slotStart: slot, status: { not: 'CANCELLED' } } });
const outboxKinds = async (orderId: string) => (await app.prisma.orderOutbox.findMany({ where: { orderId }, select: { kind: true } })).map((r) => r.kind).sort();
const noticesFor = (userId: string, orderId: string) => app.prisma.$queryRaw<Array<{ title: string; body: string; data: Record<string, unknown> }>>`
  SELECT title, body, data FROM "notifications" WHERE "userId" = ${userId} AND "data"->>'orderId' = ${orderId} ORDER BY "createdAt"`;
/** Notifications are best-effort after the commit: wait until the expected count landed. */
async function settledNotices(userId: string, orderId: string, atLeast: number) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await noticesFor(userId, orderId);
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The shape of a JSON answer: every key, nested, with the kind of each leaf (never its value). */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]));
  }
  return typeof value;
}

const on = () => vi.stubEnv('INSTANT_BOOKING', '1');
const off = () => vi.stubEnv('INSTANT_BOOKING', '');

let shop: Business;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  vi.stubEnv('LIFECYCLE_V2', '1');

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  shop = await makeBusiness('Studio');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('LIFECYCLE_V2', '1');
  off();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:book-s3 instant-confirm fixtures');
  if (orderIds.length > 0) {
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: userIds } }] } });
  await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.booking.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

// ── switch OFF: today ──────────────────────────────────────────────────────

describe('[BOOK-S3] switch OFF — checkout is exactly today, whatever a listing stores', () => {
  it('a listing that stores "confirm automatically" (set while ON) is still a request: PENDING, no booking, the accept alert and auto-cancel armed, "will confirm shortly"', async () => {
    const slot = nextSlot();
    const a = await customer('Ada');
    const instant = await book(a, shop.instantId, slot);
    const request = await book(await customer('Abe'), shop.requestId, nextSlot());
    expect(instant.statusCode, instant.body).toBe(200);
    expect(request.statusCode, request.body).toBe(200);
    // The same answer, field for field, as a listing that never had the setting.
    expect(shapeOf(instant.json())).toEqual(shapeOf(request.json()));
    const answer = instant.json().data;
    expect(answer.order.status).toBe('PENDING');
    expect(answer.message).toBe(`Order placed! S3 Studio will confirm shortly.`);
    const row = await orderRow(answer.order.id);
    expect(row).toMatchObject({ status: 'PENDING', acceptedAt: null, holdExpiresAt: null });
    expect(await bookingsOf(row.id)).toEqual([]);
    expect(await outboxKinds(row.id)).toEqual(['auto-cancel', 'vendor-alert-escalate']);
    const told = await settledNotices(shop.owner.userId, row.id, 1);
    expect(told.map((n) => n.title)).toEqual(['New Order!']);
    expect(told[0]!.data).toMatchObject({ kind: 'vendor_order_alert', status: 'PENDING' });
  });

  it('no listing can be set to confirm automatically: a save asking for it is refused; one without it stores nothing new', async () => {
    const refused = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S3 Off Trim', basePrice: 1000, fulfillment: 'APPOINTMENT',
      bookingConfig: { ...apiHours, instantBooking: true },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'INSTANT_BOOKING_OFF', message: 'Confirming bookings automatically is not available yet. Bookings wait for you to accept them.' });
    const plain = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S3 Off Shave', basePrice: 1000, fulfillment: 'APPOINTMENT', bookingConfig: { ...apiHours, instantBooking: false },
    });
    expect(plain.statusCode, plain.body).toBe(200);
    const stored = (await app.prisma.item.findUniqueOrThrow({ where: { id: plain.json().data.id } })).bookingConfig as Record<string, unknown>;
    expect(stored).toEqual(apiHours);
  });
});

// ── switch ON: instant confirm ─────────────────────────────────────────────

describe('[BOOK-S3] switch ON — a cash booking of an automatic listing is confirmed in the checkout commit', () => {
  it('ACCEPTED + CONFIRMED in one commit: the standing acceptance is the system\'s, its note names the listing\'s setting; the answer says confirmed', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Bea');
    const res = await book(a, shop.instantId, slot);
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json().data;
    expect(answer.order.status).toBe('ACCEPTED');
    expect(answer.message).toBe('Booking confirmed with S3 Studio.');
    const row = await orderRow(answer.order.id);
    expect(row.status).toBe('ACCEPTED');
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(await bookingsOf(row.id)).toEqual([expect.objectContaining({ status: 'CONFIRMED', slotStart: slot })]);
    const logs = await app.prisma.orderStatusLog.findMany({ where: { orderId: row.id }, orderBy: { createdAt: 'asc' }, select: { status: true, changedBy: true, note: true } });
    expect(logs).toEqual([
      { status: 'PENDING', changedBy: a.userId, note: 'Order placed' },
      { status: 'ACCEPTED', changedBy: 'system', note: INSTANT_CONFIRM_NOTE },
    ]);
    expect(INSTANT_CONFIRM_NOTE).toContain('bookingConfig.instantBooking');
  });

  it('the business is TOLD, never asked: "New booking (confirmed)" on its order desk, no accept alert, no ladder, no auto-cancel', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Cal');
    const order = await booked(a, shop.instantId, slot);
    expect(await outboxKinds(order.id)).toEqual([]);
    expect(await app.prisma.alertDelivery.count({ where: { subjectId: order.id } })).toBe(0);
    const told = await settledNotices(shop.owner.userId, order.id, 1);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe('New booking (confirmed)');
    expect(told[0]!.body).toMatch(/^S3 Studio Cut, .+ \(booking .+\)\. Already confirmed — nothing to accept\.$/);
    // No kind: every phone build opens a business push with an orderId on VendorOrderDetail.
    expect(told[0]!.data).toMatchObject({ orderId: order.id, status: 'ACCEPTED', audience: 'business', instantBooking: true });
    expect(told[0]!.data['kind']).toBeUndefined();
    const customerTold = await settledNotices(a.userId, order.id, 1);
    expect(customerTold.map((n) => n.title)).toEqual(['Booking confirmed']);
    // The accept door has nothing left to do.
    const again = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, shop.owner.token, {});
    expect(again.statusCode).toBe(400);
  });

  it('atomic: a failure after the standing acceptance rolls the whole checkout back — no order, no booking', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Dee');
    const real = OrderService.prototype.stageCanonicalOrderTransition;
    vi.spyOn(OrderService.prototype, 'stageCanonicalOrderTransition').mockImplementationOnce(async function (this: OrderService, ...args: Parameters<typeof real>) {
      await real.apply(this, args);
      throw new Error('injected after the standing acceptance');
    });
    const res = await book(a, shop.instantId, slot);
    expect(res.statusCode).toBe(500);
    expect(await ordersOf(a)).toBe(0);
    expect(await liveAt(shop.vendorId, slot)).toBe(0);
  });

  it('MMG stays "the business confirms" (A3): PENDING, the slot RESERVED, the accept alert armed', async () => {
    on();
    vi.stubEnv('STORE_MMG_PAY_LINK', '1');
    vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
    const slot = nextSlot();
    const res = await book(await customer('Eli'), shop.instantId, slot, { paymentMethod: 'MOBILE_MONEY' });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().data.order.id as string;
    expect((await orderRow(id)).status).toBe('PENDING');
    expect(await bookingsOf(id)).toEqual([expect.objectContaining({ status: 'RESERVED' })]);
    expect(await outboxKinds(id)).toEqual(['auto-cancel', 'vendor-alert-escalate']);
  });

  it('control: a listing where the business confirms is a request (PENDING + RESERVED), as in S2', async () => {
    on();
    const order = await booked(await customer('Fen'), shop.requestId, nextSlot());
    expect(order.status).toBe('PENDING');
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'RESERVED' })]);
  });
});

describe('[BOOK-S3] the standing acceptance is given only by a business that could accept the booking itself', () => {
  it('an unverified business (documents lapsed): 409 in the customer\'s words and NO order; switch OFF it is still a request, as today', async () => {
    const lapsed = await makeBusiness('Lapsed');
    await app.prisma.vendor.update({ where: { id: lapsed.vendorId }, data: { isVerified: false } });
    on();
    const slot = nextSlot();
    const a = await customer('Gil');
    const res = await book(a, lapsed.instantId, slot);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'BUSINESS_CANNOT_CONFIRM_BOOKINGS',
      message: "S3 Lapsed can't take bookings right now, so this time can't be booked. Please try again later.",
    });
    expect(await ordersOf(a)).toBe(0);
    expect(await liveAt(lapsed.vendorId, slot)).toBe(0);
    off();
    const today = await booked(a, lapsed.instantId, slot);
    expect(today.status).toBe('PENDING');
  });

  it('a business on a weekly-fee hold (suspended by billing): refused, NO order', async () => {
    const held = await makeBusiness('Held');
    on();
    const a = await customer('Hob');
    // The cart was filled while the business was open; the hold lands before checkout.
    expect((await call('DELETE', '/api/v1/customer/cart', a.token)).statusCode).toBe(200);
    expect((await call('POST', '/api/v1/customer/cart/items', a.token, { vendorId: held.vendorId, itemId: held.instantId, quantity: 1 })).statusCode).toBe(201);
    await app.prisma.vendor.update({ where: { id: held.vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'BILLING' } });
    const res = await call('POST', '/api/v1/customer/checkout', a.token, { paymentMethod: 'CASH', appointments: [{ itemId: held.instantId, slotStart: nextSlot().toISOString() }] });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await ordersOf(a)).toBe(0);
  });

  it('a home visit whose owner holds no approved police clearance is refused, NO order (instant does not skip it)', async () => {
    const visits = await makeBusiness('Visits', { serviceMode: 'MOBILE' });
    on();
    const a = await customer('Ida');
    const res = await book(a, visits.instantId, nextSlot());
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
    expect(await ordersOf(a)).toBe(0);
  });
});

describe('[BOOK-S3] races', () => {
  it('PARALLEL, on real PostgreSQL: instant and request checkouts for one time at one business — exactly one winner, and it is whole', async () => {
    on();
    const slot = nextSlot();
    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => customer(`Racer${i}`)));
    for (const [i, r] of racers.entries()) {
      expect((await call('DELETE', '/api/v1/customer/cart', r.token)).statusCode).toBe(200);
      const itemId = i % 2 === 0 ? shop.instantId : shop.requestId;
      expect((await call('POST', '/api/v1/customer/cart/items', r.token, { vendorId: shop.vendorId, itemId, quantity: 1 })).statusCode).toBe(201);
    }
    const results = await Promise.all(racers.map((r, i) => call('POST', '/api/v1/customer/checkout', r.token, {
      paymentMethod: 'CASH', appointments: [{ itemId: i % 2 === 0 ? shop.instantId : shop.requestId, slotStart: slot.toISOString() }],
    })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, results.map((r) => r.body).join('\n')).toEqual([200, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json().error.code).toBe('SLOT_TAKEN');
    const winners = await app.prisma.order.findMany({ where: { customerId: { in: racers.map((r) => r.userId) } }, include: { items: true } });
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    const instantWon = winner.items[0]!.itemId === shop.instantId;
    expect(winner.status).toBe(instantWon ? 'ACCEPTED' : 'PENDING');
    expect(await bookingsOf(winner.id)).toEqual([expect.objectContaining({ status: instantWon ? 'CONFIRMED' : 'RESERVED' })]);
    expect(await liveAt(shop.vendorId, slot)).toBe(1);
  });
});

describe('[BOOK-S3] races (all automatic)', () => {
  it('PARALLEL, on real PostgreSQL: five instant checkouts for one time — one ACCEPTED + CONFIRMED order, four 409 with no order', async () => {
    on();
    const slot = nextSlot();
    const racers = await Promise.all(Array.from({ length: 5 }, (_, i) => customer(`Dash${i}`)));
    for (const r of racers) {
      expect((await call('DELETE', '/api/v1/customer/cart', r.token)).statusCode).toBe(200);
      expect((await call('POST', '/api/v1/customer/cart/items', r.token, { vendorId: shop.vendorId, itemId: shop.instantId, quantity: 1 })).statusCode).toBe(201);
    }
    const results = await Promise.all(racers.map((r) => call('POST', '/api/v1/customer/checkout', r.token, {
      paymentMethod: 'CASH', appointments: [{ itemId: shop.instantId, slotStart: slot.toISOString() }],
    })));
    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join('\n')).toEqual([200, 409, 409, 409, 409]);
    const winners = await app.prisma.order.findMany({ where: { customerId: { in: racers.map((r) => r.userId) } } });
    expect(winners.map((o) => o.status)).toEqual(['ACCEPTED']);
    expect(await bookingsOf(winners[0]!.id)).toEqual([expect.objectContaining({ status: 'CONFIRMED' })]);
    expect(await liveAt(shop.vendorId, slot)).toBe(1);
  });
});

// ── B1: appointments cancel free until two hours before ────────────────────

/** Move a confirmed booking's time (and its acceptance) relative to now, as the clock would. */
async function placeInTime(orderId: string, startsInMin: number, acceptedMinAgo: number) {
  await app.prisma.order.update({
    where: { id: orderId },
    data: { appointmentSlot: new Date(Date.now() + startsInMin * MIN), acceptedAt: new Date(Date.now() - acceptedMinAgo * MIN) },
  });
}
const preview = async (who: Actor, orderId: string) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, who.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { canCancel: boolean; freeCancellationExpiresAt: string | null; cancelUnavailable: { code: string; message: string } | null };
};
const cancel = (who: Actor, orderId: string) => call('POST', `/api/v1/customer/orders/${orderId}/cancel`, who.token, {});

describe('[BOOK-S3 · owner B1] switch ON — an appointment cancels free until 2 hours before it starts; preview = result', () => {
  it('the rule is two hours', () => {
    expect(APPOINTMENT_FREE_CANCEL_BEFORE_MIN).toBe(120);
  });

  it('confirmed 10 minutes ago, starts in 3 hours: free — the preview offers it until 2 hours before, and the cancel succeeds and frees the time', async () => {
    on();
    const a = await customer('Jem');
    const order = await booked(a, shop.instantId, nextSlot());
    await placeInTime(order.id, 180, 10);
    const view = await preview(a, order.id);
    const slot = (await orderRow(order.id)).appointmentSlot!;
    expect(view).toMatchObject({ canCancel: true, cancelUnavailable: null });
    expect(view.freeCancellationExpiresAt).toBe(new Date(slot.getTime() - 120 * MIN).toISOString());
    const res = await cancel(a, order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
  });

  it('starts in 90 minutes, confirmed 10 minutes ago: refused — the preview\'s refusal is the cancel\'s, word for word', async () => {
    on();
    const a = await customer('Kit');
    const order = await booked(a, shop.instantId, nextSlot());
    await placeInTime(order.id, 90, 10);
    const view = await preview(a, order.id);
    expect(view.canCancel).toBe(false);
    expect(view.cancelUnavailable).toMatchObject({
      code: 'CANCEL_WINDOW_CLOSED',
      message: 'This booking can no longer be cancelled in the app: it starts in less than 2 hours. Contact the provider to change or cancel it.',
    });
    const res = await cancel(a, order.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: view.cancelUnavailable!.code, message: view.cancelUnavailable!.message });
    expect((await orderRow(order.id)).status).toBe('ACCEPTED');
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CONFIRMED' })]);
  });

  it('booked close to its time: still free for the first minute after it is confirmed (never less than today)', async () => {
    on();
    const a = await customer('Lia');
    const order = await booked(a, shop.instantId, nextSlot());
    await placeInTime(order.id, 90, 0);
    expect((await preview(a, order.id)).canCancel).toBe(true);
    expect((await cancel(a, order.id)).statusCode).toBe(200);
  });

  it('a booking the BUSINESS confirmed follows the same rule', async () => {
    on();
    const a = await customer('Mo');
    const order = await booked(a, shop.requestId, nextSlot());
    expect((await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, shop.owner.token, {})).statusCode).toBe(200);
    await placeInTime(order.id, 180, 10);
    expect((await preview(a, order.id)).canCancel).toBe(true);
    expect((await cancel(a, order.id)).statusCode).toBe(200);
  });

  it('control, switch OFF: today\'s one-minute window — confirmed 10 minutes ago, 3 hours ahead, refused in today\'s words', async () => {
    const a = await customer('Ned');
    const order = await booked(a, shop.requestId, nextSlot());
    expect((await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, shop.owner.token, {})).statusCode).toBe(200);
    await placeInTime(order.id, 180, 10);
    const view = await preview(a, order.id);
    expect(view.canCancel).toBe(false);
    expect(view.cancelUnavailable?.message).toBe('This booking can no longer be cancelled in the app: the 1-minute cancellation window has passed. Contact the provider to change or cancel it.');
    const res = await cancel(a, order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(view.cancelUnavailable!.message);
  });
});

// ── REVIEW-G S4-2: a legacy request accepted after the switch is on ─────────

describe('[BOOK-S3 · REVIEW-G S4-2 on #2192] a request placed while OFF and accepted while ON stays inside the cap', () => {
  it('the customer already holds 2 upcoming bookings with the business: the accept is refused in the business\'s words, the request stays PENDING with no booking', async () => {
    const a = await customer('Ola');
    const legacy = await booked(a, shop.requestId, nextSlot()); // switch OFF: a request, no booking
    expect(await bookingsOf(legacy.id)).toEqual([]);
    on();
    await booked(a, shop.instantId, nextSlot());
    await booked(a, shop.instantId, nextSlot());
    const res = await call('PUT', `/api/v1/vendor/orders/${legacy.id}/accept`, shop.owner.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'BOOKING_LIMIT_REACHED',
      message: 'This customer already has 2 upcoming bookings with your business, the most one customer can hold. Decline this request, or accept it after one of them is done or cancelled.',
    });
    expect((await orderRow(legacy.id)).status).toBe('PENDING');
    expect(await bookingsOf(legacy.id)).toEqual([]);
  });

  it('[F S4 · privacy] over the TOTAL cap: the business is not told how many bookings the customer holds with other businesses', async () => {
    const [b, c] = [await makeBusiness('Other1'), await makeBusiness('Other2')];
    const a = await customer('Rex');
    const legacy = await booked(a, shop.requestId, nextSlot()); // switch OFF: a request, no booking
    on();
    for (const itemId of [b.instantId, b.instantId, c.instantId, c.instantId, shop.instantId]) await booked(a, itemId, nextSlot());
    const res = await call('PUT', `/api/v1/vendor/orders/${legacy.id}/accept`, shop.owner.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'BOOKING_LIMIT_REACHED',
      message: 'This customer already has the most upcoming bookings one customer can hold. Decline this request, or accept it after one of them is done or cancelled.',
    });
    expect(res.json().error.message).not.toMatch(/\d/);
    expect((await orderRow(legacy.id)).status).toBe('PENDING');
  });

  it('under the cap, the legacy request is accepted and booked (CONFIRMED)', async () => {
    const a = await customer('Pia');
    const legacy = await booked(a, shop.requestId, nextSlot());
    on();
    const res = await call('PUT', `/api/v1/vendor/orders/${legacy.id}/accept`, shop.owner.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(await bookingsOf(legacy.id)).toEqual([expect.objectContaining({ status: 'CONFIRMED' })]);
  });

  it('control, switch OFF: no cap at accept (today)', async () => {
    const a = await customer('Quy');
    const orders = [await booked(a, shop.requestId, nextSlot()), await booked(a, shop.requestId, nextSlot()), await booked(a, shop.requestId, nextSlot())];
    for (const o of orders) expect((await call('PUT', `/api/v1/vendor/orders/${o.id}/accept`, shop.owner.token, {})).statusCode).toBe(200);
  });
});

// ── listing settings (A4, C2) ─────────────────────────────────────────────

describe('[BOOK-S3 · owner A4/C2] switch ON — a new bookable service starts as automatic, with 2 hours\' notice', () => {
  it('a new listing that does not name them stores instantBooking true and minNoticeMinutes 120; named values are kept', async () => {
    on();
    const fresh = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S3 New Trim', basePrice: 1000, fulfillment: 'APPOINTMENT', bookingConfig: apiHours,
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: fresh.json().data.id } })).bookingConfig).toEqual({ ...apiHours, instantBooking: true, minNoticeMinutes: 120 });
    const chosen = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S3 New Wash', basePrice: 1000, fulfillment: 'APPOINTMENT', bookingConfig: { ...apiHours, instantBooking: false, minNoticeMinutes: 0 },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: chosen.json().data.id } })).bookingConfig).toEqual({ ...apiHours, instantBooking: false, minNoticeMinutes: 0 });
  });

  it('a listing that is already bookable keeps its setting when an app that does not know it saves (build 9)', async () => {
    on();
    const created = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S3 Kept', basePrice: 1000, fulfillment: 'APPOINTMENT', bookingConfig: { ...apiHours, instantBooking: false },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.id as string;
    const saved = await call('PUT', `/api/v1/vendor/items/${id}`, shop.owner.token, { bookingConfig: { ...apiHours, durationMinutes: 30 } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id } })).bookingConfig).toEqual({ ...apiHours, durationMinutes: 30, instantBooking: false, minNoticeMinutes: 120 });
  });
});

describe('[BOOK-S3 · COORD 18:14Z] what must land before the switch goes ON is written on the switch', () => {
  it('the dark-feature entry names the hair/beauty certificate gate, the phone popup branch, and the Terms wording', () => {
    const entry = DARK_FEATURES.find((f) => f.setting === 'INSTANT_BOOKING');
    expect(entry?.whileOff).toContain('hair and beauty');
    expect(entry?.whileOff).toContain('Booking requested');
    expect(entry?.whileOff).toContain('Terms');
  });
});

describe('[BOOK-S3 · REVIEW-G S4-1 on #2192] the dead legacy cleanup is gone', () => {
  it('OrderService.applyCancellationSideEffects no longer exists (it had no caller)', () => {
    expect('applyCancellationSideEffects' in OrderService.prototype).toBe(false);
  });
});
