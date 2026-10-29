import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { grantStepUp } from './helpers/step-up';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { PartnerService } from '../modules/partner/partner.service';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [CHAINS · owner 29 Oct 2026] One owner runs many branches from one login.
// POST /vendor/stores adds a branch under the SAME owner: owner only (never a
// manager or staff), only once Swift has approved a first store (the owner's
// identity and papers are already checked), a fresh "confirm it's you", the
// weekly fee shown and ticked for THIS branch (each branch pays its own fee),
// a cap per owner. The branch starts waiting for approval like any store; the
// one activation projection makes it live once its own checklist is met.
// GET /vendor/stores/branch-terms is what the add-a-branch screen shows first:
// the fee, whether the owner's running free trial covers it and until when.
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Branch', lastName: `Person${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/branch.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chains-branch', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function storeFor(ownerId: string, status: 'ACTIVE' | 'PENDING_APPROVAL' = 'ACTIVE') {
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId, name: `Chain Kitchen ${wordFreeTag(8)}`, slug: `chain-kitchen-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: testPhone(), addressLine1: '6 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status, acceptingOrders: status === 'ACTIVE', isCurrentlyOpen: status === 'ACTIVE', isVerified: status === 'ACTIVE',
    },
  });
  vendorIds.push(vendor.id);
  return vendor;
}

async function makeOwner(firstStoreStatus: 'ACTIVE' | 'PENDING_APPROVAL' = 'ACTIVE', stepUp = true) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  if (stepUp) await grantStepUp(app, owner.token);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  ownerIds.push(vo.id);
  const first = await storeFor(vo.id, firstStoreStatus);
  return { ...owner, ownerId: vo.id, firstId: first.id };
}

const branchBody = (over: Record<string, unknown> = {}) => ({
  name: `North Branch ${wordFreeTag(6)}`, vendorType: 'RESTAURANT', phone: testPhone(),
  addressLine1: '12 Sheriff Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.14,
  ...over,
});

async function ackFor(userId: string, vendorType = 'RESTAURANT') {
  const quote = await signupQuote(app.prisma, userId, { role: 'VENDOR', vendorType });
  return { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode };
}

const add = (token: string, payload: Record<string, unknown>, vendorId?: string) => app.inject({
  method: 'POST', url: '/api/v1/vendor/stores', payload,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(vendorId ? { 'x-vendor-id': vendorId } : {}) },
});
const terms = (token: string, query = '') => app.inject({
  method: 'GET', url: `/api/v1/vendor/stores/branch-terms${query}`, headers: { authorization: `Bearer ${token}` },
});
const storesOf = (ownerId: string) => app.prisma.vendor.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
});

afterEach(() => { delete process.env['VENDOR_BRANCH_LIMIT']; });

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const all = await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } });
  const ids = [...new Set([...vendorIds, ...all.map((v) => v.id)])];
  const subs = await app.prisma.subscription.findMany({ where: { vendorId: { in: ids } }, select: { id: true } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
  await app.prisma.subscription.deleteMany({ where: { vendorId: { in: ids } } });
  await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } });
  const clusters = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
  await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusters.map((c) => c.clusterId) } } });
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await app.prisma.vendor.deleteMany({ where: { id: { in: ids } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[CHAINS] POST /vendor/stores — add a branch', () => {
  it('an approved owner adds a branch: same owner, waiting for approval, its fee tick on the record', async () => {
    const owner = await makeOwner();
    const ack = await ackFor(owner.userId);
    const res = await add(owner.token, { business: branchBody({ name: `Royal North ${wordFreeTag(6)}` }), weeklyFeeAck: ack });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    expect(data).toMatchObject({ status: 'PENDING_APPROVAL' });
    const stores = await storesOf(owner.ownerId);
    expect(stores.map((s) => s.id)).toEqual([owner.firstId, data.id]);
    expect(stores[1]).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false, acceptingOrders: false, vendorType: 'RESTAURANT', latitude: 6.81 });
    const tick = await app.prisma.consentRecord.findFirst({ where: { subjectId: owner.userId, documentType: 'weekly_fee_acknowledgement' } });
    expect(tick?.evidence).toMatchObject({ path: 'vendor/stores', vendorId: data.id, weeklyFee: { amount: ack.amount, currencyCode: ack.currencyCode } });
    const audit = await app.prisma.auditLog.findFirst({ where: { userId: owner.userId, action: 'VENDOR_BRANCH_ADDED', entityId: data.id } });
    expect(audit).toBeTruthy();
    // The switcher lists it at once.
    const list = await app.inject({ method: 'GET', url: '/api/v1/vendor/stores', headers: { authorization: `Bearer ${owner.token}` } });
    expect(list.json().data.stores.map((s: { id: string }) => s.id)).toEqual([owner.firstId, data.id]);
  });

  it('a manager or staff member cannot add a branch, even with a fresh confirmation', async () => {
    const owner = await makeOwner();
    for (const role of ['MANAGER', 'STAFF'] as const) {
      const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
      await grantStepUp(app, member.token);
      await app.prisma.vendorStaff.create({ data: { vendorId: owner.firstId, userId: member.userId, role, invitedBy: owner.userId } });
      const res = await add(member.token, { business: branchBody(), weeklyFeeAck: await ackFor(member.userId) }, owner.firstId);
      expect(res.statusCode, `${role}: ${res.body}`).toBe(403);
      expect(res.json().error.code).toBe('STAFF_FORBIDDEN');
    }
    expect(await storesOf(owner.ownerId)).toHaveLength(1);
  });

  it('an owner whose first store Swift has not approved yet cannot add branches', async () => {
    const owner = await makeOwner('PENDING_APPROVAL');
    const res = await add(owner.token, { business: branchBody(), weeklyFeeAck: await ackFor(owner.userId) });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('FIRST_STORE_NOT_APPROVED');
    expect(await storesOf(owner.ownerId)).toHaveLength(1);
  });

  // [COORD ruling 29 Oct] An owner in trouble anywhere adds no branch: each refusal says why, and nothing is written.
  const sub = (vendorId: string, status: 'PAST_DUE' | 'SUSPENDED') => app.prisma.subscription.create({ data: {
    vendorId, type: 'RESTAURANT', status, weeklyRate: 15000, currencyCode: 'GYD', billingMethod: 'CASH',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(), nextBillingDate: new Date() } });
  type Owner = Awaited<ReturnType<typeof makeOwner>>;
  const troubles: Array<[string, string, (o: Owner) => Promise<unknown>]> = [
    ['a sibling store Swift suspended', 'STORE_SUSPENDED', async (o) => {
      const s = await storeFor(o.ownerId); await app.prisma.vendor.update({ where: { id: s.id }, data: { status: 'SUSPENDED', suspensionSource: 'ADMIN' } });
    }],
    ['a sibling store Swift closed (banned)', 'STORE_CLOSED', async (o) => {
      const s = await storeFor(o.ownerId); await app.prisma.vendor.update({ where: { id: s.id }, data: { status: 'CLOSED' } });
    }],
    ['a store whose MMG checkout Swift holds', 'STORE_ON_HOLD', (o) =>
      app.prisma.vendor.update({ where: { id: o.firstId }, data: { mmgCheckoutHeldAt: new Date(), mmgCheckoutHeldReason: 'chains test' } })],
    ['an open enforcement hold on the owner', 'OWNER_ON_HOLD', (o) =>
      app.prisma.enforcementAction.create({ data: { accountId: o.userId, level: 'REVIEW_FIRST', reasonCode: 'CHAINS_TEST', signalsFired: [] as never, decidedBy: 'SYSTEM' } })],
    ['a weekly fee past due on a store', 'FEE_UNPAID', (o) => sub(o.firstId, 'PAST_DUE')],
    ['a store billing-suspended for its fee', 'FEE_UNPAID', async (o) => {
      const s = await storeFor(o.ownerId); await app.prisma.vendor.update({ where: { id: s.id }, data: { status: 'SUSPENDED', suspensionSource: 'BILLING' } });
      await sub(s.id, 'SUSPENDED');
    }],
    ['documents approved once, but no store live now', 'NO_ACTIVE_STORE', (o) =>
      app.prisma.vendor.update({ where: { id: o.firstId }, data: { status: 'PENDING_APPROVAL', isVerified: true } })],
  ];
  for (const [what, code, harm] of troubles) {
    it(`refused with ${code}: ${what}`, async () => {
      const owner = await makeOwner();
      await harm(owner);
      const before = (await storesOf(owner.ownerId)).length;
      const res = await add(owner.token, { business: branchBody(), weeklyFeeAck: await ackFor(owner.userId) });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.json().error.code).toBe(code);
      expect(await storesOf(owner.ownerId)).toHaveLength(before);
      await app.prisma.enforcementAction.deleteMany({ where: { accountId: owner.userId } });
    });
  }

  it('an owner whose own account is not active adds no branch (checked by the service, under its lock)', async () => {
    const owner = await makeOwner();
    await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'SUSPENDED' } });
    await expect(new PartnerService(app.prisma).addBranch(owner.userId, { ...branchBody(), vendorType: 'RESTAURANT' } as Parameters<PartnerService['addBranch']>[1],
      { weeklyFeeAck: await ackFor(owner.userId), surface: 'web' })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect(await storesOf(owner.ownerId)).toHaveLength(1);
  });

  it('a branch is born waiting for a person at Swift; a first store made at sign-up is not', async () => {
    const owner = await makeOwner();
    const res = await add(owner.token, { business: branchBody(), weeklyFeeAck: await ackFor(owner.userId) });
    expect(res.statusCode, res.body).toBe(201);
    const branch = await app.prisma.vendor.findUniqueOrThrow({ where: { id: res.json().data.id } });
    expect(branch.personApprovalRequired).toBe(true);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: owner.firstId } })).personApprovalRequired).toBe(false);
  });

  it('needs a fresh "confirm it\'s you"', async () => {
    const owner = await makeOwner('ACTIVE', false);
    const res = await add(owner.token, { business: branchBody(), weeklyFeeAck: await ackFor(owner.userId) });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await storesOf(owner.ownerId)).toHaveLength(1);
  });

  it('the weekly fee must be shown and ticked for this branch, at the fee quoted now', async () => {
    const owner = await makeOwner();
    const none = await add(owner.token, { business: branchBody() });
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json().error.code).toBe('WEEKLY_FEE_ACK_REQUIRED');
    const ack = await ackFor(owner.userId);
    const wrong = await add(owner.token, { business: branchBody(), weeklyFeeAck: { ...ack, amount: ack.amount - 1000 } });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json().error.code).toBe('WEEKLY_FEE_CHANGED');
    expect(await storesOf(owner.ownerId)).toHaveLength(1);
  });

  it('a pin outside the launch market is refused before anything is written', async () => {
    const owner = await makeOwner();
    const res = await add(owner.token, { business: branchBody({ latitude: 40.7, longitude: -74 }), weeklyFeeAck: await ackFor(owner.userId) });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('STORE_PIN_OUT_OF_MARKET');
    expect(await storesOf(owner.ownerId)).toHaveLength(1);
  });

  it('an owner can hold at most VENDOR_BRANCH_LIMIT stores (default 50)', async () => {
    const { branchLimit } = await import('../modules/partner/partner.service') as unknown as { branchLimit: (env: Record<string, string | undefined>) => number };
    expect(branchLimit({})).toBe(50);
    expect(branchLimit({ VENDOR_BRANCH_LIMIT: '80' })).toBe(80);
    expect(branchLimit({ VENDOR_BRANCH_LIMIT: '0' })).toBe(50);
    expect(branchLimit({ VENDOR_BRANCH_LIMIT: 'many' })).toBe(50);
    process.env['VENDOR_BRANCH_LIMIT'] = '2';
    const owner = await makeOwner();
    const ack = await ackFor(owner.userId);
    expect((await add(owner.token, { business: branchBody(), weeklyFeeAck: ack })).statusCode).toBe(201);
    const over = await add(owner.token, { business: branchBody(), weeklyFeeAck: ack });
    expect(over.statusCode, over.body).toBe(409);
    expect(over.json().error.code).toBe('BRANCH_LIMIT');
    expect(await storesOf(owner.ownerId)).toHaveLength(2);
  });

  it('two adds at once never pass the limit (counted under the owner\'s lock)', async () => {
    process.env['VENDOR_BRANCH_LIMIT'] = '2';
    const owner = await makeOwner();
    const ack = await ackFor(owner.userId);
    const results = await Promise.all([0, 1, 2].map(() => add(owner.token, { business: branchBody(), weeklyFeeAck: ack })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await storesOf(owner.ownerId)).toHaveLength(2);
    // The service itself, with nothing in front of it to space the calls out: still never past the limit.
    const racer = await makeOwner();
    const racerAck = await ackFor(racer.userId);
    const service = new PartnerService(app.prisma);
    const settled = await Promise.allSettled([0, 1, 2, 3, 4, 5].map(() => service.addBranch(
      racer.userId, { ...branchBody(), vendorType: 'RESTAURANT' } as Parameters<PartnerService['addBranch']>[1],
      { weeklyFeeAck: racerAck, surface: 'web' }, { VENDOR_BRANCH_LIMIT: '2' },
    )));
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await storesOf(racer.ownerId)).toHaveLength(2);
  });
});

describe('[CHAINS] GET /vendor/stores/branch-terms', () => {
  it('shows the fee for the branch type and that the running trial covers a branch until its end', async () => {
    const owner = await makeOwner();
    const subs = new SubscriptionService(app.prisma);
    const firstSub = await subs.startTrialForVendor(owner.firstId);
    expect(firstSub.status).toBe('TRIAL');
    const res = await terms(owner.token, '?vendorType=SUPERMARKET');
    expect(res.statusCode, res.body).toBe(200);
    const quote = await signupQuote(app.prisma, owner.userId, { role: 'VENDOR', vendorType: 'SUPERMARKET' });
    expect(res.json().data).toMatchObject({
      weeklyFee: { amount: quote.amount, currencyCode: quote.currencyCode, version: WEEKLY_FEE_ACK_VERSION },
      sharedTrialEndsAt: firstSub.trialEndDate!.toISOString(),
      stores: 1, limit: 50, dealWeeklyRate: null,
    });
  });

  it('after the trial, a branch pays from approval (no trial end to show)', async () => {
    const owner = await makeOwner();
    const firstSub = await new SubscriptionService(app.prisma).startTrialForVendor(owner.firstId);
    await app.prisma.subscription.update({ where: { id: firstSub.id }, data: { status: 'ACTIVE', isTrialActive: false, trialEndDate: new Date(Date.now() - DAY) } });
    const res = await terms(owner.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.sharedTrialEndsAt).toBeNull();
  });

  it('owner only', async () => {
    const owner = await makeOwner();
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: owner.firstId, userId: member.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const res = await terms(member.token);
    expect(res.statusCode).toBe(403);
  });
});
