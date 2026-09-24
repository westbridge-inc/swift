/**
 * [DOC-1 §3.11 · P3-4 · E2E-DOC-3] test_vehicle_doc_expiry_suspends_all_linked_drivers
 *
 * A fleet owner's car carries the vehicle documents; three drivers are linked to the
 * car (ASSIGNED_DRIVER) and hold only their personal documents. Each driver is
 * verified THROUGH the vehicle's evidence. When the car's insurance expires, ONE sweep
 * pulls all three offline, tells each of them which document on which plate, and tells
 * the owner once. A second sweep tells nobody twice. Revocation propagates the same way.
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
import { CountryConfigService } from '../modules/country/country-config.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, BUCKET_OF } from '../modules/verification/doc-registry';
import { resolveSubject } from '../modules/verification/subjects';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';
import { syntheticLocationOwner } from './helpers/online-mover';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const PLATE = `HC${NUM.slice(-4)}`;
const DAY = 86_400_000;

let app: FastifyInstance;
let service: VerificationService;
let countryConfig: CountryConfigService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-fleet-test');

async function mover(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59277${NUM}${n}`, firstName: 'Fleet', lastName: `Driver${n}`, activeRole: 'MOVER', roles: ['MOVER'], countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  await system(() => app.prisma.driver.create({ data: {
    userId: u.id, vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2018, vehicleColor: 'Yellow', vehicleType: 'CAR', licensePlate: PLATE,
    driverLicenseUrl: `/uploads/test/${RUN}-dl.jpg`, vehicleInsuranceUrl: `/uploads/test/${RUN}-ins.jpg`, isOnline: true, documentsVerified: false,
    locationSessionId: syntheticLocationOwner('fleet-test'), // an online driver owns a location session (CHECK drivers_online_requires_location_owner)
  } }));
  return u.id;
}
async function riderMover(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+5920078${NUM}${n}`, firstName: 'Rider', lastName: `Fleet${n}`, activeRole: 'MOVER', roles: ['MOVER'], countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  await system(() => app.prisma.rider.create({ data: {
    userId: u.id, riderType: 'DELIVERY', vehicleType: 'CAR',
  } }));
  return u.id;
}
const approved = (userId: string, docType: string, extra: Record<string, unknown> = {}) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/${RUN}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'fleet-test', reviewedAt: new Date(),
  expiresAt: new Date(Date.now() + 200 * DAY), ...extra,
} }));
const online = (userId: string) => system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId }, select: { isOnline: true } })).then((d) => d.isOnline);
const notices = (userId: string, kind: string) => system(() => app.prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: kind } }, orderBy: { createdAt: 'asc' } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`)))]);
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  countryConfig = new CountryConfigService(app.prisma);
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

describe('[DOC-1 P3-4] a vehicle document lapse reaches every driver assigned to the vehicle', () => {
  it('E2E-DOC-3: insurance expires → all three drivers offline in one sweep, each told the plate and document, the owner told once; a second sweep tells nobody twice; revocation propagates too', async () => {
    const checklist = await countryConfig.getMoverChecklist('GY', 'CAR');
    const vehicleTypes = checklist.filter((t) => BUCKET_OF[t] === 'VEHICLE');
    const personalTypes = checklist.filter((t) => BUCKET_OF[t] !== 'VEHICLE');
    expect(vehicleTypes).toContain('vehicle_insurance');

    // The owner registers the car: its subject exists once, with an OWNER link, and carries every vehicle document.
    const owner = await mover(1);
    const car = (await system(() => resolveSubject(app.prisma, { userId: owner, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default' })))!;
    await system(() => app.prisma.subjectLink.create({ data: { accountId: owner, subjectId: car.subjectId, relation: 'OWNER', tenantId: 'swift-default' } }));
    for (const t of personalTypes) await approved(owner, t);
    let insuranceId = '';
    for (const t of vehicleTypes) {
      const d = await approved(owner, t, { subjectId: car.subjectId, ...(t === 'vehicle_insurance' ? { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } : {}) });
      if (t === 'vehicle_insurance') insuranceId = d.id;
    }

    // Three drivers: personal documents of their own, the car's documents only through the link.
    const drivers = [await mover(2), await mover(3), await mover(4)];
    for (const d of drivers) {
      for (const t of personalTypes) await approved(d, t);
      const link = await system(() => resolveSubject(app.prisma, { userId: d, countryCode: 'GY', docType: 'vehicle_registration', tenantId: 'swift-default' }));
      expect(link!.subjectId).toBe(car.subjectId);
      expect(link!.relation).toBe('ASSIGNED_DRIVER');
      // [High #9 · DS109] The auto-created cross-account link is PENDING: the admin's
      // assignment approval is what turns the car's evidence on for this driver.
      expect((await system(() => service.approveVehicleAssignment(d))).approved).toBe(1);
      expect(await system(() => service.isRoleVerified(d, 'MOVER'))).toBe(true);
      expect((await system(() => service.getLiveOperationStatus(d, { vehicleType: 'CAR' }))).allowed).toBe(true);
    }
    // A closed link carries nothing: a driver who LEFT the fleet loses the car's evidence at once.
    const former = await mover(5);
    for (const t of personalTypes) await approved(former, t);
    expect(await system(() => service.isRoleVerified(former, 'MOVER'))).toBe(false); // no link yet → no vehicle evidence
    await system(() => resolveSubject(app.prisma, { userId: former, countryCode: 'GY', docType: 'vehicle_registration', tenantId: 'swift-default' }));
    expect(await system(() => service.isRoleVerified(former, 'MOVER'))).toBe(false); // a PENDING link propagates nothing
    expect((await system(() => service.approveVehicleAssignment(former))).approved).toBe(1);
    expect(await system(() => service.isRoleVerified(former, 'MOVER'))).toBe(true);
    await system(() => app.prisma.subjectLink.updateMany({ where: { accountId: former, subjectId: car.subjectId }, data: { validTo: new Date() } }));
    expect(await system(() => service.isRoleVerified(former, 'MOVER'))).toBe(false);

    // The insurance lapses. One sweep.
    await system(() => app.prisma.verificationDocument.update({ where: { id: insuranceId }, data: { expiresAt: new Date(Date.now() - DAY) } }));
    const expired = await system(() => service.expireLapsedDocuments());
    expect(expired).toBeGreaterThanOrEqual(1);
    for (const d of drivers) {
      expect(await online(d)).toBe(false);
      const told = await notices(d, 'verification_forced_offline');
      expect(told).toHaveLength(1);
      expect(told[0]!.body).toContain(PLATE);
      expect(told[0]!.body).toContain('vehicle insurance');
      expect(told[0]!.body).toContain('expired');
      expect(await system(() => service.isRoleVerified(d, 'MOVER'))).toBe(false);
    }
    const ownerTold = await notices(owner, 'verification_vehicle_lapsed');
    expect(ownerTold).toHaveLength(1);
    expect(ownerTold[0]!.body).toContain('3 drivers');
    expect(await online(owner)).toBe(false);

    // A second sweep: nothing new to say.
    await system(() => service.expireLapsedDocuments());
    for (const d of drivers) expect(await notices(d, 'verification_forced_offline')).toHaveLength(1);
    expect(await notices(owner, 'verification_vehicle_lapsed')).toHaveLength(1);

    // Renewal by the owner brings the fleet back to verified; revoking it reaches them again.
    const renewed = await approved(owner, 'vehicle_insurance', { subjectId: car.subjectId, coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true });
    for (const d of drivers) {
      expect(await system(() => service.isRoleVerified(d, 'MOVER'))).toBe(true);
      await system(() => app.prisma.driver.update({ where: { userId: d }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('fleet-test') } }));
    }
    await system(() => service.revokeDocument(renewed.id, owner, 'Insurer cancelled the policy'));
    for (const d of drivers) {
      expect(await online(d)).toBe(false);
      const told = await notices(d, 'verification_forced_offline');
      expect(told).toHaveLength(2);
      expect(told[1]!.body).toContain('was revoked');
    }
    expect(await notices(owner, 'verification_vehicle_lapsed')).toHaveLength(2);
  });
});

describe('[High #9 · DS109] adopting another car\'s plate inherits nothing', () => {
  it('driver B retypes A\'s verified plate and submits one vehicle document: B\'s GO is refused, B inherits none of A\'s documents, A stays live', async () => {
    // A plate distinct from the fleet fixture above (`HC…`) AND from the `HB…` plates
    // doc1-subjects.test.ts mints from the same Date.now() tail (a parallel worker would
    // otherwise hit vehicle_profile's (registrationMark, countryCode) unique with P2002).
    const PLATE_B = `HBF${NUM.slice(-4)}`;
    const checklist = await countryConfig.getMoverChecklist('GY', 'CAR');
    const vehicleTypes = checklist.filter((t) => BUCKET_OF[t] === 'VEHICLE');
    const personalTypes = checklist.filter((t) => BUCKET_OF[t] !== 'VEHICLE');
    expect(vehicleTypes).toContain('vehicle_insurance');

    // A: a verified CAR on their own plate.
    const a = await mover(6);
    await system(() => app.prisma.driver.update({ where: { userId: a }, data: { licensePlate: PLATE_B } }));
    const subjectA = (await system(() => resolveSubject(app.prisma, { userId: a, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default' })))!;
    expect(subjectA.owned).toBe(true);
    for (const t of personalTypes) await approved(a, t);
    for (const t of vehicleTypes) {
      await approved(a, t, { subjectId: subjectA.subjectId, ...(t === 'vehicle_insurance' ? { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } : {}) });
    }
    expect((await system(() => service.getLiveOperationStatus(a, { vehicleType: 'CAR' }))).allowed).toBe(true);

    // B: an activated driver who types A's plate into their own profile.
    const b = await mover(7);
    await system(() => app.prisma.driver.update({ where: { userId: b }, data: { licensePlate: PLATE_B } }));
    for (const t of personalTypes) await approved(b, t);

    // B submits ONE vehicle document — bound to A's durable vehicle subject, but the
    // cross-account link it creates is PENDING and must not propagate A's evidence.
    const subjectB = (await system(() => resolveSubject(app.prisma, { userId: b, countryCode: 'GY', docType: 'vehicle_registration', tenantId: 'swift-default' })))!;
    expect(subjectB.subjectId).toBe(subjectA.subjectId);
    expect(subjectB.owned).toBe(false);
    await system(() => app.prisma.verificationDocument.create({ data: {
      userId: b, role: 'MOVER', docType: 'vehicle_registration', subjectId: subjectB.subjectId,
      fileUrl: `/uploads/verification/${RUN}/${nanoid(5)}.enc`, status: 'PENDING',
    } }));

    // RED on main: the open ASSIGNED_DRIVER link makes A's approved documents B's — GO allowed.
    const live = await system(() => service.getLiveOperationStatus(b, { vehicleType: 'CAR' }));
    expect(live.allowed).toBe(false);

    // Durable state: B inherited none of A's vehicle evidence; the link stays open but PENDING
    // (never silently approved); A is untouched.
    expect(await system(() => service.isRoleVerified(b, 'MOVER'))).toBe(false);
    const link = await system(() => app.prisma.subjectLink.findFirst({
      where: { accountId: b, subjectId: subjectA.subjectId, relation: 'ASSIGNED_DRIVER' },
    }));
    expect(link).not.toBeNull();
    expect(link!.validTo).toBeNull();
    // The link stays PENDING: open but never silently approved.
    const pending = await system(() => app.prisma.subjectLink.findFirst({
      where: { accountId: b, subjectId: subjectA.subjectId, relation: 'ASSIGNED_DRIVER', validTo: null, approvedAt: null },
    }));
    expect(pending).not.toBeNull();
    expect((await system(() => service.getLiveOperationStatus(a, { vehicleType: 'CAR' }))).allowed).toBe(true);
    expect((await system(() => service.isRoleVerified(a, 'MOVER')))).toBe(true);
  });

  it('mixed backfill posture: a vehicle type filed only on a legacy null-subject row keeps counting while the current subject has no record of that type', async () => {
    // Distinct prefix (HBM) — never the fleet HC… fixture nor the HB…/HBF… plates above.
    const PLATE_M = `HBM${NUM.slice(-4)}`;
    const checklist = await countryConfig.getMoverChecklist('GY', 'CAR');
    const vehicleTypes = checklist.filter((t) => BUCKET_OF[t] === 'VEHICLE');
    const personalTypes = checklist.filter((t) => BUCKET_OF[t] !== 'VEHICLE');

    const d = await mover(8);
    await system(() => app.prisma.driver.update({ where: { userId: d }, data: { licensePlate: PLATE_M } }));
    const subject = (await system(() => resolveSubject(app.prisma, { userId: d, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default' })))!;
    expect(subject.owned).toBe(true);
    for (const t of personalTypes) await approved(d, t);
    for (const t of vehicleTypes) {
      if (t === 'vehicle_insurance') {
        await approved(d, t, { subjectId: subject.subjectId, coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true });
      } else {
        // The pre-backfill shape: real, current evidence about this plate that is not yet
        // bound to the subject. The current subject has no record of this type, so it must
        // still count — a partially backfilled fleet is not refused at GO.
        await approved(d, t, { subjectId: null });
      }
    }
    expect((await system(() => service.getLiveOperationStatus(d, { vehicleType: 'CAR' }))).allowed).toBe(true);
  });

  it('a rider retyping another rider\'s plate is refused at GO — the exact-vehicle rule covers riders too', async () => {
    // Distinct prefix (HBR) — never HC…/HB…/HBF…/HBM… above.
    const PLATE_R = `HBR${NUM.slice(-4)}`;
    const checklist = await countryConfig.getMoverChecklist('GY', 'CAR');
    const vehicleTypes = checklist.filter((t) => BUCKET_OF[t] === 'VEHICLE');
    const personalTypes = checklist.filter((t) => BUCKET_OF[t] !== 'VEHICLE');
    expect(vehicleTypes).toContain('vehicle_insurance');

    // A: a verified rider on their own plate.
    const a = await riderMover(9);
    await system(() => app.prisma.rider.update({ where: { userId: a }, data: { licensePlate: PLATE_R } }));
    const subjectA = (await system(() => resolveSubject(app.prisma, { userId: a, countryCode: 'GY', docType: 'vehicle_insurance', tenantId: 'swift-default' })))!;
    expect(subjectA.owned).toBe(true);
    for (const t of personalTypes) await approved(a, t);
    for (const t of vehicleTypes) {
      await approved(a, t, { subjectId: subjectA.subjectId, ...(t === 'vehicle_insurance' ? { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } : {}) });
    }
    expect(await system(() => service.riderLiveOperation(a, 'CAR'))).toBe(true);

    // B: a rider who types A's plate into their profile and submits ONE vehicle document.
    const b = await riderMover(10);
    await system(() => app.prisma.rider.update({ where: { userId: b }, data: { licensePlate: PLATE_R } }));
    for (const t of personalTypes) await approved(b, t);
    const subjectB = (await system(() => resolveSubject(app.prisma, { userId: b, countryCode: 'GY', docType: 'vehicle_registration', tenantId: 'swift-default' })))!;
    expect(subjectB.subjectId).toBe(subjectA.subjectId);
    expect(subjectB.owned).toBe(false);
    await system(() => app.prisma.verificationDocument.create({ data: {
      userId: b, role: 'MOVER', docType: 'vehicle_registration', subjectId: subjectB.subjectId,
      fileUrl: `/uploads/verification/${RUN}/${nanoid(5)}.enc`, status: 'PENDING',
    } }));

    // RED on main: rider GO used isRoleVerified, whose open link counted A's documents for B.
    expect(await system(() => service.isRoleVerified(b, 'MOVER'))).toBe(false);
    // The exact-vehicle gate a rider's GO now passes through refuses B and admits A.
    expect(await system(() => service.riderLiveOperation(b, 'CAR'))).toBe(false);
    expect(await system(() => service.riderLiveOperation(a, 'CAR'))).toBe(true);
    expect(await system(() => service.isRoleVerified(a, 'MOVER'))).toBe(true);
  });
});
