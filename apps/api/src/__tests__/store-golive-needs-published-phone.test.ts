import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { SubscriptionService } from '../modules/subscription/subscription.service';

// ---------------------------------------------------------------------------
// Owner decision 51 (14 Oct 2026): a store cannot go live without a published
// contact phone. Once a store accepts an order the customer can no longer
// cancel it in the app and is told to contact the store (owner #46), so there
// must always be a number to call.
//
// The gate lives in the ONE authority that makes a store live — the activation
// projection (verification.service) — and holds only a store's FIRST go-live:
// a store already live without a number is never taken down (owner: no
// automatic unpublishing). The owner is told once, and the store goes live the
// moment the number is saved.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
const PUBLISHED = '+5926007788';
const KIND = 'vendor_needs_public_phone';

let app: FastifyInstance;
let svc: VerificationService;
let adminToken: string;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_320_000_000 + Math.floor(Math.random() * 800_000_000);

async function makeOwner() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Golive', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'golive-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function approvedDocs(userId: string) {
  for (const docType of SUPERMARKET_DOCS) {
    await app.prisma.verificationDocument.create({
      data: {
        userId, role: 'VENDOR_OWNER' as never, docType, fileUrl: `test/${marker}/${docType}`,
        status: 'APPROVED', expiresAt: new Date(Date.now() + 365 * DAY),
      } as never,
    });
  }
}

async function makeStore(ownerUserId: string, over: { status?: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED'; isVerified?: boolean; acceptingOrders?: boolean; publicPhone?: string | null } = {}) {
  seq += 1;
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: ownerUserId }, update: {}, create: { userId: ownerUserId } });
  return app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Golive Mart ${seq}`, slug: `golive-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET',
      phone: `+59268${String(seq).padStart(5, '0')}`, addressLine1: '1 Golive St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: over.status ?? 'PENDING_APPROVAL', isVerified: over.isVerified ?? false, acceptingOrders: over.acceptingOrders ?? false,
      publicPhone: over.publicPhone ?? null,
    },
  });
}

const storeRow = (id: string) => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { status: true, isVerified: true, acceptingOrders: true } });
const notices = (userId: string) => app.prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: KIND } } });

function inject(method: 'GET' | 'PUT', url: string, token: string, vendorId: string, payload?: unknown) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`, 'x-vendor-id': vendorId,
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
});

afterAll(async () => {
  if (userIds.length > 0) {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    const subIds = (await app.prisma.subscription.findMany({ where: { vendor: { owner: { userId: { in: userIds } } } }, select: { id: true } })).map((s) => s.id);
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('[owner #51] a store goes live only with a published contact phone', () => {
  it('documents done, no published number: the store stays pending, and the owner is told once', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId);
    await approvedDocs(owner.userId);

    await svc.reconcileVendorActivations();
    expect(await storeRow(store.id)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false, acceptingOrders: false });
    const told = await notices(owner.userId);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Add the number customers can call', data: { kind: KIND, vendorId: store.id } });
    expect(told[0]!.body).not.toContain(store.phone); // never the account line

    // The daily belt runs again: still pending, still exactly one notice.
    await svc.reconcileVendorActivations();
    expect((await storeRow(store.id)).status).toBe('PENDING_APPROVAL');
    expect(await notices(owner.userId)).toHaveLength(1);

    // The owner's dashboard says what is missing.
    const profile = await inject('GET', '/api/v1/vendor/profile', owner.token, store.id);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data.vendors.find((v: { id: string }) => v.id === store.id)).toMatchObject({ goLiveMissing: ['PUBLISHED_PHONE'] });
  });

  it('a number that is not a callable Guyana line does not count', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId, { publicPhone: '911' });
    await approvedDocs(owner.userId);
    await svc.reconcileVendorActivations();
    expect((await storeRow(store.id)).status).toBe('PENDING_APPROVAL');
  });

  it('saving the number puts a waiting store live at once — no wait for the daily belt', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId);
    await approvedDocs(owner.userId);

    const saved = await inject('PUT', '/api/v1/vendor/profile', owner.token, store.id, { publicPhone: '+592 600 7788' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ publicPhone: PUBLISHED, status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    expect(await storeRow(store.id)).toEqual({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    const profile = await inject('GET', '/api/v1/vendor/profile', owner.token, store.id);
    expect(profile.json().data.vendors.find((v: { id: string }) => v.id === store.id)).toMatchObject({ goLiveMissing: [] });
  });

  it('control — with a published number the documents put the store live as before', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId, { publicPhone: PUBLISHED });
    await approvedDocs(owner.userId);
    await svc.reconcileVendorActivations();
    expect(await storeRow(store.id)).toEqual({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    expect(await notices(owner.userId)).toHaveLength(0);
  });

  it('a store already live without a number is never taken down for it', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId, { status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    await approvedDocs(owner.userId);
    await svc.reconcileVendorActivations();
    expect(await storeRow(store.id)).toEqual({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    expect(await notices(owner.userId)).toHaveLength(0);
    const profile = await inject('GET', '/api/v1/vendor/profile', owner.token, store.id);
    expect(profile.json().data.vendors.find((v: { id: string }) => v.id === store.id)).toMatchObject({ goLiveMissing: [] });
  });

  it('the admin approve button holds a never-live store with no published number; a store being reinstated is never held', async () => {
    const approve = (id: string) => app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
    });
    const owner = await makeOwner();
    const store = await makeStore(owner.userId);
    await approvedDocs(owner.userId);
    const held = await approve(store.id);
    expect(held.statusCode, held.body).toBe(409);
    expect(held.json().error.code).toBe('PUBLISHED_PHONE_MISSING');
    expect((await storeRow(store.id)).status).toBe('PENDING_APPROVAL');

    // A store that WAS live (it carries the subscription its activation started)
    // and was suspended comes back without being asked for a number.
    const returning = await makeOwner();
    const suspended = await makeStore(returning.userId, { status: 'SUSPENDED', isVerified: true });
    await approvedDocs(returning.userId);
    await new SubscriptionService(app.prisma).startTrialForVendor(suspended.id);
    const reinstated = await approve(suspended.id);
    expect(reinstated.statusCode, reinstated.body).toBe(200);
    expect((await storeRow(suspended.id)).status).toBe('ACTIVE');
  });

  it('[DS1142 S3 · DS1145 S3] a never-live store an admin suspended never goes live without a number — approving lifts the suspension back to waiting, where the owner adds it and the store goes live', async () => {
    const approve = (id: string) => app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
    });
    const checklist = (id: string) => app.inject({
      method: 'GET', url: `/api/v1/admin/vendors/${id}/activation-checklist`, headers: { authorization: `Bearer ${adminToken}` },
    });
    const owner = await makeOwner();
    const neverLive = await makeStore(owner.userId, { status: 'SUSPENDED' });
    await app.prisma.vendor.update({ where: { id: neverLive.id }, data: { suspensionSource: 'ADMIN' } });
    await approvedDocs(owner.userId);
    // The console says what approving will do, from the same verdict the route enforces.
    expect((await checklist(neverLive.id)).json().data.next).toBe('CAN_LIFT_TO_WAITING');
    const lifted = await approve(neverLive.id);
    expect(lifted.statusCode, lifted.body).toBe(200);
    // Not live — waiting, with no subscription started (that is the activation's), so it still reads as never live.
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: neverLive.id }, select: { status: true, suspensionSource: true, isVerified: true } }))
      .toEqual({ status: 'PENDING_APPROVAL', suspensionSource: null, isVerified: false });
    expect(await app.prisma.subscription.count({ where: { vendorId: neverLive.id } })).toBe(0);
    expect((await checklist(neverLive.id)).json().data.next).toBe('NEEDS_PHONE');
    const again = await approve(neverLive.id);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('PUBLISHED_PHONE_MISSING');
    // The owner is asked for the number…
    const asked = await app.prisma.notification.findMany({ where: { userId: owner.userId, title: 'Add the number customers can call' } });
    expect(asked.length).toBeGreaterThanOrEqual(1);
    // …and, from the waiting store, adding it puts the store live: the recovery the suspended store did not have.
    const saved = await inject('PUT', '/api/v1/vendor/profile', owner.token, neverLive.id, { publicPhone: PUBLISHED });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await storeRow(neverLive.id)).toMatchObject({ status: 'ACTIVE', isVerified: true });
  });

  it('[DS1145 S3] lifting decides again under the lock: a store wound down between the first read and the write stays closed', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId, { status: 'SUSPENDED' });
    await app.prisma.vendor.update({ where: { id: store.id }, data: { suspensionSource: 'WIND_DOWN' } });
    await approvedDocs(owner.userId);
    // The route's first read sees the store a moment before its owner's account closed.
    const real = app.prisma.vendor.findUnique.bind(app.prisma.vendor);
    let served = false;
    const stale = vi.spyOn(app.prisma.vendor, 'findUnique').mockImplementation((async (args: any) => {
      const row = await real(args);
      if (!served && args?.include?.owner && row) { served = true; return { ...row, suspensionSource: 'ADMIN' }; }
      return row;
    }) as never);
    try {
      const res = await app.inject({
        method: 'PUT', url: `/api/v1/admin/vendors/${store.id}/approve`,
        headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
      });
      expect(served, 'the approve route read the stale row').toBe(true);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    } finally { stale.mockRestore(); }
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id }, select: { status: true, suspensionSource: true } }))
      .toEqual({ status: 'SUSPENDED', suspensionSource: 'WIND_DOWN' });
  });

  it('[owner #51] a store that has been live is never held for a number: suspended with a subscription, the console offers Reinstate', async () => {
    const owner = await makeOwner();
    const wasLive = await makeStore(owner.userId, { status: 'SUSPENDED', isVerified: true });
    await approvedDocs(owner.userId);
    await new SubscriptionService(app.prisma).startTrialForVendor(wasLive.id);
    const read = await app.inject({ method: 'GET', url: `/api/v1/admin/vendors/${wasLive.id}/activation-checklist`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(read.json().data.next).toBe('CAN_REINSTATE');
  });
});
