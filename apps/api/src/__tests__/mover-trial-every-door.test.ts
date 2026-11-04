import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, VehicleType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { CountryConfigService, partnerRateFor } from '../modules/country/country-config.service';
import * as feeAuthority from '../modules/subscription/mover-fee-authority';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { cleanupBillingClocks, cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { testPhone } from './helpers/fixture-ids';

// A mover's weekly fee is born the moment they hold BOTH a mover profile and approved documents, whichever comes second.
// The trial used to be born only at a document approval that found a profile, so a mover whose papers were approved
// before the vehicle was saved got no fee at all, and a rider's GO let a missing row through. Every door below is the
// real route; nothing here is mocked but the failures it says it injects.

const DAY = 86_400_000;
let app: FastifyInstance;
let service: VerificationService;
let riderRate = 0;
const users: string[] = [];
const fictions: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'mover-trial-every-door');
const plate = () => `HAA${String(Date.now()).slice(-4)}${nanoid(3).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;

/** A person who signed up to earn and stopped before the vehicle step: the MOVER role, no Rider, no Driver. */
async function signedUpMover(tenantId?: string) {
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Door', lastName: 'Test', roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY', customer: { create: {} }, ...(tenantId ? { tenantId } : {}),
  } }));
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `door-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token };
}

const send = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) => app.inject({
  method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
});
const become = (token: string, body: Record<string, unknown>) => send('POST', '/api/v1/partner/become', token, { role: 'MOVER', acceptAgreement: true, ...body });
const change = (token: string, body: Record<string, unknown>) => send('PUT', '/api/v1/partner/vehicle', token, body);
const GO = { latitude: 6.8013, longitude: -58.1551 };
const riderGo = (token: string) => send('POST', '/api/v1/rider/go-online', token, GO);
const driverGo = (token: string) => send('POST', '/api/v1/driver/go-online', token, GO);
const taxi = () => ({ vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'White', licensePlate: plate() } });

const checklistOf = (vehicleType: VehicleType) => system(() => new CountryConfigService(app.prisma).getMoverChecklist('GY', vehicleType));
/** An approved paper, filed the way the review pipeline leaves it (the INSERT trigger derives COMMITTED + a VALID record). */
const approvedPaper = (userId: string, docType: string) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/door/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'door-test',
  reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY),
  ...(docType === 'vehicle_insurance' ? { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } : {}),
} }));
async function approvePapers(userId: string, vehicleType: VehicleType, except?: string) {
  for (const docType of await checklistOf(vehicleType)) if (docType !== except) await approvedPaper(userId, docType);
}

const subscriptionsOf = (userId: string) => system(() => app.prisma.subscription.findMany({ where: { OR: [{ rider: { userId } }, { driver: { userId } }] } }));
const trialGrantsOf = (userId: string) => system(() => app.prisma.trialGrant.count({ where: { accountId: userId } }));
const riderOf = (userId: string) => system(() => app.prisma.rider.findUnique({ where: { userId } }));
const driverOf = (userId: string) => system(() => app.prisma.driver.findUnique({ where: { userId } }));

function expectTrial(sub: { status: string; isTrialActive: boolean; trialEndDate: Date | null; weeklyRate: unknown } | undefined) {
  expect(sub?.status).toBe('TRIAL');
  expect(sub?.isTrialActive).toBe(true);
  expect(Number(sub?.weeklyRate)).toBeGreaterThan(0);
  const days = (sub!.trialEndDate!.getTime() - Date.now()) / DAY;
  expect(days).toBeGreaterThan(13.9);
  expect(days).toBeLessThanOrEqual(14);
}

/** One fee, on the rider's own type and rate: what a mover with no taxi in use pays. */
async function expectDeliveryFee(userId: string) {
  const subs = await subscriptionsOf(userId);
  expect(subs).toHaveLength(1);
  expect(subs[0]!.type).toBe('DELIVERY_RIDER');
  expect(Number(subs[0]!.weeklyRate)).toBe(riderRate);
  expect(subs[0]!.driverId).toBeNull();
  const authority = await system(() => app.prisma.moverFeeAuthority.findUnique({ where: { userId } }));
  if (authority) expect(authority.feeType).toBe('DELIVERY_RIDER');
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const tiers = await system(() => new CountryConfigService(app.prisma).getSubscriptionTiers('GY'));
  riderRate = partnerRateFor(tiers, { kind: 'RIDER', vehicleType: 'MOTORCYCLE' }).rate;
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await system(async () => {
    const subIds = (await app.prisma.subscription.findMany({ where: { OR: [{ rider: { userId: { in: users } } }, { driver: { userId: { in: users } } }] }, select: { id: true } })).map((s) => s.id);
    await cleanupPayerBillingClocks(app.prisma, users);
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.verificationDecisionOutbox.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: { in: fictions } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: fictions } } });
  });
  await app.close();
});

describe('papers approved before the vehicle is saved', () => {
  it.each(['MOTORCYCLE', 'BICYCLE'] as const)('%s: the trial is born when the vehicle is saved, and GO then stands on it', async (vehicleType) => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, vehicleType);
    const before = await send('GET', `/api/v1/verification/status?role=MOVER&vehicleType=${vehicleType}`, mover.token);
    expect(before.json().data.roleVerified).toBe(true);
    expect(before.json().data.vehicleType).toBeNull();

    const saved = await become(mover.token, { vehicleType });
    expect(saved.statusCode, saved.body).toBe(201);

    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
    expect(subs[0]!.riderId).toBe((await riderOf(mover.userId))!.id);
    expect(await trialGrantsOf(mover.userId)).toBe(1);
    const fee = await send('GET', '/api/v1/rider/subscription', mover.token);
    expect(fee.statusCode, fee.body).toBe(200);
    expect(fee.json().data?.status).toBe('TRIAL');

    const go = await riderGo(mover.token);
    expect(go.statusCode, go.body).toBe(200);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(1);
  });

  it('through the real approval: the approval owes nothing yet (no profile), the vehicle collects it', async () => {
    const mover = await signedUpMover();
    const reviewer = (await signedUpMover()).userId;
    const list = await checklistOf('MOTORCYCLE');
    for (const docType of list) {
      const doc = await system(() => app.prisma.verificationDocument.create({ data: {
        userId: mover.userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/door/${docType}-${nanoid(4)}.enc`, status: 'PENDING',
      } }));
      await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
      const insurance = docType === 'vehicle_insurance'
        ? { insurerName: 'Door Insurance', policyNumber: 'P-1', coverageClass: 'HIRE' as const, hireClassConfirmed: true, plateCrossChecked: true } : undefined;
      await system(() => service.approveDocument(doc.id, reviewer, new Date(Date.now() + 200 * DAY), insurance));
    }
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
  });

  it('a taxi driver: the same trial on the driver profile, and the plate is captured before it', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'CAR');
    const car = taxi();
    const saved = await become(mover.token, car);
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().data.kind).toBe('DRIVER');

    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
    expect(subs[0]!.type).toBe('TAXI_DRIVER');
    expect(subs[0]!.driverId).toBe((await driverOf(mover.userId))!.id);
    const plateKey = await system(() => app.prisma.identityKey.count({ where: { accountId: mover.userId, type: 'PLATE' } }));
    expect(plateKey).toBe(1);
    const go = await driverGo(mover.token);
    expect(go.statusCode, go.body).toBe(200);
  });

  it('a rider on a trial who adds a car with its papers already approved: one fee, repriced for the taxi, no second trial', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    const riderFee = (await subscriptionsOf(mover.userId))[0]!;
    await approvePapers(mover.userId, 'CAR');
    const saved = await become(mover.token, taxi());
    expect(saved.statusCode, saved.body).toBe(201);
    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expect(await trialGrantsOf(mover.userId)).toBe(1);
    const authority = await system(() => app.prisma.moverFeeAuthority.findUnique({ where: { userId: mover.userId } }));
    expect(authority?.feeType).toBe('TAXI_DRIVER');
    expect(Number(subs[0]!.weeklyRate)).toBeGreaterThan(Number(riderFee.weeklyRate));
  });

  it('papers not all approved: nothing is owed, nothing is born, GO asks for documents', async () => {
    const mover = await signedUpMover();
    const [first] = await checklistOf('MOTORCYCLE');
    await approvedPaper(mover.userId, first!);
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
    expect(await trialGrantsOf(mover.userId)).toBe(0);
    const go = await riderGo(mover.token);
    expect(go.statusCode, go.body).toBe(403);
    expect(go.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
  });

  it('once: a repeated save, GO and two saves at once leave one fee and one trial grant', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    const [a, b] = await Promise.all([become(mover.token, { vehicleType: 'MOTORCYCLE' }), become(mover.token, { vehicleType: 'MOTORCYCLE' })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(200);
    expect((await riderGo(mover.token)).statusCode).toBe(200);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(1);
    expect(await trialGrantsOf(mover.userId)).toBe(1);
  });
});

describe('the ordinary order is unchanged', () => {
  it('vehicle first, papers after: the last approval births the trial, once', async () => {
    const mover = await signedUpMover();
    const reviewer = (await signedUpMover()).userId;
    expect((await become(mover.token, { vehicleType: 'BICYCLE' })).statusCode).toBe(201);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
    for (const docType of await checklistOf('BICYCLE')) {
      const doc = await system(() => app.prisma.verificationDocument.create({ data: {
        userId: mover.userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/door/${docType}-${nanoid(4)}.enc`, status: 'PENDING',
      } }));
      await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
      await system(() => service.approveDocument(doc.id, reviewer, new Date(Date.now() + 200 * DAY)));
    }
    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
    expect(await trialGrantsOf(mover.userId)).toBe(1);
  });
});

describe('changing the vehicle', () => {
  it('a driver with no fee moves to a vehicle whose papers are complete: the rider\'s trial is born there, at the rider\'s rate', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'BICYCLE');
    expect((await become(mover.token, taxi())).statusCode).toBe(201);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);

    const moved = await change(mover.token, { vehicleType: 'BICYCLE' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().data.kind).toBe('RIDER');

    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
    expect(subs[0]!.riderId).toBe((await riderOf(mover.userId))!.id);
    await expectDeliveryFee(mover.userId);
    expect((await riderGo(mover.token)).statusCode).toBe(200);
  });
});

describe('the fee follows the vehicle in use, on that vehicle\'s own list', () => {
  const tierChanges = async (userId: string) => {
    const ids = (await subscriptionsOf(userId)).map((s) => s.id);
    return system(() => app.prisma.billingEvent.count({ where: { subscriptionId: { in: ids }, type: 'TIER_CHANGE' } }));
  };
  const switchTo = async (mover: { token: string }, role: 'RIDER' | 'DRIVER') => {
    const res = await send('POST', '/api/v1/customer/switch-role', mover.token, { role });
    expect(res.statusCode, res.body).toBe(200);
  };

  it('a rider on a trial who added a car with no car papers saves the motorbike again: the fee does not move', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    expect((await become(mover.token, taxi())).statusCode).toBe(201);
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(200);
    await expectDeliveryFee(mover.userId);
    expect(await tierChanges(mover.userId)).toBe(0);
    expect((await riderGo(mover.token)).statusCode).toBe(200);
    await expectDeliveryFee(mover.userId);
  });

  it('GO collects for the vehicle moved to, not the one left behind', async () => {
    const mover = await signedUpMover();
    expect((await become(mover.token, taxi())).statusCode).toBe(201);
    expect((await change(mover.token, { vehicleType: 'BICYCLE' })).statusCode).toBe(200);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
    await approvePapers(mover.userId, 'BICYCLE');
    expect((await riderGo(mover.token)).statusCode).toBe(200);
    await expectDeliveryFee(mover.userId);
  });

  it('the last approval of a rider who holds a complete car list but rides the bike leaves the rider\'s fee alone', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    expect((await become(mover.token, taxi())).statusCode).toBe(201);
    await switchTo(mover, 'RIDER');
    await approvePapers(mover.userId, 'CAR', 'hire_car_driver_licence');
    const reviewer = (await signedUpMover()).userId;
    const doc = await system(() => app.prisma.verificationDocument.create({ data: {
      userId: mover.userId, role: 'MOVER', docType: 'hire_car_driver_licence', fileUrl: `/uploads/verification/door/hire-${nanoid(4)}.enc`, status: 'PENDING',
    } }));
    await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
    await system(() => service.approveDocument(doc.id, reviewer, new Date(Date.now() + 200 * DAY)));
    await expectDeliveryFee(mover.userId);
    expect(await tierChanges(mover.userId)).toBe(0);
  });

  it('that rider switches to the car and presses GO: the taxi fee, once, on the one row', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    expect((await become(mover.token, taxi())).statusCode).toBe(201);
    await switchTo(mover, 'RIDER');
    await approvePapers(mover.userId, 'CAR');
    await expectDeliveryFee(mover.userId);
    await switchTo(mover, 'DRIVER');
    expect((await driverGo(mover.token)).statusCode).toBe(200);
    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expect((await system(() => app.prisma.moverFeeAuthority.findUnique({ where: { userId: mover.userId } })))?.feeType).toBe('TAXI_DRIVER');
    expect(await trialGrantsOf(mover.userId)).toBe(1);
  });

  it('GO names its own profile: a driver whose pointer still says rider is judged on the car\'s list and pays the taxi fee', async () => {
    const mover = await signedUpMover();
    const car = taxi();
    await system(() => app.prisma.driver.create({ data: {
      userId: mover.userId, rideClass: 'ECONOMY', vehicleCapacity: 4, vehicleType: 'CAR', vehicleMake: car.vehicle.make, vehicleModel: car.vehicle.model,
      vehicleYear: car.vehicle.year, vehicleColor: car.vehicle.color, licensePlate: car.vehicle.licensePlate, driverLicenseUrl: '', vehicleInsuranceUrl: '',
    } }));
    await system(() => app.prisma.rider.create({ data: { userId: mover.userId, riderType: 'BOTH', vehicleType: 'BICYCLE' } }));
    await system(() => app.prisma.user.update({ where: { id: mover.userId }, data: { roles: ['MOVER', 'CUSTOMER', 'RIDER', 'DRIVER'], activeRole: 'MOVER', lastMoverRole: 'RIDER' } }));
    await approvePapers(mover.userId, 'CAR');
    const go = await driverGo(mover.token);
    expect(go.statusCode, go.body).toBe(200);
    expect((await subscriptionsOf(mover.userId)).map((s) => s.type)).toEqual(['TAXI_DRIVER']);
  });

  it('a driver already on the taxi fee is not re-activated by GO', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'CAR');
    expect((await become(mover.token, taxi())).statusCode).toBe(201);
    const start = vi.spyOn(SubscriptionService.prototype, 'startTrialForDriver');
    expect((await driverGo(mover.token)).statusCode).toBe(200);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('GO is the last door: no fee row, no free pass', () => {
  /** The state the old order left: a saved vehicle, every paper approved, no fee. */
  async function stranded(kind: 'RIDER' | 'DRIVER', tenantId?: string) {
    const mover = await signedUpMover(tenantId);
    if (kind === 'RIDER') {
      await system(() => app.prisma.rider.create({ data: { userId: mover.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } }));
      await system(() => app.prisma.user.update({ where: { id: mover.userId }, data: { roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
      await approvePapers(mover.userId, 'MOTORCYCLE');
    } else {
      const car = taxi();
      await system(() => app.prisma.driver.create({ data: {
        userId: mover.userId, rideClass: 'ECONOMY', vehicleCapacity: 4, vehicleType: 'CAR', vehicleMake: car.vehicle.make, vehicleModel: car.vehicle.model,
        vehicleYear: car.vehicle.year, vehicleColor: car.vehicle.color, licensePlate: car.vehicle.licensePlate, driverLicenseUrl: '', vehicleInsuranceUrl: '',
      } }));
      await system(() => app.prisma.user.update({ where: { id: mover.userId }, data: { roles: ['MOVER', 'CUSTOMER', 'DRIVER'], activeRole: 'DRIVER', lastMoverRole: 'DRIVER' } }));
      await approvePapers(mover.userId, 'CAR');
    }
    return mover;
  }

  it('a stranded rider presses GO: the trial they are owed is born, then they go online on it', async () => {
    const mover = await stranded('RIDER');
    const go = await riderGo(mover.token);
    expect(go.statusCode, go.body).toBe(200);
    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
  });

  it('a stranded driver presses GO: the same, where it used to be refused for ever', async () => {
    const mover = await stranded('DRIVER');
    const go = await driverGo(mover.token);
    expect(go.statusCode, go.body).toBe(200);
    const subs = await subscriptionsOf(mover.userId);
    expect(subs).toHaveLength(1);
    expectTrial(subs[0]);
  });

  it('when the fee cannot be born the rider stays offline, told plainly, and is never called unpaid', async () => {
    const mover = await stranded('RIDER');
    vi.spyOn(SubscriptionService.prototype, 'startTrialForRider').mockRejectedValue(new Error('injected: fee not born'));
    const go = await riderGo(mover.token);
    expect(go.statusCode, go.body).toBe(403);
    expect(go.json().error.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect(go.json().error.message).toMatch(/Get Help/);
    expect(go.json().error.message).not.toMatch(/unpaid/i);
    expect(go.json().error.details).toEqual({ nextStep: 'OPEN_WEEKLY_FEE' });
    expect((await riderOf(mover.userId))!.isOnline).toBe(false);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
  });

  it('the check under the lock reads the same rule: a row missing there is refused too', async () => {
    const mover = await stranded('RIDER');
    vi.spyOn(SubscriptionService.prototype, 'startTrialForRider').mockRejectedValue(new Error('injected: fee not born'));
    vi.spyOn(feeAuthority, 'moverFeeOperability').mockResolvedValueOnce({ operable: true });
    const go = await riderGo(mover.token);
    expect(go.statusCode, go.body).toBe(403);
    expect(go.json().error.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await riderOf(mover.userId))!.isOnline).toBe(false);
  });

  it('a failed birth at the save never loses the vehicle: the save answers 201 and GO collects the trial', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    const failing = vi.spyOn(SubscriptionService.prototype, 'startTrialForRider').mockRejectedValueOnce(new Error('injected: fee not born'));
    const saved = await become(mover.token, { vehicleType: 'MOTORCYCLE' });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await riderOf(mover.userId)).not.toBeNull();
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
    expect((await riderGo(mover.token)).statusCode).toBe(200);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(1);
  });

  it('a mover holding a fee row is not re-activated by GO', async () => {
    const mover = await signedUpMover();
    await approvePapers(mover.userId, 'MOTORCYCLE');
    expect((await become(mover.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    const start = vi.spyOn(SubscriptionService.prototype, 'startTrialForRider');
    expect((await riderGo(mover.token)).statusCode).toBe(200);
    expect(start).not.toHaveBeenCalled();
  });

  it('what the grandfather clause exists for: a legacy-verified rider who never filed a paper keeps working, with no row', async () => {
    const mover = await signedUpMover();
    await system(() => app.prisma.rider.create({ data: { userId: mover.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true } }));
    await system(() => app.prisma.user.update({ where: { id: mover.userId }, data: { roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
    const go = await riderGo(mover.token);
    expect(go.statusCode, go.body).toBe(200);
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
  });

  it('a legacy-verified rider whose papers are all approved is owed the trial like anyone else', async () => {
    const mover = await signedUpMover();
    await system(() => app.prisma.rider.create({ data: { userId: mover.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true } }));
    await system(() => app.prisma.user.update({ where: { id: mover.userId }, data: { roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' } }));
    await approvePapers(mover.userId, 'MOTORCYCLE');
    expect((await riderGo(mover.token)).statusCode).toBe(200);
    expectTrial((await subscriptionsOf(mover.userId))[0]);
  });

  it.each(['RIDER', 'DRIVER'] as const)('the store-review fiction (%s) holds no fee and is not asked for one: GO stands, nothing is written', async (kind) => {
    const tenantId = `review-door-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
    await system(() => app.prisma.tenant.create({ data: { id: tenantId, name: 'Door fiction', slug: tenantId, kind: 'REVIEW' } }));
    fictions.push(tenantId);
    await system(() => app.prisma.reviewSession.create({ data: { tenantId, expiresAt: new Date(Date.now() + DAY) } }));
    const mover = await stranded(kind, tenantId);
    const settle = vi.spyOn(VerificationService.prototype, 'settleMoverFee');
    const go = await (kind === 'RIDER' ? riderGo : driverGo)(mover.token);
    expect(go.statusCode, go.body).toBe(200);
    expect(settle).not.toHaveBeenCalled();
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
  });

  it('an erased account is owed nothing: the barrier stops it before any activation, so no fee and no plate key', async () => {
    const mover = await stranded('DRIVER');
    await system(() => app.prisma.user.update({ where: { id: mover.userId }, data: { status: 'DEACTIVATED' } }));
    const start = vi.spyOn(SubscriptionService.prototype, 'startTrialForDriver');
    expect(await system(() => service.settleMoverFee(mover.userId))).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(await subscriptionsOf(mover.userId)).toHaveLength(0);
    expect(await system(() => app.prisma.identityKey.count({ where: { accountId: mover.userId, type: 'PLATE' } }))).toBe(0);
  });
});
