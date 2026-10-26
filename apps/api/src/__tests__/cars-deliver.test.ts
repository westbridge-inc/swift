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
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';
import { grantStepUp } from './helpers/step-up';
import { walkOrderStatus } from './helpers/order-status-walk';

// ---------------------------------------------------------------------------
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

const SPOT = { lat: 4.656, lng: -59.827 }; // Kato
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = 'cars-deliver-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const NUM = String(Date.now()).slice(-4);

let app: FastifyInstance;
let dispatch: DispatchService;
let vendorId = '';
let itemId = '';
let seq = 0;
const phoneBase = 592_350_000_000 + Math.floor(Math.random() * 800_000_000);
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
      orderNumber: `CARS-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
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
        ownerId: vo.id, name: 'Kato Store', slug: `kato-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5927728899',
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

describe('[CARS-DELIVER] switch OFF (the default): nothing changes for a taxi driver', () => {
  it('"Deliveries too" is not offered, and its door is refused in plain words with nothing written', async () => {
    const driver = await makeTaxiDriver();
    const status = await call('GET', '/api/v1/driver/deliveries', driver.token);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data).toMatchObject({ available: false, enabled: false, reason: 'SWITCH_OFF', vehicle: { type: 'CAR', label: 'Car' } });

    const before = await userOf(driver.userId);
    const enable = await call('POST', '/api/v1/driver/deliveries', driver.token);
    expect(enable.statusCode, enable.body).toBe(403);
    expect(enable.json().error.code).toBe('VEHICLE_PASSENGERS_ONLY');
    expect(enable.json().error.message).toContain('passengers only');
    expect(await riderOf(driver.userId)).toBeNull();
    expect(await userOf(driver.userId)).toEqual(before);
    expect(await sys(() => app.prisma.auditLog.count({ where: { userId: driver.userId, action: 'MOVER_CAR_DELIVERIES_ADDED' } }))).toBe(0);
  });

  it('a taxi car’s delivery profile cannot go online; the taxi profile goes online and sits in the taxi pool exactly as before', async () => {
    const plain = await makeTaxiDriver();
    const withProfile = await makeTaxiDriver();
    const riderId = await seedCarProfile(withProfile);
    await sys(() => app.prisma.user.update({ where: { id: withProfile.userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));

    const go = await call('POST', '/api/v1/rider/go-online', withProfile.token, here);
    expect(go.statusCode, go.body).toBe(403);
    expect(go.json().error.code).toBe('VEHICLE_PASSENGERS_ONLY');
    expect((await riderOf(withProfile.userId))).toMatchObject({ id: riderId, isOnline: false, locationSessionId: null });

    // Taxi work: the same GO, the same answer, for the driver with and without a delivery profile.
    await sys(() => app.prisma.user.update({ where: { id: withProfile.userId }, data: { activeRole: 'DRIVER', lastMoverRole: 'DRIVER' } }));
    for (const d of [plain, withProfile]) {
      const taxiGo = await call('POST', '/api/v1/driver/go-online', d.token, here);
      expect(taxiGo.statusCode, taxiGo.body).toBe(200);
      expect(taxiGo.json().data).toMatchObject({ isOnline: true, isAvailable: true });
    }
    expect(await taxiPool()).toEqual([plain.driverId, withProfile.driverId].sort());
    // ...and no delivery search ever reaches the taxi car while the switch is off.
    const found = await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null);
    expect(found.map((c) => c.riderId)).not.toContain(riderId);
  });
});

describe('[CARS-DELIVER] switch ON (CAR_DELIVERIES=1): a verified taxi car also delivers', () => {
  it('sets up a delivery profile mirroring the car — store orders only, offline, the work app unchanged — and is idempotent', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver({ vehicleType: 'WAGON_CAR' });
    const taxiBefore = await driverOf(driver.userId);
    expect((await call('GET', '/api/v1/driver/deliveries', driver.token)).json().data)
      .toMatchObject({ available: true, enabled: false, reason: null, vehicle: { type: 'WAGON_CAR', label: 'Wagon Car' } });

    const enable = await call('POST', '/api/v1/driver/deliveries', driver.token);
    expect(enable.statusCode, enable.body).toBe(200);
    expect(enable.json().data).toMatchObject({ available: true, enabled: true, reason: null });
    const rider = await riderOf(driver.userId);
    expect(rider).toMatchObject({
      riderType: 'DELIVERY', vehicleType: 'WAGON_CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019,
      vehicleColor: 'Silver', licensePlate: driver.plate, vehiclePhotoUrl: taxiBefore.vehiclePhotoUrl,
      profilePhotoUrl: taxiBefore.profilePhotoUrl, documentsVerified: true, isOnline: false, currentOrderId: null,
    });
    expect(Number(rider!.floatLimit)).toBe(20_000); // L2's float, as onboarding seeds it
    expect(await userOf(driver.userId)).toEqual({ roles: ['CUSTOMER', 'MOVER', 'DRIVER', 'RIDER'], activeRole: 'DRIVER', lastMoverRole: 'DRIVER' });
    expect(await driverOf(driver.userId)).toEqual(taxiBefore); // the taxi profile is untouched
    expect(await sys(() => app.prisma.auditLog.count({ where: { userId: driver.userId, action: 'MOVER_CAR_DELIVERIES_ADDED', entityId: rider!.id } }))).toBe(1);

    const again = await call('POST', '/api/v1/driver/deliveries', driver.token);
    expect(again.statusCode, again.body).toBe(200);
    expect(await sys(() => app.prisma.rider.count({ where: { userId: driver.userId } }))).toBe(1);
    expect(await sys(() => app.prisma.auditLog.count({ where: { userId: driver.userId, action: 'MOVER_CAR_DELIVERIES_ADDED' } }))).toBe(1);
  });

  it('is refused until the taxi papers are current, and for an account that already delivers with a motorbike — nothing written', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const unverified = await makeTaxiDriver({ verified: false });
    const refused = await call('POST', '/api/v1/driver/deliveries', unverified.token);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect(await riderOf(unverified.userId)).toBeNull();
    expect((await userOf(unverified.userId)).roles).not.toContain('RIDER');

    const dual = await makeTaxiDriver();
    await sys(() => app.prisma.rider.create({ data: { userId: dual.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } }));
    expect((await call('GET', '/api/v1/driver/deliveries', dual.token)).json().data).toMatchObject({ available: false, enabled: false, reason: 'OTHER_DELIVERY_VEHICLE' });
    const other = await call('POST', '/api/v1/driver/deliveries', dual.token);
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().error.code).toBe('DELIVERY_PROFILE_OTHER_VEHICLE');
    expect(other.json().error.message).toContain('motorbike');
    expect((await riderOf(dual.userId))!.vehicleType).toBe('MOTORCYCLE');
  });

  it('end to end: switch to deliveries, go online, get a store order, claim it on the delivery profile (never driverId); back to taxi retires delivery supply', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await call('POST', '/api/v1/driver/deliveries', driver.token)).statusCode).toBe(200);
    const riderId = (await riderOf(driver.userId))!.id;

    const toDeliveries = await call('POST', '/api/v1/customer/switch-role', driver.token, { role: 'RIDER' });
    expect(toDeliveries.statusCode, toDeliveries.body).toBe(200);
    const go = await call('POST', '/api/v1/rider/go-online', driver.token, here);
    expect(go.statusCode, go.body).toBe(200);
    expect(go.json().data).toMatchObject({ isOnline: true, isAvailable: true });
    expect(await driverOf(driver.userId)).toMatchObject({ isOnline: false, isAvailable: false });

    const order = await makeReadyOrder(customer.userId);
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(riderId);
    const claimed = await dispatch.acceptOffer(order.id, driver.userId);
    expect({ status: claimed.status, riderId: claimed.riderId, driverId: claimed.driverId }).toEqual({ status: 'RIDER_ASSIGNED', riderId, driverId: null });
    expect((await riderOf(driver.userId))!.currentOrderId).toBe(order.id);

    // With a delivery in hand there is no switching to taxi work; once it is handed back, taxi GO retires delivery supply.
    const blocked = await call('POST', '/api/v1/customer/switch-role', driver.token, { role: 'DRIVER' });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const handback = await call('POST', `/api/v1/rider/orders/${order.id}/handback`, driver.token, { reason: 'Car trouble before pickup' });
    expect(handback.statusCode, handback.body).toBe(200);
    expect((await riderOf(driver.userId))!.currentOrderId).toBeNull();
    expect((await call('POST', '/api/v1/customer/switch-role', driver.token, { role: 'DRIVER' })).statusCode).toBe(200);
    const taxiGo = await call('POST', '/api/v1/driver/go-online', driver.token, here);
    expect(taxiGo.statusCode, taxiGo.body).toBe(200);
    expect(await riderOf(driver.userId)).toMatchObject({ isOnline: false, isAvailable: false, locationSessionId: null });
  });

  it('delivery GO re-syncs the car from the taxi profile (a plate or colour changed there is never left behind)', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver();
    expect((await call('POST', '/api/v1/driver/deliveries', driver.token)).statusCode).toBe(200);
    const newPlate = `HK ${NUM}9${String(seq).padStart(2, '0')}`;
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { licensePlate: newPlate, vehicleColor: 'Blue', vehiclePhotoUrl: 'vehicles/synthetic/new.jpg' } }));
    await sys(() => app.prisma.user.update({ where: { id: driver.userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));

    const go = await call('POST', '/api/v1/rider/go-online', driver.token, here);
    expect(go.statusCode, go.body).toBe(200);
    expect(await riderOf(driver.userId)).toMatchObject({ licensePlate: newPlate, vehicleColor: 'Blue', vehiclePhotoUrl: 'vehicles/synthetic/new.jpg', isOnline: true });
  });

  it('a claim needs the taxi document verdict on the same car: with the hire insurance gone it is refused under lock, nothing bound', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const riderId = await seedCarProfile(driver);
    await sys(() => app.prisma.user.update({ where: { id: driver.userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
    await sys(() => app.prisma.rider.update({ where: { id: riderId }, data: {
      isOnline: true, isAvailable: true, locationSessionId: driver.sessionId, currentLat: SPOT.lat, currentLng: SPOT.lng, lastLocationUpdate: new Date(),
    } }));
    await sys(() => app.prisma.verificationDocument.updateMany({ where: { userId: driver.userId, docType: 'vehicle_insurance' }, data: { coverageClass: 'PRIVATE' } }));
    const order = await makeReadyOrder(customer.userId);
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { riderId } }));
    await expect(sys(() => app.prisma.$transaction((tx) => reserveRiderLeg(tx, riderId, order.id, 1))))
      .rejects.toMatchObject({ code: 'INSURANCE_HIRE_CLASS_REQUIRED' });
    expect((await riderOf(driver.userId))!.currentOrderId).toBeNull();
  });

  it('a claim needs the taxi profile to name the same car: an online delivery profile left on an old plate is refused under lock', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const riderId = await seedCarProfile(driver);
    await sys(() => app.prisma.user.update({ where: { id: driver.userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
    await sys(() => app.prisma.rider.update({ where: { id: riderId }, data: {
      isOnline: true, isAvailable: true, locationSessionId: driver.sessionId, currentLat: SPOT.lat, currentLng: SPOT.lng, lastLocationUpdate: new Date(),
    } }));
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { licensePlate: `HK ${NUM}7${String(seq).padStart(2, '0')}` } }));
    const order = await makeReadyOrder(customer.userId);
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { riderId } }));
    await expect(sys(() => app.prisma.$transaction((tx) => reserveRiderLeg(tx, riderId, order.id, 1))))
      .rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    expect((await riderOf(driver.userId))!.currentOrderId).toBeNull();
  });

  it('a vehicle change carries the delivery profile to the new car, offline, and the old car’s papers retire with it', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver({ verified: false });
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null } }));
    const riderId = await seedCarProfile(driver);
    // The old car's insurance, bound to the car its plate names (as submission binds it).
    const subject = await sys(() => app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: driver.userId } }));
    await sys(() => app.prisma.vehicleProfile.create({ data: { subjectId: subject.id, registrationMark: driver.plate.replace(/\s+/g, ''), countryCode: 'GY', vehicleKind: 'CAR', registeredById: driver.userId } }));
    await sys(() => app.prisma.subjectLink.create({ data: { accountId: driver.userId, subjectId: subject.id, relation: 'ASSIGNED_DRIVER', approvedAt: new Date() } }));
    const insurance = await sys(() => app.prisma.verificationDocument.create({ data: {
      userId: driver.userId, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: `/uploads/verification/cars/${nanoid(4)}.enc`, status: 'APPROVED',
      reviewedBy: 'cars-deliver-test', reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY), subjectId: subject.id,
    } }));

    const newPlate = `HK ${NUM}8${String(seq).padStart(2, '0')}`;
    await grantStepUp(app, driver.token);
    const changed = await call('PUT', '/api/v1/partner/vehicle', driver.token, { vehicleType: 'CAR', vehicle: { make: 'Honda', model: 'Fit', year: 2017, color: 'Red', licensePlate: newPlate } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().data).toMatchObject({ kind: 'DRIVER', vehicleType: 'CAR', retiredDocuments: 1 });
    expect(await riderOf(driver.userId)).toMatchObject({
      id: riderId, riderType: 'DELIVERY', vehicleType: 'CAR', vehicleMake: 'Honda', vehicleModel: 'Fit', vehicleYear: 2017, vehicleColor: 'Red',
      licensePlate: newPlate, isOnline: false, documentsVerified: false,
    });
    expect((await sys(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: insurance.id } }))).state).toBe('SUPERSEDED');
  });

  it('from delivery mode, naming the same taxi car again is no change at all: nothing moves, the work app stays deliveries', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver({ verified: false });
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null } }));
    const riderId = await seedCarProfile(driver);
    await sys(() => app.prisma.user.update({ where: { id: driver.userId }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
    await grantStepUp(app, driver.token);
    const same = await call('PUT', '/api/v1/partner/vehicle', driver.token, { vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2019, color: 'Silver', licensePlate: driver.plate } });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().data).toMatchObject({ changed: false, retiredDocuments: 0, activeRole: null, lastMoverRole: null });
    expect(await userOf(driver.userId)).toMatchObject({ activeRole: 'RIDER', lastMoverRole: 'RIDER' });
    expect(await riderOf(driver.userId)).toMatchObject({ id: riderId, licensePlate: driver.plate, vehicleType: 'CAR' });
  });

  it('a taxi driver with Deliveries too who switches to a motorbike: the delivery profile becomes an ordinary rider (store orders and parcels)', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver({ verified: false, plan: false });
    await sys(() => app.prisma.driver.update({ where: { userId: driver.userId }, data: { documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null } }));
    const riderId = await seedCarProfile(driver);
    await grantStepUp(app, driver.token);
    const bike = await call('PUT', '/api/v1/partner/vehicle', driver.token, { vehicleType: 'MOTORCYCLE', vehicle: { make: 'Honda', model: 'CG125', year: 2020, color: 'Black', licensePlate: `CK ${NUM}${String(seq).padStart(2, '0')}` } });
    expect(bike.statusCode, bike.body).toBe(200);
    expect(bike.json().data).toMatchObject({ kind: 'RIDER', vehicleType: 'MOTORCYCLE' });
    expect(await riderOf(driver.userId)).toMatchObject({ id: riderId, vehicleType: 'MOTORCYCLE', riderType: 'BOTH', isOnline: false });
  });

  it('[CHAINS 02:00Z · #2117] the car’s cash deliveries count in the delivery profile’s CASH COLLECTED after paying the store, never in the taxi figure', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const driver = await makeTaxiDriver();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const riderId = await seedCarProfile(driver);
    // A handed-over cash store delivery on the delivery profile: 2,500 collected at the door, 2,000 paid to the store.
    const order = await makeReadyOrder(customer.userId);
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { riderId, acceptedAt: new Date(), paymentStatus: 'CAPTURED' } }));
    await sys(() => walkOrderStatus(app.prisma, order.id, 'DELIVERED', { deliveredAt: new Date() }));
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))).driverId).toBeNull();

    const deliveries = await call('GET', '/api/v1/rider/earnings/summary', driver.token);
    expect(deliveries.statusCode, deliveries.body).toBe(200);
    expect(deliveries.json().data.cashInHand).toMatchObject({ today: 500, allTime: 500 });
    const taxi = await call('GET', '/api/v1/driver/earnings/summary', driver.token);
    expect(taxi.statusCode, taxi.body).toBe(200);
    expect(taxi.json().data.cashInHand).toMatchObject({ today: 0, allTime: 0 });
  });
});
