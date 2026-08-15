import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [ACTIVATION AUTHORITY — task #2 slice 1] Document truth drives activation:
//   STRAND-1  checklist completion IS vendor activation (PENDING_APPROVAL →
//             ACTIVE in the SAME decision transaction — no second admin event);
//   EV-ACT-11 admin vendor approve is checklist-gated + CAS;
//   EV-ACT-15 admin mover verify is checklist-gated; a negative decision
//             revokes live supply atomically;
//   STRAND-3  commercial classes: BUS needs its commercial documents at the
//             live gate, and can actually SUBMIT them (the old CAR-hard-coded
//             list made road_service_licence unsubmittable).
// SUPERMARKET checklist (GY): owner_national_id, business_registration,
// tin_certificate, storefront_photo. MOTORCYCLE mover checklist: national_id,
// police_clearance, drivers_licence, vehicle_registration, vehicle_insurance.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: VerificationService;
let adminToken: string;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
let seq = 0;

const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
const MOTORCYCLE_DOCS = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

async function makeUser(first: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59267${String((marker.charCodeAt(0) + seq) % 10)}${String(seq).padStart(4, '0')}`,
      firstName: first, lastName: `Act${seq}`,
      roles: ['VENDOR_OWNER', 'MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  userIds.push(user.id);
  return user;
}

async function approvedDoc(userId: string, docType: string, extra: Record<string, unknown> = {}) {
  return app.prisma.verificationDocument.create({
    data: {
      userId, role: 'VENDOR_OWNER' as never, docType, fileUrl: `test/${marker}/${docType}`,
      status: 'APPROVED', expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      ...extra,
    } as never,
  });
}

async function makePendingVendor(ownerUserId: string, status: 'PENDING_APPROVAL' | 'SUSPENDED' = 'PENDING_APPROVAL') {
  seq += 1;
  const vo = await app.prisma.vendorOwner.upsert({
    where: { userId: ownerUserId },
    update: {},
    create: { userId: ownerUserId },
  });
  return app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Act Mart ${seq}`, slug: `act-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET',
      phone: `+59268${String(seq).padStart(5, '0')}`, addressLine1: '1 Activation St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status, isVerified: false, acceptingOrders: false,
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  const admin = await loginWithOtp(app, '+5926001000');
  adminToken = admin.json().data.tokens.accessToken;
});

afterAll(async () => {
  if (userIds.length > 0) {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: userIds } } }, { driver: { userId: { in: userIds } } }, { vendor: { owner: { userId: { in: userIds } } } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('STRAND-1 — checklist completion IS vendor activation, atomically', () => {
  it('the final document approval promotes PENDING_APPROVAL → ACTIVE in the same decision', async () => {
    const owner = await makeUser('Strand');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS.slice(0, 3)) await approvedDoc(owner.id, docType);
    const last = await app.prisma.verificationDocument.create({
      data: {
        userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'storefront_photo',
        fileUrl: `test/${marker}/storefront`, status: 'PENDING',
      },
    });

    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));

    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    // The strand is dead: no admin /approve call, no billing event — the
    // completed, individually-reviewed checklist activated the store.
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.isVerified).toBe(true);
    expect(fresh.acceptingOrders).toBe(true);
  });

  it('promotion is PENDING_APPROVAL-only: a SUSPENDED store gains the flag, never status', async () => {
    const owner = await makeUser('Susp');
    const vendor = await makePendingVendor(owner.id, 'SUSPENDED');
    for (const docType of SUPERMARKET_DOCS.slice(0, 3)) await approvedDoc(owner.id, docType);
    const last = await app.prisma.verificationDocument.create({
      data: {
        userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'storefront_photo',
        fileUrl: `test/${marker}/storefront2`, status: 'PENDING',
      },
    });
    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(true);
    expect(fresh.status).toBe('SUSPENDED'); // admin/billing own that lifecycle
  });

  it('a rejected required document de-verifies the cached flag in the same decision', async () => {
    const owner = await makeUser('Deverify');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    // Verify through the projection (any decision run projects):
    const extra = await app.prisma.verificationDocument.create({
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'owner_national_id', fileUrl: `test/${marker}/renewal`, status: 'PENDING' },
    });
    await svc.approveDocument(extra.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).isVerified).toBe(true);

    // Now the ONLY storefront photo is administratively invalidated: simulate
    // purge (retention) then run any decision for this user — the projection
    // must follow document truth DOWN as well.
    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'storefront_photo' },
      data: { purgedAt: new Date(), fileUrl: '' },
    });
    const again = await app.prisma.verificationDocument.create({
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'tin_certificate', fileUrl: `test/${marker}/tin2`, status: 'PENDING' },
    });
    await svc.approveDocument(again.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false); // purged evidence no longer counts
  });
});

describe('STRAND-2 belt — the daily reconciler heals projection drift', () => {
  it('a stranded pre-cutover vendor (checklist complete, still PENDING_APPROVAL) is promoted by the reconciler', async () => {
    const owner = await makeUser('Heal');
    const vendor = await makePendingVendor(owner.id);
    // Complete evidence exists but NO decision transaction ever ran for it —
    // the exact shape a pre-slice-1 crash (or manual import) leaves behind.
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);

    const healed = await svc.reconcileVendorActivations();
    expect(healed).toBeGreaterThanOrEqual(1);
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.isVerified).toBe(true);
    expect(fresh.acceptingOrders).toBe(true);
  });

  it('a stale isVerified flag over purged evidence is revoked by the reconciler', async () => {
    const owner = await makeUser('Drift');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'ACTIVE', isVerified: true } });
    // Evidence dies outside any decision path (retention purge).
    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'business_registration' },
      data: { purgedAt: new Date(), fileUrl: '' },
    });
    await svc.reconcileVendorActivations();
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false); // cache follows document truth down
    expect(fresh.status).toBe('ACTIVE'); // lifecycle stays admin/billing-owned
  });
});

describe('EV-ACT-11 — admin vendor approve is checklist-gated and exactly-once', () => {
  it('refuses to activate a store whose checklist is incomplete (409 CHECKLIST_INCOMPLETE)', async () => {
    const owner = await makeUser('Gate');
    const vendor = await makePendingVendor(owner.id);
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('CHECKLIST_INCOMPLETE');
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.status).toBe('PENDING_APPROVAL');
    expect(fresh.isVerified).toBe(false);
  });

  it('activates once the checklist is complete; a double-tap has exactly one winner', async () => {
    const owner = await makeUser('Approve');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).status).toBe('ACTIVE');

    const dup = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error?.code ?? dup.json().code).toBe('ALREADY_ACTIVE');
  });
});

describe('EV-ACT-15 — admin mover verify is checklist-gated; rejection revokes supply atomically', () => {
  it('cannot bless a rider with missing evidence; verifies once the checklist is current', async () => {
    const user = await makeUser('Rider');
    const rider = await app.prisma.rider.create({
      data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false },
    });

    const refused = await app.inject({
      method: 'PUT', url: `/api/v1/admin/riders/${rider.id}/verify-documents`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe('CHECKLIST_INCOMPLETE');
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).documentsVerified).toBe(false);

    for (const docType of MOTORCYCLE_DOCS) await approvedDoc(user.id, docType);
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/admin/riders/${rider.id}/verify-documents`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).documentsVerified).toBe(true);
  });

  it('a negative decision forces an online rider offline in the same write', async () => {
    const user = await makeUser('Revoke');
    const rider = await app.prisma.rider.create({
      data: {
        userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
        documentsVerified: true, isOnline: true, isAvailable: true, locationSessionId: `sess-${marker}`,
      },
    });
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/riders/${rider.id}/verify-documents`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { verified: false, rejectionReason: 'plate mismatch' },
    });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(fresh.documentsVerified).toBe(false);
    expect(fresh.isOnline).toBe(false); // no dispatchable window until the daily sweep
    expect(fresh.locationSessionId).toBeNull();
  });
});

describe('STRAND-3 — commercial classes carry their own checklist', () => {
  it('a BUS_9 with only the taxi-car documents is not live; adding commercial docs completes it', async () => {
    const user = await makeUser('Bus');
    await app.prisma.driver.create({
      data: { userId: user.id, vehicleType: 'BUS_9' as never, documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleYear: 2022, vehicleColor: 'White', licensePlate: `BUS-${marker}-1`, driverLicenseUrl: 'test/lic1', vehicleInsuranceUrl: 'test/ins1' },
    });
    // Everything a CAR taxi needs, including confirmed HIRE insurance…
    const carDocs = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration',
      'hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert'];
    for (const docType of carDocs) await approvedDoc(user.id, docType);
    await approvedDoc(user.id, 'vehicle_insurance', {
      insurerName: 'GY Assure', policyNumber: `P-${marker}`, coverageClass: 'HIRE',
      hireClassConfirmed: true, plateCrossChecked: true,
    });

    // …is still NOT enough for a bus: the commercial checklist binds.
    const withoutCommercial = await svc.getLiveOperationStatus(user.id, { vehicleType: 'BUS_9' as never });
    expect(withoutCommercial.allowed).toBe(false);
    expect(withoutCommercial.reason).toBe('docs');

    await approvedDoc(user.id, 'road_service_licence');
    const withCommercial = await svc.getLiveOperationStatus(user.id, { vehicleType: 'BUS_9' as never });
    expect(withCommercial.allowed).toBe(true);
  });

  it('submitDocument accepts commercial types for a commercial mover and refuses them for a motorcycle', async () => {
    const busUser = await makeUser('BusSubmit');
    await app.prisma.driver.create({ data: { userId: busUser.id, vehicleType: 'BUS_9' as never, documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleYear: 2022, vehicleColor: 'White', licensePlate: `BUS-${marker}-2`, driverLicenseUrl: 'test/lic2', vehicleInsuranceUrl: 'test/ins2' } });
    // The union checklist admits the type (the old CAR-only list threw
    // INVALID_DOC_TYPE and made buses impossible to onboard).
    await expect(
      svc.submitDocument(busUser.id, 'MOVER', 'road_service_licence', `test/${marker}/rsl`, 'test-v1'),
    ).resolves.toBeTruthy();

    const bikeUser = await makeUser('BikeSubmit');
    await app.prisma.rider.create({ data: { userId: bikeUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false } });
    await expect(
      svc.submitDocument(bikeUser.id, 'MOVER', 'road_service_licence', `test/${marker}/rsl2`, 'test-v1'),
    ).rejects.toMatchObject({ code: 'INVALID_DOC_TYPE' });
  });
});
