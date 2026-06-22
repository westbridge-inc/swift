import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// Step 4 — verification behind KycProvider: checklists from config, the
// manual review queue, the L2 identity flow, listing/online gates, and the
// expiry automation. Hardest paths: resubmission after rejection, expiry
// during pending review, lapse auto-suspending live listings.
// ---------------------------------------------------------------------------

const MOVER_PHONE = '+5920004444';
const VENDOR_PHONE = '+5920005555';
const L2_AUTO_PHONE = '+5920006666';
const L2_MANUAL_PHONE = '+5920007777';
const ADMIN_PHONE = '+5920004445';
const TAXI_MOVER_PHONE = '+5920004446';
const BICYCLE_MOVER_PHONE = '+5920004447';
const PREVIEW_MOVER_PHONE = '+5920004448';
const ALL_PHONES = [MOVER_PHONE, VENDOR_PHONE, L2_AUTO_PHONE, L2_MANUAL_PHONE, ADMIN_PHONE, TAXI_MOVER_PHONE, BICYCLE_MOVER_PHONE, PREVIEW_MOVER_PHONE];

const MOVER_DOCS = ['national_id', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

let app: FastifyInstance;
let sweepService: VerificationService;
let adminToken: string;
let moverToken: string;
let moverUserId: string;
let vendorToken: string;
let vendorUserId: string;
let serviceVendorId: string;
let serviceCategoryId: string;

async function cleanup() {
  const users = await app.prisma.user.findMany({ where: { phone: { in: ALL_PHONES } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function signup(phone: string, role: 'CUSTOMER' | 'MOVER' | 'VENDOR') {
  await loginWithOtp(app, phone);
  const res = await inject('POST', '/api/v1/auth/register', {
    phone,
    firstName: 'Step4',
    lastName: role,
    role,
  });
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  await cleanup();
  for (const phone of ALL_PHONES) {
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_attempt:${phone}`, `otp_verified:${phone}`);
  }

  sweepService = new VerificationService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getKycProvider(),
  );

  // Own admin via direct session — never race the seeded admin phone
  const adminUser = await app.prisma.user.create({
    data: {
      phone: ADMIN_PHONE,
      firstName: 'Step4',
      lastName: 'Admin',
      roles: ['ADMIN'],
      activeRole: 'ADMIN',
      isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  adminToken = app.jwt.sign({ userId: adminUser.id, role: 'ADMIN', jti: `s4-${Date.now()}` });
  await app.prisma.session.create({
    data: {
      userId: adminUser.id,
      token: adminToken,
      refreshToken: `s4-refresh-${Date.now()}`,
      deviceId: 'step4-admin',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  // Mover with a rider record (created during later onboarding in real flows)
  const mover = await signup(MOVER_PHONE, 'MOVER');
  moverToken = mover.tokens.accessToken;
  moverUserId = mover.user.id;
  await app.prisma.rider.create({
    data: { userId: moverUserId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });

  // Vendor owner with an ACTIVE but unverified SERVICE vendor
  const vendor = await signup(VENDOR_PHONE, 'VENDOR');
  vendorToken = vendor.tokens.accessToken;
  vendorUserId = vendor.user.id;
  const owner = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId: vendorUserId } });
  const serviceVendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: 'Step4 Spa',
      slug: 'step4-spa',
      vendorType: 'SERVICE',
      phone: VENDOR_PHONE,
      addressLine1: '1 Test Lane',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      status: 'ACTIVE',
      acceptingOrders: true,
    },
  });
  serviceVendorId = serviceVendor.id;
  const category = await app.prisma.category.create({
    data: { vendorId: serviceVendorId, name: 'Treatments', sortOrder: 0 },
  });
  serviceCategoryId = category.id;
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('Checklists drive from config', () => {
  it('returns the country checklist with everything missing for a fresh mover', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, moverToken);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.checklist).toEqual(MOVER_DOCS);
    expect(data.missing).toEqual(MOVER_DOCS);
    expect(data.roleVerified).toBe(false);
  });

  it('rejects a document type that is not on the checklist', async () => {
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'boat_licence',
      fileUrl: 'storage://t/boat.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, moverToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_DOC_TYPE');
  });
});

describe('Gating — no work until verified', () => {
  it('an unverified mover cannot go online', async () => {
    const res = await inject('POST', '/api/v1/rider/go-online', {}, moverToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
  });

  it('an unverified vendor cannot list items', async () => {
    const res = await inject('POST', '/api/v1/vendor/items', {
      categoryId: serviceCategoryId,
      name: 'Hot Stone Massage',
      basePrice: 8000,
    }, vendorToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
  });
});

describe('Manual review queue — submit, reject, resubmit, approve', () => {
  let rejectedDocId: string;

  it('submitted documents land in the admin queue as PENDING', async () => {
    for (const docType of MOVER_DOCS) {
      const res = await inject('POST', '/api/v1/verification/documents', {
        role: 'MOVER',
        docType,
        fileUrl: `storage://t/${docType}.jpg`,
        consent: true,
        privacyNoticeVersion: 'v1',
      }, moverToken);
      expect(res.statusCode).toBe(201);
      expect(res.json().data.status).toBe('PENDING');
    }

    const queue = await inject('GET', '/api/v1/admin/verification/queue?limit=50', undefined, adminToken);
    expect(queue.statusCode).toBe(200);
    const docTypes = queue.json().data
      .filter((d: { userId: string }) => d.userId === moverUserId)
      .map((d: { docType: string }) => d.docType);
    for (const docType of MOVER_DOCS) expect(docTypes).toContain(docType);
  });

  it('rejection notifies the applicant with the reason (resubmit path)', async () => {
    const doc = await app.prisma.verificationDocument.findFirstOrThrow({
      where: { userId: moverUserId, docType: 'national_id', status: 'PENDING' },
    });
    rejectedDocId = doc.id;

    const res = await inject('PUT', `/api/v1/admin/verification/${doc.id}/reject`, {
      reason: 'Photo is blurry',
    }, adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('REJECTED');

    const note = await app.prisma.notification.findFirst({
      where: { userId: moverUserId, body: { contains: 'Photo is blurry' } },
    });
    expect(note).not.toBeNull();
  });

  it('a rejected document cannot be re-reviewed', async () => {
    const res = await inject('PUT', `/api/v1/admin/verification/${rejectedDocId}/approve`, {}, adminToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_PENDING');
  });

  it('resubmission after rejection creates a fresh PENDING document', async () => {
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'national_id',
      fileUrl: 'storage://t/national_id_v2.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, moverToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
    expect(res.json().data.id).not.toBe(rejectedDocId);
  });

  it('approving the full checklist verifies the role and opens the gate', async () => {
    const pending = await app.prisma.verificationDocument.findMany({
      where: { userId: moverUserId, status: 'PENDING' },
    });
    for (const doc of pending) {
      const res = await inject('PUT', `/api/v1/admin/verification/${doc.id}/approve`, {}, adminToken);
      expect(res.statusCode).toBe(200);
    }

    const status = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, moverToken);
    expect(status.json().data.roleVerified).toBe(true);
    expect(status.json().data.missing).toEqual([]);

    const online = await inject('POST', '/api/v1/rider/go-online', {}, moverToken);
    expect(online.statusCode).toBe(200);
  });

  it('an approved document cannot be submitted again', async () => {
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'national_id',
      fileUrl: 'storage://t/dupe.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, moverToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_APPROVED');
  });
});

describe('Provider auto-decisions (swappable interface)', () => {
  it('auto-approves the vendor checklist and unlocks listing', async () => {
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'SERVICE',
      docType: 'owner_national_id',
      fileUrl: 'storage://t/auto-approve/owner_id.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, vendorToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('APPROVED');
    expect(res.json().data.kycRef).toMatch(/^sbx_/);

    const listing = await inject('POST', '/api/v1/vendor/items', {
      categoryId: serviceCategoryId,
      name: 'Hot Stone Massage',
      basePrice: 8000,
      fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 60, slots: [{ dayOfWeek: 5, start: '10:00', end: '16:00' }] },
    }, vendorToken);
    expect(listing.statusCode).toBe(200);

    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: serviceVendorId } });
    expect(vendor.isVerified).toBe(true);
  });
});

describe('L2 identity — permanent customer verification', () => {
  it('auto-approval promotes to L2 immediately', async () => {
    const customer = await signup(L2_AUTO_PHONE, 'CUSTOMER');
    const res = await inject('POST', '/api/v1/verification/identity', {
      idDocumentUrl: 'storage://t/auto-approve/id.jpg',
      selfieUrl: 'storage://t/selfie.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, customer.tokens.accessToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('APPROVED');

    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: L2_AUTO_PHONE } });
    expect(user.trustLevel).toBe('L2');

    // Already verified — no second submission
    const again = await inject('POST', '/api/v1/verification/identity', {
      idDocumentUrl: 'storage://t/id2.jpg',
      selfieUrl: 'storage://t/selfie2.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, customer.tokens.accessToken);
    expect(again.statusCode).toBe(409);
  });

  it('manual path: pending review, then admin approval promotes to L2', async () => {
    const customer = await signup(L2_MANUAL_PHONE, 'CUSTOMER');
    const res = await inject('POST', '/api/v1/verification/identity', {
      idDocumentUrl: 'storage://t/id.jpg',
      selfieUrl: 'storage://t/selfie.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, customer.tokens.accessToken);
    expect(res.json().data.status).toBe('PENDING');

    const approve = await inject('PUT', `/api/v1/admin/verification/${res.json().data.id}/approve`, {}, adminToken);
    expect(approve.statusCode).toBe(200);

    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: L2_MANUAL_PHONE } });
    expect(user.trustLevel).toBe('L2');
  });
});

describe('Expiry automation', () => {
  it('expires a document that lapses DURING pending review', async () => {
    const doc = await app.prisma.verificationDocument.create({
      data: {
        userId: moverUserId,
        role: 'MOVER',
        docType: 'vehicle_insurance',
        fileUrl: 'storage://t/lapsing.jpg',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    await sweepService.expireLapsedDocuments();

    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('EXPIRED');
  });

  it('a lapsed critical document auto-suspends the vendor listings', async () => {
    // The SERVICE vendor's only checklist doc lapses
    await app.prisma.verificationDocument.updateMany({
      where: { userId: vendorUserId, docType: 'owner_national_id', status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const expired = await sweepService.expireLapsedDocuments();
    expect(expired).toBeGreaterThan(0);

    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: serviceVendorId } });
    expect(vendor.acceptingOrders).toBe(false);
    expect(vendor.isVerified).toBe(false);

    const liveItems = await app.prisma.item.count({
      where: { vendorId: serviceVendorId, isAvailable: true },
    });
    expect(liveItems).toBe(0);

    const note = await app.prisma.notification.findFirst({
      where: { userId: vendorUserId, title: 'Document expired' },
    });
    expect(note).not.toBeNull();
  });

  it('sends exactly one 30-day reminder per expiring document', async () => {
    await app.prisma.verificationDocument.updateMany({
      where: { userId: moverUserId, docType: 'drivers_licence', status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) },
    });

    const first = await sweepService.sendExpiryReminders();
    expect(first).toBeGreaterThanOrEqual(1);

    const second = await sweepService.sendExpiryReminders();
    expect(second).toBe(0);
  });
});

describe('Phase 2 — document storage & DPA compliance', () => {
  it('rejects a document upload without consent (DPA §3.5)', async () => {
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'national_id',
      fileUrl: 'storage://t/no-consent.jpg',
      // consent + privacyNoticeVersion intentionally omitted
    }, moverToken);
    expect(res.statusCode).toBe(400);
  });

  it('issues a short-lived signed URL and audit-logs the access', async () => {
    const doc = await app.prisma.verificationDocument.create({
      data: {
        userId: moverUserId,
        role: 'MOVER',
        docType: 'national_id',
        fileUrl: '/uploads/verification/signed-me.jpg',
        status: 'PENDING',
        consentAt: new Date(),
        privacyNoticeVersion: 'v1',
      },
    });

    const res = await inject('GET', `/api/v1/admin/verification/${doc.id}/document-url`, undefined, adminToken);
    expect(res.statusCode).toBe(200);
    const { url, expiresInSeconds } = res.json().data;
    expect(expiresInSeconds).toBeGreaterThan(0);
    // Signed + time-limited — never a raw public link
    expect(url).toContain('expires=');
    expect(url).toContain('signed-me.jpg');

    const access = await app.prisma.auditLog.findFirst({
      where: { action: 'VIEW_VERIFICATION_DOC', entityId: doc.id },
    });
    expect(access).not.toBeNull();
  });

  it('retention purge deletes the object, clears the key, and blocks viewing (410)', async () => {
    const doc = await app.prisma.verificationDocument.create({
      data: {
        userId: moverUserId,
        role: 'MOVER',
        docType: 'national_id',
        fileUrl: '/uploads/verification/purge-me.jpg',
        status: 'APPROVED',
        consentAt: new Date(),
        privacyNoticeVersion: 'v1',
        retentionExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const purged = await sweepService.purgeExpiredDocuments();
    expect(purged).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.purgedAt).not.toBeNull();
    expect(after.fileUrl).toBe('');

    const view = await inject('GET', `/api/v1/admin/verification/${doc.id}/document-url`, undefined, adminToken);
    expect(view.statusCode).toBe(410);
  });

  it('scheduleDocumentRetention sets a future deletion date from CountryConfig', async () => {
    const doc = await app.prisma.verificationDocument.create({
      data: {
        userId: moverUserId,
        role: 'MOVER',
        docType: 'national_id',
        fileUrl: '/uploads/verification/retain-me.jpg',
        status: 'APPROVED',
        consentAt: new Date(),
        privacyNoticeVersion: 'v1',
      },
    });

    const count = await sweepService.scheduleDocumentRetention(moverUserId);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.retentionExpiresAt).not.toBeNull();
    expect(after.retentionExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('Phase 3 — taxi checklist merge + auto-KYC audit', () => {
  it('a mover can submit a taxi-only document and the auto-approval is audited', async () => {
    // hire_car_permit lives in MOVER_TAXI_EXTRA — only submittable via the merge
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'hire_car_permit',
      fileUrl: 'storage://t/auto-approve/hire_permit.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, moverToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('APPROVED');

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: 'KYC_AUTO_APPROVE', entityId: res.json().data.id },
    });
    expect(audit).not.toBeNull();
  });
});

describe('Taxi movers are shown — and gated on — the taxi-extra checklist', () => {
  // The dead-end this prevents: a taxi driver was only ever shown the 4 base
  // mover docs, uploaded them, saw "verified" — then go-online silently failed
  // because the live gate ALSO requires hire permit / plate photo / police
  // clearance / fitness cert. What onboarding shows must equal what gates.
  const TAXI_DOCS = [...MOVER_DOCS, 'hire_car_permit', 'vehicle_plate_photo', 'police_clearance', 'fitness_cert'];
  let taxiToken: string;
  let bicycleToken: string;

  beforeAll(async () => {
    const taxi = await signup(TAXI_MOVER_PHONE, 'MOVER');
    taxiToken = taxi.tokens.accessToken;
    // A car-for-hire mover has a Driver entity; bike/moto couriers have a Rider.
    await app.prisma.driver.create({
      data: {
        userId: taxi.user.id,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
        vehicleColor: 'Silver', licensePlate: 'HC-S4TAXI',
        driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
      },
    });
    const cyclist = await signup(BICYCLE_MOVER_PHONE, 'MOVER');
    bicycleToken = cyclist.tokens.accessToken;
    await app.prisma.rider.create({
      data: { userId: cyclist.user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' },
    });
  });

  it('surfaces police clearance + the taxi extras in the onboarding checklist', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, taxiToken);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.checklist).toEqual(TAXI_DOCS);
    expect(data.missing).toContain('police_clearance');
    expect(data.roleVerified).toBe(false);
  });

  it('does not over-ask a motorcycle courier for taxi docs', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, moverToken);
    const data = res.json().data;
    expect(data.checklist).toEqual(MOVER_DOCS);
    expect(data.checklist).not.toContain('police_clearance');
  });

  it('asks a bicycle courier for identity only — no licence/registration/insurance', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, bicycleToken);
    const data = res.json().data;
    expect(data.checklist).toEqual(['national_id']);
    expect(data.checklist).not.toContain('drivers_licence');
    expect(data.checklist).not.toContain('vehicle_insurance');
    expect(data.vehicleType).toBe('BICYCLE');
  });

  it('previews a vehicle selection before it is saved (display hint, gates ignore it)', async () => {
    // A fresh mover (no entity) selecting CAR should see the taxi docs as a preview.
    const fresh = await signup(PREVIEW_MOVER_PHONE, 'MOVER');
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER&vehicleType=CAR', undefined, fresh.tokens.accessToken);
    const data = res.json().data;
    expect(data.checklist).toEqual(TAXI_DOCS);
    expect(data.vehicleType).toBeNull(); // nothing saved yet — gate would use the entity
  });
});
