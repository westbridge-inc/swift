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
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-S5a · owner A4/B2/C1/C2 28 Oct 2026] What the partner app reads and
// saves for a Services business:
//  - the profile says, per Services store, whether "Confirm bookings
//    automatically" can be chosen (instantBookingAvailable, only while
//    INSTANT_BOOKING is on);
//  - the editor's save (hours per day with a break, the gap after each
//    booking, the minimum notice, the setting) is stored as sent, and a save
//    from an app that does not know them keeps them;
//  - the Schedule's bookings name their listing (itemId), so "Move" can offer
//    its free times, and the business's move lands;
//  - "how many bookings at once" saves and reads back.
// Real mounted routes, real PostgreSQL.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920866nnn): no other file uses it.
const PHONE_PREFIX = '+5920868';
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
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `S5a-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `s5a-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
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
      ownerId: vo.id, name: `S5a ${name}`, slug: `s5a-${name.toLowerCase()}-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}${String(900 - vendorIds.length).padStart(3, '0')}`, addressLine1: '7 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      // MMG by the store's pay link only (no phone number fixture needed).
      mmgPayUrl: 'https://pay.example.com/pay/s5a-studio',
    },
  });
  vendorIds.push(v.id);
  const category = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Chair', sortOrder: 0 } });
  const instantId = (await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `S5a ${name} Cut`, basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: { ...everyHour, instantBooking: true } },
  })).id;
  const requestId = (await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `S5a ${name} Colour`, basePrice: 3000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: { ...everyHour } },
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
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:book-s5a partner-app fixtures');
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

const profileRow = async (owner: Actor, vendorId: string) => {
  const res = await call('GET', '/api/v1/vendor/profile', owner.token);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data.vendors as Array<Record<string, unknown>>).find((v) => v['id'] === vendorId)!;
};
const storedConfig = async (itemId: string) => (await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } })).bookingConfig;
/** What the partner app's editor sends for a bookable service (BOOK-S5a): Monday with a lunch break,
 *  Tuesday 10–14, a 15-minute gap, one hour's notice, and the setting when it may be chosen. */
const editorConfig = (extra: Record<string, unknown> = {}) => ({
  durationMinutes: 60,
  slots: [
    { dayOfWeek: 1, start: '09:00', end: '12:00' },
    { dayOfWeek: 1, start: '13:00', end: '17:00' },
    { dayOfWeek: 2, start: '10:00', end: '14:00' },
  ],
  serviceMode: 'AT_BUSINESS',
  bufferMinutes: 15,
  minNoticeMinutes: 60,
  ...extra,
});

// ── the switch's word on the profile ────────────────────────────────────────

describe('[BOOK-S5a · owner A4] the profile says whether "Confirm bookings automatically" can be chosen', () => {
  it('switch OFF: not sent', async () => {
    expect('instantBookingAvailable' in (await profileRow(shop.owner, shop.vendorId))).toBe(false);
  });
  it('switch ON: true for a Services store', async () => {
    on();
    expect((await profileRow(shop.owner, shop.vendorId))['instantBookingAvailable']).toBe(true);
  });
  it('switch ON: never on a store that is not a Services business', async () => {
    on();
    const biz = await makeBusiness('Grocer');
    await app.prisma.vendor.update({ where: { id: biz.vendorId }, data: { vendorType: 'SUPERMARKET' } });
    expect('instantBookingAvailable' in (await profileRow(biz.owner, biz.vendorId))).toBe(false);
  });
});

// ── the editor's save ───────────────────────────────────────────────────────

describe('[BOOK-S5a] the item editor\'s booking settings round-trip', () => {
  it('switch ON: hours per day with a break, the gap, the notice and the setting are stored as sent', async () => {
    on();
    const created = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S5a Lunch-break Cut', basePrice: 1500, fulfillment: 'APPOINTMENT', bookingConfig: editorConfig({ instantBooking: false }),
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.id as string;
    expect(await storedConfig(id)).toEqual(editorConfig({ instantBooking: false }));
    // The editor saves it again with the setting turned on and a new gap.
    const saved = await call('PUT', `/api/v1/vendor/items/${id}`, shop.owner.token, { fulfillment: 'APPOINTMENT', bookingConfig: editorConfig({ instantBooking: true, bufferMinutes: 30 }) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await storedConfig(id)).toEqual(editorConfig({ instantBooking: true, bufferMinutes: 30 }));
  });

  it('switch OFF: the editor sends no setting (the profile did not offer it), and the save is accepted as before', async () => {
    const created = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S5a Off Cut', basePrice: 1500, fulfillment: 'APPOINTMENT', bookingConfig: editorConfig(),
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(await storedConfig(created.json().data.id)).toEqual(editorConfig());
  });

  it('a save from an app that does not know the new fields (build 9) keeps them', async () => {
    on();
    const created = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S5a Kept Cut', basePrice: 1500, fulfillment: 'APPOINTMENT', bookingConfig: editorConfig({ instantBooking: true }),
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.id as string;
    const old = { durationMinutes: 30, slots: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }, { dayOfWeek: 1, start: '13:00', end: '17:00' }, { dayOfWeek: 2, start: '10:00', end: '14:00' }], serviceMode: 'AT_BUSINESS' };
    const saved = await call('PUT', `/api/v1/vendor/items/${id}`, shop.owner.token, { bookingConfig: old });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await storedConfig(id)).toEqual({ ...old, bufferMinutes: 15, minNoticeMinutes: 60, instantBooking: true });
  });

  it('two windows that overlap on one day are refused in the server\'s words (the editor shows them)', async () => {
    const res = await call('POST', '/api/v1/vendor/items', shop.owner.token, {
      categoryId: shop.categoryId, name: 'S5a Overlap Cut', basePrice: 1500, fulfillment: 'APPOINTMENT',
      bookingConfig: editorConfig({ slots: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }, { dayOfWeek: 1, start: '11:00', end: '13:00' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'OVERLAPPING_HOURS', message: 'Two opening times on Monday overlap (09:00–12:00 and 11:00–13:00). Join them into one, or change one so they do not overlap.' });
  });
});

// ── the Schedule ────────────────────────────────────────────────────────────

describe('[BOOK-S5a · owner B2] the Schedule names each booking\'s listing, and the business\'s move lands', () => {
  it('itemId on every booking; a move to another free time of it shows on the Schedule and on the order', async () => {
    const a = await customer('Ada');
    const order = await booked(a, shop.requestId, nextSlot());
    expect((await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, shop.owner.token, {})).statusCode).toBe(200);
    const from = gyDay(2);
    const list = await call('GET', `/api/v1/vendor/bookings?from=${from}&to=${gyDay(20)}`, shop.owner.token);
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json().data as Array<{ id: string; orderId: string; itemId: string }>).find((b) => b.orderId === order.id)!;
    expect(row.itemId).toBe(shop.requestId);
    const to = nextSlot();
    const moved = await call('POST', `/api/v1/vendor/bookings/${row.id}/reschedule`, shop.owner.token, { newSlotStart: to.toISOString() });
    expect(moved.statusCode, moved.body).toBe(200);
    const after = (await call('GET', `/api/v1/vendor/bookings?from=${from}&to=${gyDay(20)}`, shop.owner.token)).json().data as Array<{ orderId: string; slotStart: string; itemId: string }>;
    expect(after.filter((b) => b.orderId === order.id)).toEqual([expect.objectContaining({ slotStart: to.toISOString(), itemId: shop.requestId })]);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).appointmentSlot).toEqual(to);
  });
});

// ── how many at once ────────────────────────────────────────────────────────

describe('[BOOK-S5a · owner C1] "how many bookings at once" saves and reads back', () => {
  it('the profile carries it (1 by default); a save raises it and the profile shows the new number', async () => {
    const biz = await makeBusiness('Chairs');
    expect((await profileRow(biz.owner, biz.vendorId))['bookingCapacity']).toBe(1);
    const res = await call('PUT', '/api/v1/vendor/profile', biz.owner.token, { bookingCapacity: 3 });
    expect(res.statusCode, res.body).toBe(200);
    expect((await profileRow(biz.owner, biz.vendorId))['bookingCapacity']).toBe(3);
  });
});
