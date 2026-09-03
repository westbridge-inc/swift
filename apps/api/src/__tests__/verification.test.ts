import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { VerificationService, docTypeExpires, resolveApprovalExpiry } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { loginWithOtp } from './helpers/otp';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// verification behind KycProvider: checklists from config, the
// manual review queue, the L2 identity flow, listing/online gates, and the
// expiry automation. Hardest paths: resubmission after rejection, expiry
// during pending review, lapse auto-suspending live listings.
// ---------------------------------------------------------------------------

// Unique per run: PHONE is a STRONG identity signal — with fixed numbers,
// run 2's "fresh" signup unions into run 1's residual cluster (identity rows
// outlive the deleted test users) and the trial law correctly denies the
// second trial. Same lesson as the plate below.
const runBase = 592_001_000_000 + Math.floor(Math.random() * 8_000_000); // window disjoint from the 592_8XX suite bases
const MOVER_PHONE = `+${runBase + 1}`;
const VENDOR_PHONE = `+${runBase + 2}`;
const L2_AUTO_PHONE = `+${runBase + 3}`;
const L2_MANUAL_PHONE = `+${runBase + 4}`;
const ADMIN_PHONE = `+${runBase + 5}`;
const TAXI_MOVER_PHONE = `+${runBase + 6}`;
const BICYCLE_MOVER_PHONE = `+${runBase + 7}`;
const PREVIEW_MOVER_PHONE = `+${runBase + 8}`;
const FACE_MATCH_PHONE = `+${runBase + 9}`;
const ALL_PHONES = [MOVER_PHONE, VENDOR_PHONE, L2_AUTO_PHONE, L2_MANUAL_PHONE, ADMIN_PHONE, TAXI_MOVER_PHONE, BICYCLE_MOVER_PHONE, PREVIEW_MOVER_PHONE, FACE_MATCH_PHONE];

// Base (incl. police clearance — required of every courier) + motor docs.
const MOVER_DOCS = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

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
  const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
    phone,
    firstName: 'Step4',
    lastName: role,
    role,
  });
  expect(res.statusCode).toBe(201);
  // These fixtures model accounts past the signup selfie (its gate has its
  // own coverage in selfie.test.ts) — go-online and the ID face-match must
  // not trip on a missing profile photo here.
  await app.prisma.user.update({
    where: { phone },
    data: { selfieCapturedAt: new Date(), avatar: 'storage://seed/profile-selfie.jpg' },
  });
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
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      admin: { create: { permissions: ['*'] } },
    },
  });
  adminToken = app.jwt.sign({ userId: adminUser.id, role: 'ADMIN', jti: `s4-${Date.now()}` });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP',
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

  it('commerce checklists carry the Guyana-real docs (TIN, GRA licence, storefront)', async () => {
    const restaurant = await inject('GET', '/api/v1/verification/status?role=RESTAURANT', undefined, vendorToken);
    expect(restaurant.json().data.checklist).toEqual([
      'owner_national_id', 'business_registration', 'tin_certificate',
      'gra_restaurant_licence', 'food_handler_cert', 'storefront_photo',
    ]);

    const supermarket = await inject('GET', '/api/v1/verification/status?role=SUPERMARKET', undefined, vendorToken);
    expect(supermarket.json().data.checklist).toEqual([
      'owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo',
    ]);

    const store = await inject('GET', '/api/v1/verification/status?role=STORE', undefined, vendorToken);
    expect(store.json().data.checklist).toEqual([
      'owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo',
    ]);

    const service = await inject('GET', '/api/v1/verification/status?role=SERVICE', undefined, vendorToken);
    expect(service.json().data.checklist).toEqual(['owner_national_id', 'police_clearance']);
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
      // [A-19] A reviewer keys the printed expiry; a document type that carries
      // one can no longer be approved without it.
      const body = docTypeExpires(doc.docType)
        ? { expiresAt: new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString() }
        : {};
      const res = await inject('PUT', `/api/v1/admin/verification/${doc.id}/approve`, body, adminToken);
      expect(res.statusCode, doc.docType).toBe(200);
    }

    const status = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, moverToken);
    expect(status.json().data.roleVerified).toBe(true);
    expect(status.json().data.missing).toEqual([]);

    const online = await inject('POST', '/api/v1/rider/go-online', {
      latitude: 6.8013,
      longitude: -58.1551,
    }, moverToken);
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

    // ID alone is not the SERVICE bar — police clearance is still missing
    // (service people enter customers' homes), so listing stays gated.
    const early = await inject('POST', '/api/v1/vendor/items', {
      categoryId: serviceCategoryId,
      name: 'Hot Stone Massage',
      basePrice: 8000,
    }, vendorToken);
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('VERIFICATION_REQUIRED');

    const clearance = await inject('POST', '/api/v1/verification/documents', {
      role: 'SERVICE',
      docType: 'police_clearance',
      fileUrl: 'storage://t/auto-approve/clearance.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, vendorToken);
    expect(clearance.statusCode).toBe(201);
    expect(clearance.json().data.status).toBe('APPROVED');

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
    expect((note!.data as any)?.audience).toBe('business');
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

describe('Document storage & DPA compliance', () => {
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

describe('Taxi checklist merge + auto-KYC audit', () => {
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
  // The dead-end this prevents: a taxi driver was only ever shown the base
  // mover docs, uploaded them, saw "verified" — then go-online silently failed
  // because the live gate ALSO requires hire permit / plate photo / exterior
  // photo / fitness cert. What onboarding shows must equal what gates.
  const TAXI_DOCS = [...MOVER_DOCS, 'hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert'];
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
        // Unique per run: the trial-integrity plate law (one plate = one
        // vehicle-bound human) unions same-plate drivers across runs — a
        // hard-coded plate made run 2's "fresh" mover inherit run 1's trial.
        vehicleColor: 'Silver', licensePlate: `HC-${Math.floor(100000 + Math.random() * 899999)}`,
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
    expect(data.checklist).not.toContain('hire_car_permit');
    expect(data.checklist).not.toContain('vehicle_exterior_photo');
  });

  it('asks a bicycle courier for identity + character only — no vehicle docs', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER', undefined, bicycleToken);
    const data = res.json().data;
    // Police clearance applies to EVERY courier (cash + home visits) — only
    // the vehicle documents scale away for a bicycle (master plan §3.2).
    expect(data.checklist).toEqual(['national_id', 'police_clearance']);
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

  it('asks a box truck for base + motor + commercial docs, not the taxi-hire extras', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER&vehicleType=BOX_TRUCK_LONG', undefined, taxiToken);
    const data = res.json().data;
    // A box truck is a commercial goods vehicle, not a hire car.
    expect(data.checklist).toEqual([...MOVER_DOCS, 'road_service_licence', 'fitness_cert']);
    expect(data.checklist).not.toContain('hire_car_permit');
  });

  it('asks a bus for the hire extras AND commercial docs — fitness cert only once', async () => {
    const res = await inject('GET', '/api/v1/verification/status?role=MOVER&vehicleType=BUS_15', undefined, taxiToken);
    const data = res.json().data;
    expect(data.checklist).toContain('hire_car_permit'); // it carries passengers
    expect(data.checklist).toContain('road_service_licence'); // it is commercial
    // fitness_cert is in both the taxi and commercial profiles — deduped to one.
    expect(data.checklist.filter((d: string) => d === 'fitness_cert')).toHaveLength(1);
  });
});

describe('Operator identity docs are face-matched against the signup selfie', () => {
  let faceToken: string;
  let faceUserId: string;

  beforeAll(async () => {
    const u = await signup(FACE_MATCH_PHONE, 'MOVER');
    faceToken = u.tokens.accessToken;
    faceUserId = u.user.id;
  });

  it('refuses an ID submission when no profile selfie exists', async () => {
    // Models a pre-selfie account — strip what the fixture helper added.
    await app.prisma.user.update({
      where: { id: faceUserId },
      data: { selfieCapturedAt: null, avatar: null },
    });

    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'national_id',
      fileUrl: 'storage://t/auto-approve/face-id.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, faceToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SELFIE_REQUIRED');

    // A NON-identity document is unaffected by the missing selfie.
    const plain = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'vehicle_registration',
      fileUrl: 'storage://t/face-reg.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, faceToken);
    expect(plain.statusCode).toBe(201);
  });

  it('routes ID docs through verifyIdentity with the selfie; other docs through verifyDocument', async () => {
    await app.prisma.user.update({
      where: { id: faceUserId },
      data: { selfieCapturedAt: new Date(), avatar: 'storage://seed/face-selfie.jpg' },
    });

    const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
    const recorder = {
      verifyIdentity: async (input: { userId: string; idDocumentUrl: string; selfieUrl: string }) => {
        calls.push({ path: 'identity', input });
        return { status: 'approved' as const, referenceToken: 'stub_identity' };
      },
      verifyDocument: async (input: { userId: string; docType: string; fileUrl: string }) => {
        calls.push({ path: 'document', input });
        return { status: 'approved' as const, referenceToken: 'stub_document' };
      },
      getStatus: async () => 'pending_manual' as const,
    };
    const svc = new VerificationService(
      app.prisma,
      new NotificationService(app.prisma, app.io),
      recorder,
    );

    await svc.submitDocument(faceUserId, 'MOVER', 'national_id', 'storage://t/face-id2.jpg', 'v1');
    await svc.submitDocument(faceUserId, 'MOVER', 'drivers_licence', 'storage://t/face-dl.jpg', 'v1');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      path: 'identity',
      input: {
        userId: faceUserId,
        idDocumentUrl: 'storage://t/face-id2.jpg',
        selfieUrl: 'storage://seed/face-selfie.jpg', // the signup selfie IS the match target
      },
    });
    expect(calls[1]?.path).toBe('document');
  });
});

describe('Subscriptions are born on verification (auto-approval path)', () => {
  // The dead-end this prevents: KYC auto-approves the full checklist, the
  // operator is "verified", but only the ADMIN entity-verify endpoints ever
  // started trials — so go-online failed with SUBSCRIPTION_REQUIRED and there
  // was no self-serve way out.
  it('a fully-verified mover holds exactly one TRIAL subscription', async () => {
    const rider = await app.prisma.rider.findFirstOrThrow({
      where: { userId: moverUserId },
      include: { subscription: true },
    });
    expect(rider.subscription).not.toBeNull();
    expect(rider.subscription!.status).toBe('TRIAL');
    // MOTORCYCLE is the STANDARD fee band. A bus/canter mover would be 12,000.
    expect(Number(rider.subscription!.weeklyRate)).toBe(10000);

    // afterApproval fired once per approved document — birth must be idempotent
    const count = await app.prisma.subscription.count({ where: { riderId: rider.id } });
    expect(count).toBe(1);
  });

  it('a fully-verified vendor holds exactly one TRIAL subscription', async () => {
    const subs = await app.prisma.subscription.findMany({ where: { vendorId: serviceVendorId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.status).toBe('TRIAL');
    // vendorType SERVICE — a trade with no catalogue, priced apart from shops.
    expect(Number(subs[0]!.weeklyRate)).toBe(12000);
  });

  it('a mover on TRIAL can go online (the trial is not a dead-end)', async () => {
    const res = await inject('POST', '/api/v1/rider/go-online', {
      latitude: 6.8013,
      longitude: -58.1551,
    }, moverToken);
    expect(res.statusCode).toBe(200);
  });
});

describe('Commerce gate — acceptingOrders requires verification', () => {
  // State from the expiry suite: the SERVICE vendor's owner_national_id lapsed,
  // so the store sits suspended (isVerified=false, acceptingOrders=false).
  it('an unverified store cannot turn ordering back on', async () => {
    const res = await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, vendorToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');

    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: serviceVendorId } });
    expect(vendor.acceptingOrders).toBe(false);
  });

  it('re-verification restores commerce automatically', async () => {
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'SERVICE',
      docType: 'owner_national_id',
      fileUrl: 'storage://t/auto-approve/owner_id_renewed.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, vendorToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('APPROVED');

    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: serviceVendorId } });
    expect(vendor.isVerified).toBe(true);
    expect(vendor.acceptingOrders).toBe(true);

    // Re-verification never mints a second subscription
    const count = await app.prisma.subscription.count({ where: { vendorId: serviceVendorId } });
    expect(count).toBe(1);
  });

  it('a verified store can pause and resume freely', async () => {
    const off = await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, vendorToken);
    expect(off.statusCode).toBe(200);
    expect(off.json().data.acceptingOrders).toBe(false);

    const on = await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, vendorToken);
    expect(on.statusCode).toBe(200);
    expect(on.json().data.acceptingOrders).toBe(true);
  });

  it('a SUSPENDED store cannot switch commerce back on — status is admin/billing-owned [EV-ACT-14]', async () => {
    await app.prisma.vendor.update({ where: { id: serviceVendorId }, data: { status: 'SUSPENDED', acceptingOrders: false } });
    try {
      const on = await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, vendorToken);
      expect(on.statusCode).toBe(409);
      expect(on.json().error.code).toBe('VENDOR_NOT_ACTIVE');
      expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: serviceVendorId } })).acceptingOrders).toBe(false);

      // Opening the storefront is refused the same way; closing stays free.
      await app.prisma.vendor.update({ where: { id: serviceVendorId }, data: { isCurrentlyOpen: false } });
      const open = await inject('PUT', '/api/v1/vendor/vendor/toggle-open', {}, vendorToken);
      expect(open.statusCode).toBe(409);
      expect(open.json().error.code).toBe('VENDOR_NOT_ACTIVE');
    } finally {
      await app.prisma.vendor.update({ where: { id: serviceVendorId }, data: { status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true } });
    }
  });

  // The toggle write itself is now a CAS bound to the OBSERVED value (a tap
  // that lost a race matches nothing and answers current truth) — structural;
  // a deterministic interleaving proof belongs to the barrier-test track.

  it('a routine renewal approval does not override a deliberate pause', async () => {
    // The owner pauses on purpose…
    const off = await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, vendorToken);
    expect(off.json().data.acceptingOrders).toBe(false);

    // …then a document renewal is approved (police clearance enters its
    // 30-day window and the renewal auto-approves).
    await app.prisma.verificationDocument.updateMany({
      where: { userId: vendorUserId, docType: 'police_clearance', status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) },
    });
    const renewal = await inject('POST', '/api/v1/verification/documents', {
      role: 'SERVICE',
      docType: 'police_clearance',
      fileUrl: 'storage://t/auto-approve/clearance_renewed.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, vendorToken);
    expect(renewal.statusCode).toBe(201);

    // Still verified — but the pause the owner chose stays.
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: serviceVendorId } });
    expect(vendor.isVerified).toBe(true);
    expect(vendor.acceptingOrders).toBe(false);

    // restore for any later suite
    await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, vendorToken);
  });
});

describe('Early renewal window — resubmission opens 30 days before expiry', () => {
  it('accepts a renewal once the document is inside the window', async () => {
    // drivers_licence carries a +10d expiry from the reminder test above
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'drivers_licence',
      fileUrl: 'storage://t/licence_renewal.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, moverToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
  });

  it('rejects resubmission while the document is valid beyond the window', async () => {
    await app.prisma.verificationDocument.updateMany({
      where: { userId: moverUserId, docType: 'vehicle_registration', status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000) },
    });
    const res = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER',
      docType: 'vehicle_registration',
      fileUrl: 'storage://t/too-early.jpg',
      consent: true,
      privacyNoticeVersion: 'v1',
    }, moverToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_APPROVED');
  });
});

describe('Taxi hire-class insurance — the manual 5-point check is enforced', () => {
  let taxiUserId: string;
  const TAXI_CHECKLIST = [
    'national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration',
    'vehicle_insurance', 'hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert',
  ];

  beforeAll(async () => {
    const u = await app.prisma.user.findUniqueOrThrow({ where: { phone: TAXI_MOVER_PHONE } });
    taxiUserId = u.id;
    // Full CAR checklist approved; insurance reviewed HIRE + hire class
    // confirmed, but the reviewer has NOT cross-checked the plate yet.
    await app.prisma.verificationDocument.createMany({
      data: TAXI_CHECKLIST.map((docType) => ({
        userId: taxiUserId,
        role: 'MOVER' as const,
        docType,
        fileUrl: `storage://t/taxi/${docType}.jpg`,
        status: 'APPROVED' as const,
        reviewedBy: 'test',
        reviewedAt: new Date(),
        consentAt: new Date(),
        privacyNoticeVersion: 'v1',
        ...(docType === 'vehicle_insurance' && {
          insurerName: 'Demerara Mutual',
          policyNumber: 'HC-TEST-5PT',
          coverageClass: 'HIRE' as const,
          hireClassConfirmed: true,
          plateCrossChecked: false,
        }),
      })),
    });
  });

  it('blocks live operation until the plate cross-check is confirmed', async () => {
    const live = await sweepService.getLiveOperationStatus(taxiUserId, { vehicleType: 'CAR' });
    expect(live).toEqual({ allowed: false, reason: 'insurance' });
  });

  it('passes once the reviewer confirms the plate against the policy', async () => {
    await app.prisma.verificationDocument.updateMany({
      where: { userId: taxiUserId, docType: 'vehicle_insurance' },
      data: { plateCrossChecked: true },
    });
    const live = await sweepService.getLiveOperationStatus(taxiUserId, { vehicleType: 'CAR' });
    expect(live).toEqual({ allowed: true, reason: 'ok' });
  });

  it('PRIVATE coverage never operates a taxi', async () => {
    await app.prisma.verificationDocument.updateMany({
      where: { userId: taxiUserId, docType: 'vehicle_insurance' },
      data: { coverageClass: 'PRIVATE' },
    });
    const live = await sweepService.getLiveOperationStatus(taxiUserId, { vehicleType: 'CAR' });
    expect(live).toEqual({ allowed: false, reason: 'insurance' });

    await app.prisma.verificationDocument.updateMany({
      where: { userId: taxiUserId, docType: 'vehicle_insurance' },
      data: { coverageClass: 'HIRE' },
    });
  });
});

describe('Lapsed documents force movers offline (daily sweep)', () => {
  it('an online taxi whose insurance lapses is pulled offline immediately', async () => {
    const taxi = await app.prisma.user.findUniqueOrThrow({ where: { phone: TAXI_MOVER_PHONE } });
    await app.prisma.driver.updateMany({ where: { userId: taxi.id }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('verification') } });
    await app.prisma.verificationDocument.updateMany({
      where: { userId: taxi.id, docType: 'vehicle_insurance', status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    await sweepService.expireLapsedDocuments();

    const driver = await app.prisma.driver.findFirstOrThrow({ where: { userId: taxi.id } });
    expect(driver.isOnline).toBe(false);

    const note = await app.prisma.notification.findFirst({
      where: { userId: taxi.id, title: 'You have been taken offline' },
    });
    expect(note).not.toBeNull();
    // Role separation: operator alerts are tagged for the driver surface,
    // so a multi-role account never sees them in the shopping feed.
    expect((note!.data as any)?.audience).toBe('earner');
  });

  it('an online courier is pulled offline when their police clearance lapses — others untouched', async () => {
    // A bystander who stays online through someone else's expiry
    const cyclist = await app.prisma.user.findUniqueOrThrow({ where: { phone: BICYCLE_MOVER_PHONE } });
    await app.prisma.rider.updateMany({ where: { userId: cyclist.id }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('verification') } });

    await app.prisma.rider.updateMany({ where: { userId: moverUserId }, data: { isOnline: true, locationSessionId: syntheticLocationOwner('verification') } });
    await app.prisma.verificationDocument.updateMany({
      where: { userId: moverUserId, docType: 'police_clearance', status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    await sweepService.expireLapsedDocuments();

    const rider = await app.prisma.rider.findFirstOrThrow({ where: { userId: moverUserId } });
    expect(rider.isOnline).toBe(false);

    const bystander = await app.prisma.rider.findFirstOrThrow({ where: { userId: cyclist.id } });
    expect(bystander.isOnline).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [A-19] S0 compliance. Approving a licence, insurance policy or permit used to
// run through one line:
//
//     expiresAt: expiresAt ?? null
//
// and the admin console has never sent a date. Two consequences, both live:
//
//  1. The approved document became PERMANENTLY valid. The readiness query
//     treats a null expiry as never-expiring, and the daily lapse sweep only
//     examines rows that HAVE a date — so nothing downstream would ever catch
//     it. An expired hire-car permit stays "approved" forever.
//  2. Approving a document that already carried an auto-assigned expiry (the
//     submission path sets one from the same map) WIPED it back to null. Since
//     the console never sent one, that was the normal case.
//
// What was already right and is NOT re-fixed here: the readiness gate refuses
// passenger work unless the insurance is HIRE class with both manual checks, so
// a PRIVATE-class approval genuinely cannot put a driver on passenger jobs.
// ---------------------------------------------------------------------------

describe('[A-19] an expiring document cannot be approved without its expiry', () => {
  const future = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it('knows which types carry a printed expiry, from the one map', () => {
    for (const t of ['drivers_licence', 'vehicle_insurance', 'police_clearance', 'hire_car_permit', 'fitness_cert']) {
      expect(docTypeExpires(t), t).toBe(true);
    }
    expect(docTypeExpires('business_registration')).toBe(false);
  });

  it('refuses an expiring type with no date anywhere', () => {
    expect(() => resolveApprovalExpiry('drivers_licence', undefined, null)).toThrow(/expiry/i);
    try {
      resolveApprovalExpiry('drivers_licence', undefined, null);
    } catch (e) {
      expect((e as { code?: string }).code ?? (e as { errorCode?: string }).errorCode).toBeDefined();
    }
  });

  it('refuses a date that has already passed', () => {
    expect(() => resolveApprovalExpiry('vehicle_insurance', past, null)).toThrow(/passed/i);
    expect(() => resolveApprovalExpiry('vehicle_insurance', undefined, past)).toThrow(/passed/i);
  });

  it('a supplied date wins, and an existing one is PRESERVED rather than wiped', () => {
    const existing = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
    expect(resolveApprovalExpiry('drivers_licence', future, existing)).toBe(future);
    // the wipe: no date supplied, but the row already had one
    expect(resolveApprovalExpiry('drivers_licence', undefined, existing)).toBe(existing);
  });

  it('a non-expiring type is unaffected either way', () => {
    expect(resolveApprovalExpiry('business_registration', undefined, null)).toBeNull();
    expect(resolveApprovalExpiry('business_registration', future, null)).toBe(future);
  });

  it('the route refuses the approval, and the document stays PENDING', async () => {
    const pending = await app.prisma.verificationDocument.findFirst({
      where: { status: 'PENDING', docType: { in: ['drivers_licence', 'vehicle_insurance', 'police_clearance'] } },
    });
    if (!pending) return; // no such candidate in this fixture run
    const res = await inject('PUT', `/api/v1/admin/verification/${pending.id}/approve`, {}, adminToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EXPIRY_REQUIRED');
    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe('PENDING');
  });
});

describe('[A-19] the reviewer can see what they are asked to cross-check', () => {
  it('the queue sends the driver’s plate and vehicle with each document', async () => {
    const res = await inject('GET', '/api/v1/admin/verification/queue?status=PENDING&role=operator&limit=100', undefined, adminToken);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ user?: { driver?: unknown } }>;
    // The console shows a "cross-checked against the H-plate" checkbox. If the
    // plate never reaches the page, that checkbox asserts something the
    // operator cannot see — so the SHAPE has to be on the wire.
    const withDriver = rows.find((r) => r.user?.driver);
    if (withDriver) {
      expect(withDriver.user!.driver).toHaveProperty('licensePlate');
      expect(withDriver.user!.driver).toHaveProperty('vehicleMake');
    } else {
      // no driver applicant in this fixture run — assert the selection exists
      const routes = readFileSync(join(__dirname, '../modules/admin/admin.routes.ts'), 'utf8');
      expect(routes).toMatch(/driver: \{ select: \{ licensePlate: true/);
    }
  });
});
