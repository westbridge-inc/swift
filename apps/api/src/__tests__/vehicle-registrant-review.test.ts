/**
 * [SEC-TRUST F9] The account that first names a plate registers the vehicle, but naming a plate proves
 * nothing: its ASSIGNED_DRIVER link starts PENDING and is approved only when a PERSON approves one of that
 * account's OWN papers for the vehicle. A rejected paper (by a person or automatically) closes a link that
 * is still pending. When a person approves ANOTHER account's papers for the vehicle, a registrant whose
 * approved link stands on no person-approved paper of its own goes back to pending for a re-check, and the
 * operators are told; a registrant with one keeps its link.
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
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { recordEvidenceFor } from '../modules/verification/evidence';
import { ownedVerificationFixture } from './helpers/verification-object';
import { testPhone } from './helpers/fixture-ids';

let app: FastifyInstance;
let service: VerificationService;
let reviewerId: string;
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

  it('another account’s approved papers send a registrant with no person-approved paper of its own back to pending, and the operators are told', async () => {
    const P = plate();
    const first = await driverOn(P);
    const junk = await submit(first);
    const vehicle = await subjectOf(junk.id);
    // The shape an account registered before this rule may carry: an approved link and no paper a person approved.
    await system(() => app.prisma.subjectLink.updateMany({ where: { accountId: first, subjectId: vehicle, validTo: null }, data: { approvedAt: new Date() } }));
    await system(() => app.prisma.verificationDocument.update({ where: { id: junk.id }, data: { status: 'REJECTED', reviewedBy: 'kyc:auto', reviewedAt: new Date() } }));

    const owner = await driverOn(P);
    const genuine = await submit(owner);
    await approve(genuine.id);

    expect((await openLinks(first, vehicle)).map((l) => l.approvedAt)).toEqual([null]);
    expect(await vehicleEvidence(first)).toEqual([]);
    const told = await system(() => app.prisma.notification.count({
      where: { userId: reviewerId, data: { path: ['kind'], equals: 'verification_vehicle_registrant_recheck' } },
    }));
    expect(told).toBeGreaterThanOrEqual(1);
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
