/**
 * [Owner research R9, 15 Oct 2026 · legal A1/D5] No bus on any hire, and no hire for more than 7 passengers.
 *
 * #1708 hid both buses at launch: no sign-up, vehicle change or GO with one, and the Group tier left the
 * riders' fares. Two doors stayed open (#1708's own deploy note): a bus driver who was ONLINE before that
 * update was still a dispatch candidate for Economy and Comfort rides (Group sits at the top of the class
 * ladder), and could see and accept them. R9 closes both: dispatch offers a ride only to a vehicle a hire
 * may use, the ride board shows a bus nothing, and the accept (and the locked claim behind it) refuses a
 * bus. A party of more than 7 is refused before anything is priced or written, queued or not.
 *
 * Fixtures: Kwakwani, a place no other suite uses, so only this file's drivers are ever candidates.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { RideClass, UserRole, VehicleType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { runWithoutTenant } from '../plugins/tenant-context';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { makeDispatchService, type DispatchService } from '../modules/dispatch/dispatch.service';
import * as vehicleClasses from '../config/vehicle-classes';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { currentMoverDocuments, currentTaxiSplitDocuments } from './helpers/current-mover-documents';

const DAY = 86_400_000;
const SPOT = { lat: 5.2833, lng: -58.05 }; // Kwakwani
const DROP = { lat: 5.2983, lng: -58.035 };
const phoneBase = 592_350_000_000 + Math.floor(Math.random() * 800_000_000);
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'r9-no-buses-on-hire');
const vc = vehicleClasses as unknown as Record<string, unknown>;

let app: FastifyInstance;
let dispatch: DispatchService;
let seq = 0;
const userIds: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Hire', lastName: `R9${seq}`, roles, activeRole, countryCode: 'GY',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', avatar: `/uploads/avatars/r9-${seq}.jpg`,
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `r9-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An online, free, freshly located driver with every document current, `meters` north of the pickup. */
async function makeDriver(vehicleType: VehicleType, rideClass: RideClass, seats: number, meters: number) {
  const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId, vehicleType, rideClass, vehicleCapacity: seats,
      vehicleMake: 'Toyota', vehicleModel: vehicleType === 'CAR' ? 'Allion' : 'Coaster', vehicleYear: 2019, vehicleColor: 'White',
      licensePlate: vehicleType === 'CAR' ? `HC ${4000 + seq}` : `BR ${4000 + seq}`,
      driverLicenseUrl: 'storage://r9/dl.jpg', vehicleInsuranceUrl: 'storage://r9/ins.jpg', documentsVerified: true,
      isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: SPOT.lat + meters / 111_000, currentLng: SPOT.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }));
  await sys(() => currentMoverDocuments(app.prisma, u.userId, vehicleType, true));
  await sys(() => currentTaxiSplitDocuments(app.prisma, u.userId));
  driverIds.push(driver.id);
  return { ...u, driverId: driver.id };
}

/** A cash Economy taxi request, waiting for a driver. */
async function makeRide(customer: Actor) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `R9-${nanoid(10)}`, orderType: 'TAXI', customerId: customer.userId, status: 'PENDING',
      pickupAddress: 'Kwakwani landing', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Kwakwani park', deliveryLat: DROP.lat, deliveryLng: DROP.lng,
      taxiPickupAddress: 'Kwakwani landing', taxiDropoffAddress: 'Kwakwani park',
      taxiPassengerCount: 1, rideClass: 'ECONOMY', taxiFareTotal: 1500,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500,
      paymentMethod: 'CASH', ridePin: '482915',
    },
  }));
  orderIds.push(order.id);
  return order;
}

const call = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
});

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
  dispatch = makeDispatchService(app);
}, 120_000);

afterEach(async () => {
  await sys(() => app.prisma.driver.updateMany({ where: { id: { in: driverIds }, isOnline: true }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
});

afterAll(async () => {
  await sys(async () => {
    const placed = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
    const all = [...new Set([...orderIds, ...placed.map((o) => o.id)])];
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: all } } });
    await app.prisma.order.deleteMany({ where: { id: { in: all } } });
    await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
}, 120_000);

describe('[R9] the hire seat limit', () => {
  it('a hire carries at most 7 passengers; the vehicles a hire may use are the car and the wagon car, never a bus', () => {
    expect(vc['MAX_HIRE_PASSENGERS']).toBe(7);
    expect(typeof vc['hireVehicleTypes']).toBe('function');
    expect((vc['hireVehicleTypes'] as () => string[])()).toEqual(['CAR', 'WAGON_CAR']);
    expect(vehicleClasses.isVehicleOffered('BUS_9')).toBe(false);
    expect(vehicleClasses.isVehicleOffered('BUS_15')).toBe(false);
    expect(vehicleClasses.isRideClassServed('GROUP')).toBe(false);
  });
});

describe('[R9] a bus online from before #1708 gets no ride at any door', () => {
  it('dispatch offers an Economy ride to the farther car, never to the nearer bus', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bus = await makeDriver('BUS_15', 'GROUP', 15, 100);
    const car = await makeDriver('CAR', 'ECONOMY', 4, 700);
    const ride = await makeRide(customer);
    const offered = (await dispatch.dispatchOrder(ride.id)).offered;
    expect(offered).not.toBe(bus.driverId);
    expect(offered).toBe(car.driverId);
  });

  it('with only a bus near, the ride is offered to nobody', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await makeDriver('BUS_9', 'GROUP', 9, 100);
    const ride = await makeRide(customer);
    expect((await dispatch.dispatchOrder(ride.id)).offered).toBeUndefined();
  });

  it('the bus’s ride board is empty, and its accept is refused in plain words with nothing written', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bus = await makeDriver('BUS_15', 'GROUP', 15, 100);
    const ride = await makeRide(customer);
    const board = await call('GET', '/api/v1/driver/rides/available', bus.token);
    expect(board.statusCode, board.body).toBe(200);
    expect((board.json().data as Array<{ id: string }>).map((r) => r.id)).not.toContain(ride.id);
    const accept = await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, bus.token, {});
    expect(accept.statusCode, accept.body).toBe(403);
    expect(accept.json().error.code).toBe('VEHICLE_NOT_OFFERED');
    expect(accept.json().error.message).toContain('buses');
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } })))).toMatchObject({ driverId: null, status: 'PENDING' });
  });
});

describe('[R9] no hire for more than 7 passengers', () => {
  const trip = { pickup: SPOT, dropoff: DROP, pickupAddress: 'Kwakwani landing', dropoffAddress: 'Kwakwani park', rideClass: 'ECONOMY' };

  it('a request for 8 is refused before anything is written, and says what to do', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await call('POST', '/api/v1/rides/request', customer.token, { ...trip, passengerCount: 8 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'TOO_MANY_PASSENGERS' });
    expect(res.json().error.message).toContain('at most 7 passengers');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);
  });

  it('a queue join for 8 is refused too: nothing waits that no hire may carry', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await call('POST', '/api/v1/rides/queue/join', customer.token, { ...trip, passengerCount: 8 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('TOO_MANY_PASSENGERS');
    expect(await sys(() => app.prisma.rideQueueEntry.count({ where: { customerId: customer.userId } }))).toBe(0);
  });
});
