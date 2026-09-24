import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { LAUNCH_HIDDEN_VEHICLE_TYPES, VEHICLE_TYPES_IN_ORDER } from '../config/vehicle-classes';
import { grantStepUp } from './helpers/step-up';

// ---------------------------------------------------------------------------
// [VEHICLES · owner 2026-09-24] "after you save vehicle you cant switch it at
// all" and "take out extra vehicles like truck". Proven through the real routes:
//
//   the launch list: canters and box trucks are priced but not offered; /become,
//   the change route and GO all refuse them; everything else is offered;
//
//   PUT /partner/vehicle: a mover changes vehicle. Supply retires, the legacy
//   grant clears, and VEHICLE DOCUMENTS FOLLOW VEHICLES. Approved papers about
//   a vehicle the mover no longer has are SUPERSEDED (their evidence records
//   follow), papers still in review lapse with their cases closed, renewal
//   reminders stop, and papers bound to a plate the mover still carries stay.
//   Personal papers are never touched.
//
//   Refusals: a job in progress, a verified mover without step-up, a move
//   between delivery and taxi work while a weekly plan runs, a driver vehicle
//   without its details, and a rider type change through the old profile route.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const users: string[] = [];
let seq = 0;
// One file, one block: +592019nnnnnn (1M wide), never past +593.
const phoneBase = 592_019_000_000 + Math.floor(Math.random() * 900_000);
const NUM = String(Date.now()).slice(-4);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'vehicle-change-test');
const DAY = 86_400_000;

async function makeUser(): Promise<{ userId: string; token: string }> {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Vee', lastName: `Mover${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: `/uploads/avatars/vc-${seq}.jpg`,
  } }));
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'vehicle-change', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token };
}

function send(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers });
}
const become = (token: string, body: Record<string, unknown>) => send('POST', '/api/v1/partner/become', token, { role: 'MOVER', acceptAgreement: true, ...body });
const change = (token: string, body: Record<string, unknown>) => send('PUT', '/api/v1/partner/vehicle', token, body);

/** An approved paper, filed the way the review pipeline leaves it (the INSERT trigger derives COMMITTED + a VALID record). */
const approved = (userId: string, docType: string, extra: Record<string, unknown> = {}) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/vc/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'vehicle-change-test',
  reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY), ...extra,
} }));
/** A paper still waiting on a human, with its one open review case. */
async function inReview(userId: string, docType: string) {
  const doc = await system(() => app.prisma.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/vc/${docType}-${nanoid(4)}.enc`, status: 'PENDING',
  } }));
  const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
  return { doc, kase };
}
const docState = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { state: true, status: true } }));
const recordStatus = (submissionId: string) => system(() => app.prisma.documentRecord.findUnique({ where: { submissionId }, select: { status: true } })).then((r) => r?.status ?? null);

/** A rider on a heavy vehicle, as the app registered them before the launch list existed. */
async function legacyHeavyRider(vehicleType: 'CANTER_SHORT' | 'BOX_TRUCK_LONG' = 'CANTER_SHORT') {
  const u = await makeUser();
  await system(() => app.prisma.rider.create({ data: { userId: u.userId, riderType: 'BOTH', vehicleType } }));
  await system(() => app.prisma.user.update({ where: { id: u.userId }, data: { roles: ['CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
  return u;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: users } } }, { driver: { userId: { in: users } } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('the launch vehicle list: canters and box trucks are priced but not offered', () => {
  it('the price list still quotes every vehicle, and marks exactly the four heavy freight classes not offered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/pricing?countryCode=GY' });
    expect(res.statusCode, res.body).toBe(200);
    const movers = res.json().data.movers as Array<{ vehicleType: string; offered: boolean }>;
    expect(movers.map((m) => m.vehicleType)).toEqual(VEHICLE_TYPES_IN_ORDER);
    expect(movers.filter((m) => !m.offered).map((m) => m.vehicleType).sort())
      .toEqual(['BOX_TRUCK_LONG', 'BOX_TRUCK_SHORT', 'CANTER_LONG', 'CANTER_SHORT']);
    expect(movers.filter((m) => m.offered).map((m) => m.vehicleType))
      .toEqual(['BICYCLE', 'MOTORCYCLE', 'CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15']);
    expect([...LAUNCH_HIDDEN_VEHICLE_TYPES].sort()).toEqual(['BOX_TRUCK_LONG', 'BOX_TRUCK_SHORT', 'CANTER_LONG', 'CANTER_SHORT']);
  });

  it('"Save vehicle" refuses a canter and provisions nothing; a motorbike provisions a Rider', async () => {
    const u = await makeUser();
    const refused = await become(u.token, { vehicleType: 'CANTER_SHORT' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('VEHICLE_NOT_OFFERED');
    expect(await system(() => app.prisma.rider.count({ where: { userId: u.userId } }))).toBe(0);
    const ok = await become(u.token, { vehicleType: 'MOTORCYCLE' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().data.kind).toBe('RIDER');
  });

  it('a mover already on a heavy vehicle cannot go online until they change it', async () => {
    const u = await legacyHeavyRider('BOX_TRUCK_LONG');
    const go = await send('POST', '/api/v1/rider/go-online', u.token, { lat: 6.8, lng: -58.15 });
    expect(go.statusCode).toBe(403);
    expect(go.json().error.code).toBe('VEHICLE_NOT_OFFERED');
    expect((await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId } }))).isOnline).toBe(false);
  });
});

describe('PUT /partner/vehicle: the owner\'s case, a canter rider in onboarding switches to a motorbike', () => {
  it('the vehicle changes; the canter\'s papers are retired (approved → SUPERSEDED, in review → lapsed, case closed, reminders stopped); personal papers stay', async () => {
    const u = await legacyHeavyRider('CANTER_SHORT');
    // What the canter rider had filed: an approved national ID (personal), the canter's
    // insurance and registration (approved, plate-less so unbound), and its fitness
    // certificate still in review.
    const idCard = await approved(u.userId, 'national_id');
    const insurance = await approved(u.userId, 'vehicle_insurance');
    const registration = await approved(u.userId, 'vehicle_registration');
    const fitness = await inReview(u.userId, 'fitness_cert');
    expect((await docState(insurance.id)).state).toBe('COMMITTED');
    expect(await recordStatus(insurance.id)).toBe('VALID');
    expect((await docState(fitness.doc.id)).state).toBe('REVIEW_QUEUED');
    const reminders = await system(() => app.prisma.renewalSchedule.findMany({ where: { documentId: { in: [insurance.id, registration.id] } }, select: { suspendedAt: true } }));
    expect(reminders.every((r) => r.suspendedAt === null)).toBe(true);

    // Not verified yet (onboarding), so no step-up is asked for.
    const res = await change(u.token, { vehicleType: 'MOTORCYCLE' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ kind: 'RIDER', vehicleType: 'MOTORCYCLE', previousVehicleType: 'CANTER_SHORT', changed: true, retiredDocuments: 2, withdrawnDocuments: 1, lastMoverRole: 'RIDER' });

    const rider = await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId } }));
    expect(rider.vehicleType).toBe('MOTORCYCLE');
    expect(rider.licensePlate).toBeNull();
    expect(rider.isOnline).toBe(false);
    expect(rider.documentsVerified).toBe(false);

    // Durable: the canter's approved papers are superseded and their records followed;
    // the paper in review lapsed and its case closed; the personal ID is untouched.
    for (const id of [insurance.id, registration.id]) {
      expect((await docState(id)).state).toBe('SUPERSEDED');
      expect(await recordStatus(id)).toBe('SUPERSEDED');
    }
    expect(await docState(fitness.doc.id)).toEqual({ state: 'EXPIRED', status: 'EXPIRED' });
    expect((await system(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id: fitness.kase.id } }))).closedAt).not.toBeNull();
    expect((await docState(idCard.id)).state).toBe('COMMITTED');
    expect(await recordStatus(idCard.id)).toBe('VALID');
    const stopped = await system(() => app.prisma.renewalSchedule.findMany({ where: { documentId: { in: [insurance.id, registration.id] } }, select: { suspendedAt: true } }));
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.every((r) => r.suspendedAt !== null)).toBe(true);

    // The checklist the app reads no longer shows the canter's approvals.
    const status = await send('GET', '/api/v1/verification/status?role=MOVER&vehicleType=MOTORCYCLE', u.token);
    expect(status.statusCode, status.body).toBe(200);
    const docs = status.json().data.documents as Array<{ id: string }>;
    expect(docs.map((d) => d.id)).not.toContain(insurance.id);
    expect(docs.map((d) => d.id)).not.toContain(registration.id);
    expect(status.json().data.vehicleType).toBe('MOTORCYCLE');
    expect(status.json().data.missing).toEqual(expect.arrayContaining(['vehicle_insurance']));

    // On the record.
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'MOVER_VEHICLE_CHANGED', entityId: rider.id } }));
    expect(audit?.changes).toMatchObject({ from: { kind: 'RIDER', vehicleType: 'CANTER_SHORT' }, to: { kind: 'RIDER', vehicleType: 'MOTORCYCLE' } });

    // A retry naming the same vehicle moves nothing.
    const again = await change(u.token, { vehicleType: 'MOTORCYCLE' });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ changed: false, retiredDocuments: 0, withdrawnDocuments: 0 });
  });

  it('a paper under a legal hold is frozen: the change leaves it exactly as it was, and retires the rest', async () => {
    const u = await legacyHeavyRider('CANTER_SHORT');
    const held = await approved(u.userId, 'vehicle_insurance');
    const free = await approved(u.userId, 'vehicle_registration');
    const hold = await system(() => app.prisma.docLegalHold.create({ data: {
      subjectUserId: u.userId, reason: 'vehicle-change test hold', ownerId: 'vehicle-change-test', placedBy: 'vehicle-change-test', reviewBy: new Date(Date.now() + 30 * DAY),
    } }));
    await system(() => app.prisma.verificationDocument.update({ where: { id: held.id }, data: { legalHoldId: hold.id } }));
    const res = await change(u.token, { vehicleType: 'MOTORCYCLE' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ changed: true, retiredDocuments: 1 });
    expect((await docState(held.id)).state).toBe('COMMITTED');
    expect((await docState(free.id)).state).toBe('SUPERSEDED');
  });

  it('a rider naming the vehicle it already has, without details, keeps its plate — nothing moves', async () => {
    const u = await makeUser();
    expect((await become(u.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    const plate = `VC${NUM}G`;
    await grantStepUp(app, u.token);
    expect((await send('PUT', '/api/v1/rider/profile', u.token, { licensePlate: plate, vehicleMake: 'Honda' })).statusCode).toBe(200);
    const res = await change(u.token, { vehicleType: 'MOTORCYCLE' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ changed: false, retiredDocuments: 0 });
    expect(await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId }, select: { licensePlate: true, vehicleMake: true } }))).toEqual({ licensePlate: plate, vehicleMake: 'Honda' });
  });

  it('a heavy vehicle is not a valid target, and a driver vehicle needs its details — nothing changes', async () => {
    const u = await legacyHeavyRider('CANTER_SHORT');
    const heavy = await change(u.token, { vehicleType: 'BOX_TRUCK_SHORT' });
    expect(heavy.statusCode).toBe(422);
    expect(heavy.json().error.code).toBe('VEHICLE_NOT_OFFERED');
    const noDetails = await change(u.token, { vehicleType: 'CAR' });
    expect(noDetails.statusCode).toBe(400);
    expect((await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId } }))).vehicleType).toBe('CANTER_SHORT');
    expect(await system(() => app.prisma.driver.count({ where: { userId: u.userId } }))).toBe(0);
  });

  it('an account with no vehicle has nothing to change', async () => {
    const u = await makeUser();
    const res = await change(u.token, { vehicleType: 'MOTORCYCLE' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MOVER_PROFILE_NOT_FOUND');
  });

  it('the old profile route cannot change the vehicle type — it points to the change route', async () => {
    const u = await legacyHeavyRider('CANTER_SHORT');
    const res = await send('PUT', '/api/v1/rider/profile', u.token, { vehicleType: 'BICYCLE' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USE_VEHICLE_CHANGE');
    expect((await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId } }))).vehicleType).toBe('CANTER_SHORT');
  });
});

describe('PUT /partner/vehicle: moving between delivery and taxi work', () => {
  it('a delivery rider switching to a car becomes a taxi Driver: profile provisioned from the taxonomy, pointer moved, rider offline', async () => {
    const u = await makeUser();
    expect((await become(u.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    const plate = `VC${NUM}A`;
    const res = await change(u.token, { vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Axio', year: 2019, color: 'White', licensePlate: plate } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ kind: 'DRIVER', vehicleType: 'CAR', previousVehicleType: 'MOTORCYCLE', changed: true, activeRole: 'DRIVER', lastMoverRole: 'DRIVER' });

    const driver = await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }));
    expect(driver).toMatchObject({ vehicleType: 'CAR', rideClass: 'ECONOMY', vehicleCapacity: 4, licensePlate: plate, isOnline: false, documentsVerified: false });
    const user = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: u.userId }, select: { roles: true, activeRole: true, lastMoverRole: true } }));
    expect(user.roles).toEqual(expect.arrayContaining(['MOVER', 'RIDER', 'DRIVER']));
    expect(user.lastMoverRole).toBe('DRIVER');
    expect((await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId } }))).isOnline).toBe(false);
    expect((await send('GET', '/api/v1/driver/profile', u.token)).statusCode).toBe(200);
  });

  it('a weekly plan running on the current profile keeps the move between kinds with support — nothing changes', async () => {
    const u = await makeUser();
    const made = await become(u.token, { vehicleType: 'MOTORCYCLE' });
    const riderId: string = made.json().data.id;
    await system(() => app.prisma.subscription.create({ data: {
      riderId, type: 'DELIVERY_RIDER', status: 'TRIAL', weeklyRate: 0,
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
    } }));
    const res = await change(u.token, { vehicleType: 'WAGON_CAR', vehicle: { make: 'Toyota', model: 'Fielder', year: 2017, color: 'Grey', licensePlate: `VC${NUM}B` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PLAN_ON_CURRENT_ROLE');
    expect(await system(() => app.prisma.driver.count({ where: { userId: u.userId } }))).toBe(0);
    expect((await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: u.userId } }))).vehicleType).toBe('MOTORCYCLE');
    // Within the same kind of work the plan simply follows the new vehicle.
    const same = await change(u.token, { vehicleType: 'BICYCLE' });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().data).toMatchObject({ kind: 'RIDER', vehicleType: 'BICYCLE' });
  });
});

describe('PUT /partner/vehicle: a driver changes car', () => {
  it('same plate, new type: papers bound to the plate stay; a new plate retires them and closes the assignment', async () => {
    const u = await makeUser();
    const plateA = `VC${NUM}C`;
    const made = await become(u.token, { vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Premio', year: 2018, color: 'Blue', licensePlate: plateA } });
    expect(made.statusCode, made.body).toBe(201);
    // The car's insurance, bound to the car the plate names (as submission binds it).
    const subject = await system(() => app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: u.userId } }));
    await system(() => app.prisma.vehicleProfile.create({ data: { subjectId: subject.id, registrationMark: plateA, countryCode: 'GY', vehicleKind: 'CAR', registeredById: u.userId } }));
    await system(() => app.prisma.subjectLink.create({ data: { accountId: u.userId, subjectId: subject.id, relation: 'ASSIGNED_DRIVER', approvedAt: new Date() } }));
    const insurance = await approved(u.userId, 'vehicle_insurance', { subjectId: subject.id });

    // Re-declared as a wagon, same plate: the same physical car, so its papers stay.
    const wagon = await change(u.token, { vehicleType: 'WAGON_CAR', vehicle: { make: 'Toyota', model: 'Premio', year: 2018, color: 'Blue', licensePlate: plateA } });
    expect(wagon.statusCode, wagon.body).toBe(200);
    expect(wagon.json().data).toMatchObject({ kind: 'DRIVER', vehicleType: 'WAGON_CAR', retiredDocuments: 0 });
    expect((await docState(insurance.id)).state).toBe('COMMITTED');
    const driver = await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }));
    expect(driver).toMatchObject({ rideClass: 'COMFORT', vehicleCapacity: 5 });
    expect((await system(() => app.prisma.subjectLink.findFirstOrThrow({ where: { accountId: u.userId, subjectId: subject.id } }))).validTo).toBeNull();

    // A different car: the old car's papers are retired and its assignment closes.
    const bus = await change(u.token, { vehicleType: 'BUS_15', vehicle: { make: 'Toyota', model: 'Hiace', year: 2016, color: 'White', licensePlate: `VC${NUM}D` } });
    expect(bus.statusCode, bus.body).toBe(200);
    expect(bus.json().data).toMatchObject({ vehicleType: 'BUS_15', retiredDocuments: 1 });
    expect((await docState(insurance.id)).state).toBe('SUPERSEDED');
    expect((await system(() => app.prisma.subjectLink.findFirstOrThrow({ where: { accountId: u.userId, subjectId: subject.id } }))).validTo).not.toBeNull();
    expect(await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId }, select: { rideClass: true, vehicleCapacity: true } }))).toEqual({ rideClass: 'GROUP', vehicleCapacity: 15 });
  });

  it('a verified driver steps up first; a driver on a ride cannot change at all', async () => {
    const u = await makeUser();
    const made = await become(u.token, { vehicleType: 'CAR', vehicle: { make: 'Nissan', model: 'Tiida', year: 2015, color: 'Black', licensePlate: `VC${NUM}E` } });
    expect(made.statusCode, made.body).toBe(201);
    await system(() => app.prisma.driver.update({ where: { userId: u.userId }, data: { documentsVerified: true } }));
    const next = { vehicleType: 'WAGON_CAR', vehicle: { make: 'Nissan', model: 'Wingroad', year: 2016, color: 'Black', licensePlate: `VC${NUM}F` } };

    const noStepUp = await change(u.token, next);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }))).vehicleType).toBe('CAR');

    await grantStepUp(app, u.token);
    await system(() => app.prisma.driver.update({ where: { userId: u.userId }, data: { currentRideId: `ride-${nanoid(8)}` } }));
    const onRide = await change(u.token, next);
    expect(onRide.statusCode).toBe(409);
    expect(onRide.json().error.code).toBe('ACTIVE_WORK');
    expect((await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }))).vehicleType).toBe('CAR');

    await system(() => app.prisma.driver.update({ where: { userId: u.userId }, data: { currentRideId: null } }));
    const ok = await change(u.token, next);
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }));
    expect(after).toMatchObject({ vehicleType: 'WAGON_CAR', documentsVerified: false, documentsVerifiedAt: null, isOnline: false });
  });
});
