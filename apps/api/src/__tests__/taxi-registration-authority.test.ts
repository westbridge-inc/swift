import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ownedVerificationFixture } from './helpers/verification-object';
import { PartnerService } from '../modules/partner/partner.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

let app: FastifyInstance;
let service: VerificationService;
let reviewerId: string;
const users: string[] = [];
const phoneBase = 592_096_000_000 + Math.floor(Math.random() * 900_000);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'taxi-registration-authority-test');

async function user(role: 'ADMIN' | 'MOVER' = 'MOVER') {
  const row = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Review',
    roles: [role], activeRole: role, countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(role === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}),
  } });
  users.push(row.id);
  return row;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  reviewerId = (await system(() => user('ADMIN'))).id;
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((doc) => doc.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

async function pending(profilePlate: string, storedPlate: string | null, delivery = false) {
  return system(async () => {
    const applicant = await user();
    if (delivery) await app.prisma.rider.create({ data: {
      userId: applicant.id, riderType: 'DELIVERY', vehicleType: 'CAR', licensePlate: profilePlate,
    } });
    else await app.prisma.driver.create({ data: {
      userId: applicant.id, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018,
      vehicleColor: 'Silver', licensePlate: profilePlate,
      driverLicenseUrl: '/uploads/synthetic-licence', vehicleInsuranceUrl: '/uploads/synthetic-insurance',
    } });
    let subjectId: string | null = null;
    if (storedPlate !== null) {
      const subject = await app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: applicant.id } });
      subjectId = subject.id;
      await app.prisma.vehicleProfile.create({ data: {
        subjectId, countryCode: 'GY', registrationMark: storedPlate, vehicleKind: 'CAR', registeredById: applicant.id,
      } });
      await app.prisma.subjectLink.create({ data: { accountId: applicant.id, subjectId, relation: 'ASSIGNED_DRIVER', approvedAt: new Date() } });
    }
    return app.prisma.verificationDocument.create({ data: {
      userId: applicant.id, subjectId, role: 'MOVER', docType: 'vehicle_registration', status: 'PENDING',
      expiresAt: new Date(Date.now() + 100 * 86_400_000),
      fileUrl: `/uploads/verification/synthetic-${nanoid()}.enc`,
    } });
  });
}

async function refused(docId: string, code: string) {
  await expect(system(() => service.approveDocument(docId, reviewerId))).rejects.toMatchObject({ code });
  expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } })).toMatchObject({ status: 'PENDING' });
  expect(await app.prisma.reviewDecision.count({ where: { case: { submissionId: docId } } })).toBe(0);
}

describe('taxi approval uses the stored registration subject', () => {
  it.each(['HB123456', ''])('refuses an unbound legacy taxi document despite profile plate %j', async (plate) => {
    const doc = await pending(plate, null);
    await refused(doc.id, 'VEHICLE_SUBJECT_REQUIRED');
  });
  it.each(['', ' -- '])('refuses a missing registered plate %j even with an H profile plate', async (plate) => {
    const doc = await pending('HB654321', plate);
    await refused(doc.id, 'WRONG_PLATE_CLASS');
  });
  it('an H profile plate cannot override a stored private registration', async () => {
    const doc = await pending('HB111111', 'PAB111111');
    await refused(doc.id, 'WRONG_PLATE_CLASS');
  });
  it.each(['PAB222222', ''])('approves a valid stored H registration regardless of profile plate %j', async (plate) => {
    const doc = await pending(plate, `HB${nanoid(8).replace(/[^a-z0-9]/gi, '0').toUpperCase()}`);
    expect(await system(() => service.approveDocument(doc.id, reviewerId))).toMatchObject({ status: 'APPROVED', state: 'COMMITTED' });
    expect(await app.prisma.reviewDecision.count({ where: { case: { submissionId: doc.id }, outcome: 'APPROVE' } })).toBe(1);
  });
  it('preserves the non-taxi legacy delivery exemption', async () => {
    const doc = await pending('PAB333333', null, true);
    expect(await system(() => service.approveDocument(doc.id, reviewerId))).toMatchObject({ status: 'APPROVED' });
  });
});

describe('every taxi approval path checks stored vehicle authority', () => {
  it('a motorbike-to-car change with the same private plate cannot approve the old motorbike subject', async () => {
    const doc = await pending('PAB444444', 'PAB444444');
    await system(async () => {
      await app.prisma.driver.delete({ where: { userId: doc.userId } });
      await app.prisma.rider.create({ data: { userId: doc.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', licensePlate: 'PAB444444' } });
      await app.prisma.user.update({ where: { id: doc.userId }, data: { lastMoverRole: 'RIDER' } });
      await app.prisma.vehicleProfile.update({ where: { subjectId: doc.subjectId! }, data: { vehicleKind: 'MOTORCYCLE' } });
      await new PartnerService(app.prisma).changeVehicleWithAuthority(doc.userId, { vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: 'PAB444444' } }, async (tx) => {
        await tx.user.update({ where: { id: doc.userId }, data: { activeRole: 'DRIVER', lastMoverRole: 'DRIVER', roles: ['MOVER', 'RIDER', 'DRIVER'] } });
        return null;
      });
    });
    // [#1551] The vehicle change withdrew the paper that was awaiting review: it can never be approved.
    await expect(system(() => service.approveDocument(doc.id, reviewerId))).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ state: 'EXPIRED' });
    // A fresh submission is taken (no dead end), but automatic processing never approves it, and the
    // car now in use on that plate is a taxi: its private plate is refused for the reason that matters.
    const fileKey = await system(() => ownedVerificationFixture(app.prisma, doc.userId, 'auto-approve'));
    const again = await system(() => service.submitDocument(doc.userId, 'MOVER', 'vehicle_registration', fileKey, 'test-v1', 'DRIVER'));
    expect(again.status).toBe('PENDING');
    await refused(again.id, 'WRONG_PLATE_CLASS');
  });
  it('a car corrected to a wagon car on the same H plate can still submit and be approved', async () => {
    const plate = `HC${nanoid(6).replace(/[^a-z0-9]/gi, '0').toUpperCase()}`;
    const doc = await pending(plate, plate);
    await system(() => new PartnerService(app.prisma).changeVehicleWithAuthority(doc.userId, { vehicleType: 'WAGON_CAR', vehicle: { make: 'Toyota', model: 'Fielder', year: 2018, color: 'Silver', licensePlate: plate } }, async () => null));
    const fileKey = await system(() => ownedVerificationFixture(app.prisma, doc.userId));
    const again = await system(() => service.submitDocument(doc.userId, 'MOVER', 'vehicle_registration', fileKey, 'test-v1'));
    expect(again.subjectId).toBe(doc.subjectId);
    if (again.status === 'PENDING') {
      // (The printed date a reviewer keys; the class question is what this case is about.)
      expect(await system(() => service.approveDocument(again.id, reviewerId, new Date(Date.now() + 300 * 86_400_000)))).toMatchObject({ status: 'APPROVED', state: 'COMMITTED' });
    } else {
      expect(again.status).toBe('APPROVED');
    }
  });
  it.each(['PAB555555', ''])('automatic processing never approves taxi registration with stored mark %j', async (plate) => {
    const applicant = await system(() => user());
    await system(() => app.prisma.driver.create({ data: { userId: applicant.id, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver', licensePlate: plate, driverLicenseUrl: '/uploads/synthetic-licence', vehicleInsuranceUrl: '/uploads/synthetic-insurance' } }));
    const fileKey = await system(() => ownedVerificationFixture(app.prisma, applicant.id, 'auto-approve'));
    const doc = await system(() => service.submitDocument(applicant.id, 'MOVER', 'vehicle_registration', fileKey, 'test-v1'));
    expect(doc.status).toBe('PENDING');
    expect(doc.state).toBe('REVIEW_QUEUED');
  });
  it('bound delivery motorbike evidence keeps the non-taxi exemption', async () => {
    const doc = await pending('PAB666666', 'PAB666666', true);
    await system(async () => {
      await app.prisma.rider.update({ where: { userId: doc.userId }, data: { vehicleType: 'MOTORCYCLE' } });
      await app.prisma.vehicleProfile.update({ where: { subjectId: doc.subjectId! }, data: { vehicleKind: 'MOTORCYCLE' } });
    });
    expect(await system(() => service.approveDocument(doc.id, reviewerId))).toMatchObject({ status: 'APPROVED' });
  });
});
