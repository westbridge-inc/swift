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
import { purgeAuditLogs } from '../lib/audit-immutability';
import { CUSTOMER_RESCHEDULE_BEFORE_MIN, RESCHEDULE_WINDOW_CLOSED_CODE, RESCHEDULE_WINDOW_CLOSED_MESSAGE, customerRescheduleVerdict } from '../modules/booking/reschedule-policy';
import { APPOINTMENT_FREE_CANCEL_BEFORE_MIN } from '../modules/order/cancel-policy';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-S6a · owner A3/A4/B2 28 Oct 2026] What the customer app reads, behind
// INSTANT_BOOKING:
//  - the slots answer says whether a cash booking of the listing is confirmed
//    at checkout (instantConfirmation), for the item screen's badge;
//  - the customer order detail projects the live booking behind an
//    appointment (appointmentBooking) and whether the customer may move it now;
//  - the customer's move is refused inside two hours of the start, with the
//    words the preview showed (one predicate: booking/reschedule-policy.ts).
//    The business may still move it.
// With the switch OFF the answers are today's (no new keys) and the move
// route behaves as before. Real mounted routes, real PostgreSQL, LIFECYCLE_V2 on.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920866nnn): no other file uses it.
const PHONE_PREFIX = '+5920867';
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
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `S6a-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `s6a-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}
const customer = (name = 'Cy') => makeUser(name, ['CUSTOMER'], 'CUSTOMER');

const everyHour = { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '24:00' })) };
type Business = { owner: Actor; vendorId: string; instantId: string; requestId: string; categoryId: string };

/** A Services store with two 60-minute listings bookable every hour: one that
 *  confirms bookings automatically, one where the business confirms. */
async function makeBusiness(name: string): Promise<Business> {
  const owner = await makeUser(`${name}Owner`, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const v = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `S6a ${name}`, slug: `s6a-${name.toLowerCase()}-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}${String(900 - vendorIds.length).padStart(3, '0')}`, addressLine1: '7 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      // MMG by the store's pay link only (no phone number fixture needed).
      mmgPayUrl: 'https://pay.example.com/pay/s6a-studio',
    },
  });
  vendorIds.push(v.id);
  const category = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Chair', sortOrder: 0 } });
  const instantId = (await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `S6a ${name} Cut`, basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: { ...everyHour, instantBooking: true } },
  })).id;
  const requestId = (await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `S6a ${name} Colour`, basePrice: 3000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: { ...everyHour } },
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
const liveBookingOf = (orderId: string) => app.prisma.booking.findFirstOrThrow({ where: { orderId, status: { not: 'CANCELLED' } } });
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
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:book-s6a customer-app fixtures');
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

// ── helpers ─────────────────────────────────────────────────────────────────

const slotsOf = async (who: Actor, itemId: string, day: string) => {
  const res = await call('GET', `/api/v1/customer/items/${itemId}/slots?date=${day}`, who.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown>;
};
const detail = async (who: Actor, orderId: string) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, who.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown> & {
    appointmentBooking?: { id: string; itemId: string; slotStart: string; reschedule: { allowed: boolean; message: string | null } } | null;
  };
};
const customerMove = (who: Actor, bookingId: string, to: Date) =>
  call('POST', `/api/v1/customer/bookings/${bookingId}/reschedule`, who.token, { newSlotStart: to.toISOString() });
const businessMove = (owner: Actor, bookingId: string, to: Date) =>
  call('POST', `/api/v1/vendor/bookings/${bookingId}/reschedule`, owner.token, { newSlotStart: to.toISOString() });
/** Put a booking (and its order's time) this many minutes from now, as the clock would. */
async function startsIn(orderId: string, minutes: number) {
  const start = new Date(Date.now() + minutes * MIN);
  const b = await liveBookingOf(orderId);
  await app.prisma.booking.update({ where: { id: b.id }, data: { slotStart: start, slotEnd: new Date(start.getTime() + 60 * MIN) } });
  await app.prisma.order.update({ where: { id: orderId }, data: { appointmentSlot: start } });
  return start;
}

// ── the rule ────────────────────────────────────────────────────────────────

describe('[BOOK-S6a · owner B2] the customer reschedule rule', () => {
  it('is the free-cancel cut-off: two hours before the start', () => {
    expect(CUSTOMER_RESCHEDULE_BEFORE_MIN).toBe(APPOINTMENT_FREE_CANCEL_BEFORE_MIN);
    expect(CUSTOMER_RESCHEDULE_BEFORE_MIN).toBe(120);
    const start = new Date('2026-12-01T14:00:00.000Z');
    expect(customerRescheduleVerdict(start, new Date(start.getTime() - 121 * MIN))).toEqual({ allowed: true, code: null, message: null });
    expect(customerRescheduleVerdict(start, new Date(start.getTime() - 120 * MIN))).toEqual({ allowed: false, code: RESCHEDULE_WINDOW_CLOSED_CODE, message: RESCHEDULE_WINDOW_CLOSED_MESSAGE });
    expect(RESCHEDULE_WINDOW_CLOSED_MESSAGE).toBe('This booking can no longer be moved in the app: it starts in less than 2 hours. Contact the provider to change it.');
  });
});

// ── switch OFF: today ───────────────────────────────────────────────────────

describe('[BOOK-S6a] switch OFF — the answers are today\'s', () => {
  it('the slots answer carries no instantConfirmation, even for a listing that stores the setting', async () => {
    const a = await customer('Ola');
    const data = await slotsOf(a, shop.instantId, gyDay(3));
    expect(Object.keys(data).sort()).toEqual(['bookableWeekdays', 'date', 'durationMinutes', 'serviceMode', 'serviceRadiusKm', 'slots']);
  });

  it('the order detail carries no appointmentBooking, and the customer\'s move is not cut off (as before)', async () => {
    const a = await customer('Pat');
    const order = await booked(a, shop.requestId, nextSlot());
    expect((await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, shop.owner.token, {})).statusCode).toBe(200);
    expect('appointmentBooking' in (await detail(a, order.id))).toBe(false);
    await startsIn(order.id, 90);
    const res = await customerMove(a, (await liveBookingOf(order.id)).id, nextSlot());
    expect(res.statusCode, res.body).toBe(200);
  });
});

// ── switch ON ───────────────────────────────────────────────────────────────

describe('[BOOK-S6a · owner A3/A4] switch ON — the slots answer says whether a cash booking is confirmed at once', () => {
  it('an automatic listing: instantConfirmation true; a listing the business confirms: false', async () => {
    on();
    const a = await customer('Quin');
    expect((await slotsOf(a, shop.instantId, gyDay(3)))['instantConfirmation']).toBe(true);
    expect((await slotsOf(a, shop.requestId, gyDay(3)))['instantConfirmation']).toBe(false);
  });

  it('the badge\'s word agrees with checkout: the automatic listing comes back ACCEPTED, the other PENDING', async () => {
    on();
    expect((await booked(await customer('Ray'), shop.instantId, nextSlot())).status).toBe('ACCEPTED');
    expect((await booked(await customer('Sol'), shop.requestId, nextSlot())).status).toBe('PENDING');
  });
});

describe('[BOOK-S6a · owner B2] switch ON — the order screen projects the booking and the move it allows; preview = result', () => {
  it('a confirmed booking days ahead: projected, movable; the customer moves it and the screen shows the new booking', async () => {
    on();
    const a = await customer('Tam');
    const order = await booked(a, shop.instantId, nextSlot());
    const before = await liveBookingOf(order.id);
    const view = (await detail(a, order.id)).appointmentBooking;
    expect(view).toEqual({ id: before.id, itemId: shop.instantId, slotStart: before.slotStart.toISOString(), reschedule: { allowed: true, message: null } });
    const to = nextSlot();
    const res = await customerMove(a, before.id, to);
    expect(res.statusCode, res.body).toBe(200);
    const after = (await detail(a, order.id)).appointmentBooking!;
    expect(after.slotStart).toBe(to.toISOString());
    expect(after.id).not.toBe(before.id);
    expect(after.reschedule).toEqual({ allowed: true, message: null });
    expect((await detail(a, order.id))['appointmentSlot']).toBe(to.toISOString());
  });

  it('inside two hours: the preview says no in the move\'s own words, the move is refused, nothing changes — and the business can still move it', async () => {
    on();
    const biz = await makeBusiness('Late');
    const a = await customer('Uma');
    const order = await booked(a, biz.instantId, nextSlot());
    const start = await startsIn(order.id, 90);
    const view = (await detail(a, order.id)).appointmentBooking!;
    expect(view.reschedule).toEqual({ allowed: false, message: RESCHEDULE_WINDOW_CLOSED_MESSAGE });
    const booking = await liveBookingOf(order.id);
    const res = await customerMove(a, booking.id, nextSlot());
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: RESCHEDULE_WINDOW_CLOSED_CODE, message: view.reschedule.message });
    expect(await bookingsOf(order.id)).toEqual([{ id: booking.id, status: 'CONFIRMED', slotStart: start }]);
    // The business may move it at any time (B2: "the business can reschedule too").
    const moved = await businessMove(biz.owner, booking.id, nextSlot());
    expect(moved.statusCode, moved.body).toBe(200);
  });

  it('a request (reserved at checkout, the business has not accepted): projected and movable', async () => {
    on();
    const a = await customer('Val');
    const order = await booked(a, shop.requestId, nextSlot());
    expect(order.status).toBe('PENDING');
    const view = (await detail(a, order.id)).appointmentBooking!;
    expect(view).toMatchObject({ itemId: shop.requestId, reschedule: { allowed: true, message: null } });
    expect((await customerMove(a, view.id, nextSlot())).statusCode).toBe(200);
  });

  it('a cancelled booking: appointmentBooking is null (nothing to move)', async () => {
    on();
    const a = await customer('Wes');
    const order = await booked(a, shop.instantId, nextSlot());
    expect((await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, a.token, {})).statusCode).toBe(200);
    expect((await detail(a, order.id)).appointmentBooking).toBeNull();
  });

  it('a finished appointment whose booking was left live: not offered, and the move refuses it too', async () => {
    on();
    const a = await customer('Zed');
    const order = await booked(a, shop.instantId, nextSlot());
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED' } });
    const view = (await detail(a, order.id)).appointmentBooking!;
    expect(view.reschedule).toEqual({ allowed: false, message: null });
    const res = await customerMove(a, view.id, nextSlot());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('NOT_RESCHEDULABLE');
  });

  it('another customer never sees or moves it (the order and the booking stay the customer\'s own)', async () => {
    on();
    const a = await customer('Xan');
    const order = await booked(a, shop.instantId, nextSlot());
    const intruder = await customer('Yul');
    expect((await call('GET', `/api/v1/customer/orders/${order.id}`, intruder.token)).statusCode).toBe(404);
    expect((await customerMove(intruder, (await liveBookingOf(order.id)).id, nextSlot())).statusCode).toBe(404);
  });
});
