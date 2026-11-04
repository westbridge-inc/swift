// [BUG-HUNT-2 G04 + G03] Nobody is stuck at the pickup. Through the real routes on a real database:
//  - G04: the driver marks arrived and then nothing happens. From 15 minutes with nobody aboard the passenger can cancel free.
//  - G03: the passenger never comes. From the no-show grace the driver records it: the ride ends with a true word, the driver
//    is not marked down, and no next driver is sent.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { OrderService } from '../modules/order/order.service';
import { PASSENGER_NO_SHOW_REASON } from '../modules/rides/passenger-no-show';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone } from './helpers/fixture-ids';

const MIN = 60_000;
const DAY = 86_400_000;
const pickup = { lat: 6.8055, lng: -58.1553 };
type Actor = { userId: string; token: string };

let app: FastifyInstance;
const queued: Array<{ name: string; data: unknown }> = [];
const userIds: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, extra: Record<string, unknown> = {}): Promise<Actor> {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Tess', lastName: 'Pickup', roles, activeRole: active, isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...extra,
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pickup', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function driverActor(): Promise<Actor & { driverId: string }> {
  const person = await actor(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({ data: {
    userId: person.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015, licensePlate: `T ${nanoid(6)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
    currentLat: pickup.lat, currentLng: pickup.lng, lastLocationUpdate: new Date(),
  } as never });
  driverIds.push(driver.id);
  return { ...person, driverId: driver.id };
}

/** A ride at `status`, its driver arrived `arrivedAgoMs` back (null: not arrived). */
async function ride(status: OrderStatus, arrivedAgoMs: number | null, over: Record<string, unknown> = {}) {
  const customer = await actor(['CUSTOMER'], 'CUSTOMER');
  const driver = await driverActor();
  const order = await app.prisma.order.create({ data: {
    orderNumber: `TPD-${nanoid(10)}`, customerId: customer.userId, orderType: 'TAXI', status: 'PENDING', placedAt: new Date(Date.now() - 40 * MIN),
    pickupAddress: 'Pickup', pickupLat: pickup.lat, pickupLng: pickup.lng, deliveryAddress: 'Drop', deliveryLat: 6.81, deliveryLng: -58.16,
    subtotalBase: 800, subtotalMarkup: 0, subtotalCustomer: 800, deliveryFee: 0, totalAmount: 800, paymentMethod: 'CASH', ridePin: '1234',
  } as never });
  orderIds.push(order.id);
  await walkOrderStatus(app.prisma, order.id, status, { driverId: driver.driverId, acceptedAt: new Date(Date.now() - 30 * MIN) });
  await app.prisma.order.update({ where: { id: order.id }, data: { driverArrivedAt: arrivedAgoMs === null ? null : new Date(Date.now() - arrivedAgoMs), ...over } });
  await app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: order.id, isAvailable: false, cancellationRate: 10 } });
  return { order, customer, driver };
}

function call(method: 'GET' | 'POST', url: string, as: Actor, payload?: unknown) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const handBack = (id: string, as: Actor, reason: string) => call('POST', `/api/v1/driver/rides/${id}/cancel`, as, { reason });
const passengerView = async (as: Actor) => (await call('GET', '/api/v1/rides/active', as)).json().data;
const passengerCancel = (id: string, as: Actor) => call('POST', `/api/v1/rides/${id}/cancel`, as, {});
const noticesOf = (userId: string) => app.prisma.notification.findMany({ where: { userId } });
const row = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.decorate('dispatchQueue', { add: async (name: string, data: unknown) => { queued.push({ name, data }); } } as never);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  vi.unstubAllEnvs();
});

describe('[G04] the driver marks arrived and then nothing happens', () => {
  it('before 15 minutes the passenger is refused, and from 15 minutes the screen offers a free cancel', async () => {
    const early = await ride('DRIVER_ARRIVED', 14 * MIN);
    const before = await passengerView(early.customer);
    expect(before.canCancel).toBe(false);
    expect((await passengerCancel(early.order.id, early.customer)).statusCode).toBe(409);

    const late = await ride('DRIVER_ARRIVED', 15 * MIN);
    const view = await passengerView(late.customer);
    expect(view.canCancel).toBe(true);
    expect(view.cancellationMessage).toBe('This ride is very late starting: your driver arrived 15 minutes ago and you are not aboard. You can cancel it for free.');
  });

  it('the cancel is free, the driver is told and freed, and no next driver is sent', async () => {
    const { order, customer, driver } = await ride('DRIVER_ARRIVED', 16 * MIN);
    queued.length = 0;
    const res = await passengerCancel(order.id, customer);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ cancellationFee: 0 });
    const closed = await row(order.id);
    expect(closed).toMatchObject({ status: 'CANCELLED', cancelledBy: customer.userId });
    expect(String(closed.totalAmount)).toBe('800');
    expect((await noticesOf(driver.userId)).map((notice) => notice.title)).toEqual(['Ride cancelled']);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } })).toMatchObject({ currentRideId: null, cancellationRate: 10 });
    expect(queued).toEqual([]);
  });

  it('a passenger aboard is never cancelled this way: the code was verified', async () => {
    const { order, customer } = await ride('DRIVER_ARRIVED', 40 * MIN, { ridePinVerified: true, ridePinVerifiedAt: new Date() });
    expect((await passengerView(customer)).canCancel).toBe(false);
    expect((await passengerCancel(order.id, customer)).statusCode).toBe(400);
    expect((await row(order.id)).status).toBe('DRIVER_ARRIVED');
  });
});

describe('[G03] the passenger never comes', () => {
  it('inside the grace the driver is told when, and nothing changes', async () => {
    const { order, driver } = await ride('DRIVER_ARRIVED', 4 * MIN);
    const res = await handBack(order.id, driver, 'Passenger did not arrive');
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NO_SHOW_TOO_EARLY');
    expect(res.json().error.message).toContain('minute');
    expect(await row(order.id)).toMatchObject({ status: 'DRIVER_ARRIVED', driverId: driver.driverId });
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } })).cancellationRate).toBe(10);
  });

  it('after the grace the ride ends: a true record, the driver free and not marked down, the passenger told, nobody sent', async () => {
    const { order, customer, driver } = await ride('DRIVER_ARRIVED', 6 * MIN);
    queued.length = 0;
    const res = await handBack(order.id, driver, 'Passenger did not arrive');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ orderId: order.id, status: 'CANCELLED', reDispatched: false });
    const closed = await row(order.id);
    expect(closed).toMatchObject({ status: 'CANCELLED', cancellationReason: PASSENGER_NO_SHOW_REASON, cancelledBy: driver.userId });
    expect(String(closed.totalAmount)).toBe('800');
    const log = closed.statusHistory.filter((entry) => entry.status === 'CANCELLED');
    expect(log).toHaveLength(1);
    expect(log[0]!.note).toContain(PASSENGER_NO_SHOW_REASON);
    expect(log[0]!.note).toContain('from the pickup');
    const free = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    expect(free).toMatchObject({ currentRideId: null, isAvailable: true, cancellationRate: 10 });
    expect(await app.prisma.strike.count({ where: { orderId: order.id } })).toBe(0);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
    expect(queued).toEqual([]);
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, driver.driverId)).toBe(0);
    const told = await noticesOf(customer.userId);
    expect(told.map((notice) => notice.title)).toEqual(['Ride closed']);
    expect(told[0]!.body).toContain('waited');
    expect(told[0]!.body).toContain('no fee');
    expect(told[0]!.data).toMatchObject({ orderId: order.id, status: 'CANCELLED' });
  });

  it('a lost reply: the second tap gets the same answer and tells nobody twice', async () => {
    const { order, customer, driver } = await ride('DRIVER_ARRIVED', 6 * MIN);
    expect((await handBack(order.id, driver, 'Passenger did not arrive')).statusCode).toBe(200);
    const again = await handBack(order.id, driver, 'Passenger did not arrive');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toEqual({ orderId: order.id, status: 'CANCELLED', reDispatched: false });
    expect(await noticesOf(customer.userId)).toHaveLength(1);
  });

  it('a driver who never arrived cannot record it: the passenger was not kept waiting', async () => {
    const { order, driver } = await ride('DRIVER_EN_ROUTE', null);
    const res = await handBack(order.id, driver, 'Passenger did not arrive');
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NO_SHOW_NOT_ARRIVED');
    expect((await row(order.id)).status).toBe('DRIVER_EN_ROUTE');
  });

  it('a passenger aboard cannot be recorded as absent', async () => {
    const { order, driver } = await ride('DRIVER_ARRIVED', 20 * MIN, { ridePinVerified: true, ridePinVerifiedAt: new Date() });
    expect((await handBack(order.id, driver, 'Passenger did not arrive')).statusCode).toBe(400);
    expect((await row(order.id)).status).toBe('DRIVER_ARRIVED');
  });

  it('only this ride\'s driver', async () => {
    const { order } = await ride('DRIVER_ARRIVED', 20 * MIN);
    const other = await driverActor();
    expect((await handBack(order.id, other, 'Passenger did not arrive')).statusCode).toBe(404);
    expect((await row(order.id)).status).toBe('DRIVER_ARRIVED');
  });

  it.each([
    ['the arrival moved', { driverArrivedAt: new Date() }, 'NO_SHOW_TOO_EARLY'],
    ['the code was verified', { ridePinVerified: true, ridePinVerifiedAt: new Date() }, 'INVALID_STATUS'],
  ])('the locked row decides: %s between the read and the lock wins', async (_why, change, code) => {
    const { order, customer, driver } = await ride('DRIVER_ARRIVED', 6 * MIN);
    const real = OrderService.prototype.transitionOrderAtomically;
    const spy = vi.spyOn(OrderService.prototype, 'transitionOrderAtomically').mockImplementationOnce(async function (this: OrderService, input) {
      await app.prisma.order.update({ where: { id: order.id }, data: change });
      return real.call(this, input);
    });
    const res = await handBack(order.id, driver, 'Passenger did not arrive');
    spy.mockRestore();
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe(code);
    expect((await row(order.id)).status).toBe('DRIVER_ARRIVED');
    expect(await noticesOf(customer.userId)).toHaveLength(0);
  });

  it('any other reason is still a hand-back: the passenger keeps the ride and the next driver is sent', async () => {
    const { order, customer, driver } = await ride('DRIVER_ARRIVED', 6 * MIN);
    queued.length = 0;
    const res = await handBack(order.id, driver, 'Vehicle problem');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'PENDING', reDispatched: true });
    expect(queued.map((job) => job.name)).toEqual(['dispatch-order']);
    expect((await noticesOf(customer.userId)).map((notice) => notice.title)).toEqual(['Finding you another driver']);
  });
});
