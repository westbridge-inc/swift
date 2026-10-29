import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import {
  assertOneAppointment, isAppointmentOnlyGroup, storeFlagsAllowCheckout,
} from '../modules/booking/appointment-checkout';

// ---------------------------------------------------------------------------
// [BOOK-FU3 · 29 Oct 2026]
//
// 1. MONEY (REVIEW-M S4-1 on #2202). A booking line is ONE appointment. The
//    price is unit x quantity, so a line of 2 would charge twice for one time.
//    The API refuses it with a plain 400 at cart add, cart update, the guest
//    basket upload and checkout; the checkout refusal writes no order, takes no
//    time and gives no MMG instruction.
//
// 2. CLOSED NOW IS NOT "CAN'T OPERATE" (COORD ruling 29 Oct 00:09Z). A store
//    whose "open now" switch is off still takes a booking for a later time; a
//    store that is suspended, has paused its orders, whose documents lapsed or
//    whose weekly fee is not in good standing still refuses it, and the time
//    must be inside the listing's booking windows. A cart with goods is
//    unchanged: a closed store refuses it.
//
// Real routes on real PostgreSQL.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920869nnn): no other file uses it.
const PHONE_PREFIX = '+5920869';
const DAY = 24 * 60 * 60 * 1000;
const ONE = { code: 'APPOINTMENT_QUANTITY', message: 'A booking is for one appointment.' };

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
/** Tomorrow at 10:00, Guyana time. */
const tomorrowTen = () => gy(gyDay(1), 10);

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `FU3-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `fu3-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}
const customer = (name = 'Cy') => makeUser(name, ['CUSTOMER'], 'CUSTOMER');

/** A live Services business: one listing bookable 09:00-17:00 every day, and one ordinary (goods) item. */
async function makeBusiness(name: string, flags: Partial<{ isCurrentlyOpen: boolean; acceptingOrders: boolean }> = {}) {
  const owner = await makeUser(`${name}Owner`, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const v = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `FU3 ${name}`, slug: `fu3-${name.toLowerCase()}-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}${String(900 - vendorIds.length).padStart(3, '0')}`, addressLine1: '9 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', isVerified: true,
      isCurrentlyOpen: flags.isCurrentlyOpen ?? true, acceptingOrders: flags.acceptingOrders ?? true,
      mmgNumber: '+5926001288', mmgPayUrl: 'https://pay.example.com/pay/fu3',
    },
  });
  vendorIds.push(v.id);
  const category = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Chair', sortOrder: 0 } });
  const cut = await app.prisma.item.create({
    data: {
      vendorId: v.id, categoryId: category.id, name: `FU3 ${name} Cut`, basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })) },
    },
  });
  const comb = await app.prisma.item.create({
    data: { vendorId: v.id, categoryId: category.id, name: `FU3 ${name} Comb`, basePrice: 500, isAvailable: true },
  });
  return { vendorId: v.id, cutId: cut.id, combId: comb.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...headers,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const add = (who: Actor, vendorId: string, itemId: string, quantity?: number) =>
  call('POST', '/api/v1/customer/cart/items', who.token, { vendorId, itemId, ...(quantity !== undefined ? { quantity } : {}) });
const linesOf = (who: Actor) => app.prisma.cartItem.findMany({ where: { cart: { customerId: who.userId } }, select: { id: true, itemId: true, quantity: true } });
const ordersOf = (who: Actor) => app.prisma.order.count({ where: { customerId: who.userId } });
const bookingsOfCustomer = (who: Actor) => app.prisma.booking.count({ where: { customerId: who.userId } });
const checkout = (who: Actor, itemId: string, slot: Date, payment: Record<string, unknown> = { paymentMethod: 'CASH' }) =>
  call('POST', '/api/v1/customer/checkout', who.token, { ...payment, appointments: [{ itemId, slotStart: slot.toISOString() }] });

/** Cart = exactly this one booking (quantity 1, through the route), then checkout for that time. */
async function book(who: Actor, biz: { vendorId: string; cutId: string }, slot: Date, payment?: Record<string, unknown>) {
  expect((await call('DELETE', '/api/v1/customer/cart', who.token)).statusCode).toBe(200);
  const added = await add(who, biz.vendorId, biz.cutId, 1);
  expect(added.statusCode, added.body).toBe(201);
  return checkout(who, biz.cutId, slot, payment);
}

let shop: { vendorId: string; cutId: string; combId: string };

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  shop = await makeBusiness('Studio');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:book-fu3 one-appointment fixtures');
  if (orderIds.length > 0) {
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: userIds } }] } });
  await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cartMergeReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.booking.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[BOOK-FU3] the rules, as pure functions', () => {
  it('a booking line must be exactly 1; any other listing passes at any quantity', () => {
    expect(() => assertOneAppointment('APPOINTMENT', 1)).not.toThrow();
    for (const q of [0, 2, 3, 99]) {
      expect(() => assertOneAppointment('APPOINTMENT', q), String(q)).toThrow(ONE.message);
    }
    for (const f of ['DELIVERY', 'PICKUP', null, undefined]) expect(() => assertOneAppointment(f, 5)).not.toThrow();
  });

  it('closed right now stops goods but not a booking-only group; not ACTIVE or paused stops both', () => {
    const open = { status: 'ACTIVE', isCurrentlyOpen: true, acceptingOrders: true };
    const closedNow = { ...open, isCurrentlyOpen: false };
    expect(storeFlagsAllowCheckout(open, false)).toBe(true);
    expect(storeFlagsAllowCheckout(closedNow, false)).toBe(false);
    expect(storeFlagsAllowCheckout(closedNow, true)).toBe(true);
    for (const cannot of [{ ...closedNow, acceptingOrders: false }, { ...open, acceptingOrders: false }, { ...open, status: 'SUSPENDED' }, { ...closedNow, status: 'PENDING' }]) {
      expect(storeFlagsAllowCheckout(cannot, true), JSON.stringify(cannot)).toBe(false);
      expect(storeFlagsAllowCheckout(cannot, false), JSON.stringify(cannot)).toBe(false);
    }
  });

  it('a group is booking-only only when every line is an appointment', () => {
    const appt = { item: { fulfillment: 'APPOINTMENT' } };
    const goods = { item: { fulfillment: 'DELIVERY' } };
    expect(isAppointmentOnlyGroup([appt])).toBe(true);
    expect(isAppointmentOnlyGroup([appt, appt])).toBe(true);
    expect(isAppointmentOnlyGroup([appt, goods])).toBe(false);
    expect(isAppointmentOnlyGroup([goods])).toBe(false);
    expect(isAppointmentOnlyGroup([])).toBe(false);
  });
});

describe('[BOOK-FU3 · money] a booking line is one appointment', () => {
  it('cart add with quantity 2 on a booking: plain 400, nothing added', async () => {
    const a = await customer('Ada');
    const res = await add(a, shop.vendorId, shop.cutId, 2);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject(ONE);
    expect(await linesOf(a)).toEqual([]);
  });

  it('re-adding the same booking (quantity 1) leaves its line at 1, never 2', async () => {
    const a = await customer('Ben');
    expect((await add(a, shop.vendorId, shop.cutId, 1)).statusCode).toBe(201);
    const again = await add(a, shop.vendorId, shop.cutId, 1);
    expect(again.statusCode, again.body).toBe(200);
    expect(await linesOf(a)).toEqual([expect.objectContaining({ itemId: shop.cutId, quantity: 1 })]);
    // An older client that sends no quantity is the same.
    expect((await add(a, shop.vendorId, shop.cutId)).statusCode).toBe(200);
    expect((await linesOf(a)).map((l) => l.quantity)).toEqual([1]);
  });

  it('cart update of a booking line to 2: plain 400, the line stays 1; 0 still removes it', async () => {
    const a = await customer('Cleo');
    expect((await add(a, shop.vendorId, shop.cutId, 1)).statusCode).toBe(201);
    const [line] = await linesOf(a);
    const res = await call('PUT', `/api/v1/customer/cart/items/${line!.id}`, a.token, { quantity: 2 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject(ONE);
    expect((await linesOf(a)).map((l) => l.quantity)).toEqual([1]);
    expect((await call('PUT', `/api/v1/customer/cart/items/${line!.id}`, a.token, { quantity: 1 })).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/customer/cart/items/${line!.id}`, a.token, { quantity: 0 })).statusCode).toBe(200);
    expect(await linesOf(a)).toEqual([]);
  });

  it('control: an ordinary item still adds and updates past 1', async () => {
    const a = await customer('Dan');
    expect((await add(a, shop.vendorId, shop.combId, 2)).statusCode).toBe(201);
    expect((await add(a, shop.vendorId, shop.combId, 1)).statusCode).toBe(200);
    const [line] = await linesOf(a);
    expect(line!.quantity).toBe(3);
    expect((await call('PUT', `/api/v1/customer/cart/items/${line!.id}`, a.token, { quantity: 5 })).statusCode).toBe(200);
    expect((await linesOf(a)).map((l) => l.quantity)).toEqual([5]);
  });

  it('a guest basket upload with a booking of 2 does not land (QUANTITY_LIMIT); with 1 it does', async () => {
    const a = await customer('Eve');
    const upload = (quantity: number, key: string) => call('POST', '/api/v1/customer/cart/merge', a.token, {
      lines: [{ clientLineId: `l-${key}`, vendorId: shop.vendorId, itemId: shop.cutId, quantity, expectedUnitPrice: 2000 }],
    }, { 'idempotency-key': `fu3merge${key}${nanoid(6)}` });
    const two = await upload(2, 'a');
    expect(two.statusCode, two.body).toBe(200);
    expect(two.json().data).toMatchObject({ applied: false, verdicts: [expect.objectContaining({ status: 'QUANTITY_LIMIT' })] });
    expect(await linesOf(a)).toEqual([]);
    const one = await upload(1, 'b');
    expect(one.json().data).toMatchObject({ applied: true, verdicts: [expect.objectContaining({ status: 'ADDED' })] });
    expect((await linesOf(a)).map((l) => l.quantity)).toEqual([1]);
    // A second upload of the same booking would make it 2: it does not land either.
    const again = await upload(1, 'c');
    expect(again.json().data).toMatchObject({ applied: false, verdicts: [expect.objectContaining({ status: 'QUANTITY_LIMIT' })] });
    expect((await linesOf(a)).map((l) => l.quantity)).toEqual([1]);
  });

  for (const [i, [label, env, payment]] of ([
    ['cash, INSTANT_BOOKING off', '', { paymentMethod: 'CASH' }],
    ['MMG to the store number, INSTANT_BOOKING on', '1', { paymentMethod: 'MOBILE_MONEY', mmgPayTo: 'STORE_NUMBER' }],
    ['MMG pay link, INSTANT_BOOKING on', '1', { paymentMethod: 'MOBILE_MONEY' }],
  ] as const).entries()) {
    it(`checkout of a booking line of 2 (${label}): plain 400, no order, no time taken, no MMG instruction`, async () => {
      vi.stubEnv('INSTANT_BOOKING', env);
      vi.stubEnv('STORE_MMG_PAY_LINK', '1');
      vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
      const a = await customer('Fay');
      expect((await add(a, shop.vendorId, shop.cutId, 1)).statusCode).toBe(201);
      // A line of 2 however it got there (a line saved before this rule, any other writer).
      await app.prisma.cartItem.updateMany({ where: { cart: { customerId: a.userId } }, data: { quantity: 2 } });
      const res = await checkout(a, shop.cutId, gy(gyDay(3), 10 + i), payment);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toMatchObject(ONE);
      expect(res.body).not.toContain('paymentAction');
      expect(res.body).not.toContain('pay.example.com');
      expect(res.body).not.toContain('6001288');
      expect(await ordersOf(a)).toBe(0);
      expect(await bookingsOfCustomer(a)).toBe(0);
      expect((await linesOf(a)).map((l) => l.quantity)).toEqual([2]);
    });
  }

  it('control: the same checkout with a line of 1 places one order priced once', async () => {
    const a = await customer('Gus');
    const res = await book(a, shop, gy(gyDay(3), 16));
    expect(res.statusCode, res.body).toBe(200);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: res.json().data.order.id }, include: { items: true } });
    expect(order.items.map((i) => i.quantity)).toEqual([1]);
    expect(Number(order.subtotalCustomer)).toBe(2000);
  });
});

describe('[BOOK-FU3 · COORD 29 Oct] a closed-now store still takes a booking; a store that cannot operate does not', () => {
  it('closed tonight: booking tomorrow 10:00 is accepted (an order is placed for that time)', async () => {
    const biz = await makeBusiness('Night', { isCurrentlyOpen: false });
    const a = await customer('Hal');
    const slot = tomorrowTen();
    const res = await book(a, biz, slot);
    expect(res.statusCode, res.body).toBe(200);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: res.json().data.order.id } });
    expect(order).toMatchObject({ vendorId: biz.vendorId, status: 'PENDING', fulfillment: 'APPOINTMENT', appointmentSlot: slot });
  });

  it('closed tonight, INSTANT_BOOKING on: tomorrow 10:00 is booked and its time held in the same commit', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    const biz = await makeBusiness('NightHold', { isCurrentlyOpen: false });
    const a = await customer('Ivy');
    const res = await book(a, biz, tomorrowTen());
    expect(res.statusCode, res.body).toBe(200);
    expect(await app.prisma.booking.findMany({ where: { orderId: res.json().data.order.id }, select: { status: true } })).toEqual([{ status: 'RESERVED' }]);
  });

  it('closed tonight: a time outside the listing\'s booking windows is still refused (SLOT_OUTSIDE_HOURS)', async () => {
    const biz = await makeBusiness('NightLate', { isCurrentlyOpen: false });
    const a = await customer('Jo');
    const res = await book(a, biz, gy(gyDay(1), 20));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('SLOT_OUTSIDE_HOURS');
    expect(await ordersOf(a)).toBe(0);
  });

  for (const [label, flags] of [
    ['the owner paused orders (open switch on)', { isCurrentlyOpen: true, acceptingOrders: false }],
    ['the owner paused orders and the store is closed now', { isCurrentlyOpen: false, acceptingOrders: false }],
  ] as const) {
    it(`${label}: the booking is refused VENDOR_CLOSED, no order`, async () => {
      const biz = await makeBusiness(`Paused${label.length}`, flags);
      const a = await customer('Kai');
      const res = await book(a, biz, tomorrowTen());
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('VENDOR_CLOSED');
      expect(await ordersOf(a)).toBe(0);
    });
  }

  it('a suspended store refuses the booking (the cart already refuses it: VENDOR_UNAVAILABLE; checkout VENDOR_CLOSED)', async () => {
    const biz = await makeBusiness('Suspended', { isCurrentlyOpen: false });
    const a = await customer('Lou');
    expect((await add(a, biz.vendorId, biz.cutId, 1)).statusCode).toBe(201);
    await app.prisma.vendor.update({ where: { id: biz.vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'ADMIN' } });
    const res = await checkout(a, biz.cutId, tomorrowTen());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    expect(await ordersOf(a)).toBe(0);
  });

  it('a store whose weekly fee is not in good standing (subscription SUSPENDED) refuses the booking while closed', async () => {
    const biz = await makeBusiness('Unpaid', { isCurrentlyOpen: false });
    const end = new Date(Date.now() + 3 * DAY);
    await app.prisma.subscription.create({
      data: {
        vendorId: biz.vendorId, type: 'SERVICE_PROVIDER', status: 'SUSPENDED', suspendedAt: new Date(), weeklyRate: 2100, billingMethod: 'CASH',
        currentPeriodStart: new Date(end.getTime() - 7 * DAY), currentPeriodEnd: end, nextBillingDate: end,
      },
    });
    const a = await customer('May');
    const res = await book(a, biz, tomorrowTen());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    expect(await ordersOf(a)).toBe(0);
  });

  it('a store whose documents lapsed (activationValidUntil passed) refuses the booking while closed', async () => {
    const biz = await makeBusiness('Lapsed', { isCurrentlyOpen: false });
    await app.prisma.vendor.update({ where: { id: biz.vendorId }, data: { activationValidUntil: new Date(Date.now() - 60_000) } });
    const a = await customer('Ned');
    const res = await book(a, biz, tomorrowTen());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    expect(await ordersOf(a)).toBe(0);
  });

  it('a cart with goods at a closed store is unchanged: refused VENDOR_CLOSED', async () => {
    const biz = await makeBusiness('Goods', { isCurrentlyOpen: false });
    const a = await customer('Ola');
    expect((await add(a, biz.vendorId, biz.combId, 1)).statusCode).toBe(201);
    const res = await call('POST', '/api/v1/customer/checkout', a.token, { paymentMethod: 'CASH', fulfillmentSelections: { [biz.vendorId]: 'PICKUP' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    expect(await ordersOf(a)).toBe(0);
  });

  it('a booking together with goods at a closed store is refused VENDOR_CLOSED (only a booking-only cart is let through)', async () => {
    const biz = await makeBusiness('Mixed', { isCurrentlyOpen: false });
    const a = await customer('Pat');
    expect((await add(a, biz.vendorId, biz.cutId, 1)).statusCode).toBe(201);
    expect((await add(a, biz.vendorId, biz.combId, 1)).statusCode).toBe(201);
    const res = await checkout(a, biz.cutId, tomorrowTen());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    expect(await ordersOf(a)).toBe(0);
  });

  describe('decided again under the commit\'s vendor lock', () => {
    async function checkoutWithFlip(flip: Record<string, unknown>, goods = false) {
      const biz = await makeBusiness(`Flip${seq}`);
      const a = await customer('Quinn');
      expect((await add(a, biz.vendorId, goods ? biz.combId : biz.cutId, 1)).statusCode).toBe(201);
      const svc = new OrderService(app.prisma, app.io);
      const run = svc.checkout({
        userId: a.userId,
        paymentMethod: 'CASH',
        ...(goods
          ? { fulfillmentSelections: { [biz.vendorId]: 'PICKUP' as const } }
          : { appointments: [{ itemId: biz.cutId, slotStart: tomorrowTen() }] }),
        // The early check saw an open store; the store changes before the commit.
        beforeTransaction: async () => { await app.prisma.vendor.update({ where: { id: biz.vendorId }, data: flip }); },
      });
      return { a, run };
    }

    it('the store closes for the night between the early check and the commit: the booking is still placed', async () => {
      const { a, run } = await checkoutWithFlip({ isCurrentlyOpen: false });
      const res = await run;
      expect(res.orders).toHaveLength(1);
      expect(await ordersOf(a)).toBe(1);
    });

    it('control, goods: the store closes between the early check and the commit: VENDOR_CLOSED, no order', async () => {
      const { a, run } = await checkoutWithFlip({ isCurrentlyOpen: false }, true);
      await expect(run).rejects.toMatchObject({ statusCode: 400, code: 'VENDOR_CLOSED' });
      expect(await ordersOf(a)).toBe(0);
    });

    it('control, goods: with the store open throughout, the same pickup order is placed', async () => {
      const { a, run } = await checkoutWithFlip({}, true);
      expect((await run).orders).toHaveLength(1);
      expect(await ordersOf(a)).toBe(1);
    });

    it('the owner pauses orders between the early check and the commit: VENDOR_CLOSED, no order', async () => {
      const { a, run } = await checkoutWithFlip({ acceptingOrders: false });
      await expect(run).rejects.toMatchObject({ statusCode: 400, code: 'VENDOR_CLOSED' });
      expect(await ordersOf(a)).toBe(0);
    });

    it('the store is suspended between the early check and the commit: VENDOR_CLOSED, no order', async () => {
      const { a, run } = await checkoutWithFlip({ status: 'SUSPENDED', suspensionSource: 'ADMIN' });
      await expect(run).rejects.toMatchObject({ statusCode: 400, code: 'VENDOR_CLOSED' });
      expect(await ordersOf(a)).toBe(0);
    });
  });
});
