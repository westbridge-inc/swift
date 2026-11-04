import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { VerificationService } from '../modules/verification/verification.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { partnerApprovalsOpen } from '../modules/verification/approval-brake';
import { REVIEW_QUEUE_SELECT, reviewQueueRow } from '../modules/admin/review-queue-row';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { ownedVerificationFixture } from './helpers/verification-object';

// ---------------------------------------------------------------------------
// [BUG-HUNT F23 · COORD 4 Nov 2026] "Review now, approve on launch day", and a free trial starts the day a partner is
// approved. The last approval starts the clock at once, so a reviewer doing the owner's "check now" burned a partner's
// 14 days. While PARTNER_APPROVALS_OPEN is closed: every paper can be approved except the one that would complete a
// partner, which stays waiting with a marker; nothing machine-approves; and no door births a trial.
// Runs against real Postgres through the real approve path. Synthetic data only.
// ---------------------------------------------------------------------------

const YEAR = 365 * 24 * 3600 * 1000;
const STORE_DOCS = ['owner_national_id', 'business_registration', 'storefront_photo'];
const MOVER_DOCS = ['vehicle_insurance', 'vehicle_registration', 'drivers_licence'];
const marker = nanoid(6).toLowerCase();
let app: FastifyInstance;
let svc: VerificationService;
let subscriptions: SubscriptionService;
let adminToken: string;
const userIds: string[] = [];
let seq = 0;

const close = () => { process.env['PARTNER_APPROVALS_OPEN'] = '0'; };
afterEach(() => { delete process.env['PARTNER_APPROVALS_OPEN']; });

async function makeUser(first: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59266${String(marker.charCodeAt(0) % 10)}${String(seq).padStart(4, '0')}`,
      firstName: first, lastName: `Brake${seq}`, roles: ['VENDOR_OWNER', 'MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeStore(ownerUserId: string) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: ownerUserId }, update: {}, create: { userId: ownerUserId } });
  return app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Brake Mart ${seq}`, slug: `brake-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET', phone: `+59268${String(seq).padStart(5, '0')}`,
      addressLine1: '1 Brake St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'PENDING_APPROVAL', isVerified: false,
      acceptingOrders: false, publicPhone: '+5926001100',
    },
  });
}

const paper = (userId: string, docType: string, role: string, status: 'PENDING' | 'APPROVED') => app.prisma.verificationDocument.create({
  data: { userId, role: role as never, docType, fileUrl: `test/${marker}/${nanoid(6)}`, status, ...(status === 'APPROVED' ? { expiresAt: new Date(Date.now() + YEAR) } : {}) } as never,
});

/** A partner with every paper approved but the last, which waits for a reviewer. */
async function storeAtTheLastPaper(first = 'Store') {
  const owner = await makeUser(first);
  const store = await makeStore(owner.id);
  for (const docType of STORE_DOCS.slice(0, -1)) await paper(owner.id, docType, 'VENDOR_OWNER', 'APPROVED');
  const last = await paper(owner.id, STORE_DOCS.at(-1)!, 'VENDOR_OWNER', 'PENDING');
  return { owner, store, last };
}

async function riderAtTheLastPaper() {
  const user = await makeUser('Rider');
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  for (const docType of MOVER_DOCS.slice(0, -1)) await paper(user.id, docType, 'MOVER', 'APPROVED');
  const last = await paper(user.id, MOVER_DOCS.at(-1)!, 'MOVER', 'PENDING');
  return { user, rider, last };
}

const approve = (id: string) => svc.approveDocument(id, 'admin-brake', new Date(Date.now() + YEAR));
const feeOf = (where: Record<string, string>) => app.prisma.subscription.findFirst({ where });
const docOf = (id: string) => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await registerAuthRoutes(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  subscriptions = new SubscriptionService(app.prisma);
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
}, 60_000);

afterAll(async () => {
  if (userIds.length > 0) {
    const where = { OR: [{ rider: { userId: { in: userIds } } }, { vendor: { owner: { userId: { in: userIds } } } }] };
    const subIds = (await app.prisma.subscription.findMany({ where, select: { id: true } })).map((s) => s.id);
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.moverFeeAuthority.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => undefined);
    await app.prisma.verificationDecisionOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } }).catch(() => undefined);
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => undefined);
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await app.close();
});

describe('[F23] who the switch opens for', () => {
  it.each([
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'production', PARTNER_APPROVALS_OPEN: '' }, false],
    [{ NODE_ENV: 'production', PARTNER_APPROVALS_OPEN: '0' }, false],
    [{ NODE_ENV: 'production', PARTNER_APPROVALS_OPEN: 'true' }, false],
    [{ NODE_ENV: 'production', PARTNER_APPROVALS_OPEN: ' 1' }, false],
    [{ NODE_ENV: 'production', PARTNER_APPROVALS_OPEN: '1' }, true],
    [{ NODE_ENV: 'test' }, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'development', PARTNER_APPROVALS_OPEN: '0' }, false],
    [{ NODE_ENV: 'development', PARTNER_APPROVALS_OPEN: 'no' }, false],
  ])('%j -> %s', (env, open) => {
    expect(partnerApprovalsOpen(env)).toBe(open);
  });
});

describe('[F23] closed: the last paper waits and nothing starts', () => {
  it('a store: refused in the reviewer\'s words, the paper still waiting, no live store, no fee, no notice', async () => {
    const { owner, store, last } = await storeAtTheLastPaper();
    close();
    await expect(approve(last.id)).rejects.toMatchObject({
      statusCode: 409, code: 'PARTNER_APPROVAL_HELD',
      message: `This is the last paper for ${store.name}. Approving it starts their free trial. Hold it until ordering day.`,
    });
    expect(await docOf(last.id)).toMatchObject({ status: 'PENDING' });
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(await feeOf({ vendorId: store.id })).toBeNull();
    expect(await app.prisma.notification.count({ where: { userId: owner.id, title: 'Document approved' } })).toBe(0);
  });

  it('a rider: the same, by name', async () => {
    const { user, rider, last } = await riderAtTheLastPaper();
    close();
    await expect(approve(last.id)).rejects.toMatchObject({
      code: 'PARTNER_APPROVAL_HELD',
      message: `This is the last paper for ${user.firstName} ${user.lastName}. Approving it starts their free trial. Hold it until ordering day.`,
    });
    expect(await feeOf({ riderId: rider.id })).toBeNull();
  });

  it('someone with no vehicle yet: the last paper is held too, or the vehicle would start the clock', async () => {
    const user = await makeUser('NoVehicle');
    for (const docType of MOVER_DOCS.slice(0, -1)) await paper(user.id, docType, 'MOVER', 'APPROVED');
    const last = await paper(user.id, MOVER_DOCS.at(-1)!, 'MOVER', 'PENDING');
    close();
    await expect(approve(last.id)).rejects.toMatchObject({ code: 'PARTNER_APPROVAL_HELD' });
  });

  it('the marker says who checked it and when, for staff only', async () => {
    const { last } = await storeAtTheLastPaper();
    close();
    await approve(last.id).catch(() => undefined);
    const held = await docOf(last.id);
    expect(held.approvalHeldBy).toBe('admin-brake');
    expect(held.approvalHeldAt).toBeInstanceOf(Date);
    const row = reviewQueueRow({ ...await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: last.id }, select: REVIEW_QUEUE_SELECT }), previousDecision: null });
    expect(row.approvalHeldAt).toEqual(held.approvalHeldAt);
    expect(row.approvalHeldBy).toBe('admin-brake');
    const mine = await svc.getStatus(held.userId, 'SUPERMARKET');
    expect(JSON.stringify(mine)).not.toContain('approvalHeld');
  });

  it('a paper that is not the last is approved as ever, with no marker', async () => {
    const owner = await makeUser('Early');
    await makeStore(owner.id);
    const first = await paper(owner.id, STORE_DOCS[0]!, 'VENDOR_OWNER', 'PENDING');
    close();
    await approve(first.id);
    expect(await docOf(first.id)).toMatchObject({ status: 'APPROVED', approvalHeldAt: null });
  });

  it('a partner with a fee on record renews as ever: their trial is not at stake', async () => {
    const { owner, store, last } = await storeAtTheLastPaper('Renew');
    await subscriptions.startTrialForVendor(store.id);
    close();
    await approve(last.id);
    expect(await docOf(last.id)).toMatchObject({ status: 'APPROVED' });
    expect(owner.id).toBeTruthy();
  });

  it('the console\'s Approve refuses in the same words', async () => {
    const owner = await makeUser('Console');
    const store = await makeStore(owner.id);
    for (const docType of STORE_DOCS) await paper(owner.id, docType, 'VENDOR_OWNER', 'APPROVED');
    close();
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${store.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('PARTNER_APPROVAL_HELD');
    expect(res.json().error.message).toContain(`This is the last paper for ${store.name}.`);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(await feeOf({ vendorId: store.id })).toBeNull();
  });

  it('a store whose papers were complete before the brake stays where it is on every run of the projection', async () => {
    const owner = await makeUser('Before');
    const store = await makeStore(owner.id);
    for (const docType of STORE_DOCS) await paper(owner.id, docType, 'VENDOR_OWNER', 'APPROVED');
    close();
    await svc.reprojectVendorActivation(owner.id);
    await svc.reconcileVendorActivations();
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(await feeOf({ vendorId: store.id })).toBeNull();
  });

  it('an approval tail left on the outbox from before the brake finishes quietly: nothing starts, nothing is paged', async () => {
    const user = await makeUser('Tail');
    const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    for (const docType of MOVER_DOCS) await paper(user.id, docType, 'MOVER', 'APPROVED');
    close();
    await expect((svc as unknown as { afterApproval(id: string): Promise<boolean> }).afterApproval(user.id)).resolves.toBe(true);
    expect(await feeOf({ riderId: rider.id })).toBeNull();
  });

  it('the belt: no door births a fee row, whatever reached it', async () => {
    const { store } = await storeAtTheLastPaper();
    const { rider } = await riderAtTheLastPaper();
    close();
    await expect(subscriptions.startTrialForVendor(store.id)).rejects.toMatchObject({ code: 'PARTNER_APPROVAL_HELD' });
    await expect(subscriptions.startTrialForRider(rider.id)).rejects.toMatchObject({ code: 'PARTNER_APPROVAL_HELD' });
    expect(await feeOf({ vendorId: store.id })).toBeNull();
    expect(await feeOf({ riderId: rider.id })).toBeNull();
  });
});

describe('[F23] closed: no machine approves anything', () => {
  it('an engine\'s approval waits for a person, on any paper, last or not', async () => {
    const owner = await makeUser('Auto');
    await makeStore(owner.id);
    const engine = { ...getKycProvider(), verifyDocument: async () => ({ status: 'approved' as const, referenceToken: 'stub_document' }), verifyIdentity: async () => ({ status: 'approved' as const, referenceToken: 'stub_identity' }) };
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), engine as never);
    close();
    const doc = await service.submitDocument(owner.id, 'SUPERMARKET', 'storefront_photo', await ownedVerificationFixture(app.prisma, owner.id, `auto-${nanoid(6)}`), 'v1');
    expect(doc.status).toBe('PENDING');
  });
});

describe('[F23] ordering day: the switch opens, and the batch goes through', () => {
  it('the held paper is approved by a reviewer, the marker clears, the store is live, and the trial starts now', async () => {
    const { store, last } = await storeAtTheLastPaper('Batch');
    close();
    await approve(last.id).catch(() => undefined);
    process.env['PARTNER_APPROVALS_OPEN'] = '1';
    const before = Date.now();
    await approve(last.id);
    expect(await docOf(last.id)).toMatchObject({ status: 'APPROVED', approvalHeldAt: null, approvalHeldBy: null });
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'ACTIVE', isVerified: true });
    const fee = await feeOf({ vendorId: store.id });
    expect(fee).not.toBeNull();
    expect(fee!.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('a rider\'s held paper the same', async () => {
    const { rider, last } = await riderAtTheLastPaper();
    close();
    await approve(last.id).catch(() => undefined);
    delete process.env['PARTNER_APPROVALS_OPEN'];
    await approve(last.id);
    expect(await feeOf({ riderId: rider.id })).not.toBeNull();
  });
});
