import { registerMoverPush } from './helpers/mover-push';
import { PrismaClient } from '@prisma/client';
import * as documentAuthority from '../modules/verification/mover-document-authority';
import { resolveSubject } from '../modules/verification/subjects';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { ownedVerificationFixture } from './helpers/verification-object';
import { stepUpKey } from '../modules/auth/step-up';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { CountryConfigService } from '../modules/country/country-config.service';

const DAY = 86_400_000;
const users: string[] = [];
const riders: string[] = [];
const orders: string[] = [];
const subjects: string[] = [];
const phoneBase = 592_006_000_000 + Math.floor(Math.random() * 900_000);
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await app.prisma.countryConfig.upsert({ where: { code: 'GY' }, update: {}, create: {
    code: 'GY', name: 'Guyana', currencyCode: 'GYD', currencySymbol: '$', usdExchangeRate: 208.5,
    subscriptionTiers: { mover: 6000, smallVendor: 6000, largeVendor: 12000 },
    documentChecklists: DEFAULT_DOCUMENT_CHECKLISTS,
  } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!app) return;
  if (orders.length) await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
  if (users.length) {
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: users } } }, { driver: { userId: { in: users } } }] } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { OR: [{ id: { in: subjects } }, { createdById: { in: users } }] } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  for (const riderId of riders) {
    await app.redis.del(`rider:location_db_ts:${riderId}`, `rider:online_since:${riderId}`);
  }
  await app.close();
});

async function fixture(legacyVerified = true) {
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Mover',
    activeRole: 'RIDER', roles: ['RIDER'], countryCode: 'GY',
    isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  users.push(user.id);
  await registerMoverPush(app.prisma, user.id);
  const rider = await app.prisma.rider.create({ data: {
    userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
    documentsVerified: legacyVerified, isOnline: false, isAvailable: false,
  } });
  riders.push(rider.id);
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid() });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, riderId: rider.id, token };
}

async function document(userId: string, docType: string, status: 'APPROVED' | 'EXPIRED' | 'REJECTED' | 'PENDING', expiresAt: Date) {
  return app.prisma.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType, status, expiresAt,
    fileUrl: `/uploads/verification/synthetic-${nanoid()}.enc`,
    ...(status === 'APPROVED' ? { reviewedAt: new Date(), reviewedBy: 'synthetic-review' } : {}),
  } });
}
function go(token: string) {
  return app.inject({ method: 'POST', url: '/api/v1/rider/go-online',
    headers: { authorization: `Bearer ${token}` }, payload: { latitude: 6.8, longitude: -58.15 } });
}

describe('rider GO uses current document authority even with a legacy approval', () => {
  it.each(['APPROVED', 'EXPIRED', 'REJECTED', 'PENDING'] as const)('refuses known noncurrent %s required evidence', async (status) => {
    const mover = await fixture();
    const doc = await document(mover.userId, 'drivers_licence', status,
      new Date(Date.now() + (status === 'APPROVED' || status === 'EXPIRED' ? -DAY : DAY)));
    expect(await app.prisma.verificationDocument.count({ where: { id: doc.id } })).toBe(1);
    const result = await go(mover.token);
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe('VERIFICATION_REQUIRED');
    const profile = await app.prisma.rider.findUniqueOrThrow({ where: { id: mover.riderId } });
    expect(profile.isOnline).toBe(false);
    expect(profile.locationSessionId).toBeNull();
  });

  it('preserves the documented never-filed legacy exception', async () => {
    const mover = await fixture();
    expect((await go(mover.token)).statusCode).toBe(200);
  });

  it('allows all genuinely current required approvals without a legacy flag', async () => {
    const mover = await fixture(false);
    const types = await new CountryConfigService(app.prisma).getMoverChecklist('GY', 'MOTORCYCLE');
    expect(types).toContain('drivers_licence');
    for (const type of types) await document(mover.userId, type, 'APPROVED', new Date(Date.now() + DAY));
    expect((await go(mover.token)).statusCode).toBe(200);
  });
});


function verification() {
  return new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
}
async function availableOrder() {
  const customer = await fixture();
  const order = await app.prisma.order.create({ data: {
    customerId: customer.userId, orderNumber: `DOCS-${nanoid()}`, orderType: 'FOOD_DELIVERY',
    status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY', paymentMethod: 'CASH',
    pickupAddress: 'Synthetic pickup', deliveryAddress: 'Synthetic drop',
    pickupLat: 6.8, pickupLng: -58.15, deliveryLat: 6.81, deliveryLng: -58.16,
    subtotalBase: 100, subtotalMarkup: 0, subtotalCustomer: 100, deliveryFee: 500, totalAmount: 600,
  } });
  orders.push(order.id);
  return order;
}

describe('known invalid proof is never a never-filed legacy exception', () => {
  it.each(['REJECTED', 'PENDING'] as const)('recognizes a %s submission with no committed record', async (status) => {
    const mover = await fixture();
    await document(mover.userId, 'drivers_licence', status, new Date(Date.now() + DAY));
    expect(await app.prisma.documentRecord.count({ where: { accountId: mover.userId } })).toBe(0);
    expect(await verification().getLiveOperationStatus(mover.userId, { vehicleType: 'MOTORCYCLE', legacyVerified: true }))
      .toEqual({ allowed: false, reason: 'docs' });
  });

  it('does not treat a retired submission as never filed', async () => {
    const mover = await fixture();
    const doc = await document(mover.userId, 'drivers_licence', 'APPROVED', new Date(Date.now() + DAY));
    await app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { purgedAt: new Date(), fileUrl: '' } });
    expect(await verification().getLiveOperationStatus(mover.userId, { vehicleType: 'MOTORCYCLE', legacyVerified: true }))
      .toEqual({ allowed: false, reason: 'docs' });
  });
});

describe('current document authority applies to new custody', () => {
  it.each(['board', 'offer'] as const)('refuses the %s claim and rolls back order, float and profile changes', async (door) => {
    const mover = await fixture();
    expect((await go(mover.token)).statusCode).toBe(200);
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { floatLimit: 10000 } });
    // The durable expiry clock can pass before the daily offline projection.
    await document(mover.userId, 'drivers_licence', 'APPROVED', new Date(Date.now() - DAY));
    const order = await availableOrder();
    if (door === 'board') {
      const response = await app.inject({ method: 'POST', url: `/api/v1/rider/orders/${order.id}/accept`,
        headers: { authorization: `Bearer ${mover.token}` }, payload: {} });
      expect(response.json().error?.code).toBe('VERIFICATION_REQUIRED');
    } else {
      const dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});
      await expect(dispatch.claimOrder(order.id, mover.riderId, 'RIDER')).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    }
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('READY_FOR_PICKUP');
    expect(fresh.riderId).toBeNull();
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
    const profile = await app.prisma.rider.findUniqueOrThrow({ where: { id: mover.riderId } });
    expect(profile.currentOrderId).toBeNull();
    expect(Number(profile.committedFloat)).toBe(0);
  });
});


function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function beforeDeadlinePasses(date: Date) {
  // PostgreSQL's clock is also what the operational SQL write must consult.
  for (;;) {
    const [row] = await app.prisma.$queryRaw<Array<{ expired: boolean }>>`SELECT clock_timestamp() >= ${date}::timestamptz AS expired`;
    if (row?.expired) return;
    await new Promise((done) => setTimeout(done, 10));
  }
}
async function waitForBlocking(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await app.prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`;
    if (row?.blocked) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Competing PostgreSQL transaction never reached the authority lock');
}

describe('GO and document changes have a real PostgreSQL order', () => {
  it('rechecks after a successful preview and committed revocation', async () => {
    const mover = await fixture();
    const doc = await document(mover.userId, 'drivers_licence', 'APPROVED', new Date(Date.now() + DAY));
    const preview = latch(); const resume = latch();
    const original = VerificationService.prototype.riderLiveOperation;
    vi.spyOn(VerificationService.prototype, 'riderLiveOperation').mockImplementationOnce(async function (this: VerificationService, ...args) {
      const allowed = await original.apply(this, args);
      expect(allowed).toBe(true);
      preview.resolve(); await resume.promise;
      return allowed;
    });
    const pending = go(mover.token);
    await preview.promise;
    try {
      await verification().revokeDocument(doc.id, 'synthetic-review', 'Synthetic authority withdrawal');
    } finally { resume.resolve(); }
    const response = await pending;
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: mover.riderId } })).isOnline).toBe(false);
  });

  it('checks expiry at the final SQL write after an allowed locked verdict', async () => {
    const mover = await fixture();
    const expires = new Date(Date.now() + 1500);
    await document(mover.userId, 'drivers_licence', 'APPROVED', expires);
    const original = documentAuthority.lockMoverDocuments;
    vi.spyOn(documentAuthority, 'lockMoverDocuments').mockImplementationOnce(async (...args) => {
      const verdict = await original(...args);
      expect(verdict.allowed).toBe(true);
      expect(verdict.validUntil).toEqual(expires);
      await beforeDeadlinePasses(expires);
      return verdict;
    });
    const response = await go(mover.token);
    expect(response.statusCode).toBe(403);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: mover.riderId } })).isOnline).toBe(false);
  });

  it.each(['revocation', 'assignment removal'] as const)('holds fleet %s until the other account GO commits', async (action) => {
    const owner = await fixture(); const mover = await fixture();
    const mark = `SYN${nanoid(8).replace(/[^a-zA-Z0-9]/g, 'X')}`;
    await app.prisma.rider.update({ where: { id: owner.riderId }, data: { licensePlate: mark } });
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: mark } });
    const subject = await app.prisma.$transaction((tx) => resolveSubject(tx, {
      userId: owner.userId, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default',
    }));
    expect(subject).not.toBeNull(); subjects.push(subject!.subjectId);
    await app.prisma.subjectLink.create({ data: {
      subjectId: subject!.subjectId, accountId: mover.userId, relation: 'ASSIGNED_DRIVER', approvedAt: new Date(),
    } });
    const doc = await app.prisma.verificationDocument.create({ data: {
      userId: owner.userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
      subjectId: subject!.subjectId, expiresAt: new Date(Date.now() + DAY),
      fileUrl: `/uploads/verification/synthetic-${nanoid()}.enc`, reviewedBy: 'synthetic-review', reviewedAt: new Date(),
    } });
    const locked = latch(); const resume = latch();
    const original = documentAuthority.lockMoverDocuments;
    vi.spyOn(documentAuthority, 'lockMoverDocuments').mockImplementationOnce(async (...args) => {
      const verdict = await original(...args); expect(verdict.allowed).toBe(true);
      locked.resolve(); await resume.promise; return verdict;
    });
    const pending = go(mover.token);
    await locked.promise;
    const writer = new PrismaClient();
    const started = latch(); let writerPid = 0;
    const revoke = writer.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      writerPid = row!.pid;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${owner.userId} FOR UPDATE`;
      started.resolve();
      if (action === 'revocation') {
        await tx.verificationDocument.update({ where: { id: doc.id }, data: { status: 'REJECTED', state: 'REVOKED' } });
      } else {
        await tx.subjectLink.updateMany({ where: { accountId: mover.userId, subjectId: subject!.subjectId }, data: { validTo: new Date() } });
      }
    }, { timeout: 10000 });
    try {
      await started.promise;
      await waitForBlocking(writerPid);
      resume.resolve();
      expect((await pending).statusCode).toBe(200);
      await revoke;
      expect((await go(mover.token)).statusCode).toBe(403);
    } finally { resume.resolve(); await revoke; await writer.$disconnect(); }
  });

  it('keeps a current approved proof usable while its replacement is pending', async () => {
    const mover = await fixture();
    await document(mover.userId, 'drivers_licence', 'APPROVED', new Date(Date.now() + DAY));
    await document(mover.userId, 'drivers_licence', 'PENDING', new Date(Date.now() + DAY));
    expect((await go(mover.token)).statusCode).toBe(200);
  });
});


describe('the selected operating profile owns its vehicle proof', () => {
  async function subjectFor(mover: Awaited<ReturnType<typeof fixture>>, suffix: string) {
    const mark = `DOC${suffix}${nanoid(8).replace(/[^a-zA-Z0-9]/g, 'X')}`;
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: mark } });
    const subject = await app.prisma.$transaction((tx) => resolveSubject(tx, {
      userId: mover.userId, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default',
    }));
    subjects.push(subject!.subjectId);
    return { subjectId: subject!.subjectId, mark };
  }
  it('uses the Rider plate when the account also retains a different Driver profile', async () => {
    const mover = await fixture();
    const own = await subjectFor(mover, 'A');
    await app.prisma.verificationDocument.create({ data: {
      userId: mover.userId, subjectId: own.subjectId, role: 'MOVER', docType: 'vehicle_insurance',
      status: 'APPROVED', expiresAt: new Date(Date.now() + DAY), fileUrl: 'storage://synthetic/rider-current',
    } });
    await app.prisma.driver.create({ data: {
      userId: mover.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleColor: 'Blue',
      vehicleYear: 2020, licensePlate: `OTHER${nanoid(8)}`, driverLicenseUrl: '', vehicleInsuranceUrl: '',
    } });
    expect((await go(mover.token)).statusCode).toBe(200);
  });
  it('refuses a closed assignment even when the actor uploaded the formerly valid vehicle proof', async () => {
    const mover = await fixture();
    const own = await subjectFor(mover, 'B');
    await app.prisma.verificationDocument.create({ data: {
      userId: mover.userId, subjectId: own.subjectId, role: 'MOVER', docType: 'vehicle_insurance',
      status: 'APPROVED', expiresAt: new Date(Date.now() + DAY), fileUrl: 'storage://synthetic/closed-assignment',
    } });
    await app.prisma.subjectLink.updateMany({ where: { accountId: mover.userId, subjectId: own.subjectId }, data: { validTo: new Date() } });
    const response = await go(mover.token);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('VERIFICATION_REQUIRED');
  });
});


describe('proof deadlines remain authoritative at the custody write', () => {
  it.each(['board', 'offer', 'driver'] as const)('rolls back %s custody when expiry passes after the locked verdict', async (door) => {
    const mover = await fixture();
    const order = await availableOrder();
    let moverId = mover.riderId;
    if (door === 'driver') {
      await app.prisma.user.update({ where: { id: mover.userId }, data: { activeRole: 'DRIVER', roles: ['RIDER', 'DRIVER'] } });
      const session = await app.prisma.session.findFirstOrThrow({ where: { userId: mover.userId } });
      const driver = await app.prisma.driver.create({ data: {
        userId: mover.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleColor: 'Blue',
        vehicleYear: 2020, licensePlate: 'SYNTHETIC', driverLicenseUrl: '', vehicleInsuranceUrl: '',
        isOnline: true, isAvailable: true, documentsVerified: true, locationSessionId: session.id,
      } });
      moverId = driver.id;
      await app.prisma.verificationDocument.create({ data: {
        userId: mover.userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
        coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true, fileUrl: 'storage://synthetic/deadline',
      } });
      await app.prisma.order.update({ where: { id: order.id }, data: { orderType: 'TAXI', status: 'PENDING', taxiFareTotal: 1000 } });
    } else {
      expect((await go(mover.token)).statusCode).toBe(200);
      await app.prisma.rider.update({ where: { id: mover.riderId }, data: { floatLimit: 10000 } });
    }
    const expires = new Date(Date.now() + 1500);
    await document(mover.userId, 'drivers_licence', 'APPROVED', expires);
    const original = documentAuthority.lockMoverDocuments;
    vi.spyOn(documentAuthority, 'lockMoverDocuments').mockImplementationOnce(async (...args) => {
      const verdict = await original(...args); expect(verdict.allowed).toBe(true);
      expect(verdict.validUntil).toEqual(expires);
      await beforeDeadlinePasses(expires); return verdict;
    });
    if (door === 'board') {
      const response = await app.inject({ method: 'POST', url: `/api/v1/rider/orders/${order.id}/accept`,
        headers: { authorization: `Bearer ${mover.token}` }, payload: {} });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    } else {
      const dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});
      await expect(dispatch.claimOrder(order.id, moverId, door === 'driver' ? 'DRIVER' : 'RIDER')).rejects.toThrow();
    }
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe(door === 'driver' ? 'PENDING' : 'READY_FOR_PICKUP');
    expect(fresh.riderId).toBeNull(); expect(fresh.driverId).toBeNull();
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { id: mover.riderId } });
    expect(rider.currentOrderId).toBeNull(); expect(Number(rider.committedFloat)).toBe(0);
    if (door === 'driver') expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: moverId } })).currentRideId).toBeNull();
  });
});


it('refuses Driver custody with known expired proof despite legacy approval', async () => {
  const mover = await fixture(); const order = await availableOrder();
  await app.prisma.user.update({ where: { id: mover.userId }, data: { activeRole: 'DRIVER', roles: ['DRIVER', 'RIDER'] } });
  const session = await app.prisma.session.findFirstOrThrow({ where: { userId: mover.userId } });
  const driver = await app.prisma.driver.create({ data: {
    userId: mover.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleColor: 'Blue',
    vehicleYear: 2020, licensePlate: 'HCLAIM', driverLicenseUrl: '', vehicleInsuranceUrl: '',
    isOnline: true, isAvailable: true, documentsVerified: true, locationSessionId: session.id,
  } });
  await app.prisma.verificationDocument.create({ data: {
    userId: mover.userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
    coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true, fileUrl: 'storage://synthetic/driver-claim',
  } });
  await document(mover.userId, 'drivers_licence', 'APPROVED', new Date(Date.now() - DAY));
  await app.prisma.order.update({ where: { id: order.id }, data: { orderType: 'TAXI', status: 'PENDING', taxiFareTotal: 1000 } });
  const dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});
  await expect(dispatch.claimOrder(order.id, driver.id, 'DRIVER')).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).driverId).toBeNull();
  expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).currentRideId).toBeNull();
  expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
});

it('driver GO enforces the proof deadline at its final SQL write', async () => {
  const mover = await fixture();
  await app.prisma.user.update({ where: { id: mover.userId }, data: { activeRole: 'DRIVER', roles: ['RIDER', 'DRIVER'] } });
  const driver = await app.prisma.driver.create({ data: {
    userId: mover.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleColor: 'Blue',
    vehicleYear: 2020, licensePlate: 'SYNTHETIC', driverLicenseUrl: '', vehicleInsuranceUrl: '', documentsVerified: true,
  } });
  await app.prisma.subscription.create({ data: {
    driverId: driver.id, type: 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 9000,
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + DAY), nextBillingDate: new Date(Date.now() + DAY),
  } });
  await app.prisma.verificationDocument.create({ data: {
    userId: mover.userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
    coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true, fileUrl: 'storage://synthetic/driver-go',
  } });
  const expires = new Date(Date.now() + 1500);
  await document(mover.userId, 'drivers_licence', 'APPROVED', expires);
  const original = documentAuthority.lockMoverDocuments;
  vi.spyOn(documentAuthority, 'lockMoverDocuments').mockImplementationOnce(async (...args) => {
    const verdict = await original(...args); expect(verdict.allowed).toBe(true);
    await beforeDeadlinePasses(expires); return verdict;
  });
  const response = await app.inject({ method: 'POST', url: '/api/v1/driver/go-online',
    headers: { authorization: `Bearer ${mover.token}` }, payload: { latitude: 6.8, longitude: -58.15 } });
  expect(response.statusCode).toBe(403);
  expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).isOnline).toBe(false);
});


it('refuses valid proof bound to a different vehicle even with a stale legacy flag', async () => {
  const mover = await fixture();
  await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: `OLD${nanoid(8)}` } });
  const subject = await app.prisma.$transaction((tx) => resolveSubject(tx, {
    userId: mover.userId, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default',
  }));
  subjects.push(subject!.subjectId);
  await app.prisma.verificationDocument.create({ data: {
    userId: mover.userId, subjectId: subject!.subjectId, role: 'MOVER', docType: 'vehicle_insurance',
    status: 'APPROVED', expiresAt: new Date(Date.now() + DAY), fileUrl: 'storage://synthetic/old-vehicle',
  } });
  await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: `NEW${nanoid(8)}` } });
  const response = await go(mover.token);
  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe('VERIFICATION_REQUIRED');
});


describe('submission and approval retain their actual vehicle authority', () => {
  async function dual(mover: Awaited<ReturnType<typeof fixture>>) {
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: 'RIDER123' } });
    return app.prisma.driver.create({ data: {
      userId: mover.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleColor: 'Blue',
      vehicleYear: 2020, licensePlate: 'DRIVER456', driverLicenseUrl: '', vehicleInsuranceUrl: '',
    } });
  }
  async function submit(mover: Awaited<ReturnType<typeof fixture>>, fileUrl: string) {
    return app.inject({ method: 'POST', url: '/api/v1/verification/documents',
      headers: { authorization: `Bearer ${mover.token}` }, payload: {
        role: 'MOVER', docType: 'vehicle_insurance', fileUrl, consent: true, privacyNoticeVersion: 'v1',
      } });
  }
  it('binds an authenticated RIDER submission to that profile even with a retained Driver', async () => {
    const mover = await fixture(); await dual(mover);
    const fileUrl = await ownedVerificationFixture(app.prisma, mover.userId, 'manual');
    const response = await submit(mover, fileUrl);
    expect(response.statusCode, response.body).toBe(201);
    const doc = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: response.json().data.id },
      include: { subject: { include: { vehicle: true } } } });
    expect(doc.subject?.vehicle?.registrationMark).toBe('RIDER123');
    expect(doc.subject?.vehicle?.vehicleKind).toBe('MOTORCYCLE');
  });
  it('holds a generic MOVER with two profiles instead of guessing a vehicle', async () => {
    const mover = await fixture(); await dual(mover);
    await app.prisma.user.update({ where: { id: mover.userId }, data: { activeRole: 'MOVER', roles: ['MOVER', 'RIDER', 'DRIVER'] } });
    const fileUrl = await ownedVerificationFixture(app.prisma, mover.userId, 'manual');
    const response = await submit(mover, fileUrl);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('MOVER_PROFILE_REQUIRED');
    expect(await app.prisma.verificationDocument.count({ where: { userId: mover.userId } })).toBe(0);
  });
  it('rejects a submission when the actual plate changes while processing is paused', async () => {
    const mover = await fixture();
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: `BEFORE${nanoid(5)}` } });
    const fileUrl = await ownedVerificationFixture(app.prisma, mover.userId, 'manual');
    const processing = latch(); const resume = latch();
    vi.spyOn(SandboxKycProvider.prototype, 'verifyDocument').mockImplementationOnce(async () => {
      processing.resolve(); await resume.promise;
      return { status: 'pending_manual', referenceToken: 'synthetic-paused-document' };
    });
    const pending = submit(mover, fileUrl);
    await processing.promise;
    const session = await app.prisma.session.findFirstOrThrow({ where: { userId: mover.userId } });
    await app.redis.set(stepUpKey(session.id), '1', 'EX', 60);
    try {
      const changed = await app.inject({ method: 'PUT', url: '/api/v1/rider/profile',
        headers: { authorization: `Bearer ${mover.token}` }, payload: { licensePlate: `AFTER${nanoid(5)}` } });
      expect(changed.statusCode, changed.body).toBe(200);
    } finally { resume.resolve(); await app.redis.del(stepUpKey(session.id)); }
    const response = await pending;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('MOVER_AUTHORITY_CHANGED');
    expect(await app.prisma.verificationDocument.count({ where: { userId: mover.userId } })).toBe(0);
  });
  it('approves a bound motorcycle submission using its stored subject after a Driver profile appears', async () => {
    const mover = await fixture();
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: `MOTOR${nanoid(5)}` } });
    const subject = await app.prisma.$transaction((tx) => resolveSubject(tx, {
      userId: mover.userId, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default',
    }));
    subjects.push(subject!.subjectId);
    const doc = await app.prisma.verificationDocument.create({ data: {
      userId: mover.userId, subjectId: subject!.subjectId, role: 'MOVER', docType: 'vehicle_insurance', status: 'PENDING',
      fileUrl: 'storage://synthetic/stored-motorcycle',
    } });
    await dual(mover);
    const reviewer = await fixture();
    const approved = await verification().approveDocument(doc.id, reviewer.userId, new Date(Date.now() + DAY));
    expect(approved.subjectId).toBe(subject!.subjectId);
    expect(approved.status).toBe('APPROVED');
  });
  it('binds an explicit DRIVER submission even while a Rider profile remains', async () => {
    const mover = await fixture(); await dual(mover);
    await app.prisma.user.update({ where: { id: mover.userId }, data: { activeRole: 'DRIVER', roles: ['RIDER', 'DRIVER'] } });
    const response = await submit(mover, await ownedVerificationFixture(app.prisma, mover.userId, 'manual'));
    expect(response.statusCode, response.body).toBe(201);
    const doc = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: response.json().data.id },
      include: { subject: { include: { vehicle: true } } } });
    expect(doc.subject?.vehicle?.registrationMark).toBe('DRIVER456');
    expect(doc.subject?.vehicle?.vehicleKind).toBe('CAR');
  });
  it('holds legacy unbound dual-profile approval without guessing from the active role', async () => {
    const mover = await fixture(); await dual(mover); const reviewer = await fixture();
    const doc = await document(mover.userId, 'vehicle_insurance', 'PENDING', new Date(Date.now() + DAY));
    await expect(verification().approveDocument(doc.id, reviewer.userId)).rejects.toMatchObject({ code: 'MOVER_PROFILE_REQUIRED' });
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('PENDING');
    expect(await app.prisma.reviewDecision.count({ where: { case: { submissionId: doc.id } } })).toBe(0);
  });
  it('keeps stored taxi HIRE requirements after switching to a motorcycle profile', async () => {
    const mover = await fixture();
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { licensePlate: `HBOUND${nanoid(5)}`, vehicleType: 'CAR' } });
    const subject = await app.prisma.$transaction((tx) => resolveSubject(tx, {
      userId: mover.userId, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default',
    }));
    subjects.push(subject!.subjectId);
    const doc = await app.prisma.verificationDocument.create({ data: {
      userId: mover.userId, subjectId: subject!.subjectId, role: 'MOVER', docType: 'vehicle_insurance', status: 'PENDING',
      expiresAt: new Date(Date.now() + DAY), fileUrl: 'storage://synthetic/stored-taxi',
    } });
    await app.prisma.rider.update({ where: { id: mover.riderId }, data: { vehicleType: 'MOTORCYCLE', licensePlate: `MOTOR${nanoid(5)}` } });
    const reviewer = await fixture();
    await expect(verification().approveDocument(doc.id, reviewer.userId)).rejects.toMatchObject({ code: 'INSURANCE_SCOPE_INSUFFICIENT' });
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('PENDING');
  });
  it('rejects a stale exact Driver assignment after a real concurrent plate update', async () => {
    const mover = await fixture();
    const initialDriver = await dual(mover);
    const driver = await app.prisma.driver.update({ where: { id: initialDriver.id }, data: { licensePlate: `HOLD${nanoid(8).replace(/[^a-zA-Z0-9]/g, 'X').toUpperCase()}` } });
    const newMark = `HNEW${nanoid(6).replace(/[^a-zA-Z0-9]/g, 'X').toUpperCase()}`;
    for (const registrationMark of [driver.licensePlate, newMark]) {
      const subject = await app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: mover.userId } });
      subjects.push(subject.id);
      await app.prisma.vehicleProfile.create({ data: { subjectId: subject.id, registrationMark, countryCode: 'GY', vehicleKind: 'CAR', registeredById: mover.userId } });
      await app.prisma.subjectLink.create({ data: { accountId: mover.userId, subjectId: subject.id, relation: 'ASSIGNED_DRIVER' } });
    }
    const peer = new PrismaClient(); const locked = latch(); const release = latch();
    const change = peer.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${mover.userId} FOR UPDATE`;
      locked.resolve(); await release.promise;
      await tx.driver.update({ where: { id: driver.id }, data: { licensePlate: newMark } });
    }, { timeout: 10000 });
    await locked.promise;
    const pending = verification().approveVehicleAssignment(mover.userId, driver);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await app.prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT cardinality(pg_blocking_pids(pid)) > 0 AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
            AND query LIKE '%vehicle-assignment-authority%'`;
        if (rows.some((row) => row.blocked)) { blocked = true; break; }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(blocked).toBe(true);
      release.resolve(); await change;
      await expect(pending).rejects.toMatchObject({ code: 'MOVER_AUTHORITY_CHANGED' });
      expect(await app.prisma.subjectLink.count({ where: { accountId: mover.userId, approvedAt: { not: null } } })).toBe(0);
    } finally { release.resolve(); await change; await peer.$disconnect(); }
  });
  it('keeps a legacy dual-profile vehicle submission unresolved during backfill', async () => {
    const mover = await fixture(); await dual(mover);
    const subject = await app.prisma.$transaction((tx) => resolveSubject(tx, {
      userId: mover.userId, countryCode: 'GY', docType: 'vehicle_registration', tenantId: 'swift-default',
    }));
    expect(subject).toBeNull();
    expect(await app.prisma.subjectLink.count({ where: { accountId: mover.userId } })).toBe(0);
  });

});
