/**
 * [SEC-TRUST F9] The account that first names a plate registers the vehicle, but naming a plate proves
 * nothing: its ASSIGNED_DRIVER link starts PENDING and is approved only when a PERSON approves one of that
 * account's OWN papers for the vehicle. A rejected paper (by a person or automatically) closes a link that
 * is still pending. And at evidence time, whatever its link says (one approved before this rule included),
 * a registrant counts the vehicle's papers only while it holds a non-revoked paper of its own for the
 * vehicle that a person approved: another account's approved papers never stand in for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { BUCKET_OF, seedDocRegistry } from '../modules/verification/doc-registry';
import { CountryConfigService } from '../modules/country/country-config.service';
import { recordEvidenceFor } from '../modules/verification/evidence';
import { ownedVerificationFixture } from './helpers/verification-object';
import { testPhone } from './helpers/fixture-ids';

let app: FastifyInstance;
let service: VerificationService;
let reviewerId: string;
let countryConfig: CountryConfigService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'vehicle-registrant-review-test');
const plate = () => `HB${nanoid(8).replace(/[^a-z0-9]/gi, '0').toUpperCase()}`;

async function user(role: 'ADMIN' | 'MOVER' = 'MOVER') {
  const row = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Synthetic', lastName: 'Registrant',
    roles: [role], activeRole: role, countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(role === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  users.push(row.id);
  return row.id;
}

async function driverOn(licensePlate: string) {
  const id = await user();
  await system(() => app.prisma.driver.create({ data: {
    userId: id, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018,
    vehicleColor: 'Silver', licensePlate,
    driverLicenseUrl: '/uploads/synthetic-licence', vehicleInsuranceUrl: '/uploads/synthetic-insurance',
  } }));
  return id;
}

const submit = (userId: string, marker = 'manual') => runWithTenant('swift-default', async () =>
  service.submitDocument(userId, 'MOVER', 'vehicle_registration', await ownedVerificationFixture(app.prisma, userId, marker), 'v1'));
const approve = (docId: string) => system(() => service.approveDocument(docId, reviewerId));
const reject = (docId: string) => system(() => service.rejectDocument(docId, reviewerId, 'The registration is not readable.', 'UNREADABLE'));
const subjectOf = async (docId: string) => (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId }, select: { subjectId: true } }))).subjectId!;
const openLinks = (accountId: string, subjectId: string) => system(() => app.prisma.subjectLink.findMany({
  where: { accountId, subjectId, relation: 'ASSIGNED_DRIVER', validTo: null }, select: { id: true, approvedAt: true },
}));
/** An approved paper on file (the decision written as it stands; `approvedBy` = who approved it). */
const approvedPaper = (userId: string, docType: string, approvedBy: string, subjectId: string | null = null) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'MOVER', docType, subjectId, fileUrl: `/uploads/verification/sectrust-f9/${docType}-${nanoid(6)}.enc`, status: 'APPROVED',
  reviewedBy: approvedBy, reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * 86_400_000),
  ...(docType === 'vehicle_insurance' ? { coverageClass: 'HIRE' as const, hireClassConfirmed: true, plateCrossChecked: true } : {}),
} }));
/** The vehicle evidence the go-online gate would count for this account (its own, and its approved links'). */
const vehicleEvidence = (accountId: string) => system(() => recordEvidenceFor(app.prisma, accountId, ['vehicle_registration'], new Date()));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  countryConfig = new CountryConfigService(app.prisma);
  await system(() => seedDocRegistry(app.prisma));
  reviewerId = await user('ADMIN');
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((doc) => doc.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } }).catch(() => {});
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } }).catch(() => {});
    await app.prisma.verificationDecisionOutbox.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[SEC-TRUST F9] the vehicle registrant is reviewed like every other assignment', () => {
  it('the first account to name a plate gets a PENDING link, and a rejected paper leaves it nothing: it never counts the real owner’s approved papers', async () => {
    const P = plate();
    const first = await driverOn(P);
    const junk = await submit(first);
    const vehicle = await subjectOf(junk.id);
    expect((await openLinks(first, vehicle)).map((l) => l.approvedAt)).toEqual([null]);
    await reject(junk.id);
    expect(await openLinks(first, vehicle)).toEqual([]);

    // The car's real owner later files genuine papers, which a person approves.
    const owner = await driverOn(P);
    const genuine = await submit(owner);
    expect(await subjectOf(genuine.id)).toBe(vehicle);
    expect(await approve(genuine.id)).toMatchObject({ status: 'APPROVED', state: 'COMMITTED' });

    // The first account counts none of them.
    expect(await vehicleEvidence(first)).toEqual([]);
  });

  it('an automatic approval does not approve the registrant: its first paper waits for a person', async () => {
    const first = await driverOn(plate());
    const doc = await submit(first, 'auto-approve');
    expect(doc.status).toBe('PENDING');
    const vehicle = await subjectOf(doc.id);
    expect((await openLinks(first, vehicle)).map((l) => l.approvedAt)).toEqual([null]);
    expect(await vehicleEvidence(first)).toEqual([]);
  });

  it('an automatic rejection closes the registrant’s pending link', async () => {
    const first = await driverOn(plate());
    const doc = await submit(first, 'auto-reject');
    expect(doc.status).toBe('REJECTED');
    expect(await openLinks(first, await subjectOf(doc.id))).toEqual([]);
  });

  it('a person approving the registrant’s own paper approves its link, even after an earlier rejection closed it', async () => {
    const first = await driverOn(plate());
    const blurry = await submit(first);
    const vehicle = await subjectOf(blurry.id);
    await reject(blurry.id);
    expect(await openLinks(first, vehicle)).toEqual([]);
    const clear = await submit(first);
    expect((await openLinks(first, vehicle)).map((l) => l.approvedAt)).toEqual([null]);
    await approve(clear.id);
    const links = await openLinks(first, vehicle);
    expect(links).toHaveLength(1);
    expect(links[0]!.approvedAt).not.toBeNull();
    expect((await vehicleEvidence(first)).map((row) => row.docType)).toEqual(['vehicle_registration']);
  });

  it('a rejection closes the pending link while another paper waits; a person approving that paper opens an approved link', async () => {
    const first = await driverOn(plate());
    const registration = await submit(first);
    const vehicle = await subjectOf(registration.id);
    const insurance = await runWithTenant('swift-default', async () =>
      service.submitDocument(first, 'MOVER', 'vehicle_insurance', await ownedVerificationFixture(app.prisma, first), 'v1'));
    expect(await subjectOf(insurance.id)).toBe(vehicle);
    await reject(insurance.id);
    expect(await openLinks(first, vehicle)).toEqual([]);
    await approve(registration.id);
    const links = await openLinks(first, vehicle);
    expect(links).toHaveLength(1);
    expect(links[0]!.approvedAt).not.toBeNull();
  });

  it('a registrant approved before this rule counts another account’s approved papers only once a person has approved a paper of its own (go-online gate)', async () => {
    const checklist = await countryConfig.getMoverChecklist('GY', 'CAR');
    const vehicleTypes = checklist.filter((t) => BUCKET_OF[t] === 'VEHICLE');
    const personalTypes = checklist.filter((t) => BUCKET_OF[t] !== 'VEHICLE');
    expect(vehicleTypes).toContain('vehicle_insurance');
    const P = plate();
    const first = await driverOn(P);
    // The shape an account registered before this rule may carry: the vehicle on its name, an approved
    // link, and no paper of its own that a person approved.
    const vehicle = await system(async () => {
      const subject = await app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById: first } });
      await app.prisma.vehicleProfile.create({ data: { subjectId: subject.id, countryCode: 'GY', registrationMark: P, vehicleKind: 'CAR', registeredById: first } });
      await app.prisma.subjectLink.create({ data: { accountId: first, subjectId: subject.id, relation: 'ASSIGNED_DRIVER', approvedAt: new Date() } });
      return subject.id;
    });
    for (const t of personalTypes) await approvedPaper(first, t, reviewerId);
    // Another account's papers for the car, approved by a person.
    const owner = await driverOn(P);
    for (const t of vehicleTypes) await approvedPaper(owner, t, reviewerId, vehicle);

    const gate = () => system(() => service.getLiveOperationStatus(first, { vehicleType: 'CAR' }));
    expect((await gate()).allowed).toBe(false);
    expect((await vehicleEvidence(first)).filter((row) => row.userId === owner)).toEqual([]);

    // Papers of its own that only an engine approved are not a person's check.
    for (const t of vehicleTypes) await approvedPaper(first, t, 'kyc:auto', vehicle);
    expect((await gate()).allowed).toBe(false);

    // A paper of its own that a person approved: the vehicle's papers count for it.
    await approvedPaper(first, 'vehicle_registration', reviewerId, vehicle);
    expect((await gate()).allowed).toBe(true);
    expect((await vehicleEvidence(first)).some((row) => row.userId === owner)).toBe(true);
  });

  it('a registrant whose own paper a person approved keeps its link when another account’s papers are approved', async () => {
    const P = plate();
    const first = await driverOn(P);
    const own = await submit(first);
    const vehicle = await subjectOf(own.id);
    await approve(own.id);
    const before = await openLinks(first, vehicle);
    expect(before[0]!.approvedAt).not.toBeNull();

    const second = await driverOn(P);
    const theirs = await submit(second);
    await approve(theirs.id);

    const after = await openLinks(first, vehicle);
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(after[0]!.approvedAt).not.toBeNull();
  });
});
