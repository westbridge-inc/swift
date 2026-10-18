import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { PartnerService } from '../modules/partner/partner.service';
import { evaluateMoverDocuments } from '../modules/verification/mover-document-authority';
import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

// ---------------------------------------------------------------------------
// [Owner ruling 11 Oct 2026 — H-PLATE: KEEP · Opus review 12 Oct S3 follow-ups]
// (1) The go-online taxi gate checks the plate too: a car or wagon car without an
//     H-series plate never works as a taxi, whatever papers were approved before
//     (defence in depth beside the approval check).
// (2) A mover who switches a vehicle to the other kind of work on the SAME plate
//     (motorbike -> car -> motorbike) no longer leaves that plate on the retired
//     profile, so the vehicle they really use decides their later papers instead
//     of a car they no longer drive.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let service: VerificationService;
let reviewerId: string;
const users: string[] = [];
// One file, one block: +592097nnnnnn.
const phoneBase = 592_097_000_000 + Math.floor(Math.random() * 900_000);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'taxi-plate-gate-test');
const plate = (prefix: string) => `${prefix}${nanoid(6).replace(/[^a-z0-9]/gi, '0').toUpperCase()}`;

async function user(role: 'ADMIN' | 'MOVER' = 'MOVER') {
  const row = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Plate',
    roles: role === 'ADMIN' ? ['ADMIN'] : ['MOVER', 'CUSTOMER'], activeRole: role, countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
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

const driverCar = (userId: string, licensePlate: string) => app.prisma.driver.create({ data: {
  userId, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver', licensePlate,
  driverLicenseUrl: '/uploads/synthetic-licence', vehicleInsuranceUrl: '/uploads/synthetic-insurance',
} });

describe('(1) the go-online taxi gate checks the plate class', () => {
  it('a car without an H-series plate is refused before any paper is weighed; an H plate goes on to the paper checks', async () => {
    // [VERIFY-DOCS · ruling 8] Both drivers hold the two hire licences a taxi now needs (the legacy flag cannot
    // supply them), so the plate and then the hire insurance are what decide.
    const privatePlate = await system(async () => { const u = await user(); await driverCar(u.id, plate('PAG')); await currentTaxiSplitDocuments(app.prisma, u.id); return u; });
    // Legacy grant on, the two licences on file: the plate alone refuses it, as documents.
    expect(await system(() => evaluateMoverDocuments(app.prisma, privatePlate.id, { kind: 'DRIVER', vehicleType: 'CAR', legacyVerified: true })))
      .toEqual({ allowed: false, reason: 'docs', validUntil: null });
    const hirePlate = await system(async () => { const u = await user(); await driverCar(u.id, plate('HG')); await currentTaxiSplitDocuments(app.prisma, u.id); return u; });
    // Same papers, H plate: the plate passes and the hire-insurance check is what refuses.
    expect(await system(() => evaluateMoverDocuments(app.prisma, hirePlate.id, { kind: 'DRIVER', vehicleType: 'CAR', legacyVerified: true })))
      .toEqual({ allowed: false, reason: 'insurance', validUntil: null });
  });

  it('a delivery rider is never judged by plate class', async () => {
    const rider = await system(async () => {
      const u = await user();
      await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', licensePlate: plate('PMG') } });
      return u;
    });
    const verdict = await system(() => evaluateMoverDocuments(app.prisma, rider.id, { kind: 'RIDER', vehicleType: 'MOTORCYCLE', legacyVerified: true }));
    expect(verdict.reason).not.toBe('insurance');
    expect(verdict.allowed).toBe(true);
  });
});

describe('(2) switching back on the same plate leaves no retired car on it', () => {
  it('motorbike -> car -> motorbike on one plate: the retired car keeps no plate, the stored vehicle follows, and the motorbike insurance is judged as a motorbike', async () => {
    const p1 = plate('HS');
    const mover = await system(async () => {
      const u = await user();
      await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', licensePlate: p1 } });
      await app.prisma.user.update({ where: { id: u.id }, data: { roles: ['MOVER', 'RIDER', 'CUSTOMER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' } });
      return u;
    });
    const partners = new PartnerService(app.prisma);
    const vehicle = { make: 'Synthetic', model: 'Vehicle', year: 2019, color: 'Blue', licensePlate: p1 };
    await system(() => partners.changeVehicleWithAuthority(mover.id, { vehicleType: 'CAR', vehicle }, async (tx) => {
      await tx.user.update({ where: { id: mover.id }, data: { activeRole: 'DRIVER', lastMoverRole: 'DRIVER', roles: ['MOVER', 'RIDER', 'DRIVER', 'CUSTOMER'] } });
      return null;
    }));
    // The motorbike profile no longer carries the plate the car now uses.
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { userId: mover.id } })).licensePlate).toBeNull();
    await system(() => partners.changeVehicleWithAuthority(mover.id, { vehicleType: 'MOTORCYCLE', vehicle }, async (tx) => {
      await tx.user.update({ where: { id: mover.id }, data: { activeRole: 'RIDER', lastMoverRole: 'RIDER' } });
      return null;
    }));
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { userId: mover.id } })).licensePlate).toBe('');
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { userId: mover.id } })).licensePlate).toBe(p1);

    // The motorbike's insurance, bound to its plate, is judged as a motorbike's: [R13] a delivery vehicle's policy
    // must permit use for hire or reward (commercial use), not carry passengers for hire as a taxi's must.
    const doc = await system(async () => {
      // The vehicle record the car step registered on that plate now says what the mover uses: a motorbike.
      const stored = await app.prisma.vehicleProfile.findUniqueOrThrow({ where: { registrationMark_countryCode: { registrationMark: p1, countryCode: 'GY' } } });
      expect(stored.vehicleKind).toBe('MOTORCYCLE');
      await app.prisma.subjectLink.updateMany({ where: { accountId: mover.id, subjectId: stored.subjectId }, data: { approvedAt: new Date(), validTo: null } });
      return app.prisma.verificationDocument.create({ data: {
        userId: mover.id, subjectId: stored.subjectId, role: 'MOVER', docType: 'vehicle_insurance', status: 'PENDING',
        expiresAt: new Date(Date.now() + 100 * 86_400_000), fileUrl: `/uploads/verification/synthetic-${nanoid()}.enc`,
      } });
    });
    await expect(system(() => service.approveDocument(doc.id, reviewerId, undefined, {
      insurerName: 'Synthetic Insurer', policyNumber: 'SYN-0001', coverageClass: 'PRIVATE', hireClassConfirmed: false, plateCrossChecked: true,
    }))).rejects.toThrow(/a motor vehicle that delivers needs insurance that permits use for hire or reward \(commercial use\)/i);
    const approved = await system(() => service.approveDocument(doc.id, reviewerId, undefined, {
      insurerName: 'Synthetic Insurer', policyNumber: 'SYN-0001', coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true,
    }));
    expect(approved).toMatchObject({ status: 'APPROVED' });
  });

  it('a car re-declared as a wagon car on the same plate keeps its plate (same kind of work)', async () => {
    const p2 = plate('HW');
    const mover = await system(async () => {
      const u = await user();
      await driverCar(u.id, p2);
      await app.prisma.user.update({ where: { id: u.id }, data: { roles: ['MOVER', 'DRIVER', 'CUSTOMER'], activeRole: 'DRIVER', lastMoverRole: 'DRIVER' } });
      return u;
    });
    await system(() => new PartnerService(app.prisma).changeVehicleWithAuthority(mover.id, { vehicleType: 'WAGON_CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: p2 } }, async () => null));
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { userId: mover.id } })).licensePlate).toBe(p2);
  });
});
