import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Prisma } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-2] A STORE GOES LIVE BY ONE AUTHORITY, AND THE CONSOLE
// SHOWS WHY IT HAS NOT.
//
// The admin "Approve" route checked only the document checklist and wrote
// ACTIVE itself, so it could make a store live that the single activation
// projection (VerificationService.projectVendorActivation) holds back: an
// incomplete storefront disclosure block once the market's business document
// types are active (DOC-INV-27), and it left no activation expiry. It could
// also reopen the store of a partner who closed their Swift account (the
// wind-down suspends their stores). These tests are written first and fail on
// the old route. The new activation-checklist reads give the console the
// per-document truth it shows, in the gate's own terms.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: VerificationService;
let adminToken: string;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
const activatedDocTypes: string[] = [];
let seq = 0;
const DAY = 86_400_000;
const OPERATOR = { PLATFORM_LEGAL_NAME: 'Westbridge Inc.', PLATFORM_REGISTERED_ADDRESS: '1 Main Street, Georgetown, Guyana', SUPPORT_EMAIL: 'support@example.gy' };
const prevEnv: Record<string, string | undefined> = {};

const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
const MOTORCYCLE_DOCS = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-activation-checklist-test');

async function makeUser(first: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59265${String((marker.charCodeAt(1) + seq) % 10)}${String(seq).padStart(4, '0')}`,
      firstName: first, lastName: `Check${seq}`,
      roles: ['VENDOR_OWNER', 'MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, countryCode: 'GY', ...extra,
    },
  });
  userIds.push(user.id);
  return user;
}

async function doc(userId: string, docType: string, status: 'APPROVED' | 'PENDING' | 'REJECTED', extra: Record<string, unknown> = {}) {
  return app.prisma.verificationDocument.create({
    data: {
      userId, role: 'VENDOR_OWNER' as never, docType, fileUrl: `test/${marker}/${docType}-${nanoid(4)}`,
      status, expiresAt: new Date(Date.now() + 365 * DAY), ...extra,
    } as never,
  });
}

async function makeStore(ownerUserId: string, status: 'PENDING_APPROVAL' | 'SUSPENDED' = 'PENDING_APPROVAL', extra: Record<string, unknown> = {}) {
  seq += 1;
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: ownerUserId }, update: {}, create: { userId: ownerUserId } });
  return app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Check Mart ${seq}`, slug: `check-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET',
      phone: `+59269${String(seq).padStart(5, '0')}`, addressLine1: `${seq} Checklist Street`, city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status, isVerified: false, acceptingOrders: false, ...extra,
    },
  });
}

/** A weekly-fee subscription for a store, in the given billing state (the period ended a week ago when unpaid). */
async function feeSubscription(vendorId: string, status: 'ACTIVE' | 'SUSPENDED' | 'CHURNED') {
  const now = Date.now();
  const paid = status === 'ACTIVE';
  return app.prisma.subscription.create({
    data: {
      vendorId, type: 'SUPERMARKET', status, weeklyRate: 5000, currencyCode: 'GYD',
      currentPeriodStart: new Date(now - (paid ? 1 : 14) * DAY), currentPeriodEnd: new Date(now + (paid ? 6 : -7) * DAY),
      nextBillingDate: new Date(now + (paid ? 6 : -7) * DAY), suspendedAt: paid ? null : new Date(now - 5 * DAY),
    },
  });
}

/**
 * The race shape: a competing writer holds the owner's account row (as account deletion and document decisions do)
 * and has written, but not committed, when the reinstate arrives. The writer commits once the reinstate is either
 * finished (the old route never waited) or plainly blocked behind the lock; then the reinstate's answer is returned.
 */
async function raceAgainstAccountLock<T>(userId: string, write: (tx: Prisma.TransactionClient) => Promise<unknown>, act: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held!: () => void;
  const holding = new Promise<void>((r) => { held = r; });
  const writer = app.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    await write(tx);
    held();
    await gate;
  }, { timeout: 30_000 });
  await holding;
  const acting = act();
  await Promise.race([acting, new Promise((r) => setTimeout(r, 1500))]);
  release();
  await writer;
  return acting;
}

const approve = (vendorId: string) => app.inject({
  method: 'PUT', url: `/api/v1/admin/vendors/${vendorId}/approve`,
  headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
});
const read = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });

/** Engage DOC-INV-27 for GY (a BUSINESS-bucket type goes active) and leave the operator block unconfigured, so a
 *  store whose documents are complete still has an INCOMPLETE disclosure ('operator' missing). Always restored. */
async function withDisclosureGateEngagedAndIncomplete<T>(work: () => Promise<T>): Promise<T> {
  const code = registryCode('GY', 'business_registration');
  await system(() => app.prisma.docType.update({ where: { code }, data: { isActive: true, legalFactsVerifiedAt: new Date() } }));
  activatedDocTypes.push(code);
  const savedEmail = process.env['SUPPORT_EMAIL'];
  delete process.env['SUPPORT_EMAIL'];
  try {
    return await work();
  } finally {
    process.env['SUPPORT_EMAIL'] = savedEmail;
    await system(() => app.prisma.docType.update({ where: { code }, data: { isActive: false, legalFactsVerifiedAt: null } }));
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  for (const [k, v] of Object.entries(OPERATOR)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
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
  await system(() => seedDocRegistry(app.prisma));
  const admin = await loginWithOtp(app, '+5926001000');
  adminToken = admin.json().data.tokens.accessToken;
});

afterAll(async () => {
  for (const k of Object.keys(OPERATOR)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  if (activatedDocTypes.length) {
    await system(() => app.prisma.docType.updateMany({ where: { code: { in: activatedDocTypes } }, data: { isActive: false, legalFactsVerifiedAt: null } }));
  }
  if (userIds.length > 0) {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    const subIds = (await app.prisma.subscription.findMany({ where: { OR: [{ rider: { userId: { in: userIds } } }, { driver: { userId: { in: userIds } } }, { vendor: { owner: { userId: { in: userIds } } } }] }, select: { id: true } })).map((s) => s.id);
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await system(() => purgeSensitiveReadLogs(app.prisma, { action: { contains: 'activation-checklist' } }, 'test-cleanup:admin-activation-checklist').catch(() => 0));
  await app.close();
});

describe('[MC-PR2] the approve route is a request to the one activation authority', () => {
  it('does NOT make a store live past the storefront-disclosure go-live gate (DOC-INV-27)', async () => {
    const owner = await makeUser('Disclose');
    const store = await makeStore(owner.id);
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    await withDisclosureGateEngagedAndIncomplete(async () => {
      const res = await approve(store.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DISCLOSURE_INCOMPLETE');
      expect(res.json().error.message).toMatch(/operator details/);
      expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    });
  });

  it('activates through the projection: the store carries the activation expiry its evidence allows', async () => {
    const owner = await makeUser('Expiry');
    const store = await makeStore(owner.id);
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED', t === 'tin_certificate' ? { expiresAt: new Date(Date.now() + 90 * DAY) } : {});
    const res = await approve(store.id);
    expect(res.statusCode).toBe(200);
    const live = await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } });
    expect(live).toMatchObject({ status: 'ACTIVE', isVerified: true });
    const bound = await svc.checklistEvidenceValidUntil(owner.id, 'SUPERMARKET');
    expect(bound).not.toBeNull();
    expect(live.activationValidUntil?.toISOString()).toBe(bound!.toISOString());
  });

  // [DS816 S3] "Activate now" names one store. The projection it runs used to sweep every store the owner holds, so a
  // second store of the same owner, never shown on the page, went live and started its trial too.
  it('"Activate now" activates the named store only — another store of the same owner is left as it was', async () => {
    const owner = await makeUser('TwoStores');
    const named = await makeStore(owner.id);
    const sibling = await makeStore(owner.id);
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    const res = await approve(named.id);
    expect(res.statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: named.id } })).status).toBe('ACTIVE');
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(await app.prisma.subscription.count({ where: { vendorId: sibling.id } })).toBe(0);
  });

  it('a reinstated (admin-suspended) store passes the same gates and carries the same expiry', async () => {
    const owner = await makeUser('Reinstate');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'ADMIN', isVerified: true });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    await withDisclosureGateEngagedAndIncomplete(async () => {
      const held = await approve(store.id);
      expect(held.statusCode).toBe(409);
      expect(held.json().error.code).toBe('DISCLOSURE_INCOMPLETE');
      expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).status).toBe('SUSPENDED');
    });
    const ok = await approve(store.id);
    expect(ok.statusCode).toBe(200);
    const live = await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } });
    expect(live).toMatchObject({ status: 'ACTIVE', suspensionSource: null, isVerified: true });
    expect(live.activationValidUntil?.toISOString()).toBe((await svc.checklistEvidenceValidUntil(owner.id, 'SUPERMARKET'))!.toISOString());
  });

  it('never reopens the store of a partner who closed their Swift account (wind-down), whatever their documents say', async () => {
    const owner = await makeUser('WindDown');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'WIND_DOWN' });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    const res = await approve(store.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'WIND_DOWN' });
  });

  it('…nor when the owner account is closed and the store was suspended for another reason first', async () => {
    const owner = await makeUser('Closed', { status: 'DEACTIVATED' });
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'ADMIN' });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    const res = await approve(store.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).status).toBe('SUSPENDED');
  });

  // [MC-AD2] A weekly-fee hold is lifted by billing (a payment the provider confirmed), never by the console:
  // reinstating the store row while its subscription stays suspended would show a live store that cannot take
  // orders, and would clear the hold without a payment.
  it('never lifts a weekly-fee hold: a store suspended by billing, its fee unpaid, is refused and nothing changes', async () => {
    const owner = await makeUser('FeeHeld');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'BILLING', isVerified: true });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    const sub = await feeSubscription(store.id, 'SUSPENDED');
    const res = await approve(store.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEE_UNPAID');
    expect(res.json().error.message).toMatch(/weekly fee/);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'BILLING' });
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('SUSPENDED');
    // no false "your store is back" push
    expect(await app.prisma.notification.count({ where: { userId: owner.id } })).toBe(0);
  });

  it('…nor when the store was later suspended by an admin over the same unpaid fee (the source changed, the debt did not)', async () => {
    const owner = await makeUser('FeeAdmin');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'ADMIN', isVerified: true });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    await feeSubscription(store.id, 'CHURNED');
    const res = await approve(store.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEE_UNPAID');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).status).toBe('SUSPENDED');
  });

  it('a store whose fee is paid up is reinstated, even if a stale billing mark is left on it', async () => {
    const owner = await makeUser('FeePaid');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'BILLING', isVerified: true });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    await feeSubscription(store.id, 'ACTIVE');
    const res = await approve(store.id);
    expect(res.statusCode).toBe(200);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'ACTIVE', suspensionSource: null });
  });

  // [Opus S3-1] The reinstate decides again under the owner's account lock — the lock account deletion and every
  // document decision take — so a writer that commits while the reinstate is in flight is honoured, not undone.
  it('a deletion that commits while a reinstate is in flight wins: the deleted owner’s store stays closed', async () => {
    const owner = await makeUser('RaceDelete');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'ADMIN', isVerified: true });
    await feeSubscription(store.id, 'ACTIVE'); // paid up: the reinstate itself is not otherwise held
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    const res = await raceAgainstAccountLock(owner.id, (tx) => tx.user.update({ where: { id: owner.id }, data: { status: 'DEACTIVATED' } }), () => approve(store.id));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'ADMIN' });
    expect(await app.prisma.notification.count({ where: { userId: owner.id } })).toBe(0);
  });

  it('a document revoked while a reinstate is in flight wins: the store stays suspended', async () => {
    const owner = await makeUser('RaceRevoke');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'ADMIN', isVerified: true });
    await feeSubscription(store.id, 'ACTIVE'); // paid up: the reinstate itself is not otherwise held
    const docs: Array<{ id: string }> = [];
    for (const t of SUPERMARKET_DOCS) docs.push(await doc(owner.id, t, 'APPROVED'));
    // the revocation's own transition (VerificationService.revokeDocument): COMMITTED → REVOKED, legacy status REJECTED
    const res = await raceAgainstAccountLock(owner.id, (tx) => tx.verificationDocument.update({ where: { id: docs[0]!.id }, data: { state: 'REVOKED', status: 'REJECTED', reviewNote: 'REVOKED: the photo is unreadable' } as never }), () => approve(store.id));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKLIST_INCOMPLETE');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).status).toBe('SUSPENDED');
  });
});

describe('[MC-PR2] GET /vendors/:id/activation-checklist — the per-document truth, in the gate’s own terms', () => {
  it('lists every required document with its state, the rejection note, and what to do next — and no file reference', async () => {
    const owner = await makeUser('Checklist');
    const store = await makeStore(owner.id);
    await doc(owner.id, 'owner_national_id', 'APPROVED');
    await doc(owner.id, 'business_registration', 'PENDING');
    await doc(owner.id, 'tin_certificate', 'REJECTED', { reviewNote: 'The TIN on the certificate does not match the business name.' });
    const res = await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ vendorId: store.id, applicantId: owner.id, storeStatus: 'PENDING_APPROVAL', role: 'SUPERMARKET', next: 'NEEDS_DOCUMENTS', ready: false });
    expect(data.checklist.complete).toBe(false);
    const byType = Object.fromEntries(data.checklist.items.map((i: { docType: string; state: string }) => [i.docType, i]));
    expect(Object.keys(byType).sort()).toEqual([...SUPERMARKET_DOCS].sort());
    expect(byType['owner_national_id']!.state).toBe('APPROVED');
    expect(byType['business_registration']!.state).toBe('PENDING');
    expect(byType['tin_certificate']).toMatchObject({ state: 'REJECTED', note: 'The TIN on the certificate does not match the business name.' });
    expect(byType['storefront_photo']).toMatchObject({ state: 'MISSING', documentId: null });
    expect(res.body).not.toMatch(/fileUrl|test\//);
  });

  it('a complete checklist reads CAN_ACTIVATE; with the disclosure gate engaged and incomplete it reads NEEDS_DISCLOSURE, naming what is missing', async () => {
    const owner = await makeUser('Ready');
    const store = await makeStore(owner.id);
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    const ready = (await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`)).json().data;
    expect(ready).toMatchObject({ next: 'CAN_ACTIVATE', ready: true });
    expect(ready.checklist.complete).toBe(true);
    await withDisclosureGateEngagedAndIncomplete(async () => {
      const held = (await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`)).json().data;
      expect(held).toMatchObject({ next: 'NEEDS_DISCLOSURE', ready: false, disclosure: { engaged: true, complete: false, missing: ['operator'] } });
    });
  });

  it('a document whose approval no longer counts (expired) reads EXPIRED, as the gate reads it', async () => {
    const owner = await makeUser('Lapsed');
    const store = await makeStore(owner.id);
    await doc(owner.id, 'owner_national_id', 'APPROVED', { expiresAt: new Date(Date.now() - DAY) });
    const data = (await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`)).json().data;
    expect(data.checklist.items.find((i: { docType: string }) => i.docType === 'owner_national_id').state).toBe('EXPIRED');
  });

  it('a wind-down store reads ACCOUNT_CLOSED; an unknown store is a 404', async () => {
    const owner = await makeUser('WindRead');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'WIND_DOWN' });
    expect((await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`)).json().data.next).toBe('ACCOUNT_CLOSED');
    expect((await read('/api/v1/admin/vendors/no-such-store/activation-checklist')).statusCode).toBe(404);
  });

  it('a store held for its unpaid weekly fee reads FEE_UNPAID (no reinstate offered), with the fee state shown', async () => {
    const owner = await makeUser('FeeRead');
    const store = await makeStore(owner.id, 'SUSPENDED', { suspensionSource: 'BILLING', isVerified: true });
    for (const t of SUPERMARKET_DOCS) await doc(owner.id, t, 'APPROVED');
    await feeSubscription(store.id, 'SUSPENDED');
    expect((await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`)).json().data).toMatchObject({ next: 'FEE_UNPAID', subscriptionStatus: 'SUSPENDED', feeOperable: false });
  });

  it('opening a checklist is a recorded sensitive read naming the store', async () => {
    const owner = await makeUser('Logged');
    const store = await makeStore(owner.id);
    expect((await read(`/api/v1/admin/vendors/${store.id}/activation-checklist`)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const rows = await system(() => app.prisma.sensitiveReadLog.findMany({ where: { action: 'GET /vendors/:id/activation-checklist', subjectId: store.id } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.capability).toBe('vendor.read');
  });
});

describe('[MC-PR2] GET /riders|drivers/:id/activation-checklist — the mover gate the Verify button obeys', () => {
  it('a rider with documents missing reads NEEDS_DOCUMENTS; complete reads CAN_VERIFY; verified reads VERIFIED', async () => {
    const user = await makeUser('Mover');
    const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false } });
    await doc(user.id, 'national_id', 'APPROVED');
    const partial = (await read(`/api/v1/admin/riders/${rider.id}/activation-checklist`)).json().data;
    expect(partial).toMatchObject({ moverId: rider.id, kind: 'RIDER', applicantId: user.id, vehicleType: 'MOTORCYCLE', next: 'NEEDS_DOCUMENTS', live: { allowed: false, reason: 'docs' } });
    expect(partial.checklist.items.map((i: { docType: string }) => i.docType).sort()).toEqual([...MOTORCYCLE_DOCS].sort());

    for (const t of MOTORCYCLE_DOCS.filter((t) => t !== 'national_id')) await doc(user.id, t, 'APPROVED');
    expect((await read(`/api/v1/admin/riders/${rider.id}/activation-checklist`)).json().data).toMatchObject({ next: 'CAN_VERIFY', live: { allowed: true } });

    await app.prisma.rider.update({ where: { id: rider.id }, data: { documentsVerified: true } });
    expect((await read(`/api/v1/admin/riders/${rider.id}/activation-checklist`)).json().data.next).toBe('VERIFIED');
  });

  it('a driver with nothing sent reads NEEDS_DOCUMENTS against their own vehicle class', async () => {
    const user = await makeUser('Driver');
    seq += 1;
    const driver = await app.prisma.driver.create({ data: { userId: user.id, vehicleType: 'CAR', documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'Silver', licensePlate: `HC ${marker}${seq}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins' } });
    const data = (await read(`/api/v1/admin/drivers/${driver.id}/activation-checklist`)).json().data;
    expect(data).toMatchObject({ moverId: driver.id, kind: 'DRIVER', vehicleType: 'CAR', next: 'NEEDS_DOCUMENTS' });
    expect(data.checklist.items.length).toBeGreaterThan(3);
    expect(data.checklist.items.every((i: { state: string }) => i.state === 'MISSING')).toBe(true);
    expect((await read('/api/v1/admin/drivers/no-such-driver/activation-checklist')).statusCode).toBe(404);
  });
});
