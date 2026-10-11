import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { ownedVerificationFixture } from './helpers/verification-object';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { resolveSubject } from '../modules/verification/subjects';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { evaluateMoverDocuments } from '../modules/verification/mover-document-authority';
import { captureSubmissionAuthority } from '../modules/verification/submission-authority';
import { grantStepUp } from './helpers/step-up';

let app: FastifyInstance;
const users: string[] = [];
const phoneBase = 592_018_000_000 + Math.floor(Math.random() * 900_000);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'vehicle-identity-lock-test');
const identity = { vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver' };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    const ids = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map(d => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: ids } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

async function fixture(kind: 'driver' | 'rider') {
  return system(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Mover',
      roles: ['MOVER'], activeRole: 'MOVER', countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
    } });
    users.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid() });
    const session = await app.prisma.session.create({ data: {
      userId: user.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    } });
    const licensePlate = `HB${nanoid(10).replace(/[^a-z0-9]/gi, '0').toUpperCase()}`;
    const common = { userId: user.id, ...identity, licensePlate, vehicleType: 'CAR' as const,
      documentsVerified: true, isOnline: true, locationSessionId: session.id };
    if (kind === 'driver') await app.prisma.driver.create({ data: {
      ...common, driverLicenseUrl: '/uploads/synthetic-licence', vehicleInsuranceUrl: '/uploads/synthetic-insurance',
      documentsVerifiedAt: new Date(), documentsVerifiedBy: 'synthetic-reviewer',
    } });
    else await app.prisma.rider.create({ data: { ...common, riderType: 'DELIVERY', documentsVerifiedAt: new Date(), documentsVerifiedBy: 'synthetic-reviewer' } });
    const subject = await app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: user.id } });
    await app.prisma.vehicleProfile.create({ data: {
      subjectId: subject.id, registrationMark: licensePlate, countryCode: 'GY', vehicleKind: 'CAR', registeredById: user.id,
      make: identity.vehicleMake, model: identity.vehicleModel, year: identity.vehicleYear, colour: identity.vehicleColor,
    } });
    const link = await app.prisma.subjectLink.create({ data: {
      accountId: user.id, subjectId: subject.id, relation: 'ASSIGNED_DRIVER', approvedAt: new Date(),
    } });
    return { userId: user.id, token, licensePlate, linkId: link.id, subjectId: subject.id };
  });
}

function save(kind: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: `/api/v1/${kind}/profile`, payload,
    headers: { authorization: `Bearer ${token}` } });
}
const read = (kind: 'driver' | 'rider', userId: string) => kind === 'driver'
  ? app.prisma.driver.findUniqueOrThrow({ where: { userId } })
  : app.prisma.rider.findUniqueOrThrow({ where: { userId } });

describe.each(['driver', 'rider'] as const)('%s vehicle identity changes require review', (kind) => {
  it.each([
    ['vehicleMake', 'Honda'], ['vehicleModel', 'Civic'], ['vehicleYear', 2020],
    ['vehicleColor', 'Blue'], ['licensePlate', 'HC000001'],
  ])('%s: requires step-up, retires supply and closes the old approval link', async (field, value) => {
    const mover = await fixture(kind);
    const body = { [field as string]: value };
    const refused = await save(kind, mover.token, body);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await read(kind, mover.userId)).toMatchObject({ ...identity, licensePlate: mover.licensePlate,
      isOnline: true, documentsVerified: true });
    expect((await app.prisma.subjectLink.findUniqueOrThrow({ where: { id: mover.linkId } })).validTo).toBeNull();

    await grantStepUp(app, mover.token);
    const saved = await save(kind, mover.token, body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ ...body, isOnline: false, documentsVerified: false, locationSessionId: null });
    const profile = await read(kind, mover.userId);
    expect(profile).toMatchObject({ ...body, isOnline: false, documentsVerified: false, locationSessionId: null });
    if ('documentsVerifiedAt' in profile) {
      expect(profile.documentsVerifiedAt).toBeNull();
      expect(profile.documentsVerifiedBy).toBeNull();
    }
    expect((await app.prisma.subjectLink.findUniqueOrThrow({ where: { id: mover.linkId } })).validTo).toBeInstanceOf(Date);
  });

  it('a full save with unchanged identity, including formatting, retains approval without step-up', async () => {
    const mover = await fixture(kind);
    const saved = await save(kind, mover.token, { ...identity,
      vehicleMake: ' toyota ', vehicleModel: ' ALLION ', vehicleColor: ' silver ',
      licensePlate: mover.licensePlate.toLowerCase().replace('hb', 'hb-'),
    });
    expect(saved.statusCode).toBe(200);
    expect(await read(kind, mover.userId)).toMatchObject({ isOnline: true, documentsVerified: true });
    expect((await app.prisma.subjectLink.findUniqueOrThrow({ where: { id: mover.linkId } })).validTo).toBeNull();
  });

  it('an unrelated profile save retains the vehicle approval', async () => {
    const mover = await fixture(kind);
    expect((await save(kind, mover.token, { profilePhotoUrl: '/uploads/synthetic-avatar' })).statusCode).toBe(200);
    expect(await read(kind, mover.userId)).toMatchObject({ isOnline: true, documentsVerified: true });
    expect((await app.prisma.subjectLink.findUniqueOrThrow({ where: { id: mover.linkId } })).validTo).toBeNull();
  });
});

async function paper(userId: string, subjectId: string | null, days = 100) {
 return system(() => app.prisma.verificationDocument.create({ data: { userId, subjectId, role: 'MOVER', docType: 'vehicle_registration', fileUrl: `/uploads/verification/identity-${nanoid()}.enc`, status: 'APPROVED', reviewedBy: 'synthetic-reviewer', reviewedAt: new Date(), expiresAt: new Date(Date.now() + days * 86400000) } }));
}
const verification = () => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
describe('vehicle edit evidence lifecycle', () => {
 it.each(['driver','rider'] as const)('%s retires legacy unbound evidence and permits replacement review', async kind => {
  const mover = await fixture(kind);
  const old = await paper(mover.userId, null);
  await grantStepUp(app, mover.token);
  expect((await save(kind, mover.token, { vehicleModel: 'Civic' })).statusCode).toBe(200);
  expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'SUPERSEDED' });
  const result = await system(() => evaluateMoverDocuments(app.prisma, mover.userId, { kind: kind === 'driver' ? 'DRIVER' : 'RIDER', vehicleType: 'CAR', legacyVerified: false }));
  expect(result.allowed).toBe(false);
  const fileKey = await system(() => ownedVerificationFixture(app.prisma, mover.userId));
  const uploaded = await system(() => verification().submitDocument(mover.userId, 'MOVER', 'vehicle_registration', fileKey, 'test-v1'));
  expect(uploaded).toMatchObject({ status: 'PENDING', state: 'REVIEW_QUEUED' });
  expect(await app.prisma.reviewCase.count({ where: { submissionId: uploaded.id, closedAt: null } })).toBe(1);
  const reviewer = await system(() => app.prisma.user.create({ data: { phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', admin: { create: { permissions: ['*'] } } } }));
  users.push(reviewer.id);
  await system(() => verification().approveDocument(uploaded.id, reviewer.id, new Date(Date.now() + 100 * 86400000)));
  expect(await app.prisma.subjectLink.count({ where: { accountId: mover.userId, validTo: null, approvedAt: { not: null } } })).toBe(1);
 });
 it('pending renewal never restores a closed owner approval', async () => {
  const mover = await fixture('driver'); await paper(mover.userId, mover.subjectId, 20);
  await grantStepUp(app, mover.token); await save('driver', mover.token, { vehicleColor: 'Blue' });
  await system(async () => {
   const authority = await captureSubmissionAuthority(app.prisma, mover.userId);
   await resolveSubject(app.prisma, { userId: mover.userId, countryCode: 'GY', tenantId: (await app.prisma.user.findUniqueOrThrow({ where: { id: mover.userId } })).tenantId, docType: 'vehicle_registration', vehicleProfile: authority.profile });
  });
  expect(await app.prisma.subjectLink.count({ where: { accountId: mover.userId, subjectId: mover.subjectId, validTo: null, approvedAt: { not: null } } })).toBe(0);
 });
 it('the app vehicle writer retires same-plate detail evidence too', async () => {
  const mover = await fixture('driver'); const old = await paper(mover.userId, mover.subjectId);
  await grantStepUp(app, mover.token);
  const result = await app.inject({ method: 'PUT', url: '/api/v1/partner/vehicle', headers: { authorization: `Bearer ${mover.token}` }, payload: { vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Blue', licensePlate: mover.licensePlate } } });
  expect(result.statusCode, result.body).toBe(200);
  expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'SUPERSEDED' });
  expect((await app.prisma.subjectLink.findUniqueOrThrow({ where: { id: mover.linkId } })).validTo).toBeInstanceOf(Date);
 });
 it.each(['driver','rider'] as const)('%s refuses an identity edit while working', async kind => {
  const mover = await fixture(kind);
  await system(async () => {
    if (kind === 'driver') await app.prisma.driver.update({ where: { userId: mover.userId }, data: { currentRideId: 'synthetic-active-ride' } });
    else await app.prisma.rider.update({ where: { userId: mover.userId }, data: { currentOrderId: 'synthetic-active-order' } });
  });
  await grantStepUp(app, mover.token);
  const result = await save(kind, mover.token, { vehicleColor: 'Blue' });
  expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('ACTIVE_WORK');
  expect(await read(kind, mover.userId)).toMatchObject({ vehicleColor: 'Silver', isOnline: true });
 });
});
