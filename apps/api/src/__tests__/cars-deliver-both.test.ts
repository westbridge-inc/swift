import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, VehicleType } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { makeDispatchService, type DispatchService } from '../modules/dispatch/dispatch.service';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';

// ---------------------------------------------------------------------------
// [CARS-DELIVER PR4 · owner 8 Oct "or get both" · COORD ruling 26 Oct] "Taxi + deliveries". Fixtures and switch
// handling as in cars-deliver.test.ts (PR1); this file proves PR4 below its own header.
// ---------------------------------------------------------------------------
// (PR1 header, kept for the shared fixtures:)
// [CARS-DELIVER · owner 8 Oct 2026 + 25 Oct 22:33Z] "Cars can deliver": a verified taxi driver's car can
// also take store deliveries ("Deliveries too"), behind the CAR_DELIVERIES switch (OFF unless exactly '1';
// GUARDRAILS §8: taxi cars carry passengers only until counsel verifies goods carriage).
//
// The deliveries run on a DELIVERY PROFILE (the account's Rider row) that mirrors the taxi car, so every
// delivery rule is the rider's, and an order binds riderId — never driverId. Proven here through the real
// routes:
//   switch OFF: "Deliveries too" is not offered and its door writes nothing; a taxi car's delivery profile
//     cannot go online; the taxi profile's GO and its place in the taxi pool are exactly as before;
//   switch ON: a verified taxi driver sets it up (the car mirrored, store orders only, offline, the work app
//     unchanged), switches to deliveries, goes online, is offered a store order and claims it on the
//     delivery profile; going back to taxi retires the delivery supply; delivery GO re-syncs the car from
//     the taxi profile; a claim needs the taxi document verdict on the same car; a vehicle change carries
//     the delivery profile to the new car and retires the old car's papers; the car's cash deliveries count in
//     the delivery profile's CASH COLLECTED (#2117) after paying the store, and never in the taxi figure.
//
// Fixtures: Kato, far from every other suite, so only this file's movers are ever candidates.
// ---------------------------------------------------------------------------

const SPOT = { lat: 4.236, lng: -59.613 }; // Kurupukari, far from every other suite (PR1's file uses Kato)
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = 'cars-deliver-both-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const NUM = String(Date.now()).slice(-4);

let app: FastifyInstance;
let dispatch: DispatchService;
let vendorId = '';
let itemId = '';
let seq = 0;
const phoneBase = 592_360_000_000 + Math.floor(Math.random() * 800_000_000);
const userIds: string[] = [];
const orderIds: string[] = [];

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Kato', lastName: `K${seq}`, roles, activeRole, countryCode: 'GY',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      ...extra,
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `cars-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** The taxi car's current hire documents: hire-class insurance + both hire licences (what taxi GO reads). */
async function hireDocuments(userId: string) {
  await sys(() => app.prisma.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
    fileUrl: `storage://synthetic/cars-deliver/insurance-${nanoid(4)}`, expiresAt: new Date(Date.now() + 30 * DAY),
    coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true,
  } }));
  await sys(() => currentTaxiSplitDocuments(app.prisma, userId));
}

/** A taxi driver on an H-plate car, offline, with a running weekly plan. `verified` = the taxi papers are current. */
async function makeTaxiDriver(opts: { verified?: boolean; vehicleType?: VehicleType; plan?: boolean } = {}) {
  const u = await makeUser(['CUSTOMER', 'MOVER', 'DRIVER'], 'DRIVER', { lastMoverRole: 'DRIVER' });
  const plate = `HK ${NUM}${String(seq).padStart(2, '0')}`;
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId, vehicleType: opts.vehicleType ?? 'CAR', rideClass: opts.vehicleType === 'WAGON_CAR' ? 'COMFORT' : 'ECONOMY',
      vehicleCapacity: opts.vehicleType === 'WAGON_CAR' ? 5 : 4,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver', licensePlate: plate,
      vehiclePhotoUrl: `vehicles/synthetic/${nanoid(6)}.jpg`, profilePhotoUrl: `avatars/synthetic/${nanoid(6)}.jpg`,
      driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg',
      documentsVerified: true, documentsVerifiedAt: new Date(Date.now() - DAY), documentsVerifiedBy: 'cars-deliver-test',
      isOnline: false, isAvailable: false,
    },
  }));
  if (opts.plan !== false) await sys(() => app.prisma.subscription.create({ data: {
    driverId: driver.id, type: 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 8000,
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
  } }));
  if (opts.verified !== false) await hireDocuments(u.userId);
  return { ...u, driverId: driver.id, plate };
}

/** A delivery profile on the driver's car, written directly (as the enable route leaves it). */
async function seedCarProfile(driver: { userId: string }) {
  const d = await sys(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: driver.userId } }));
  const rider = await sys(() => app.prisma.rider.create({ data: {
    userId: driver.userId, riderType: 'DELIVERY', vehicleType: d.vehicleType, vehicleMake: d.vehicleMake, vehicleModel: d.vehicleModel,
    vehicleYear: d.vehicleYear, vehicleColor: d.vehicleColor, licensePlate: d.licensePlate, documentsVerified: d.documentsVerified,
    floatLimit: 20_000, isOnline: false, isAvailable: false,
  } }));
  await sys(() => app.prisma.user.update({ where: { id: driver.userId }, data: { roles: ['CUSTOMER', 'MOVER', 'DRIVER', 'RIDER'] } }));
  return rider.id;
}

async function makeReadyOrder(customerId: string) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `CARB-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
      pickupAddress: 'Kato Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Kato homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      paymentMethod: 'CASH',
      items: { create: [{
        itemId, name: 'Rice plate', quantity: 1,
        basePrice: 2000, markedUpPrice: 2000, markupAmount: 0, totalBase: 2000, totalMarkup: 0, totalCustomer: 2000,
      }] },
    },
  }));
  orderIds.push(order.id);
  return order;
}

const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const here = { latitude: SPOT.lat + 0.001, longitude: SPOT.lng };
const riderOf = (userId: string) => sys(() => app.prisma.rider.findUnique({ where: { userId } }));
const driverOf = (userId: string) => sys(() => app.prisma.driver.findUniqueOrThrow({ where: { userId } }));
const userOf = (userId: string) => sys(() => app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { roles: true, activeRole: true, lastMoverRole: true } }));

/** The taxi pool's answer for a ride at SPOT (the same search a ride request runs). */
async function taxiPool() {
  const found = await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'DRIVER', 0, 'ECONOMY', null, null, null, 1);
  return found.map((c) => c.riderId).sort();
}

const priorSwitch = process.env['CAR_DELIVERIES'];

beforeAll(async () => {
  delete process.env['CAR_DELIVERIES'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
  dispatch = makeDispatchService(app);

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Kurupukari Store', slug: `kurupukari-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5927728899',
        addressLine1: '1 Kato Road', city: 'Kato', region: 'Potaro-Siparuni', latitude: SPOT.lat, longitude: SPOT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Rice plate', basePrice: 2000, isAvailable: true } });
    return { vendorId: vendor.id, itemId: item.id };
  });
  vendorId = ids.vendorId;
  itemId = ids.itemId;
}, 120_000);

afterEach(async () => {
  // Park every mover of this file, so the next case starts from an empty pool.
  await sys(() => app.prisma.rider.updateMany({ where: { userId: { in: userIds }, isOnline: true }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
  await sys(() => app.prisma.driver.updateMany({ where: { userId: { in: userIds }, isOnline: true }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
  delete process.env['CAR_DELIVERIES'];
});

afterAll(async () => {
  if (priorSwitch === undefined) delete process.env['CAR_DELIVERIES']; else process.env['CAR_DELIVERIES'] = priorSwitch;
  await sys(async () => {
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.subjectLink.deleteMany({ where: { accountId: { in: userIds } } });
    await app.prisma.vehicleProfile.deleteMany({ where: { registeredById: { in: userIds } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: userIds } } });
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: userIds } } }, { driver: { userId: { in: userIds } } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId } });
    await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
}, 120_000);


// ---------------------------------------------------------------------------
// PR4 — "taxi + deliveries": while the taxi is online and free, the car's delivery profile is ALSO a delivery
// candidate, located where the taxi is. Accepting a delivery promotes it inside the claim (taxi supply retired,
// the delivery profile online on the same device session, work app -> deliveries). When its deliveries end, the
// next delivery heartbeat returns the account to taxi work with deliveries on — through the taxi GO's own gates.
// One job at a time throughout. Switch OFF: none of it, and taxi work exactly as before.
// ---------------------------------------------------------------------------

const mode = (token: string, takesDeliveries: boolean) => call('PUT', '/api/v1/driver/deliveries/mode', token, { takesDeliveries });
const heartbeat = (token: string, at = here) => call('PUT', '/api/v1/rider/location', token, at);

/** A verified taxi driver with Deliveries too, online as a taxi (real GO), optionally on "taxi + deliveries". */
async function taxiWithDeliveries(opts: { both?: boolean } = {}) {
  const driver = await makeTaxiDriver();
  const riderId = await seedCarProfile(driver);
  const go = await call('POST', '/api/v1/driver/go-online', driver.token, here);
  expect(go.statusCode, go.body).toBe(200);
  if (opts.both !== false) await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { takesDeliveries: true } }));
  return { ...driver, riderId };
}

describe('[CARS-DELIVER PR4] switch OFF: no "taxi + deliveries", and taxi work exactly as before', () => {
  it('turning it on is refused in plain words with nothing written; turning it off is allowed', async () => {
    const driver = await makeTaxiDriver();
    await seedCarProfile(driver);
    const on = await mode(driver.token, true);
    expect(on.statusCode, on.body).toBe(403);
    expect(on.json().error.code).toBe('VEHICLE_PASSENGERS_ONLY');
    expect((await driverOf(driver.userId)).takesDeliveries).toBe(false);
    const off = await mode(driver.token, false);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data).toMatchObject({ takesDeliveries: false, reason: 'SWITCH_OFF' });
  });

  it('even with the column set, an online taxi is never a delivery candidate and cannot claim one; its taxi pool place is unchanged', async () => {
    const driver = await taxiWithDeliveries();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBeUndefined();
    await expect(dispatch.claimOrder(order.id, driver.riderId, 'RIDER')).rejects.toMatchObject({ code: 'MOVER_INACTIVE' });
    expect(await driverOf(driver.userId)).toMatchObject({ isOnline: true, isAvailable: true });
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: false, returnsToTaxi: false });
    expect(await taxiPool()).toEqual([driver.driverId]);
  });
});

describe('[CARS-DELIVER PR4] switch ON: taxi + deliveries', () => {
  it('the mode: on needs Deliveries too set up; on and off are each one write and change no supply', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const bare = await makeTaxiDriver();
    const refused = await mode(bare.token, true);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('DELIVERIES_NOT_SET_UP');
    expect((await driverOf(bare.userId)).takesDeliveries).toBe(false);

    const driver = await taxiWithDeliveries({ both: false });
    const on = await mode(driver.token, true);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data).toMatchObject({ enabled: true, takesDeliveries: true });
    expect(await driverOf(driver.userId)).toMatchObject({ takesDeliveries: true, isOnline: true, isAvailable: true });
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: false });
    expect((await mode(driver.token, false)).json().data).toMatchObject({ takesDeliveries: false });
    expect((await driverOf(driver.userId)).takesDeliveries).toBe(false);
  });

  it('an online, free taxi on taxi + deliveries is offered a store order on its delivery profile; not when off, on a ride, or gone quiet', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await taxiWithDeliveries();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(driver.riderId);

    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { takesDeliveries: false } }));
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId)).not.toContain(driver.riderId);
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { takesDeliveries: true, isAvailable: false, currentRideId: `ride-${nanoid(6)}` } }));
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId)).not.toContain(driver.riderId);
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { isAvailable: true, currentRideId: null, lastLocationUpdate: new Date(Date.now() - 10 * 60_000) } }));
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId)).not.toContain(driver.riderId);
    // ...nor while its delivery profile still points at a delivery (one job at a time).
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { lastLocationUpdate: new Date() } }));
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId)).toContain(driver.riderId);
    await sys(() => app.prisma.rider.update({ where: { id: driver.riderId }, data: { currentOrderId: order.id } }));
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId)).not.toContain(driver.riderId);
    await sys(() => app.prisma.rider.update({ where: { id: driver.riderId }, data: { currentOrderId: null } }));
  });

  it('accepting promotes the delivery profile inside the claim: riderId (never driverId), taxi supply retired, same device session, work app deliveries', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await taxiWithDeliveries();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(driver.riderId);
    const claimed = await dispatch.acceptOffer(order.id, driver.userId);
    expect({ status: claimed.status, riderId: claimed.riderId, driverId: claimed.driverId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: driver.riderId, driverId: null });
    expect(await driverOf(driver.userId)).toMatchObject({ isOnline: false, isAvailable: false, locationSessionId: null, takesDeliveries: true });
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: true, locationSessionId: driver.sessionId, currentOrderId: order.id, returnsToTaxi: true });
    expect(await userOf(driver.userId)).toMatchObject({ activeRole: 'RIDER', lastMoverRole: 'RIDER' });
  });

  it('a delivery claim after the taxi took a ride is refused, and nothing moves', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await taxiWithDeliveries();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { isAvailable: false, currentRideId: `ride-${nanoid(6)}` } }));
    await expect(dispatch.claimOrder(order.id, driver.riderId, 'RIDER')).rejects.toMatchObject({ code: 'MOVER_INACTIVE' });
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))).riderId).toBeNull();
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: false, returnsToTaxi: false });
    expect(await userOf(driver.userId)).toMatchObject({ activeRole: 'DRIVER' });
  });

  it('when the delivery ends, the next delivery heartbeat returns the account to taxi + deliveries: same session, that position', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await taxiWithDeliveries();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(driver.riderId);
    await dispatch.acceptOffer(order.id, driver.userId);

    // While the delivery is live, heartbeats are ordinary.
    const during = await heartbeat(driver.token);
    expect(during.statusCode, during.body).toBe(200);
    expect(during.json().data).toMatchObject({ accepted: true });

    const handback = await call('POST', `/api/v1/rider/orders/${order.id}/handback`, driver.token, { reason: 'Car trouble before pickup' });
    expect(handback.statusCode, handback.body).toBe(200);
    const moved = { latitude: SPOT.lat + 0.002, longitude: SPOT.lng + 0.001 };
    const back = await heartbeat(driver.token, moved);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().data).toEqual({ accepted: false, reason: 'RETURNED_TO_TAXI' });
    const taxi = await driverOf(driver.userId);
    expect(taxi).toMatchObject({ isOnline: true, isAvailable: true, locationSessionId: driver.sessionId, takesDeliveries: true });
    expect(taxi.currentLat).toBeCloseTo(moved.latitude, 5);
    expect(taxi.currentLng).toBeCloseTo(moved.longitude, 5);
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: false, locationSessionId: null, returnsToTaxi: false });
    expect(await userOf(driver.userId)).toMatchObject({ activeRole: 'DRIVER', lastMoverRole: 'DRIVER' });
    expect(await taxiPool()).toContain(driver.driverId);
  });

  it('the return passes the taxi gates: with the hire insurance lapsed, delivery supply ends and the taxi stays offline (taxi GO will say why)', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await taxiWithDeliveries();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(driver.riderId);
    await dispatch.acceptOffer(order.id, driver.userId);
    expect((await call('POST', `/api/v1/rider/orders/${order.id}/handback`, driver.token, { reason: 'Car trouble before pickup' })).statusCode).toBe(200);
    await sys(() => app.prisma.verificationDocument.updateMany({ where: { userId: driver.userId, docType: 'vehicle_insurance' }, data: { coverageClass: 'PRIVATE' } }));
    const back = await heartbeat(driver.token);
    expect(back.json().data).toEqual({ accepted: false, reason: 'RETURNED_TO_TAXI' });
    expect(await driverOf(driver.userId)).toMatchObject({ isOnline: false });
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: false, returnsToTaxi: false });
    expect(await userOf(driver.userId)).toMatchObject({ activeRole: 'DRIVER' });
  });

  it('deliveries the mover chose themselves (delivery GO) never send them back to taxi work', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver();
    const riderId = await seedCarProfile(driver);
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { takesDeliveries: true } }));
    await sys(() => app.prisma.rider.update({ where: { id: riderId }, data: { returnsToTaxi: true } }));
    await sys(() => app.prisma.user.update({ where: { id: driver.userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
    const go = await call('POST', '/api/v1/rider/go-online', driver.token, here);
    expect(go.statusCode, go.body).toBe(200);
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: true, returnsToTaxi: false });
    const beat = await heartbeat(driver.token);
    expect(beat.json().data).toMatchObject({ accepted: true });
    expect(await driverOf(driver.userId)).toMatchObject({ isOnline: false });
  });
});
