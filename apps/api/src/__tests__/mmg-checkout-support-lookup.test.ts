import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Writable } from 'node:stream';
import { loggerRedactConfig, loggerSerializers } from '../utils/logger-config';
import rateLimit from '@fastify/rate-limit';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { rateLimitKey } from '../utils/rate-limit-key';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { MMG_CHECKOUT_RUNTIME_DECORATION, mmgCheckoutPublicRoutes, type MmgCheckoutRuntime } from '../modules/billing/mmg-checkout.routes';
import { resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, type MmgLookupClient, type MmgLookupDetail } from '../providers/mmg/mmg-provider';
import { FakeMmgHistory, mmgHistoryRow } from './helpers/mmg-history-fake';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import {
  MMG_CHECKOUT_CREDITED_PERIOD_KEYS,
  MMG_CHECKOUT_SUPPORT_DETAIL_KEYS,
  MMG_CHECKOUT_SUPPORT_PARTNER_KEYS,
  MMG_CHECKOUT_SUPPORT_ROW_KEYS,
  MMG_CHECKOUT_TIMELINE_KEYS,
  type MmgCheckoutSupportDetail,
  type MmgCheckoutSupportRow,
} from '@swift/types';
import { mmgCheckoutSupportDetail } from '../modules/billing/mmg-checkout-support';
import { getMmgCheckoutProvider } from '../providers/mmg/mmg-checkout';

// ---------------------------------------------------------------------------
// [MMG support lookup] What MMG must see before it issues production
// credentials, against the database:
//   1. MMG's transaction id and our own (merchantTransactionId) are captured and stored;
//   2. support finds a payment by either id (and by MMG's ledger number, a
//      reply's named transaction, or the partner's phone), exactly, through an
//      admin route that is audited and discloses nothing secret;
//   3. the partner sees both ids on their receipt, MMG's only once CONFIRMED.
// The checkouts here are real ones, driven through the partner routes and the
// public return door; the sandbox runs the real reply cryptography and the
// MMG lookup answers in the exact UAT shape (evidence/mmg-uat, 1 Oct).
// Phones: +592648… for people, +592649… for stores (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const SEARCH = '/api/v1/admin/billing/mmg-checkouts';
const RETURN_URL = '/api/v1/billing/mmg-checkout/return';
let app: FastifyInstance;
let sandbox: SandboxMmgCheckoutProvider;
let kekBefore: string | undefined;
let enabledBefore: string | undefined;
let zoneBefore: string | undefined;
const startedAt = new Date();

const lookups = new Map<string, MmgLookupDetail>();
/** [7 Oct] MMG's Transaction History (helpers/mmg-history-fake.ts): it holds every payment `mmgAnswers` registers, made now. */
const history = new FakeMmgHistory();
const lookup: MmgLookupClient = {
  transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' },
  transactionHistoryRows: (query) => history.transactionHistoryRows(query),
};
/** MMG stamps creationDate as Guyana wall-clock time written with a "Z" (UAT, 1 Oct). */
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
/** MMG's lookup of `txn` in the exact UAT shape, read as the live adapter reads it. */
function mmgAnswers(checkout: { merchantTransactionId: string }, txn: string, ledger: string, amountGyd: number, patch: Record<string, unknown> = {}) {
  lookups.set(txn, lookupDetailFrom({
    transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
    subType: 'subscriber_mpay', transactionReference: ledger,
    creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
    metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
    descriptionText: null, ...patch,
  }, txn));
  history.holds(txn, amountGyd, { external_id: checkout.merchantTransactionId });
}
/** MMG ids are digits (UAT: transactionId 20402048536279, transactionReference 20402048601581); unique per run. */
let idSeq = 0;
const RUN_DIGITS = String(Date.now()).slice(-9);
const mmgId = () => `20${RUN_DIGITS}${String((idSeq += 1)).padStart(3, '0')}`;

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;
const phoneBase = Math.floor(Math.random() * 8000);
const personPhone = () => `+592648${String(phoneBase + (seq += 1)).padStart(4, '0')}`;
const storePhone = () => `+592649${String(phoneBase + (seq += 1)).padStart(4, '0')}`;
const key = () => `tap-${nanoid(12)}`;

/** Fixtures are written in a clean system context: an in-process request binds its tenant with
 *  enterWith, and a fixture written after one would otherwise inherit (be stamped with) that tenant. */
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:mmg-support-lookup');

type Actor = { userId: string; token: string; phone: string };
const makeUser = (roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; admin?: string[] } = {}) => sys(() => makeUserRow(roles, activeRole, opts));
async function makeUserRow(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; admin?: string[] }): Promise<Actor> {
  const phone = personPhone();
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Lookup', lastName: `P${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.admin ? { admin: { create: { permissions: opts.admin } } } : {}),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `mslookup-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, phone };
}
type SubOpts = { status?: SubscriptionStatus; due?: Date };
function period(opts: SubOpts) {
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  return { currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due };
}
type Partner = Actor & { subId: string; family: 'vendor' | 'rider' | 'driver'; vendorId?: string; name: string };
const makeStore = (opts: SubOpts = {}) => sys(() => makeStoreRows(opts));
async function makeStoreRows(opts: SubOpts): Promise<Partner> {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const name = `Lookup Store ${seq}`;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name, slug: `lookup-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: storePhone(),
      addressLine1: '1 Lookup Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: { vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100, ...period(opts), prepaidBalance: { create: { balance: 0 } } },
  });
  subIds.push(sub.id);
  return { ...owner, vendorId: vendor.id, subId: sub.id, family: 'vendor', name };
}
const makeRider = (opts: SubOpts = {}) => sys(() => makeRiderRows(opts));
async function makeRiderRows(opts: SubOpts): Promise<Partner> {
  const actor = await makeUser(['MOVER'], 'MOVER');
  const rider = await app.prisma.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
  const sub = await app.prisma.subscription.create({
    data: { riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: 6000, ...period(opts), prepaidBalance: { create: { balance: 0 } } },
  });
  subIds.push(sub.id);
  return { ...actor, subId: sub.id, family: 'rider', name: `Lookup P${seq}` };
}
const makeDriver = (opts: SubOpts = {}) => sys(() => makeDriverRows(opts));
async function makeDriverRows(opts: SubOpts): Promise<Partner> {
  const actor = await makeUser(['MOVER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: actor.userId, vehicleType: 'CAR', documentsVerified: true, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: `HB-LK-${nanoid(5)}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
    },
  });
  const sub = await app.prisma.subscription.create({
    data: { driverId: driver.id, type: 'TAXI_DRIVER', status: opts.status ?? 'ACTIVE', weeklyRate: 8000, ...period(opts), prepaidBalance: { create: { balance: 0 } } },
  });
  subIds.push(sub.id);
  return { ...actor, subId: sub.id, family: 'driver', name: `Lookup P${seq}` };
}

const partnerHeaders = (p: Partner) => ({ authorization: `Bearer ${p.token}`, 'x-client-platform': 'ios', ...(p.vendorId ? { 'x-vendor-id': p.vendorId } : {}) });
const subscriptionOf = (p: Partner) => app.inject({ method: 'GET', url: `/api/v1/${p.family}/subscription`, headers: partnerHeaders(p) });
const follow = (p: Partner, ref: string) => app.inject({ method: 'GET', url: `/api/v1/${p.family}/subscription/mmg-checkout/${ref}`, headers: partnerHeaders(p) });
const idempotencyKeys: string[] = [];
const start = (p: Partner) => {
  const k = key();
  idempotencyKeys.push(k);
  return app.inject({ method: 'POST', url: `/api/v1/${p.family}/subscription/mmg-checkout`, headers: { 'content-type': 'application/json', 'idempotency-key': k, ...partnerHeaders(p) }, payload: {} });
};
const checkoutUrls: string[] = [];
async function started(p: Partner) {
  const res = await start(p);
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { ref: string; checkoutUrl: string; amountGyd: number };
  checkoutUrls.push(data.checkoutUrl);
  return { ...data, row: await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: data.ref } }) };
}
/** MMG's reply as its page documents it: our reference, MMG's transaction, the result code, a message and HTML. */
const reply = (row: { merchantTransactionId: string }, code: string, txn?: string) => sandbox.sandboxReplyToken({
  merchantTransactionId: row.merchantTransactionId, ...(txn ? { transactionId: txn } : {}), ResultCode: code,
  ResultMessage: 'per MMG words', htmlResponse: '<h1>per MMG html</h1>',
});
const returnWith = (token: string) => app.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: { outcome: 'success', params: { token } } });

let admin: Actor;
const asAdmin = (url: string, token = admin.token) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const search = (q: string, extra = '', token?: string) => asAdmin(`${SEARCH}?q=${encodeURIComponent(q)}${extra}`, token);
const rowsOf = (res: { json: () => { data: MmgCheckoutSupportRow[] } }) => res.json().data;
const auditRows = () => app.prisma.auditLog.findMany({ where: { userId: admin.userId }, orderBy: { createdAt: 'desc' } });

/** The scenario: one checkout in every state that matters to support. */
const s = {} as {
  store: Partner; rider: Partner; driver: Partner;
  confirmed: { ref: string; ours: string; txn: string; ledger: string; amount: number };
  held: { ref: string; ours: string; txn: string; ledger: string };
  confirming: { ref: string; ours: string; txn: string };
  notPaid: { ref: string; ours: string };
  open: { ref: string; ours: string };
};

async function buildApp(logger: FastifyServerOptions['logger'] = false, beforeReady?: (server: FastifyInstance) => void): Promise<FastifyInstance> {
  const server = Fastify({ logger });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(rateLimit, { max: 1000, timeWindow: '1 minute', keyGenerator: rateLimitKey((token) => server.jwt.verify(token)) });
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  const notifications = new NotificationService(server.prisma, server.io);
  const billing = new BillingService(server.prisma, notifications, getPaymentProvider());
  const service = new MmgCheckoutService(server.prisma, billing, notifications, { checkout: () => sandbox, lookup: () => lookup });
  const runtime: MmgCheckoutRuntime = { service, checkout: () => sandbox, notifications };
  server.decorate(MMG_CHECKOUT_RUNTIME_DECORATION, runtime);
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.register(riderRoutes, { prefix: '/api/v1/rider' });
  await server.register(driverRoutes, { prefix: '/api/v1/driver' });
  await server.register(mmgCheckoutPublicRoutes, { prefix: '/api/v1/billing/mmg-checkout' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  beforeReady?.(server);
  await server.ready();
  return server;
}

beforeAll(async () => {
  delete process.env['MMG_DRIVER'];
  enabledBefore = process.env['MMG_CHECKOUT_ENABLED'];
  process.env['MMG_CHECKOUT_ENABLED'] = '1';
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  // [#1393 DS632] How MMG's payment time is read, as staging and production
  // set it (deploy/.env.deploy.example): the confirmations below and the
  // window support reports both read it. Unset, every payment would be held.
  zoneBefore = process.env['MMG_CHECKOUT_CREATION_ZONE'];
  process.env['MMG_CHECKOUT_CREATION_ZONE'] = 'GUYANA_WALL_CLOCK';
  resetKeyProviderForTests();
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((res, rej) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? rej(err) : res({ publicKey, privateKey })));
  });
  sandbox = new SandboxMmgCheckoutProvider({ request: pair, result: pair });
  app = await buildApp();
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
  resetFeeCheckoutSwitchCache();
  admin = await makeUser(['SUPER_ADMIN'], 'SUPER_ADMIN', { admin: ['*'] });

  // CONFIRMED: an overdue store pays; MMG answers 0 naming its transaction and the lookup confirms all six conditions.
  s.store = await makeStore({ status: 'PAST_DUE', due: new Date(Date.now() - DAY) });
  // An earlier attempt MMG cancelled (6): NOT_PAID, and the partner tries again.
  const first = await started(s.store);
  expect((await returnWith(reply(first.row, '6'))).json().data.state).toBe('NOT_PAID');
  s.notPaid = { ref: first.ref, ours: first.row.merchantTransactionId };
  const paid = await started(s.store);
  const txn = mmgId();
  const ledger = mmgId();
  mmgAnswers(paid.row, txn, ledger, paid.amountGyd);
  expect((await returnWith(reply(paid.row, '0', txn))).json().data.state).toBe('CONFIRMED');
  s.confirmed = { ref: paid.ref, ours: paid.row.merchantTransactionId, txn, ledger, amount: paid.amountGyd };
  // OPEN: the same store starts one more and never finishes it.
  const open = await started(s.store);
  s.open = { ref: open.ref, ours: open.row.merchantTransactionId };

  // HELD: MMG answers 0, but its lookup reports a different amount.
  s.rider = await makeRider();
  const held = await started(s.rider);
  const heldTxn = mmgId();
  const heldLedger = mmgId();
  mmgAnswers(held.row, heldTxn, heldLedger, held.amountGyd + 1);
  expect((await returnWith(reply(held.row, '0', heldTxn))).json().data.state).toBe('CONFIRMING');
  expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: held.ref } })).status).toBe('HELD');
  s.held = { ref: held.ref, ours: held.row.merchantTransactionId, txn: heldTxn, ledger: heldLedger };

  // CONFIRMING: MMG answers 0 naming a transaction its lookup does not know yet.
  s.driver = await makeDriver();
  const waiting = await started(s.driver);
  const waitingTxn = mmgId();
  expect((await returnWith(reply(waiting.row, '0', waitingTxn))).json().data.state).toBe('CONFIRMING');
  s.confirming = { ref: waiting.ref, ours: waiting.row.merchantTransactionId, txn: waitingTxn };
}, 180_000);

beforeEach(() => resetFeeCheckoutSwitchCache());

afterAll(async () => {
  await runWithoutTenant(async () => {
    const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
    await app.prisma.mmgCheckoutObservation.deleteMany({ where: { OR: [{ intentId: { in: intents.map((i) => i.id) } }, { intentId: null, createdAt: { gte: startedAt } }] } });
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.providerPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    // Stores first (no mover-fee authority), then the people: a mover's fee authority and its
    // sources go with the payer (mover-fee-authority.test.ts), leaving their subscriptions orphaned.
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds }, vendorId: { not: null } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:mmg-support-lookup').catch(() => 0);
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] }, 'test-cleanup:mmg-support-lookup').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] }, 'test-cleanup:mmg-support-lookup').catch(() => 0);
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  }, 'test-cleanup:mmg-support-lookup');
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK'];
  else process.env['MASTER_KEK'] = kekBefore;
  if (zoneBefore === undefined) delete process.env['MMG_CHECKOUT_CREATION_ZONE'];
  else process.env['MMG_CHECKOUT_CREATION_ZONE'] = zoneBefore;
  if (enabledBefore === undefined) delete process.env['MMG_CHECKOUT_ENABLED'];
  else process.env['MMG_CHECKOUT_ENABLED'] = enabledBefore;
  resetKeyProviderForTests();
});

describe('1. both ids are captured and stored', () => {
  it('a confirmed checkout holds our 18-digit reference, MMG\'s transaction, and the lookup holds MMG\'s ledger number', async () => {
    const row = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: s.confirmed.ref } });
    expect(row).toMatchObject({ status: 'CONFIRMED', merchantTransactionId: s.confirmed.ours, mmgTransactionId: s.confirmed.txn });
    expect(row.merchantTransactionId).toMatch(/^\d{18}$/);
    const lookups = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: s.confirmed.ref, source: 'LOOKUP' } });
    expect(lookups.some((o) => (o.body as Record<string, unknown> | null)?.['transactionReference'] === s.confirmed.ledger)).toBe(true);
  });
});

describe('2. support finds a payment: the admin route is for admins only', () => {
  it('no token is 401; a customer, a partner and an admin without the grant are 403 — on both routes', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const narrow = await makeUser(['ADMIN'], 'ADMIN', { admin: ['support.read'] });
    for (const url of [`${SEARCH}?q=${s.confirmed.ours}`, `${SEARCH}/${s.confirmed.ref}`]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      for (const [who, token] of [['customer', customer.token], ['partner', s.store.token], ['narrow admin', narrow.token]] as const) {
        const res = await asAdmin(url, token);
        expect(res.statusCode, `${who} ${url}: ${res.body}`).toBe(403);
        expect(res.body).not.toContain(s.confirmed.txn);
      }
    }
  });
});

describe('2. support finds a payment by each identifier, exactly', () => {
  it('our reference (the Swift reference), as pasted', async () => {
    const rows = rowsOf(await search(` ${s.confirmed.ours.slice(0, 6)} ${s.confirmed.ours.slice(6)} `));
    expect(rows.map((r) => r.id)).toEqual([s.confirmed.ref]);
    expect(rows[0]).toMatchObject({
      swiftReference: s.confirmed.ours, mmgTransactionId: s.confirmed.txn, mmgTransactionReference: s.confirmed.ledger,
      amount: s.confirmed.amount, currencyCode: 'GYD', status: 'CONFIRMED', platform: 'ios', matchedBy: ['SWIFT_REFERENCE'],
      partner: { kind: 'VENDOR', displayName: s.store.name, subscriptionId: s.store.subId },
    });
    expect(rows[0]!.confirmedAt).not.toBeNull();
    expect(rows[0]!.replyAt).not.toBeNull();
    expect(rows[0]!.partner.maskedPhone).toBe(`+592•••••${s.store.phone.slice(-4)}`);
  });

  it("MMG's transaction id: the confirmed one, and one a reply named that is still held or confirming", async () => {
    expect(rowsOf(await search(s.confirmed.txn))).toMatchObject([{ id: s.confirmed.ref, matchedBy: ['MMG_TRANSACTION_ID', 'MMG_CANDIDATE'] }]);
    expect(rowsOf(await search(s.held.txn))).toMatchObject([{ id: s.held.ref, status: 'HELD', mmgTransactionId: null, reason: 'AMOUNT_MISMATCH', matchedBy: ['MMG_CANDIDATE'] }]);
    expect(rowsOf(await search(s.confirming.txn))).toMatchObject([{ id: s.confirming.ref, status: 'CONFIRMING', mmgTransactionId: null, matchedBy: ['MMG_CANDIDATE'] }]);
  });

  it("MMG's ledger number (the lookup's transactionReference), for a confirmed and a held payment", async () => {
    expect(rowsOf(await search(s.confirmed.ledger))).toMatchObject([{ id: s.confirmed.ref, matchedBy: ['MMG_REFERENCE'] }]);
    expect(rowsOf(await search(s.held.ledger))).toMatchObject([{ id: s.held.ref, mmgTransactionReference: s.held.ledger, matchedBy: ['MMG_REFERENCE'] }]);
  });

  it("the partner's phone, in E.164 or as a local Guyana number: every checkout of theirs, newest first", async () => {
    for (const q of [s.store.phone, s.store.phone.slice(4), `592 ${s.store.phone.slice(4)}`]) {
      const rows = rowsOf(await search(q));
      expect(rows.map((r) => r.id), q).toEqual([s.open.ref, s.confirmed.ref, s.notPaid.ref]);
      expect(rows.every((r) => r.matchedBy.join() === 'PARTNER_PHONE')).toBe(true);
    }
    expect(rowsOf(await search(s.rider.phone)).map((r) => r.id)).toEqual([s.held.ref]);
  });

  it('exact means exact: a prefix, a suffix, one digit off or an unknown value finds nothing', async () => {
    for (const q of [s.confirmed.ours.slice(0, 17), s.confirmed.ours.slice(1), `${s.confirmed.txn}0`, s.confirmed.txn.slice(0, -1), '999999999999999999', s.store.phone.slice(0, -1), 'nothing-here']) {
      const res = await search(q);
      expect(res.statusCode, q).toBe(200);
      expect(rowsOf(res), q).toEqual([]);
    }
  });

  it('the status filter narrows a search, and an unknown status is refused', async () => {
    expect(rowsOf(await search(s.store.phone, '&status=CONFIRMED')).map((r) => r.id)).toEqual([s.confirmed.ref]);
    expect(rowsOf(await search(s.store.phone, '&status=HELD'))).toEqual([]);
    expect((await search(s.store.phone, '&status=PAID')).statusCode).toBe(400);
  });

  it('pages newest first with an opaque cursor, and a forged cursor is refused', async () => {
    const one = await search(s.store.phone, '&limit=2');
    expect(rowsOf(one).map((r) => r.id)).toEqual([s.open.ref, s.confirmed.ref]);
    const cursor = one.json().nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const two = await search(s.store.phone, `&limit=2&cursor=${cursor}`);
    expect(rowsOf(two).map((r) => r.id)).toEqual([s.notPaid.ref]);
    expect(two.json().nextCursor).toBeNull();
    expect((await search(s.store.phone, '&cursor=not-a-cursor')).statusCode).toBe(400);
    expect((await search(s.store.phone, '&limit=51')).statusCode).toBe(400);
  });

  it('with no query it is the checkouts list, newest first, filterable by status', async () => {
    const res = await asAdmin(`${SEARCH}?status=HELD&limit=50`);
    expect(res.statusCode).toBe(200);
    const rows = rowsOf(res);
    expect(rows.map((r) => r.id)).toContain(s.held.ref);
    expect(rows.every((r) => r.status === 'HELD' && r.matchedBy.length === 0)).toBe(true);
    const times = rows.map((r) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("another operator's (tenant's) payment is never found, by any id, and its detail is 404", async () => {
    const tenantId = `mslookup-other-${nanoid(6).toLowerCase()}`;
    tenantIds.push(tenantId);
    await app.prisma.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Another operator', kind: 'PRODUCTION', isActive: true } });
    // A store of that operator, with a held checkout that names the same MMG transaction as ours.
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER', { tenantId });
    expect((await sys(() => app.prisma.user.findUniqueOrThrow({ where: { id: owner.userId }, select: { tenantId: true } }))).tenantId).toBe(tenantId);
    const foreignSub = await sys(async () => {
      const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
      const vendor = await app.prisma.vendor.create({
        data: {
          tenantId, ownerId: ownerRow.id, name: 'Foreign Store', slug: `foreign-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: storePhone(),
          addressLine1: '1 Foreign Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
        },
      });
      vendorIds.push(vendor.id);
      return app.prisma.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, ...period({}) } });
    });
    subIds.push(foreignSub.id);
    const ours = `17${RUN_DIGITS}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const foreign = await sys(() => app.prisma.mmgCheckoutIntent.create({
      data: {
        tenantId, subscriptionId: foreignSub.id, merchantTransactionId: ours, amount: 2100, currencyCode: 'GYD', status: 'HELD',
        createdByUserId: owner.userId, platform: 'web', checkoutUrlSealed: randomBytes(64), checkoutUrlDek: randomBytes(64),
        expiresAt: new Date(Date.now() + 60_000), candidates: [s.confirmed.txn], reason: 'AMOUNT_MISMATCH',
      },
    }));
    try {
      expect(rowsOf(await search(ours))).toEqual([]);
      expect(rowsOf(await search(s.confirmed.txn)).map((r) => r.id)).toEqual([s.confirmed.ref]);
      expect(rowsOf(await search(owner.phone))).toEqual([]);
      expect((await asAdmin(`${SEARCH}/${foreign.id}`)).statusCode).toBe(404);
    } finally {
      await sys(() => app.prisma.mmgCheckoutIntent.delete({ where: { id: foreign.id } }));
    }
  });
});

describe('2. every search and every detail view is audited, never with the raw phone', () => {
  it('a search writes who, when, the identifier type that matched and the record ids', async () => {
    const before = new Date();
    await search(s.held.ledger);
    const [row] = await auditRows();
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row!.action).toBe(`ADMIN GET ${SEARCH}`);
    expect(row!.changes).toMatchObject({ queryType: 'MMG_REFERENCE', queryShape: 'ID', matchedIds: s.held.ref, matchedCount: 1 });
  });

  it('a phone search records PARTNER_PHONE and the ids, and no form of the number anywhere in the row', async () => {
    await search(s.store.phone);
    const [row] = await auditRows();
    expect(row!.changes).toMatchObject({ queryType: 'PARTNER_PHONE', matchedIds: [s.open.ref, s.confirmed.ref, s.notPaid.ref].join(',') });
    const text = JSON.stringify(row);
    for (const form of [s.store.phone, s.store.phone.slice(1), s.store.phone.slice(4)]) expect(text).not.toContain(form);
  });

  it('a search that finds nothing is still recorded', async () => {
    await search('123456789012');
    const [row] = await auditRows();
    expect(row!.changes).toMatchObject({ queryType: 'NO_MATCH', matchedIds: '', matchedCount: 0 });
  });

  it('the list (no query) is recorded as a list', async () => {
    await asAdmin(`${SEARCH}?status=HELD`);
    const [row] = await auditRows();
    expect(row!.changes).toMatchObject({ queryType: 'LIST', queryShape: 'EMPTY', statusFilter: 'HELD' });
  });

  it('a detail view writes the checkout it opened; a refused read writes nothing', async () => {
    await asAdmin(`${SEARCH}/${s.held.ref}`);
    const [row] = await auditRows();
    expect(row!.action).toBe(`ADMIN GET ${SEARCH}/:id`);
    expect(row!.entityId).toBe(s.held.ref);
    expect(row!.changes).toMatchObject({ queryType: 'DETAIL', matchedIds: s.held.ref });
    const count = (await auditRows()).length;
    expect((await asAdmin(`${SEARCH}/no-such-checkout`)).statusCode).toBe(404);
    expect((await asAdmin(`${SEARCH}?cursor=forged`)).statusCode).toBe(400);
    expect((await auditRows()).length).toBe(count);
  });
});

describe('2. the answer discloses nothing secret: exactly the contract keys', () => {
  const FORBIDDEN_KEYS = /url|token|key|secret|html|header|sealed|dek|password|candidates|body|shape|message/i;
  function keysIn(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); keysIn(v, out); }
    return out;
  }
  const assertNoSecrets = (body: string) => {
    for (const url of checkoutUrls) expect(body).not.toContain(url);
    for (const k of idempotencyKeys) expect(body).not.toContain(k);
    expect(body).not.toMatch(/per MMG words|per MMG html|<h1>|sandbox|checkoutUrl|mmgtest|token=/i);
  };

  it('search rows carry exactly the row and partner keys', async () => {
    const res = await search(s.store.phone);
    for (const row of rowsOf(res)) {
      expect(Object.keys(row).sort()).toEqual([...MMG_CHECKOUT_SUPPORT_ROW_KEYS].sort());
      expect(Object.keys(row.partner).sort()).toEqual([...MMG_CHECKOUT_SUPPORT_PARTNER_KEYS].sort());
    }
    expect(Object.keys(res.json()).sort()).toEqual(['data', 'nextCursor', 'success']);
    expect(keysIn(res.json()).filter((k) => FORBIDDEN_KEYS.test(k) && k !== 'nextCursor')).toEqual([]);
    assertNoSecrets(res.body);
  });

  it('a detail carries exactly the detail, timeline and credited-period keys', async () => {
    for (const ref of [s.confirmed.ref, s.held.ref, s.confirming.ref, s.notPaid.ref, s.open.ref]) {
      const res = await asAdmin(`${SEARCH}/${ref}`);
      expect(res.statusCode).toBe(200);
      const detail = res.json().data as MmgCheckoutSupportDetail;
      expect(Object.keys(detail).sort()).toEqual([...MMG_CHECKOUT_SUPPORT_DETAIL_KEYS].sort());
      for (const entry of detail.timeline) expect(Object.keys(entry).sort()).toEqual([...MMG_CHECKOUT_TIMELINE_KEYS].sort());
      if (detail.creditedPeriod) expect(Object.keys(detail.creditedPeriod).sort()).toEqual([...MMG_CHECKOUT_CREDITED_PERIOD_KEYS].sort());
      expect(keysIn(res.json()).filter((k) => FORBIDDEN_KEYS.test(k))).toEqual([]);
      assertNoSecrets(res.body);
    }
  });
});

describe('2. the detail: the row, a timeline from the observations, and the credited period', () => {
  it('[Fable · #1422 S3-1] support reads the zone from the checkout provider in use, as verify() does: a provider with no zone shows UNREADABLE, never INSIDE', async () => {
    const row = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: s.confirmed.ref } });
    const detailWith = (checkout: () => ReturnType<typeof getMmgCheckoutProvider>) =>
      runWithoutTenant(() => mmgCheckoutSupportDetail(app.prisma, { tenantId: row.tenantId, id: row.id }, { checkout }));
    // The provider verify() would use here (this file's sandbox, GUYANA_WALL_CLOCK): MMG's history record reads INSIDE.
    expect((await detailWith(() => sandbox))!.timeline.find((e) => e.source === 'HISTORY')).toMatchObject({ windowCheck: 'INSIDE' });
    // The checkout switched off (the environment still names a zone): verify() reads no zone and holds
    // every payment CREATION_ZONE_UNVERIFIED, so support claims nothing either.
    expect(process.env['MMG_CHECKOUT_CREATION_ZONE']).toBe('GUYANA_WALL_CLOCK');
    const off = getMmgCheckoutProvider({ ...process.env, MMG_CHECKOUT_ENABLED: '0' });
    expect(off.creationZone).toBeNull();
    expect((await detailWith(() => off))!.timeline.find((e) => e.source === 'HISTORY')).toMatchObject({ windowCheck: 'UNREADABLE' });
    // A provider that cannot be built (a configuration error) is no zone too.
    expect((await detailWith(() => { throw new Error('bad MMG configuration'); }))!.timeline.find((e) => e.source === 'HISTORY')).toMatchObject({ windowCheck: 'UNREADABLE' });
  });

  it('[Sol, DS663 · 7 Oct] a payment MMG’s history dates three minutes after its first reply, inside the window: held as PAYMENT_TIME_AFTER_REPLY, and support shows AFTER_REPLY, never INSIDE', async () => {
    const rider = await makeRider();
    const c = await started(rider);
    const txn = mmgId();
    mmgAnswers(c.row, txn, mmgId(), c.amountGyd);
    history.answer = async () => ({ outcome: 'rows', rows: [mmgHistoryRow(txn, c.amountGyd, { external_id: c.row.merchantTransactionId, modificationDate: gyStamp(new Date(Date.now() + 3 * 60_000)) })] });
    try {
      expect((await returnWith(reply(c.row, '0', txn))).json().data.state).toBe('CONFIRMING');
    } finally {
      history.answer = null;
    }
    expect(await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: c.ref } })).toMatchObject({ status: 'HELD', reason: 'PAYMENT_TIME_AFTER_REPLY' });
    const detail = (await asAdmin(`${SEARCH}/${c.ref}`)).json().data as MmgCheckoutSupportDetail;
    expect(detail.timeline.find((e) => e.source === 'HISTORY')).toMatchObject({ mmgTransactionId: txn, transactionStatus: 'completed', windowCheck: 'AFTER_REPLY' });
    // The lookup shows MMG's status, never a window: its creationDate is the lookup's own moment.
    expect(detail.timeline.find((e) => e.source === 'LOOKUP')).toMatchObject({ mmgTransactionId: txn, transactionStatus: 'successful', windowCheck: null });
    expect(detail.timeline.some((e) => e.windowCheck === 'INSIDE' && e.source !== 'RETURN')).toBe(false);
  });

  it('a confirmed payment: the reply (ResultCode 0, in time), the lookup (successful, amount, GYD, ledger number), MMG’s history record (completed, inside the window), the week it paid and its receipt', async () => {
    const detail = (await asAdmin(`${SEARCH}/${s.confirmed.ref}`)).json().data as MmgCheckoutSupportDetail;
    expect(detail).toMatchObject({ id: s.confirmed.ref, swiftReference: s.confirmed.ours, mmgTransactionId: s.confirmed.txn, mmgTransactionReference: s.confirmed.ledger, status: 'CONFIRMED', timelineTruncated: false });
    expect(detail.timeline[0]).toMatchObject({ source: 'RETURN', resultCode: '0', mmgTransactionId: s.confirmed.txn, windowCheck: 'INSIDE', failure: null });
    expect(detail.timeline).toContainEqual(expect.objectContaining({
      source: 'LOOKUP', transactionStatus: 'successful', amount: String(s.confirmed.amount), currency: 'GYD',
      mmgTransactionId: s.confirmed.txn, mmgTransactionReference: s.confirmed.ledger, windowCheck: null, resultCode: null,
    }));
    expect(detail.timeline).toContainEqual(expect.objectContaining({
      source: 'HISTORY', transactionStatus: 'completed', amount: String(s.confirmed.amount), currency: 'GYD',
      mmgTransactionId: s.confirmed.txn, mmgTransactionReference: null, windowCheck: 'INSIDE', resultCode: null, failure: null,
    }));
    const times = detail.timeline.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const payment = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: s.store.subId, status: 'CAPTURED' }, orderBy: { createdAt: 'desc' } });
    const receipt = await app.prisma.feeReceipt.findFirstOrThrow({ where: { subscriptionId: s.store.subId }, orderBy: { issuedAt: 'desc' } });
    expect(detail.creditedPeriod).toEqual({
      state: 'APPLIED', periodStart: payment.periodStart.toISOString(), periodEnd: payment.periodEnd.toISOString(), receiptNumber: receipt.receiptNumber,
    });
  });

  it('a held payment: no credited period, the operator reason, and the lookup that disagreed', async () => {
    const detail = (await asAdmin(`${SEARCH}/${s.held.ref}`)).json().data as MmgCheckoutSupportDetail;
    expect(detail).toMatchObject({ status: 'HELD', reason: 'AMOUNT_MISMATCH', mmgTransactionId: null, creditedPeriod: null });
    expect(detail.timeline).toContainEqual(expect.objectContaining({ source: 'LOOKUP', mmgTransactionId: s.held.txn, mmgTransactionReference: s.held.ledger }));
  });

  it("a cancelled attempt shows MMG's code 6; an open one has no timeline yet", async () => {
    const cancelled = (await asAdmin(`${SEARCH}/${s.notPaid.ref}`)).json().data as MmgCheckoutSupportDetail;
    expect(cancelled).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_RESULT_6', creditedPeriod: null });
    expect(cancelled.timeline).toMatchObject([{ source: 'RETURN', resultCode: '6', mmgTransactionId: null }]);
    const open = (await asAdmin(`${SEARCH}/${s.open.ref}`)).json().data as MmgCheckoutSupportDetail;
    expect(open).toMatchObject({ status: 'OPEN', timeline: [], replyAt: null, confirmedAt: null });
  });
});

describe('3. the partner sees both ids on their receipt; MMG\'s only once CONFIRMED', () => {
  it('the subscription payload: every checkout carries the Swift reference, only the confirmed one MMG\'s id', async () => {
    const recent = (await subscriptionOf(s.store)).json().data.recentCheckouts as Array<Record<string, unknown>>;
    const byRef = new Map(recent.map((c) => [c['ref'], c]));
    expect(byRef.get(s.confirmed.ref)).toMatchObject({ status: 'CONFIRMED', swiftReference: s.confirmed.ours, mmgTransactionId: s.confirmed.txn });
    expect(byRef.get(s.notPaid.ref)).toMatchObject({ status: 'NOT_PAID', swiftReference: s.notPaid.ours, mmgTransactionId: null });
    expect(byRef.get(s.open.ref)).toMatchObject({ status: 'OPEN', swiftReference: s.open.ours, mmgTransactionId: null });
  });

  it('a HELD or CONFIRMING checkout never shows the partner the MMG id a reply named', async () => {
    for (const [p, c] of [[s.rider, s.held], [s.driver, s.confirming]] as const) {
      const recent = (await subscriptionOf(p)).json().data.recentCheckouts as Array<Record<string, unknown>>;
      expect(recent.find((r) => r['ref'] === c.ref)).toMatchObject({ swiftReference: c.ours, mmgTransactionId: null });
      expect((await follow(p, c.ref)).json().data).toMatchObject({ swiftReference: c.ours, mmgTransactionId: null });
      expect(JSON.stringify((await subscriptionOf(p)).json())).not.toContain(c.txn);
    }
  });

  it('following one checkout answers the same receipt fields', async () => {
    expect((await follow(s.store, s.confirmed.ref)).json().data).toMatchObject({ swiftReference: s.confirmed.ours, mmgTransactionId: s.confirmed.txn });
  });
});

describe('[Sol · #1422] a phone search that fails never writes the phone to the operational log', () => {
  it('the request and its failure are logged by route template only, with the production logger settings', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    // The production logger settings (app.ts): redaction and serializers. The
    // search route fails the way a database or audit failure would, with an
    // error that carries the raw request target.
    const logged = await buildApp({ level: 'trace', stream, redact: loggerRedactConfig, serializers: loggerSerializers }, (server) => {
      server.addHook('preHandler', async (request) => {
        if (request.routeOptions.url === SEARCH) {
          throw Object.assign(new Error(`audit write refused for GET ${request.url}`), { url: request.url, query: request.query });
        }
      });
    });
    try {
      const phone = s.rider.phone;
      const res = await logged.inject({ method: 'GET', url: `${SEARCH}?q=${encodeURIComponent(phone)}`, headers: { authorization: `Bearer ${admin.token}` } });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(phone.slice(1));
      const log = lines.join('');
      // The failure was logged, by route template...
      expect(log).toContain('Unhandled error');
      expect(log).toContain(SEARCH);
      // ...and nowhere does the phone appear, in any spelling.
      for (const spelling of [phone, encodeURIComponent(phone), phone.slice(1), phone.slice(4)]) expect(log).not.toContain(spelling);
      expect(log).not.toContain('?q=');
    } finally {
      await logged.close();
    }
  });
});
