import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';
/**
 * [REVIEW-PARTNER · lane row 53] The store-review fiction's demo RIDER and taxi
 * DRIVER: two logins an App Store / Play reviewer uses to reach the partner
 * app, and that the Play background-location video records going online.
 *
 * Everything runs through the operator's own commands (provision → seed) and
 * the routes the apps call. What it proves:
 *   - provision mints a RIDER and a DRIVER login beside the CUSTOMER one, each
 *     its own fictional identifier and static code (DL-6: no SMS; a code opens
 *     only its own identifier);
 *   - the seed makes both verified partners INSIDE the REVIEW tenant with the
 *     production verification states (COMMITTED submissions, VALID document
 *     records, the hire insurance a taxi needs), a drawn profile photo, no
 *     file, no fee, no global audit trace — and is idempotent;
 *   - both go online, stream location and see an honestly EMPTY board;
 *   - tenant isolation both ways: a review partner never sees, takes or is
 *     offered production work, a store or a payout; a production customer
 *     never sees a review partner (presence, supply, availability, dispatch);
 *   - the board stays empty: the fiction books no taxi or parcel (DL-5);
 *   - no money and no SMS: no weekly fee row, every fee/MMG surface refused,
 *     step-up confirms with the static code and texts nobody — while a
 *     production driver with no weekly plan is still refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { authRoutes } from '../modules/auth/auth.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { devChannelLog } from '../providers/notifications/channels';
import { provisionReviewTenant, reviewStatus } from '../modules/review/provision';
import { seedReviewContentPack, planReviewContentPack, reviewContentPackFacts } from '../modules/review/content-pack';
import { seedReviewPartners, REVIEW_PACK_PARTNERS, REVIEW_PACK_REVIEWER, partnerPortraitUrl, packPartnerDocuments } from '../modules/review/partner-pack';
import { REVIEW_DEMO_NO_ORDERS, REVIEW_DEMO_NO_BOOKINGS_MESSAGE, REVIEW_DEMO_NO_MONEY } from '../modules/review/demo-policy';
import { hasStepUp, reviewStepUpKey } from '../modules/auth/step-up';
import { hashReviewCode } from '../modules/review/credentials';
import { PACK_IMAGE_WIDTH, PACK_IMAGE_HEIGHT } from '../modules/review/pack-image';
import { commitReviewFixtureDocument } from '../modules/verification/verification.service';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adsRoutes } from '../modules/ads/ads.routes';
import { servicesRoutes } from '../modules/services/services.routes';
import { stageMmgLinkChange, clearMmgLink, cancelMmgLinkChange, applyDueMmgLinkChanges } from '../modules/integrity/money-surface';
import { sendStepUpOtp, verifyStepUp, stepUpKey } from '../modules/auth/step-up';
import { REVIEW_DEMO_NO_NEW_ROLES } from '../modules/review/demo-policy';
import { CountryConfigService } from '../modules/country/country-config.service';

/** Advertising is closed at launch (ADS_ENABLED); the demo's own refusal sits
 *  behind that switch, so it is graded with advertising switched on. */
async function withAdsOn<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env['ADS_ENABLED'];
  process.env['ADS_ENABLED'] = '1';
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env['ADS_ENABLED']; else process.env['ADS_ENABLED'] = prior;
  }
}

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REVIEW = `review-partner-${RUN}`;
const PRODUCTION = 'swift-default';
const UPLOAD_DIR = `/tmp/review-partner-test-uploads-${RUN}`;
/** A remote point inside Guyana, far from every other suite's fixtures: tenancy alone separates the movers here. */
const SPOT = { lat: 6.3107, lng: -57.5321 };
/** ~300 m north: the production movers sit a little FURTHER from the pickup than the review partners. */
const NEAR = { lat: SPOT.lat + 0.0027, lng: SPOT.lng };
const DAY = 86_400_000;
/** Production fixture phones: +59200064 + 4 digits of this run (a range no other suite uses). */
const prodPhoneBase = `+59200064${String(Math.floor(Math.random() * 90) + 10)}`;

let app: FastifyInstance;
let dispatch: DispatchService;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'review-partner-demo-test');
const creds: Record<'CUSTOMER' | 'RIDER' | 'DRIVER', { identifier: string; code: string }> = {} as never;
const review = { customerId: '', riderUserId: '', driverUserId: '', riderId: '', driverId: '' };
const tokens = { customer: '', rider: '', driver: '', riderSession: '', driverSession: '' };
const prod = {
  customerId: '', customerToken: '', ownerUserId: '', vendorId: '',
  riderUserId: '', riderId: '', riderSession: '', driverUserId: '', driverId: '', driverToken: '', driverSession: '',
  deliveryOrderId: '', taxiOrderId: '', settlementId: '',
};
const prodUserIds: string[] = [];
let prodSeq = 0;
/** The country's mover checklists for the pack's two vehicles — the lists the go-online gate reads. */
let riderChecklist: string[] = [];
let driverChecklist: string[] = [];
/** [VERIFY-DOCS] what each vehicle REQUIRES (the app's checklist); the pack partners present these plus an identity document. */
let riderRequired: string[] = [];
let driverRequired: string[] = [];

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: auth(token) });
const post = (url: string, token: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });
const put = (url: string, token: string, payload: unknown = {}) => app.inject({ method: 'PUT', url, headers: auth(token), payload: payload as never });
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);

async function signIn(identifier: string, code: string) {
  await app.redis.del(`otp_rate:${identifier}`, `review_otp_fail:${identifier}`);
  const sent = await app.inject({ method: 'POST', url: '/api/v1/auth/send-otp', payload: { phone: identifier } });
  expect(sent.statusCode, sent.body).toBe(200);
  return app.inject({
    method: 'POST', url: '/api/v1/auth/verify-otp', payload: { phone: identifier, code },
    headers: { 'x-device-id': `rp-${RUN}-${identifier.slice(-2)}`, 'x-device-type': 'test' },
  });
}

async function prodUser(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}) {
  prodSeq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `${prodPhoneBase}${String(prodSeq).padStart(2, '0')}`, firstName: 'Real', lastName: `Person${prodSeq}`,
    roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', tenantId: PRODUCTION,
    ...extra,
  } as never });
  prodUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: `rp-prod-${prodSeq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token, sessionId: session.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['UPLOAD_DIR'] = UPLOAD_DIR;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  // As server.ts does: a fresh tenant store per request BEFORE any auth hook.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  registerPublicUploads(app, UPLOAD_DIR);
  await app.ready();
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});
  // [VERIFY-DOCS] what each pack partner presents: its vehicle's required documents plus the optional identity document
  riderChecklist = await system(() => packPartnerDocuments(app.prisma, 'GY', REVIEW_PACK_PARTNERS.RIDER.vehicleType));
  driverChecklist = await system(() => packPartnerDocuments(app.prisma, 'GY', REVIEW_PACK_PARTNERS.DRIVER.vehicleType));
  riderRequired = await system(() => new CountryConfigService(app.prisma).getMoverChecklist('GY', REVIEW_PACK_PARTNERS.RIDER.vehicleType));
  driverRequired = await system(() => new CountryConfigService(app.prisma).getMoverChecklist('GY', REVIEW_PACK_PARTNERS.DRIVER.vehicleType));

  // The operator's command: the tenant, a session, and three logins.
  const provisioned = await system(() => provisionReviewTenant(app.prisma, { slug: REVIEW, phonePrefix: '+59200093' }));
  for (const c of provisioned.credentials) creds[c.role as keyof typeof creds] = { identifier: c.identifier, code: c.code };
  await system(async () => {
    const byPhone = async (phone: string) => (await app.prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } })).id;
    review.customerId = await byPhone(creds.CUSTOMER.identifier);
    review.riderUserId = await byPhone(creds.RIDER.identifier);
    review.driverUserId = await byPhone(creds.DRIVER.identifier);
  });

  // Production: a customer, a store, a rider and a taxi driver (offline until a case needs them).
  await system(async () => {
    const customer = await prodUser(['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
    prod.customerId = customer.userId; prod.customerToken = customer.token;
    const owner = await prodUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    prod.ownerUserId = owner.userId;
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    prod.vendorId = (await app.prisma.vendor.create({ data: {
      ownerId: vo.id, tenantId: PRODUCTION, name: `Real Kitchen ${RUN}`, slug: `real-kitchen-${RUN}`, vendorType: 'RESTAURANT',
      phone: `${prodPhoneBase}90`, addressLine1: '1 Real Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: SPOT.lat, longitude: SPOT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    } })).id;
    const rider = await prodUser(['MOVER', 'CUSTOMER', 'RIDER'], 'RIDER');
    prod.riderUserId = rider.userId; prod.riderSession = rider.sessionId;
    prod.riderId = (await app.prisma.rider.create({ data: {
      userId: rider.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000,
      isOnline: false, isAvailable: true, currentLat: NEAR.lat, currentLng: NEAR.lng,
    } })).id;
    const driver = await prodUser(['MOVER', 'CUSTOMER', 'DRIVER'], 'DRIVER');
    prod.driverUserId = driver.userId; prod.driverToken = driver.token; prod.driverSession = driver.sessionId;
    prod.driverId = (await app.prisma.driver.create({ data: {
      userId: driver.userId, vehicleMake: 'Real', vehicleModel: 'Car', vehicleYear: 2019, vehicleColor: 'Blue', licensePlate: `HB ${RUN.slice(0, 4)}`,
      driverLicenseUrl: '', vehicleInsuranceUrl: '', documentsVerified: true, isOnline: false, isAvailable: true,
      currentLat: NEAR.lat, currentLng: NEAR.lng,
    } })).id;
  });
});

afterAll(async () => {
  await system(async () => {
    const reviewUsers = (await app.prisma.user.findMany({ where: { tenantId: REVIEW }, select: { id: true } })).map((u) => u.id);
    const everyone = [...reviewUsers, ...prodUserIds];
    // A regression that let a booking through would leave rows behind; clear them first.
    const orders = (await app.prisma.order.findMany({ where: { OR: [{ tenantId: REVIEW }, { customerId: { in: everyone } }] }, select: { id: true } })).map((o) => o.id);
    await app.prisma.deliveryCashSettlement.deleteMany({ where: { orderId: { in: orders } } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: orders } } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
    await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: everyone } } });
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.advertiserMember.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.advertiser.deleteMany({ where: { createdByUserId: { in: everyone } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: everyone } } });
    const plantedVendors = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: everyone } } }, select: { id: true } })).map((v) => v.id);
    await app.prisma.vendor.deleteMany({ where: { id: { in: plantedVendors } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: everyone } } });
    const p = planReviewContentPack(REVIEW);
    const vendorIds = [...p.vendors.map((v) => v.id), prod.vendorId];
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.operatingHours.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: [p.ownerUserId, prod.ownerUserId] } } });
    await app.prisma.user.deleteMany({ where: { id: { in: [...everyone, p.ownerUserId] } } });
    await app.prisma.reviewCredential.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.ratingTagDef.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[REVIEW-PARTNER] provision: a rider and a taxi driver login beside the customer one', () => {
  it('three logins, each its own fictional identifier and static code (hash only), in the REVIEW tenant, shaped as production accounts', async () => {
    expect(Object.keys(creds).sort()).toEqual(['CUSTOMER', 'DRIVER', 'RIDER']);
    const identifiers = Object.values(creds).map((c) => c.identifier);
    expect(new Set(identifiers).size).toBe(3);
    for (const id of identifiers) expect(id).toMatch(/^\+59200093\d{2}$/);
    await system(async () => {
      for (const role of ['CUSTOMER', 'RIDER', 'DRIVER'] as const) {
        const row = await app.prisma.reviewCredential.findFirstOrThrow({ where: { tenantId: REVIEW, identifier: creds[role].identifier } });
        expect(row.role).toBe(role);
        expect(row.staticOtpHash).toBe(hashReviewCode(row.id, creds[role].code));
        expect(row.staticOtpHash).not.toContain(creds[role].code);
      }
      const rider = await app.prisma.user.findUniqueOrThrow({ where: { id: review.riderUserId } });
      expect([rider.tenantId, rider.isSynthetic, rider.activeRole, rider.lastMoverRole]).toEqual([REVIEW, true, 'RIDER', 'RIDER']);
      expect(rider.roles).toEqual(['MOVER', 'CUSTOMER', 'RIDER']);
      const driver = await app.prisma.user.findUniqueOrThrow({ where: { id: review.driverUserId } });
      expect([driver.tenantId, driver.isSynthetic, driver.activeRole, driver.lastMoverRole]).toEqual([REVIEW, true, 'DRIVER', 'DRIVER']);
      expect(driver.roles).toEqual(['MOVER', 'CUSTOMER', 'DRIVER']);
    });
    const status = await system(() => reviewStatus(app.prisma, REVIEW));
    expect(status.credentialsByRole).toEqual({ CUSTOMER: 1, RIDER: 1, DRIVER: 1 });
    // Logins exist, partners are not seeded yet: the pack is honestly ABSENT.
    expect(status.contentPack).toBe('ABSENT');
    expect(status.contentPackDetail?.partners).toMatchObject({ RIDER: { credentials: 1, ready: 0 }, DRIVER: { credentials: 1, ready: 0 }, profiles: 0 });
  });
});

describe('[REVIEW-PARTNER] seed: verified partners inside the fiction, by the production states', () => {
  it('the seed makes both logins verified partners and the pack PRESENT; a second run commits nothing', async () => {
    const first = await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }));
    expect(first.state).toBe('PRESENT');
    expect(first.partners).toMatchObject({ RIDER: { credentials: 1, ready: 1 }, DRIVER: { credentials: 1, ready: 1 }, profiles: 2 });
    // GY: a motorbike rider's checklist (identity, police, licence, registration, insurance) and a taxi's (+ hire permit, plate, car photos, fitness).
    // [VERIFY-DOCS · owner rulings 1, 2 and 4, 6 Oct 2026] a motorbike rider proves identity by the licence; the
    // national ID is optional and the pack partner still presents it (so it stays L2); no police clearance.
    expect(riderChecklist).toEqual(expect.arrayContaining(['national_id', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance']));
    expect(riderChecklist).not.toContain('police_clearance');
    // [VERIFY-DOCS · ruling 8] the person's and the car's hire licences replace the single permit
    expect(driverChecklist).toEqual(expect.arrayContaining(['vehicle_insurance', 'hire_car_driver_licence', 'hire_car_vehicle_licence']));
    expect(first.partnerDocumentsCommitted).toBe(riderChecklist.length + driverChecklist.length);
    const again = await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }));
    expect([again.state, again.partnerDocumentsCommitted]).toEqual(['PRESENT', 0]);
    await system(async () => {
      const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: review.riderUserId } });
      const spec = REVIEW_PACK_PARTNERS.RIDER;
      expect([rider.riderType, rider.vehicleType, rider.licensePlate, rider.documentsVerified]).toEqual(['DELIVERY', 'MOTORCYCLE', spec.vehicle.plate, false]);
      review.riderId = rider.id;
      const driver = await app.prisma.driver.findUniqueOrThrow({ where: { userId: review.driverUserId } });
      expect([driver.vehicleType, driver.rideClass, driver.vehicleCapacity, driver.documentsVerified]).toEqual(['CAR', 'ECONOMY', 4, false]);
      expect(driver.licensePlate.replace(/\s/g, '').startsWith('H')).toBe(true); // a taxi carries an H plate
      review.driverId = driver.id;
      for (const id of [review.riderUserId, review.driverUserId]) {
        const u = await app.prisma.user.findUniqueOrThrow({ where: { id } });
        expect([u.trustLevel, u.selfieCapturedAt instanceof Date]).toEqual(['L2', true]);
        expect(u.avatar).toBe(partnerPortraitUrl(id === review.riderUserId ? 'RIDER' : 'DRIVER'));
      }
    });
  });

  it('every document is an approved, COMMITTED fixture with NO file, and its VALID record is in the REVIEW tenant; the taxi insurance is hire-class', async () => {
    await system(async () => {
      const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: [review.riderUserId, review.driverUserId] } }, include: { record: true } });
      expect(docs).toHaveLength(riderChecklist.length + driverChecklist.length);
      for (const d of docs) {
        expect([d.state, d.status, d.fileUrl, d.reviewedBy, d.role]).toEqual(['COMMITTED', 'APPROVED', '', REVIEW_PACK_REVIEWER, 'MOVER']);
        expect(d.reviewNote).toMatch(/fixture/i);
        expect(d.consentAt).toBeNull();
        expect([d.record?.status, d.record?.tenantId]).toEqual(['VALID', REVIEW]);
      }
      const insurance = docs.find((d) => d.userId === review.driverUserId && d.docType === 'vehicle_insurance')!;
      expect([insurance.coverageClass, insurance.hireClassConfirmed, insurance.plateCrossChecked]).toEqual(['HIRE', true, true]);
      const ids = docs.map((d) => d.id);
      // No human reviewed a fiction: no case, no decision — and so nothing in the platform-wide audit chain.
      expect(await app.prisma.reviewCase.count({ where: { submissionId: { in: ids } } })).toBe(0);
      expect(await app.prisma.auditChainEntry.count({ where: { submissionRef: { in: ids } } })).toBe(0);
      // No money rail of any kind for either partner.
      expect(await app.prisma.subscription.count({ where: { OR: [{ riderId: review.riderId }, { driverId: review.driverId }] } })).toBe(0);
      expect(await app.prisma.trialGrant.count({ where: { accountId: { in: [review.riderUserId, review.driverUserId] } } })).toBe(0);
      expect(await app.prisma.notification.count({ where: { userId: { in: [review.riderUserId, review.driverUserId] } } })).toBe(0);
    });
  });

  it('a lapsed document is renewed by re-seeding (the newer fixture supersedes it) and a drifted vehicle heals back to the pack', async () => {
    await system(async () => {
      // [VERIFY-DOCS] police clearance is optional for movers, so the pack does not present one: the licence lapses instead
      const lapsed = await app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: review.riderUserId, docType: 'drivers_licence', state: 'COMMITTED' } });
      await app.prisma.verificationDocument.update({ where: { id: lapsed.id }, data: { state: 'EXPIRED' } });
      await app.prisma.rider.update({ where: { id: review.riderId }, data: { vehicleType: 'BICYCLE' } });
    });
    expect((await system(() => reviewContentPackFacts(app.prisma, REVIEW))).state).toBe('INCOMPLETE');
    const healed = await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }));
    expect([healed.state, healed.partnerDocumentsCommitted]).toEqual(['PRESENT', 1]);
    await system(async () => {
      expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: review.riderId } })).vehicleType).toBe('MOTORCYCLE');
      const police = await app.prisma.verificationDocument.findMany({ where: { userId: review.riderUserId, docType: 'drivers_licence' }, include: { record: true } });
      expect(police.map((d) => d.record?.status).sort()).toEqual(['EXPIRED', 'VALID']);
    });
  });

  it('the profile photo is DRAWN from the pack — a real PNG on the public avatars route; any other name is a 404', async () => {
    for (const role of ['RIDER', 'DRIVER'] as const) {
      const res = await app.inject({ method: 'GET', url: partnerPortraitUrl(role) });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect([res.rawPayload.readUInt32BE(16), res.rawPayload.readUInt32BE(20)]).toEqual([PACK_IMAGE_WIDTH, PACK_IMAGE_HEIGHT]);
    }
    expect((await app.inject({ method: 'GET', url: '/uploads/avatars/review-pack/v1/someone.png' })).statusCode).toBe(404);
  });

  it('the verification service writes a fixture document only for the review fiction: a production account is refused before anything is written', async () => {
    const writes = (userId: string) => system(() => commitReviewFixtureDocument(app.prisma, {
      userId, docType: 'national_id', expiresAt: null, reviewedBy: REVIEW_PACK_REVIEWER, reviewedAt: new Date(), reviewNote: 'guard probe',
    }));
    await expect(writes(prod.riderUserId)).rejects.toMatchObject({ statusCode: 403, code: 'REVIEW_FIXTURE_REFUSED' });
    await expect(writes(`no-such-user-${RUN}`)).rejects.toMatchObject({ code: 'REVIEW_FIXTURE_REFUSED' });
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: prod.riderUserId } }))).toBe(0);
  });

  it('the partner seed never touches an account outside a REVIEW tenant: a RIDER credential planted under swift-default (a real person) or under a CRAWLER tenant seeds nothing', async () => {
    const realPhone = `${prodPhoneBase}77`;
    const crawlerPhone = `${prodPhoneBase}78`;
    const CRAWLER = `crawl-partner-${RUN}`;
    await system(async () => {
      // (a) a real production person, and a RIDER credential naming them under swift-default
      const real = await app.prisma.user.create({ data: { phone: realPhone, firstName: 'Real', lastName: 'Rider', roles: ['MOVER', 'RIDER'], activeRole: 'RIDER', tenantId: PRODUCTION } });
      prodUserIds.push(real.id);
      await app.prisma.reviewCredential.create({ data: { id: `rc-${RUN}-real`, tenantId: PRODUCTION, role: 'RIDER', identifier: realPhone, staticOtpHash: hashReviewCode(`rc-${RUN}-real`, '111111') } });
      // (b) a non-REVIEW fiction (a CRAWLER tenant: its people are synthetic by derivation) with a RIDER credential
      await app.prisma.tenant.create({ data: { id: CRAWLER, name: 'Crawler', slug: CRAWLER, kind: 'CRAWLER' } });
      const crawler = await app.prisma.user.create({ data: { phone: crawlerPhone, firstName: 'Crawler', lastName: 'Rider', roles: ['MOVER', 'RIDER'], activeRole: 'RIDER', tenantId: CRAWLER } });
      prodUserIds.push(crawler.id);
      expect(crawler.isSynthetic).toBe(true);
      await app.prisma.reviewCredential.create({ data: { id: `rc-${RUN}-crawl`, tenantId: CRAWLER, role: 'RIDER', identifier: crawlerPhone, staticOtpHash: hashReviewCode(`rc-${RUN}-crawl`, '222222') } });
    });
    try {
      await system(() => seedReviewPartners(app.prisma, PRODUCTION));
      await system(() => seedReviewPartners(app.prisma, CRAWLER));
      await system(async () => {
        for (const phone of [realPhone, crawlerPhone]) {
          const u = await app.prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true, avatar: true, selfieCapturedAt: true, trustLevel: true } });
          expect(await app.prisma.rider.count({ where: { userId: u.id } }), phone).toBe(0);
          expect(await app.prisma.verificationDocument.count({ where: { userId: u.id } }), phone).toBe(0);
          expect([u.avatar, u.selfieCapturedAt, u.trustLevel], phone).toEqual([null, null, 'L1']);
        }
      });
    } finally {
      await system(async () => {
        await app.prisma.reviewCredential.deleteMany({ where: { id: { in: [`rc-${RUN}-real`, `rc-${RUN}-crawl`] } } });
        await app.prisma.user.deleteMany({ where: { phone: crawlerPhone } });
        await app.prisma.tenant.deleteMany({ where: { id: CRAWLER } });
      });
    }
  });

  it('the partner seed touches only synthetic accounts: a real person inside a REVIEW tenant (one re-kinded after a real sign-up) is left untouched, while the synthetic partner beside it is seeded', async () => {
    // The database derives isSynthetic on a USER write only. A tenant whose kind
    // changes later keeps its real people unflagged: the seed's own check is the guard.
    const FLIP = `review-flip-${RUN}`;
    const realPhone = `${prodPhoneBase}79`;
    let fictionPhone = '';
    const ids = { real: '', fiction: '' };
    await system(async () => {
      await app.prisma.tenant.create({ data: { id: FLIP, name: 'Re-kinded', slug: FLIP, kind: 'PRODUCTION' } });
      const real = await app.prisma.user.create({ data: { phone: realPhone, firstName: 'Real', lastName: 'Rider', roles: ['MOVER', 'RIDER'], activeRole: 'RIDER', tenantId: FLIP } });
      ids.real = real.id;
      prodUserIds.push(real.id);
      expect(real.isSynthetic).toBe(false);
      await app.prisma.tenant.update({ where: { id: FLIP }, data: { kind: 'REVIEW' } });
      // A fictional identifier from the provisioned review range, beside the real one.
      for (let i = 0; i < 100 && !fictionPhone; i++) {
        const candidate = `+59200093${String(i).padStart(2, '0')}`;
        if (!(await app.prisma.user.findUnique({ where: { phone: candidate }, select: { id: true } }))) fictionPhone = candidate;
      }
      expect(fictionPhone).not.toBe('');
      const fiction = await app.prisma.user.create({ data: { phone: fictionPhone, firstName: 'Demo', lastName: 'Driver', roles: ['MOVER', 'CUSTOMER', 'DRIVER'], activeRole: 'DRIVER', lastMoverRole: 'DRIVER', tenantId: FLIP } });
      ids.fiction = fiction.id;
      prodUserIds.push(fiction.id);
      expect(fiction.isSynthetic).toBe(true);
      expect((await app.prisma.user.findUniqueOrThrow({ where: { id: real.id } })).isSynthetic).toBe(false);
      // The real account's credential is the older one, so the seed reaches it first.
      await app.prisma.reviewCredential.create({ data: { id: `rc-${RUN}-flip-real`, tenantId: FLIP, role: 'RIDER', identifier: realPhone, staticOtpHash: hashReviewCode(`rc-${RUN}-flip-real`, '333333'), rotatedAt: new Date(Date.now() - 60_000) } });
      await app.prisma.reviewCredential.create({ data: { id: `rc-${RUN}-flip-fiction`, tenantId: FLIP, role: 'DRIVER', identifier: fictionPhone, staticOtpHash: hashReviewCode(`rc-${RUN}-flip-fiction`, '444444') } });
    });
    try {
      const seeded = await system(() => seedReviewPartners(app.prisma, FLIP));
      expect(seeded).toMatchObject({ RIDER: { credentials: 1, ready: 0 }, DRIVER: { credentials: 1, ready: 1 }, profiles: 1 });
      expect(seeded.documentsCommitted).toBe(driverChecklist.length);
      await system(async () => {
        const real = await app.prisma.user.findUniqueOrThrow({ where: { id: ids.real }, select: { avatar: true, selfieCapturedAt: true, trustLevel: true, isSynthetic: true } });
        expect(await app.prisma.rider.count({ where: { userId: ids.real } })).toBe(0);
        expect(await app.prisma.driver.count({ where: { userId: ids.real } })).toBe(0);
        expect(await app.prisma.verificationDocument.count({ where: { userId: ids.real } })).toBe(0);
        expect([real.avatar, real.selfieCapturedAt, real.trustLevel, real.isSynthetic]).toEqual([null, null, 'L1', false]);
        const fiction = await app.prisma.user.findUniqueOrThrow({ where: { id: ids.fiction }, select: { avatar: true, trustLevel: true } });
        expect(await app.prisma.driver.count({ where: { userId: ids.fiction } })).toBe(1);
        expect(await app.prisma.verificationDocument.count({ where: { userId: ids.fiction } })).toBe(driverChecklist.length);
        expect([fiction.avatar, fiction.trustLevel]).toEqual([partnerPortraitUrl('DRIVER'), 'L2']);
      });
    } finally {
      await system(async () => {
        await app.prisma.reviewCredential.deleteMany({ where: { tenantId: FLIP } });
        await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: [ids.real, ids.fiction] } } });
        await app.prisma.rider.deleteMany({ where: { userId: { in: [ids.real, ids.fiction] } } });
        await app.prisma.driver.deleteMany({ where: { userId: { in: [ids.real, ids.fiction] } } });
        await app.prisma.user.deleteMany({ where: { tenantId: FLIP } });
        await app.prisma.tenant.deleteMany({ where: { id: FLIP } });
      });
    }
  });
});

describe('[REVIEW-PARTNER · DL-6] sign-in: each partner through the production door, with no SMS', () => {
  it('rider and driver sign in with their own static codes; the response names tenant.kind REVIEW and the mover role; nothing is texted', async () => {
    for (const [role, key] of [['RIDER', 'rider'], ['DRIVER', 'driver']] as const) {
      const res = await signIn(creds[role].identifier, creds[role].code);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data.isNewUser).toBe(false);
      expect(data.user.tenant).toEqual({ kind: 'REVIEW' });
      expect(data.user.activeRole).toBe(role);
      tokens[key] = data.tokens.accessToken;
      expect(smsTo(creds[role].identifier)).toHaveLength(0);
    }
    const customer = await signIn(creds.CUSTOMER.identifier, creds.CUSTOMER.code);
    expect(customer.statusCode, customer.body).toBe(200);
    tokens.customer = customer.json().data.tokens.accessToken;
    await system(async () => {
      tokens.riderSession = (await app.prisma.session.findFirstOrThrow({ where: { token: tokens.rider } })).id;
      tokens.driverSession = (await app.prisma.session.findFirstOrThrow({ where: { token: tokens.driver } })).id;
    });
  });

  it('a code opens only its own identifier: the rider code on the driver identifier (and on the customer one) is refused', async () => {
    for (const other of ['DRIVER', 'CUSTOMER'] as const) {
      const res = await signIn(creds[other].identifier, creds.RIDER.code === creds[other].code ? '000000' : creds.RIDER.code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_OTP');
      await app.redis.del(`review_otp:${creds[other].identifier}`, `review_otp_fail:${creds[other].identifier}`);
    }
  });
});

describe('[REVIEW-PARTNER] going online works for both, exactly as in production', () => {
  it('the app reads both partners as verified: every checklist type approved, nothing missing', async () => {
    const r = (await get('/api/v1/verification/status?role=MOVER', tokens.rider)).json().data;
    expect([r.roleVerified, r.missing, r.vehicleType]).toEqual([true, [], 'MOTORCYCLE']);
    expect([...r.checklist].sort()).toEqual([...riderRequired].sort());
    const d = (await get('/api/v1/verification/status?role=MOVER', tokens.driver)).json().data;
    expect([d.roleVerified, d.missing, d.vehicleType]).toEqual([true, [], 'CAR']);
    expect([...d.checklist].sort()).toEqual([...driverRequired].sort());
  });

  it('the rider goes online, streams location, sees an honestly EMPTY board and no offer, and goes offline', async () => {
    const on = await post('/api/v1/rider/go-online', tokens.rider, { latitude: SPOT.lat, longitude: SPOT.lng });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data).toEqual({ isOnline: true, isAvailable: true });
    const ping = await put('/api/v1/rider/location', tokens.rider, { latitude: SPOT.lat, longitude: SPOT.lng, accuracy: 8 });
    expect(ping.statusCode, ping.body).toBe(200);
    expect(ping.json().data?.accepted).not.toBe(false);
    const board = await get('/api/v1/rider/orders/available', tokens.rider);
    expect(board.statusCode, board.body).toBe(200);
    expect(board.json().data).toEqual([]);
    expect((await get('/api/v1/rider/offers/current', tokens.rider)).json().data.offer).toBeNull();
    const off = await post('/api/v1/rider/go-offline', tokens.rider);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data).toEqual({ isOnline: false, isAvailable: false });
  });

  it('the taxi driver goes online with NO weekly plan (the fiction holds none), streams location, sees an EMPTY board, and goes offline', async () => {
    const on = await post('/api/v1/driver/go-online', tokens.driver, { latitude: SPOT.lat, longitude: SPOT.lng });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data.isOnline).toBe(true);
    const ping = await put('/api/v1/driver/location', tokens.driver, { latitude: SPOT.lat, longitude: SPOT.lng, accuracy: 8 });
    expect(ping.statusCode, ping.body).toBe(200);
    const board = await get('/api/v1/driver/rides/available', tokens.driver);
    expect(board.statusCode, board.body).toBe(200);
    expect(board.json().data).toEqual([]);
    expect((await get('/api/v1/driver/offers/current', tokens.driver)).json().data.offer).toBeNull();
    const off = await post('/api/v1/driver/go-offline', tokens.driver);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data.isOnline).toBe(false);
  });
});

describe('[REVIEW-PARTNER · isolation] a production customer never sees a review partner', () => {
  it('with the review driver online at a point, a production customer there sees no car, no supply and no availability — the review customer sees the fiction’s own', async () => {
    expect((await post('/api/v1/driver/go-online', tokens.driver, { latitude: SPOT.lat, longitude: SPOT.lng })).statusCode).toBe(200);
    const q = `lat=${SPOT.lat}&lng=${SPOT.lng}`;
    const prodPresence = await get(`/api/v1/rides/presence?${q}`, prod.customerToken);
    expect(prodPresence.statusCode, prodPresence.body).toBe(200);
    expect(prodPresence.json().data.cars).toEqual([]);
    const prodSupply = await get(`/api/v1/rides/supply?${q}`, prod.customerToken);
    expect(prodSupply.statusCode, prodSupply.body).toBe(200);
    expect(prodSupply.json().data).toMatchObject({ online: 0, level: 'NONE' });
    const prodAvail = await get(`/api/v1/rides/availability?${q}`, prod.customerToken);
    expect(prodAvail.json().data).toMatchObject({ level: 'NONE', nearestEtaMinutes: null });
    // Inside the fiction the driver IS supply: proof the partner is really online.
    const reviewPresence = await get(`/api/v1/rides/presence?${q}`, tokens.customer);
    expect(reviewPresence.json().data.cars).toHaveLength(1);
    expect((await get(`/api/v1/rides/supply?${q}`, tokens.customer)).json().data).toMatchObject({ online: 1, level: 'LOW' });
  });

  it('dispatch of a production taxi ride never reaches the review driver, though it is the nearest car: the production driver gets the offer', async () => {
    await system(async () => {
      await app.prisma.driver.update({ where: { id: prod.driverId }, data: { isOnline: true, isAvailable: true, locationSessionId: prod.driverSession, lastLocationUpdate: new Date(), currentLat: NEAR.lat, currentLng: NEAR.lng } });
      prod.taxiOrderId = (await app.prisma.order.create({ data: {
        tenantId: PRODUCTION, orderNumber: `RP-T-${RUN}`, orderType: 'TAXI', customerId: prod.customerId, status: 'PENDING',
        pickupAddress: 'Real pickup', pickupLat: SPOT.lat, pickupLng: SPOT.lng, deliveryAddress: 'Real dropoff',
        deliveryLat: SPOT.lat + 0.02, deliveryLng: SPOT.lng + 0.02, rideClass: 'ECONOMY', taxiPassengerCount: 1,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      } })).id;
    });
    const candidates = await system(() => dispatch.findCandidates(prod.taxiOrderId, SPOT, 5, 'DRIVER', 0, 'ECONOMY', PRODUCTION));
    expect(candidates.map((c) => c.riderId)).toEqual([prod.driverId]);
    const offered = await system(() => dispatch.dispatchOrder(prod.taxiOrderId, PRODUCTION));
    expect(offered.offered).toBe(prod.driverId);
    expect((await get('/api/v1/driver/offers/current', tokens.driver)).json().data.offer).toBeNull();
    await system(() => dispatch.releaseHeldOffer(prod.driverId));
  });

  it('dispatch of a production delivery never reaches the review rider, though it is the nearest bike: the production rider gets the offer', async () => {
    expect((await post('/api/v1/rider/go-online', tokens.rider, { latitude: SPOT.lat, longitude: SPOT.lng })).statusCode).toBe(200);
    await system(async () => {
      await app.prisma.rider.update({ where: { id: prod.riderId }, data: { isOnline: true, isAvailable: true, locationSessionId: prod.riderSession, lastLocationUpdate: new Date(), currentLat: NEAR.lat, currentLng: NEAR.lng } });
      prod.deliveryOrderId = (await app.prisma.order.create({ data: {
        tenantId: PRODUCTION, orderNumber: `RP-D-${RUN}`, orderType: 'FOOD_DELIVERY', customerId: prod.customerId, vendorId: prod.vendorId,
        status: 'ACCEPTED', fulfillment: 'DELIVERY', pickupAddress: 'Real Kitchen', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
        deliveryAddress: 'Real home', deliveryLat: SPOT.lat + 0.01, deliveryLng: SPOT.lng + 0.01,
        // No goods cash to front (subtotalBase 0): the float gate cannot be what separates the two riders.
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 500, totalAmount: 500, paymentMethod: 'CASH',
      } })).id;
    });
    const candidates = await system(() => dispatch.findCandidates(prod.deliveryOrderId, SPOT, 5, 'RIDER', 0, null, PRODUCTION));
    expect(candidates.map((c) => c.riderId)).toEqual([prod.riderId]);
    const offered = await system(() => dispatch.dispatchOrder(prod.deliveryOrderId, PRODUCTION));
    expect(offered.offered).toBe(prod.riderId);
    expect((await get('/api/v1/rider/offers/current', tokens.rider)).json().data.offer).toBeNull();
    await system(() => dispatch.releaseHeldOffer(prod.riderId));
  });
});

describe('[REVIEW-PARTNER · isolation] a review partner cannot see or affect production', () => {
  it('a production delivery at the rider’s feet is not on its board, and taking it by id is a 404 that changes nothing', async () => {
    const board = await get('/api/v1/rider/orders/available', tokens.rider);
    expect(board.statusCode, board.body).toBe(200);
    expect(board.body).not.toContain(prod.deliveryOrderId);
    const take = await post(`/api/v1/rider/orders/${prod.deliveryOrderId}/accept`, tokens.rider);
    expect(take.statusCode, take.body).toBe(404);
    const order = await system(() => app.prisma.order.findUniqueOrThrow({ where: { id: prod.deliveryOrderId }, select: { riderId: true, status: true } }));
    expect(order).toEqual({ riderId: null, status: 'ACCEPTED' });
  });

  it('a production taxi request beside the driver is not on its board, and taking it by id is a 404 that changes nothing', async () => {
    const board = await get('/api/v1/driver/rides/available', tokens.driver);
    expect(board.statusCode, board.body).toBe(200);
    expect(board.body).not.toContain(prod.taxiOrderId);
    const take = await post(`/api/v1/driver/rides/${prod.taxiOrderId}/accept`, tokens.driver);
    expect(take.statusCode, take.body).toBe(404);
    const order = await system(() => app.prisma.order.findUniqueOrThrow({ where: { id: prod.taxiOrderId }, select: { driverId: true, status: true } }));
    expect(order).toEqual({ driverId: null, status: 'PENDING' });
  });

  it('no production store or customer reaches a partner: browsing shows only the fiction’s stores, and its order history is empty', async () => {
    const stores = await get('/api/v1/customer/vendors?limit=50', tokens.rider);
    expect(stores.statusCode, stores.body).toBe(200);
    expect(stores.body).not.toContain(prod.vendorId);
    for (const v of planReviewContentPack(REVIEW).vendors) expect(stores.body).toContain(v.id);
    const history = await get('/api/v1/rider/orders', tokens.rider);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).not.toContain(prod.deliveryOrderId);
    expect(history.body).not.toContain(prod.customerId);
  });

  it('a production rider’s payout (the cash a store owes them) is invisible to the review rider and cannot be confirmed by it', async () => {
    prod.settlementId = (await system(() => app.prisma.deliveryCashSettlement.create({ data: {
      orderId: prod.deliveryOrderId, riderId: prod.riderId, vendorId: prod.vendorId, tenantId: PRODUCTION, amount: 500,
    } }))).id;
    const list = await get('/api/v1/rider/cash-settlements', tokens.rider);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(prod.settlementId);
    const confirm = await post(`/api/v1/rider/cash-settlements/${prod.settlementId}/confirm`, tokens.rider, { amount: 500 });
    expect(confirm.statusCode, confirm.body).toBe(404);
    const row = await system(() => app.prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id: prod.settlementId } }));
    expect([row.status, row.riderConfirmedAt]).toEqual(['OWED', null]);
  });
});

describe('[REVIEW-PARTNER · DL-5] the board stays empty: the fiction books no taxi and no parcel', () => {
  const ride = { pickup: SPOT, dropoff: { lat: SPOT.lat + 0.02, lng: SPOT.lng + 0.02 }, pickupAddress: 'Demo pickup', dropoffAddress: 'Demo dropoff', passengerCount: 1, rideClass: 'ECONOMY' };

  it('a review customer’s taxi request and queue join are refused with the demo message before anything is written', async () => {
    for (const url of ['/api/v1/rides/request', '/api/v1/rides/queue/join']) {
      const res = await post(url, tokens.customer, ride);
      expect(res.statusCode, `${url} ${res.body}`).toBe(403);
      expect(res.json().error).toMatchObject({ code: REVIEW_DEMO_NO_ORDERS, message: REVIEW_DEMO_NO_BOOKINGS_MESSAGE });
    }
    await system(async () => {
      expect(await app.prisma.order.count({ where: { tenantId: REVIEW } })).toBe(0);
      expect(await app.prisma.rideQueueEntry.count({ where: { customerId: review.customerId } })).toBe(0);
    });
    expect((await get('/api/v1/driver/rides/available', tokens.driver)).json().data).toEqual([]);
  });

  it('a review customer’s parcel is refused with the demo message: no order, nothing for the rider', async () => {
    const res = await post('/api/v1/courier/order', tokens.customer, {
      pickup: SPOT, dropoff: { lat: SPOT.lat + 0.01, lng: SPOT.lng }, pickupAddress: 'Demo pickup', dropoffAddress: 'Demo dropoff',
      packageSize: 'SMALL', recipientName: 'Demo Recipient', recipientPhone: '+5920009399',
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toMatchObject({ code: REVIEW_DEMO_NO_ORDERS, message: REVIEW_DEMO_NO_BOOKINGS_MESSAGE });
    expect(await system(() => app.prisma.order.count({ where: { tenantId: REVIEW } }))).toBe(0);
    expect((await get('/api/v1/rider/orders/available', tokens.rider)).json().data).toEqual([]);
  });
});

describe('[REVIEW-PARTNER · DL-5 / DL-6] no money and no SMS for a review partner', () => {
  it('no weekly plan exists to show, and every fee or MMG surface answers with the demo refusal — before any step-up', async () => {
    expect((await get('/api/v1/rider/subscription', tokens.rider)).json().data).toBeNull();
    expect((await get('/api/v1/driver/subscription', tokens.driver)).json().data).toBeNull();
    for (const [url, token] of [['/api/v1/rider/subscription/billing-method', tokens.rider], ['/api/v1/driver/subscription/billing-method', tokens.driver]] as const) {
      const res = await put(url, token, { method: 'MOBILE_MONEY', mmgPayerMsisdn: '+5926001234' });
      expect(res.statusCode, `${url} ${res.body}`).toBe(403);
      expect(res.json().error.code).toBe(REVIEW_DEMO_NO_MONEY);
    }
    const link = await put('/api/v1/driver/profile', tokens.driver, { mmgPayUrl: 'https://mmg.gy/pay/demo-driver' });
    expect(link.statusCode, link.body).toBe(403);
    expect(link.json().error.code).toBe(REVIEW_DEMO_NO_MONEY);
    await system(async () => {
      const driver = await app.prisma.driver.findUniqueOrThrow({ where: { id: review.driverId } });
      expect([driver.mmgPayUrl, driver.mmgPayUrlPending]).toEqual([null, null]);
      expect(await app.prisma.moneySurfaceCommand.count({ where: { userId: review.driverUserId } })).toBe(0);
      expect(await app.prisma.subscription.count({ where: { OR: [{ riderId: review.riderId }, { driverId: review.driverId }] } })).toBe(0);
    });
    expect([...smsTo(creds.RIDER.identifier), ...smsTo(creds.DRIVER.identifier)]).toHaveLength(0);
  });

  it('step-up (“confirm it’s you”) texts nobody: the static review code confirms the session; a wrong code does not', async () => {
    await app.redis.del(`otp_rate:stepup:${review.driverUserId}`, reviewStepUpKey(review.driverUserId), `stepup:fail:${review.driverUserId}`);
    const sent = await post('/api/v1/auth/step-up', tokens.driver);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(smsTo(creds.DRIVER.identifier)).toHaveLength(0);
    const wrong = await post('/api/v1/auth/step-up/verify', tokens.driver, { code: creds.DRIVER.code === '000000' ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_CODE');
    // Only its own identifier's code: the rider's code does not confirm the driver.
    if (creds.RIDER.code !== creds.DRIVER.code) {
      expect((await post('/api/v1/auth/step-up/verify', tokens.driver, { code: creds.RIDER.code })).statusCode).toBe(400);
    }
    const ok = await post('/api/v1/auth/step-up/verify', tokens.driver, { code: creds.DRIVER.code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await hasStepUp(app.redis, tokens.driverSession)).toBe(true);
    // Single use: the window closed with the success.
    expect((await post('/api/v1/auth/step-up/verify', tokens.driver, { code: creds.DRIVER.code })).statusCode).toBe(400);
    await app.redis.del(`stepup:ok:${tokens.driverSession}`, `stepup:fail:${review.driverUserId}`);
  });

  it('a production account’s step-up still texts its own phone — even when a review credential is planted on its number — and a production driver with no weekly plan is still refused at GO', async () => {
    const prodPhone = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: prod.driverUserId }, select: { phone: true } }))).phone;
    // A REVIEW-tenant credential written for a production person's number confirms nothing for them.
    const trapId = `rc-${RUN}-trap`;
    await system(() => app.prisma.reviewCredential.create({ data: { id: trapId, tenantId: REVIEW, role: 'DRIVER', identifier: prodPhone, staticOtpHash: hashReviewCode(trapId, '135790') } }));
    try {
      const before = smsTo(prodPhone).length;
      const sent = await post('/api/v1/auth/step-up', prod.driverToken);
      expect(sent.statusCode, sent.body).toBe(200);
      expect(smsTo(prodPhone).length).toBe(before + 1);
      expect(await app.redis.get(reviewStepUpKey(prod.driverUserId))).toBeNull();
      const trapped = await post('/api/v1/auth/step-up/verify', prod.driverToken, { code: '135790' });
      expect(trapped.statusCode, trapped.body).toBe(400);
      expect(await hasStepUp(app.redis, prod.driverSession)).toBe(false);
    } finally {
      await system(() => app.prisma.reviewCredential.deleteMany({ where: { id: trapId } }));
      await app.redis.del(`stepup:fail:${prod.driverUserId}`);
    }
    await system(() => currentTaxiSplitDocuments(app.prisma, prod.driverUserId));
    // The fee exemption is the fiction's only: a verified production taxi without a plan stays off the road.
    await system(async () => {
      await app.prisma.driver.update({ where: { id: prod.driverId }, data: { isOnline: false, locationSessionId: null } });
      await app.prisma.verificationDocument.create({ data: {
        userId: prod.driverUserId, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: '', status: 'APPROVED', reviewedBy: 'test-admin', reviewedAt: new Date(),
        expiresAt: new Date(Date.now() + 300 * DAY), coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true,
      } });
    });
    const go = await post('/api/v1/driver/go-online', prod.driverToken, { latitude: NEAR.lat, longitude: NEAR.lng });
    expect(go.statusCode, go.body).toBe(400);
    expect(go.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('[REVIEW-PARTNER · DL-9] the partners live and die with the review session, like the customer', () => {
  it('when the review session ends, every partner request is 410 REVIEW_SESSION_CLOSED — never production data; a new session revives them', async () => {
    const live = await system(() => app.prisma.reviewSession.findMany({ where: { tenantId: REVIEW, status: { in: ['PROVISIONED', 'ANCHORED'] } }, select: { id: true } }));
    await system(() => app.prisma.reviewSession.updateMany({ where: { id: { in: live.map((s) => s.id) } }, data: { status: 'REVOKED' } }));
    for (const [url, token] of [['/api/v1/rider/orders/available', tokens.rider], ['/api/v1/driver/rides/available', tokens.driver], ['/api/v1/rider/profile', tokens.rider]] as const) {
      const res = await get(url, token);
      expect(res.statusCode, url).toBe(410);
      expect(res.json().error.code).toBe('REVIEW_SESSION_CLOSED');
    }
    await system(() => app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + DAY) } }));
    expect((await get('/api/v1/rider/profile', tokens.rider)).statusCode).toBe(200);
  });
});


describe('[REVIEW-PARTNER · DL-5 · Sol F1] a demo login cannot grow into a money surface', () => {
  const business = { name: `Demo Grow ${RUN}`, vendorType: 'RESTAURANT', phone: '+5920009399', addressLine1: '1 Demo Way', city: 'Georgetown', latitude: SPOT.lat, longitude: SPOT.lng };

  it('the exact sequence — become a store, step up with the static code, set an MMG link — ends in refusals: no store, no role, no money command, no SMS, no admin notice', async () => {
    const t0 = new Date();
    const smsBefore = devChannelLog.filter((e) => e.channel === 'sms').length;
    const before = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: review.customerId }, select: { roles: true, activeRole: true } }));
    const become = await post('/api/v1/partner/become', tokens.customer, { role: 'VENDOR', acceptAgreement: true, business });
    expect(become.statusCode, become.body).toBe(403);
    expect(become.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    // The static code still confirms the session (it texts nobody) ...
    await app.redis.del(`otp_rate:stepup:${review.customerId}`, reviewStepUpKey(review.customerId), `stepup:fail:${review.customerId}`);
    expect((await post('/api/v1/auth/step-up', tokens.customer)).statusCode).toBe(200);
    expect((await post('/api/v1/auth/step-up/verify', tokens.customer, { code: creds.CUSTOMER.code })).statusCode).toBe(200);
    // ... and there is still no store, so no money surface to reach.
    const link = await put('/api/v1/vendor/profile', tokens.customer, { mmgPayUrl: '' });
    expect(link.statusCode, link.body).toBe(403);
    expect(link.json().error.code).toBe('FORBIDDEN');
    await system(async () => {
      expect(await app.prisma.user.findUniqueOrThrow({ where: { id: review.customerId }, select: { roles: true, activeRole: true } })).toEqual(before);
      expect(await app.prisma.vendorOwner.count({ where: { userId: review.customerId } })).toBe(0);
      expect(await app.prisma.moneySurfaceCommand.count({ where: { userId: review.customerId } })).toBe(0);
      expect(await app.prisma.notification.count({ where: { createdAt: { gte: t0 } } })).toBe(0);
    });
    expect(devChannelLog.filter((e) => e.channel === 'sms').length).toBe(smsBefore);
  });

  it('every other way to grow a role is refused too: a vehicle swap, an advertiser company, a service-provider profile', async () => {
    const t0 = new Date();
    const vehicle = await put('/api/v1/partner/vehicle', tokens.rider, { vehicleType: 'CAR', vehicle: { make: 'Demo', model: 'Car', year: 2020, color: 'Blue', licensePlate: 'H DEMO 9' } });
    expect(vehicle.statusCode, vehicle.body).toBe(403);
    expect(vehicle.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    const advertiser = await withAdsOn(() => post('/api/v1/ads/advertiser/register', tokens.customer, { companyName: `Demo Ads ${RUN}`, industry: 'Food & Beverage', contactName: 'Demo', contactEmail: 'demo@example.com', contactPhone: '+5926001234' }));
    expect(advertiser.statusCode, advertiser.body).toBe(403);
    expect(advertiser.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    const provider = await post('/api/v1/services/providers', tokens.customer, { trade: 'carpenter' });
    expect(provider.statusCode, provider.body).toBe(403);
    expect(provider.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    await system(async () => {
      expect(await app.prisma.driver.count({ where: { userId: review.riderUserId } })).toBe(0);
      expect((await app.prisma.rider.findUniqueOrThrow({ where: { userId: review.riderUserId } })).vehicleType).toBe('MOTORCYCLE');
      expect(await app.prisma.advertiser.count({ where: { createdByUserId: review.customerId } })).toBe(0);
      expect(await app.prisma.serviceProvider.count({ where: { userId: review.customerId } })).toBe(0);
      expect(await app.prisma.notification.count({ where: { createdAt: { gte: t0 } } })).toBe(0);
    });
  });

  it('the shared money-command authority refuses the fiction itself — a store or a driver of a REVIEW tenant — before any write, command or notice', async () => {
    const vendorId = await system(async () => {
      // A store a review account owns, planted directly: the state a pre-fix /partner/become left behind.
      const vo = await app.prisma.vendorOwner.create({ data: { userId: review.customerId } });
      await app.prisma.user.update({ where: { id: review.customerId }, data: { roles: ['CUSTOMER', 'VENDOR_OWNER'] } });
      return (await app.prisma.vendor.create({ data: {
        ownerId: vo.id, tenantId: REVIEW, name: `Planted ${RUN}`, slug: `planted-${RUN}`, vendorType: 'RESTAURANT', phone: '+5920009398',
        addressLine1: '2 Demo Way', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: SPOT.lat, longitude: SPOT.lng, status: 'PENDING_APPROVAL',
      } })).id;
    });
    const smsBefore = devChannelLog.filter((e) => e.channel === 'sms').length;
    // No step-up on this session: the refusal must come BEFORE the step-up demand, not from a later layer.
    const customerSession = await system(() => app.prisma.session.findFirstOrThrow({ where: { token: tokens.customer }, select: { id: true } }));
    await app.redis.del(stepUpKey(customerSession.id));
    // The store's own money routes refuse the fiction before any step-up or write ...
    for (const [method, url, body] of [['PUT', '/api/v1/vendor/profile', { mmgPayUrl: '' }], ['PUT', '/api/v1/vendor/subscription/billing-method', { method: 'NONE' }]] as const) {
      const res = await app.inject({ method, url, headers: auth(tokens.customer), payload: body });
      expect(res.statusCode, `${url} ${res.body}`).toBe(403);
      expect(res.json().error.code).toBe(REVIEW_DEMO_NO_MONEY);
    }
    // ... and so does the shared authority itself, whoever calls it.
    const deps = { prisma: app.prisma, io: app.io };
    for (const [actor, entityId, userId] of [['VENDOR', vendorId, review.customerId], ['DRIVER', review.driverId, review.driverUserId]] as const) {
      await expect(system(() => stageMmgLinkChange(deps, { actor, entityId, userId, sessionId: null, newUrl: 'https://mmg.example/pay/demo' }))).rejects.toMatchObject({ statusCode: 403, code: REVIEW_DEMO_NO_MONEY });
      await expect(system(() => clearMmgLink(deps, { actor, entityId, userId }))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_MONEY });
      await expect(system(() => cancelMmgLinkChange(deps, { actor, entityId, userId, keepSessionId: null }))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_MONEY });
    }
    await system(async () => {
      expect(await app.prisma.moneySurfaceCommand.count({ where: { entityId: { in: [vendorId, review.driverId] } } })).toBe(0);
      const v = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect([v.mmgPayUrl, v.mmgPayUrlPending]).toEqual([null, null]);
    });
    // The executor never makes a fiction's link live, even one that was pending before this fix.
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrlPending: 'https://mmg.example/pay/legacy', mmgPayUrlPendingAt: new Date(Date.now() - 2 * DAY), mmgPayUrlApplyAt: new Date(Date.now() - DAY) } }));
    await system(() => applyDueMmgLinkChanges(deps));
    await system(async () => {
      const v = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect(v.mmgPayUrl).toBeNull();
      expect(await app.prisma.moneySurfaceCommand.count({ where: { entityId: vendorId } })).toBe(0);
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null } });
      await app.prisma.user.update({ where: { id: review.customerId }, data: { roles: ['CUSTOMER'] } });
    });
    expect(devChannelLog.filter((e) => e.channel === 'sms').length).toBe(smsBefore);
  });
});

describe('[REVIEW-PARTNER · DL-6 · Sol F3] the review step-up window is consumed atomically', () => {
  /** The real app, with the account lookup held at a gate so a test can act DURING verification. */
  function gated(onLookup: () => Promise<void>) {
    const prisma = new Proxy(app.prisma, {
      get(target, prop, receiver) {
        if (prop === 'user') return { findUnique: async (args: never) => { await onLookup(); return target.user.findUnique(args); } };
        return Reflect.get(target, prop, receiver);
      },
    });
    return { prisma, redis: app.redis } as unknown as FastifyInstance;
  }
  const arm = async () => {
    await app.redis.del(`otp_rate:stepup:${review.riderUserId}`, `stepup:fail:${review.riderUserId}`, `stepup:lock:${review.riderUserId}`);
    await sendStepUpOtp(app, review.riderUserId);
  };
  const cleanup = () => app.redis.del(stepUpKey(`rp-race-a-${RUN}`), stepUpKey(`rp-race-b-${RUN}`), stepUpKey(`rp-expiry-${RUN}`), `stepup:fail:${review.riderUserId}`, reviewStepUpKey(review.riderUserId));

  it('two verifiers racing on one window: exactly one session is stepped up', async () => {
    await arm();
    let entered = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const racer = gated(async () => { entered += 1; if (entered === 2) open(); await gate; });
    const results = await Promise.allSettled([
      verifyStepUp(racer, { userId: review.riderUserId, sessionId: `rp-race-a-${RUN}` }, creds.RIDER.code),
      verifyStepUp(racer, { userId: review.riderUserId, sessionId: `rp-race-b-${RUN}` }, creds.RIDER.code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['INVALID_CODE']);
    const granted = [await hasStepUp(app.redis, `rp-race-a-${RUN}`), await hasStepUp(app.redis, `rp-race-b-${RUN}`)];
    expect(granted.filter(Boolean)).toHaveLength(1);
    await cleanup();
  });

  it('a window re-armed while the account is being looked up belongs to the NEW send: the old verifier does not consume it', async () => {
    await arm();
    const rearming = gated(async () => { await app.redis.del(`otp_rate:stepup:${review.riderUserId}`); await sendStepUpOtp(app, review.riderUserId); });
    await expect(verifyStepUp(rearming, { userId: review.riderUserId, sessionId: `rp-expiry-${RUN}` }, creds.RIDER.code)).rejects.toMatchObject({ code: 'INVALID_CODE' });
    expect(await hasStepUp(app.redis, `rp-expiry-${RUN}`)).toBe(false);
    expect(await app.redis.get(reviewStepUpKey(review.riderUserId))).not.toBeNull(); // the new window is still open
    await cleanup();
  });

  it('a window that expires while the account is being looked up does not succeed', async () => {
    await arm();
    const expiring = gated(async () => { await app.redis.del(reviewStepUpKey(review.riderUserId)); });
    await expect(verifyStepUp(expiring, { userId: review.riderUserId, sessionId: `rp-expiry-${RUN}` }, creds.RIDER.code)).rejects.toMatchObject({ code: 'INVALID_CODE' });
    expect(await hasStepUp(app.redis, `rp-expiry-${RUN}`)).toBe(false);
    await cleanup();
  });
});
