import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService, ORDER_TRANSITIONS } from '../modules/order/order.service';
import { BookingService } from '../modules/booking/booking.service';
import { RatingService } from '../modules/rating/rating.service';

// ---------------------------------------------------------------------------
// the locked order lifecycle. Hardest paths: the state
// machine under concurrency, ID-gate threshold boundaries, multi-vendor
// splits, and appointment slots booked at acceptance.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const ALL_STATUSES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

let app: FastifyInstance;
let orderService: OrderService;
let bookingService: BookingService;

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];

let seq = 0;
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200077${String(seq).padStart(2, '0')}`,
      firstName: 'Step7',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'step7-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor(opts: { type: 'RESTAURANT' | 'SUPERMARKET' | 'SERVICE'; minOrder?: number }) {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Step7 ${opts.type} ${seq}`,
      slug: `step7-${opts.type.toLowerCase()}-${seq}`,
      vendorType: opts.type,
      phone: `+5920008${String(seq).padStart(3, '0')}`,
      addressLine1: '1 Lifecycle Lane',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
      minOrderAmount: opts.minOrder ?? 0,
    },
  });
  const category = await app.prisma.category.create({
    data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 },
  });
  return { ...owned, vendorId: vendor.id, categoryId: category.id };
}

async function makeItem(vendorId: string, categoryId: string, name: string, price: number, extra?: object) {
  return app.prisma.item.create({
    data: { vendorId, categoryId, name, basePrice: price, ...extra },
  });
}

async function makeBareOrder(customerId: string, vendorId: string, status: OrderStatus) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `S7-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status,
      deliveryAddress: 'matrix',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 0,
      totalAmount: 1000,
      paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
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

/** Next occurrence of a UTC weekday at hh:mm, at least a day out. */
function nextUtc(dayOfWeek: number, hours: number, minutes: number): Date {
  const d = new Date(Date.now() + DAY);
  d.setUTCHours(hours, minutes, 0, 0);
  while (d.getUTCDay() !== dayOfWeek || d.getTime() <= Date.now()) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

let customer: { userId: string; token: string };

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orderService = new OrderService(app.prisma, ioStub);
  bookingService = new BookingService(app.prisma);

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: {
      userId: customer.userId,
      label: 'Home',
      addressLine1: '9 Customer Close',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      isDefault: true,
    },
  });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    const orders = await app.prisma.order.findMany({ where: { customerId: { in: createdUserIds } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await app.prisma.booking.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.rating.deleteMany({
      where: { OR: [{ raterId: { in: createdUserIds } }, { rateeId: { in: createdUserIds } }] },
    });
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('The state machine — exhaustive transition matrix', () => {
  it('permits exactly the locked transitions and refuses everything else', async () => {
    const vendor = await makeVendor({ type: 'RESTAURANT' });

    for (const target of ALL_STATUSES) {
      const allowed = new Set(ORDER_TRANSITIONS[target]);
      for (const from of ALL_STATUSES) {
        if (from === target) continue;
        const order = await makeBareOrder(customer.userId, vendor.vendorId, from);

        if (allowed.has(from)) {
          const updated = await orderService.updateStatus(order.id, target, 'matrix-test');
          expect(updated.status).toBe(target);
        } else {
          await expect(
            orderService.updateStatus(order.id, target, 'matrix-test'),
          ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
          const untouched = await app.prisma.order.findUniqueOrThrow({
            where: { id: order.id },
            select: { status: true },
          });
          expect(untouched.status).toBe(from);
        }
      }
    }
  }, 120_000);

  it('terminal states are terminal: nothing leaves DELIVERED via COMPLETED chain end or CANCELLED', async () => {
    const vendor = await makeVendor({ type: 'RESTAURANT' });
    const cancelled = await makeBareOrder(customer.userId, vendor.vendorId, 'CANCELLED');
    for (const target of ['ACCEPTED', 'PICKED_UP', 'DELIVERED'] as const) {
      await expect(orderService.updateStatus(cancelled.id, target, 't')).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
    }
  });

  it('a race between pickup and cancellation has exactly one winner', async () => {
    const vendor = await makeVendor({ type: 'RESTAURANT' });
    const order = await makeBareOrder(customer.userId, vendor.vendorId, 'READY_FOR_PICKUP');

    const results = await Promise.allSettled([
      orderService.updateStatus(order.id, 'PICKED_UP', 'rider'),
      orderService.updateStatus(order.id, 'CANCELLED', 'customer'),
    ]);

    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);

    const final = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(['PICKED_UP', 'CANCELLED']).toContain(final.status);

    const log = await app.prisma.orderStatusLog.findMany({ where: { orderId: order.id } });
    expect(log).toHaveLength(1); // only the winner appended evidence
  });
});

describe('Checkout — ID gate, multi-vendor split, fulfillment', () => {
  let restaurant: Awaited<ReturnType<typeof makeVendor>>;
  let supermarket: Awaited<ReturnType<typeof makeVendor>>;
  let burgerId: string;
  let riceId: string;

  beforeAll(async () => {
    restaurant = await makeVendor({ type: 'RESTAURANT' });
    supermarket = await makeVendor({ type: 'SUPERMARKET' });
    burgerId = (await makeItem(restaurant.vendorId, restaurant.categoryId, 'Gate Burger', 1000)).id;
    riceId = (await makeItem(supermarket.vendorId, supermarket.categoryId, 'Gate Rice', 3000)).id;
  });

  async function addToCart(token: string, vendorId: string, itemId: string, quantity = 1) {
    const res = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity }, token);
    expect([200, 201]).toContain(res.statusCode);
  }

  it('splits a multi-vendor cart into one order per vendor with correct totals', async () => {
    await addToCart(customer.token, restaurant.vendorId, burgerId, 2);
    await addToCart(customer.token, supermarket.vendorId, riceId, 1);

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;

    expect(data.orders).toHaveLength(2);
    for (const order of data.orders) createdOrderIds.push(order.id);

    const byVendor = new Map(data.orders.map((o: { vendorName: string; subtotal: number }) => [o.vendorName, o]));
    const restOrder = byVendor.get(`Step7 RESTAURANT ${restaurant.vendorId ? '' : ''}`.trim());
    void restOrder; // names carry seq — assert via subtotals instead
    const subtotals = data.orders.map((o: { subtotal: number }) => o.subtotal).sort((a: number, b: number) => a - b);
    expect(subtotals).toEqual([2000, 3000]);

    // Zero-commission: the customer pays exactly base price
    for (const order of data.orders) {
      const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(db.subtotalMarkup)).toBe(0);
      expect(Number(db.subtotalCustomer)).toBe(Number(db.subtotalBase));
      expect(Number(db.deliveryFee)).toBeGreaterThan(0); // both delivered
      expect(db.status).toBe('PENDING');
    }
  });

  it('cart preview shows base price with zero markup (display matches checkout)', async () => {
    await addToCart(customer.token, restaurant.vendorId, burgerId, 2); // base 1000 each

    const res = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(res.statusCode).toBe(200);
    const cart = res.json().data;

    // Customers see the vendor base price — no 5% markup on any surface
    for (const item of cart.items) {
      expect(item.customerPrice).toBe(item.basePrice);
    }
    expect(cart.subtotalMarkup).toBe(0);
    expect(cart.subtotalCustomer).toBe(cart.subtotalBase);
    expect(cart.subtotalCustomer).toBe(2000); // 2 x 1000, no markup

    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });

  it('PICKUP orders carry zero delivery fee and the vendor address', async () => {
    await addToCart(customer.token, supermarket.vendorId, riceId, 1);
    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      fulfillmentSelections: { [supermarket.vendorId]: 'PICKUP' },
    }, customer.token);
    expect(res.statusCode).toBe(200);
    const order = res.json().data.order;
    createdOrderIds.push(order.id);

    expect(order.fulfillment).toBe('PICKUP');
    expect(order.deliveryFee).toBe(0);
    expect(order.deliveryAddress).toContain('Lifecycle Lane');
    // Takeaway: the customer gets a 6-digit (CSPRNG) collection code.
    expect(order.pickupCode).toMatch(/^\d{6}$/);
  });

  it('express charges exactly 1.5x the delivery fee and flags the order — pickup ignores it', async () => {
    // Baseline: the same cart at standard speed
    await addToCart(customer.token, restaurant.vendorId, burgerId, 1);
    const std = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(std.statusCode).toBe(200);
    const stdOrder = std.json().data.order ?? std.json().data.orders[0];
    createdOrderIds.push(stdOrder.id);
    const stdFee = Number(stdOrder.deliveryFee);
    expect(stdFee).toBeGreaterThan(0);
    expect(stdOrder.isExpress).toBe(false);

    // Express: same route, 1.5x fee, flag persisted, premium in the total
    await addToCart(customer.token, restaurant.vendorId, burgerId, 1);
    const exp = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', express: true }, customer.token);
    expect(exp.statusCode).toBe(200);
    const expOrder = exp.json().data.order ?? exp.json().data.orders[0];
    createdOrderIds.push(expOrder.id);
    expect(Number(expOrder.deliveryFee)).toBe(Math.round(stdFee * 1.5));
    expect(expOrder.isExpress).toBe(true);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: expOrder.id } });
    expect(db.isExpress).toBe(true);
    expect(Number(db.totalAmount)).toBe(Number(db.subtotalBase) + Math.round(stdFee * 1.5));

    // Express is meaningless for pickup — no fee, no flag
    await addToCart(customer.token, supermarket.vendorId, riceId, 1);
    const pick = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      express: true,
      fulfillmentSelections: { [supermarket.vendorId]: 'PICKUP' },
    }, customer.token);
    expect(pick.statusCode).toBe(200);
    const pickOrder = pick.json().data.order;
    createdOrderIds.push(pickOrder.id);
    expect(pickOrder.deliveryFee).toBe(0);
    const pdb = await app.prisma.order.findUniqueOrThrow({ where: { id: pickOrder.id } });
    expect(pdb.isExpress).toBe(false);
  });

  describe('Takeaway — pickup completion (no rider)', () => {
    async function makePickupOrder(status: OrderStatus, pickupCode: string | null) {
      const order = await app.prisma.order.create({
        data: {
          orderNumber: `S7P-${nanoid(10)}`,
          orderType: 'FOOD_DELIVERY',
          customerId: customer.userId,
          vendorId: supermarket.vendorId,
          status,
          fulfillment: 'PICKUP',
          pickupCode,
          deliveryAddress: 'vendor counter',
          deliveryLat: 6.8,
          deliveryLng: -58.15,
          subtotalBase: 1000,
          subtotalMarkup: 0,
          subtotalCustomer: 1000,
          deliveryFee: 0,
          totalAmount: 1000,
          paymentMethod: 'CASH',
        },
      });
      createdOrderIds.push(order.id);
      return order;
    }

    it('rejects completing a non-pickup (delivery) order', async () => {
      const o = await makeBareOrder(customer.userId, supermarket.vendorId, 'READY_FOR_PICKUP'); // fulfillment defaults DELIVERY
      const res = await inject('PUT', `/api/v1/vendor/orders/${o.id}/complete-pickup`, {}, supermarket.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('NOT_A_PICKUP');
    });

    it('rejects a wrong pickup code', async () => {
      const o = await makePickupOrder('READY_FOR_PICKUP', '1234');
      const res = await inject('PUT', `/api/v1/vendor/orders/${o.id}/complete-pickup`, { code: '9999' }, supermarket.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('WRONG_PICKUP_CODE');
    });

    it('rejects completing before the order is ready', async () => {
      const o = await makePickupOrder('PREPARING', '1234');
      const res = await inject('PUT', `/api/v1/vendor/orders/${o.id}/complete-pickup`, { code: '1234' }, supermarket.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_STATUS');
    });

    it('completes a ready pickup with the right code → COMPLETED', async () => {
      const o = await makePickupOrder('READY_FOR_PICKUP', '4242');
      const res = await inject('PUT', `/api/v1/vendor/orders/${o.id}/complete-pickup`, { code: '4242' }, supermarket.token);
      expect(res.statusCode).toBe(200);
      const db = await app.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(db.status).toBe('COMPLETED');
    });
  });

  it('blocks an L1 account exactly at the ID-gate threshold, with the boundary just below passing', async () => {
    // Gate: 50 USD x 209 = 10,450 GYD (from the seeded CountryConfig)
    const bigId = (await makeItem(supermarket.vendorId, supermarket.categoryId, 'Gate Freezer', 10450)).id;
    const justUnderId = (await makeItem(supermarket.vendorId, supermarket.categoryId, 'Gate Fan', 10449)).id;

    // Just under: flows for L1 (PICKUP keeps the total exactly at item price)
    await addToCart(customer.token, supermarket.vendorId, justUnderId, 1);
    const under = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      fulfillmentSelections: { [supermarket.vendorId]: 'PICKUP' },
    }, customer.token);
    expect(under.statusCode).toBe(200);
    createdOrderIds.push(under.json().data.order.id);

    // Exactly at: blocked for L1 with a clear upgrade path
    await addToCart(customer.token, supermarket.vendorId, bigId, 1);
    const blocked = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      fulfillmentSelections: { [supermarket.vendorId]: 'PICKUP' },
    }, customer.token);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ID_VERIFICATION_REQUIRED');

    // L2 flows through the same cart
    await app.prisma.user.update({ where: { id: customer.userId }, data: { trustLevel: 'L2' } });
    const allowed = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      fulfillmentSelections: { [supermarket.vendorId]: 'PICKUP' },
    }, customer.token);
    expect(allowed.statusCode).toBe(200);
    createdOrderIds.push(allowed.json().data.order.id);

    await app.prisma.user.update({ where: { id: customer.userId }, data: { trustLevel: 'L1' } });
  });

  it('flags risky orders deterministically (new account + high value + odd hours)', async () => {
    const night = new Date();
    night.setUTCHours(3, 0, 0, 0); // 23:00 in Guyana (UTC-4)
    night.setUTCDate(night.getUTCDate() + 1);
    const noonUtc = new Date(night.getTime() + 13 * 60 * 60 * 1000); // 12:00 UTC -> 08:00 GYT

    const freshCustomer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const highValueId = (await makeItem(supermarket.vendorId, supermarket.categoryId, 'Risk Cooler', 6000)).id;

    for (const [now, expected] of [[night, true], [noonUtc, false]] as const) {
      await app.prisma.cart.create({
        data: {
          customerId: freshCustomer.userId,
          vendorId: supermarket.vendorId,
          items: { create: { itemId: highValueId, quantity: 1, selectedOptions: {} } },
        },
      });
      const result = await orderService.checkout({
        userId: freshCustomer.userId,
        paymentMethod: 'CASH',
        fulfillmentSelections: { [supermarket.vendorId]: 'PICKUP' },
        now,
      });
      createdOrderIds.push(result.order.id);
      expect(result.order.riskFlagged).toBe(expected);
    }
  });
});

describe('Appointments — booked at acceptance, never double-held', () => {
  let service: Awaited<ReturnType<typeof makeVendor>>;
  let haircutId: string;
  const slot = nextUtc(4, 11, 0); // next Thursday 11:00 UTC

  beforeAll(async () => {
    service = await makeVendor({ type: 'SERVICE' });
    haircutId = (await makeItem(service.vendorId, service.categoryId, 'Step7 Cut', 2000, {
      fulfillment: 'APPOINTMENT',
      bookingConfig: {
        durationMinutes: 30,
        slots: [{ dayOfWeek: 4, start: '09:00', end: '17:00' }],
      },
    })).id;
  });

  async function checkoutAppointment(cust: { userId: string; token: string }, slotStart: Date) {
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: service.vendorId, itemId: haircutId, quantity: 1 }, cust.token);
    return inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      appointments: [{ itemId: haircutId, slotStart: slotStart.toISOString() }],
    }, cust.token);
  }

  it('requires a slot at checkout and stores it on the PENDING order', async () => {
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: service.vendorId, itemId: haircutId, quantity: 1 }, customer.token);
    const missing = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('SLOT_REQUIRED');

    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      appointments: [{ itemId: haircutId, slotStart: slot.toISOString() }],
    }, customer.token);
    expect(res.statusCode).toBe(200);
    const order = res.json().data.order;
    createdOrderIds.push(order.id);
    expect(order.fulfillment).toBe('APPOINTMENT');
    expect(new Date(order.appointmentSlot).getTime()).toBe(slot.getTime());

    // No booking exists yet — the slot is claimed at vendor acceptance
    const bookings = await app.prisma.booking.count({ where: { itemId: haircutId, slotStart: slot } });
    expect(bookings).toBe(0);

    // Vendor accepts -> booking CONFIRMED and tied to the order
    const accept = await inject('PUT', `/api/v1/vendor/orders/${order.id}/accept`, {}, service.token);
    expect(accept.statusCode).toBe(200);
    const booking = await app.prisma.booking.findFirstOrThrow({ where: { orderId: order.id } });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.slotStart.getTime()).toBe(slot.getTime());
  });

  it('a second order on the same slot fails at acceptance and stays PENDING', async () => {
    const rival = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await checkoutAppointment(rival, slot);
    expect(res.statusCode).toBe(200);
    const order = res.json().data.order;
    createdOrderIds.push(order.id);

    const accept = await inject('PUT', `/api/v1/vendor/orders/${order.id}/accept`, {}, service.token);
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('SLOT_TAKEN');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(db.status).toBe('PENDING');
  });

  it('cancelling an accepted appointment frees the slot', async () => {
    const first = await app.prisma.booking.findFirstOrThrow({
      where: { itemId: haircutId, slotStart: slot, status: 'CONFIRMED' },
    });
    await orderService.cancelOrder(first.orderId!, customer.userId, 'changed my mind');

    const freed = await app.prisma.booking.findUniqueOrThrow({ where: { id: first.id } });
    expect(freed.status).toBe('CANCELLED');

    const rebooked = await bookingService.reserveSlot(haircutId, customer.userId, slot);
    expect(rebooked.status).toBe('RESERVED');
  });

  it('refuses mixing an appointment with goods in one vendor order', async () => {
    const snackId = (await makeItem(service.vendorId, service.categoryId, 'Lobby Snack', 500)).id;
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: service.vendorId, itemId: haircutId, quantity: 1 }, customer.token);
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: service.vendorId, itemId: snackId, quantity: 1 }, customer.token);

    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH',
      appointments: [{ itemId: haircutId, slotStart: nextUtc(4, 14, 0).toISOString() }],
    }, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MIXED_FULFILLMENT');

    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });
});

describe('Trust completeness', () => {
  it('only a transaction participant can rate (verified-transaction)', async () => {
    const vendor = await makeVendor({ type: 'RESTAURANT' });
    const order = await makeBareOrder(customer.userId, vendor.vendorId, 'DELIVERED');
    const ratings = new RatingService(app.prisma);

    const stranger = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await expect(
      ratings.rate({ orderId: order.id, raterId: stranger.userId, vendorId: vendor.vendorId, type: 'CUSTOMER_TO_VENDOR', score: 5 }),
    ).rejects.toThrow(/participant/i);

    const ok = await ratings.rate({ orderId: order.id, raterId: customer.userId, vendorId: vendor.vendorId, type: 'CUSTOMER_TO_VENDOR', score: 5 });
    expect(ok.score).toBe(5);
  });

  it('flags rating-bombing (3+ low scores from one rater against one target)', async () => {
    const vendor = await makeVendor({ type: 'RESTAURANT' });
    const ratings = new RatingService(app.prisma);
    for (let i = 0; i < 3; i++) {
      await app.prisma.rating.create({
        data: {
          orderId: `bomb-${nanoid(8)}`,
          raterId: customer.userId,
          vendorId: vendor.vendorId,
          type: 'CUSTOMER_TO_VENDOR',
          score: 1,
        },
      });
    }

    const flagged = await ratings.flagSuspiciousRatings();
    expect(flagged).toBeGreaterThanOrEqual(3);
    const count = await app.prisma.rating.count({ where: { vendorId: vendor.vendorId, flagged: true } });
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('issues a printable QR deep-link for a vendor', async () => {
    const vendor = await makeVendor({ type: 'RESTAURANT' });
    const res = await inject('GET', '/api/v1/vendor/qr', undefined, vendor.token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.deepLink).toContain('/v/');
    expect(data.svg).toContain('svg');
  });

  it('exposes region-specific CountryConfig fields (no hardcoding)', async () => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    expect(gy.taxiCredentialName).toBe('Hire Car Licence');
    expect(gy.insuranceClassName).toBe('Hire');
    expect(gy.locale).toBe('en-GY');
  });
});
