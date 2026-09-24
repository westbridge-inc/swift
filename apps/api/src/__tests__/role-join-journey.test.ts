import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { loginWithOtp, requestOtp } from './helpers/otp';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { injectWithApproval } from './helpers/admin-approval';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// ---------------------------------------------------------------------------
// [phone feedback P2] The owner installed the app, signed up as a customer
// and tapped "Swift Business", then "Swift Driver". The staging log:
//
//   POST /customer/switch-role ×3 (200)      — the way BACK to the customer app
//   GET  /vendor/profile        → 403 ×5     — the business shell's probe
//   GET  /rider/profile         → 403 ×3     — the mover shell's probes,
//   GET  /driver/profile        → 403 ×3       retried three times each
//
// He has no business, rider or driver account. The 403 on the self-profile
// read of a role the caller does not hold is the server's DELIBERATE answer:
// the authz matrix (authz-matrix.test.ts) pins 401/403 for a wrong-role token
// on every /vendor, /driver and /rider route, and partner.test.ts and
// staff-roles.test.ts pin this exact case by name ("403, not a 404 oracle";
// "authz answers, not existence"). That contract stands. The app now reads
// its OWN outsider 403 as "no profile yet" and opens the JOIN flow
// (apps/mobile/src/navigation/roleJoin.test.ts proves that half).
//
// This file proves the JOIN flow the app then drives works END TO END
// through the real routes, for each role:
//   customer with no business → refused switch, outsider probe → creates the
//   business (POST /partner/become) → the shell loads PENDING_APPROVAL → the
//   document steps (GET /verification/status, POST /verification/documents)
//   → an admin approves each document through the real review route → the
//   completed checklist activates the store → GET /vendor/profile is 200 and
//   ACTIVE, and switch-role now accepts VENDOR (and CUSTOMER, the way back).
// Rider and driver: the same up to documents pending review.
// ---------------------------------------------------------------------------

// Unique phone prefix per file (parallel-test gotcha).
const VENDOR_PHONE = '+59200199101';
const RIDER_PHONE = '+59200199102';
const DRIVER_PHONE = '+59200199103';
const PHONES = [VENDOR_PHONE, RIDER_PHONE, DRIVER_PHONE];

let app: FastifyInstance;
let adminToken = '';
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

async function cleanup() {
  const ids = (await app.prisma.user.findMany({ where: { phone: { in: PHONES } }, select: { id: true } })).map((u) => u.id);
  if (ids.length === 0) return;
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: ids } } }, { driver: { userId: { in: ids } } }, { vendor: { owner: { userId: { in: ids } } } }] } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/** Exactly what the phone did: a real OTP, a customer registration, then the
 *  mandatory signup selfie (the root navigator's selfie gate sits before any
 *  earner surface, so every JOIN starts from a selfie-carrying account). */
async function signupCustomer(phone: string): Promise<{ token: string; userId: string }> {
  const code = await requestOtp(app, phone);
  const verified = await app.inject({
    method: 'POST', url: '/api/v1/auth/verify-otp',
    payload: { phone, code }, headers: { 'content-type': 'application/json' },
  });
  const registrationProof = verified.json().data.registrationProof;
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { phone, registrationProof, firstName: 'Mayur', lastName: 'Owner', countryCode: 'GY', role: 'CUSTOMER', acceptTerms: true },
    headers: { 'content-type': 'application/json' },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const userId: string = reg.json().data.user.id;
  await signupSelfieFixture(app.prisma, userId);
  return { token: reg.json().data.tokens.accessToken, userId };
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}
function post(url: string, payload: unknown, token: string) {
  return app.inject({
    method: 'POST', url, payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}
const switchRole = (role: string, token: string) => post('/api/v1/customer/switch-role', { role }, token);

/** The document steps as the app runs them: read the checklist, submit each
 *  missing type through the real route (the upload pointer modelled by the
 *  fixture), and read the status back. */
async function submitMissingDocuments(role: string, userId: string, token: string, vehicleType?: string) {
  const query = `role=${role}${vehicleType ? `&vehicleType=${vehicleType}` : ''}`;
  const before = await get(`/api/v1/verification/status?${query}`, token);
  expect(before.statusCode, before.body).toBe(200);
  const { checklist, missing, roleVerified } = before.json().data;
  expect(roleVerified).toBe(false);
  expect(checklist.length).toBeGreaterThan(0);
  expect(missing).toEqual(checklist);
  for (const docType of missing as string[]) {
    const fileUrl = await ownedVerificationFixture(app.prisma, userId, docType);
    const submitted = await post('/api/v1/verification/documents', { role, docType, fileUrl, consent: true, privacyNoticeVersion: 'v1' }, token);
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json().data.status).toBe('PENDING');
  }
  const after = await get(`/api/v1/verification/status?${query}`, token);
  return after.json().data as { checklist: string[]; missing: string[]; roleVerified: boolean; documents: Array<{ id: string; docType: string; status: string }> };
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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  await cleanup();
  for (const p of PHONES) await app.redis.del(`otp:${p}`, `otp_rate:${p}`, `otp_attempt:${p}`, `otp_verified:${p}`);
  for (const [key, phone] of [['vendor', VENDOR_PHONE], ['rider', RIDER_PHONE], ['driver', DRIVER_PHONE]] as const) {
    const account = await signupCustomer(phone);
    tokens[key] = account.token;
    userIds[key] = account.userId;
  }
  const admin = await loginWithOtp(app, '+5926001000');
  adminToken = admin.json().data.tokens.accessToken;
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('business: a customer with no business lists one, end to end', () => {
  it('holds no vendor role: switch-role refuses VENDOR and the self-profile read is the outsider 403 the app maps to onboarding', async () => {
    const switched = await switchRole('VENDOR', tokens['vendor']!);
    expect(switched.statusCode).toBe(403);
    expect(switched.json().error.code).toBe('FORBIDDEN');

    // the business shell's probe — exactly the 403 ×5 in the staging log
    const probe = await get('/api/v1/vendor/profile', tokens['vendor']!);
    expect(probe.statusCode).toBe(403);
    expect(probe.json().error.code).toBe('FORBIDDEN');
    expect(probe.json().data).toBeUndefined(); // no oracle, no data — the contract the authz matrix pins
  });

  it('"Create store" provisions the business and grants the role in one transaction', async () => {
    const created = await post('/api/v1/partner/become', {
      role: 'VENDOR',
      acceptAgreement: true,
      business: {
        name: 'Mayur’s Mini Mart', vendorType: 'SUPERMARKET', phone: '+5926001234',
        addressLine1: '12 Main Street', city: 'Georgetown', latitude: 6.8013, longitude: -58.1551,
      },
    }, tokens['vendor']!);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.kind).toBe('VENDOR');
    expect(created.json().data.roles).toContain('VENDOR_OWNER');
    expect(created.json().data.activeRole).toBe('VENDOR_OWNER');
  });

  it('the business shell now loads: the store is PENDING_APPROVAL, which the server reports on the same profile read', async () => {
    const profile = await get('/api/v1/vendor/profile', tokens['vendor']!);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data.myRole).toBe('OWNER');
    expect(profile.json().data.vendors).toHaveLength(1);
    expect(profile.json().data.vendors[0].status).toBe('PENDING_APPROVAL');
    expect(profile.json().data.vendors[0].isVerified).toBe(false);
    // owned now: the switcher's instant switch works, and so does the way back
    expect((await switchRole('VENDOR', tokens['vendor']!)).statusCode).toBe(200);
    expect((await switchRole('CUSTOMER', tokens['vendor']!)).statusCode).toBe(200);
  });

  it('the document steps: every checklist document goes in through the real route and waits for review; the store stays pending', async () => {
    const status = await submitMissingDocuments('SUPERMARKET', userIds['vendor']!, tokens['vendor']!);
    expect(status.roleVerified).toBe(false);
    expect(status.missing).toEqual(status.checklist);
    for (const docType of status.checklist) {
      expect(status.documents.find((d) => d.docType === docType)?.status).toBe('PENDING');
    }
    const profile = await get('/api/v1/vendor/profile', tokens['vendor']!);
    expect(profile.json().data.vendors[0].status).toBe('PENDING_APPROVAL');

    // an admin cannot short-cut the evidence: the store approval is checklist-gated
    const vendorId = profile.json().data.vendors[0].id;
    const shortcut = await injectWithApproval(app, {
      method: 'PUT', url: `/api/v1/admin/vendors/${vendorId}/approve`, payload: {},
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    });
    expect(shortcut.statusCode).toBe(409);
    expect(shortcut.json().error.code).toBe('CHECKLIST_INCOMPLETE');
  });

  it('an admin reviews each document through the real route; the completed checklist activates the store and the dashboard loads', async () => {
    const status = await get('/api/v1/verification/status?role=SUPERMARKET', tokens['vendor']!);
    const pending = (status.json().data.documents as Array<{ id: string; status: string }>).filter((d) => d.status === 'PENDING');
    expect(pending.length).toBeGreaterThan(0);
    for (const doc of pending) {
      const approved = await injectWithApproval(app, {
        method: 'PUT', url: `/api/v1/admin/verification/${doc.id}/approve`, payload: {},
        headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json().data.status).toBe('APPROVED');
    }

    const verified = await get('/api/v1/verification/status?role=SUPERMARKET', tokens['vendor']!);
    expect(verified.json().data.roleVerified).toBe(true);
    expect(verified.json().data.missing).toEqual([]);

    // GET /vendor/profile 200, ACTIVE: the business dashboard
    const profile = await get('/api/v1/vendor/profile', tokens['vendor']!);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data.vendors[0].status).toBe('ACTIVE');
    expect(profile.json().data.vendors[0].isVerified).toBe(true);
    expect((await switchRole('VENDOR', tokens['vendor']!)).statusCode).toBe(200);
  });
});

describe('rider: a customer applies to deliver, up to documents pending review', () => {
  it('holds no mover role: both self-profile probes are the outsider 403, switch-role refuses RIDER, and the application checklist is readable', async () => {
    expect((await get('/api/v1/rider/profile', tokens['rider']!)).statusCode).toBe(403);
    expect((await get('/api/v1/driver/profile', tokens['rider']!)).statusCode).toBe(403);
    expect((await switchRole('RIDER', tokens['rider']!)).statusCode).toBe(403);
    // the mover shell decides onboarding vs. dashboard by THIS read — a 200 for anyone
    const status = await get('/api/v1/verification/status?role=MOVER', tokens['rider']!);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data.roleVerified).toBe(false);
    expect(status.json().data.vehicleType).toBeNull();
  });

  it('"Save vehicle" provisions the Rider and the roles; the rider profile loads and the driver one is a real 404', async () => {
    const created = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true }, tokens['rider']!);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.kind).toBe('RIDER');
    expect(created.json().data.roles).toEqual(expect.arrayContaining(['MOVER', 'RIDER']));
    expect((await get('/api/v1/rider/profile', tokens['rider']!)).statusCode).toBe(200);
    expect((await get('/api/v1/driver/profile', tokens['rider']!)).statusCode).toBe(404); // an insider without that profile
    expect((await switchRole('RIDER', tokens['rider']!)).statusCode).toBe(200);
    expect((await switchRole('CUSTOMER', tokens['rider']!)).statusCode).toBe(200);
  });

  it('the documents go in through the real route and wait for review', async () => {
    const status = await submitMissingDocuments('MOVER', userIds['rider']!, tokens['rider']!, 'MOTORCYCLE');
    expect(status.roleVerified).toBe(false);
    expect(status.documents.length).toBeGreaterThan(0);
    expect(status.documents.every((d) => d.status === 'PENDING')).toBe(true);
    // still not live: the rider cannot go online until an admin reviews
    const profile = await get('/api/v1/rider/profile', tokens['rider']!);
    expect(profile.json().data.documentsVerified ?? false).toBe(false);
  });
});

describe('driver: a customer applies to drive, up to documents pending review', () => {
  it('holds no mover role: outsider 403 on both probes, switch-role refuses DRIVER', async () => {
    expect((await get('/api/v1/driver/profile', tokens['driver']!)).statusCode).toBe(403);
    expect((await get('/api/v1/rider/profile', tokens['driver']!)).statusCode).toBe(403);
    expect((await switchRole('DRIVER', tokens['driver']!)).statusCode).toBe(403);
  });

  it('"Save vehicle" with the car’s details provisions the Driver; the driver profile loads and the rider one is a real 404', async () => {
    const created = await post('/api/v1/partner/become', {
      role: 'MOVER', vehicleType: 'CAR', acceptAgreement: true,
      vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: 'HC 1234' },
    }, tokens['driver']!);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.kind).toBe('DRIVER');
    expect(created.json().data.roles).toEqual(expect.arrayContaining(['MOVER', 'DRIVER']));
    expect((await get('/api/v1/driver/profile', tokens['driver']!)).statusCode).toBe(200);
    expect((await get('/api/v1/rider/profile', tokens['driver']!)).statusCode).toBe(404);
    expect((await switchRole('DRIVER', tokens['driver']!)).statusCode).toBe(200);
    expect((await switchRole('CUSTOMER', tokens['driver']!)).statusCode).toBe(200);
  });

  it('the documents go in through the real route and wait for review', async () => {
    const status = await submitMissingDocuments('MOVER', userIds['driver']!, tokens['driver']!, 'CAR');
    expect(status.roleVerified).toBe(false);
    expect(status.documents.length).toBeGreaterThan(0);
    expect(status.documents.every((d) => d.status === 'PENDING')).toBe(true);
    const profile = await get('/api/v1/driver/profile', tokens['driver']!);
    expect(profile.json().data.documentsVerified ?? false).toBe(false);
  });
});
