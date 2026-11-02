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
import { registerAuthRoutes } from './helpers/auth-routes-harness';
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
import { AccountService } from '../modules/user/account.service';

// ---------------------------------------------------------------------------
// [WEB-DELETE · REVIEW-M #2304 S3-1, adopted from REVIEW-GMF's probe] An open closure request holds every store of
// the owner (closure-pause.ts). Nothing may slip past it: a branch added during the request is refused (it would be
// born outside the pause and, once a person approves it, take new orders), and a first store that goes live after
// the request goes live PAUSED (the activation projection's guard).
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

const storeRow = (id: string) => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { status: true, isVerified: true, acceptingOrders: true, closurePausedAt: true } });


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
  await registerAuthRoutes(app);
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
    await app.prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

const approve = (id: string) => app.inject({
  method: 'PUT', url: `/api/v1/admin/vendors/${id}/approve`,
  headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
});



describe('[WEB-DELETE] nothing slips past an open closure request', () => {
  it('a branch cannot be added while the closure request is open: refused in plain words', async () => {
    const { owner, first } = await (async () => {
      const owner = await makeOwner();
      const first = await makeStore(owner.userId, { status: 'ACTIVE', isVerified: true, acceptingOrders: true, publicPhone: PUBLISHED });
      await approvedDocs(owner.userId);
      await grantStepUp(app, owner.token);
      return { owner, first };
    })();
    const receipt = await new AccountService(app).requestClosure(owner.userId, 'website');
    expect(receipt.status).toBe('CLOSURE_REQUESTED');
    expect((await storeRow(first.id)).acceptingOrders).toBe(false);
    const quote = await signupQuote(app.prisma, owner.userId, { role: 'VENDOR', vendorType: 'SUPERMARKET' });
    let added: string | null = null; let refusal: { code?: string; message?: string } | null = null;
    try {
      const b = await new PartnerService(app.prisma).addBranch(owner.userId, {
        name: `Branch Mart North ${wordFreeTag(6)}`, vendorType: 'SUPERMARKET', phone: '+5926001234', addressLine1: '2 Branch St', city: 'Georgetown',
        region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.14,
      }, { weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode }, surface: 'web' });
      added = b.id;
    } catch (e) { refusal = e as { code?: string; message?: string }; }
    if (added) {
      await app.prisma.vendor.update({ where: { id: added }, data: { publicPhone: PUBLISHED } });
      const res = await approve(added);
      expect(res.statusCode).toBeGreaterThan(0);
    }
    expect(added, 'a store added during an open closure request must not be able to take new orders').toBeNull();
    expect(refusal).toMatchObject({ code: 'CLOSURE_REQUESTED', message: expect.stringMatching(/^You asked Swift to close your account, so a new branch can’t be added/) });
  });

  it('a first store going live after the request goes live PAUSED (the activation guard)', async () => {
    const owner = await makeOwner();
    const store = await makeStore(owner.userId, { publicPhone: PUBLISHED });
    await approvedDocs(owner.userId);
    await new AccountService(app).requestClosure(owner.userId, 'app');
    expect((await storeRow(store.id)).closurePausedAt).toBeInstanceOf(Date);
    await svc.reconcileVendorActivations();
    const row = await storeRow(store.id);
    expect(row).toMatchObject({ status: 'ACTIVE', isVerified: true, acceptingOrders: false });
    expect(row.closurePausedAt).toBeInstanceOf(Date);
  });
});
