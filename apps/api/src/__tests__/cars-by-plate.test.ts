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
import { partnerRoutes } from '../modules/partner/partner.routes';
import { makeDispatchService, type DispatchService } from '../modules/dispatch/dispatch.service';
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { CountryConfigService, partnerRateFor, type SubscriptionTiers } from '../modules/country/country-config.service';
import { privateCarPrices } from '../modules/country/partner-pricing';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { moverRoleForVehicle } from '../modules/verification/hire-plate';
import { carriesParcels, parcelSizeCarriableToday } from '../config/vehicle-classes';
import { docProfilesFor } from '../config/vehicle-classes';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { grantStepUp } from './helpers/step-up';

// ---------------------------------------------------------------------------
// [CARS-PLATES · owner 6 Nov 2026 ~04:20Z + 04:30Z] Cars by plate. A private (P) plate car does DELIVERIES ONLY and
// pays the delivery rider's weekly fee; an H-plate (hire) car drives taxi rides and may deliver too. The plate class is
// the plate's first letter, counted only through the Certificate of Registration a person approves for that plate.
// CAR_DELIVERIES stays the kill switch (on only when exactly '1'): with it off, everything is as before.
// Proven here through the real routes and services:
//   - sign-up decides a car's work by its plate (P -> a delivery profile with the car's details; H -> taxi);
//   - the fee a P car is quoted and ticks for is the delivery rider's, never the taxi fee;
//   - a P car's papers are the delivery rider's (no hire licences) and are approvable without an H plate, while a
//     taxi profile on a P plate is still refused (WRONG_PLATE_CLASS), and nothing changes with the switch off;
//   - a P car goes online and is offered and claims store work as a rider, and is never in the taxi pool;
//   - the taxi pool and the taxi claim refuse any car without an H plate, whatever its row says.
// Fixtures: far south (1.88, -58.95), so only this file's movers are ever candidates.
// ---------------------------------------------------------------------------

const SPOT = { lat: 1.88, lng: -58.95 };
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = 'cars-by-plate-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const NUM = String(Date.now()).slice(-4);

let app: FastifyInstance;
let dispatch: DispatchService;
let verification: VerificationService;
let reviewerId = '';
let vendorId = '';
let itemId = '';
let seq = 0;
const phoneBase = 592_351_000_000 + Math.floor(Math.random() * 800_000_000);
const userIds: string[] = [];
const orderIds: string[] = [];

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Plate', lastName: `P${seq}`, roles, activeRole, countryCode: 'GY',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      ...(roles.includes('ADMIN') ? { admin: { create: { permissions: ['*'] } } } : {}),
      ...extra,
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `plates-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

const plate = (letter: 'P' | 'H') => `${letter}${letter === 'P' ? 'W' : 'C'} ${NUM}${String(++seq).padStart(3, '0')}`;
const car = (licensePlate: string) => ({ make: 'Toyota', model: 'Premio', year: 2017, color: 'White', licensePlate });

const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const here = { latitude: SPOT.lat + 0.001, longitude: SPOT.lng };
const riderOf = (userId: string) => sys(() => app.prisma.rider.findUnique({ where: { userId } }));
const driverOf = (userId: string) => sys(() => app.prisma.driver.findUnique({ where: { userId } }));
const tiers = async () => (await sys(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } }))).subscriptionTiers as unknown as SubscriptionTiers;

/** A private (P) plate delivery car, as sign-up leaves it, with the legacy grant and a running delivery plan. */
async function privateCar(opts: { vehicleType?: VehicleType; riderType?: 'DELIVERY' | 'BOTH' | 'COURIER' } = {}) {
  const u = await makeUser(['CUSTOMER', 'MOVER', 'RIDER'], 'RIDER', { lastMoverRole: 'RIDER' });
  const p = plate('P');
  const rider = await sys(() => app.prisma.rider.create({ data: {
    userId: u.userId, riderType: opts.riderType ?? 'DELIVERY', vehicleType: opts.vehicleType ?? 'CAR', ...{ vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2017, vehicleColor: 'White' },
    licensePlate: p, profilePhotoUrl: `avatars/synthetic/${nanoid(6)}.jpg`, vehiclePhotoUrl: `vehicles/synthetic/${nanoid(6)}.jpg`,
    documentsVerified: true, documentsVerifiedAt: new Date(Date.now() - DAY), documentsVerifiedBy: 'cars-by-plate-test',
    floatLimit: 20_000, isOnline: false, isAvailable: false,
  } }));
  await sys(() => app.prisma.subscription.create({ data: {
    riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 2000,
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
  } }));
  return { ...u, riderId: rider.id, plate: p };
}

/** A taxi Driver row online at SPOT with the given plate (legacy data can hold anything; the pool must not trust it). */
async function onlineTaxi(licensePlate: string) {
  const u = await makeUser(['CUSTOMER', 'MOVER', 'DRIVER'], 'DRIVER', { lastMoverRole: 'DRIVER' });
  const driver = await sys(() => app.prisma.driver.create({ data: {
    userId: u.userId, vehicleType: 'CAR', rideClass: 'ECONOMY', vehicleCapacity: 4,
    vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver', licensePlate,
    driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg',
    documentsVerified: true, documentsVerifiedAt: new Date(Date.now() - DAY), documentsVerifiedBy: 'cars-by-plate-test',
    isOnline: true, isAvailable: true, locationSessionId: u.sessionId, currentLat: SPOT.lat, currentLng: SPOT.lng, lastLocationUpdate: new Date(),
  } }));
  return { ...u, driverId: driver.id };
}

async function makeReadyOrder(customerId: string) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `PLT-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
      pickupAddress: 'South Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'South homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      paymentMethod: 'CASH',
      items: { create: [{
        itemId, name: 'Farine', quantity: 1,
        basePrice: 2000, markedUpPrice: 2000, markupAmount: 0, totalBase: 2000, totalMarkup: 0, totalCustomer: 2000,
      }] },
    },
  }));
  orderIds.push(order.id);
  return order;
}

async function makeRide(customerId: string) {
  const ride = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `PLT-T-${nanoid(10)}`, orderType: 'TAXI', customerId, status: 'PENDING',
      pickupAddress: 'South crossing', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'South landing', deliveryLat: SPOT.lat + 0.01, deliveryLng: SPOT.lng + 0.01,
      taxiPickupAddress: 'South crossing', taxiDropoffAddress: 'South landing',
      taxiPassengerCount: 1, rideClass: 'ECONOMY', taxiFareTotal: 1500,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500,
      paymentMethod: 'CASH', ridePin: '482915',
    },
  }));
  orderIds.push(ride.id);
  return ride;
}

/** A pending vehicle paper about `mark`, bound to its vehicle subject (as submission binds it). */
async function pendingVehiclePaper(userId: string, mark: string, docType: 'vehicle_registration' | 'vehicle_insurance' | 'vehicle_exterior_photo' = 'vehicle_registration') {
  return sys(async () => {
    const subject = await app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: userId } });
    await app.prisma.vehicleProfile.create({ data: { subjectId: subject.id, countryCode: 'GY', registrationMark: mark.replace(/\s+/g, ''), vehicleKind: 'CAR', registeredById: userId } });
    await app.prisma.subjectLink.create({ data: { accountId: userId, subjectId: subject.id, relation: 'ASSIGNED_DRIVER', approvedAt: new Date() } });
    return app.prisma.verificationDocument.create({ data: {
      userId, subjectId: subject.id, role: 'MOVER', docType, status: 'PENDING',
      expiresAt: new Date(Date.now() + 100 * DAY), fileUrl: `/uploads/verification/synthetic-${nanoid()}.enc`,
    } });
  });
}

const become = (token: string, vehicleType: VehicleType, licensePlate: string, weeklyFeeAck?: Record<string, unknown>) =>
  call('POST', '/api/v1/partner/become', token, { role: 'MOVER', acceptAgreement: true, vehicleType, vehicle: car(licensePlate), ...(weeklyFeeAck ? { weeklyFeeAck } : {}) });

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
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
  dispatch = makeDispatchService(app);
  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  reviewerId = (await makeUser(['ADMIN'], 'ADMIN')).userId;

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'South Store', slug: `south-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5927728890',
        addressLine1: '1 South Road', city: 'Aishalton', region: 'Upper Takutu', latitude: SPOT.lat, longitude: SPOT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Farine', basePrice: 2000, isAvailable: true } });
    return { vendorId: vendor.id, itemId: item.id };
  });
  vendorId = ids.vendorId;
  itemId = ids.itemId;
}, 120_000);

afterEach(async () => {
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
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
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

describe('[CARS-PLATES] the plate decides a car’s work (pure rules)', () => {
  it('a non-H car delivers only while car deliveries are on; an H car is a taxi; other vehicles keep their role', () => {
    const on = { CAR_DELIVERIES: '1' };
    expect(moverRoleForVehicle('CAR', 'PW 1234', on)).toBe('RIDER');
    expect(moverRoleForVehicle('WAGON_CAR', ' p-a 77 ', on)).toBe('RIDER');
    expect(moverRoleForVehicle('CAR', 'hc 1234', on)).toBe('DRIVER');
    expect(moverRoleForVehicle('CAR', ' H-C 1', on)).toBe('DRIVER');
    expect(moverRoleForVehicle('CAR', '', on)).toBe('RIDER');
    // The kill switch: off (unset, or anything but exactly '1') = a car is a taxi, as before.
    expect(moverRoleForVehicle('CAR', 'PW 1234', {})).toBe('DRIVER');
    expect(moverRoleForVehicle('CAR', 'PW 1234', { CAR_DELIVERIES: 'true' })).toBe('DRIVER');
    expect(moverRoleForVehicle('MOTORCYCLE', 'HC 1', on)).toBe('RIDER');
    expect(moverRoleForVehicle('MOTORCYCLE', 'PW 1', {})).toBe('RIDER');
  });

  it('a car’s delivery profile reads the delivery rider’s papers (no hire licences); the taxi profile the taxi’s', () => {
    expect(docProfilesFor('CAR', 'RIDER')).toEqual(['MOVER_MOTOR']);
    expect(docProfilesFor('WAGON_CAR', 'RIDER')).toEqual(['MOVER_MOTOR']);
    expect(docProfilesFor('CAR', 'DRIVER')).toEqual(['MOVER_MOTOR', 'MOVER_TAXI_EXTRA']);
    expect(docProfilesFor('CAR')).toEqual(['MOVER_MOTOR', 'MOVER_TAXI_EXTRA']);
    expect(docProfilesFor('MOTORCYCLE', 'RIDER')).toEqual(['MOVER_MOTOR']);
  });
});

describe('[CARS-PLATES] sign-up: the plate decides, the fee follows the work', () => {
  it('switch ON: a P-plate car becomes a delivery profile carrying its car, and never a taxi', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const p = plate('P');
    const res = await become(u.token, 'CAR', p);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ kind: 'RIDER', activeRole: 'RIDER', lastMoverRole: 'RIDER' });
    // [owner 6 Nov ~05:20Z] food and shop orders only: never courier parcels.
    expect(await riderOf(u.userId)).toMatchObject({ vehicleType: 'CAR', riderType: 'DELIVERY', licensePlate: p, vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2017, vehicleColor: 'White' });
    expect(await driverOf(u.userId)).toBeNull();
  });

  it('switch ON: an H-plate car is a taxi, exactly as before', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const h = plate('H');
    const res = await become(u.token, 'CAR', h);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ kind: 'DRIVER' });
    expect(await driverOf(u.userId)).toMatchObject({ licensePlate: h, vehicleType: 'CAR' });
    expect(await riderOf(u.userId)).toBeNull();
  });

  it('switch OFF (the kill switch): a P-plate car is refused in the taxi plate words, nothing written', async () => {
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await become(u.token, 'CAR', plate('P'));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('TAXI_PLATE_NOT_HIRE');
    expect(await riderOf(u.userId)).toBeNull();
    expect(await driverOf(u.userId)).toBeNull();
  });

  it('owner 04:30Z: a P car is quoted and ticks for the delivery rider’s weekly fee; a taxi-fee tick is refused', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const t = await tiers();
    const riderRate = partnerRateFor(t, { kind: 'RIDER', vehicleType: 'MOTORCYCLE' }).rate;
    const taxiRate = partnerRateFor(t, { kind: 'DRIVER', vehicleType: 'CAR' }).rate;
    expect(riderRate).not.toBe(taxiRate); // the seeded card prices the two apart, so the case can tell them apart
    const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const quote = await sys(() => signupQuote(app.prisma, u.userId, { role: 'MOVER', vehicleType: 'CAR', moverRole: moverRoleForVehicle('CAR', 'PW 1') }));
    expect(quote.amount).toBe(riderRate);
    const wrong = await become(u.token, 'CAR', plate('P'), { version: WEEKLY_FEE_ACK_VERSION, amount: taxiRate, currencyCode: quote.currencyCode });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json().error.code).toBe('WEEKLY_FEE_CHANGED');
    expect(await riderOf(u.userId)).toBeNull();
    const right = await become(u.token, 'CAR', plate('P'), { version: WEEKLY_FEE_ACK_VERSION, amount: riderRate, currencyCode: quote.currencyCode });
    expect(right.statusCode, right.body).toBe(201);
    // The public price list says the same: a private car at the rider's fee, only while cars deliver.
    const list = privateCarPrices(t, true);
    expect(list.on).toBe(true);
    expect(list.quotes.map((q) => [q.vehicleType, q.role, q.rate])).toEqual([['CAR', 'RIDER', riderRate], ['WAGON_CAR', 'RIDER', riderRate]]);
    expect(privateCarPrices(t, false)).toEqual({ on: false, quotes: [] });
  });
});

describe('[CARS-PLATES] papers: a P car is checked as a delivery car; a taxi on a P plate is still refused', () => {
  it('the P car’s own list is the delivery rider’s plus one car photo: licence, registration, insurance, photo — no hire licences, no fitness', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const status = await sys(() => verification.getStatus(pc.userId, 'MOVER'));
    // [owner 6 Nov ~05:20Z] + ONE car photo with the plate showing, so a person can match the plate letter (no fitness).
    expect([...(status as { checklist: string[] }).checklist].sort()).toEqual(['drivers_licence', 'vehicle_exterior_photo', 'vehicle_insurance', 'vehicle_registration']);
    const taxiList = await sys(() => new CountryConfigService(app.prisma).getMoverChecklist('GY', 'CAR', app.prisma, 'DRIVER'));
    expect(taxiList).toEqual(expect.arrayContaining(['hire_car_driver_licence', 'hire_car_vehicle_licence']));
  });

  it('a person can approve a P car’s registration (no H rule for a delivery car)', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const doc = await pendingVehiclePaper(pc.userId, pc.plate);
    expect(await sys(() => verification.approveDocument(doc.id, reviewerId))).toMatchObject({ status: 'APPROVED' });
  });

  it('a P car’s insurance still needs cover for hire or reward, in the delivery words', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const doc = await pendingVehiclePaper(pc.userId, pc.plate, 'vehicle_insurance');
    await expect(sys(() => verification.approveDocument(doc.id, reviewerId, undefined, { insurerName: 'Synthetic', policyNumber: 'X1', coverageClass: 'PRIVATE', hireClassConfirmed: false, plateCrossChecked: true })))
      .rejects.toMatchObject({ code: 'INSURANCE_SCOPE_INSUFFICIENT', message: expect.stringContaining('A motor vehicle that delivers') });
  });

  it('a TAXI profile on that P plate is refused WRONG_PLATE_CLASS, and so is the P car with the switch off', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    await sys(() => app.prisma.driver.create({ data: {
      userId: pc.userId, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2017, vehicleColor: 'White', licensePlate: pc.plate,
      driverLicenseUrl: '', vehicleInsuranceUrl: '',
    } }));
    const doc = await pendingVehiclePaper(pc.userId, pc.plate);
    await expect(sys(() => verification.approveDocument(doc.id, reviewerId))).rejects.toMatchObject({ code: 'WRONG_PLATE_CLASS' });
    const off = await privateCar();
    const paper = await pendingVehiclePaper(off.userId, off.plate);
    delete process.env['CAR_DELIVERIES'];
    await expect(sys(() => verification.approveDocument(paper.id, reviewerId))).rejects.toMatchObject({ code: 'WRONG_PLATE_CLASS' });
  });
});

describe('[CARS-PLATES] dispatch: a P car delivers, never drives a ride', () => {
  it('a P car goes online as a rider, is offered and claims a store order; switch off it cannot go online', async () => {
    const pc = await privateCar();
    const refused = await call('POST', '/api/v1/rider/go-online', pc.token, here);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('VEHICLE_PASSENGERS_ONLY');

    process.env['CAR_DELIVERIES'] = '1';
    const go = await call('POST', '/api/v1/rider/go-online', pc.token, here);
    expect(go.statusCode, go.body).toBe(200);
    expect(await riderOf(pc.userId)).toMatchObject({ isOnline: true, licensePlate: pc.plate, vehicleType: 'CAR' });
    const pool = (await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId);
    expect(pool).toContain(pc.riderId);
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'DRIVER', 0, 'ECONOMY', null, null, null, 1)).map((c) => c.riderId)).not.toContain(pc.riderId);
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await makeReadyOrder(customer.userId);
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { riderId: pc.riderId } }));
    expect(await sys(() => app.prisma.$transaction((tx) => reserveRiderLeg(tx, pc.riderId, order.id, 1)))).toBe(true);
    // No taxi verdict is read for it (no taxi profile on its plate): its own delivery papers are its gate.
    expect(await driverOf(pc.userId)).toBeNull();
  });

  it('the taxi pool never holds a car without an H plate, whatever its row says', async () => {
    const h = await onlineTaxi(plate('H'));
    const p = await onlineTaxi(plate('P'));
    const spaced = await onlineTaxi(` h-c ${NUM}${String(++seq).padStart(3, '0')}`);
    const pool = (await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'DRIVER', 0, 'ECONOMY', null, null, null, 1)).map((c) => c.riderId);
    expect(pool).toContain(h.driverId);
    expect(pool).toContain(spaced.driverId);
    expect(pool).not.toContain(p.driverId);
  });

  it('the taxi claim refuses a car without an H plate under its lock, in plain words, nothing bound', async () => {
    const p = await onlineTaxi(plate('P'));
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ride = await makeRide(customer.userId);
    await expect(dispatch.claimOrder(ride.id, p.driverId, 'DRIVER')).rejects.toMatchObject({
      code: 'TAXI_NEEDS_HIRE_PLATE', message: expect.stringContaining('H-plate'),
    });
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } }))).driverId).toBeNull();
  });
});

describe('[CARS-PLATES · REVIEW-G22 S2-1] an H plate is always a taxi car’s: never checked only for commercial use', () => {
  it('a delivery car cannot type an H plate of its own (server side, before any step-up); a P plate edit still works', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const h = plate('H');
    const refused = await call('PUT', '/api/v1/rider/profile', pc.token, { licensePlate: h });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'PRIVATE_CAR_H_PLATE', message: expect.stringContaining('H (hire) plate car is a taxi car') });
    expect((await riderOf(pc.userId))!.licensePlate).toBe(pc.plate);
    // A taxi on ANOTHER H plate does not make this car its twin.
    await sys(() => app.prisma.driver.create({ data: {
      userId: pc.userId, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver', licensePlate: plate('H'),
      driverLicenseUrl: '', vehicleInsuranceUrl: '',
    } }));
    expect((await call('PUT', '/api/v1/rider/profile', pc.token, { licensePlate: h })).statusCode).toBe(400);
    const p2 = plate('P');
    await sys(() => grantStepUp(app, pc.token));
    const ok = await call('PUT', '/api/v1/rider/profile', pc.token, { licensePlate: p2 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await riderOf(pc.userId))!.licensePlate).toBe(p2);
  });

  it('papers about an H plate held only by a delivery car are reviewed taxi-grade: insurance needs passengers-for-hire cover', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const h = plate('H');
    // A delivery car on an H plate (legacy data, or written past the route): its papers must not take the delivery path.
    await sys(() => app.prisma.rider.update({ where: { id: pc.riderId }, data: { licensePlate: h } }));
    const insurance = await pendingVehiclePaper(pc.userId, h, 'vehicle_insurance');
    await expect(sys(() => verification.approveDocument(insurance.id, reviewerId, undefined, { insurerName: 'Synthetic', policyNumber: 'X2', coverageClass: 'HIRE', hireClassConfirmed: false, plateCrossChecked: true })))
      .rejects.toMatchObject({ code: 'INSURANCE_SCOPE_INSUFFICIENT', message: expect.stringContaining('cover for passengers carried for hire') });
    // A P plate on the same kind of car keeps the delivery words (the private-car path).
    const pc2 = await privateCar();
    const ins2 = await pendingVehiclePaper(pc2.userId, pc2.plate, 'vehicle_insurance');
    await expect(sys(() => verification.approveDocument(ins2.id, reviewerId, undefined, { insurerName: 'Synthetic', policyNumber: 'X3', coverageClass: 'HIRE', hireClassConfirmed: false, plateCrossChecked: true })))
      .rejects.toMatchObject({ code: 'INSURANCE_SCOPE_INSUFFICIENT', message: expect.stringContaining('A motor vehicle that delivers') });
  });
});

async function makeParcel(customerId: string, courierPackageSize: 'SMALL' | 'LARGE' = 'SMALL') {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `PLT-C-${nanoid(10)}`, orderType: 'COURIER', fulfillment: 'DELIVERY', customerId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
      courierPackageSize,
      pickupAddress: 'South sender', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'South recipient', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 800, totalAmount: 800, paymentMethod: 'CASH',
    },
  }));
  orderIds.push(order.id);
  return order;
}

describe('[CARS-PLATES · owner 6 Nov ~05:20Z] a car takes food and shop orders only — never a courier parcel', () => {
  it('the rule: a car carries no parcel even while cars deliver; a parcel only a car could carry cannot be placed', () => {
    const on = { CAR_DELIVERIES: '1' };
    expect(carriesParcels('CAR', on)).toBe(false);
    expect(carriesParcels('WAGON_CAR', on)).toBe(false);
    expect(carriesParcels('MOTORCYCLE', on)).toBe(true);
    expect(parcelSizeCarriableToday('SMALL', on)).toBe(true);
    expect(parcelSizeCarriableToday('EXTRA_LARGE', on)).toBe(false);
  });

  it('a P car — even one left as BOTH by older data — is never a parcel candidate, and never claims one; a store order it does', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar({ riderType: 'BOTH' });
    expect((await call('POST', '/api/v1/rider/go-online', pc.token, here)).statusCode).toBe(200);
    const parcelPool = (await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, 'SMALL', null)).map((c) => c.riderId);
    expect(parcelPool).not.toContain(pc.riderId);
    const unsized = (await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null, null, undefined, true)).map((c) => c.riderId);
    expect(unsized).not.toContain(pc.riderId);
    expect((await dispatch.findCandidates(`probe-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null, null, null, null)).map((c) => c.riderId)).toContain(pc.riderId);
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const parcel = await makeParcel(customer.userId);
    await expect(sys(() => app.prisma.$transaction((tx) => reserveRiderLeg(tx, pc.riderId, parcel.id, 1))))
      .rejects.toMatchObject({ code: 'CAR_NO_PARCELS' });
    expect((await riderOf(pc.userId))!.currentOrderId).toBeNull();
    // The board grab says the same, before anything is bound.
    const grab = await call('POST', `/api/v1/rider/orders/${parcel.id}/accept`, pc.token, {});
    expect(grab.statusCode, grab.body).toBe(403);
    expect(grab.json().error.code).toBe('CAR_NO_PARCELS');
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: parcel.id } }))).riderId).toBeNull();
  });

  it('a car cannot sign up for parcels on its profile', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const res = await call('PUT', '/api/v1/rider/profile', pc.token, { riderType: 'BOTH' });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('CAR_NO_PARCELS');
    expect((await riderOf(pc.userId))!.riderType).toBe('DELIVERY');
  });

  it('a person can approve the P car’s photo (the plate shown) on the delivery path', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const pc = await privateCar();
    const photo = await pendingVehiclePaper(pc.userId, pc.plate, 'vehicle_exterior_photo');
    expect(await sys(() => verification.approveDocument(photo.id, reviewerId))).toMatchObject({ status: 'APPROVED' });
  });
});
