import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Owner decision 50 (14 Oct 2026): "remember the 5 minute timer to cancel —
// same thing, after the 5 minutes no cancelling allowed, so no fee shown."
// Rides, parcels and service bookings cancel FREE inside the five-minute
// window; after it there is no in-app cancel (the customer contacts the driver,
// the rider or the provider) and there is NO fee anywhere — the G$500 marker
// is gone. The exits that keep a customer from being stuck stay free: nobody
// has accepted it yet, no mover was found, and the driver/rider/provider is
// very late (owner #52: thirty minutes past the promised moment).
//
// One predicate (cancel-policy.ts) decides every door: the customer cancel,
// the ride cancel, and the parcel sender cancel — which used to be a fork that
// cancelled any parcel before pickup without asking the policy at all.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PUBLISHED = '+5926004321';
const RIDE_CLOSED = 'This ride can no longer be cancelled in the app: the 5-minute cancellation window has passed. Contact your driver.';
const PARCEL_CLOSED = 'This delivery can no longer be cancelled in the app: the 5-minute cancellation window has passed. Contact your rider.';
const BOOKING_CLOSED = 'This booking can no longer be cancelled in the app: the 5-minute cancellation window has passed. Contact the provider to change or cancel it.';
const VERY_LATE_MESSAGE = 'Your order is running very late. You can cancel it for free.';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdVendorIds: string[] = [];
const createdDriverIds: string[] = [];
const createdRiderIds: string[] = [];
let seq = 0;
const phoneBase = 592_310_000_000 + Math.floor(Math.random() * 800_000_000);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000);

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Window',
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
      userId: user.id, token, refreshToken: nanoid(48), deviceId: 'window-cancel-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeDriver() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
      licensePlate: `WC ${seq}${nanoid(3)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', documentsVerified: true,
      isOnline: false, isAvailable: false,
    },
  });
  createdDriverIds.push(driver.id);
  return driver.id;
}

async function makeRider() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: owned.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 100_000, committedFloat: 0, isOnline: false, isAvailable: false,
    },
  });
  createdRiderIds.push(rider.id);
  return rider.id;
}

async function makeProvider() {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Window Provider ${seq}`, slug: `window-provider-${nanoid(10).toLowerCase()}`,
      vendorType: 'SERVICE', phone: `+5922${String(phoneBase % 1_000_000 + seq).padStart(6, '0').slice(-6)}`,
      publicPhone: PUBLISHED, addressLine1: '1 Slot Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor.id;
}

const baseOrder = (customerId: string) => ({
  orderNumber: `WCR-${nanoid(10)}`,
  customerId,
  deliveryAddress: 'window-cancel',
  deliveryLat: 6.8,
  deliveryLng: -58.15,
  subtotalBase: 1000,
  subtotalMarkup: 0,
  subtotalCustomer: 1000,
  deliveryFee: 0,
  totalAmount: 1000,
  paymentMethod: 'CASH',
});

async function makeTaxi(customerId: string, status: OrderStatus, over: Record<string, unknown> = {}) {
  const driverId = status === 'PENDING' ? null : await makeDriver();
  const order = await app.prisma.order.create({
    data: {
      ...baseOrder(customerId),
      orderType: 'TAXI', status, fulfillment: 'DELIVERY',
      pickupAddress: '1 Pickup Road', pickupLat: 6.81, pickupLng: -58.16,
      taxiPickupAddress: '1 Pickup Road', taxiDropoffAddress: '2 Dropoff Road',
      driverId,
      ...over,
    } as never,
  });
  createdOrderIds.push(order.id);
  return order;
}

async function makeParcel(customerId: string, status: OrderStatus, over: Record<string, unknown> = {}) {
  const riderId = status === 'READY_FOR_PICKUP' || status === 'PENDING' ? null : await makeRider();
  const order = await app.prisma.order.create({
    data: {
      ...baseOrder(customerId),
      orderType: 'COURIER', status, fulfillment: 'DELIVERY',
      pickupAddress: '12 Sender Street', pickupLat: 6.81, pickupLng: -58.16,
      estimatedDeliveryTime: 20,
      riderId,
      ...over,
    } as never,
  });
  createdOrderIds.push(order.id);
  return order;
}

async function makeBooking(customerId: string, vendorId: string, status: OrderStatus, over: Record<string, unknown> = {}) {
  const order = await app.prisma.order.create({
    data: {
      ...baseOrder(customerId),
      orderType: 'FOOD_DELIVERY', status, fulfillment: 'APPOINTMENT', vendorId,
      appointmentSlot: new Date(Date.now() + DAY),
      ...(status !== 'PENDING' ? { acceptedAt: minutesAgo(1) } : {}),
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

type CancelView = {
  canCancel: boolean;
  cancellationFee?: number;
  freeCancellationExpiresAt: string | null;
  cancellationMessage: string | null;
  cancelUnavailable: { code: string; message: string; contactPhone?: string | null } | null;
};

async function orderPreview(id: string, token: string) {
  const res = await inject('GET', `/api/v1/customer/orders/${id}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as CancelView;
}

async function activeRide(token: string) {
  const res = await inject('GET', '/api/v1/rides/active', token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as CancelView & { id: string };
}

/** A refused cancel changes nothing: status, mover, marker, evidence. */
async function expectUntouched(id: string, status: OrderStatus, mover: { driverId?: string | null; riderId?: string | null }) {
  const row = await app.prisma.order.findUniqueOrThrow({ where: { id } });
  expect({ status: row.status, lateCancelFeeDue: row.lateCancelFeeDue, cancelledAt: row.cancelledAt, driverId: row.driverId, riderId: row.riderId })
    .toEqual({ status, lateCancelFeeDue: 0, cancelledAt: null, driverId: mover.driverId ?? null, riderId: mover.riderId ?? null });
  expect(await app.prisma.orderStatusLog.count({ where: { orderId: id } })).toBe(0);
}

/** A free cancel: CANCELLED, no marker, and no fee in the answer. */
async function expectCancelledFree(id: string, res: { statusCode: number; body: string; json: () => { data?: { message?: string; cancellationFee?: unknown } } }) {
  expect(res.statusCode, res.body).toBe(200);
  // No fee in the words, and the compatibility number is always zero.
  expect(res.json().data?.message ?? '').not.toMatch(/fee/i);
  expect(res.json().data?.cancellationFee).toBe(0);
  const row = await app.prisma.order.findUniqueOrThrow({ where: { id } });
  expect({ status: row.status, lateCancelFeeDue: row.lateCancelFeeDue }).toEqual({ status: 'CANCELLED', lateCancelFeeDue: 0 });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: createdOrderIds } } });
  // order deletion cascades the append-only status logs (never delete those directly)
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  await app.prisma.rider.deleteMany({ where: { id: { in: createdRiderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[owner #50] a ride cancels free inside the five-minute window, then not at all', () => {
  it('a driver accepted a minute in: still free at minute three — no fee, the driver is freed', async () => {
    const rider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const ride = await makeTaxi(rider.userId, 'DRIVER_ASSIGNED', { placedAt: minutesAgo(3), acceptedAt: minutesAgo(2) });

    const shown = await activeRide(rider.token);
    expect(shown).toMatchObject({ id: ride.id, canCancel: true, cancelUnavailable: null });
    expect(Date.parse(shown.freeCancellationExpiresAt ?? '')).toBe(ride.placedAt.getTime() + 5 * 60_000);

    const res = await inject('POST', `/api/v1/rides/${ride.id}/cancel`, rider.token, {});
    await expectCancelledFree(ride.id, res);
    expect(res.json().data).toEqual({ message: 'Ride cancelled — no charge', cancellationFee: 0 });
  });

  it.each(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'] as const)(
    '%s after the window: no Cancel, the reason in plain words — and the server refuses, writing nothing',
    async (status) => {
      const rider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
      const ride = await makeTaxi(rider.userId, status, { placedAt: minutesAgo(10), acceptedAt: minutesAgo(8) });

      expect(await activeRide(rider.token)).toMatchObject({
        id: ride.id, canCancel: false, freeCancellationExpiresAt: null, cancellationMessage: null,
        cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED', message: RIDE_CLOSED },
      });
      // The customer order screen reads the same verdict.
      expect(await orderPreview(ride.id, rider.token)).toMatchObject({
        canCancel: false, cancellationFee: 0, cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED', message: RIDE_CLOSED, contactPhone: null },
      });

      const res = await inject('POST', `/api/v1/rides/${ride.id}/cancel`, rider.token, {});
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'CANCEL_WINDOW_CLOSED', message: RIDE_CLOSED });
      await expectUntouched(ride.id, status, { driverId: ride.driverId });
    },
  );

  it('nobody has accepted the ride yet: free at any age (the search is still running — no one to contact)', async () => {
    const rider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const ride = await makeTaxi(rider.userId, 'PENDING', { placedAt: minutesAgo(20) });

    expect(await activeRide(rider.token)).toMatchObject({ id: ride.id, canCancel: true, freeCancellationExpiresAt: null, cancelUnavailable: null });
    await expectCancelledFree(ride.id, await inject('POST', `/api/v1/rides/${ride.id}/cancel`, rider.token, {}));
  });

  it('the driver is very late — 30 minutes after accepting and still not there: free; at 29 minutes: refused', async () => {
    const rider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const late = await makeTaxi(rider.userId, 'DRIVER_EN_ROUTE', { placedAt: minutesAgo(32), acceptedAt: minutesAgo(31) });
    expect(await activeRide(rider.token)).toMatchObject({ id: late.id, canCancel: true, cancellationMessage: VERY_LATE_MESSAGE });
    const res = await inject('POST', `/api/v1/rides/${late.id}/cancel`, rider.token, {});
    await expectCancelledFree(late.id, res);
    expect(res.json().data.message).toBe('Ride cancelled because it was running very late.');

    const rider2 = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const notYet = await makeTaxi(rider2.userId, 'DRIVER_EN_ROUTE', { placedAt: minutesAgo(30), acceptedAt: minutesAgo(29) });
    const refused = await inject('POST', `/api/v1/rides/${notYet.id}/cancel`, rider2.token, {});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('CANCEL_WINDOW_CLOSED');
  });

  it('a driver who has ARRIVED is not late: refused, however long ago the ride was booked', async () => {
    const rider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const ride = await makeTaxi(rider.userId, 'DRIVER_ARRIVED', {
      placedAt: minutesAgo(60), acceptedAt: minutesAgo(55), driverArrivedAt: minutesAgo(2),
    });
    const res = await inject('POST', `/api/v1/rides/${ride.id}/cancel`, rider.token, {});
    expect(res.statusCode, res.body).toBe(409);
    await expectUntouched(ride.id, 'DRIVER_ARRIVED', { driverId: ride.driverId });
  });
});

describe('[owner #50] a parcel follows the same rule — through the sender cancel too (no fork)', () => {
  it('a rider holds the parcel job past the window: the sender cancel is refused, nothing changes', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const parcel = await makeParcel(sender.userId, 'RIDER_ASSIGNED', { placedAt: minutesAgo(10) });

    const res = await inject('POST', `/api/v1/courier/order/${parcel.id}/cancel`, sender.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CANCEL_WINDOW_CLOSED', message: PARCEL_CLOSED });
    await expectUntouched(parcel.id, 'RIDER_ASSIGNED', { riderId: parcel.riderId });

    // The generic customer cancel and its preview say the same.
    expect(await orderPreview(parcel.id, sender.token)).toMatchObject({
      canCancel: false, cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED', message: PARCEL_CLOSED },
    });
    const generic = await inject('POST', `/api/v1/customer/orders/${parcel.id}/cancel`, sender.token, {});
    expect(generic.statusCode, generic.body).toBe(409);
    expect(generic.json().error.code).toBe('CANCEL_WINDOW_CLOSED');
  });

  it('inside the window the sender cancel is free even with a rider on it', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const parcel = await makeParcel(sender.userId, 'RIDER_ASSIGNED', { placedAt: minutesAgo(2) });
    const res = await inject('POST', `/api/v1/courier/order/${parcel.id}/cancel`, sender.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: parcel.id } })).status).toBe('CANCELLED');
  });

  it('no rider has taken it: free at any age', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const parcel = await makeParcel(sender.userId, 'READY_FOR_PICKUP', { placedAt: minutesAgo(40) });
    const res = await inject('POST', `/api/v1/courier/order/${parcel.id}/cancel`, sender.token, {});
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the rider is very late — 30 minutes past the quoted job time and still not at the pickup: free', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    // Quoted 20 minutes: very late from minute 50.
    const late = await makeParcel(sender.userId, 'RIDER_EN_ROUTE_PICKUP', { placedAt: minutesAgo(51) });
    expect(await orderPreview(late.id, sender.token)).toMatchObject({ canCancel: true, cancellationMessage: VERY_LATE_MESSAGE });
    expect((await inject('POST', `/api/v1/courier/order/${late.id}/cancel`, sender.token, {})).statusCode).toBe(200);

    const notYet = await makeParcel(sender.userId, 'RIDER_EN_ROUTE_PICKUP', { placedAt: minutesAgo(48) });
    expect((await inject('POST', `/api/v1/courier/order/${notYet.id}/cancel`, sender.token, {})).statusCode).toBe(409);
  });
});

describe('[owner #50] a booking: free in the window or until the provider accepts; then contact the provider', () => {
  it('accepted, past the window: no Cancel, the provider’s published number, the server refuses', async () => {
    const vendorId = await makeProvider();
    const me = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const booking = await makeBooking(me.userId, vendorId, 'ACCEPTED', { placedAt: minutesAgo(10) });

    expect(await orderPreview(booking.id, me.token)).toMatchObject({
      canCancel: false, cancellationFee: 0, freeCancellationExpiresAt: null,
      cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED', message: BOOKING_CLOSED, contactPhone: PUBLISHED },
    });
    const res = await inject('POST', `/api/v1/customer/orders/${booking.id}/cancel`, me.token, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CANCEL_WINDOW_CLOSED', message: BOOKING_CLOSED });
    await expectUntouched(booking.id, 'ACCEPTED', {});
  });

  it('accepted within the window: free, counting down to placing + 5 minutes', async () => {
    const vendorId = await makeProvider();
    const me = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const booking = await makeBooking(me.userId, vendorId, 'ACCEPTED', { placedAt: minutesAgo(2) });
    const shown = await orderPreview(booking.id, me.token);
    expect(shown).toMatchObject({ canCancel: true, cancellationFee: 0, cancelUnavailable: null });
    expect(Date.parse(shown.freeCancellationExpiresAt ?? '')).toBe(booking.placedAt.getTime() + 5 * 60_000);
    const res = await inject('POST', `/api/v1/customer/orders/${booking.id}/cancel`, me.token, {});
    await expectCancelledFree(booking.id, res);
    expect(res.json().data).toEqual({ message: 'Booking cancelled — no charge', cancellationFee: 0 });
  });

  it('the provider never accepted: free at any age, even with the slot two minutes away', async () => {
    const vendorId = await makeProvider();
    const me = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const booking = await makeBooking(me.userId, vendorId, 'PENDING', { placedAt: minutesAgo(2 * 24 * 60), appointmentSlot: minutesAhead(2) });
    await expectCancelledFree(booking.id, await inject('POST', `/api/v1/customer/orders/${booking.id}/cancel`, me.token, {}));
  });

  it('the provider is very late — 30 minutes past the slot, never completed: free; at 29: refused', async () => {
    const vendorId = await makeProvider();
    const me = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const late = await makeBooking(me.userId, vendorId, 'ACCEPTED', { placedAt: minutesAgo(3 * 60), appointmentSlot: minutesAgo(31) });
    await expectCancelledFree(late.id, await inject('POST', `/api/v1/customer/orders/${late.id}/cancel`, me.token, {}));
    const notYet = await makeBooking(me.userId, vendorId, 'ACCEPTED', { placedAt: minutesAgo(3 * 60), appointmentSlot: minutesAgo(29) });
    expect((await inject('POST', `/api/v1/customer/orders/${notYet.id}/cancel`, me.token, {})).statusCode).toBe(409);
  });
});
