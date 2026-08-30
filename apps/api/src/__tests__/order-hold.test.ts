import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { OrderService, holdWindowMs } from '../modules/order/order.service';
import { vendorResponseSlaMinutes, vendorRespondBy } from '../modules/order/response-sla';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// LIFECYCLE_V2 hold (spec Part A). Core invariant: nothing is committed to a
// vendor or dispatched until the customer's cancel window closes. Failure
// paths first: the flag OFF must be byte-identical to today.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let orders: OrderService;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_200_000_000 + Math.floor(Math.random() * 700_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Hold', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'hold-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

let vendorOwner: { userId: string; token: string };
let vendorId: string;
let customer: { userId: string; token: string };

async function makeHeldOrder(opts: { holdMsFromNow: number; status?: OrderStatus; orderType?: 'FOOD_DELIVERY' | 'COURIER' } = { holdMsFromNow: 120_000 }) {
  return app.prisma.order.create({
    data: {
      orderNumber: `HOLD-${nanoid(8)}`,
      orderType: opts.orderType ?? 'FOOD_DELIVERY',
      customerId: customer.userId,
      ...(opts.orderType === 'COURIER' ? {} : { vendorId }),
      status: opts.status ?? (opts.orderType === 'COURIER' ? 'READY_FOR_PICKUP' : 'PENDING'),
      fulfillment: 'DELIVERY',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      pickupAddress: 'y', pickupLat: 6.81, pickupLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
      paymentMethod: 'CASH',
      holdExpiresAt: new Date(Date.now() + opts.holdMsFromNow),
      statusHistory: { create: { status: opts.status ?? 'PENDING', changedBy: customer.userId, note: 'placed (test)' } },
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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  orders = new OrderService(app.prisma, app.io);

  vendorOwner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: vendorOwner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Hold Diner ${seq}`, slug: `hold-diner-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `+5920008${String(seq).padStart(3, '0')}`, addressLine1: '1 Hold St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

beforeEach(() => {
  delete process.env['LIFECYCLE_V2'];
  delete process.env['ORDER_HOLD_MINUTES'];
});

afterAll(async () => {
  delete process.env['LIFECYCLE_V2'];
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

function inject(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
  });
}

describe('flag plumbing', () => {
  it('flag off → no hold window; flag on → configured minutes', () => {
    expect(holdWindowMs()).toBeNull();
    process.env['LIFECYCLE_V2'] = '1';
    // [F036-03b] The default IS the settled five minutes — an env that omits
    // the variable must not quietly shorten the documented window.
    expect(holdWindowMs()).toBe(5 * 60_000);
    process.env['ORDER_HOLD_MINUTES'] = '3';
    expect(holdWindowMs()).toBe(3 * 60_000);
    process.env['ORDER_HOLD_MINUTES'] = 'garbage';
    expect(holdWindowMs()).toBeNull(); // misconfiguration fails safe (no hold)
  });
});

describe('vendor blindness while held', () => {
  it('the board, the pending count and direct id access all exclude a held order', async () => {
    const held = await makeHeldOrder({ holdMsFromNow: 120_000 });

    const board = await inject('GET', '/api/v1/vendor/orders', vendorOwner.token);
    expect(board.statusCode).toBe(200);
    expect(board.json().data.some((o: any) => o.id === held.id)).toBe(false);

    const byId = await inject('GET', `/api/v1/vendor/orders/${held.id}`, vendorOwner.token);
    expect(byId.statusCode).toBe(404); // invisible even by direct id

    const overview = await inject('GET', '/api/v1/vendor/analytics/overview', vendorOwner.token);
    expect(overview.statusCode).toBe(200);
    // The held order must not count as actionable pending work.
    const pendingAll = await app.prisma.order.count({ where: { vendorId, status: 'PENDING' } });
    expect(overview.json().data.pendingOrders).toBeLessThan(pendingAll >= 1 ? pendingAll + 1 : 1);
  });

  it('a RELEASED order is visible again', async () => {
    const order = await makeHeldOrder({ holdMsFromNow: -1000 }); // already due
    await orders.releaseDueHeldOrders(async () => {});
    const board = await inject('GET', '/api/v1/vendor/orders', vendorOwner.token);
    expect(board.json().data.some((o: any) => o.id === order.id)).toBe(true);
  });
});

// The release tick NULLs holdExpiresAt and pushes the vendor alert. If that tick
// is down, holdExpiresAt stays set — but once it's in the PAST the customer's
// window has closed, and the server-clock notHeldFilter must still surface the
// order so the vendor can find and accept it off their board. This is the
// worker-outage backstop (order.service.ts:1114 "board still shows the order");
// without it a legitimately-placed order could sit invisible until the
// no-response auto-cancel reaped it. Locks that recovery independent of the tick.
describe('the vendor response deadline', () => {
  it('is placement + hold + SLA while PENDING, and null once the order is no longer waiting on the vendor', () => {
    const placedAt = new Date('2026-08-30T12:00:00Z');
    const order = { status: 'PENDING', placedAt, createdAt: new Date('2026-08-30T11:59:59Z') };
    expect(vendorRespondBy(order, { slaMinutes: 10, holdMs: 5 * 60_000 })?.toISOString()).toBe('2026-08-30T12:15:00.000Z');
    expect(vendorRespondBy(order, { slaMinutes: 10, holdMs: 0 })?.toISOString()).toBe('2026-08-30T12:10:00.000Z');
    // No placedAt (legacy row): the creation time is the placement.
    expect(vendorRespondBy({ ...order, placedAt: null }, { slaMinutes: 10, holdMs: 0 })?.toISOString()).toBe('2026-08-30T12:09:59.000Z');
    for (const status of ['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'CANCELLED']) {
      expect(vendorRespondBy({ ...order, status }, { slaMinutes: 10, holdMs: 0 })).toBeNull();
    }
  });

  it('an accepted order reads null on the detail — a clock on an accepted order would be a lie', async () => {
    const accepted = await makeHeldOrder({ holdMsFromNow: -60_000, status: 'PREPARING' });
    const byId = await inject('GET', `/api/v1/vendor/orders/${accepted.id}`, vendorOwner.token);
    expect(byId.statusCode).toBe(200);
    expect(byId.json().data.respondBy).toBeNull();
  });
});

describe('board-recovery backstop (release tick never ran)', () => {
  it('a past-due held order is visible on the board and acceptable by id even if the tick did not null it', async () => {
    const due = await makeHeldOrder({ holdMsFromNow: -60_000 }); // window closed, still flagged
    expect(due.holdExpiresAt).not.toBeNull(); // the tick has NOT run — no release CAS

    const board = await inject('GET', '/api/v1/vendor/orders', vendorOwner.token);
    expect(board.statusCode).toBe(200);
    expect(board.json().data.some((o: any) => o.id === due.id)).toBe(true); // recovered by the clock

    const byId = await inject('GET', `/api/v1/vendor/orders/${due.id}`, vendorOwner.token);
    expect(byId.statusCode).toBe(200); // and actionable by direct id, so the vendor can accept it

    // The accept-clock the takeover draws is the server's deadline — placement
    // + hold window + response SLA, exactly what auto-cancel was enqueued with —
    // on the board row and on the detail read alike. The client invents nothing.
    const slaMinutes = await vendorResponseSlaMinutes(app.prisma);
    const expected = new Date(due.placedAt.getTime() + (holdWindowMs() ?? 0) + slaMinutes * 60_000).toISOString();
    expect(board.json().data.find((o: any) => o.id === due.id).respondBy).toBe(expected);
    expect(byId.json().data.respondBy).toBe(expected);

    // A still-held order (window open) stays hidden — the backstop is the clock,
    // not a blanket "show everything".
    const future = await makeHeldOrder({ holdMsFromNow: 120_000 });
    const board2 = await inject('GET', '/api/v1/vendor/orders', vendorOwner.token);
    expect(board2.json().data.some((o: any) => o.id === future.id)).toBe(false);
  });
});

describe('held cancel', () => {
  it('is free regardless of clock games, and restores stock semantics', async () => {
    const held = await makeHeldOrder({ holdMsFromNow: 120_000 });
    // Backdate past the legacy 5-minute free window: the HOLD is what makes it free.
    await app.prisma.order.update({ where: { id: held.id }, data: { placedAt: new Date(Date.now() - 30 * 60_000) } });

    const res = await inject('POST', `/api/v1/customer/orders/${held.id}/cancel`, customer.token, { reason: 'changed my mind' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cancellationFee).toBe(0);

    const after = await app.prisma.order.findUnique({ where: { id: held.id } });
    expect(after!.status).toBe('CANCELLED');
  });
});

describe('release worker', () => {
  it('releases due orders exactly once, notifies the vendor, and is idempotent', async () => {
    const due = await makeHeldOrder({ holdMsFromNow: -5_000 });
    const notBefore = await app.prisma.notification.count({
      where: { userId: vendorOwner.userId, data: { path: ['orderId'], equals: due.id } },
    });

    const first = await orders.releaseDueHeldOrders(async () => {});
    expect(first.released).toContain(due.id);

    const row = await app.prisma.order.findUnique({ where: { id: due.id } });
    expect(row!.holdExpiresAt).toBeNull();
    expect(row!.releasedToVendorAt).not.toBeNull();
    expect(row!.status).toBe('PENDING'); // release is visibility, not a transition

    const notAfter = await app.prisma.notification.count({
      where: { userId: vendorOwner.userId, data: { path: ['orderId'], equals: due.id } },
    });
    expect(notAfter).toBe(notBefore + 1); // the vendor alert fired at release

    const second = await orders.releaseDueHeldOrders(async () => {});
    expect(second.released).not.toContain(due.id); // idempotent
  });

  it('leaves a not-yet-due hold alone', async () => {
    const early = await makeHeldOrder({ holdMsFromNow: 120_000 });
    const { released } = await orders.releaseDueHeldOrders(async () => {});
    expect(released).not.toContain(early.id);
  });

  it('a cancel that won the race means the release no-ops (no vendor notify)', async () => {
    const due = await makeHeldOrder({ holdMsFromNow: -5_000 });
    // Customer cancels a millisecond before the tick.
    await inject('POST', `/api/v1/customer/orders/${due.id}/cancel`, customer.token, {});
    const { released } = await orders.releaseDueHeldOrders(async () => {});
    expect(released).not.toContain(due.id);
    const note = await app.prisma.notification.findFirst({
      where: { userId: vendorOwner.userId, data: { path: ['orderId'], equals: due.id } },
    });
    expect(note).toBeNull(); // the vendor never hears about it
  });

  it('a due COURIER order starts its dispatch cascade at release', async () => {
    const courier = await makeHeldOrder({ holdMsFromNow: -5_000, orderType: 'COURIER' });
    const enqueued: string[] = [];
    const { released } = await orders.releaseDueHeldOrders(async (id) => {
      enqueued.push(id);
    });
    expect(released).toContain(courier.id);
    expect(enqueued).toContain(courier.id);
  });
});

describe('courier creation honors the flag', () => {
  const body = {
    pickup: { lat: 6.8, lng: -58.15 },
    dropoff: { lat: 6.82, lng: -58.14 },
    pickupAddress: '1 Hold Street, Georgetown',
    dropoffAddress: '2 Release Road, Georgetown',
    packageSize: 'SMALL',
    speed: 'STANDARD',
    recipientName: 'Test Recipient',
    recipientPhone: '+5926000000',
  };

  it('flag OFF: born unheld (current behavior)', async () => {
    const res = await inject('POST', '/api/v1/courier/order', customer.token, body);
    expect(res.statusCode).toBe(201);
    const order = await app.prisma.order.findUnique({ where: { id: res.json().data.id ?? res.json().data.orderId } });
    expect(order!.holdExpiresAt).toBeNull();
  });

  it('flag ON: born held and NOT dispatchable to riders', async () => {
    process.env['LIFECYCLE_V2'] = '1';
    const res = await inject('POST', '/api/v1/courier/order', customer.token, body);
    expect(res.statusCode).toBe(201);
    const id = res.json().data.id ?? res.json().data.orderId;
    const order = await app.prisma.order.findUnique({ where: { id } });
    expect(order!.holdExpiresAt).not.toBeNull();
    expect(order!.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
