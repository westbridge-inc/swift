/**
 * [RETIER PR-A · owner 30 Oct 2026 15:54Z "okay"] A NEW store's weekly fee is quoted from its REAL catalogue when the
 * fee is born (approval), and the store sees and agrees to that exact amount before anything is charged:
 *
 *  - a store whose own catalogue reaches a higher step when Swift approves it (1,000+ items: large; 10,000+:
 *    department) is born on THAT step's fee (and the department store on its 7-day trial), never the first step;
 *  - above the first step (what every sign-up was shown), its owner reads the fee and ticks "I understand the weekly
 *    fee" for that store at exactly that amount and currency first: the activation projection holds the store and
 *    tells the owner once per amount, the console refuses it, and the birth re-checks the tick under its own locks;
 *  - a tick to another amount (the catalogue moved since) is no tick; nothing is born at an amount nobody ticked;
 *  - a store at the first step, a Services business, and a chain branch whose deal keeps it at or under the first
 *    step are born exactly as before, with no tick (old phone builds keep working);
 *  - a chain deal stays min(deal, step); a store that already has its fee is never re-priced or asked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { VendorType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { vendorActivationNext } from '../modules/admin/vendor-activation';
import { feePausePredicate } from '../modules/billing/mmg-pause';
import { WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { publishLegalDocumentOnce, recordConsent } from '../modules/legal/consent.service';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { reviewerTyped } from './helpers/reviewer-typed';
import { wordFreeTag } from './helpers/fixture-ids';

/** The ledger path and the notice kind, pinned as literals (partner/store-fee.ts; the notification census reads them). */
const STORE_FEE_ACK_PATH = 'vendor/store-weekly-fee-ack';
const STORE_FEE_NOTICE_KIND = 'vendor_needs_weekly_fee_tick';
const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'storefront_photo'] as const;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'store-fee-test');

let app: FastifyInstance;
let service: VerificationService;
let subscriptions: SubscriptionService;
let adminId = '';
let small = 0;
let large = 0;
let dept = 0;
let services = 0;
let largeFloor = 0;
let deptFloor = 0;
const users: string[] = [];
let seq = 0;

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  subscriptions = new SubscriptionService(app.prisma);
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+5928${NUM}00`, firstName: 'Fee', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = admin.id; users.push(admin.id);
  const gy = await system(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } }));
  const tiers = gy.subscriptionTiers as Record<string, number>;
  small = tiers['smallVendor']!; large = tiers['largeVendor']!; dept = tiers['departmentVendor']!; services = tiers['serviceVendor']!;
  largeFloor = tiers['largeCatalogueThreshold']!; deptFloor = tiers['departmentCatalogueThreshold']!;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.documentRecord.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } })).map((v) => v.id);
    const subIds = (await app.prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((s) => s.id);
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.platformConfig.deleteMany({ where: { OR: subIds.map((id) => ({ key: { endsWith: id } })) } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
}, 300_000);

type Owner = { userId: string; vendorId: string; token: string };

/** A store owner with one store waiting for its first go-live. */
async function owner(opts: { vendorType?: VendorType; deal?: number; status?: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED'; firstLiveAt?: Date } = {}): Promise<Owner> {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5928${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Mala', lastName: `Shop${seq}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  const vendorOwner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: {
    userId: user.id,
    ...(opts.deal !== undefined ? { dealWeeklyRate: opts.deal, dealCurrencyCode: 'GYD', dealSetAt: new Date(), dealSetBy: 'store-fee-test', dealReason: 'store fee test' } : {}),
    vendors: { create: {
      name: `Big Mart ${seq}`, slug: `store-fee-${RUN.toLowerCase()}-${seq}`, vendorType: opts.vendorType ?? 'SUPERMARKET',
      phone: `+5928${NUM}9${seq}`, addressLine1: '1 Water Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.16, status: opts.status ?? 'PENDING_APPROVAL', isVerified: false, publicPhone: '+5926001234',
      ...(opts.firstLiveAt ? { firstLiveAt: opts.firstLiveAt } : {}),
    } },
  }, include: { vendors: true } }));
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `store-fee-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, vendorId: vendorOwner.vendors[0]!.id, token };
}

/** `n` listings on the store, in one statement. */
async function addItems(vendorId: string, n: number) {
  const category = await system(() => app.prisma.category.create({ data: { vendorId, name: `Aisle ${wordFreeTag(4)}`, sortOrder: 0 } }));
  await system(() => app.prisma.$executeRaw`
    INSERT INTO "items" ("id", "vendorId", "categoryId", "tenantId", "name", "basePrice", "isAvailable", "updatedAt", "createdAt")
    SELECT 'sf-' || ${category.id} || '-' || g, ${vendorId}, ${category.id}, 'swift-default', 'Item ' || g, 100, true, now(), now()
    FROM generate_series(1, ${n}) AS g`);
}

const call = (method: 'GET' | 'POST', url: string, o: Owner, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, 'x-vendor-id': o.vendorId, ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const feeView = async (o: Owner) => (await call('GET', '/api/v1/vendor/onboarding/weekly-fee', o)).json().data;
const tick = (o: Owner, amount: number, currencyCode = 'GYD', version = WEEKLY_FEE_ACK_VERSION, vendorId = o.vendorId) =>
  call('POST', '/api/v1/vendor/onboarding/weekly-fee', o, { vendorId, weeklyFeeAck: { version, amount, currencyCode } });
const store = (o: Owner) => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { status: true, isVerified: true } }));
const subOf = (o: Owner) => system(() => app.prisma.subscription.findUnique({ where: { vendorId: o.vendorId } }));
const notices = (o: Owner) => system(() => app.prisma.notification.findMany({ where: { userId: o.userId, data: { path: ['kind'], equals: STORE_FEE_NOTICE_KIND } }, orderBy: { createdAt: 'asc' } }));
const ticks = (o: Owner) => system(() => app.prisma.consentRecord.findMany({ where: { subjectId: o.userId, documentType: 'weekly_fee_acknowledgement', evidence: { path: ['path'], equals: STORE_FEE_ACK_PATH } } }));
const birth = (o: Owner) => system(() => subscriptions.startTrialForVendor(o.vendorId));

async function approveAll(o: Owner) {
  for (const docType of SUPERMARKET_DOCS) {
    const doc = await service.submitDocument(o.userId, 'SUPERMARKET', docType, await ownedVerificationFixture(app.prisma, o.userId, `store-fee-${docType}`), 'v1');
    await service.approveDocument(doc.id, adminId, new Date(Date.now() + 200 * DAY), undefined, { ...reviewerTyped(docType, doc.id) });
  }
}

describe('the seeded card the tests price from', () => {
  it('first step < large < department; the services rate is its own', () => {
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(dept).toBeGreaterThan(large);
    expect(deptFloor).toBeGreaterThan(largeFloor);
    expect(services).toBeGreaterThan(0);
  });
});

describe('[RETIER PR-A] a department-size store is born on the department fee, only after its owner ticks it', () => {
  it('documents approved: held, told once (amount, why); the console refuses; the tick at exactly that amount makes it live at that fee', async () => {
    const o = await owner();
    await addItems(o.vendorId, deptFloor);

    // what the store is shown before it ticks: the department fee, from its own 10,000 items
    const view = await feeView(o);
    expect(view).toMatchObject({
      vendorId: o.vendorId, set: false, required: true, ticked: false, items: deptFloor, cardRate: dept, dealRate: null,
      weeklyFee: { amount: dept, currencyCode: 'GYD', tier: 'department', version: WEEKLY_FEE_ACK_VERSION },
    });
    expect(view.terms.version).toBe(WEEKLY_FEE_ACK_VERSION);
    expect(view.why).toContain(deptFloor.toLocaleString('en-US'));

    await approveAll(o);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(await subOf(o)).toBeNull();
    const told = await notices(o);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe('Check your weekly fee to go live');
    expect(told[0]!.body).toContain(dept.toLocaleString('en-US'));
    expect(told[0]!.body).toContain('Nothing is charged before you do');
    // the belt runs again: still held, never told twice
    await service.reprojectVendorActivation(o.userId);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(await notices(o)).toHaveLength(1);

    // the console refuses, and the go-live verdict names the step
    const goLive = (await service.vendorGoLive(o.vendorId))!;
    expect(goLive.weeklyFee).toEqual({ required: true, ticked: false });
    expect(goLive.ready).toBe(false);
    expect(vendorActivationNext({ status: 'PENDING_APPROVAL', suspensionSource: null, ownerAccountStatus: 'ACTIVE', subscription: null, feePause: feePausePredicate(false) }, goLive)).toBe('NEEDS_WEEKLY_FEE_TICK');
    expect((await service.storeGoLiveViews([o.vendorId])).get(o.vendorId)).toEqual({ waitingFor: 'OWNER', steps: ['WEEKLY_FEE'] });
    // the birth itself refuses without the tick, and writes nothing
    await expect(birth(o)).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED' });
    expect(await subOf(o)).toBeNull();

    // the first step's amount (what sign-up showed), another currency, other words: refused, nothing written
    const wrong = await tick(o, small);
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json().error.code).toBe('WEEKLY_FEE_CHANGED');
    expect((await tick(o, dept, 'USD')).json().error.code).toBe('WEEKLY_FEE_CHANGED');
    expect((await tick(o, dept, 'GYD', 'v0')).json().error.code).toBe('WEEKLY_FEE_TERMS_CHANGED');
    expect(await ticks(o)).toHaveLength(0);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });

    const res = await tick(o, dept);
    expect(res.statusCode, res.body).toBe(201);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    const sub = (await subOf(o))!;
    expect(Number(sub.weeklyRate)).toBe(dept);
    expect(sub.customRate).toBeNull();
    expect(sub.status).toBe('TRIAL');
    // the department store's own 7-day trial ([DEPT-PRICE]); nothing charged before it ends
    expect(Math.round((sub.trialEndDate!.getTime() - sub.currentPeriodStart.getTime()) / DAY)).toBe(7);
    const [row] = await ticks(o);
    expect(row).toMatchObject({
      subjectType: 'vendor_user', documentVersion: WEEKLY_FEE_ACK_VERSION, action: 'granted',
      documentContentHash: createHash('sha256').update(WEEKLY_FEE_ACK_TEXT_V1, 'utf8').digest('hex'),
    });
    expect(row!.evidence).toMatchObject({ path: STORE_FEE_ACK_PATH, kind: 'STORE', vendorId: o.vendorId, weeklyFee: { amount: dept, currencyCode: 'GYD', tier: 'department', items: deptFloor } });

    // once born: nothing to tick, and a tick is refused (its changes follow the 14-day notice)
    expect(await feeView(o)).toMatchObject({ set: true, required: false, weeklyFee: null });
    expect((await tick(o, dept)).json().error.code).toBe('STORE_FEE_ALREADY_SET');
    expect(await ticks(o)).toHaveLength(1);
  });

  it('a large catalogue (1,000+) is born on the large fee on its tick; the same tick again writes nothing', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor);
    expect((await feeView(o)).weeklyFee).toMatchObject({ amount: large, tier: 'large' });
    await expect(birth(o)).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED' });
    expect((await tick(o, large)).statusCode).toBe(201);
    expect((await tick(o, large)).statusCode).toBe(200);
    expect(await ticks(o)).toHaveLength(1);
    const sub = await birth(o);
    expect(Number(sub.weeklyRate)).toBe(large);
    expect(Math.round((sub.trialEndDate!.getTime() - sub.currentPeriodStart.getTime()) / DAY)).toBe(14);
  });

  it('a tick to an amount the catalogue has since moved past is no tick: the birth refuses, and the owner is asked again at the new amount', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor);
    expect((await tick(o, large)).statusCode).toBe(201);
    await addItems(o.vendorId, deptFloor - largeFloor);
    await expect(birth(o)).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED', details: { amount: dept, currencyCode: 'GYD' } });
    expect(await subOf(o)).toBeNull();
    expect(await feeView(o)).toMatchObject({ required: true, ticked: false, weeklyFee: { amount: dept } });
    await approveAll(o);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    expect((await notices(o)).map((n) => (n.data as { weeklyFee?: number }).weeklyFee)).toEqual([dept]);
    expect((await tick(o, dept)).statusCode).toBe(201);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    expect(Number((await subOf(o))!.weeklyRate)).toBe(dept);
  });
});

describe('[REVIEW-M #2245] what the quote counts, and which tick counts', () => {
  it('S3-1 · COORD: listings removed in the last 7 days still count (deleting just before approval does not lower the fee), and the words say so', async () => {
    const o = await owner();
    await addItems(o.vendorId, deptFloor);
    await system(() => app.prisma.$executeRaw`
      UPDATE "items" SET "archivedAt" = now(), "isAvailable" = false, "updatedAt" = now()
      WHERE "id" IN (SELECT "id" FROM "items" WHERE "vendorId" = ${o.vendorId} ORDER BY "id" LIMIT 2000)`);
    const view = await feeView(o);
    expect(view).toMatchObject({ items: deptFloor, required: true, weeklyFee: { amount: dept, tier: 'department' } });
    expect(view.why).toBe(`It has ${deptFloor.toLocaleString('en-US')} items on sale, or taken off sale, changed or removed in the last 7 days, so it is on the department store rate of GY$${dept.toLocaleString('en-US')} a week.`);
  });

  it('S3-1 · COORD: listings removed more than 7 days ago are not the store\'s catalogue: 10,000 with 2,000 removed 8 days ago is priced and trialled for 8,000 (large)', async () => {
    const o = await owner();
    await addItems(o.vendorId, deptFloor);
    await system(() => app.prisma.$executeRaw`
      UPDATE "items" SET "archivedAt" = now() - interval '8 days', "isAvailable" = false, "updatedAt" = now() - interval '8 days'
      WHERE "id" IN (SELECT "id" FROM "items" WHERE "vendorId" = ${o.vendorId} ORDER BY "id" LIMIT 2000)`);
    const view = await feeView(o);
    expect(view).toMatchObject({ items: deptFloor - 2000, required: true, weeklyFee: { amount: large, tier: 'large' } });
    expect(view.why).toContain(`It has ${(deptFloor - 2000).toLocaleString('en-US')} items on sale`);
    expect((await tick(o, large)).statusCode).toBe(201);
    const sub = await birth(o);
    expect(Number(sub.weeklyRate)).toBe(large);
    expect(Math.round((sub.trialEndDate!.getTime() - sub.currentPeriodStart.getTime()) / DAY)).toBe(14);
  });

  it('S4-1 (REVIEW-M pair) · a listing removed more than 7 days ago stays out even when a later write touched it (photo clean-up updates archived rows): 10,000 with 2,000 removed 8 days ago but updated now is priced for 8,000 (large)', async () => {
    const o = await owner();
    await addItems(o.vendorId, deptFloor);
    await system(() => app.prisma.$executeRaw`
      UPDATE "items" SET "archivedAt" = now() - interval '8 days', "isAvailable" = false, "updatedAt" = now()
      WHERE "id" IN (SELECT "id" FROM "items" WHERE "vendorId" = ${o.vendorId} ORDER BY "id" LIMIT 2000)`);
    const view = await feeView(o);
    expect(view).toMatchObject({ items: deptFloor - 2000, required: true, weeklyFee: { amount: large, tier: 'large' } });
    expect(view.why).toContain(`It has ${(deptFloor - 2000).toLocaleString('en-US')} items on sale`);
  });

  it('S4-1 a tick to OTHER words (an older version) at the right amount is no tick: nothing is born', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor);
    await system(() => publishLegalDocumentOnce(app.prisma, { documentType: 'weekly_fee_acknowledgement', version: 'v0', renderedText: 'Older weekly fee words.' }));
    await system(() => app.prisma.$transaction((tx) => recordConsent(tx, {
      subjectType: 'vendor_user', subjectId: o.userId, documentType: 'weekly_fee_acknowledgement', version: 'v0', action: 'granted', surface: 'web', ip: null,
      evidence: { control: 'weekly_fee_checkbox', path: STORE_FEE_ACK_PATH, kind: 'STORE', vendorId: o.vendorId, weeklyFee: { amount: large, currencyCode: 'GYD', tier: 'large' } },
    })));
    expect(await feeView(o)).toMatchObject({ required: true, ticked: false });
    await expect(birth(o)).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED' });
    expect(await subOf(o)).toBeNull();
  });

  it('S4-2 a store that has been live, with no fee on record, whose documents lapsed and came back: re-verified on the first step as before, never asked or held', async () => {
    const o = await owner({ status: 'ACTIVE', firstLiveAt: new Date(Date.now() - 30 * DAY) });
    await addItems(o.vendorId, deptFloor);
    expect(await feeView(o)).toMatchObject({ required: false, ticked: false, weeklyFee: { amount: small, tier: 'small' } });
    await approveAll(o);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    const sub = (await subOf(o))!;
    expect(Number(sub.weeklyRate)).toBe(small);
    // its trial still follows its own catalogue, exactly as on main ([DEPT-PRICE]: department size -> 7 days)
    expect(Math.round((sub.trialEndDate!.getTime() - sub.currentPeriodStart.getTime()) / DAY)).toBe(7);
    expect(await notices(o)).toHaveLength(0);
    expect(await ticks(o)).toHaveLength(0);
  });
});

describe('[RETIER PR-A · COORD security review] never live is a durable fact, not a status', () => {
  it('a store suspended before it ever went live is still never-live: the console sees NEEDS_WEEKLY_FEE_TICK, a reinstate births nothing until the tick, then its catalogue step', async () => {
    const o = await owner({ status: 'SUSPENDED' });
    await addItems(o.vendorId, deptFloor);
    expect(await feeView(o)).toMatchObject({ required: true, ticked: false, weeklyFee: { amount: dept, tier: 'department' } });
    const goLive = { checklist: { complete: true, items: [] }, disclosure: { engaged: false, complete: null, missing: [] }, publishedPhone: true, foodHandlers: { required: false, attested: false },
      weeklyFee: (await service.vendorGoLive(o.vendorId))!.weeklyFee } as never;
    expect(vendorActivationNext({ status: 'SUSPENDED', suspensionSource: 'ADMIN', ownerAccountStatus: 'ACTIVE', subscription: null, feePause: feePausePredicate(false) }, goLive)).toBe('NEEDS_WEEKLY_FEE_TICK');
    await expect(birth(o)).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED' });
    expect((await tick(o, dept)).statusCode).toBe(201);
    expect(Number((await birth(o)).weeklyRate)).toBe(dept);
  });

  it('going live marks the store for good: once its documents lapse and come back without a fee, it is priced on the first step', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor - 1);
    await approveAll(o);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    const marked = await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { firstLiveAt: true } }));
    expect(marked.firstLiveAt).toBeInstanceOf(Date);
    // its fee row gone (a grandfathered store), documents lapsed, catalogue grown: never re-priced on it
    await system(() => app.prisma.subscription.deleteMany({ where: { vendorId: o.vendorId } }));
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { isVerified: false, activationValidUntil: null } }));
    await addItems(o.vendorId, deptFloor);
    expect(await feeView(o)).toMatchObject({ required: false, weeklyFee: { amount: small, tier: 'small' } });
  });
});

describe('[RETIER PR-A] born exactly as before, with no tick', () => {
  it('a store under 1,000 items: the first step, no tick asked, live on its documents', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor - 1);
    expect(await feeView(o)).toMatchObject({ required: false, ticked: false, weeklyFee: { amount: small, tier: 'small' }, items: largeFloor - 1 });
    await approveAll(o);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    expect(Number((await subOf(o))!.weeklyRate)).toBe(small);
    expect(await notices(o)).toHaveLength(0);
    expect(await ticks(o)).toHaveLength(0);
  });

  it('a Services business: the services rate whatever it lists, no tick', async () => {
    const o = await owner({ vendorType: 'SERVICE' });
    await addItems(o.vendorId, deptFloor);
    expect(await feeView(o)).toMatchObject({ required: false, items: null, weeklyFee: { amount: services, tier: 'service' } });
    const sub = await birth(o);
    expect(Number(sub.weeklyRate)).toBe(services);
  });
});

describe('[RETIER PR-A] a chain deal stays min(deal, step)', () => {
  it('a deal at or under the first step: born on the department step with the deal as its custom rate, charged the deal, no tick', async () => {
    const o = await owner({ deal: small - 3000 });
    await addItems(o.vendorId, deptFloor);
    expect(await feeView(o)).toMatchObject({ required: false, cardRate: dept, dealRate: small - 3000, weeklyFee: { amount: small - 3000 } });
    const sub = await birth(o);
    expect(Number(sub.weeklyRate)).toBe(dept);
    expect(Number(sub.customRate)).toBe(small - 3000);
  });

  it('a deal above the first step but under the step: the owner ticks the DEAL amount (what is charged), never the step', async () => {
    const deal = large + 5000;
    const o = await owner({ deal });
    await addItems(o.vendorId, deptFloor);
    expect(await feeView(o)).toMatchObject({ required: true, cardRate: dept, dealRate: deal, weeklyFee: { amount: deal, tier: 'department' } });
    expect((await tick(o, dept)).json().error.code).toBe('WEEKLY_FEE_CHANGED');
    expect((await tick(o, deal)).statusCode).toBe(201);
    const sub = await birth(o);
    expect(Number(sub.weeklyRate)).toBe(dept);
    expect(Number(sub.customRate)).toBe(deal);
  });
});

describe('[RETIER PR-A] existing fees never move', () => {
  it('a store that already has its fee keeps it whatever its catalogue: activation returns it unchanged', async () => {
    const o = await owner();
    const first = await birth(o);
    expect(Number(first.weeklyRate)).toBe(small);
    await addItems(o.vendorId, deptFloor);
    const again = await birth(o);
    expect(again.id).toBe(first.id);
    expect(Number(again.weeklyRate)).toBe(small);
    expect(await feeView(o)).toMatchObject({ set: true, required: false });
  });

  it('only the store’s owner ticks it: another account naming this store reaches only its own, and the store named in the tick must be the store it reaches', async () => {
    const o = await owner();
    const other = await owner();
    await addItems(o.vendorId, largeFloor);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/vendor/onboarding/weekly-fee', payload: { vendorId: o.vendorId, weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: large, currencyCode: 'GYD' } },
      headers: { authorization: `Bearer ${other.token}`, 'x-vendor-id': o.vendorId, 'content-type': 'application/json' },
    });
    // another account's x-vendor-id is not theirs: they reach only their OWN store, which is not the store named
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STORE_FEE_STORE_MISMATCH');
    // the owner naming another store than the one the request is for: refused too
    const crossed = await tick(o, large, 'GYD', WEEKLY_FEE_ACK_VERSION, other.vendorId);
    expect(crossed.statusCode, crossed.body).toBe(409);
    expect(crossed.json().error.code).toBe('STORE_FEE_STORE_MISMATCH');
    // a tick that names no store is refused before anything is read
    expect((await call('POST', '/api/v1/vendor/onboarding/weekly-fee', o, { weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: large, currencyCode: 'GYD' } })).statusCode).toBe(400);
    expect(await ticks(o)).toHaveLength(0);
    expect(await ticks(other)).toHaveLength(0);
  });

  it('a manager of the store neither sees nor ticks its fee (403, nothing written)', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor);
    seq += 1;
    const mgr = await system(() => app.prisma.user.create({ data: {
      phone: `+5928${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Ravi', lastName: `Manager${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    } }));
    users.push(mgr.id);
    await runWithTenant('swift-default', () => app.prisma.vendorStaff.create({ data: { vendorId: o.vendorId, userId: mgr.id, role: 'MANAGER', invitedBy: o.userId } }));
    const token = app.jwt.sign({ userId: mgr.id, role: 'CUSTOMER', jti: nanoid(8) });
    await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: mgr.id, token, refreshToken: nanoid(24), deviceId: `store-fee-m${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
    const m = { userId: mgr.id, vendorId: o.vendorId, token };
    const seen = await call('GET', '/api/v1/vendor/onboarding/weekly-fee', m);
    expect(seen.statusCode, seen.body).toBe(403);
    expect(seen.body).not.toContain(String(large));
    const res = await tick(m, large);
    expect(res.statusCode, res.body).toBe(403);
    expect(await ticks(o)).toHaveLength(0);
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: mgr.id, documentType: 'weekly_fee_acknowledgement' } }))).toBe(0);
  });

  it('a tick is per store: ticking one department-size store never lets the owner’s other one be born', async () => {
    const o = await owner();
    const ownerId = (await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { ownerId: true } }))).ownerId;
    const second = await runWithTenant('swift-default', () => app.prisma.vendor.create({ data: {
      ownerId, name: 'Second Mart', slug: `store-fee-${RUN.toLowerCase()}-2nd-${seq}`, vendorType: 'SUPERMARKET', phone: `+5928${NUM}8${seq}`,
      addressLine1: '2 Water Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL', publicPhone: '+5926001235',
    } }));
    await addItems(o.vendorId, largeFloor);
    await addItems(second.id, largeFloor);
    expect((await tick(o, large)).statusCode).toBe(201);
    expect(await feeView({ ...o, vendorId: second.id })).toMatchObject({ vendorId: second.id, required: true, ticked: false });
    await expect(system(() => subscriptions.startTrialForVendor(second.id))).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED' });
  });

  it('a tick to the same amount in another currency is no tick: the birth refuses', async () => {
    const o = await owner();
    await addItems(o.vendorId, largeFloor);
    await system(() => publishLegalDocumentOnce(app.prisma, { documentType: 'weekly_fee_acknowledgement', version: WEEKLY_FEE_ACK_VERSION, renderedText: WEEKLY_FEE_ACK_TEXT_V1 }));
    await system(() => app.prisma.$transaction((tx) => recordConsent(tx, {
      subjectType: 'vendor_user', subjectId: o.userId, documentType: 'weekly_fee_acknowledgement', version: WEEKLY_FEE_ACK_VERSION, action: 'granted', surface: 'web', ip: null,
      evidence: { control: 'weekly_fee_checkbox', path: STORE_FEE_ACK_PATH, kind: 'STORE', vendorId: o.vendorId, weeklyFee: { amount: large, currencyCode: 'USD', tier: 'large' } },
    })));
    await expect(birth(o)).rejects.toMatchObject({ code: 'STORE_FEE_TICK_REQUIRED' });
    expect(await feeView(o)).toMatchObject({ required: true, ticked: false });
  });
});
