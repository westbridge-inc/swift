/**
 * [DOC-1 §4.3 · P1-2] Subjects — test_every_new_submission_writes_a_subject_link.
 *
 * A submission is evidence about a PERSON, a BUSINESS or a VEHICLE; the account is
 * linked to that subject with a relation. One person subject per account, one business
 * subject per owner, one vehicle subject per registration mark and country (a second
 * driver on the same plate is a second LINK, not a second vehicle). A mover without a
 * plate gets no vehicle subject (DOC-INV-18). Legacy reads are untouched; the backfill
 * fills rows that predate subjects and is idempotent; the tenant wall binds the new
 * tables to the account's tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { resolveSubject, backfillSubjects, linkedAccountIds, normalizeRegistrationMark, plateClassOf, rootSubjectId } from '../modules/verification/subjects';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const PLATE = `HB ${NUM.slice(-4)}`;

let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-subjects-test');

async function person(n: number, role: 'VENDOR_OWNER' | 'MOVER' = 'VENDOR_OWNER') {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59276${NUM}${n}`, firstName: 'Sub', lastName: `Ject${n}`, activeRole: role, roles: [role], countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
const driver = (userId: string, plate: string) => system(() => app.prisma.driver.create({ data: {
  userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Yellow', vehicleType: 'CAR', licensePlate: plate,
  driverLicenseUrl: `/uploads/test/${RUN}-dl.jpg`, vehicleInsuranceUrl: `/uploads/test/${RUN}-ins.jpg`,
} }));
const submit = (userId: string, roleKey: 'RESTAURANT' | 'MOVER', docType: string) =>
  runWithTenant('swift-default', () => service.submitDocument(userId, roleKey, docType, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
const docOf = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { subjectId: true, status: true, state: true, userId: true } }));
const subjectOf = (id: string) => system(() => app.prisma.subject.findUniqueOrThrow({ where: { id }, include: { links: true, person: true, business: true, vehicle: true } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`)))]);
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P1-2] every new submission writes a subject and a link', () => {
  it('a business document names ONE business subject per owner (OWNER link); a personal document names the person (SELF link); each is reused', async () => {
    const u = await person(1);
    const reg = await submit(u, 'RESTAURANT', 'business_registration');
    const tin = await submit(u, 'RESTAURANT', 'tin_certificate');
    const id1 = (await docOf(reg.id)).subjectId!; const id2 = (await docOf(tin.id)).subjectId!;
    expect(id1).toBeTruthy(); expect(id2).toBe(id1);
    const biz = await subjectOf(id1);
    expect(biz).toMatchObject({ kind: 'BUSINESS', countryCode: 'GY', createdById: u, tenantId: 'swift-default' });
    expect(biz.business).toMatchObject({ ownerAccountId: u });
    expect(biz.links.map((l) => [l.accountId, l.relation, l.validTo])).toEqual([[u, 'OWNER', null]]);

    const nid = await submit(u, 'RESTAURANT', 'owner_national_id');
    const pid = (await docOf(nid.id)).subjectId!;
    expect(pid).not.toBe(id1);
    const me = await subjectOf(pid);
    expect(me.kind).toBe('PERSON'); expect(me.person).toMatchObject({ accountId: u });
    expect(me.links.map((l) => l.relation)).toEqual(['SELF']);
    // the same person again → the same subject, still one link
    const again = await submit(u, 'RESTAURANT', 'food_handler_cert');
    expect((await docOf(again.id)).subjectId).toBe(pid);
    expect((await subjectOf(pid)).links).toHaveLength(1);
  });

  it('a vehicle document names the vehicle by its plate; a second driver on the same plate is a second LINK, not a second vehicle; the class is computed', async () => {
    const a = await person(2, 'MOVER'); await driver(a, PLATE);
    const b = await person(3, 'MOVER'); await driver(b, PLATE.toLowerCase().replace(' ', '-'));
    const ins = await submit(a, 'MOVER', 'vehicle_insurance');
    const vid = (await docOf(ins.id)).subjectId!;
    const car = await subjectOf(vid);
    expect(car.kind).toBe('VEHICLE');
    expect(car.vehicle).toMatchObject({ registrationMark: normalizeRegistrationMark(PLATE), countryCode: 'GY', vehicleKind: 'CAR', make: 'Toyota', registeredById: a });
    expect(plateClassOf(car.vehicle!.registrationMark)).toBe('H');
    const reg = await submit(b, 'MOVER', 'vehicle_registration');
    expect((await docOf(reg.id)).subjectId).toBe(vid);
    const links = (await subjectOf(vid)).links.map((l) => [l.accountId, l.relation]).sort();
    expect(links).toEqual([[a, 'ASSIGNED_DRIVER'], [b, 'ASSIGNED_DRIVER']].sort());
    expect((await linkedAccountIds(app.prisma, vid)).sort()).toEqual([a, b].sort());
  });

  it('a mover without a plate gets NO vehicle subject (DOC-INV-18), and the resolver says so instead of inventing one', async () => {
    const u = await person(4, 'MOVER');
    await system(() => app.prisma.rider.create({ data: { userId: u, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } }));
    const r = await system(() => resolveSubject(app.prisma, { userId: u, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default' }));
    expect(r).toBeNull();
    const p = await system(() => resolveSubject(app.prisma, { userId: u, countryCode: 'GY', docType: 'national_id', tenantId: 'swift-default' }));
    expect(p).toMatchObject({ kind: 'PERSON', relation: 'SELF', created: true });
  });

  it('a merged subject resolves to its root', async () => {
    const u = await person(5);
    const first = await system(() => resolveSubject(app.prisma, { userId: u, countryCode: 'GY', docType: 'business_registration', tenantId: 'swift-default' }));
    const root = await system(() => app.prisma.subject.create({ data: { kind: 'BUSINESS', countryCode: 'GY', createdById: u } }));
    await system(() => app.prisma.subject.update({ where: { id: first!.subjectId }, data: { mergedIntoId: root.id } }));
    expect(await system(() => rootSubjectId(app.prisma, first!.subjectId))).toBe(root.id);
    const again = await system(() => resolveSubject(app.prisma, { userId: u, countryCode: 'GY', docType: 'tin_certificate', tenantId: 'swift-default' }));
    expect(again!.subjectId).toBe(root.id);
  });

  it('legacy rows are backfilled, idempotently; a plate-less vehicle document stays unresolved and is counted', async () => {
    const u = await person(6);
    const legacy = await system(() => app.prisma.verificationDocument.createMany({ data: [
      { userId: u, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: `x/${RUN}/1`, status: 'APPROVED' },
      { userId: u, role: 'VENDOR_OWNER', docType: 'owner_national_id', fileUrl: `x/${RUN}/2`, status: 'PENDING' },
    ] }));
    expect(legacy.count).toBe(2);
    const m = await person(7, 'MOVER');
    await system(() => app.prisma.rider.create({ data: { userId: m, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }));
    await system(() => app.prisma.verificationDocument.create({ data: { userId: m, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: `x/${RUN}/3`, status: 'APPROVED' } }));
    const before = await system(() => app.prisma.verificationDocument.count({ where: { userId: { in: [u, m] }, subjectId: null } }));
    expect(before).toBe(3);
    const first = await system(() => backfillSubjects(app.prisma));
    expect(first.resolved).toBeGreaterThanOrEqual(2);
    expect(first.unresolved).toBeGreaterThanOrEqual(1);
    const rows = await system(() => app.prisma.verificationDocument.findMany({ where: { userId: u }, select: { docType: true, subjectId: true } }));
    expect(rows.every((r) => r.subjectId)).toBe(true);
    expect(new Set(rows.map((r) => r.subjectId)).size).toBe(2); // business + person
    expect((await system(() => app.prisma.verificationDocument.findFirst({ where: { userId: m } })))!.subjectId).toBeNull();
    const second = await system(() => backfillSubjects(app.prisma));
    expect(second.resolved).toBe(0);
  });

  it('the tenant wall binds: a link stamped with a foreign tenant is refused by lineage', async () => {
    const u = await person(8);
    const s = await system(() => resolveSubject(app.prisma, { userId: u, countryCode: 'GY', docType: 'business_registration', tenantId: 'swift-default' }));
    await expect(system(() => app.prisma.$executeRawUnsafe(
      `INSERT INTO subject_link ("tenantId", "accountId", "subjectId", relation) VALUES ('another-tenant', $1, $2::uuid, 'DIRECTOR')`, u, s!.subjectId,
    ))).rejects.toThrow(/STA-1 lineage|check_violation|does not exist/);
  });
});
