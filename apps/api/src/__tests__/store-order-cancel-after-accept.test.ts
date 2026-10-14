import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  cancellationVerdict,
  isStoreOrder,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';

// ---------------------------------------------------------------------------
// Owner decision 46 (13 Oct 2026), after a staging screen showed "possible
// $500 late-cancellation fee" on a cash order: a customer cancels a STORE
// order free only while it is still waiting for the store to accept. Once the
// store accepts, a cash or MMG store order can no longer be cancelled by the
// customer — no Cancel button, no fee wording anywhere, the store's own
// published number instead ("contact the store"). Two exceptions stay free:
// no mover was found (11 Oct rule, retries included) and an order that is very
// late (the food-age cutoff the rescue sweep already enforces, and — owner
// #52, 14 Oct — thirty minutes past the promised time). Swift never shows or
// implies a fee it cannot collect.
//
// The rule lives in the ONE cancel predicate (cancel-policy.ts): the preview
// and the locked charge path read the same verdict, and the server refuses a
// late cancel with a plain code and message the clients show as-is.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PUBLISHED = '+5926001234';
const REFUSED_MESSAGE = 'The store has accepted your order, so it can no longer be cancelled in the app. Contact the store to change or cancel it.';
const AWAITING_STORE_MESSAGE = 'You can cancel for free until the store accepts your order.';
const TOO_LATE_MESSAGE = 'Your order is running very late. You can cancel it for free.';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_300_000_000 + Math.floor(Math.random() * 800_000_000);

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Store',
      lastName: `Cancel${seq}`,
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
      userId: user.id, token, refreshToken: nanoid(48), deviceId: 'store-cancel-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

/** The store's ACCOUNT line is deliberately distinctive: it must never reach a customer. */
async function makeVendor(opts: { publicPhone?: string | null; status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const accountLine = `+5922${String(phoneBase % 1_000_000 + seq).padStart(6, '0').slice(-6)}`;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Store Cancel Vendor ${seq}`,
      slug: `store-cancel-${nanoid(10).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: accountLine,
      publicPhone: opts.publicPhone === undefined ? PUBLISHED : opts.publicPhone,
      addressLine1: '1 Accept Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: opts.status ?? 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return { vendorId: vendor.id, accountLine };
}

async function makeStoreOrder(
  customerId: string,
  vendorId: string,
  status: OrderStatus,
  over: Record<string, unknown> = {},
) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SCA-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status,
      fulfillment: 'DELIVERY',
      placedAt: new Date(Date.now() - 30 * 60_000), // long past the old five-minute window
      deliveryAddress: 'store-cancel',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 500,
      totalAmount: 1500,
      paymentMethod: 'CASH',
      ...(status !== 'PENDING' ? { acceptedAt: new Date(Date.now() - 25 * 60_000) } : {}),
      ...over,
    } as never,
  });
  createdOrderIds.push(order.id);
  return order;
}

function inject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
  });
}

type Preview = {
  canCancel: boolean;
  freeCancellationWindow: boolean;
  cancellationFee: number;
  freeCancellationExpiresAt: string | null;
  cancellationMessage: string | null;
  cancelUnavailable: { code: string; message: string; contactPhone: string | null } | null;
};

async function preview(id: string, token: string) {
  const res = await inject('GET', `/api/v1/customer/orders/${id}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return { data: res.json().data as Preview, body: res.body };
}

let customer: { userId: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: createdOrderIds } } });
  // order deletion cascades the append-only status logs (never delete those directly)
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[owner #46] a store order cancels free only while it waits for the store', () => {
  it('a PENDING cash order long past the old five-minute window cancels free — no countdown, no fee', async () => {
    const { vendorId } = await makeVendor();
    const order = await makeStoreOrder(customer.userId, vendorId, 'PENDING');

    const { data } = await preview(order.id, customer.token);
    expect(data).toMatchObject({
      canCancel: true,
      freeCancellationWindow: true,
      cancellationFee: 0,
      // Free until the store accepts — there is no moment to count down to.
      freeCancellationExpiresAt: null,
      cancellationMessage: AWAITING_STORE_MESSAGE,
      cancelUnavailable: null,
    });

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'changed my mind' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.cancellationFee).toBe(0);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: row.status, lateCancelFeeDue: row.lateCancelFeeDue }).toEqual({ status: 'CANCELLED', lateCancelFeeDue: 0 });
  });

  it.each(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] as const)(
    '%s cash order: no Cancel, no fee wording, the store contact instead — and the server refuses',
    async (status) => {
      const { vendorId, accountLine } = await makeVendor();
      const order = await makeStoreOrder(customer.userId, vendorId, status);

      const { data, body } = await preview(order.id, customer.token);
      expect(data).toMatchObject({
        canCancel: false,
        freeCancellationWindow: false,
        cancellationFee: 0,
        freeCancellationExpiresAt: null,
        cancellationMessage: null,
        cancelUnavailable: { code: 'STORE_ACCEPTED', message: REFUSED_MESSAGE, contactPhone: PUBLISHED },
      });
      // The store's account/OTP line is never the contact (S1 High #6).
      expect(body).not.toContain(accountLine);

      const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'too slow' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'STORE_ACCEPTED', message: REFUSED_MESSAGE });
      expect(res.body).not.toMatch(/fee/i);

      // A refused cancel changes nothing: status, fee marker, evidence.
      const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect({ status: row.status, lateCancelFeeDue: row.lateCancelFeeDue, cancelledAt: row.cancelledAt })
        .toEqual({ status, lateCancelFeeDue: 0, cancelledAt: null });
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
    },
  );

  it('an accepted MMG order whose payment is not yet confirmed is refused the same way (MMG is a store order too)', async () => {
    const { vendorId } = await makeVendor();
    const order = await makeStoreOrder(customer.userId, vendorId, 'ACCEPTED', { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' });

    const { data } = await preview(order.id, customer.token);
    expect(data).toMatchObject({ canCancel: false, cancellationFee: 0, cancelUnavailable: { code: 'STORE_ACCEPTED' } });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STORE_ACCEPTED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');
  });

  it('the contact is only the number the store PUBLISHED — none when it published none, none for a suspended store', async () => {
    const quiet = await makeVendor({ publicPhone: null });
    const quietOrder = await makeStoreOrder(customer.userId, quiet.vendorId, 'ACCEPTED');
    const q = await preview(quietOrder.id, customer.token);
    expect(q.data.cancelUnavailable).toEqual({ code: 'STORE_ACCEPTED', message: REFUSED_MESSAGE, contactPhone: null });
    expect(q.body).not.toContain(quiet.accountLine);

    const suspended = await makeVendor({ status: 'SUSPENDED' });
    const suspendedOrder = await makeStoreOrder(customer.userId, suspended.vendorId, 'PREPARING');
    const s = await preview(suspendedOrder.id, customer.token);
    expect(s.data.cancelUnavailable?.contactPhone).toBeNull();
    expect(s.body).not.toContain(suspended.accountLine);
  });
});

describe('[owner #46] the two exceptions stay free after the store accepted', () => {
  it('no mover was found: free, in plain words', async () => {
    const { vendorId } = await makeVendor();
    const order = await makeStoreOrder(customer.userId, vendorId, 'READY_FOR_PICKUP', {
      fulfillmentMode: 'PLATFORM_RIDER', readyAt: new Date(Date.now() - 10 * 60_000),
    });
    await app.prisma.dispatchSearch.create({
      data: { subjectId: order.id, subjectType: 'ORDER', vertical: 'DELIVERY', status: 'EXHAUSTED', radiusKm: 5, deliveryAuthorityVersion: 0, exhaustedAt: new Date() },
    });

    const { data } = await preview(order.id, customer.token);
    expect(data).toMatchObject({ canCancel: true, freeCancellationWindow: true, cancellationFee: 0, cancelUnavailable: null });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.cancellationFee).toBe(0);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  });

  it('very late — past the food-age cutoff with nobody to carry it: free; just inside the cutoff: refused', async () => {
    const { vendorId } = await makeVendor();
    // FOOD_DELIVERY's cutoff is 45 minutes from ready (rescue.foodAgeMaxMinutes).
    const late = await makeStoreOrder(customer.userId, vendorId, 'READY_FOR_PICKUP', {
      fulfillmentMode: 'PLATFORM_RIDER', readyAt: new Date(Date.now() - 50 * 60_000),
    });
    const notYet = await makeStoreOrder(customer.userId, vendorId, 'READY_FOR_PICKUP', {
      fulfillmentMode: 'PLATFORM_RIDER', readyAt: new Date(Date.now() - 40 * 60_000),
    });

    const shown = await preview(late.id, customer.token);
    expect(shown.data).toMatchObject({
      canCancel: true, freeCancellationWindow: true, cancellationFee: 0,
      freeCancellationExpiresAt: null, cancellationMessage: TOO_LATE_MESSAGE, cancelUnavailable: null,
    });
    const res = await inject('POST', `/api/v1/customer/orders/${late.id}/cancel`, customer.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ cancellationFee: 0, message: 'Order cancelled because it was running very late.' });
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: late.id } });
    expect({ status: row.status, lateCancelFeeDue: row.lateCancelFeeDue }).toEqual({ status: 'CANCELLED', lateCancelFeeDue: 0 });

    expect((await preview(notYet.id, customer.token)).data.cancelUnavailable?.code).toBe('STORE_ACCEPTED');
    const refused = await inject('POST', `/api/v1/customer/orders/${notYet.id}/cancel`, customer.token, {});
    expect(refused.statusCode, refused.body).toBe(409);
  });

  it('[owner #52] 30 minutes past the promised time: free at any stage before pickup; at 29 minutes: refused', async () => {
    const { vendorId } = await makeVendor();
    for (const [status, over] of [
      ['ACCEPTED', {}],
      ['PREPARING', {}],
      // the store's own courier, ready but not gone (no food-age cutoff applies to it)
      ['READY_FOR_PICKUP', { fulfillmentMode: 'VENDOR_DELIVERY', readyAt: new Date(Date.now() - 5 * 60_000) }],
    ] as const) {
      const late = await makeStoreOrder(customer.userId, vendorId, status, { promisedAt: new Date(Date.now() - 31 * 60_000), ...over });
      const shown = await preview(late.id, customer.token);
      expect(shown.data).toMatchObject({ canCancel: true, cancellationFee: 0, freeCancellationExpiresAt: null, cancellationMessage: TOO_LATE_MESSAGE, cancelUnavailable: null });
      const res = await inject('POST', `/api/v1/customer/orders/${late.id}/cancel`, customer.token, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ message: 'Order cancelled because it was running very late.', cancellationFee: 0 });
    }
    const notYet = await makeStoreOrder(customer.userId, vendorId, 'PREPARING', { promisedAt: new Date(Date.now() - 29 * 60_000) });
    const refused = await inject('POST', `/api/v1/customer/orders/${notYet.id}/cancel`, customer.token, {});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('STORE_ACCEPTED');
  });

  it('[owner #52] a pickup is late from "ready in about N minutes" — until the store marks it ready (then the customer is the late one)', async () => {
    const { vendorId } = await makeVendor();
    const pickup = { fulfillment: 'PICKUP', fulfillmentMode: 'PICKUP', estimatedPrepTime: 15, placedAt: new Date(Date.now() - 46 * 60_000) };
    const cooking = await makeStoreOrder(customer.userId, vendorId, 'PREPARING', pickup);
    expect((await inject('POST', `/api/v1/customer/orders/${cooking.id}/cancel`, customer.token, {})).statusCode).toBe(200);
    const ready = await makeStoreOrder(customer.userId, vendorId, 'READY_FOR_PICKUP', { ...pickup, readyAt: new Date(Date.now() - 20 * 60_000) });
    const refused = await inject('POST', `/api/v1/customer/orders/${ready.id}/cancel`, customer.token, {});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('STORE_ACCEPTED');
  });

  it('[owner #52] a scheduled order is never late before its slot', async () => {
    const { vendorId } = await makeVendor();
    const order = await makeStoreOrder(customer.userId, vendorId, 'ACCEPTED', {
      promisedAt: new Date(Date.now() - 60 * 60_000), scheduledFor: new Date(Date.now() + 60 * 60_000),
    });
    expect((await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, {})).statusCode).toBe(409);
  });

  it.each([
    ['a pickup order (nobody delivers it)', { fulfillment: 'PICKUP', fulfillmentMode: 'PICKUP' }],
    ["the store's own courier", { fulfillmentMode: 'VENDOR_DELIVERY' }],
  ] as const)('the very-late exception follows the cutoff’s own scope: %s is refused', async (_label, over) => {
    const { vendorId } = await makeVendor();
    const order = await makeStoreOrder(customer.userId, vendorId, 'READY_FOR_PICKUP', {
      readyAt: new Date(Date.now() - 120 * 60_000), ...over,
    });
    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STORE_ACCEPTED');
  });
});

// ---------------------------------------------------------------------------
// The verdict itself — what both callers read.
// ---------------------------------------------------------------------------
describe('cancellationVerdict — the ONE predicate, store branch', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const store: CancellationSnapshot = {
    status: 'PENDING', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', placedAt: minutesAgo(30),
    holdExpiresAt: null, riderId: null, driverId: null, scheduledFor: null,
  };

  it('a store order is a marketplace order a business accepts — not a ride, a parcel or a booking', () => {
    expect(isStoreOrder({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY' })).toBe(true);
    expect(isStoreOrder({ orderType: 'GROCERY_DELIVERY', fulfillment: 'PICKUP' })).toBe(true);
    expect(isStoreOrder({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT' })).toBe(false);
    expect(isStoreOrder({ orderType: 'TAXI', fulfillment: 'DELIVERY' })).toBe(false);
    expect(isStoreOrder({ orderType: 'COURIER', fulfillment: 'DELIVERY' })).toBe(false);
  });

  it('waiting for the store: free at any age, scheduled or not', () => {
    expect(cancellationVerdict({ ...store, placedAt: minutesAgo(300) })).toMatchObject({ allowed: true, free: true, reason: 'AWAITING_STORE' });
    expect(cancellationVerdict({ ...store, scheduledFor: new Date(Date.now() + 2 * 60_000) })).toMatchObject({ allowed: true, free: true });
  });

  it('accepted: refused, never charged — whatever the clock or the schedule says', () => {
    for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED']) {
      expect(cancellationVerdict({ ...store, status, placedAt: minutesAgo(1) })).toMatchObject({ allowed: false, code: 'STORE_ACCEPTED' });
      expect(cancellationVerdict({ ...store, status, scheduledFor: new Date(Date.now() + DAY) })).toMatchObject({ allowed: false });
    }
  });

  it('a mover holding the job is never a free store cancel, even before acceptance (the assignment belt)', () => {
    expect(cancellationVerdict({ ...store, riderId: 'r1' })).toMatchObject({ allowed: false, code: 'STORE_ACCEPTED' });
    expect(cancellationVerdict({ ...store, status: 'READY_FOR_PICKUP', riderId: 'r1', noMoverFound: true, tooLateToDeliver: true }))
      .toMatchObject({ allowed: false });
  });

  it('the exceptions: no mover found, or too late to deliver — each free on its own', () => {
    const accepted = { ...store, status: 'READY_FOR_PICKUP' };
    expect(cancellationVerdict({ ...accepted, noMoverFound: true })).toMatchObject({ allowed: true, free: true, reason: 'NO_MOVER' });
    expect(cancellationVerdict({ ...accepted, tooLateToDeliver: true })).toMatchObject({ allowed: true, free: true, reason: 'TOO_LATE' });
    expect(cancellationVerdict({ ...accepted, noMoverFound: false, tooLateToDeliver: false })).toMatchObject({ allowed: false });
  });

  it('[owner #50] rides, parcels and bookings: free in the window, refused after it — never a fee', () => {
    const taxi = { ...store, orderType: 'TAXI', status: 'DRIVER_ASSIGNED', driverId: 'd1', placedAt: minutesAgo(10), acceptedAt: minutesAgo(9) };
    expect(cancellationVerdict(taxi)).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(cancellationVerdict({ ...taxi, placedAt: minutesAgo(4) })).toEqual({ allowed: true, free: true, reason: 'IN_WINDOW' });
    const booking = { ...store, fulfillment: 'APPOINTMENT', status: 'ACCEPTED' };
    expect(cancellationVerdict(booking)).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(cancellationVerdict({ ...booking, status: 'PENDING' })).toEqual({ allowed: true, free: true, reason: 'NOT_ACCEPTED' });
  });

  it('no verdict ever carries a fee: every allowed cancel is free', () => {
    const kinds = [
      store, { ...store, status: 'ACCEPTED' }, { ...store, orderType: 'TAXI', status: 'DRIVER_EN_ROUTE', driverId: 'd1' },
      { ...store, orderType: 'COURIER', status: 'RIDER_ASSIGNED', riderId: 'r1' }, { ...store, fulfillment: 'APPOINTMENT', status: 'ACCEPTED' },
    ];
    for (const order of kinds) {
      for (const at of [0, 3, 10, 45, 300]) {
        const verdict = cancellationVerdict({ ...order, placedAt: minutesAgo(at) });
        expect(verdict.allowed ? verdict.free : true).toBe(true);
      }
    }
  });
});
