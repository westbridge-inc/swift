import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { Prisma, PrismaClient, SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
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
import { readReopenableMmgCheckout } from '../modules/billing/mmg-checkout-reopen';
import { readDunningClock, resolveConfirmationInTx } from '../modules/billing/dunning-clock';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import {
  MMG_CHECKOUT_NOTIFY_BODY_LIMIT,
  MMG_CHECKOUT_NOTIFY_RATE,
  MMG_CHECKOUT_RETURN_BODY_LIMIT,
  MMG_CHECKOUT_RETURN_RATE,
  MMG_CHECKOUT_RUNTIME_DECORATION,
  MMG_CHECKOUT_START_RATE,
  RETURN_STATES,
  mmgCheckoutPublicRoutes,
  mmgCheckoutRuntimeOf,
  type MmgCheckoutRuntime,
} from '../modules/billing/mmg-checkout.routes';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, type MmgLookupClient, type MmgLookupDetail } from '../providers/mmg/mmg-provider';

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
// [owner, 1 Oct · #1393] A payment confirms automatically only on MMG's own
// success answer for the checkout plus its lookup's six conditions; the lookup
// is scripted as MMG's UAT answer, read through the live adapter. Every
// subscription is mapped onto #1393's shared billing confirmation clock, as the
// billing cutover maps every subscription in production.
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
let zoneBefore: string | undefined;
let superAdminId: string;
const startedAt = new Date();

const lookups = new Map<string, MmgLookupDetail>();
/** Every transaction MMG's lookup was asked about, in order. */
const lookedUp: string[] = [];
const lookup: MmgLookupClient = { transactionLookupDetail: async (id) => {
  lookedUp.push(id);
  return lookups.get(id) ?? { outcome: 'not_found' };
} };
type Found = Extract<MmgLookupDetail, { outcome: 'found' }>;
/** MMG stamps creationDate as Guyana wall-clock time written with a "Z" (UAT, 1 Oct). */
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
/** MMG's own ledger number for a payment: a different number from the reply's transactionId (UAT, 1 Oct). */
const ledgerOf = (txn: string) => `L${txn}`;
/** [owner, 1 Oct] MMG's lookup answer in the exact UAT shape (evidence/mmg-uat/ROUNDTRIP-PROOF-20261001.md),
 *  as #1393's suites build it: transactionStatus, a whole-dollar amount string, currency, creationDate (now:
 *  inside a fresh checkout's window), MMG's ledger number, the parties as [{ key: "accountid", value }] and
 *  metadata whose description is empty. */
const uatAnswer = (txn: string, amountGyd: number, answer: Record<string, unknown> = {}): Record<string, unknown> => ({
  transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
  subType: 'subscriber_mpay', transactionReference: ledgerOf(txn),
  creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
  descriptionText: null, ...answer,
});
/** MMG's lookup of `txn`, read exactly as the live adapter reads it. `answer` patches MMG's own fields; `patch` the reading. */
function found(txn: string, amountGyd: number, answer: Record<string, unknown> = {}, patch: Partial<Found> = {}) {
  lookups.set(txn, { ...lookupDetailFrom(uatAnswer(txn, amountGyd, answer), txn), ...patch });
}
const approved = (txn: string, amountGyd: number, patch: Partial<Found> = {}) => found(txn, amountGyd, {}, patch);
const declined = (txn: string, amountGyd: number, patch: Partial<Found> = {}) => found(txn, amountGyd, { transactionStatus: 'failed' }, patch);
/** [F1] MMG's answer echoing THIS checkout's reference. MMG's lookup carries no such field (UAT, 1 Oct): an echo
 *  only adds a contradiction check, it never confirms. */
const echoOf = (row: { merchantTransactionId: string }): Partial<Found> => ({ echoedReferences: [row.merchantTransactionId] });

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const tenantIds: string[] = [];
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
/** Fixtures are written in an explicit tenant scope: `tenantId`'s, or none (the schema's production tenant).
 *  Never the caller's ambient context, which a previous in-process request may have bound to its own tenant
 *  (Fastify's inject runs the auth hook in the caller's context, and the scoped client stamps creates). */
const inTenant = <T>(tenantId: string | undefined, fn: () => Promise<T>) => (tenantId ? runWithTenant(tenantId, fn) : runWithoutTenant(fn, 'mmgpr3-test-fixture'));
async function makeUser(roles: UserRole[], activeRole: UserRole, tenantId?: string): Promise<Actor> {
  seq += 1;
  const user = await inTenant(tenantId, () => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Pay', lastName: `R${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(tenantId ? { tenantId } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `mmgpr3-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}
/** `tenantId`: the partner's tenant (default: the production tenant). `mapped: false`: a subscription the
 *  shared billing confirmation clock has not mapped yet. */
type SubOpts = { status?: SubscriptionStatus; balance?: number; due?: Date; tenantId?: string; mapped?: boolean };
function period(opts: SubOpts) {
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  return { currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due };
}
/** [#1393] The billing cutover maps every subscription onto the shared confirmation clock, and the read-only
 *  pay decision fails closed without one (reading never maps it). Fixtures are mapped the same way, through
 *  #1393's own read path, unless a test asks for an unmapped subscription. */
async function mappedUnless<T extends { subId: string }>(partner: T, opts: SubOpts): Promise<T> {
  if (opts.mapped !== false) await inTenant(opts.tenantId, () => readDunningClock(app.prisma, partner.subId));
  return partner;
}
async function makeStore(opts: SubOpts & { owner?: Actor } = {}) {
  const owner = opts.owner ?? (await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER', opts.tenantId));
  const { vendorId, subId } = await inTenant(opts.tenantId, async () => {
    const ownerRow = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: ownerRow.id, name: `Pay Store ${seq}`, slug: `pay-store-${nanoid(6).toLowerCase()}`,
        vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
        addressLine1: '1 Pay Street', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      },
    });
    vendorIds.push(vendor.id);
    const sub = await app.prisma.subscription.create({
      data: { vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100, ...period(opts), prepaidBalance: { create: { balance: opts.balance ?? 0 } } },
    });
    subIds.push(sub.id);
    return { vendorId: vendor.id, subId: sub.id };
  });
  return mappedUnless({ ...owner, vendorId, subId, family: 'vendor' as const }, opts);
}
async function makeRider(opts: SubOpts = {}) {
  const actor = await makeUser(['MOVER'], 'MOVER', opts.tenantId);
  const subId = await inTenant(opts.tenantId, async () => {
    const rider = await app.prisma.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
    const sub = await app.prisma.subscription.create({
      data: { riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: 6000, ...period(opts), prepaidBalance: { create: { balance: opts.balance ?? 0 } } },
    });
    subIds.push(sub.id);
    return sub.id;
  });
  return mappedUnless({ ...actor, subId, family: 'rider' as const }, opts);
}
async function driverProfile(userId: string) {
  return app.prisma.driver.create({
    data: {
      userId, vehicleType: 'CAR', documentsVerified: true, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: `HB-${RUN}-${seq}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
    },
  });
}
async function makeDriver(opts: SubOpts = {}) {
  const actor = await makeUser(['MOVER'], 'MOVER', opts.tenantId);
  const subId = await inTenant(opts.tenantId, async () => {
    const driver = await driverProfile(actor.userId);
    const sub = await app.prisma.subscription.create({
      data: { driverId: driver.id, type: 'TAXI_DRIVER', status: opts.status ?? 'ACTIVE', weeklyRate: 8000, ...period(opts), prepaidBalance: { create: { balance: opts.balance ?? 0 } } },
    });
    subIds.push(sub.id);
    return sub.id;
  });
  return mappedUnless({ ...actor, subId, family: 'driver' as const }, opts);
}
/** A tenant of another kind. REVIEW is the store-review demo: its requests pass the review gate only while a
 *  review session is live, as review:provision creates one. */
async function makeTenant(kind: 'REVIEW' | 'CRAWLER') {
  const id = `mmgpr3-${kind.toLowerCase()}-${nanoid(6).toLowerCase()}`;
  await app.prisma.tenant.create({ data: { id, slug: id, name: `MMG checkout ${kind.toLowerCase()} fiction`, kind, isActive: true } });
  tenantIds.push(id);
  if (kind === 'REVIEW') await runWithTenant(id, () => app.prisma.reviewSession.create({ data: { tenantId: id, expiresAt: new Date(Date.now() + DAY) } }));
  return id;
}
/** A request (or read) in its own tenant context. Fastify's inject runs the auth hook in the caller's context,
 *  so without this a request's tenant would carry over to whatever the test creates next. */
const isolated = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'mmgpr3-test-isolation');
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
/** [MMG reopen] The Back button's own request: it names the ONE checkout it may hand back. */
const reopenTap = (p: Partner, ref: string, extra: Record<string, string> = {}, target = app) =>
  target.inject({ method: 'POST', url: `/api/v1/${p.family}/subscription/mmg-checkout/${ref}/reopen`, headers: { 'content-type': 'application/json', 'idempotency-key': key(), ...headersOf(p, extra) }, payload: {} });
/** [MMG reopen · F2] The reopen switch's platform-config key (written as text: a missing row is OFF). */
const REOPEN_SWITCH = 'billing.feeCheckout.reopen.platforms';
const reopenSwitch = async (value: unknown) => {
  if (value === null) await app.prisma.platformConfig.deleteMany({ where: { key: REOPEN_SWITCH } });
  else await app.prisma.platformConfig.upsert({ where: { key: REOPEN_SWITCH }, create: { key: REOPEN_SWITCH, value: value as never }, update: { value: value as never } });
  resetFeeCheckoutSwitchCache();
};
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
  // [#1393 DS632] How MMG's payment time is read, as staging and production
  // set it (deploy/.env.deploy.example). Unset, every payment would be held.
  zoneBefore = process.env['MMG_CHECKOUT_CREATION_ZONE'];
  process.env['MMG_CHECKOUT_CREATION_ZONE'] = 'GUYANA_WALL_CLOCK';
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
  // Unscoped, as system work: the fixtures span the production, review and crawler tenants.
  await isolated(async () => {
    // [#1393] The shared confirmation clock's evidence (holds, notices, transitions, clocks) names the checkouts: it goes first.
    await cleanupBillingClocks(app.prisma, subIds);
    const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
    await app.prisma.mmgCheckoutObservation.deleteMany({ where: { OR: [{ intentId: { in: intents.map((i) => i.id) } }, { intentId: null, createdAt: { gte: startedAt } }] } });
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
    await app.prisma.platformConfig.deleteMany({ where: { key: { in: [FEE_CHECKOUT_PLATFORMS_KEY, REOPEN_SWITCH] } } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    // [#1393] A mover's fee authority lives exactly as long as its payer and names the canonical subscription:
    // the mover payers go first (profiles, sessions, notices and the authority cascade), then the subscriptions.
    const payers = await app.prisma.moverFeeAuthority.findMany({ where: { userId: { in: userIds } }, select: { userId: true } });
    await app.prisma.user.deleteMany({ where: { id: { in: payers.map((a) => a.userId) } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK'];
  else process.env['MASTER_KEK'] = kekBefore;
  if (zoneBefore === undefined) delete process.env['MMG_CHECKOUT_CREATION_ZONE'];
  else process.env['MMG_CHECKOUT_CREATION_ZONE'] = zoneBefore;
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

  it('[owner, 1 Oct · option 2] the iOS app pays in-app too: with no switch row every platform is live, and the switch stays the server-side kill switch', async () => {
    const p = await makeStore();
    const switchTo = async (value: Record<string, unknown> | null) => {
      if (value === null) await app.prisma.platformConfig.deleteMany({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
      else await app.prisma.platformConfig.upsert({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY }, create: { key: FEE_CHECKOUT_PLATFORMS_KEY, value: value as never }, update: { value: value as never } });
      resetFeeCheckoutSwitchCache();
    };
    const mmgOn = async (platform: string) => (await subscriptionOf(p, { 'x-client-platform': platform })).json().data.payActions[0];
    // No row at all (the default): iOS, Android, the web and an unnamed platform all pay in the app.
    await switchTo(null);
    for (const platform of ['ios', 'android', 'web', '']) expect(await mmgOn(platform), platform || 'unknown').toMatchObject({ id: 'MMG_CHECKOUT', state: 'live' });
    // A row that does not name iOS leaves iOS on.
    await switchTo({ android: true, web: true });
    expect(await mmgOn('ios')).toMatchObject({ state: 'live' });
    // The kill switch: iOS off with no app build; Android still pays.
    await switchTo({ ios: false });
    expect(await mmgOn('ios')).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    expect((await start(p, { 'x-client-platform': 'ios' })).json().error.code).toBe('PAY_ACTION_OFF');
    expect(await mmgOn('android')).toMatchObject({ state: 'live' });
    await switchTo(null);
  });

  it('[#1393] never live while a weekly-fee payment is being confirmed, nor before the billing clock covers the subscription', async () => {
    const LIVE = { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 2100, currencyCode: 'GYD' };
    const MMG_OFF = { id: 'MMG_CHECKOUT', state: 'off' };
    const mmgOf = async (p: Partner) => (await subscriptionOf(p)).json().data.payActions[0];

    // No clock covers it yet: the read-only decision fails closed, and reading never maps one.
    const p = await makeStore({ mapped: false });
    expect(await mmgOf(p)).toEqual(MMG_OFF);
    expect(await app.prisma.billingDunningClock.count({ where: { subscriptionId: p.subId } })).toBe(0);
    await isolated(() => readDunningClock(app.prisma, p.subId));
    expect(await mmgOf(p)).toEqual(LIVE);

    // Its own checkout is open (the partner may be paying on MMG's page right now): no second Pay
    // button. The open checkout is resumed from latestMmgCheckout.
    const open = await started(p);
    expect(await mmgOf(p)).toEqual(MMG_OFF);
    expect((await subscriptionOf(p)).json().data.latestMmgCheckout).toMatchObject({ ref: open.ref, status: 'OPEN' });
    // MMG's own "cancelled" answer for it releases the pause: live again.
    expect((await ret('error', { token: officialReply(open.row, '6') })).json().data.state).toBe('NOT_PAID');
    expect(await mmgOf(p)).toEqual(LIVE);

    // Confirming: MMG sent the partner back naming a transaction its lookup does not know yet.
    const confirming = await started(p);
    expect((await ret('success', { token: officialReply(confirming.row, '7', tx('SLOW7')) })).json().data.state).toBe('CONFIRMING');
    expect(await mmgOf(p)).toEqual(MMG_OFF);

    // Another weekly-fee payment, on another rail, is unclear: off, and a new page is refused.
    const q = await makeStore();
    expect(await mmgOf(q)).toEqual(LIVE);
    const due = (await app.prisma.subscription.findUniqueOrThrow({ where: { id: q.subId } })).nextBillingDate;
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId: q.subId, amount: 2100, paymentMethod: 'CARD',
      status: 'UNKNOWN', periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), failureRaw: { providerEffect: 'AUTHORIZED' } } });
    expect(await mmgOf(q)).toEqual(MMG_OFF);
    // Reading changed nothing: no hold was taken by the payload.
    expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: q.subId } })).toBe(0);
    const refused = await start(q);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('PAYMENT_CONFIRMING');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: q.subId } })).toBe(0);
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

  it.each(['driver', 'rider'] as const)('[#1393 mover fee authority] a dual-role mover whose one fee sits on the %s profile pays it from the other family: the subscription GET /subscription shows', async (holder) => {
    // A mover with a rider profile and a driver profile; one weekly fee, on the `holder` profile.
    const actor = await makeUser(['MOVER'], 'MOVER');
    const { sub, fee } = await isolated(async () => {
      const rider = await app.prisma.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
      const driver = await driverProfile(actor.userId);
      const fee = holder === 'driver' ? { driverId: driver.id, type: 'TAXI_DRIVER' as const, weeklyRate: 8000 } : { riderId: rider.id, type: 'DELIVERY_RIDER' as const, weeklyRate: 6000 };
      const sub = await app.prisma.subscription.create({ data: { ...fee, status: 'ACTIVE', ...period({}), prepaidBalance: { create: { balance: 0 } } } });
      subIds.push(sub.id);
      await readDunningClock(app.prisma, sub.id);
      return { sub, fee };
    });
    const asRider = { ...actor, subId: sub.id, family: 'rider' as const };
    const asDriver = { ...actor, subId: sub.id, family: 'driver' as const };
    for (const p of [asRider, asDriver]) {
      expect((await subscriptionOf(p)).json().data, p.family).toMatchObject({ id: sub.id, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: fee.weeklyRate }, { id: 'CARD', state: 'off' }] });
    }
    // The OTHER family's Pay button pays exactly that fee.
    const payer = holder === 'driver' ? asRider : asDriver;
    const res = await start(payer);
    expect(res.statusCode, res.body).toBe(201);
    const row = await intentOf(res.json().data.ref);
    expect(row.subscriptionId).toBe(sub.id);
    expect(Number(row.amount)).toBe(fee.weeklyRate);
    // Either family follows it, and both payloads carry it.
    for (const p of [asRider, asDriver]) {
      expect((await follow(p, row.id)).json().data, p.family).toMatchObject({ ref: row.id, status: 'OPEN' });
      expect((await subscriptionOf(p)).json().data.latestMmgCheckout, p.family).toMatchObject({ ref: row.id, status: 'OPEN' });
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

  it('[owner, 1 Oct] failed (2), cancelled (6) and timed-out (7) replies never credit; MMG\'s own not-paid answer for the checkout says "not paid" at once', async () => {
    const p = await makeStore({ balance: 600 });
    // 2 · MMG's own failed answer for THIS checkout, naming a transaction: NOT_PAID at once, the
    // confirmation pause released, the partner told once. The transaction is still looked at later [I8].
    const failed = await started(p);
    declined(tx('FAIL2'), 1500);
    let res = await ret('success', { token: officialReply(failed.row, '2', tx('FAIL2')) });
    expect(res.json().data.state).toBe('NOT_PAID');
    expect((await follow(p, failed.ref)).json().data.status).toBe('NOT_PAID');
    expect((await intentOf(failed.ref)).candidates).toEqual([tx('FAIL2')]);
    expect((await toldOf(p.userId, 'NOT_PAID')).length).toBe(1);
    expect(await creditsOf(p.subId)).toBe(0);

    // The partner may try again at once (no manual expiry). MMG's ResultCode is a string ("2"): a JSON
    // number is not MMG's documented reply, so it decides nothing; the documented one says not paid.
    const bound = await started(p);
    declined(tx('FAIL2B'), 1500, echoOf(bound.row));
    res = await ret('success', { token: officialReply(bound.row, 2, tx('FAIL2B')) });
    expect(res.json().data.state).toBe('UNKNOWN');
    expect((await intentOf(bound.ref)).status).toBe('OPEN');
    res = await ret('success', { token: officialReply(bound.row, '2', tx('FAIL2B')) });
    expect(res.json().data.state).toBe('NOT_PAID');
    expect((await follow(p, bound.ref)).json().data.status).toBe('NOT_PAID');
    expect((await toldOf(p.userId, 'NOT_PAID')).length).toBe(2);

    // 6 · cancelled on MMG's page: no transaction to look up; NOT_PAID at once, nothing credited.
    const cancelled = await started(p);
    res = await ret('success', { token: officialReply(cancelled.row, '6') });
    expect(res.json().data.state).toBe('NOT_PAID');
    expect((await intentOf(cancelled.ref)).candidates).toEqual([]);

    // 7 · timed out naming no transaction: nothing can have been paid; NOT_PAID at once.
    const timedOutEmpty = await started(p);
    res = await ret('error', { token: officialReply(timedOutEmpty.row, '7') });
    expect(res.json().data.state).toBe('NOT_PAID');
    expect((await toldOf(p.userId, 'NOT_PAID')).length).toBe(4);

    // 7 · timed out naming a transaction: not paid unless the lookup says paid — MMG does not know it
    // yet, so the checkout keeps confirming: never "not paid" on a timeout alone.
    const timedOut = await started(p);
    res = await ret('success', { token: officialReply(timedOut.row, '7', tx('TIME7')) });
    expect(res.json().data.state).toBe('CONFIRMING');
    expect((await intentOf(timedOut.ref)).status).toBe('CONFIRMING');
    // …and the error path is the same reply family: never "not paid" on its own.
    expect((await ret('error', { token: officialReply(timedOut.row, '7', tx('TIME7')) })).json().data.state).toBe('CONFIRMING');
    // A second checkout is refused while that one confirms: the partner cannot pay twice.
    const blocked = await start(p);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({ code: 'CHECKOUT_CONFIRMING', details: { ref: timedOut.ref } });

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
      // Let the next code start a fresh checkout. An expired checkout MMG never answered keeps the
      // payment pause [#1393], so MMG's own "cancelled" answer for this one releases it instead.
      expect((await ret('error', { token: officialReply(row, '6') })).json().data.state).toBe('NOT_PAID');
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
    expect(await identitiesOf(ledgerOf(txn))).toBe(1); // [owner, 1 Oct · 6] MMG's ledger number is claimed with it
    expect(await creditsOf(p.subId)).toBe(1);
    expect(await walletOf(p.subId)).toBe(600 + 1500 - 2100); // credited, then re-billed at once [I5]
    expect((await follow(p, ref)).json().data.subscriptionStatus).toBe('ACTIVE');
    expect((await toldOf(p.userId, 'CONFIRMED')).length).toBe(1);

    // The same reply again through the web page, then the notify route as a form and as JSON: still one credit.
    // [DS635] The token must arrive once, as one string: the same reply named twice is refused as UNKNOWN.
    expect((await ret('success', { token })).json().data.state).toBe('CONFIRMED');
    expect((await ret('success', { token: ['stale-duplicate', token] })).json().data.state).toBe('UNKNOWN');
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
    // A JSON-number code is not MMG's documented reply: it decides nothing.
    expect((await notify({ Token: officialReply(row, 0, txn), noise: 'ignored' })).json()).toEqual({ success: true });
    expect((await follow(p, ref)).json().data.status).toBe('OPEN');
    // MMG's reply as its page documents it and UAT returned it: ResultCode "0", a string.
    const res = await notify({ Token: officialReply(row, '0', txn), noise: 'ignored' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect((await follow(p, ref)).json().data.status).toBe('CONFIRMED');
    expect(await identitiesOf(txn)).toBe(1);
  });

  it('the HELD path: MMG shows a payment its success answer never named for this checkout → held for a person, shown honestly, nothing credited, no second page', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = tx('HELD1');
    approved(txn, 1500); // MMG's lookup: paid in full, to our merchant, inside the checkout's window …
    // … but MMG answered "timed out" (7) for this checkout, not success (0): only MMG's success answer ties
    // a payment to a checkout automatically [owner, 1 Oct]. A person decides.
    const res = await ret('success', { token: officialReply(row, '7', txn) });
    expect(res.json()).toEqual({ success: true, data: { state: 'CONFIRMING' } });
    expect((await follow(p, ref)).json().data.status).toBe('HELD');
    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toMatchObject({ ref, status: 'HELD' });
    expect(payload.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    expect(await creditsOf(p.subId)).toBe(0);
    expect(await identitiesOf(txn)).toBe(0);
    expect(await walletOf(p.subId)).toBe(600);
    expect((await toldOf(p.userId, 'HELD')).length).toBe(1);
    expect((await alertsOf('mmg-checkout-held')).some((a) => (a.data as Record<string, unknown>)['checkoutId'] === ref)).toBe(true);
    // A held payment keeps the payment pause until a person resolves it [#1393]: no second MMG page.
    const again = await start(p);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('PAYMENT_CONFIRMING');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: p.subId } })).toBe(1);
  });

  it('[#1393] refused-request codes page operators once per checkout and code, whatever the checkout\'s state; the checkout never changes', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const before = (await alertsOf('mmg-checkout-reply-code')).length;
    // The same code-3 reply twice (a repeat or a replay): written down twice, paged once.
    const three = officialReply(row, '3', tx('DUP3'));
    for (const n of [1, 2]) expect((await ret('error', { token: three })).json().data.state, `reply ${n}`).toBe('UNKNOWN');
    expect((await observationsOf(ref)).map((o) => o.failure)).toEqual(['RESULT_CODE_3', 'RESULT_CODE_3']);
    expect((await alertsOf('mmg-checkout-reply-code')).length).toBe(before + 1);
    // Another code for the same checkout is another page.
    expect((await ret('error', { token: officialReply(row, '4') })).json().data.state).toBe('UNKNOWN');
    expect((await alertsOf('mmg-checkout-reply-code')).length).toBe(before + 2);
    expect((await intentOf(ref)).status).toBe('OPEN');
    // Paid, through MMG's success answer; a refused-request code afterwards still pages, once, and moves nothing.
    const txn = tx('DUPPAID0');
    approved(txn, 1500);
    expect((await ret('success', { token: officialReply(row, '0', txn) })).json().data.state).toBe('CONFIRMED');
    for (const n of [1, 2]) expect((await notify({ token: officialReply(row, '5', txn) })).json(), `notify ${n}`).toEqual({ success: true });
    expect((await alertsOf('mmg-checkout-reply-code')).length).toBe(before + 3);
    expect((await intentOf(ref)).status).toBe('CONFIRMED');
    expect(await creditsOf(p.subId)).toBe(1);
  });

  it('[#1393] MMG said "not paid", then its lookup shows the payment made: the checkout turns HELD, and every partner view shows it', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = tx('LATE2');
    // MMG's own failed answer naming a transaction: NOT_PAID at once, the pause released.
    expect((await ret('error', { token: officialReply(row, '2', txn) })).json().data.state).toBe('NOT_PAID');
    expect((await subscriptionOf(p)).json().data.payActions[0]).toMatchObject({ state: 'live' });
    // Hours later, MMG's lookup shows that transaction paid in full: a person must decide.
    approved(txn, 1500);
    await mmgCheckoutRuntimeOf(app).service.pollIntents(new Date(Date.now() + 7 * 3_600_000));
    expect((await follow(p, ref)).json().data.status).toBe('HELD');
    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toMatchObject({ ref, status: 'HELD' });
    expect(payload.recentCheckouts[0]).toMatchObject({ ref, status: 'HELD' });
    expect(payload.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' }); // the pause is taken again
    expect((await toldOf(p.userId, 'HELD')).length).toBe(1);
    expect(await creditsOf(p.subId)).toBe(0);
    expect(await identitiesOf(txn)).toBe(0);
  });

  it('[DS635] a reply token named more than once is ambiguous: UNKNOWN, nothing opened, looked up or written', async () => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = tx('TWICE0');
    approved(txn, 1500);
    const token = officialReply(row, '0', txn);
    const observed = await app.prisma.mmgCheckoutObservation.count();
    const asked = lookedUp.length;
    // A repeated query or form field arrives as an array; two spellings of the field are two tokens.
    for (const params of [{ token: [token, token] }, { token: ['stale-duplicate', token] }, { token: [token] }, { token, Token: token }]) {
      const res = await ret('success', params);
      expect(res.statusCode).toBe(200);
      expect(res.json(), JSON.stringify(params).slice(0, 40)).toEqual({ success: true, data: { state: 'UNKNOWN' } });
    }
    // MMG's notify door holds to the same rule: a repeated form field, or a JSON array.
    const encoded = encodeURIComponent(token);
    expect((await notify(`token=${encoded}&token=${encoded}`, 'application/x-www-form-urlencoded')).json()).toEqual({ success: true });
    expect((await notify({ token: [token] })).json()).toEqual({ success: true });
    expect(await app.prisma.mmgCheckoutObservation.count()).toBe(observed);
    expect(lookedUp.length).toBe(asked);
    expect(await intentOf(ref)).toMatchObject({ status: 'OPEN', candidates: [], replyAt: null });
    expect(await identitiesOf(txn)).toBe(0);
    // One string is the accepted form.
    expect((await ret('success', { token })).json().data.state).toBe('CONFIRMED');
    expect(await creditsOf(p.subId)).toBe(1);
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

describe('[store review] a demo partner never opens a real MMG page', () => {
  beforeEach(() => enable(true));

  it('REVIEW-tenant partners in every family: MMG_CHECKOUT off, and starting one is 409 PAY_ACTION_OFF with nothing written', async () => {
    // The same fixture in the production tenant is live: only the tenant differs.
    expect((await isolated(async () => subscriptionOf(await makeStore()))).json().data.payActions[0]).toMatchObject({ state: 'live' });
    const review = await makeTenant('REVIEW');
    const crawler = await makeTenant('CRAWLER');
    // Created inside their own tenant, as the store-review provisioning creates them.
    const demo = [
      { kind: 'REVIEW', p: await makeStore({ tenantId: review }) },
      { kind: 'REVIEW', p: await makeRider({ tenantId: review }) },
      { kind: 'REVIEW', p: await makeDriver({ tenantId: review }) },
      { kind: 'CRAWLER', p: await makeStore({ tenantId: crawler }) },
    ];
    for (const { kind, p } of demo) {
      const label = `${p.family} in ${kind}`;
      // The partner really is in that tenant, and the billing clock covers the subscription.
      const tenant = await isolated(() => app.prisma.user.findUniqueOrThrow({ where: { id: p.userId }, select: { tenant: { select: { kind: true } } } }));
      expect(tenant.tenant.kind, label).toBe(kind);
      expect(await isolated(() => app.prisma.billingDunningClock.count({ where: { subscriptionId: p.subId } })), label).toBe(1);
      const sub = await isolated(() => subscriptionOf(p));
      expect(sub.statusCode, `${label}: ${sub.body}`).toBe(200);
      expect(sub.json().data.payActions, label).toEqual(OFF);
      // Whatever the platform: the refusal is the tenant's, not the platform switch's.
      expect((await isolated(() => subscriptionOf(p, { 'x-client-platform': 'android' }))).json().data.payActions, `${label} on android`).toEqual(OFF);
      const res = await isolated(() => start(p));
      expect(res.statusCode, `${label}: ${res.body}`).toBe(409);
      expect(res.json().error.code, label).toBe('PAY_ACTION_OFF');
      expect(await isolated(() => app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: p.subId } })), label).toBe(0);
      expect(await isolated(() => app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId } })), label).toBe(0);
    }
  });
});

describe('[MMG-RETURN-PATH] the reply MMG puts in the address path', () => {
  beforeEach(() => enable(true));

  it('the web page forwards it as params.token with only the outcome word; it reaches observeReply and confirms automatically', async () => {
    const digits = () => String(20_000_000_000_000 + Math.floor(Math.random() * 9_000_000_000_000));
    // `response`: the web page's word for /pay/mmg/token=<reply>, with no outcome in the path.
    for (const outcome of ['success', 'response']) {
      const p = await makeStore({ balance: 600 });
      const { ref, row } = await started(p);
      // MMG's reply exactly as UAT decrypted it (evidence/mmg-uat/ROUNDTRIP-PROOF-20261001.md): string fields,
      // a 14-digit transaction id, ResultCode "0", MMG's message and HTML; one RSA-4096 block as padded base64url.
      const txn = digits();
      const ledger = digits();
      const token = sandbox.sandboxReplyToken({
        merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0',
        ResultMessage: 'Transaction Successful', htmlResponse: '<html><body><h1>Transaction Successful</h1></body></html>',
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]+={0,2}$/); // what the web page accepts from the path
      expect(token).toHaveLength(684);
      found(txn, 1500, { transactionReference: ledger });
      const res = await app.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: { outcome, params: { token } } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ success: true, data: { state: 'CONFIRMED' } });
      // It reached observeReply: written down as MMG's success answer for this checkout, then MMG's lookup decided.
      expect((await observationsOf(ref)).map((o) => [o.source, o.detail])).toEqual([['RETURN', 'MMG_RESULT_0'], ['LOOKUP', txn]]);
      expect(await intentOf(ref)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
      expect(await creditsOf(p.subId)).toBe(1);
      expect(await identitiesOf(txn)).toBe(1);
      expect(await identitiesOf(ledger)).toBe(1);
      expect((await follow(p, ref)).json().data.status).toBe('CONFIRMED');
    }
  });
});

describe('[MMG, 4 Oct] Notify: MMG\'s server sends the same tokenized reply as the redirect', () => {
  beforeEach(() => enable(true));

  it.each(['a form, the token as sent', 'a form, the token percent-encoded', 'JSON'] as const)('%s: Notify alone confirms through the same reply path as /return, and either door after it changes nothing', async (shape) => {
    const p = await makeStore({ balance: 600 });
    const { ref, row } = await started(p);
    const txn = String(20_000_000_000_000 + Math.floor(Math.random() * 9_000_000_000_000));
    const token = sandbox.sandboxReplyToken({
      merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0',
      ResultMessage: 'Transaction Successful', htmlResponse: '<html><body><h1>Transaction Successful</h1></body></html>',
    });
    expect(token).toMatch(/=$/); // padded base64url, as MMG sends it
    found(txn, 1500);
    const res = shape === 'JSON'
      ? await notify({ token })
      : await notify(`token=${shape === 'a form, the token as sent' ? token : encodeURIComponent(token)}`, 'application/x-www-form-urlencoded');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    // The same path as /return: written down as MMG's success answer, MMG's lookup decided, one credit.
    expect((await observationsOf(ref)).map((o) => [o.source, o.detail])).toEqual([['NOTIFY', 'MMG_RESULT_0'], ['LOOKUP', txn]]);
    expect((await follow(p, ref)).json().data.status).toBe('CONFIRMED');
    expect(await creditsOf(p.subId)).toBe(1);
    expect(await identitiesOf(txn)).toBe(1);
    expect(await identitiesOf(ledgerOf(txn))).toBe(1);
    // The partner's browser arrives afterwards with the same reply: CONFIRMED, nothing more.
    expect((await ret('success', { token })).json().data.state).toBe('CONFIRMED');
    expect((await notify({ token })).json()).toEqual({ success: true });
    expect(await creditsOf(p.subId)).toBe(1);
    expect((await toldOf(p.userId, 'CONFIRMED')).length).toBe(1);
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

  it('[Sol] one source shares ONE ceiling on each public door, whatever bearer token it sends', async () => {
    // A signed-in caller's token selects a per-user bucket in the global key;
    // on the public doors that would let one source multiply its allowance by
    // rotating principals. Anonymous and two signed-in partners, from one
    // address, together get exactly the ceiling.
    const fresh = await buildApp();
    try {
      const a = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const b = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const c = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const as = (who: Actor | null) => (who ? { authorization: `Bearer ${who.token}` } : {});
      const doors = [
        { max: MMG_CHECKOUT_RETURN_RATE.max, hit: (who: Actor | null) => fresh.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json', ...as(who) }, payload: { outcome: 'success', params: { token: 'x' } } }) },
        { max: MMG_CHECKOUT_NOTIFY_RATE.max, hit: (who: Actor | null) => fresh.inject({ method: 'POST', url: NOTIFY_URL, headers: { 'content-type': 'application/json', ...as(who) }, payload: { token: 'x' } }) },
      ];
      for (const door of doors) {
        const callers = [null, a, b];
        for (let i = 0; i < door.max; i += 1) expect((await door.hit(callers[i % callers.length] ?? null)).statusCode).toBe(200);
        // Over the ceiling for everyone at that source: anonymous, the same partners, and a principal not seen before.
        for (const who of [null, a, b, c]) {
          const over = await door.hit(who);
          expect(over.statusCode).toBe(429);
          expect(over.json().error.code).toBe('RATE_LIMITED');
        }
      }
    } finally {
      await fresh.close();
    }
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
    // The one route handler under /pay/mmg, whatever its dynamic segment is named: [outcome], then
    // [...path] since MMG-RETURN-PATH (#1421) moved it to read MMG's reply from the address path.
    const dir = resolve(process.cwd(), '../web/src/app/pay/mmg');
    const handlers = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(resolve(dir, entry.name, 'route.ts')));
    expect(handlers.map((entry) => entry.name)).toHaveLength(1);
    const src = readFileSync(resolve(dir, handlers[0]!.name, 'route.ts'), 'utf8');
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


describe('[MMG reopen] the partner’s own open checkout', () => {
  // [F2] Reopen has its own switch, OFF when missing: these cases run with it ON everywhere.
  beforeEach(async () => { enable(true); await reopenSwitch({ ios: true, android: true, web: true }); });
  afterEach(() => reopenSwitch(null));

  it.each(['vendor', 'rider', 'driver'] as const)('%s relaunch and two devices reopen the SAME checkout with one hold', async (family) => {
    const p = await (family === 'vendor' ? makeStore() : family === 'rider' ? makeRider() : makeDriver());
    const first = await started(p);
    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    expect(payload.reopenableMmgCheckout).toEqual({ ref: first.ref, expiresAt: first.row.expiresAt.toISOString() });
    expect(Object.keys(payload.reopenableMmgCheckout).sort()).toEqual(['expiresAt', 'ref']);
    const replies = await Promise.all([isolated(() => start(p)), isolated(() => start(p))]);
    for (const reply of replies) {
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json().data).toMatchObject({ ref: first.ref, status: 'OPEN', checkoutUrl: first.checkoutUrl });
    }
    expect(await isolated(() => app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: p.subId } }))).toBe(1);
    expect(await isolated(() => app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId } }))).toBe(1);
    expect(await isolated(() => app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId, status: 'ACTIVE', checkoutId: first.ref } }))).toBe(1);
    const other = await makeStore();
    expect((await subscriptionOf(other)).json().data.reopenableMmgCheckout).toBeNull();
    expect((await follow(other, first.ref)).statusCode).toBe(404);
  });

  it.each(['CONFIRMING', 'HELD', 'EXPIRED', 'NOT_PAID', 'CONFIRMED'] as const)('never reopens %s', async (status) => {
    const p = await makeStore(); const first = await started(p);
    if (status === 'CONFIRMED') {
      const txn = tx('REOPENPAID'); approved(txn, 2100);
      expect((await ret('success', { token: officialReply(first.row, '0', txn) })).json().data.state).toBe('CONFIRMED');
    } else await app.prisma.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { status } });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
  });

  it('does not reopen a timed-out OPEN or an older checkout', async () => {
    const p = await makeStore(); const first = await started(p);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { expiresAt: new Date() } });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
    await app.prisma.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    await app.prisma.mmgCheckoutIntent.create({ data: { ...first.row, id: nanoid(), merchantTransactionId: first.row.merchantTransactionId.slice(0, 9) + '999999999', status: 'NOT_PAID', createdAt: new Date(Date.now() + 1000) } });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
  });

  it('requires the sole ACTIVE hold on the current clock and epoch', async () => {
    const p = await makeStore(); const first = await started(p);
    const hold = await app.prisma.paymentConfirmationHold.findFirstOrThrow({ where: { checkoutId: first.ref } });
    for (const data of [{ status: 'SETTLEMENT_APPLY_PENDING' as const }]) {
      await app.prisma.paymentConfirmationHold.update({ where: { id: hold.id }, data });
      expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
      await app.prisma.paymentConfirmationHold.update({ where: { id: hold.id }, data: { status: 'ACTIVE', sourceEpoch: hold.sourceEpoch } });
    }
    // The database refuses stale source epochs. Also fail closed on a stale or missing read.
    for (const rows of [[{ ...hold, sourceEpoch: hold.sourceEpoch + 1 }], []]) {
      const staleDb = { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => app.prisma.$transaction((tx) => work(new Proxy(tx, {
        get: (target, name) => name === 'paymentConfirmationHold' ? { findMany: async () => rows } : Reflect.get(target, name),
      }))) } as unknown as PrismaClient;
      expect(await readReopenableMmgCheckout(staleDb, p.subId, first.ref, new Date())).toBeNull();
    }
    await app.prisma.billingDunningClock.update({ where: { id: hold.clockId }, data: { authorityHoldReason: 'TEST_REVIEW' } });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
  });

  it.each(['PENDING', 'UNKNOWN'] as const)('a card %s blocks reopen even before its hold is discovered', async (status) => {
    const p = await makeStore(); await started(p);
    const due = (await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } })).nextBillingDate;
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId: p.subId, amount: 2100, paymentMethod: 'CARD', status, periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), clientKey: `cardpay:${nanoid()}` } });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
    await isolated(() => readDunningClock(app.prisma, p.subId));
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
  });

  it('another active confirmation hold blocks reopen', async () => {
    const p = await makeStore(); await started(p);
    const due = (await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } })).nextBillingDate;
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId: p.subId, amount: 2100, paymentMethod: 'CARD', status: 'UNKNOWN', periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY) } });
    await isolated(() => readDunningClock(app.prisma, p.subId));
    expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId, status: 'ACTIVE' } })).toBe(2);
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
  });

  it('respects the global and platform kill switches', async () => {
    const p = await makeStore(); await started(p);
    enable(false);
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
    enable(true);
    await app.prisma.platformConfig.upsert({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY }, create: { key: FEE_CHECKOUT_PLATFORMS_KEY, value: { ios: false } }, update: { value: { ios: false } } });
    resetFeeCheckoutSwitchCache();
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
    expect((await subscriptionOf(p, { 'x-client-platform': 'web' })).json().data.reopenableMmgCheckout).toBeTruthy();
    await app.prisma.platformConfig.delete({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } }); resetFeeCheckoutSwitchCache();
  });
});


describe('[MMG reopen · review fixes] Back only ever reopens the named OPEN checkout', () => {
  beforeEach(async () => { enable(true); await reopenSwitch({ ios: true, android: true, web: true }); });
  afterEach(() => reopenSwitch(null));
  const countsOf = (p: Partner) => isolated(async () => ({
    checkouts: await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: p.subId } }),
    holds: await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId } }),
    activeHolds: await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } } }),
    keys: await app.prisma.mmgCheckoutKey.count({ where: { intent: { subscriptionId: p.subId } } }),
  }));

  it('[F1] Back while OPEN hands back the SAME page (two devices at once): one checkout, one hold, 200 never 201', async () => {
    const p = await makeStore(); const first = await started(p);
    const replies = await Promise.all([isolated(() => reopenTap(p, first.ref)), isolated(() => reopenTap(p, first.ref))]);
    for (const reply of replies) {
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json().data).toMatchObject({ ref: first.ref, status: 'OPEN', checkoutUrl: first.checkoutUrl });
    }
    expect(await countsOf(p)).toEqual({ checkouts: 1, holds: 1, activeHolds: 1, keys: 3 });
  });

  it.each(['CONFIRMED', 'NOT_PAID'] as const)('[F1] a stale Back tap after MMG answered %s opens nothing: no new checkout, hold or key', async (outcome) => {
    const p = await makeStore(); const first = await started(p);
    // Another device (or this one before its refresh) still holds the grant it read while C1 was OPEN.
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toMatchObject({ ref: first.ref });
    if (outcome === 'CONFIRMED') {
      const txn = tx(`STALEBACK${seq}`); approved(txn, 2100);
      expect((await ret('success', { token: officialReply(first.row, '0', txn) })).json().data.state).toBe('CONFIRMED');
    } else {
      expect((await ret('error', { token: officialReply(first.row, '6') })).json().data.state).toBe('NOT_PAID');
    }
    const before = await countsOf(p);
    const res = await reopenTap(p, first.ref);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CHECKOUT_NOT_REOPENABLE', details: { ref: first.ref, status: outcome } });
    expect(res.body).not.toContain('checkoutUrl');
    expect(await countsOf(p)).toEqual(before);
    expect(before.checkouts).toBe(1);
  });

  it('[F1] a Back tap past the deadline expires the page and opens nothing new', async () => {
    const p = await makeStore(); const first = await started(p);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await reopenTap(p, first.ref);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CHECKOUT_NOT_REOPENABLE', details: { ref: first.ref } });
    expect(await countsOf(p)).toEqual({ checkouts: 1, holds: 1, activeHolds: 1, keys: 1 });
    expect((await intentOf(first.ref)).status).toBe('EXPIRED');
  });

  it('[F1] Back names only its own subscription’s latest checkout: another partner’s ref is 404, an older one is refused', async () => {
    const p = await makeStore(); const first = await started(p);
    const other = await makeStore();
    const foreign = await reopenTap(other, first.ref);
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect((await reopenTap(p, 'no-such-ref-at-all')).statusCode).toBe(404);
    await app.prisma.mmgCheckoutIntent.create({ data: { ...first.row, id: nanoid(), merchantTransactionId: first.row.merchantTransactionId.slice(0, 9) + '888888888', status: 'NOT_PAID', createdAt: new Date(Date.now() + 1000) } });
    const older = await reopenTap(p, first.ref);
    expect(older.statusCode, older.body).toBe(409);
    expect(older.json().error.code).toBe('CHECKOUT_NOT_REOPENABLE');
    expect(await isolated(() => app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: other.subId } }))).toBe(0);
  });

  it('[F1] the service itself refuses a resolved checkout even when the grant says yes, and binds no key', async () => {
    const p = await makeStore(); const first = await started(p);
    const txn = tx(`SVCPAID${seq}`); approved(txn, 2100);
    expect((await ret('success', { token: officialReply(first.row, '0', txn) })).json().data.state).toBe('CONFIRMED');
    const before = await countsOf(p);
    const service = mmgCheckoutRuntimeOf(app).service;
    await expect(isolated(() => service.reopenCheckout({ subscriptionId: p.subId, userId: p.userId, ref: first.ref, clientKey: key(), granted: async () => true })))
      .rejects.toMatchObject({ code: 'CHECKOUT_NOT_REOPENABLE', details: { ref: first.ref, status: 'CONFIRMED' } });
    expect(await countsOf(p)).toEqual(before);
  });

  it('[F1] a checkout that leaves OPEN while Back is being answered hands out no page', async () => {
    const p = await makeStore(); const first = await started(p);
    const service = mmgCheckoutRuntimeOf(app).service;
    // MMG's reply lands between the read and the page: the checkout is CONFIRMING when the page would go out.
    const granted = async () => { await app.prisma.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { status: 'CONFIRMING' } }); return true; };
    await expect(isolated(() => service.reopenCheckout({ subscriptionId: p.subId, userId: p.userId, ref: first.ref, clientKey: key(), granted })))
      .rejects.toMatchObject({ code: 'CHECKOUT_NOT_REOPENABLE', details: { ref: first.ref, status: 'CONFIRMING' } });
    expect(await countsOf(p)).toMatchObject({ checkouts: 1, holds: 1 });
  });

  it('[F1] Back is refused while a card payment is pending, exactly as the grant is withheld', async () => {
    const p = await makeStore(); const first = await started(p);
    const due = (await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } })).nextBillingDate;
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId: p.subId, amount: 2100, paymentMethod: 'CARD', status: 'PENDING', periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), clientKey: `cardpay:${nanoid()}` } });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
    const res = await reopenTap(p, first.ref);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).not.toContain('checkoutUrl');
  });

  it('[F2] the reopen switch is OFF when its row is missing: no grant, and Back is refused', async () => {
    const p = await makeStore(); const first = await started(p);
    await reopenSwitch(null);
    const payload = (await subscriptionOf(p)).json().data;
    expect(payload.latestMmgCheckout).toMatchObject({ ref: first.ref, status: 'OPEN' });
    expect(payload.reopenableMmgCheckout).toBeNull();
    const res = await reopenTap(p, first.ref);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).not.toContain('checkoutUrl');
    expect(await countsOf(p)).toEqual({ checkouts: 1, holds: 1, activeHolds: 1, keys: 1 });
  });

  it('[F2] the reopen switch is per platform, strict booleans only, and separate from the Pay switch', async () => {
    const p = await makeStore(); const first = await started(p);
    await reopenSwitch({ web: true });
    expect((await subscriptionOf(p, { 'x-client-platform': 'web' })).json().data.reopenableMmgCheckout).toMatchObject({ ref: first.ref });
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toBeNull();
    expect((await subscriptionOf(p, { 'x-client-platform': 'android' })).json().data.reopenableMmgCheckout).toBeNull();
    expect((await subscriptionOf(p, { 'x-client-platform': 'unknown-thing' })).json().data.reopenableMmgCheckout).toBeNull();
    expect((await reopenTap(p, first.ref)).statusCode).toBe(409);
    expect((await reopenTap(p, first.ref, { 'x-client-platform': 'web' })).statusCode).toBe(200);
    for (const value of [{ ios: 'true' }, { ios: 1 }, 'on', true, [true]]) {
      await reopenSwitch(value);
      expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout, JSON.stringify(value)).toBeNull();
    }
    // The Pay switch is untouched by the reopen switch: a fresh partner still sees Pay live.
    const fresh = await makeStore();
    expect((await subscriptionOf(fresh)).json().data.payActions[0]).toMatchObject({ id: 'MMG_CHECKOUT', state: 'live' });
  });

  it.each(['legacy push payment proven to have had no effect', 'earlier expired checkout resolved by finance'] as const)('[F3] resolved history (%s) does not deny the reopen grant', async (history) => {
    const p = await makeStore();
    const due = (await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } })).nextBillingDate;
    if (history === 'legacy push payment proven to have had no effect') {
      const legacy = await inTenant(undefined, () => app.prisma.subscriptionPayment.create({ data: {
        subscriptionId: p.subId, amount: 2100, paymentMethod: 'MOBILE_MONEY', status: 'EXPIRED', failureCode: 'PROVIDER_NOT_FOUND',
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
      } }));
      await isolated(() => readDunningClock(app.prisma, p.subId));
      await isolated(() => app.prisma.$transaction((t) => resolveConfirmationInTx(t, p.subId, { paymentId: legacy.id }, 'PROVEN_NO_EFFECT', { actor: 'provider-confirmation', reference: 'PROVIDER_NOT_FOUND' })));
    } else {
      const earlier = await started(p);
      await app.prisma.mmgCheckoutIntent.update({ where: { id: earlier.ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
      // The next Pay expires the timed-out page (its pause stays: expiry is no proof) and is refused.
      expect((await start(p)).statusCode).toBe(409);
      expect((await intentOf(earlier.ref)).status).toBe('EXPIRED');
      await isolated(() => app.prisma.$transaction((t) => resolveConfirmationInTx(t, p.subId, { checkoutId: earlier.ref }, 'PROVEN_UNPAID', { actor: 'fixture-finance', reference: 'fixture-bank-confirmed-unpaid' })));
    }
    expect(await isolated(() => app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } } }))).toBe(0);
    const current = await started(p);
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toEqual({ ref: current.ref, expiresAt: current.row.expiresAt.toISOString() });
    const res = await reopenTap(p, current.ref);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ ref: current.ref, status: 'OPEN', checkoutUrl: current.checkoutUrl });
  });

  it('[F4] a failing reopen read never fails the fee page: no grant, the rest of the payload intact', async () => {
    const p = await makeStore(); const first = await started(p);
    expect((await subscriptionOf(p)).json().data.reopenableMmgCheckout).toMatchObject({ ref: first.ref });
    const original = app.prisma.$transaction;
    const spy = vi.spyOn(app.prisma, '$transaction').mockImplementation(((input: unknown, options?: { isolationLevel?: string }) =>
      options?.isolationLevel === 'RepeatableRead'
        ? Promise.reject(Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' }))
        : (original as (i: unknown, o?: unknown) => Promise<unknown>).call(app.prisma, input, options)) as never);
    try {
      const res = await subscriptionOf(p);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ reopenableMmgCheckout: null, latestMmgCheckout: { ref: first.ref, status: 'OPEN' }, payActions: [{ id: 'MMG_CHECKOUT', state: 'off' }, expect.anything()] });
      expect(spy.mock.calls.some(([, options]) => (options as { isolationLevel?: string } | undefined)?.isolationLevel === 'RepeatableRead')).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
