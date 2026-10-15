/**
 * [VERIFY-DOCS · owner rulings 7–8, 6 Oct 2026 ~20:25 GYT; transition ruling ~21:25 GYT]
 *
 * 8. TAXI documents — seven, each something a Guyana taxi driver really carries or displays:
 *    (1) the ordinary driver's licence (printed date; fallback 5 years; NO "H class" check — the
 *    hire right is item 2), (2) the PERSON's Hire Car Driver's Licence (s.80; fallback 3 years),
 *    (3) the Certificate of Registration showing an H-series plate, (4) the CAR's yearly hire
 *    licence (s.79; 1 year), (5) the certificate of fitness (printed date only; a person keys it),
 *    (6) insurance covering hire, (7) one car photo with the plate visible. Items 2 and 4 replace
 *    the single `hire_car_permit`.
 *    Transition: [owner 15 Oct 2026] NONE. The 60-day grace (an approved permit counting as both new
 *    licences) is removed: no taxi driver goes online without both licences approved.
 * 7. TIN: no certificate image on any checklist; an OPTIONAL "VAT registration number (if
 *    VAT-registered)" on the store, typed, format-checked only, for VAT invoices.
 * (Ruling 9, buses, is its own change: verify-docs-buses.test.ts.)
 *
 * Names of new types and keys are plain strings here, so on the old code every case fails on its
 * own assertion rather than on an import.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { VehicleType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VerificationService } from '../modules/verification/verification.service';
import { lockMoverDocuments } from '../modules/verification/mover-document-authority';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { moverRequiredFrom } from '../modules/country/country-config.service';
import { AUTO_APPROVE_EXPIRY_DAYS, ALWAYS_REVIEW_LEGACY_CODES, BUCKET_OF, FIELD_CATALOGUE, REGISTRY_EFFECTIVE_FROM, REGISTRY_TIER, VALIDATOR_CATALOGUE, registryChecklist, registryCode, seedDocRegistry } from '../modules/verification/doc-registry';
import { VALIDATOR_IMPLEMENTATIONS } from '../modules/verification/validators';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { syntheticLocationOwner } from './helpers/online-mover';
import { rehearseActivation } from '../modules/verification/activation-rehearsal';
import { ensureHireSplitStarted } from '../modules/verification/hire-permit-grace';

const DAY = 86_400_000;
const SPLIT_KEY = 'documents.hire_car_split_started_at';
const TAXI7 = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance', 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];
const phoneBase = 592_008_100_000 + Math.floor(Math.random() * 90_000);
const users: string[] = [];
let app: FastifyInstance;
let service: VerificationService;
let adminId: string;
let adminToken: string;
let priorSplit: unknown;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verify-docs-taxi-tin-test');

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await app.prisma.user.create({ data: {
    phone: `+${phoneBase}`, firstName: 'Taxi', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } },
  } });
  users.push(admin.id); adminId = admin.id;
  adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid() });
  await app.prisma.session.create({ data: { userId: admin.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  priorSplit = (await app.prisma.platformConfig.findUnique({ where: { key: SPLIT_KEY } }))?.value ?? null;
});

afterAll(async () => {
  if (!app) return;
  if (priorSplit === null) await app.prisma.platformConfig.deleteMany({ where: { key: SPLIT_KEY } });
  else await app.prisma.platformConfig.update({ where: { key: SPLIT_KEY }, data: { value: priorSplit as never } });
  if (users.length) {
    await cleanupPayerBillingClocks(app.prisma, users);
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  }
  await app.close();
});

const setSplitStarted = (daysAgo: number) => app.prisma.platformConfig.upsert({
  where: { key: SPLIT_KEY }, create: { key: SPLIT_KEY, value: { startedAt: new Date(Date.now() - daysAgo * DAY).toISOString() } },
  update: { value: { startedAt: new Date(Date.now() - daysAgo * DAY).toISOString() } },
});

async function driver(plate = `HD-${Math.floor(100000 + Math.random() * 899999)}`, vehicleType: VehicleType = 'CAR') {
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + 1 + users.length}`, firstName: 'Synthetic', lastName: `Taxi${users.length}`,
    activeRole: 'DRIVER', roles: ['DRIVER', 'CUSTOMER'], countryCode: 'GY', isPhoneVerified: true,
  } });
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  await app.prisma.driver.create({ data: {
    userId: user.id, vehicleType, vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2019, vehicleColor: 'White', licensePlate: plate,
    driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg',
  } });
  const token = app.jwt.sign({ userId: user.id, role: 'DRIVER', jti: nanoid() });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

/** Build 9's submit call. */
async function submit(m: { userId: string; token: string }, docType: string) {
  const fileUrl = await ownedVerificationFixture(app.prisma, m.userId, `v5-${docType}`);
  return app.inject({ method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${m.token}` },
    payload: { role: 'MOVER', docType, fileUrl, consent: true, privacyNoticeVersion: 'v1' } });
}
const hire = { insurerName: 'Synthetic Mutual', policyNumber: `HIRE-${nanoid(6)}`, coverageClass: 'HIRE' as const, hireClassConfirmed: true, plateCrossChecked: true };
async function approve(docId: string, docType: string, expiresInDays = 300) {
  return service.approveDocument(docId, adminId, Object.hasOwn(AUTO_APPROVE_EXPIRY_DAYS, docType) ? new Date(Date.now() + expiresInDays * DAY) : undefined,
    docType === 'vehicle_insurance' ? hire : undefined);
}
const statusOf = async (token: string) => (await app.inject({ method: 'GET', url: '/api/v1/verification/status?role=MOVER', headers: { authorization: `Bearer ${token}` } })).json().data as {
  checklist: string[]; missing: string[]; roleVerified: boolean; documents: Array<{ docType: string; status: string }>;
};
const live = async (userId: string) => service.getLiveOperationStatus(userId, { vehicleType: 'CAR', kind: 'DRIVER',
  legacyVerified: (await app.prisma.driver.findUniqueOrThrow({ where: { userId }, select: { documentsVerified: true } })).documentsVerified });

/** A taxi driver from before the split: every document of today's world approved, including the old permit. */
async function legacyTaxi(permitDays = 300) {
  const m = await driver();
  for (const t of ['drivers_licence', 'vehicle_registration', 'vehicle_insurance', 'vehicle_exterior_photo', 'fitness_cert']) {
    const r = await submit(m, t); expect(r.statusCode, t).toBe(201); await approve(r.json().data.id, t);
  }
  // the permit is no longer on any list; it exists as the approved document the driver already holds,
  // about the same registered car as the driver's registration (a vehicle document is bound to its car)
  const registration = await app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: m.userId, docType: 'vehicle_registration' }, select: { subjectId: true } });
  expect(registration.subjectId, 'the registration is bound to the car').not.toBeNull();
  const permit = await app.prisma.verificationDocument.create({ data: {
    userId: m.userId, role: 'MOVER', docType: 'hire_car_permit', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
    fileUrl: await ownedVerificationFixture(app.prisma, m.userId, 'v5-permit'), subjectId: registration.subjectId,
  } });
  await approve(permit.id, 'hire_car_permit', permitDays);
  await app.prisma.driver.update({ where: { userId: m.userId }, data: { documentsVerified: true } });
  return { ...m, permitId: permit.id };
}

describe('[V5 · ruling 8] the taxi’s seven documents', () => {
  it('a genuine vehicle registration is approved without inventing an expiry', async () => {
    const m = await driver();
    const doc = await submit(m, 'vehicle_registration');
    expect(doc.statusCode).toBe(201);
    const approved = await service.approveDocument(doc.json().data.id, adminId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.expiresAt).toBeNull();
    expect(AUTO_APPROVE_EXPIRY_DAYS).not.toHaveProperty('vehicle_registration');
  });
  it.each(['CAR', 'WAGON_CAR'] as const)('%s requires exactly the seven, in order', (vt) => {
    expect(moverRequiredFrom(DEFAULT_DOCUMENT_CHECKLISTS, vt)).toEqual(TAXI7);
  });

  it('no list anywhere names the old single permit or the TIN certificate', () => {
    for (const [key, list] of Object.entries(DEFAULT_DOCUMENT_CHECKLISTS)) {
      expect(list, key).not.toContain('hire_car_permit');
      expect(list, key).not.toContain('tin_certificate');
    }
  });

  it('the new licences are typed: the person’s is PERSONAL (3 years), the car’s is VEHICLE (1 year); a driver’s licence falls back to 5 years', () => {
    expect(BUCKET_OF['hire_car_driver_licence']).toBe('PERSONAL');
    expect(BUCKET_OF['hire_car_vehicle_licence']).toBe('VEHICLE');
    expect(AUTO_APPROVE_EXPIRY_DAYS['hire_car_driver_licence']).toBe(3 * 365);
    expect(AUTO_APPROVE_EXPIRY_DAYS['hire_car_vehicle_licence']).toBe(365);
    expect(AUTO_APPROVE_EXPIRY_DAYS['drivers_licence']).toBe(5 * 365);
    expect(FIELD_CATALOGUE['hire_car_driver_licence']?.length).toBeGreaterThan(0);
    expect(FIELD_CATALOGUE['hire_car_vehicle_licence']?.some((f) => f.fieldCode === 'registration_mark')).toBe(true);
  });

  it('no "H class" check on the ordinary licence; the certificate of fitness is always read by a person', () => {
    expect(Object.keys(VALIDATOR_IMPLEMENTATIONS)).not.toContain('validators#V_LICENCE_CLASS');
    const row = VALIDATOR_CATALOGUE.find((v) => v.code === 'V_LICENCE_CLASS');
    expect(row?.isBlocking).toBe(false);
    expect(row?.implRef).toBeUndefined();
    expect(FIELD_CATALOGUE['drivers_licence']?.find((f) => f.fieldCode === 'classes')?.validatorRef).toBeUndefined();
    expect(ALWAYS_REVIEW_LEGACY_CODES.has('fitness_cert')).toBe(true);
  });

  it('the car’s hire licence, like the registration, is refused for a car without an H-series plate', async () => {
    const m = await driver('PAB-1234');
    for (const t of ['vehicle_registration', 'hire_car_vehicle_licence']) {
      const r = await submit(m, t);
      expect(r.statusCode, t).toBe(201);
      await expect(approve(r.json().data.id, t), t).rejects.toMatchObject({ code: 'WRONG_PLATE_CLASS' });
    }
  });

  it('build 9: a new taxi uploads every checklist document, a person approves, and the driver is live', async () => {
    const m = await driver();
    const first = await statusOf(m.token);
    expect(first.checklist).toEqual(TAXI7);
    for (const t of first.checklist) {
      const r = await submit(m, t); expect(r.statusCode, t).toBe(201); await approve(r.json().data.id, t);
    }
    const after = await statusOf(m.token);
    expect(after.missing).toEqual([]);
    expect(after.roleVerified).toBe(true);
    expect(await live(m.userId)).toEqual({ allowed: true, reason: 'ok' });
  });
});

// [Owner ruling 15 Oct 2026 ~04:25Z, criminal-liability decisions] THE 60-DAY GRACE IS REMOVED (abettor risk,
// MVRTA s.80 + SJ(O)A s.19). No taxi driver goes online, or is offered work, without BOTH hire licences on file
// and approved; the old single hire-car permit never stands in for them, however recently the switch-over was
// recorded. Cases marked TRANSFORMED asserted the grace (the old rule) and now assert its removal.
describe('[owner 15 Oct · no grace] the old hire-car permit never counts as the two hire licences', () => {
  /** The daily sweep (and the boot run) that enforces the two licences. Through a lookup so the old code runs its
   *  grace sweep here and fails on this file's assertions, not on a missing method. */
  const licenceSweep = (now?: Date) => {
    const s = service as unknown as Record<string, ((now?: Date) => Promise<number>) | undefined>;
    return (s['hireLicenceSweep'] ?? s['hirePermitGraceSweep'])!.call(service, now);
  };
  const HIRE_LICENCES = ['hire_car_driver_licence', 'hire_car_vehicle_licence'];
  const goOnline = (m: { token: string }) => app.inject({ method: 'POST', url: '/api/v1/driver/go-online', headers: { authorization: `Bearer ${m.token}` } });

  it('initialization refuses a failed write instead of starting with no persisted grace', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: SPLIT_KEY } });
    const failure = vi.spyOn(app.prisma.platformConfig, 'create').mockRejectedValueOnce(new Error('synthetic grace write unavailable'));
    try {
      await expect(ensureHireSplitStarted(app.prisma)).rejects.toThrow('synthetic grace write unavailable');
      expect(await app.prisma.platformConfig.findUnique({ where: { key: SPLIT_KEY } })).toBeNull();
    } finally { failure.mockRestore(); }
  });

  it('a unique-create race keeps the other node’s persisted start', async () => {
    await setSplitStarted(10);
    const existing = await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: SPLIT_KEY } });
    const raced = vi.spyOn(app.prisma.platformConfig, 'findUnique').mockResolvedValueOnce(null);
    try {
      expect((await ensureHireSplitStarted(app.prisma)).toISOString()).toBe((existing.value as { startedAt: string }).startedAt);
    } finally { raced.mockRestore(); }
  });

  // TRANSFORMED (was 'during the 60 days: verified and live, with the two new licences asked for').
  it('inside what was the 60-day window, a permit-only driver is not live, not verified, refused at GO, and told both licences are missing', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    expect(await live(m.userId)).toEqual({ allowed: false, reason: 'docs' });
    const s = await statusOf(m.token);
    expect(s.roleVerified).toBe(false);
    expect(s.missing).toEqual(HIRE_LICENCES);
    expect(s).not.toHaveProperty('hirePermitGrace');
    const go = await goOnline(m);
    expect([go.statusCode, go.json().error?.code ?? go.json().code]).toEqual([403, 'VERIFICATION_REQUIRED']);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { userId: m.userId } })).isOnline).toBe(false);
    // the two licences, uploaded and approved by a person, restore the driver
    for (const t of HIRE_LICENCES) {
      const r = await submit(m, t); expect(r.statusCode, t).toBe(201); await approve(r.json().data.id, t);
    }
    expect((await live(m.userId)).allowed).toBe(true);
  });

  // TRANSFORMED (was 'a permit that expires first ends the grace with it'): one licence is not enough either.
  it('with the permit and only ONE of the two licences, the driver is not live, the checklist names exactly the other, and the claim path refuses', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    const r = await submit(m, 'hire_car_driver_licence'); expect(r.statusCode).toBe(201); await approve(r.json().data.id, 'hire_car_driver_licence');
    expect(await live(m.userId)).toEqual({ allowed: false, reason: 'docs' });
    expect((await statusOf(m.token)).missing).toEqual(['hire_car_vehicle_licence']);
    // the locked read every job claim, ride accept and GO runs under lock (dispatch.service, driver.routes)
    const locked = await app.prisma.$transaction((tx) => lockMoverDocuments(tx, m.userId, 'DRIVER'));
    expect(locked.allowed).toBe(false);
  });

  // TRANSFORMED (was 'the daily sweep reminds a driver on the grace once per stage, and takes them offline when it ends'
  // and 'a reminder uses the permit’s earlier deadline rather than promising the whole remaining window').
  it('the sweep takes an ONLINE permit-only driver offline at once, inside what was the window, and tells them once to upload both licences', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    await app.prisma.driver.update({ where: { userId: m.userId }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('v5-no-grace') } });
    await licenceSweep();
    await licenceSweep();
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { userId: m.userId } })).isOnline).toBe(false);
    const offline = await app.prisma.notification.findMany({ where: { userId: m.userId, title: 'You have been taken offline' } });
    expect(offline).toHaveLength(1);
    expect(offline[0]!.body).toContain('Upload your Hire Car Driver’s Licence and your car’s hire licence');
    const asks = await app.prisma.notification.findMany({ where: { userId: m.userId, title: { contains: 'hire' } } });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body).toContain('Upload your Hire Car Driver’s Licence and your car’s hire licence');
    expect(asks[0]!.body).not.toMatch(/still counts|keep working|within \d+ days/i);
  });

  it('a driver holding the permit and the Hire Car Driver’s Licence is asked for the car’s hire licence alone', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    const r = await submit(m, 'hire_car_driver_licence'); await approve(r.json().data.id, 'hire_car_driver_licence');
    await app.prisma.driver.update({ where: { userId: m.userId }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('v5-one-licence') } });
    await licenceSweep();
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { userId: m.userId } })).isOnline).toBe(false);
    const asks = await app.prisma.notification.findMany({ where: { userId: m.userId, title: { contains: 'hire' } } });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body).toContain('Upload your car’s hire licence (the yearly one shown on the car) in Documents');
    expect(asks[0]!.body).not.toContain('Upload your Hire Car Driver’s Licence');
  });

  it('a permit whose retention clock elapsed never promises continuing eligibility', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    await app.prisma.verificationDocument.update({ where: { id: m.permitId }, data: { retentionExpiresAt: new Date(Date.now() - DAY) } });
    expect(await app.prisma.documentRecord.count({ where: { submissionId: m.permitId, status: 'VALID' } })).toBe(1);
    await licenceSweep();
    expect(await app.prisma.notification.count({ where: { userId: m.userId, title: { contains: 'hire' } } })).toBe(0);
  });

  it('an expired transition permit asks for the replacement licences and is never called optional', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    await app.prisma.verificationDocument.update({ where: { id: m.permitId }, data: { expiresAt: new Date(Date.now() - DAY) } });
    await service.expireLapsedDocuments();
    const notices = await app.prisma.notification.findMany({ where: { userId: m.userId, title: 'Document expired', data: { path: ['docId'], equals: m.permitId } } });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).not.toMatch(/optional|keep working/i);
    expect(notices[0]!.body).toContain('Hire Car Driver’s Licence');
  });

  // TRANSFORMED (was 'concurrent grace reminders persist one notice per stage'): concurrent sweeps, one of each notice.
  it('concurrent sweeps take the driver offline once and ask once', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi();
    await app.prisma.driver.update({ where: { userId: m.userId }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('v5-concurrent') } });
    await Promise.all(Array.from({ length: 4 }, () => licenceSweep()));
    expect(await app.prisma.notification.count({ where: { userId: m.userId, title: { contains: 'hire' } } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: m.userId, title: 'You have been taken offline' } })).toBe(1);
  });

  it('a permit expiring soon is never reminded as something to keep operating on', async () => {
    await setSplitStarted(10);
    const m = await legacyTaxi(10); // T-14 notice due now
    expect(await service.sendExpiryReminders()).toBeGreaterThanOrEqual(1);
    const reminders = (await app.prisma.notification.findMany({ where: { userId: m.userId, data: { path: ['docId'], equals: m.permitId } } }))
      .filter((n) => (n.data as { kind?: string } | null)?.kind === 'verification_expiry_reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.body).not.toMatch(/keep operating|keep working/i);
    expect(reminders[0]!.body).toContain('Upload your Hire Car Driver’s Licence and your car’s hire licence (the yearly one shown on the car) in Documents to go online');
  });

  it('after 60 days the permit no longer counts; the two new licences restore the driver', async () => {
    await setSplitStarted(61);
    const m = await legacyTaxi();
    expect(await live(m.userId)).toEqual({ allowed: false, reason: 'docs' });
    expect((await statusOf(m.token)).missing).toEqual(['hire_car_driver_licence', 'hire_car_vehicle_licence']);
    for (const t of ['hire_car_driver_licence', 'hire_car_vehicle_licence']) {
      const r = await submit(m, t); expect(r.statusCode, t).toBe(201); await approve(r.json().data.id, t);
    }
    expect((await live(m.userId)).allowed).toBe(true);
  });

  it('with no recorded switch-over, nothing is granted (the grace starts only when the split does)', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: SPLIT_KEY } });
    const m = await legacyTaxi();
    expect((await live(m.userId)).allowed).toBe(false);
  });

  it('every API boot runs the licence sweep (after the switch-over is recorded), and a failing sweep never stops the boot', async () => {
    const { runHireLicenceSweepAtBoot } = await import('../modules/verification/hire-licence-boot').catch(() => ({ runHireLicenceSweepAtBoot: undefined }));
    expect(typeof runHireLicenceSweepAtBoot).toBe('function');
    await setSplitStarted(10);
    const m = await legacyTaxi();
    await app.prisma.driver.update({ where: { userId: m.userId }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('v5-boot') } });
    const warnings: unknown[] = [];
    await runHireLicenceSweepAtBoot!({ prisma: app.prisma, io: app.io, log: { warn: (...a: unknown[]) => warnings.push(a), info: () => {} } });
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { userId: m.userId } })).isOnline).toBe(false);
    expect(warnings).toEqual([]);
    const failing = vi.spyOn(app.prisma.documentRecord, 'findMany').mockRejectedValueOnce(new Error('synthetic sweep failure'));
    try {
      await expect(runHireLicenceSweepAtBoot!({ prisma: app.prisma, io: app.io, log: { warn: (...a: unknown[]) => warnings.push(a), info: () => {} } })).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
    } finally { failing.mockRestore(); }
    const server = readFileSync(join(__dirname, '../server.ts'), 'utf8');
    const split = server.indexOf('await ensureHireSplitStarted(app.prisma);');
    const boot = server.indexOf('runHireLicenceSweepAtBoot(');
    expect(split).toBeGreaterThan(0);
    expect(boot).toBeGreaterThan(split);
  });
});

describe('[V5 · ruling 7] TIN and the VAT number', () => {
  async function store() {
    const owner = await app.prisma.user.create({ data: {
      phone: `+${phoneBase + 500 + users.length}`, firstName: 'Vat', lastName: `Owner${users.length}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, countryCode: 'GY',
    } });
    users.push(owner.id);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const v = await app.prisma.vendor.create({ data: {
      ownerId: vo.id, name: `Vat Store ${users.length}`, slug: `vat-store-${nanoid(8).toLowerCase()}`, vendorType: 'STORE', phone: `+5926${String(users.length).padStart(6, '0')}`,
      addressLine1: '1 Ledger Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    } });
    const token = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid() });
    await app.prisma.session.create({ data: { userId: owner.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { userId: owner.id, vendorId: v.id, token };
  }
  const put = (token: string, body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${token}` }, payload: body });

  it('stores open without a TIN certificate', () => {
    for (const key of ['RESTAURANT', 'SUPERMARKET', 'STORE']) expect(DEFAULT_DOCUMENT_CHECKLISTS[key], key).not.toContain('tin_certificate');
  });

  it('the owner may add a VAT registration number (format-checked), change it, or take it off', async () => {
    const s = await store();
    const ok = await put(s.token, { vatRegistrationNumber: ' 012-345-678 ' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })) as { vatRegistrationNumber?: string | null }).vatRegistrationNumber).toBe('012345678');
    const bad = await put(s.token, { vatRegistrationNumber: 'not-a-number' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VAT_NUMBER_INVALID');
    expect((await put(s.token, { vatRegistrationNumber: null })).statusCode).toBe(200);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })) as { vatRegistrationNumber?: string | null }).vatRegistrationNumber).toBeNull();
  });

  it('only the owner may give it: a manager of the same store is refused and the number stays as it was', async () => {
    const s = await store();
    expect((await put(s.token, { vatRegistrationNumber: '123456789' })).statusCode).toBe(200);
    const manager = await app.prisma.user.create({ data: {
      phone: `+${phoneBase + 700 + users.length}`, firstName: 'Vat', lastName: `Manager${users.length}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, countryCode: 'GY',
    } });
    users.push(manager.id);
    await app.prisma.vendorStaff.create({ data: { vendorId: s.vendorId, userId: manager.id, role: 'MANAGER', invitedBy: s.userId } });
    const token = app.jwt.sign({ userId: manager.id, role: 'CUSTOMER', jti: nanoid() });
    await app.prisma.session.create({ data: { userId: manager.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${token}`, 'x-vendor-id': s.vendorId }, payload: { vatRegistrationNumber: '999999999' } });
    expect(res.statusCode, res.body).toBe(403);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })) as { vatRegistrationNumber?: string | null }).vatRegistrationNumber).toBe('123456789');
  });

  it.each(['STAFF', 'MANAGER'] as const)('VAT stays on the owner’s billing profile when %s reads the store', async (role) => {
    const s = await store();
    expect((await put(s.token, { vatRegistrationNumber: '123456789' })).statusCode).toBe(200);
    const member = await app.prisma.user.create({ data: { phone: `+${phoneBase + 800 + users.length}`, firstName: 'Synthetic', lastName: `Vat${role}${users.length}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, countryCode: 'GY' } });
    users.push(member.id);
    await app.prisma.vendorStaff.create({ data: { vendorId: s.vendorId, userId: member.id, role, invitedBy: s.userId } });
    const token = app.jwt.sign({ userId: member.id, role: 'CUSTOMER', jti: nanoid() });
    await app.prisma.session.create({ data: { userId: member.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const headers = { authorization: `Bearer ${token}`, 'x-vendor-id': s.vendorId };
    const get = await app.inject({ method: 'GET', url: '/api/v1/vendor/profile', headers });
    expect(get.statusCode, get.body).toBe(200);
    expect(get.body).not.toContain('123456789');
    expect(get.body).not.toContain('vatRegistrationNumber');
    if (role === 'MANAGER') {
      const edit = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers, payload: { description: 'Synthetic store description' } });
      expect(edit.statusCode, edit.body).toBe(200);
      expect(edit.body).not.toContain('123456789');
      expect(edit.body).not.toContain('vatRegistrationNumber');
    }
    const owner = await app.inject({ method: 'GET', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${s.token}` } });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain('123456789');
  });

  it('general admin store views do not copy the owner’s VAT billing number', async () => {
    const s = await store();
    expect((await put(s.token, { vatRegistrationNumber: '123456789' })).statusCode).toBe(200);
    const headers = { authorization: `Bearer ${adminToken}` };
    for (const url of ['/api/v1/admin/vendors', `/api/v1/admin/vendors/${s.vendorId}`]) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('123456789');
      expect(res.body).not.toContain('vatRegistrationNumber');
    }
    await app.prisma.vendor.update({ where: { id: s.vendorId }, data: { status: 'PENDING_APPROVAL' } });
    const pending = await app.inject({ method: 'GET', url: '/api/v1/admin/vendors/pending', headers });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.body).not.toContain('vatRegistrationNumber');
  });

  it('admin store actions (suspend, feature, approve) answer without the owner’s VAT billing number', async () => {
    const s = await store();
    expect((await put(s.token, { vatRegistrationNumber: '123456789' })).statusCode).toBe(200);
    const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': 'Synthetic review of the store record for this test' };
    for (const action of ['suspend', 'feature', 'approve'] as const) {
      const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/vendors/${s.vendorId}/${action}`, headers, payload: action === 'suspend' ? { reason: 'Synthetic review of the store record for this test' } : {} });
      expect(res.body, `${action} answered ${res.statusCode}`).not.toContain('123456789');
      expect(res.body).not.toContain('vatRegistrationNumber');
      if (action === 'suspend') expect(res.statusCode, res.body).toBe(200);
    }
  });

  it('it is never public: the storefront a customer or a guest opens does not carry it', async () => {
    const s = await store();
    expect((await put(s.token, { vatRegistrationNumber: '987654321' })).statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${s.vendorId}` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).not.toContain('987654321');
    expect(page.body).not.toMatch(/vatRegistrationNumber/);
  });
});


describe('[V5 · registry] inactive optional documents never silence active requirements', () => {
  it('both the facade and activation rehearsal still report the blocking national ID', async () => {
    // Fixture: the registry's document types must exist before an item can name them. Seeding here keeps
    // this case independent of which suite ran first (in CI an unseeded database failed the item's foreign key,
    // and the set created below then outlived the case and blanked MOVER_NO_LICENCE for the next suite).
    await system(() => seedDocRegistry(app.prisma));
    const existingSet = await app.prisma.requirementSet.findFirst({ where: { countryCode: 'GY', actorRole: 'MOVER_NO_LICENCE', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } });
    const set = existingSet ?? await app.prisma.requirementSet.create({ data: { countryCode: 'GY', actorRole: 'MOVER_NO_LICENCE', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } });
    await app.prisma.requirementItem.upsert({ where: { requirementSetId_docTypeCode: { requirementSetId: set.id, docTypeCode: registryCode('GY', 'national_id') } }, create: { requirementSetId: set.id, docTypeCode: registryCode('GY', 'national_id'), isBlocking: true, minCount: 1, sortOrder: 0 }, update: { isBlocking: true } });
    const requiredCode = registryCode('GY', 'national_id');
    const optionalCode = registryCode('GY', 'police_clearance');
    const prior = await app.prisma.docType.findMany({ where: { code: { in: [requiredCode, optionalCode] } } });
    const itemKey = { requirementSetId_docTypeCode: { requirementSetId: set.id, docTypeCode: optionalCode } };
    const priorItem = await app.prisma.requirementItem.findUnique({ where: itemKey });
    await app.prisma.requirementItem.upsert({ where: itemKey, create: { requirementSetId: set.id, docTypeCode: optionalCode, isBlocking: false, minCount: 1, sortOrder: 99 }, update: { isBlocking: false } });
    try {
      await app.prisma.docType.update({ where: { code: requiredCode }, data: { isActive: true, legalFactsVerifiedAt: new Date('2026-09-01T00:00:00.000Z') } });
      await app.prisma.docType.update({ where: { code: optionalCode }, data: { isActive: false } });
      expect(await registryChecklist(app.prisma, 'GY', 'MOVER_NO_LICENCE')).toEqual(['national_id']);
      const rehearsal = await rehearseActivation(app.prisma, service, { countryCode: 'GY', legacyCodes: ['national_id'] });
      expect(rehearsal.registry.setsThatSwitch.find((s) => s.actorRole === 'MOVER_NO_LICENCE')?.registryList).toEqual(['national_id']);
    } finally {
      if (priorItem) await app.prisma.requirementItem.update({ where: itemKey, data: { isBlocking: priorItem.isBlocking } });
      else await app.prisma.requirementItem.delete({ where: itemKey });
      for (const type of prior) await app.prisma.docType.update({ where: { code: type.code }, data: { isActive: type.isActive, legalFactsVerifiedAt: type.legalFactsVerifiedAt } });
      if (!existingSet) {
        await app.prisma.requirementItem.deleteMany({ where: { requirementSetId: set.id } });
        await app.prisma.requirementSet.delete({ where: { id: set.id } });
      }
    }
  });
});
