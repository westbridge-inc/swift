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
      expect(await system(() => service.isRoleVerified(d, 'MOVER'))).toBe(true);
      expect((await system(() => service.getLiveOperationStatus(d, { vehicleType: 'CAR' }))).allowed).toBe(true);
    }
    // A closed link carries nothing: a driver who LEFT the fleet loses the car's evidence at once.
    const former = await mover(5);
    for (const t of personalTypes) await approved(former, t);
    expect(await system(() => service.isRoleVerified(former, 'MOVER'))).toBe(false); // no link yet → no vehicle evidence
    await system(() => resolveSubject(app.prisma, { userId: former, countryCode: 'GY', docType: 'vehicle_registration', tenantId: 'swift-default' }));
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
