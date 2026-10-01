import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { rateLimitKey } from '../utils/rate-limit-key';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import {
  MMG_CHECKOUT_NOTIFY_BODY_LIMIT,
  MMG_CHECKOUT_NOTIFY_RATE,
  MMG_CHECKOUT_RETURN_BODY_LIMIT,
  MMG_CHECKOUT_RETURN_RATE,
  MMG_CHECKOUT_RUNTIME_DECORATION,
  MMG_CHECKOUT_START_RATE,
  RETURN_STATES,
  mmgCheckoutPublicRoutes,
  type MmgCheckoutRuntime,
} from '../modules/billing/mmg-checkout.routes';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import type { MmgLookupClient, MmgLookupDetail } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// The MMG weekly-fee checkout ROUTES against the database (MMG-CHECKOUT-API.md
// sections 2-6): the partner routes of all three families, payActions in the
// subscription payload, and the public return/notify routes the web page
// forwards to. The service underneath is #1393's; these tests drive it only
// through HTTP. The sandbox runs the real request/reply cryptography under
// this file's own keys; the MMG lookup is scripted per transaction.
//
// Every route stays behind MMG_CHECKOUT_ENABLED (default off). A reply is a
// pointer, never evidence: nothing here credits without MMG's own lookup.
// Phones: +592647… (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RETURN_URL = '/api/v1/billing/mmg-checkout/return';
const NOTIFY_URL = '/api/v1/billing/mmg-checkout/notify';
let app: FastifyInstance;
let sandbox: SandboxMmgCheckoutProvider;
let checkoutProvider: () => MmgCheckoutProvider;
let kekBefore: string | undefined;
let enabledBefore: string | undefined;
let superAdminId: string;
const startedAt = new Date();

const lookups = new Map<string, MmgLookupDetail>();
const lookup: MmgLookupClient = { transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' } };
type Found = Extract<MmgLookupDetail, { outcome: 'found' }>;
function found(txn: string, status: Found['status'], amountGyd: number, patch: Partial<Found> = {}) {
  lookups.set(txn, {
    outcome: 'found', transactionId: txn, status, amountMinor: amountGyd * 100, currencyCode: 'GYD',
    // The fields #1393 added to MmgLookupDetail, named as "not sent" (null), exactly as they read before it.
    statusText: null, creditAccounts: null, ledgerReference: null,
    creditParties: [SANDBOX_MERCHANT_ID], createdAt: null, echoedReferences: [], raw: { transactionReference: txn }, ...patch,
  });
}
const approved = (txn: string, amountGyd: number, patch: Partial<Found> = {}) => found(txn, 'approved', amountGyd, patch);
const declined = (txn: string, amountGyd: number, patch: Partial<Found> = {}) => found(txn, 'declined', amountGyd, patch);
/** [F1] MMG's answer echoing THIS checkout's reference in its confirmed reference field. */
const echoOf = (row: { merchantTransactionId: string }): Partial<Found> => ({ echoedReferences: [row.merchantTransactionId] });

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_647_000_000 + Math.floor(Math.random() * 900_000);
const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const tx = (name: string) => `${name}${RUN}`;
const key = () => `tap-${nanoid(12)}`;
const enable = (on: boolean) => {
  if (on) process.env['MMG_CHECKOUT_ENABLED'] = '1';
  else delete process.env['MMG_CHECKOUT_ENABLED'];
};

type Actor = { userId: string; token: string };
async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Pay', lastName: `R${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `mmgpr3-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}
type SubOpts = { status?: SubscriptionStatus; balance?: number; due?: Date };
function period(opts: SubOpts) {
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  return { currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due };
}
async function makeStore(opts: SubOpts & { owner?: Actor } = {}) {
  const owner = opts.owner ?? (await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER'));
  const ownerRow = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: `Pay Store ${seq}`, slug: `pay-store-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
      addressLine1: '1 Pay Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: { vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100, ...period(opts), prepaidBalance: { create: { balance: opts.balance ?? 0 } } },
  });
  subIds.push(sub.id);
  return { ...owner, vendorId: vendor.id, subId: sub.id, family: 'vendor' as const };
}
async function makeRider(opts: SubOpts = {}) {
  const actor = await makeUser(['MOVER'], 'MOVER');
  const rider = await app.prisma.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
  const sub = await app.prisma.subscription.create({
    data: { riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: 6000, ...period(opts), prepaidBalance: { create: { balance: opts.balance ?? 0 } } },
  });
  subIds.push(sub.id);
  return { ...actor, subId: sub.id, family: 'rider' as const };
}
async function makeDriver(opts: SubOpts = {}) {
  const actor = await makeUser(['MOVER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: actor.userId, vehicleType: 'CAR', documentsVerified: true, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: `HB-${RUN}-${seq}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
    },
  });
  const sub = await app.prisma.subscription.create({
    data: { driverId: driver.id, type: 'TAXI_DRIVER', status: opts.status ?? 'ACTIVE', weeklyRate: 8000, ...period(opts), prepaidBalance: { create: { balance: opts.balance ?? 0 } } },
  });
  subIds.push(sub.id);
  return { ...actor, subId: sub.id, family: 'driver' as const };
}
type Partner = { token: string; userId: string; subId: string; family: 'vendor' | 'rider' | 'driver'; vendorId?: string };

const headersOf = (p: Partner, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${p.token}`, 'x-client-platform': 'ios', ...(p.vendorId ? { 'x-vendor-id': p.vendorId } : {}), ...extra,
});
const subscriptionOf = (p: Partner, extra: Record<string, string> = {}, target = app) =>
  target.inject({ method: 'GET', url: `/api/v1/${p.family}/subscription`, headers: headersOf(p, extra) });
const start = (p: Partner, extra: Record<string, string> = {}, target = app) =>
  target.inject({ method: 'POST', url: `/api/v1/${p.family}/subscription/mmg-checkout`, headers: { 'content-type': 'application/json', 'idempotency-key': key(), ...headersOf(p, extra) }, payload: {} });
const follow = (p: Partner, ref: string, target = app) =>
  target.inject({ method: 'GET', url: `/api/v1/${p.family}/subscription/mmg-checkout/${ref}`, headers: headersOf(p) });
const ret = (outcome: unknown, params: unknown, target = app) =>
  target.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: { outcome, params } });
const notify = (payload: string | Record<string, unknown>, contentType = 'application/json', target = app) =>
  target.inject({ method: 'POST', url: NOTIFY_URL, headers: { 'content-type': contentType }, payload });

const intentOf = (ref: string) => app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } });
async function started(p: Partner) {
  const res = await start(p);
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { ref: string; checkoutUrl: string; amountGyd: number };
  return { ...data, row: await intentOf(data.ref) };
}
/** A reply as MMG's official page documents it: our reference next to MMG's transaction id and the result code. */
const officialReply = (row: { merchantTransactionId: string }, code: string | number, txn?: string, extra: Record<string, unknown> = {}) =>
  sandbox.sandboxReplyToken({
    merchantTransactionId: row.merchantTransactionId, ...(txn ? { transactionId: txn } : {}), ResultCode: code,
    ResultMessage: 'per MMG', htmlResponse: '<p>per MMG</p>', ...extra,
  });
const walletOf = async (subscriptionId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } })).balance);
const creditsOf = (subscriptionId: string) => app.prisma.billingEvent.count({ where: { subscriptionId, type: 'PREPAID_TOPUP', idempotencyKey: { startsWith: 'mmg-checkout:' } } });
const identitiesOf = (txn: string) => app.prisma.providerPayment.count({ where: { provider: 'MMG', providerTxnId: txn.trim().toUpperCase() } });
const toldOf = (userId: string, status: string) => app.prisma.notification.findMany({
  where: { userId, AND: [{ data: { path: ['kind'], equals: 'billing_mmg_checkout' } }, { data: { path: ['status'], equals: status } }] },
});
const alertsOf = (alert: string) => app.prisma.notification.findMany({ where: { userId: superAdminId, data: { path: ['alert'], equals: alert } }, orderBy: { createdAt: 'asc' } });
const observationsOf = (intentId: string) => app.prisma.mmgCheckoutObservation.findMany({ where: { intentId }, orderBy: { createdAt: 'asc' } });

async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(rateLimit, { max: 1000, timeWindow: '1 minute', keyGenerator: rateLimitKey((token) => server.jwt.verify(token)) });
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  const notifications = new NotificationService(server.prisma, server.io);
  const billing = new BillingService(server.prisma, notifications, getPaymentProvider());
  const service = new MmgCheckoutService(server.prisma, billing, notifications, { checkout: () => checkoutProvider(), lookup: () => lookup });
  const runtime: MmgCheckoutRuntime = { service, checkout: () => checkoutProvider(), notifications };
  server.decorate(MMG_CHECKOUT_RUNTIME_DECORATION, runtime);
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.register(riderRoutes, { prefix: '/api/v1/rider' });
  await server.register(driverRoutes, { prefix: '/api/v1/driver' });
  await server.register(mmgCheckoutPublicRoutes, { prefix: '/api/v1/billing/mmg-checkout' });
  await server.ready();
  return server;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER'];
  enabledBefore = process.env['MMG_CHECKOUT_ENABLED'];
  enable(false);
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((res, rej) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? rej(err) : res({ publicKey, privateKey })));
  });
  sandbox = new SandboxMmgCheckoutProvider({ request: pair, result: pair });
  checkoutProvider = () => sandbox;
  app = await buildApp();
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
  seq += 1;
  const admin = await app.prisma.user.create({
    data: { phone: `+${phoneBase + 9000 + seq}`, firstName: 'Super', lastName: 'Admin', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true },
  });
  userIds.push(admin.id);
  superAdminId = admin.id;
}, 120_000);

beforeEach(() => {
  checkoutProvider = () => sandbox;
  resetFeeCheckoutSwitchCache();
});

afterAll(async () => {
  const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
  await app.prisma.mmgCheckoutObservation.deleteMany({ where: { OR: [{ intentId: { in: intents.map((i) => i.id) } }, { intentId: null, createdAt: { gte: startedAt } }] } });
  await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
  await app.prisma.platformConfig.deleteMany({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
  await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK'];
  else process.env['MASTER_KEK'] = kekBefore;
  if (enabledBefore === undefined) delete process.env['MMG_CHECKOUT_ENABLED'];
  else process.env['MMG_CHECKOUT_ENABLED'] = enabledBefore;
  resetKeyProviderForTests();
});

const OFF = [{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }];

describe('behind the flag: MMG_CHECKOUT_ENABLED unset (the default)', () => {
  beforeEach(() => enable(false));

  it('every family carries payActions, both off, and no checkouts', async () => {
    for (const p of [await makeStore(), await makeRider(), await makeDriver()]) {
      const res = await subscriptionOf(p);
      expect(res.statusCode, `${p.family}: ${res.body}`).toBe(200);
      expect(res.json().data).toMatchObject({ payActions: OFF, latestMmgCheckout: null, recentCheckouts: [] });
    }
  });

  it('starting a checkout is refused at the route even with a working provider underneath', async () => {
    const p = await makeStore();
    const res = await start(p);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAY_ACTION_OFF');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: p.subId } })).toBe(0);
  });

  it('the public routes are inert: a neutral answer, nothing written down', async () => {
    const before = await app.prisma.mmgCheckoutObservation.count();
    const r = await ret('success', { token: 'anything' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { state: 'UNKNOWN' } });
    const n = await notify({ token: 'anything' });
    expect(n.statusCode).toBe(200);
    expect(n.json()).toEqual({ success: true });
    expect(await app.prisma.mmgCheckoutObservation.count()).toBe(before);
  });
});

describe('live: payActions per the contract (section 3)', () => {
  beforeEach(() => enable(true));

  it('MMG_CHECKOUT is live with the amount due, or one week ahead when nothing is due; CARD stays off', async () => {
    const owing = await makeStore({ balance: 600 });
    expect((await subscriptionOf(owing)).json().data.payActions).toEqual([{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1500, currencyCode: 'GYD' }, { id: 'CARD', state: 'off' }]);
    const paidUp = await makeStore({ balance: 2100 });
    expect((await subscriptionOf(paidUp)).json().data.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 2100, currencyCode: 'GYD' });
    const rider = await makeRider({ balance: 1000 });
    expect((await subscriptionOf(rider)).json().data.payActions[0]).toMatchObject({ state: 'live', amountGyd: 5000 });
    const driver = await makeDriver();
    expect((await subscriptionOf(driver)).json().data.payActions[0]).toMatchObject({ state: 'live', amountGyd: 8000 });
  });

  it('a PAUSED subscription and a waived fee are off (hidden, never teased)', async () => {
    const paused = await makeStore({ status: 'PAUSED' });
    expect((await subscriptionOf(paused)).json().data.payActions).toEqual(OFF);
    const waived = await makeStore();
    await app.prisma.subscription.update({ where: { id: waived.subId }, data: { feeWaived: true } });
    expect((await subscriptionOf(waived)).json().data.payActions).toEqual(OFF);
    expect((await start(waived)).json().error.code).toBe('PAY_ACTION_OFF');
  });

  it('the per-platform switch: ios off hides it for ios and for an unknown platform, android still pays', async () => {
    const p = await makeStore();
    await app.prisma.platformConfig.upsert({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY }, create: { key: FEE_CHECKOUT_PLATFORMS_KEY, value: { ios: false } }, update: { value: { ios: false } } });
    resetFeeCheckoutSwitchCache();
    expect((await subscriptionOf(p, { 'x-client-platform': 'ios' })).json().data.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    expect((await subscriptionOf(p, { 'x-client-platform': '' })).json().data.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    expect((await subscriptionOf(p, { 'x-client-platform': 'android' })).json().data.payActions[0]).toMatchObject({ state: 'live' });
    expect((await start(p, { 'x-client-platform': 'ios' })).json().error.code).toBe('PAY_ACTION_OFF');
    await app.prisma.platformConfig.delete({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
    resetFeeCheckoutSwitchCache();
  });
});

describe('live: starting and following a checkout (sections 4-5)', () => {
  beforeEach(() => enable(true));

  it('POST prices it, answers 201 with the MMG page in the official URL format, and the payload carries it', async () => {
    const p = await makeStore({ balance: 600 });
    const res = await start(p);
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    expect(data).toMatchObject({ status: 'OPEN', amountGyd: 1500, currencyCode: 'GYD' });
    expect(Object.keys(data).sort()).toEqual(['amountGyd', 'checkoutUrl', 'currencyCode', 'expiresAt', 'ref', 'status']);
    // MMG's page: https://BASE_URL?token=TOKEN&merchantId=MERCHANTID&X-Client-ID=X-CLIENT-ID, in that order.
    expect(data.checkoutUrl).toMatch(/^https:\/\/[^?]+\?token=[A-Za-z0-9_-]+={0,2}&merchantId=\d+&X-Client-ID=[^&]+$/);
    const row = await intentOf(data.ref);
    expect(sandbox.sandboxReadRequest(data.checkoutUrl)).toMatchObject({ amount: '1500', merchantTransactionId: row.merchantTransactionId, merchantId: SANDBOX_MERCHANT_ID });
    expect(row.platform).toBe('ios');
    expect(row.createdByUserId).toBe(p.userId);

    const view = await follow(p, data.ref);
    expect(view.statusCode).toBe(200);
    expect(view.json().data).toMatchObject({ ref: data.ref, status: 'OPEN', amountGyd: 1500, currencyCode: 'GYD', confirmedAt: null, subscriptionStatus: 'ACTIVE' });
    expect(Object.keys(view.json().data).sort()).toEqual(['amountGyd', 'confirmedAt', 'createdAt', 'currencyCode', 'expiresAt', 'mmgTransactionId', 'ref', 'status', 'subscriptionStatus', 'swiftReference']);
    // [support lookup] The receipt references (section 5): ours always, MMG's only once CONFIRMED.
    expect(view.json().data).toMatchObject({ swiftReference: row.merchantTransactionId, mmgTransactionId: null });

    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toMatchObject({ ref: data.ref, status: 'OPEN', subscriptionStatus: 'ACTIVE' });
    expect(payload.recentCheckouts.map((c: { ref: string }) => c.ref)).toEqual([data.ref]);
    expect(JSON.stringify(payload)).not.toContain('checkoutUrl');
  });

  it('latestMmgCheckout is the newest checkout of the last 24 h; older ones stay in recentCheckouts only', async () => {
    const p = await makeStore();
    const { ref } = await started(p);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: ref }, data: { status: 'EXPIRED', createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toBeNull();
    expect(payload.recentCheckouts.map((c: { ref: string; status: string }) => [c.ref, c.status])).toEqual([[ref, 'EXPIRED']]);
  });

  it('the same Idempotency-Key gets the same checkout back (200); no key is 400', async () => {
    const p = await makeStore();
    const k = key();
    const first = await start(p, { 'idempotency-key': k });
    const again = await start(p, { 'idempotency-key': k });
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(again.json().data.ref).toBe(first.json().data.ref);
    const bare = await app.inject({ method: 'POST', url: '/api/v1/vendor/subscription/mmg-checkout', headers: { 'content-type': 'application/json', ...headersOf(p) }, payload: {} });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('the rider and driver families start and follow their own checkouts', async () => {
    for (const p of [await makeRider(), await makeDriver()]) {
      const { ref, row } = await started(p);
      expect(Number(row.amount)).toBe(p.family === 'rider' ? 6000 : 8000);
      expect((await follow(p, ref)).json().data).toMatchObject({ ref, status: 'OPEN' });
      expect((await subscriptionOf(p)).json().data.latestMmgCheckout.ref).toBe(ref);
    }
  });

  it('another partner gets 404 for a checkout that is not theirs, in every family', async () => {
    const store = await makeStore();
    const { ref } = await started(store);
    const otherStore = await makeStore();
    const rider = await makeRider();
    const driver = await makeDriver();
    for (const stranger of [otherStore, rider, driver]) {
      const res = await follow(stranger, ref);
      expect(res.statusCode, `${stranger.family}: ${res.body}`).toBe(404);
      expect(res.json().error.code).toBe('CHECKOUT_NOT_FOUND');
    }
    const { ref: riderRef } = await started(rider);
    expect((await follow(driver, riderRef)).statusCode).toBe(404);
    expect((await follow(store, riderRef)).statusCode).toBe(404);
    // A ref that never existed answers the same as someone else's.
    expect((await follow(store, 'cmq00000000000000000000000')).statusCode).toBe(404);
  });

  it('the authz matrix: no session 401, the wrong role 403 before any key check, a store manager 403 (OWNER only)', async () => {
    const store = await makeStore();
    const { ref } = await started(store);
    for (const url of [`/api/v1/vendor/subscription/mmg-checkout/${ref}`, '/api/v1/rider/subscription/mmg-checkout/x', '/api/v1/driver/subscription/mmg-checkout/x']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    for (const family of ['vendor', 'rider', 'driver']) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/${family}/subscription/mmg-checkout`, headers: { 'content-type': 'application/json' }, payload: {} })).statusCode, family).toBe(401);
    }
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (const family of ['vendor', 'rider', 'driver'] as const) {
      const outsider = { ...customer, subId: '', family };
      const post = await app.inject({ method: 'POST', url: `/api/v1/${family}/subscription/mmg-checkout`, headers: { 'content-type': 'application/json', ...headersOf(outsider) }, payload: {} });
      expect(post.statusCode, `${family} POST: ${post.body}`).toBe(403);
      expect((await follow(outsider, ref)).statusCode, `${family} GET`).toBe(403);
    }
    const manager = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    await app.prisma.vendorStaff.create({ data: { vendorId: store.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: store.userId } });
    const asManager = { ...manager, subId: store.subId, family: 'vendor' as const, vendorId: store.vendorId };
    expect((await start(asManager)).statusCode).toBe(403);
    expect((await follow(asManager, ref)).statusCode).toBe(403);
    // The public routes need no session at all.
    expect((await ret('success', {})).statusCode).toBe(200);
    expect((await notify({})).statusCode).toBe(200);
  });
});

describe('the public return: a reply is a pointer, never evidence (section 6)', () => {
  beforeEach(() => enable(true));

  it('forged replies (garbage, or under a stranger key) answer UNKNOWN, move nothing, credit nothing', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const strangerPair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((res, rej) => {
      generateKeyPair('rsa', { modulusLength: 2048 }, (err, publicKey, privateKey) => (err ? rej(err) : res({ publicKey, privateKey })));
    });
    const stranger = new SandboxMmgCheckoutProvider({ request: strangerPair, result: strangerPair });
    approved(tx('FORGED1'), 1500, echoOf(row));
    for (const params of [{ token: 'garbage' }, { token: stranger.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, transactionId: tx('FORGED1'), ResultCode: '0' }) }, {}, { a: ['x', 'y'] }]) {
      const res = await ret('success', params);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, data: { state: 'UNKNOWN' } });
    }
    expect((await intentOf(ref)).status).toBe('OPEN');
    expect(await creditsOf(p.subId)).toBe(0);
    expect(await walletOf(p.subId)).toBe(600);
  });

  it('failed (2), cancelled (6) and timed-out (7) replies never credit; MMG says "not paid" only through its own record', async () => {
    const p = await makeStore({ balance: 600 });
    // 2 · MMG names a transaction its lookup declines but does not tie to this checkout: confirming, never "not paid" [F5].
    const failed = await started(p);
    declined(tx('FAIL2'), 1500);
    let res = await ret('success', { token: officialReply(failed.row, '2', tx('FAIL2')) });
    expect(res.json().data.state).toBe('CONFIRMING');
    expect((await follow(p, failed.ref)).json().data.status).toBe('CONFIRMING');
    expect((await intentOf(failed.ref)).candidates).toEqual([tx('FAIL2')]);
    expect(await creditsOf(p.subId)).toBe(0);
    // A second checkout is refused while that one confirms: the partner cannot pay twice.
    const blocked = await start(p);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({ code: 'CHECKOUT_CONFIRMING', details: { ref: failed.ref } });
    await app.prisma.mmgCheckoutIntent.update({ where: { id: failed.ref }, data: { status: 'EXPIRED', nextCheckAt: null } });

    // 2 again, and this time MMG's lookup ties the decline to THIS checkout: NOT_PAID, and the partner may try again.
    const bound = await started(p);
    declined(tx('FAIL2B'), 1500, echoOf(bound.row));
    res = await ret('success', { token: officialReply(bound.row, 2, tx('FAIL2B')) });
    expect(res.json().data.state).toBe('NOT_PAID');
    expect((await follow(p, bound.ref)).json().data.status).toBe('NOT_PAID');
    expect((await toldOf(p.userId, 'NOT_PAID')).length).toBe(1);

    // 6 · cancelled on MMG's page: no transaction to look up; confirming, nothing credited.
    const cancelled = await started(p);
    res = await ret('success', { token: officialReply(cancelled.row, '6') });
    expect(res.json().data.state).toBe('CONFIRMING');
    expect((await intentOf(cancelled.ref)).candidates).toEqual([]);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: cancelled.ref }, data: { status: 'EXPIRED', nextCheckAt: null } });

    // 7 · timed out: not paid unless the lookup says paid — it does not.
    const timedOut = await started(p);
    res = await ret('success', { token: officialReply(timedOut.row, '7', tx('TIME7')) });
    expect(res.json().data.state).toBe('CONFIRMING');
    expect((await intentOf(timedOut.ref)).status).toBe('CONFIRMING');
    // …and the error path is the same reply family: never "not paid" on its own.
    expect((await ret('error', { token: officialReply(timedOut.row, '7', tx('TIME7')) })).json().data.state).toBe('CONFIRMING');

    expect(await creditsOf(p.subId)).toBe(0);
    expect(await walletOf(p.subId)).toBe(600);
    expect(await app.prisma.providerPayment.count({ where: { subscriptionId: p.subId } })).toBe(0);
  });

  it('codes 3, 4, 5 raise the ops/security alert, credit nothing, and leave the checkout untouched even when a lookup would confirm', async () => {
    const p = await makeStore({ balance: 600 });
    const before = (await alertsOf('mmg-checkout-reply-code')).length;
    for (const code of ['3', '4', 5]) {
      const { ref, row } = await started(p);
      const txn = tx(`ALERT${code}`);
      approved(txn, 1500, echoOf(row)); // would confirm through the lookup; it must never be asked
      const res = await ret('success', { token: officialReply(row, code, txn, { secretKey: 'must-not-be-stored' }) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, data: { state: 'UNKNOWN' } });
      const after = await intentOf(ref);
      expect(after.status).toBe('OPEN');
      expect(after.candidates).toEqual([]);
      expect(after.replyAt).toBeNull();
      // [I9] Written down first, under the checkout's own tenant: the reply for a person, secrets dropped.
      const seen = await observationsOf(ref);
      expect(seen.map((o) => [o.source, o.failure])).toEqual([['RETURN', `RESULT_CODE_${code}`]]);
      expect(seen[0]!.tenantId).toBe(row.tenantId);
      expect(JSON.stringify(seen[0]!.body)).toContain(txn);
      expect(JSON.stringify(seen[0]!.body)).not.toContain('must-not-be-stored');
      expect(seen[0]!.shape).toMatchObject({ merchantTransactionId: 'string', ResultCode: typeof code === 'number' ? 'integer' : 'string' });
      expect(await identitiesOf(txn)).toBe(0);
      // Let the next code start a fresh checkout.
      await app.prisma.mmgCheckoutIntent.update({ where: { id: ref }, data: { status: 'EXPIRED' } });
    }
    const alerts = (await alertsOf('mmg-checkout-reply-code')).slice(before);
    expect(alerts.map((a) => (a.data as Record<string, unknown>)['resultCode'])).toEqual(['3', '4', '5']);
    expect(alerts.every((a) => (a.data as Record<string, unknown>)['kind'] === 'billing_invariants')).toBe(true);
    expect(await creditsOf(p.subId)).toBe(0);
    expect(await walletOf(p.subId)).toBe(600);
    // A code-3 reply naming no checkout of ours is still an alert, filed with no tenant.
    const orphan = sandbox.sandboxReplyToken({ merchantTransactionId: '123456789012345678', transactionId: tx('ORPHAN3'), ResultCode: '3' });
    expect((await ret('error', { token: orphan })).json().data.state).toBe('UNKNOWN');
    expect((await alertsOf('mmg-checkout-reply-code')).length).toBe(before + 4);
  });

  it('success (0) + MMG lookup confirmed → CONFIRMED, exactly ONE credit through the provider identity, then repeats and a notify change nothing', async () => {
    const p = await makeStore({ balance: 600, status: 'PAST_DUE' });
    const { ref, row } = await started(p);
    const txn = tx('PAID0');
    approved(txn, 1500, echoOf(row));
    const token = officialReply(row, '0', txn);
    const res = await ret('success', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { state: 'CONFIRMED' } });
    const view = (await follow(p, ref)).json().data;
    expect(view).toMatchObject({ status: 'CONFIRMED', amountGyd: 1500 });
    expect(view.confirmedAt).toEqual(expect.any(String));
    expect(await identitiesOf(txn)).toBe(1);
    expect(await creditsOf(p.subId)).toBe(1);
    expect(await walletOf(p.subId)).toBe(600 + 1500 - 2100); // credited, then re-billed at once [I5]
    expect((await follow(p, ref)).json().data.subscriptionStatus).toBe('ACTIVE');
    expect((await toldOf(p.userId, 'CONFIRMED')).length).toBe(1);

    // The same reply again through the web page, then the notify route as a form and as JSON: still one credit.
    expect((await ret('success', { token: ['stale-duplicate', token] })).json().data.state).toBe('CONFIRMED');
    expect((await notify(`token=${encodeURIComponent(token)}&extra=1`, 'application/x-www-form-urlencoded')).json()).toEqual({ success: true });
    expect((await notify({ payload: token })).json()).toEqual({ success: true });
    expect(await identitiesOf(txn)).toBe(1);
    expect(await creditsOf(p.subId)).toBe(1);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: p.subId, status: 'CONFIRMED' } })).toBe(1);
    expect((await toldOf(p.userId, 'CONFIRMED')).length).toBe(1);

    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toMatchObject({ ref, status: 'CONFIRMED' });
    expect(payload.recentCheckouts[0]).toMatchObject({ ref, status: 'CONFIRMED' });
  });

  it('the notify route alone (MMG server-to-server) confirms a checkout the same way, answering nothing but 200', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = tx('NOTIFY0');
    approved(txn, 1500, echoOf(row));
    const res = await notify({ Token: officialReply(row, 0, txn), noise: 'ignored' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect((await follow(p, ref)).json().data.status).toBe('CONFIRMED');
    expect(await identitiesOf(txn)).toBe(1);
  });

  it('the HELD path: MMG confirms a payment it does not tie to this checkout → held for a person, shown honestly, nothing credited', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = tx('HELD1');
    approved(txn, 1500); // approved, right amount, our merchant — but MMG's record does not echo our reference (MMG_LOOKUP_REFERENCE_FIELDS=[])
    const res = await ret('success', { token: officialReply(row, '0', txn) });
    expect(res.json()).toEqual({ success: true, data: { state: 'CONFIRMING' } });
    expect((await follow(p, ref)).json().data.status).toBe('HELD');
    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toMatchObject({ ref, status: 'HELD' });
    expect(await creditsOf(p.subId)).toBe(0);
    expect(await identitiesOf(txn)).toBe(0);
    expect(await walletOf(p.subId)).toBe(600);
    expect((await toldOf(p.userId, 'HELD')).length).toBe(1);
    expect((await alertsOf('mmg-checkout-held')).some((a) => (a.data as Record<string, unknown>)['checkoutId'] === ref)).toBe(true);
    // Held is final for the partner: a new checkout may be started (a person resolves the held one).
    expect((await start(p)).statusCode).toBe(201);
  });

  it('the return answer carries only a state; malformed bodies are refused', async () => {
    const ok = await ret('success', { token: 'x' });
    expect(Object.keys(ok.json())).toEqual(['success', 'data']);
    expect(Object.keys(ok.json().data)).toEqual(['state']);
    for (const bad of [
      { outcome: 'success', params: 'token=x' },
      { outcome: 'success', params: ['x'] },
      { outcome: 'success', params: { token: 'x'.repeat(4097) } },
      { outcome: 'success', params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) },
      { outcome: 'success', params: { token: Array.from({ length: 17 }, () => 'v') } },
      { outcome: 'success', params: { token: 7 } },
      { outcome: 'x'.repeat(65), params: {} },
      { params: {} },
    ]) {
      const res = await app.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: bad });
      expect(res.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(res.json().success).toBe(false);
    }
  });
});

describe('the kill switch mid-flight', () => {
  it('turning the flag off hides an open checkout everywhere and makes its reply inert; turning it on brings it back', async () => {
    enable(true);
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = tx('KILL0');
    approved(txn, 1500, echoOf(row));
    const token = officialReply(row, '0', txn);
    enable(false);
    expect((await follow(p, ref)).statusCode).toBe(404);
    expect((await subscriptionOf(p)).json().data).toMatchObject({ payActions: OFF, latestMmgCheckout: null, recentCheckouts: [] });
    expect((await ret('success', { token })).json().data.state).toBe('UNKNOWN');
    expect((await notify({ token })).json()).toEqual({ success: true });
    expect((await intentOf(ref)).status).toBe('OPEN');
    expect(await identitiesOf(txn)).toBe(0);
    enable(true);
    expect((await follow(p, ref)).json().data.status).toBe('OPEN');
    expect((await ret('success', { token })).json().data.state).toBe('CONFIRMED');
    expect(await identitiesOf(txn)).toBe(1);
  });
});

describe('limits: rate and body caps on every door', () => {
  let limited: FastifyInstance;
  beforeAll(async () => {
    limited = await buildApp();
  });
  afterAll(async () => {
    await limited.close();
  });
  beforeEach(() => enable(false));

  it('the return route is rate-limited per source and body-capped', async () => {
    for (let i = 0; i < MMG_CHECKOUT_RETURN_RATE.max; i += 1) {
      expect((await ret('success', { token: 'x' }, limited)).statusCode).toBe(200);
    }
    const over = await ret('success', { token: 'x' }, limited);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } } });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    const big = await app.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ outcome: 'success', params: { token: 'x'.repeat(MMG_CHECKOUT_RETURN_BODY_LIMIT) } }) });
    expect(big.statusCode).toBe(413);
  });

  it('the notify route is rate-limited per source and capped at 16 KB', async () => {
    expect(MMG_CHECKOUT_NOTIFY_BODY_LIMIT).toBe(16 * 1024);
    for (let i = 0; i < MMG_CHECKOUT_NOTIFY_RATE.max; i += 1) {
      expect((await notify({ token: 'x' }, 'application/json', limited)).statusCode).toBe(200);
    }
    const over = await notify({ token: 'x' }, 'application/json', limited);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    const bigJson = await app.inject({ method: 'POST', url: NOTIFY_URL, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ token: 'x'.repeat(MMG_CHECKOUT_NOTIFY_BODY_LIMIT) }) });
    expect(bigJson.statusCode).toBe(413);
    const bigForm = await app.inject({ method: 'POST', url: NOTIFY_URL, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${'x'.repeat(MMG_CHECKOUT_NOTIFY_BODY_LIMIT)}` });
    expect(bigForm.statusCode).toBe(413);
  });

  it('starting a checkout is rate-limited per partner', async () => {
    const p = await makeStore();
    for (let i = 0; i < MMG_CHECKOUT_START_RATE.max; i += 1) {
      expect((await start(p, {}, limited)).statusCode).toBe(409); // the flag is off: refused, but each attempt counts
    }
    const over = await start(p, {}, limited);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED'); // the contract's code, not the plugin's default
  });
});

describe('the web return page contract', () => {
  it('the merged web route forwards to exactly this route, with this body, and renders exactly the states this route answers', () => {
    const src = readFileSync(resolve(process.cwd(), '../web/src/app/pay/mmg/[outcome]/route.ts'), 'utf8');
    expect(src).toContain(`}/api/v1/billing/mmg-checkout/return\``);
    expect(src).toContain('JSON.stringify({ outcome, params })');
    expect(src).toContain('body?.data?.state');
    const words = /const words = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
    const rendered = [...words.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
    expect(rendered.sort()).toEqual([...RETURN_STATES].sort());
    // The page forwards at most 16 values of at most 4096 characters: the API's own caps.
    expect(src).toContain('value.length > 4096');
    expect(src).toContain('entries.length >= 16');
  });
});
