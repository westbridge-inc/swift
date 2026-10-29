import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { PartnerService } from '../modules/partner/partner.service';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { grantStepUp } from './helpers/step-up';
import { wordFreeTag } from './helpers/fixture-ids';

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
      phone: `+${phoneBase + seq}`, firstName: 'Branchy', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chains-branch-approval', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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
      ownerId: vo.id, name: `Branch Mart ${seq}`, slug: `branch-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET',
      phone: `+59268${String(seq).padStart(5, '0')}`, addressLine1: '1 Branch St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: over.status ?? 'PENDING_APPROVAL', isVerified: over.isVerified ?? false, acceptingOrders: over.acceptingOrders ?? false,
      publicPhone: over.publicPhone ?? null,
    },
  });
}

const storeRow = (id: string) => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { status: true, isVerified: true, acceptingOrders: true } });


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

// ---------------------------------------------------------------------------
// [CHAINS · COORD ruling 29 Oct 2026] A branch never goes live on its owner's documents alone. Its owner's papers are
// checked (they are not asked again), but its own address and pin have not been seen by anyone: it waits in the admin
// queue until a PERSON approves it, and only then can it take orders or start a weekly fee. Every other store goes
// live by itself when its checklist completes, as before.
// ---------------------------------------------------------------------------
const approve = (id: string) => app.inject({
  method: 'PUT', url: `/api/v1/admin/vendors/${id}/approve`,
  headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
});

async function ownerWithLiveStore() {
  const owner = await makeOwner();
  const first = await makeStore(owner.userId, { status: 'ACTIVE', isVerified: true, acceptingOrders: true, publicPhone: PUBLISHED });
  await approvedDocs(owner.userId);
  await grantStepUp(app, owner.token);
  const quote = await signupQuote(app.prisma, owner.userId, { role: 'VENDOR', vendorType: 'SUPERMARKET' });
  const branch = await new PartnerService(app.prisma).addBranch(owner.userId, {
    name: `Branch Mart North ${wordFreeTag(6)}`, vendorType: 'SUPERMARKET', phone: '+5926001234', addressLine1: '2 Branch St', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.14,
  }, { weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode }, surface: 'web' });
  // Its own checklist item: the number customers call.
  await app.prisma.vendor.update({ where: { id: branch.id }, data: { publicPhone: PUBLISHED } });
  return { owner, first, branchId: branch.id };
}

describe('[CHAINS] a branch waits for a person', () => {
  it('a complete checklist does not put a branch live: no orders, no trial, no fee, until a person approves it', async () => {
    const { branchId } = await ownerWithLiveStore();
    await svc.reconcileVendorActivations();
    expect(await storeRow(branchId)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false, acceptingOrders: false });
    expect(await app.prisma.subscription.findFirst({ where: { vendorId: branchId } }), 'no weekly fee begins').toBeNull();

    const res = await approve(branchId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await storeRow(branchId)).toEqual({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    expect(await app.prisma.subscription.findFirst({ where: { vendorId: branchId } }), 'its fee begins at the person\'s approval').toBeTruthy();
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: branchId } })).personApprovalRequired).toBe(false);
  });

  it('no automatic path puts a store waiting for a person live: reconcile, reprojection or auto-approval (a branch, and any flagged store)', async () => {
    const { owner: chainOwner, branchId } = await ownerWithLiveStore();
    const other = await makeOwner();
    const flagged = await makeStore(other.userId, { publicPhone: PUBLISHED });
    await app.prisma.vendor.update({ where: { id: flagged.id }, data: { personApprovalRequired: true } });
    await approvedDocs(other.userId);
    for (const userId of [chainOwner.userId, other.userId]) {
      await svc.reconcileVendorActivations();
      await svc.reprojectVendorActivation(userId);
      // The auto-approval path's own projection and trial start (VerificationService.afterApproval).
      await (svc as unknown as { afterApproval: (u: string) => Promise<boolean> }).afterApproval(userId);
    }
    for (const id of [branchId, flagged.id]) {
      expect(await storeRow(id), id).toEqual({ status: 'PENDING_APPROVAL', isVerified: false, acceptingOrders: false });
      expect(await app.prisma.subscription.findFirst({ where: { vendorId: id } }), `${id}: no weekly fee`).toBeNull();
    }
  });

  it('control: a store made at sign-up still goes live by itself when its checklist completes', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId, { publicPhone: PUBLISHED });
    await approvedDocs(owner.userId);
    await svc.reconcileVendorActivations();
    expect(await storeRow(store.id)).toEqual({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
  });
});
