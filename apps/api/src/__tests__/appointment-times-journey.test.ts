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
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LATE_CANCEL_FEE } from '../modules/order/cancel-policy';
import { vendorResponseSlaMinutes } from '../modules/order/response-sla';
import { sendBookingReminders } from '../modules/services/services.service';
import { autoCancelUnresponsiveOrder } from '../jobs/queue';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// Q12 · APPOINTMENT TIMES, PROVEN IN GUYANA TIME. The owner, 2026-09-24: "the
// appointment dates are accordingly set and working".
//
// A service business's booking travels through the REAL mounted routes: the
// customer's slot picker, checkout, the provider's board, detail, accept and
// calendar, admin's order desk, the reschedule routes, the reminder sweep and
// the no-response auto-decline. Each assertion names the instant the customer
// picked on a Guyana wall clock and requires every surface to hand back that
// exact instant (or copy naming that exact Guyana time).
//
// The oracle is independent of the zone helper under test: Guyana is UTC−4
// all year (no daylight saving), so 10:00 there IS 14:00Z and 23:30 there is
// 03:30Z on the NEXT UTC date — asserted literally below.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920862nnn, 11 characters): no phone literal,
// generator or purge prefix under apps/, packages/, tools/, scripts/ or
// deploy/ contains "+59208" (order-hold-journey owns +5920861; the +59204…
// block is the staging live-test reserve — deliberately avoided).
const PHONE_PREFIX = '+5920862';
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let app: FastifyInstance;
let seq = 0;
const userIds: string[] = [];
const vendorIds: string[] = [];

type Actor = { userId: string; token: string; phone: string };
type Placed = { id: string; orderNumber: string; appointmentSlot: string | null; holdExpiresAt: string | null; fulfillment: string };

// ── Guyana calendar helpers ────────────────────────────────────────────────

/** The Guyana calendar date `offset` days from today, as YYYY-MM-DD. */
function gyDay(offset: number): string {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
}
/** The next Guyana date, at least `minOffset` days out, falling on `dayOfWeek`. */
function gyNext(dayOfWeek: number, minOffset: number): string {
  for (let i = minOffset; i < minOffset + 7; i += 1) {
    const key = gyDay(i);
    if (new Date(`${key}T12:00:00.000Z`).getUTCDay() === dayOfWeek) return key;
  }
  throw new Error('unreachable: every weekday occurs within seven days');
}
/** The TRUE instant of a Guyana wall-clock time on that date. */
function gy(dayKey: string, hour: number, minute = 0): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d!, hour, minute)));
}
const nextDayKey = (dayKey: string) => new Date(Date.parse(`${dayKey}T12:00:00.000Z`) + DAY).toISOString().slice(0, 10);
const weekdayOf = (dayKey: string) => WEEKDAY[new Date(`${dayKey}T12:00:00.000Z`).getUTCDay()]!;

// ── Fixtures ────────────────────────────────────────────────────────────────

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { admin?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName, lastName: `Q12B-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `q12b-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, phone };
}

let provider: Actor;
let vendorId: string;
/** A 30-minute cut, bookable every half hour of every day, 00:00–24:00. */
let cutId: string;
/** A 60-minute shave, weekdays 09:00–17:00 only — the hours rules. */
let shaveId: string;
let adminUser: Actor;

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

/** The customer's real path: an empty cart, the listing, checkout with the slot. */
async function book(customer: Actor, itemId: string, slot: Date | string) {
  const cleared = await call('DELETE', '/api/v1/customer/cart', customer.token);
  expect(cleared.statusCode, cleared.body).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  return call('POST', '/api/v1/customer/checkout', customer.token, {
    paymentMethod: 'CASH',
    appointments: [{ itemId, slotStart: typeof slot === 'string' ? slot : slot.toISOString() }],
  });
}
async function booked(customer: Actor, itemId: string, slot: Date): Promise<Placed> {
  const res = await book(customer, itemId, slot);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.order as Placed;
}

const picker = async (itemId: string, dayKey: string, token: string) => {
  const res = await call('GET', `/api/v1/customer/items/${itemId}/slots?date=${dayKey}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.slots as string[];
};
const accept = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, provider.token, {});
const bookingOf = (orderId: string) => app.prisma.booking.findFirstOrThrow({ where: { orderId, status: { not: 'CANCELLED' } } });

/** The slot as every surface hands it back: the customer's order, list and
 *  home card; the provider's board and detail; admin's detail and list. */
async function slotEverywhere(customer: Actor, order: { id: string; orderNumber: string }) {
  const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, customer.token);
  const myList = await call('GET', '/api/v1/customer/orders', customer.token);
  const home = await call('GET', '/api/v1/customer/home', customer.token);
  const board = await call('GET', '/api/v1/vendor/orders?limit=50', provider.token);
  const detail = await call('GET', `/api/v1/vendor/orders/${order.id}`, provider.token);
  const desk = await call('GET', `/api/v1/admin/orders/${order.id}`, adminUser.token);
  const deskList = await call('GET', `/api/v1/admin/orders?search=${order.orderNumber}`, adminUser.token);
  for (const res of [mine, myList, home, board, detail, desk, deskList]) expect(res.statusCode, res.body).toBe(200);
  const row = (res: typeof mine) => (res.json().data as Array<{ id: string; appointmentSlot: string | null }>).find((o) => o.id === order.id);
  const homeCard = home.json().data.activeOrder as { id: string; appointmentSlot: string | null } | null;
  return {
    customerDetail: mine.json().data.appointmentSlot as string | null,
    customerList: row(myList)?.appointmentSlot ?? null,
    customerHome: homeCard?.id === order.id ? homeCard.appointmentSlot : 'not the active order',
    providerBoard: row(board)?.appointmentSlot ?? null,
    providerDetail: detail.json().data.appointmentSlot as string | null,
    adminDetail: desk.json().data.appointmentSlot as string | null,
    adminList: row(deskList)?.appointmentSlot ?? null,
  };
}
const everywhere = (iso: string) => ({
  customerDetail: iso, customerList: iso, customerHome: iso,
  providerBoard: iso, providerDetail: iso, adminDetail: iso, adminList: iso,
});

/** Wait until some backend is blocked by the transaction running on `pid` —
 *  the request under test, queued behind a lock the test holds. Any other
 *  suite's lock waits never match: only this transaction's locks count. */
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

const priorHoldMinutes = process.env['ORDER_HOLD_MINUTES'];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // The hold is ON: bookings must still be born unheld (#1328).
  vi.stubEnv('LIFECYCLE_V2', '1');
  delete process.env['ORDER_HOLD_MINUTES'];

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  provider = await makeUser('Marcus', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: provider.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'Q12 Barber', slug: `q12-barber-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}900`, addressLine1: '5 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Chair', sortOrder: 0 } });
  cutId = (await app.prisma.item.create({
    data: {
      vendorId, categoryId: category.id, name: 'Q12 Cut', basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 30, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '24:00' })) },
    },
  })).id;
  shaveId = (await app.prisma.item.create({
    data: {
      vendorId, categoryId: category.id, name: 'Q12 Shave', basePrice: 1500, isAvailable: true, fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 60, slots: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })) },
    },
  })).id;
  adminUser = await makeUser('Ada', ['ADMIN'], 'ADMIN', { admin: true });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (priorHoldMinutes !== undefined) process.env['ORDER_HOLD_MINUTES'] = priorHoldMinutes;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  // Admin reads write audit rows in onResponse hooks; let the last one land.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:q12 appointment-times fixtures');
  await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: userIds } }, { subjectId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:q12 appointment-times fixture reads');
  if (orderIds.length > 0) {
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: userIds } }] } });
  await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.booking.deleteMany({ where: { item: { vendorId: { in: vendorIds } } } });
  await app.prisma.bookingException.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

// [AX289 F7] Every case hands the next one an unblocked provider. A block a
// case needs (B3's Monday lunch, B7's whole day) must not outlive it: the
// lunch block once did, and on a Saturday — when gyDay(2) IS that Monday —
// B5's noon booking met it and got 409 instead of 200. A block left behind
// fails the case that left it, and is removed so later cases stay isolated.
afterEach(async () => {
  const left = await app.prisma.bookingException.findMany({ where: { vendorId }, select: { date: true, start: true, end: true } });
  if (left.length > 0) await app.prisma.bookingException.deleteMany({ where: { vendorId } });
  expect(left, 'a case left a provider block behind').toEqual([]);
});

// ---------------------------------------------------------------------------
// (B1) The instant picked in Guyana time is the instant every surface returns
// ---------------------------------------------------------------------------

describe('Q12 · B1 — a 10:00 Guyana slot is stored as 14:00Z and returned identically everywhere', () => {
  it('picker → checkout → customer, provider and admin surfaces → accept → the provider calendar', async () => {
    const day = gyDay(2);
    const slot = gy(day, 10, 0);
    expect(slot.toISOString()).toBe(`${day}T14:00:00.000Z`); // the oracle: UTC−4, no DST
    const iso = slot.toISOString();

    const customer = await makeUser('Asha', ['CUSTOMER'], 'CUSTOMER');
    expect(await picker(cutId, day, customer.token)).toContain(iso);

    const order = await booked(customer, cutId, slot);
    // The answer the confirmation screen renders from; bookings are never held.
    expect(order).toMatchObject({ fulfillment: 'APPOINTMENT', appointmentSlot: iso, holdExpiresAt: null });
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).appointmentSlot?.toISOString()).toBe(iso);

    expect(await slotEverywhere(customer, order)).toEqual(everywhere(iso));

    // Accepting reserves exactly that instant; the provider's calendar for that
    // Guyana date lists it, ending 30 minutes later.
    const ok = await accept(order.id);
    expect(ok.statusCode, ok.body).toBe(200);
    const booking = await bookingOf(order.id);
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.slotStart.toISOString()).toBe(iso);
    const calendar = await call('GET', `/api/v1/vendor/bookings?from=${day}&to=${nextDayKey(day)}`, provider.token);
    expect(calendar.statusCode, calendar.body).toBe(200);
    expect(calendar.json().data).toContainEqual(expect.objectContaining({
      orderId: order.id, status: 'CONFIRMED', slotStart: iso, slotEnd: new Date(slot.getTime() + 30 * MINUTE).toISOString(),
    }));
    expect(await slotEverywhere(customer, order)).toEqual(everywhere(iso));
    // …and the picker stops offering it to anyone else.
    expect(await picker(cutId, day, customer.token)).not.toContain(iso);
  });

  it('the reminder names the same Guyana time to both sides', async () => {
    // The next half hour at least three hours away — inside the 24h reminder window.
    const now = Date.now();
    const soon = new Date(Math.ceil((now + 3 * 60 * MINUTE) / (30 * MINUTE)) * 30 * MINUTE);
    const localClock = new Date(soon.getTime() - 4 * 60 * MINUTE); // UTC−4, read as UTC fields
    const hour12 = localClock.getUTCHours() % 12 || 12;
    const expectedWhen = `${WEEKDAY[localClock.getUTCDay()]} ${hour12}:${String(localClock.getUTCMinutes()).padStart(2, '0')} ${localClock.getUTCHours() < 12 ? 'AM' : 'PM'}`;

    const customer = await makeUser('Bibi', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, soon);
    expect((await accept(order.id)).statusCode).toBe(200);
    const bookingId = (await bookingOf(order.id)).id;

    const sent: Array<{ userId: string; body: string; data: Record<string, unknown> }> = [];
    await sendBookingReminders(app.prisma, async (n) => { sent.push(n); });
    const mine = sent.filter((n) => n.data['refId'] === bookingId);
    expect(mine.find((n) => n.userId === customer.userId)?.body).toBe(`Q12 Cut at Q12 Barber is booked for ${expectedWhen}.`);
    expect(mine.find((n) => n.userId === provider.userId)?.body).toBe(`Q12 Cut appointment coming up ${expectedWhen}.`);
  });
});

// ---------------------------------------------------------------------------
// (B2–B3) Refusals: the past, outside the provider's hours, a blocked window
// ---------------------------------------------------------------------------

describe('Q12 · B2/B3 — a time that has passed, or that the provider does not offer, is refused', () => {
  it('a slot in the past is refused at checkout, and the picker never offers one', async () => {
    const customer = await makeUser('Cara', ['CUSTOMER'], 'CUSTOMER');
    for (const past of [gy(gyDay(-1), 10, 0), new Date(Math.floor((Date.now() - 30 * MINUTE) / (30 * MINUTE)) * 30 * MINUTE)]) {
      const res = await book(customer, cutId, past);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('SLOT_IN_PAST');
    }
    const today = await picker(cutId, gyDay(0), customer.token);
    expect(today.every((iso) => Date.parse(iso) > Date.now())).toBe(true);
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('outside the provider hours, off the grid, on a closed day or inside a block — refused; the control books', async () => {
    const customer = await makeUser('Dev', ['CUSTOMER'], 'CUSTOMER');
    const monday = gyNext(1, 2);
    const saturday = gyNext(6, 2);
    const refusals: Array<[string, Date, number, string]> = [
      ['after hours', gy(monday, 20, 0), 400, 'SLOT_OUTSIDE_HOURS'],
      ['off the hourly grid', gy(monday, 9, 30), 400, 'SLOT_OUTSIDE_HOURS'],
      ['would run past closing', gy(monday, 16, 30), 400, 'SLOT_OUTSIDE_HOURS'],
      ['a closed weekday', gy(saturday, 10, 0), 400, 'SLOT_OUTSIDE_HOURS'],
    ];
    for (const [why, slot, status, code] of refusals) {
      const res = await book(customer, shaveId, slot);
      expect(res.statusCode, `${why}: ${res.body}`).toBe(status);
      expect(res.json().error.code, why).toBe(code);
    }
    // The provider blocks lunch on that Monday: the block refuses without
    // saying why, and the hour after it books.
    const block = await call('POST', '/api/v1/vendor/bookings/exceptions', provider.token, { date: monday, start: '12:00', end: '13:00', reason: 'Lunch' });
    expect(block.statusCode, block.body).toBe(200);
    const blocked = await book(customer, shaveId, gy(monday, 12, 0));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({ code: 'SLOT_TAKEN' });
    expect(blocked.body).not.toContain('Lunch');
    const control = await booked(customer, shaveId, gy(monday, 13, 0));
    expect(control.appointmentSlot).toBe(`${monday}T17:00:00.000Z`);

    // Lunch is over: the provider lifts the block and noon sells again.
    const lifted = await call('DELETE', `/api/v1/vendor/bookings/exceptions/${block.json().data.id}`, provider.token);
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(await picker(shaveId, monday, customer.token)).toContain(gy(monday, 12, 0).toISOString());
  });
});

// ---------------------------------------------------------------------------
// (B4) One provider slot, one customer — including parallel requests
// ---------------------------------------------------------------------------

describe('Q12 · B4 — a double booking of one provider slot is refused', () => {
  it('two open requests for a free slot: parallel accepts confirm exactly one; the loser stays pending, never double-booked', async () => {
    const slot = gy(gyDay(3), 15, 0);
    const [x, y] = [await makeUser('Esi', ['CUSTOMER'], 'CUSTOMER'), await makeUser('Fay', ['CUSTOMER'], 'CUSTOMER')];
    const ox = await booked(x, cutId, slot);
    const oy = await booked(y, cutId, slot);
    const results = await Promise.all([accept(ox.id), accept(oy.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results[0]!.statusCode === 409 ? ox : oy;
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('SLOT_TAKEN');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: loser.id } })).status).toBe('PENDING');
    expect(await app.prisma.booking.count({ where: { itemId: cutId, slotStart: slot, status: { not: 'CANCELLED' } } })).toBe(1);
  });

  it('once the slot is confirmed, a new request for it is refused at checkout — also when two arrive at once', async () => {
    const slot = gy(gyDay(3), 16, 0);
    const first = await makeUser('Gail', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(first, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);

    const [late1, late2] = [await makeUser('Hari', ['CUSTOMER'], 'CUSTOMER'), await makeUser('Ines', ['CUSTOMER'], 'CUSTOMER')];
    const refused = await Promise.all([book(late1, cutId, slot), book(late2, cutId, slot)]);
    for (const res of refused) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'SLOT_TAKEN', message: 'That slot was just taken — pick another time' });
    }
    expect(await app.prisma.order.count({ where: { customerId: { in: [late1.userId, late2.userId] } } })).toBe(0);
    expect(await app.prisma.booking.count({ where: { itemId: cutId, slotStart: slot, status: { not: 'CANCELLED' } } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (B5) Reschedule and cancel windows, as documented
// ---------------------------------------------------------------------------

describe('Q12 · B5 — the cancel windows and the reschedule behave as documented', () => {
  it('a booking the provider has not confirmed cancels free until five minutes before the slot', async () => {
    const slot = gy(gyDay(2), 11, 0);
    const customer = await makeUser('Joy', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, slot);
    const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, customer.token);
    expect(mine.json().data).toMatchObject({
      status: 'PENDING', holdExpiresAt: null, canCancel: true, freeCancellationWindow: true, cancellationFee: 0,
      freeCancellationExpiresAt: new Date(slot.getTime() - 5 * MINUTE).toISOString(),
    });
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'Plans changed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Booking cancelled — no charge', cancellationFee: 0 });
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).lateCancelFeeDue).toBe(0);
  });

  it('a confirmed booking cancels with the recorded late-cancel marker, and the slot sells again', async () => {
    const slot = gy(gyDay(2), 12, 0);
    const customer = await makeUser('Kofi', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);
    const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, customer.token);
    expect(mine.json().data).toMatchObject({
      status: 'ACCEPTED', canCancel: true, freeCancellationWindow: false, cancellationFee: LATE_CANCEL_FEE, freeCancellationExpiresAt: null,
    });
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Booking cancelled', cancellationFee: LATE_CANCEL_FEE });
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).lateCancelFeeDue).toBe(LATE_CANCEL_FEE);
    expect(await app.prisma.booking.count({ where: { orderId: order.id, status: { not: 'CANCELLED' } } })).toBe(0);
    expect(await picker(cutId, gyDay(2), customer.token)).toContain(slot.toISOString());
  });

  it('a reschedule moves the appointment on EVERY surface — the order, not just the calendar — and names both Guyana times', async () => {
    const day = gyDay(2);
    const from = gy(day, 13, 0);
    const to = gy(day, 17, 30);
    const customer = await makeUser('Lena', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, from);
    expect((await accept(order.id)).statusCode).toBe(200);
    expect(await slotEverywhere(customer, order)).toEqual(everywhere(from.toISOString())); // warms the home cache too
    const bookingId = (await bookingOf(order.id)).id;

    // Not into the past, not outside the hours — the same rules as booking.
    const past = await call('POST', `/api/v1/customer/bookings/${bookingId}/reschedule`, customer.token, { newSlotStart: gy(gyDay(-1), 13, 0).toISOString() });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.code).toBe('SLOT_IN_PAST');

    const moved = await call('POST', `/api/v1/customer/bookings/${bookingId}/reschedule`, customer.token, { newSlotStart: to.toISOString() });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().data.slotStart).toBe(to.toISOString());
    expect(await slotEverywhere(customer, order)).toEqual(everywhere(to.toISOString()));
    expect(await picker(cutId, day, customer.token)).toContain(from.toISOString()); // the old slot sells again

    const notice = await app.prisma.notification.findFirstOrThrow({
      where: { userId: provider.userId, data: { path: ['bookingId'], equals: moved.json().data.id } },
    });
    const dayNum = Number(day.slice(8));
    expect(notice.title).toBe('Appointment moved');
    expect(notice.body).toContain(`${weekdayOf(day)} ${dayNum}`);
    expect(notice.body).toMatch(/moved from .*13:00 to .*17:30\.$/);

    // The provider can move it back; the customer is told, and every surface follows.
    const back = await call('POST', `/api/v1/vendor/bookings/${moved.json().data.id}/reschedule`, provider.token, { newSlotStart: from.toISOString() });
    expect(back.statusCode, back.body).toBe(200);
    expect(await slotEverywhere(customer, order)).toEqual(everywhere(from.toISOString()));
    const told = await app.prisma.notification.findFirstOrThrow({
      where: { userId: customer.userId, data: { path: ['bookingId'], equals: back.json().data.id } },
    });
    expect(told.title).toBe('Your appointment moved');
    expect(told.body).toMatch(/moved from .*17:30 to .*13:00\.$/);
  });

  it('[AX289 F6] a reschedule racing a cancellation of the same order waits on the ORDER first, then loses cleanly — 409 BOOKING_MOVED, never a deadlock or a 500', async () => {
    const day = gyDay(5);
    const from = gy(day, 9, 0);
    const to = gy(day, 9, 30);
    const customer = await makeUser('Pita', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, from);
    expect((await accept(order.id)).statusCode).toBe(200);
    const bookingId = (await bookingOf(order.id)).id;

    // A cancellation of this order, held at its midpoint in the canonical lock
    // order: it has the ORDER row and has not yet written the bookings.
    let resume!: () => void;
    const midpoint = new Promise<void>((resolve) => { resume = resolve; });
    let holding!: (pid: number) => void;
    const orderLocked = new Promise<number>((resolve) => { holding = resolve; });
    const cancellation = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      holding((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      await midpoint;
      // NOWAIT: the queued reschedule must hold no booking lock, so the
      // cancellation takes its bookings at once and commits — no deadlock.
      await tx.$queryRaw`SELECT id FROM "bookings" WHERE "orderId" = ${order.id} FOR UPDATE NOWAIT`;
      await tx.booking.updateMany({ where: { orderId: order.id, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: customer.userId } });
    }, { timeout: 20_000 });

    // (A cancellation that failed before it held the order ends the wait.)
    const failedEarly = cancellation.then(() => { throw new Error('the cancellation finished before it held the order'); });
    failedEarly.catch(() => undefined);
    const cancellerPid = await Promise.race([orderLocked, failedEarly]);
    const moving = call('POST', `/api/v1/customer/bookings/${bookingId}/reschedule`, customer.token, { newSlotStart: to.toISOString() });
    await waitUntilBlockedBy(cancellerPid); // the reschedule is queued behind the cancellation
    resume();
    await cancellation;
    const res = await moving;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'BOOKING_MOVED', message: 'This booking just changed — reload and try again' });

    // The lost move left nothing behind: no live booking at either time, and
    // the order still names the time it was cancelled at.
    expect(await app.prisma.booking.count({ where: { orderId: order.id, status: { not: 'CANCELLED' } } })).toBe(0);
    expect(await app.prisma.booking.count({ where: { itemId: cutId, slotStart: to, status: { not: 'CANCELLED' } } })).toBe(0);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).appointmentSlot?.toISOString()).toBe(from.toISOString());
  });
});

// ---------------------------------------------------------------------------
// (B6) The auto-decline: the earlier of 24 h after booking and 1 h before the slot
// ---------------------------------------------------------------------------

describe('Q12 · B6 — an unconfirmed booking auto-declines at the earlier of placed + 24 h and slot − 60 min', () => {
  it('the provider clock and the auto-cancel job share one deadline, and the job declines the booking in provider words', async () => {
    const slaMs = (await vendorResponseSlaMinutes(app.prisma)) * MINUTE;
    const customer = await makeUser('Mira', ['CUSTOMER'], 'CUSTOMER');
    const near = new Date(Math.ceil((Date.now() + 5 * 60 * MINUTE) / (30 * MINUTE)) * 30 * MINUTE); // ~5 h out
    const far = gy(gyDay(4), 10, 0); // days out
    for (const [label, slot, deadline] of [
      ['slot − 60 min', near, (placed: Date) => Math.max(placed.getTime() + slaMs, near.getTime() - 60 * MINUTE)],
      ['placed + 24 h', far, (placed: Date) => placed.getTime() + DAY],
    ] as const) {
      const order = await booked(customer, cutId, slot);
      const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const due = deadline(row.placedAt);
      const autoCancel = await app.prisma.orderOutbox.findFirstOrThrow({ where: { orderId: order.id, kind: 'auto-cancel' } });
      expect(row.placedAt.getTime() + autoCancel.delayMs, label).toBe(due);
      const board = await call('GET', '/api/v1/vendor/orders?limit=50', provider.token);
      const onBoard = (board.json().data as Array<{ id: string; respondBy: string | null }>).find((o) => o.id === order.id);
      expect(onBoard?.respondBy, label).toBe(new Date(due).toISOString());
    }

    // The job that fires at that deadline declines a still-unconfirmed booking.
    const lapsed = await booked(customer, cutId, gy(gyDay(4), 11, 0));
    expect(await autoCancelUnresponsiveOrder({ prisma: app.prisma, io: app.io, redis: app.redis, log: app.log }, lapsed.id)).toBe(true);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: lapsed.id } })).status).toBe('CANCELLED');
    expect(await app.prisma.booking.count({ where: { orderId: lapsed.id } })).toBe(0);
    const told = await app.prisma.notification.findFirstOrThrow({ where: { userId: customer.userId, data: { path: ['orderId'], equals: lapsed.id } }, orderBy: { createdAt: 'desc' } });
    expect(told.title).toBe('Booking cancelled — no response');
  });
});

// ---------------------------------------------------------------------------
// (B7) The day boundary: 23:30 in Guyana is 03:30Z the NEXT UTC day
// ---------------------------------------------------------------------------

describe('Q12 · B7 — a 23:30 Guyana booking stays on its Guyana date in every response', () => {
  it('picker, checkout, every surface, the provider calendar, the date blocks and the reschedule copy all keep it on its own day', async () => {
    const day = gyDay(1);
    const next = nextDayKey(day);
    const slot = gy(day, 23, 30);
    expect(slot.toISOString()).toBe(`${next}T03:30:00.000Z`); // the oracle: the NEXT UTC date
    const iso = slot.toISOString();

    const customer = await makeUser('Nia', ['CUSTOMER'], 'CUSTOMER');
    expect(await picker(cutId, day, customer.token)).toContain(iso);
    expect(await picker(cutId, next, customer.token)).not.toContain(iso);

    const order = await booked(customer, cutId, slot);
    expect(order.appointmentSlot).toBe(iso);
    expect(await slotEverywhere(customer, order)).toEqual(everywhere(iso));
    expect((await accept(order.id)).statusCode).toBe(200);

    // The provider calendar files it under its Guyana date, not the UTC one.
    const onDay = await call('GET', `/api/v1/vendor/bookings?from=${day}&to=${next}`, provider.token);
    const onNext = await call('GET', `/api/v1/vendor/bookings?from=${next}&to=${nextDayKey(next)}`, provider.token);
    expect((onDay.json().data as Array<{ orderId: string }>).some((b) => b.orderId === order.id)).toBe(true);
    expect((onNext.json().data as Array<{ orderId: string }>).some((b) => b.orderId === order.id)).toBe(false);
    expect(await picker(cutId, day, customer.token)).not.toContain(iso);
    expect(await picker(cutId, next, customer.token)).toContain(gy(next, 0, 0).toISOString());

    // A whole-day block on the NEXT date does not touch this date's evening.
    const block = await call('POST', '/api/v1/vendor/bookings/exceptions', provider.token, { date: next });
    expect(block.statusCode, block.body).toBe(200);
    const sameEvening = await makeUser('Omar', ['CUSTOMER'], 'CUSTOMER');
    expect((await booked(sameEvening, cutId, gy(day, 23, 0))).appointmentSlot).toBe(`${next}T03:00:00.000Z`);
    const blocked = await book(sameEvening, cutId, gy(next, 0, 0));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('SLOT_TAKEN');

    // The moved-appointment copy names the Guyana day and clock.
    const bookingId = (await bookingOf(order.id)).id;
    const moved = await call('POST', `/api/v1/customer/bookings/${bookingId}/reschedule`, customer.token, { newSlotStart: gy(day, 22, 30).toISOString() });
    expect(moved.statusCode, moved.body).toBe(200);
    const notice = await app.prisma.notification.findFirstOrThrow({
      where: { userId: provider.userId, data: { path: ['bookingId'], equals: moved.json().data.id } },
    });
    const dayNum = Number(day.slice(8));
    expect(notice.body).toMatch(new RegExp(`moved from ${weekdayOf(day)} ${dayNum} .*23:30 to ${weekdayOf(day)} ${dayNum} .*22:30\\.$`));
    expect(await slotEverywhere(customer, order)).toEqual(everywhere(`${next}T02:30:00.000Z`)); // 22:30 Guyana

    // The provider lifts the day block; the next date sells again.
    const lifted = await call('DELETE', `/api/v1/vendor/bookings/exceptions/${block.json().data.id}`, provider.token);
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(await picker(cutId, next, customer.token)).toContain(gy(next, 0, 0).toISOString());
  });
});

describe('[L09 · M017] one slot is one instant: stray seconds never make a second booking', () => {
  it('a request a fraction of a second into a confirmed slot is the same slot, refused at checkout and at reservation', async () => {
    const slot = gy(gyDay(4), 10, 0);
    const first = await makeUser('Ines', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(first, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);

    const second = await makeUser('Joel', ['CUSTOMER'], 'CUSTOMER');
    const late = await book(second, cutId, new Date(slot.getTime() + 400));
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('SLOT_TAKEN');

    const { BookingService } = await import('../modules/booking/booking.service');
    await expect(new BookingService(app.prisma).reserveSlot(cutId, second.userId, new Date(slot.getTime() + 400)))
      .rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await expect(new BookingService(app.prisma).assertSlotFree(cutId, new Date(slot.getTime() + 400)))
      .rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    expect(await app.prisma.booking.count({ where: { itemId: cutId, status: { not: 'CANCELLED' }, slotStart: { gte: slot, lt: new Date(slot.getTime() + MINUTE) } } })).toBe(1);
  });

  it('a slot asked for with stray seconds is stored on the minute, on the order and on the booking', async () => {
    const slot = gy(gyDay(4), 11, 0);
    const customer = await makeUser('Kira', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, new Date(slot.getTime() + 37_250));
    expect(order.appointmentSlot).toBe(slot.toISOString());
    expect((await accept(order.id)).statusCode).toBe(200);
    expect((await bookingOf(order.id)).slotStart.toISOString()).toBe(slot.toISOString());
  });
});

describe('[L09 · M018] a finished appointment stays finished', () => {
  it('completing the appointment completes its booking, and a completed appointment cannot be moved', async () => {
    const slot = gy(gyDay(4), 12, 0);
    const customer = await makeUser('Lena', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);
    const done = await call('PUT', `/api/v1/vendor/orders/${order.id}/complete-appointment`, provider.token, {});
    expect(done.statusCode, done.body).toBe(200);
    const booking = await bookingOf(order.id);
    expect(booking.status).toBe('COMPLETED');

    const move = await call('POST', `/api/v1/customer/bookings/${booking.id}/reschedule`, customer.token, { newSlotStart: gy(gyDay(4), 14, 0).toISOString() });
    expect(move.statusCode).toBe(400);
    expect(move.json().error.code).toBe('NOT_RESCHEDULABLE');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).appointmentSlot?.toISOString()).toBe(slot.toISOString());
  });

  it('a booking still marked live on a finished order is refused under the order lock, by either side', async () => {
    const slot = gy(gyDay(4), 13, 0);
    const customer = await makeUser('Mona', ['CUSTOMER'], 'CUSTOMER');
    const order = await booked(customer, cutId, slot);
    expect((await accept(order.id)).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/vendor/orders/${order.id}/complete-appointment`, provider.token, {})).statusCode).toBe(200);
    // A row written before completion synced (or by a path that forgot to).
    const booking = await bookingOf(order.id);
    await app.prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });

    for (const [path, token] of [['customer', customer.token], ['vendor', provider.token]] as const) {
      const move = await call('POST', `/api/v1/${path}/bookings/${booking.id}/reschedule`, token, { newSlotStart: gy(gyDay(4), 15, 0).toISOString() });
      expect([400, 409], move.body).toContain(move.statusCode);
      expect(move.json().error.code).toBe('NOT_RESCHEDULABLE');
    }
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).appointmentSlot?.toISOString()).toBe(slot.toISOString());
    expect(await app.prisma.booking.count({ where: { orderId: order.id, status: { not: 'CANCELLED' } } })).toBe(1);
  });
});
