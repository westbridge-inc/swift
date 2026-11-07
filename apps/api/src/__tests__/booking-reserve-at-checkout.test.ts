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
import { BookingService, lockBusinessTime } from '../modules/booking/booking.service';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { instantBookingEnabled } from '../modules/booking/instant-booking';
import { autoCancelUnresponsiveOrder } from '../jobs/queue';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-S2 · owner 28 Oct 2026 B4] RESERVE AT CHECKOUT, behind INSTANT_BOOKING.
//
// With the switch ON, the customer's time is taken when they book: checkout
// writes the booking (RESERVED, linked to the order) inside its own commit,
// under the business's time lock and the one overlap rule. Two customers can
// never wait on the same time: the one who loses the race gets 409 SLOT_TAKEN
// and NO order (no PENDING loser, no MMG payment instruction). Acceptance turns
// RESERVED into CONFIRMED; the business rejecting, the no-response
// auto-cancel and the customer's cancel all free it, through the one coupling
// seam in the order transition (booking/order-coupling.ts).
//
// With the switch OFF, checkout is exactly what it was (the control cases).
// The build-9 checkout body is unchanged and gets the same 200 shape.
// Everything runs through the real mounted routes on real PostgreSQL, with
// LIFECYCLE_V2 on (a booking is still born unheld).
// ---------------------------------------------------------------------------

// This file's fixture block (+5920865nnn): no other file uses it.
const PHONE_PREFIX = '+5920865';
const DAY = 24 * 60 * 60 * 1000;

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
/** Each case books its own hour, so no case meets another's booking. */
let hourSeq = 0;
function nextSlot(): Date {
  hourSeq += 1;
  return gy(gyDay(2 + Math.floor(hourSeq / 20)), 2 + (hourSeq % 20), 0);
}

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `S2-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `s2-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}
const customer = (name = 'Cy') => makeUser(name, ['CUSTOMER'], 'CUSTOMER');

let provider: Actor;
let vendorId: string;
/** Two 60-minute listings of ONE business, bookable every hour of every day. */
let cutId: string;
let beardId: string;

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
  const cleared = await call('DELETE', '/api/v1/customer/cart', who.token);
  expect(cleared.statusCode, cleared.body).toBe(200);
  const { vendorId: itemVendorId } = await app.prisma.item.findUniqueOrThrow({ where: { id: itemId }, select: { vendorId: true } });
  const added = await call('POST', '/api/v1/customer/cart/items', who.token, { vendorId: itemVendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  return call('POST', '/api/v1/customer/checkout', who.token, {
    ...payment,
    appointments: [{ itemId, slotStart: slot.toISOString() }],
  });
}
async function booked(who: Actor, itemId: string, slot: Date): Promise<{ id: string }> {
  const res = await book(who, itemId, slot);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.order as { id: string };
}
const accept = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, provider.token, {});
const bookingsOf = (orderId: string) => app.prisma.booking.findMany({ where: { orderId }, select: { id: true, status: true, slotStart: true, itemId: true, customerId: true } });
const liveAt = (slot: Date) => app.prisma.booking.count({ where: { vendorId, slotStart: slot, status: { not: 'CANCELLED' } } });
const ordersOf = (who: Actor) => app.prisma.order.count({ where: { customerId: who.userId } });

/** The shape of a JSON answer: every key, nested, with the kind of each leaf (never its value). */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]));
  }
  return typeof value;
}

/** Wait until some backend is blocked by the transaction running on `pid`. */
async function waitUntilBlockedBy(pid: number, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const [row] = await app.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for a request to queue behind backend ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Another business with one bookable listing (60 minutes, every hour of every day). */
async function makeBusiness(name: string): Promise<{ vendorId: string; itemId: string }> {
  const owner = await makeUser(`${name}Owner`, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const v = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `S2 ${name}`, slug: `s2-${name.toLowerCase()}-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}${String(900 - vendorIds.length).padStart(3, '0')}`, addressLine1: '9 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorIds.push(v.id);
  const category = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Chair', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: {
      vendorId: v.id, categoryId: category.id, name: `S2 ${name} Cut`, basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '24:00' })) },
    },
  });
  return { vendorId: v.id, itemId: item.id };
}

const on = () => vi.stubEnv('INSTANT_BOOKING', '1');
const off = () => vi.stubEnv('INSTANT_BOOKING', '');

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

  provider = await makeUser('Ravi', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: provider.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'S2 Studio', slug: `s2-studio-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}900`, addressLine1: '7 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      // MMG, both ways a customer can be told to pay: the store's number and its pay link.
      mmgNumber: '+5926001288', mmgPayUrl: 'https://pay.example.com/pay/s2-studio',
    },
  });
  vendorId = vendor.id;
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Chair', sortOrder: 0 } });
  const everyHour = { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '24:00' })) };
  cutId = (await app.prisma.item.create({
    data: { vendorId, categoryId: category.id, name: 'S2 Cut', basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: everyHour },
  })).id;
  beardId = (await app.prisma.item.create({
    data: { vendorId, categoryId: category.id, name: 'S2 Beard', basePrice: 1500, isAvailable: true, fulfillment: 'APPOINTMENT', bookingConfig: everyHour },
  })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  off();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:book-s2 reserve-at-checkout fixtures');
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
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[BOOK-S2] INSTANT_BOOKING is one exact switch', () => {
  it('on only at "1" (blanks ignored); unset, empty, 0, true or yes are off', () => {
    expect(instantBookingEnabled({ INSTANT_BOOKING: '1' })).toBe(true);
    expect(instantBookingEnabled({ INSTANT_BOOKING: ' 1 ' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', '2', '01']) {
      expect(instantBookingEnabled(value === undefined ? {} : { INSTANT_BOOKING: value }), String(value)).toBe(false);
    }
  });
});

describe('[BOOK-S2] switch OFF — checkout is exactly what it was', () => {
  it('control: two requests for one free time both wait (PENDING), and checkout takes no slot', async () => {
    const slot = nextSlot();
    const [a, b] = [await customer('Ada'), await customer('Ben')];
    const oa = await booked(a, cutId, slot);
    const ob = await booked(b, cutId, slot);
    for (const id of [oa.id, ob.id]) {
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      expect(await bookingsOf(id)).toEqual([]);
    }
    expect(await liveAt(slot)).toBe(0);
  });
});

describe('[BOOK-S2] switch ON — the slot is taken when the customer books', () => {
  it('checkout writes ONE booking, RESERVED and linked to the order, at the order\'s time', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Cleo');
    const order = await booked(a, cutId, slot);
    expect(await bookingsOf(order.id)).toEqual([
      expect.objectContaining({ status: 'RESERVED', itemId: cutId, customerId: a.userId, slotStart: slot }),
    ]);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row).toMatchObject({ status: 'PENDING', holdExpiresAt: null, appointmentSlot: slot });
  });

  it('a second customer for the same free time gets 409 SLOT_TAKEN and NO order; the first is untouched', async () => {
    on();
    const slot = nextSlot();
    const [a, b] = [await customer('Dan'), await customer('Eve')];
    const first = await booked(a, cutId, slot);
    const lost = await book(b, cutId, slot);
    expect(lost.statusCode, lost.body).toBe(409);
    expect(lost.json().error).toMatchObject({ code: 'SLOT_TAKEN', message: 'That slot was just taken — pick another time' });
    expect(await ordersOf(b)).toBe(0);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('PENDING');
    expect(await bookingsOf(first.id)).toEqual([expect.objectContaining({ status: 'RESERVED' })]);
    expect(await liveAt(slot)).toBe(1);
  });

  it('another listing of the same business at an overlapping time is refused too (one provider, one time)', async () => {
    on();
    const slot = nextSlot();
    const [a, b] = [await customer('Fay'), await customer('Gus')];
    await booked(a, cutId, slot);
    const lost = await book(b, beardId, slot);
    expect(lost.statusCode, lost.body).toBe(409);
    expect(lost.json().error.code).toBe('SLOT_TAKEN');
    expect(await ordersOf(b)).toBe(0);
  });

  it('PARALLEL, on real PostgreSQL: six customers check out for one free time at once — exactly one order, one booking', async () => {
    on();
    const slot = nextSlot();
    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => customer(`Racer${i}`)));
    // Each racer's cart is ready first; then the six checkouts go at once.
    for (const r of racers) {
      expect((await call('DELETE', '/api/v1/customer/cart', r.token)).statusCode).toBe(200);
      expect((await call('POST', '/api/v1/customer/cart/items', r.token, { vendorId, itemId: cutId, quantity: 1 })).statusCode).toBe(201);
    }
    const results = await Promise.all(racers.map((r) => call('POST', '/api/v1/customer/checkout', r.token, {
      paymentMethod: 'CASH', appointments: [{ itemId: cutId, slotStart: slot.toISOString() }],
    })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, results.map((r) => r.body).join('\n')).toEqual([200, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json().error.code).toBe('SLOT_TAKEN');
    expect(await app.prisma.order.count({ where: { customerId: { in: racers.map((r) => r.userId) } } })).toBe(1);
    expect(await liveAt(slot)).toBe(1);
  });

  it('a race lost INSIDE the commit (after the early check passed): 409, no order, nothing for the business to accept', async () => {
    on();
    const slot = nextSlot();
    const [a, rival] = [await customer('Hal'), await customer('Ivy')];
    // The early check passes, and in that same moment another customer's booking commits.
    const realFree = BookingService.prototype.assertSlotFree;
    vi.spyOn(BookingService.prototype, 'assertSlotFree').mockImplementationOnce(async function (this: BookingService, itemId: string, at: Date) {
      await realFree.call(this, itemId, at);
      await new BookingService(app.prisma).reserveSlot(cutId, rival.userId, slot);
    });
    const lost = await book(a, cutId, slot);
    expect(lost.statusCode, lost.body).toBe(409);
    expect(lost.json().error.code).toBe('SLOT_TAKEN');
    expect(await ordersOf(a)).toBe(0);
    expect(await app.prisma.cart.count({ where: { customerId: a.userId, items: { some: {} } } })).toBe(1); // the cart is kept to pick another time
    expect(await liveAt(slot)).toBe(1);
  });

  it('lock order: checkout waits for the business\'s time lock BEFORE it locks the vendor row, as the "how many at once" write does (no deadlock between them)', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Wes');
    expect((await call('DELETE', '/api/v1/customer/cart', a.token)).statusCode).toBe(200);
    expect((await call('POST', '/api/v1/customer/cart/items', a.token, { vendorId, itemId: cutId, quantity: 1 })).statusCode).toBe(201);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pid = 0;
    const holder = app.prisma.$transaction(async (tx) => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await lockBusinessTime(tx, vendorId);
      await gate;
    }, { timeout: 20_000 });
    while (pid === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const placing = call('POST', '/api/v1/customer/checkout', a.token, {
      paymentMethod: 'CASH', appointments: [{ itemId: cutId, slotStart: slot.toISOString() }],
    });
    let vendorRowFree: boolean;
    try {
      await waitUntilBlockedBy(pid);
      // The checkout is queued on the time lock; the vendor row must still be free.
      vendorRowFree = await app.prisma.$queryRaw`SELECT id FROM "vendors" WHERE id = ${vendorId} FOR UPDATE NOWAIT`.then(() => true, () => false);
    } finally {
      release();
      await holder;
    }
    const res = await placing;
    expect(vendorRowFree).toBe(true);
    expect(res.statusCode, res.body).toBe(200);
  });

  for (const [path, payment] of [
    ['the MMG pay link ("pay the business directly after placing the order")', { paymentMethod: 'MOBILE_MONEY' }],
    ['the store\'s MMG number', { paymentMethod: 'MOBILE_MONEY', mmgPayTo: 'STORE_NUMBER' }],
  ] as const) {
    it(`MMG, ${path}: a lost slot returns no payment instruction and leaves no order`, async () => {
      on();
      vi.stubEnv('STORE_MMG_PAY_LINK', '1');
      vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
      const slot = nextSlot();
      const [a, rival] = [await customer('Jo'), await customer('Kai')];
      const realFree = BookingService.prototype.assertSlotFree;
      vi.spyOn(BookingService.prototype, 'assertSlotFree').mockImplementationOnce(async function (this: BookingService, itemId: string, at: Date) {
        await realFree.call(this, itemId, at);
        await new BookingService(app.prisma).reserveSlot(cutId, rival.userId, slot);
      });
      const lost = await book(a, cutId, slot, payment);
      expect(lost.statusCode, lost.body).toBe(409);
      expect(lost.json().error.code).toBe('SLOT_TAKEN');
      expect(lost.body).not.toContain('paymentAction');
      expect(lost.body).not.toContain('pay.example.com');
      expect(lost.body).not.toContain('6001288');
      expect(await ordersOf(a)).toBe(0);
    });
  }

  it('control: with MMG and a free time, the order is placed and its slot taken in the same commit', async () => {
    on();
    vi.stubEnv('STORE_MMG_PAY_LINK', '1');
    vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
    const slot = nextSlot();
    const a = await customer('Lou');
    const res = await book(a, cutId, slot, { paymentMethod: 'MOBILE_MONEY', mmgPayTo: 'STORE_NUMBER' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await bookingsOf(res.json().data.order.id)).toEqual([expect.objectContaining({ status: 'RESERVED' })]);
  });
});

describe('[BOOK-S2] the booking follows its order through the one coupling seam', () => {
  it('the business accepts: the SAME booking turns RESERVED into CONFIRMED (never a second booking, never SLOT_TAKEN against itself)', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('May');
    const order = await booked(a, cutId, slot);
    const [held] = await bookingsOf(order.id);
    const res = await accept(order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('ACCEPTED');
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ id: held!.id, status: 'CONFIRMED' })]);
  });

  it('a slot taken while the switch was ON is still confirmed by an accept after it is switched OFF', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Ned');
    const order = await booked(a, cutId, slot);
    off();
    const res = await accept(order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CONFIRMED' })]);
  });

  it('the business rejects: the booking is freed in the same commit, and the time sells again', async () => {
    on();
    const slot = nextSlot();
    const [a, b] = [await customer('Oda'), await customer('Pam')];
    const order = await booked(a, cutId, slot);
    const res = await call('PUT', `/api/v1/vendor/orders/${order.id}/reject`, provider.token, { reason: 'Closed that day' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
    expect(await liveAt(slot)).toBe(0);
    const again = await booked(b, cutId, slot);
    expect(await bookingsOf(again.id)).toEqual([expect.objectContaining({ status: 'RESERVED' })]);
  });

  it('the no-response auto-cancel frees it', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Quin');
    const order = await booked(a, cutId, slot);
    expect(await autoCancelUnresponsiveOrder({ prisma: app.prisma, io: app.io, redis: app.redis, log: app.log }, order.id)).toBe(true);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
    expect(await liveAt(slot)).toBe(0);
  });

  it('the customer cancels (LIFECYCLE_V2 on: a booking is born unheld, its cancel is the customer\'s own): freed', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Rae');
    const order = await booked(a, cutId, slot);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).holdExpiresAt).toBeNull();
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, a.token, { reason: 'Plans changed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Booking cancelled — no charge', cancellationFee: 0 });
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
    expect(await liveAt(slot)).toBe(0);
  });

  it('the customer cancels after the business accepted (inside the window): the confirmed booking is freed', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Sid');
    const order = await booked(a, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, a.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
  });

  it('the appointment completes: its booking completes', async () => {
    on();
    const slot = nextSlot();
    const a = await customer('Tam');
    const order = await booked(a, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);
    const done = await call('PUT', `/api/v1/vendor/orders/${order.id}/complete-appointment`, provider.token, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(await bookingsOf(order.id)).toEqual([expect.objectContaining({ status: 'COMPLETED' })]);
  });
});

describe('[BOOK-S2 · COORD 28 Oct] slot squatting: at most 2 upcoming bookings per business and 5 in all, per customer', () => {
  it('the defaults are 2 per business and 5 in total (algo-config, no platform-config change)', () => {
    expect(ALGO_DEFAULTS['booking.maxLivePerBusiness']).toBe(2);
    expect(ALGO_DEFAULTS['booking.maxLiveTotal']).toBe(5);
  });

  it('the 3rd upcoming booking with one business is refused in plain words, with no order; another business still books', async () => {
    on();
    const a = await customer('Abe');
    await booked(a, cutId, nextSlot());
    await booked(a, beardId, nextSlot()); // another listing of the SAME business counts too
    const third = await book(a, cutId, nextSlot());
    expect(third.statusCode, third.body).toBe(409);
    expect(third.json().error).toMatchObject({
      code: 'BOOKING_LIMIT_REACHED',
      message: 'You already have 2 upcoming bookings with this business. Cancel one, or book again after one is done.',
    });
    expect(await ordersOf(a)).toBe(2);
    const other = await makeBusiness('Elsewhere');
    expect((await book(a, other.itemId, nextSlot())).statusCode).toBe(200);
  });

  it('the 6th upcoming booking in all is refused, even at a business where the customer holds none', async () => {
    on();
    const a = await customer('Bea');
    const [b1, b2, b3] = [await makeBusiness('One'), await makeBusiness('Two'), await makeBusiness('Three')];
    for (const itemId of [b1.itemId, b1.itemId, b2.itemId, b2.itemId, b3.itemId]) await booked(a, itemId, nextSlot());
    const fresh = await makeBusiness('Four');
    const sixth = await book(a, fresh.itemId, nextSlot());
    expect(sixth.statusCode, sixth.body).toBe(409);
    expect(sixth.json().error).toMatchObject({
      code: 'BOOKING_LIMIT_REACHED',
      message: 'You already have 5 upcoming bookings. Cancel one, or book again after one is done.',
    });
    expect(await ordersOf(a)).toBe(5);
  });

  it('a cancelled booking frees its place, and so does a completed one', async () => {
    on();
    const a = await customer('Cal');
    const first = await booked(a, cutId, nextSlot());
    const second = await booked(a, cutId, nextSlot());
    expect((await book(a, cutId, nextSlot())).statusCode).toBe(409);
    // Cancelled frees a place.
    expect((await call('POST', `/api/v1/customer/orders/${first.id}/cancel`, a.token, {})).statusCode).toBe(200);
    const third = await booked(a, cutId, nextSlot());
    expect((await book(a, cutId, nextSlot())).statusCode).toBe(409);
    // Completed frees a place.
    expect((await accept(second.id)).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/vendor/orders/${second.id}/complete-appointment`, provider.token, {})).statusCode).toBe(200);
    expect((await book(a, cutId, nextSlot())).statusCode).toBe(200);
    expect(await bookingsOf(third.id)).toEqual([expect.objectContaining({ status: 'RESERVED' })]);
  });

  it('control: with the switch OFF there is no cap (requests wait for the business, as before)', async () => {
    const a = await customer('Dee');
    for (let i = 0; i < 3; i += 1) expect((await book(a, cutId, nextSlot())).statusCode).toBe(200);
  });

  it('PARALLEL, on real PostgreSQL: two holds for one customer at two businesses cannot both slip past the cap', async () => {
    const a = await customer('Eli');
    const [b1, b2, b3, b4] = [await makeBusiness('Five'), await makeBusiness('Six'), await makeBusiness('Seven'), await makeBusiness('Eight')];
    on();
    for (const itemId of [b1.itemId, b1.itemId, b2.itemId, b2.itemId]) await booked(a, itemId, nextSlot());
    const limits = { perBusiness: 2, total: 5 };
    const svc = new BookingService(app.prisma);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pid = 0;
    let holding = false;
    // The first hold takes the 5th place and keeps its transaction open...
    const first = app.prisma.$transaction(async (tx) => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await svc.holdSlotAtCheckout(tx, { itemId: b3.itemId, customerId: a.userId, slotStart: nextSlot(), orderId: `s2-race-${nanoid(6)}`, limits });
      holding = true;
      await gate;
    }, { timeout: 20_000 });
    let failed: unknown = null;
    first.catch((error: unknown) => { failed = error; });
    const until = Date.now() + 10_000;
    while (!holding) {
      if (failed || Date.now() > until) throw new Error(`the first hold never took its place: ${String(failed)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // ...while the second, at another business, must wait for it rather than count the old number.
    const second = app.prisma.$transaction(
      (tx) => svc.holdSlotAtCheckout(tx, { itemId: b4.itemId, customerId: a.userId, slotStart: nextSlot(), orderId: `s2-race-${nanoid(6)}`, limits }),
      { timeout: 20_000 },
    ).then(() => 'placed', (error: { code?: string }) => error.code ?? 'error');
    let queued = true;
    try {
      await waitUntilBlockedBy(pid, 3_000);
    } catch {
      queued = false;
    } finally {
      release();
      await first;
    }
    expect(queued, 'the second hold waits on the customer\'s booking lock').toBe(true);
    expect(await second).toBe('BOOKING_LIMIT_REACHED');
    expect(await app.prisma.booking.count({ where: { customerId: a.userId, status: { in: ['RESERVED', 'CONFIRMED'] } } })).toBe(5);
  });
});

describe('[BOOK-S2] build 9 is unchanged', () => {
  it('the build-9 checkout body gets the same 200 shape with the switch ON as OFF, field for field', async () => {
    const offRes = await book(await customer('Uma'), cutId, nextSlot());
    on();
    const onRes = await book(await customer('Vic'), cutId, nextSlot());
    expect(offRes.statusCode, offRes.body).toBe(200);
    expect(onRes.statusCode, onRes.body).toBe(200);
    expect(shapeOf(onRes.json())).toEqual(shapeOf(offRes.json()));
    expect(onRes.json().data.order).toMatchObject({ status: 'PENDING', fulfillment: 'APPOINTMENT' });
  });
});

describe('[BOOK-S2] BookingService.cancelBooking is gone', () => {
  it('no booking can be cancelled apart from its order', () => {
    expect((BookingService.prototype as unknown as Record<string, unknown>)['cancelBooking']).toBeUndefined();
  });
});
