/**
 * [VERIFY-DOCS · owner rulings of 6 Oct 2026, items 1, 2, 4 and 5] What each mover must hand Swift.
 *
 *  - Police clearance is OPTIONAL for every mover (taxi, motorbike, bicycle). It stays a document
 *    a mover may add; an approved, current one sets the "Police-cleared" flag (no screen shows a badge yet,
 *    so no copy may promise one).
 *  - A motorised mover's driver's licence is their photo ID, so the national ID is OPTIONAL for
 *    them. A bicycle rider has no licence and keeps the national ID as a requirement.
 *  - The separate plate photo is gone: the car photo shows the plate. Nothing judged the plate
 *    photo; the plate cross-check lives on the insurance review, which stays as it was.
 *  - Every going-live gate reads the same lists: what the app shows is what the gate requires.
 *
 * [ROLE-DOCS · owner ruling 21 Oct 2026 — a DELIBERATE change to these pins] No mover is offered a second
 * ID (the optional national ID is gone for every vehicle partner; a bicycle rider still REQUIRES it), and the
 * optional police clearance is kept for TAXI drivers only (MOVER_TAXI_EXTRA_OPTIONAL): a delivery rider is
 * not offered one and cannot send one.
 *
 * The services rule (police clearance for home visits only) is NOT in this change: the service
 * marketplace cannot yet tell a home visit from work at the provider's place, so services keep
 * today's lists until that is decided. The last block pins that deliberately.
 *
 * Build 9 (the store build under review) reads `checklist`, `documents`, `missing` and
 * `roleVerified` and uploads exactly the `checklist` types. The "build 9" block replays that
 * client against the new lists, end to end, for a bicycle, a motorbike and a taxi car.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { riderRoutes } from '../modules/rider/rider.routes';
import { VerificationService, docTypeExpires } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { CountryConfigService, moverRequiredFrom, optionalFrom } from '../modules/country/country-config.service';
import { DEFAULT_DOCUMENT_CHECKLISTS, desiredPlatformConfig } from '../modules/ops/platform-config';
import { VEHICLE_TYPES_IN_ORDER, docProfilesFor } from '../config/vehicle-classes';
import { seedDocRegistry, registryChecklist, registryCode, REGISTRY_EFFECTIVE_FROM, REGISTRY_TIER } from '../modules/verification/doc-registry';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';

const DAY = 86_400_000;
const phoneBase = 592_007_000_000 + Math.floor(Math.random() * 900_000);
const users: string[] = [];
const riderIds: string[] = [];
let app: FastifyInstance;
let service: VerificationService;
let adminId: string;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verify-docs-checklists-test');

const BICYCLE = ['national_id'];
const MOTOR = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
// [VERIFY-DOCS · ruling 8, a DELIBERATE change] the person's and the car's hire licences replace the single permit
const TAXI = [...MOTOR, 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  // Staging and production review by hand (KYC_PROVIDER=manual): every upload waits for a person.
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await app.prisma.user.create({ data: {
    phone: `+${phoneBase}`, firstName: 'Verify', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN',
    isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } },
  } });
  users.push(admin.id);
  adminId = admin.id;
});

afterAll(async () => {
  if (!app) return;
  if (users.length) {
    // The same teardown verification.test.ts uses: billing clocks first, then the accounts.
    await cleanupPayerBillingClocks(app.prisma, users);
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  for (const id of riderIds) await app.redis.del(`rider:location_db_ts:${id}`, `rider:online_since:${id}`);
  await app.close();
});

/** A mover account as the apps create it: a signup selfie, a session, and a Rider or Driver profile. */
async function mover(vehicleType: VehicleType) {
  const driver = vehicleType === 'CAR' || vehicleType === 'WAGON_CAR';
  const role = driver ? 'DRIVER' : 'RIDER';
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + 1 + users.length}`, firstName: 'Synthetic', lastName: `Mover${users.length}`,
    activeRole: role, roles: [role, 'CUSTOMER'], countryCode: 'GY', isPhoneVerified: true,
  } });
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  const plate = `${driver ? 'HD' : 'CG'}-${Math.floor(100000 + Math.random() * 899999)}`;
  if (driver) {
    await app.prisma.driver.create({ data: {
      userId: user.id, vehicleType, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: plate, driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg',
    } });
  } else {
    const rider = await app.prisma.rider.create({ data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType, documentsVerified: false, isOnline: false, isAvailable: false,
      ...(vehicleType === 'BICYCLE' ? {} : { licensePlate: plate }),
    } });
    riderIds.push(rider.id);
  }
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid() });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token, vehicleType, driver };
}

const status = (token: string, vehicleType?: VehicleType) => app.inject({
  method: 'GET', url: `/api/v1/verification/status?role=MOVER${vehicleType ? `&vehicleType=${vehicleType}` : ''}`,
  headers: { authorization: `Bearer ${token}` },
});

/** Exactly build 9's submit call (apps/mobile/src/services/api.ts at the store build). */
async function submit(m: { userId: string; token: string }, docType: string) {
  const fileUrl = await ownedVerificationFixture(app.prisma, m.userId, `vd-${docType}`);
  return app.inject({
    method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${m.token}` },
    payload: { role: 'MOVER', docType, fileUrl, consent: true, privacyNoticeVersion: 'v1' },
  });
}

/** What a reviewer does in the console: key the printed expiry; for a taxi's insurance, the HIRE checks. */
async function approve(docId: string, docType: string, _taxi: boolean) {
  return service.approveDocument(docId, adminId, docTypeExpires(docType) ? new Date(Date.now() + 300 * DAY) : undefined,
    // [R13] every motor vehicle's insurance carries the reviewer's hire-or-reward decision, not only a taxi's
    docType === 'vehicle_insurance'
      ? { insurerName: 'Synthetic Mutual', policyNumber: `HIRE-${nanoid(6)}`, coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true }
      : undefined);
}

const goOnline = (token: string) => app.inject({
  method: 'POST', url: '/api/v1/rider/go-online', headers: { authorization: `Bearer ${token}` }, payload: { latitude: 6.8, longitude: -58.15 },
});

describe('[VERIFY-DOCS] a retained taxi profile never hides the current bicycle requirements', () => {
  it('a bicycle national ID lapse is never described as optional beside a retained taxi profile', async () => {
    const m = await mover('BICYCLE');
    await app.prisma.user.update({ where: { id: m.userId }, data: { activeRole: 'DRIVER', lastMoverRole: 'DRIVER', roles: ['RIDER', 'DRIVER', 'CUSTOMER'] } });
    await app.prisma.driver.create({ data: { userId: m.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleYear: 2020,
      vehicleColor: 'Grey', licensePlate: `HD-${nanoid(6)}`, driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg' } });
    const doc = await app.prisma.verificationDocument.create({ data: { userId: m.userId, role: 'MOVER', docType: 'national_id', fileUrl: '',
      status: 'APPROVED', state: 'COMMITTED', expiresAt: new Date(Date.now() - DAY), reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    await service.expireLapsedDocuments();
    const notices = await app.prisma.notification.findMany({ where: { userId: m.userId, data: { path: ['docId'], equals: doc.id } } });
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice.body).not.toMatch(/optional|keep working/i);
      expect(notice.body).toMatch(/Upload a new one to keep operating/);
    }
  });

  it.each(['RIDER', 'MOVER', 'CUSTOMER'] as const)('uses current or remembered Rider authority from %s', async (activeRole) => {
    const m = await mover('BICYCLE');
    await app.prisma.user.update({ where: { id: m.userId }, data: { activeRole, lastMoverRole: 'RIDER', roles: ['RIDER', 'DRIVER', 'CUSTOMER', 'MOVER'] } });
    await app.prisma.driver.create({ data: { userId: m.userId, vehicleType: 'CAR', vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleYear: 2020,
      vehicleColor: 'Grey', licensePlate: `HD-${nanoid(6)}`, driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg' } });
    for (const docType of TAXI) await app.prisma.verificationDocument.create({ data: {
      userId: m.userId, role: 'MOVER', docType, fileUrl: '', status: 'APPROVED', state: 'COMMITTED',
      expiresAt: new Date(Date.now() + 300 * DAY), reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1',
    } });
    const data = await service.getStatus(m.userId, 'MOVER');
    expect(data.vehicleType).toBe('BICYCLE');
    expect(data.checklist).toEqual(BICYCLE);
    expect(data.optional).toEqual([]);
    expect(data.missing).toEqual(['national_id']);
    expect(data.roleVerified).toBe(false);
  });
});

describe('[VERIFY-DOCS] the code defaults ARE the rulings (what every fresh install and the next seed plan writes)', () => {
  const expected: Record<string, { required: string[]; optional: string[] }> = {
    BICYCLE: { required: BICYCLE, optional: [] },
    MOTORCYCLE: { required: MOTOR, optional: [] },
    CAR: { required: TAXI, optional: ['police_clearance'] },
    WAGON_CAR: { required: TAXI, optional: ['police_clearance'] },
  };
  it.each(Object.keys(expected))('%s', (vt) => {
    const required = moverRequiredFrom(DEFAULT_DOCUMENT_CHECKLISTS, vt as VehicleType);
    expect(required).toEqual(expected[vt]!.required);
    expect(optionalFrom(DEFAULT_DOCUMENT_CHECKLISTS, ['MOVER', ...docProfilesFor(vt as VehicleType)], required)).toEqual(expected[vt]!.optional);
  });

  it('every vehicle: no police clearance or plate photo required; motorised ones prove identity by licence', () => {
    for (const vt of VEHICLE_TYPES_IN_ORDER) {
      const required = moverRequiredFrom(DEFAULT_DOCUMENT_CHECKLISTS, vt);
      expect(required, vt).not.toContain('police_clearance');
      expect(required, vt).not.toContain('vehicle_plate_photo');
      if (vt !== 'BICYCLE') { for (const kept of MOTOR) expect(required, vt).toContain(kept); expect(required, vt).not.toContain('national_id'); }
    }
  });

  it('the seeded Guyana row carries exactly these mover lists', async () => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    for (const key of ['MOVER', 'MOVER_NO_LICENCE', 'MOVER_MOTOR', 'MOVER_TAXI_EXTRA', 'MOVER_TAXI_EXTRA_OPTIONAL']) expect(stored[key], key).toEqual(DEFAULT_DOCUMENT_CHECKLISTS[key]);
    // [ROLE-DOCS · owner 21 Oct 2026] no list offers every mover an optional document any more, and no CUSTOMER_L2 list exists
    expect(stored['MOVER_OPTIONAL']).toBeUndefined();
    expect(stored['CUSTOMER_L2']).toBeUndefined();
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_TAXI_EXTRA_OPTIONAL']).toEqual(['police_clearance']);
  });
});

describe('[VERIFY-DOCS] mover checklists follow the owner rulings of 6 Oct 2026', () => {
  const lists = () => new CountryConfigService(app.prisma);

  it('a bicycle rider must give a national ID and nothing else, and is offered nothing optional', async () => {
    expect(await lists().getMoverChecklist('GY', 'BICYCLE')).toEqual(BICYCLE);
    const m = await mover('BICYCLE');
    const data = (await status(m.token)).json().data;
    expect(data.checklist).toEqual(BICYCLE);
    expect(data.optional).toEqual([]);
  });

  it('a motorbike rider needs the licence, registration and insurance, and is offered nothing optional', async () => {
    expect(await lists().getMoverChecklist('GY', 'MOTORCYCLE')).toEqual(MOTOR);
    const m = await mover('MOTORCYCLE');
    const data = (await status(m.token)).json().data;
    expect(data.checklist).toEqual(MOTOR);
    expect(data.optional).toEqual([]);
  });

  it('a taxi car or wagon: no separate plate photo, police clearance or national ID required; the car photo, hire permit and fitness stay', async () => {
    expect(await lists().getMoverChecklist('GY', 'CAR')).toEqual(TAXI);
    expect(await lists().getMoverChecklist('GY', 'WAGON_CAR')).toEqual(TAXI);
    const m = await mover('CAR');
    const data = (await status(m.token)).json().data;
    expect(data.checklist).toEqual(TAXI);
    // [ROLE-DOCS] a taxi driver may still add a police clearance; never a second ID
    expect(data.optional).toEqual(['police_clearance']);
  });

  it('no vehicle anywhere requires a police clearance or a plate photo; every motorised one keeps licence, registration and insurance', async () => {
    for (const vt of VEHICLE_TYPES_IN_ORDER) {
      const required = await lists().getMoverChecklist('GY', vt);
      expect(required, vt).not.toContain('police_clearance');
      expect(required, vt).not.toContain('vehicle_plate_photo');
      if (vt === 'BICYCLE') continue;
      for (const kept of MOTOR) expect(required, vt).toContain(kept);
      expect(required, vt).not.toContain('national_id');
    }
    for (const list of Object.values(DEFAULT_DOCUMENT_CHECKLISTS)) expect(list).not.toContain('vehicle_plate_photo');
  });

  it('the preview of a vehicle not yet saved shows the same lists', async () => {
    const m = await mover('MOTORCYCLE');
    expect((await status(m.token, 'CAR')).json().data.checklist).toEqual(TAXI);
    expect((await status(m.token, 'BICYCLE')).json().data.checklist).toEqual(BICYCLE);
  });
});

/** [ROLE-DOCS] Every taxi document approved, as a reviewer would (the HIRE checks on the insurance). */
async function approvedTaxi() {
  const m = await mover('CAR');
  for (const docType of TAXI) await approve((await submit(m, docType)).json().data.id, docType, true);
  return m;
}
const taxiLive = (userId: string) => service.getLiveOperationStatus(userId, { vehicleType: 'CAR', kind: 'DRIVER' });

describe('[VERIFY-DOCS · ROLE-DOCS] optional documents: a taxi driver may add a police clearance; it never gates and sets the Police-cleared flag', () => {
  it('a delivery rider is offered no optional document: a police clearance or a national ID is refused, like the old plate photo', async () => {
    for (const vt of ['MOTORCYCLE', 'BICYCLE'] as const) {
      const m = await mover(vt);
      for (const docType of ['police_clearance', 'vehicle_plate_photo', ...(vt === 'MOTORCYCLE' ? ['national_id'] : [])]) {
        const res = await submit(m, docType);
        expect(res.statusCode, `${vt} ${docType}`).toBe(400);
        expect(res.json().error.code, `${vt} ${docType}`).toBe('INVALID_DOC_TYPE');
      }
      const data = (await status(m.token)).json().data;
      expect(data.documents).toEqual([]);
      expect(data.policeCleared).toBe(false);
    }
  });

  it('a taxi driver may add a police clearance (never a second ID); it shows in documents and never joins missing', async () => {
    const m = await mover('CAR');
    expect((await submit(m, 'police_clearance')).statusCode).toBe(201);
    const id = await submit(m, 'national_id');
    expect(id.statusCode).toBe(400);
    expect(id.json().error.code).toBe('INVALID_DOC_TYPE');
    const data = (await status(m.token)).json().data;
    expect(data.documents.map((d: { docType: string }) => d.docType)).toEqual(['police_clearance']);
    expect(data.missing).toEqual(TAXI);
  });

  it('an approved, current police clearance sets policeCleared; without it the taxi driver still operates', async () => {
    const m = await approvedTaxi();
    const verified = (await status(m.token)).json().data;
    expect(verified.roleVerified).toBe(true);
    expect(verified.policeCleared).toBe(false);
    expect(await taxiLive(m.userId)).toEqual({ allowed: true, reason: 'ok' });

    const pc = (await submit(m, 'police_clearance')).json().data.id as string;
    expect((await status(m.token)).json().data.policeCleared).toBe(false); // pending is not cleared
    await approve(pc, 'police_clearance', true);
    expect((await status(m.token)).json().data.policeCleared).toBe(true);
  });

  it('a lapsed optional police clearance never takes a taxi driver out of operation — only the flag drops', async () => {
    const m = await approvedTaxi();
    await approve((await submit(m, 'police_clearance')).json().data.id, 'police_clearance', true);
    await app.prisma.verificationDocument.updateMany({ where: { userId: m.userId, docType: 'police_clearance' }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await service.expireLapsedDocuments();
    expect(await taxiLive(m.userId)).toEqual({ allowed: true, reason: 'ok' });
    const data = (await status(m.token)).json().data;
    expect(data.policeCleared).toBe(false);
    expect(data.roleVerified).toBe(true);
    // ... and the person is told the truth: optional, keep working, no longer recorded as police-cleared.
    // No screen shows a "Police-cleared" badge yet, so no notice may promise one (GUARDRAILS §4).
    const note = await app.prisma.notification.findFirstOrThrow({ where: { userId: m.userId, data: { path: ['kind'], equals: 'verification_expired' } } });
    expect(note.body).toMatch(/optional/i);
    expect(note.body).toMatch(/no longer recorded as police-cleared until you upload a current one/);
    expect(note.body).not.toMatch(/badge/i);
    expect(note.body).not.toMatch(/keep operating/);
  });

  it('renewal reminders never threaten a suspension over an optional document, and still do for a required one', async () => {
    const m = await mover('CAR');
    const soon = new Date(Date.now() + 6 * DAY);
    for (const t of ['police_clearance', 'drivers_licence']) {
      const id = (await submit(m, t)).json().data.id as string;
      await service.approveDocument(id, adminId, soon);
    }
    await service.sendExpiryReminders();
    const notes = await app.prisma.notification.findMany({ where: { userId: m.userId, data: { path: ['kind'], equals: 'verification_expiry_reminder' } } });
    const about = (t: string) => notes.find((n) => n.body.startsWith(`Your ${t.replace(/_/g, ' ')} `))!;
    expect(about('police_clearance').body).toMatch(/optional and does not affect your work/);
    expect(about('police_clearance').body).toMatch(/Renew it to stay recorded as police-cleared/);
    expect(about('police_clearance').body).not.toMatch(/badge/i);
    expect(about('police_clearance').body).not.toMatch(/suspension/);
    expect(about('drivers_licence').body).toMatch(/Renew it to avoid suspension/);
  });
});

describe('[VERIFY-DOCS] build 9 compatibility: a client that reads only checklist / documents / roleVerified completes onboarding', () => {
  // Build 9 renders `checklist` as "Required steps", uploads each type in it with role MOVER, polls
  // until `roleVerified`, then switches to the home screen and goes online. Nothing else is read.
  type Build9Status = { checklist: string[]; documents: Array<{ id: string; docType: string; status: string }>; missing: string[]; roleVerified: boolean };
  it.each(['BICYCLE', 'MOTORCYCLE', 'CAR'] as const)('%s: upload every checklist document, a person approves, the mover is verified and live', async (vt) => {
    const m = await mover(vt);
    const first = (await status(m.token, vt)).json().data as Build9Status;
    expect(first.roleVerified).toBe(false);
    for (const docType of first.checklist) {
      const res = await submit(m, docType);
      expect(res.statusCode, docType).toBe(201);
      await approve(res.json().data.id, docType, m.driver);
    }
    const after = (await status(m.token)).json().data as Build9Status;
    expect(after.missing).toEqual([]);
    expect(after.roleVerified).toBe(true);
    for (const docType of after.checklist) expect(after.documents.find((d) => d.docType === docType)?.status, docType).toBe('APPROVED');
    if (m.driver) {
      expect(await service.getLiveOperationStatus(m.userId, { vehicleType: vt, kind: 'DRIVER' })).toEqual({ allowed: true, reason: 'ok' });
    } else {
      expect((await goOnline(m.token)).statusCode).toBe(200);
    }
  });

  it('a taxi on the new list still cannot carry passengers without HIRE-class insurance (gate not weakened)', async () => {
    const m = await mover('CAR');
    for (const docType of TAXI.filter((d) => d !== 'vehicle_insurance')) await approve((await submit(m, docType)).json().data.id, docType, true);
    const insurance = (await submit(m, 'vehicle_insurance')).json().data.id as string;
    // A reviewer cannot approve private cover for a passenger vehicle at all ...
    await expect(service.approveDocument(insurance, adminId, new Date(Date.now() + 300 * DAY),
      { insurerName: 'Synthetic Mutual', policyNumber: `PRIV-${nanoid(6)}`, coverageClass: 'PRIVATE', hireClassConfirmed: false, plateCrossChecked: true }))
      .rejects.toThrow(/HIRE-class insurance/);
    // ... so the taxi is neither verified nor able to operate.
    expect((await status(m.token)).json().data.missing).toEqual(['vehicle_insurance']);
    expect((await service.getLiveOperationStatus(m.userId, { vehicleType: 'CAR', kind: 'DRIVER' })).allowed).toBe(false);
  });

  it('a taxi missing the car photo is not verified (the photo that shows the plate stays required)', async () => {
    const m = await mover('CAR');
    for (const docType of TAXI.filter((d) => d !== 'vehicle_exterior_photo')) await approve((await submit(m, docType)).json().data.id, docType, true);
    const data = (await status(m.token)).json().data as Build9Status;
    expect(data.missing).toEqual(['vehicle_exterior_photo']);
    expect(data.roleVerified).toBe(false);
    expect(await service.getLiveOperationStatus(m.userId, { vehicleType: 'CAR', kind: 'DRIVER' })).toEqual({ allowed: false, reason: 'docs' });
  });
});

describe('[VERIFY-DOCS] the registry and the config say the same thing', () => {
  it('optional lists are non-blocking requirement items; the plate photo is no longer a taxi requirement', async () => {
    await system(() => seedDocRegistry(app.prisma));
    const set = (role: string) => app.prisma.requirementSet.findUniqueOrThrow({
      where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: 'GY', actorRole: role, tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
      include: { items: true },
    });
    const moverSet = await set('MOVER');
    const item = (s: typeof moverSet, code: string) => s.items.find((i) => i.docTypeCode === registryCode('GY', code));
    // [ROLE-DOCS · owner 21 Oct 2026] the base offers every mover nothing, optional or required
    expect(moverSet.items).toEqual([]);
    expect(item(await set('MOVER_NO_LICENCE'), 'national_id')?.isBlocking).toBe(true);
    const taxi = await set('MOVER_TAXI_EXTRA');
    expect(item(taxi, 'vehicle_plate_photo')).toBeUndefined();
    expect(item(taxi, 'vehicle_exterior_photo')?.isBlocking).toBe(true);
    // a taxi driver's optional police clearance joins the taxi set as a NON-blocking item; no national ID anywhere optional
    expect(item(taxi, 'police_clearance')?.isBlocking).toBe(false);
    expect(item(taxi, 'national_id')).toBeUndefined();
    expect(item(await set('MOVER_MOTOR'), 'national_id')).toBeUndefined();
  });

  it('a requirement the lists no longer name is removed from the registry on the next seed', async () => {
    await system(() => seedDocRegistry(app.prisma));
    const taxi = await app.prisma.requirementSet.findUniqueOrThrow({
      where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: 'GY', actorRole: 'MOVER_TAXI_EXTRA', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
    });
    // What an install seeded before the rulings still holds: a requirement the owner has lifted.
    const stale = registryCode('GY', 'national_id');
    await system(() => app.prisma.requirementItem.create({ data: { requirementSetId: taxi.id, docTypeCode: stale, isBlocking: true, minCount: 1, sortOrder: 99 } }));
    try {
      await system(() => seedDocRegistry(app.prisma));
      expect(await app.prisma.requirementItem.count({ where: { requirementSetId: taxi.id, docTypeCode: stale } })).toBe(0);
    } finally {
      await system(() => app.prisma.requirementItem.deleteMany({ where: { requirementSetId: taxi.id, docTypeCode: stale } }));
    }
  });

  it('[ROLE-DOCS] a whole seeded set whose list is gone (CUSTOMER_L2) is removed on the next seed; a migration-inserted set is kept', async () => {
    const stale = await system(() => app.prisma.requirementSet.upsert({
      where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: 'GY', actorRole: 'CUSTOMER_L2', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
      create: { countryCode: 'GY', actorRole: 'CUSTOMER_L2', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM },
      update: {},
    }));
    await system(() => app.prisma.requirementItem.upsert({
      where: { requirementSetId_docTypeCode: { requirementSetId: stale.id, docTypeCode: registryCode('GY', 'national_id') } },
      create: { requirementSetId: stale.id, docTypeCode: registryCode('GY', 'national_id'), isBlocking: true, minCount: 1, sortOrder: 0 },
      update: {},
    }));
    const kept = await system(() => app.prisma.requirementSet.create({ data: { countryCode: 'GY', actorRole: 'CUSTOMER_L2', tier: REGISTRY_TIER, effectiveFrom: new Date('2027-01-01T00:00:00.000Z') } }));
    try {
      await system(() => seedDocRegistry(app.prisma));
      expect(await app.prisma.requirementSet.count({ where: { id: stale.id } })).toBe(0);
      expect(await app.prisma.requirementItem.count({ where: { requirementSetId: stale.id } })).toBe(0);
      expect(await app.prisma.requirementSet.count({ where: { id: kept.id } })).toBe(1);
      // the lists the code still declares keep their sets
      expect(await app.prisma.requirementSet.count({ where: { countryCode: 'GY', actorRole: 'MOVER_TAXI_EXTRA', effectiveFrom: REGISTRY_EFFECTIVE_FROM } })).toBe(1);
    } finally {
      await system(() => app.prisma.requirementItem.deleteMany({ where: { requirementSetId: { in: [stale.id, kept.id] } } }));
      await system(() => app.prisma.requirementSet.deleteMany({ where: { id: { in: [stale.id, kept.id] } } }));
    }
  });

  it('once activated, a set with only optional documents still requires nothing', async () => {
    await system(() => seedDocRegistry(app.prisma));
    const codes = ['national_id', 'police_clearance'].map((c) => registryCode('GY', c));
    await system(() => app.prisma.docType.updateMany({ where: { code: { in: codes } }, data: { isActive: true, legalFactsVerifiedAt: new Date('2026-10-06T00:00:00.000Z') } }));
    try {
      // The MOVER set holds no blocking item: the registry speaks for no requirement.
      expect(await registryChecklist(app.prisma, 'GY', 'MOVER')).toBeNull();
      expect(await new CountryConfigService(app.prisma).getDocumentChecklist('GY', 'MOVER')).toEqual([]);
      // ... while a set whose BLOCKING item is now active answers with exactly that item — and an
      // optional item beside it (what a `<KEY>_OPTIONAL` list adds) never joins the answer.
      expect(await registryChecklist(app.prisma, 'GY', 'MOVER_NO_LICENCE')).toEqual(['national_id']);
      const set = await app.prisma.requirementSet.findUniqueOrThrow({
        where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: 'GY', actorRole: 'MOVER_NO_LICENCE', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
      });
      await system(() => app.prisma.requirementItem.create({ data: { requirementSetId: set.id, docTypeCode: codes[1]!, isBlocking: false, minCount: 1, sortOrder: 1000 } }));
      try {
        expect(await registryChecklist(app.prisma, 'GY', 'MOVER_NO_LICENCE')).toEqual(['national_id']);
      } finally {
        await system(() => app.prisma.requirementItem.deleteMany({ where: { requirementSetId: set.id, docTypeCode: codes[1]! } }));
      }
    } finally {
      await system(() => app.prisma.docType.updateMany({ where: { code: { in: codes } }, data: { isActive: false, legalFactsVerifiedAt: null } }));
    }
  });

  it('the platform note no longer says the Data Protection Act 2023 is in force', () => {
    const gy = desiredPlatformConfig().countries.find((c) => c.code === 'GY')!;
    const note = String(gy.policy['regulatoryNotes']);
    expect(note).toMatch(/not yet in force/i);
    expect(note).not.toMatch(/2023 in force/i);
  });
});

describe('[VERIFY-DOCS] services follow the home-visit rule; marketplace tradespeople and stores keep their lists', () => {
  // [VERIFY-DOCS · owner ruling 6 Oct ~21:25 GYT — a DELIBERATE change to this pin] The services
  // rule is decided: a service BUSINESS opens on its owner's ID and its home-visit bookings need
  // the owner's police clearance (verify-docs-home-visits.test.ts proves the booking side).
  // Marketplace tradespeople keep it required; the store lists are untouched.
  it('SERVICE opens on the owner’s ID (police clearance optional); SERVICE_PROVIDER and the store lists are unchanged', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE']).toEqual(['owner_national_id']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_OPTIONAL']).toEqual(['police_clearance']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER']).toEqual(['national_id', 'police_clearance']);
    // [VERIFY-DOCS · ruling 7] the TIN certificate left every store list
    // [FOOD-PERMIT · owner ruling 24 Oct 2026 — a DELIBERATE change] the food handler's certificate is optional for a
    // registered restaurant (RESTAURANT_OPTIONAL); its owner ticks for its food handlers instead
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT']).toEqual(['owner_national_id', 'business_registration', 'gra_restaurant_licence', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_OPTIONAL']).toEqual(['food_handler_cert']);
  });
});
