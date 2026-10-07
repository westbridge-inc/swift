import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

let app: FastifyInstance;
let service: VerificationService;
let reviewerId: string;
const users: string[] = [];
const phoneBase = 592_020_000_000 + Math.floor(Math.random() * 900_000);
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
