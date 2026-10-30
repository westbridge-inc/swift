import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { rateLimitKey } from '../utils/rate-limit-key';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_CHECKOUT_TTL_MS, MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { readDunningClock } from '../modules/billing/dunning-clock';
import { readFeePaymentDecision } from '../modules/billing/fee-payment-authority';
import { confirmationReviewQueue, resolveFinanceConfirmation } from '../modules/billing/confirmation-finance';
import { reversalEligibilityInTx } from '../modules/billing/mmg-fee-reversal';
import { searchMmgCheckouts } from '../modules/billing/mmg-checkout-support';
import { partnerObligations } from '../modules/user/partner-wind-down';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { grantStepUp } from './helpers/step-up';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import {
  MMG_CHECKOUT_RUNTIME_DECORATION,
  mmgCheckoutPublicRoutes,
  type MmgCheckoutRuntime,
} from '../modules/billing/mmg-checkout.routes';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, newMerchantTransactionId, type MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, type MmgCheckoutLookupClient, type MmgLookupDetail } from '../providers/mmg/mmg-provider';
import { FakeMmgHistory, mmgTimeOf } from './helpers/mmg-history-fake';
import { NO_REPLY_CHECK_ACTOR, NO_REPLY_CLOSE_AUDIT, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS, CONFIRMATION_RESOLVE_ACTION } from '../modules/billing/mmg-expired-hold-check';

// ---------------------------------------------------------------------------
// [ENTERPRISE E1 · owner 29 Oct 2026 "just do whats best"; COORD ruling
// 21:28Z] "Pay all my branches": ONE MMG checkout for every branch fee that
// is due, against the real database (triggers, checks, RLS as migrated), the
// real vendor routes and the sandbox's real request/reply cryptography. MMG's
// lookup and history are scripted per transaction (no MMG fact is invented:
// the shapes are #1393's UAT shapes).
//
// Money rules pinned here (GUARDRAILS s1):
//   P1 the list is each branch's OWN Pay amount; the owner confirms it first
//   P2 re-priced under every branch's locks BEFORE any page: a difference is
//      refused (409 PAYMENT_QUOTE_CHANGED), never adjusted after a payment
//   P3 each covered branch's clock is held by its own part: its own Pay is
//      off and refused while the pay-all is unresolved (no double charge),
//      and a pay-all and a branch's own Pay racing never both open
//   P4 nothing credits until MMG's lookup confirms the exact total; then ONE
//      MMG identity, and each branch's own top-up of exactly its share, in one
//      transaction; replays credit nothing more
//   P5 held / not paid / expired behave as a single checkout does, for every
//      branch at once
// Phones: +592648… (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RETURN_URL = '/api/v1/billing/mmg-checkout/return';
let app: FastifyInstance;
let service: MmgCheckoutService;
let billing: BillingService;
let sandbox: SandboxMmgCheckoutProvider;
let checkoutProvider: () => MmgCheckoutProvider;
let kekBefore: string | undefined;
let enabledBefore: string | undefined;
let zoneBefore: string | undefined;
const startedAt = new Date();

const lookups = new Map<string, MmgLookupDetail>();
const history = new FakeMmgHistory();
const lookup: MmgCheckoutLookupClient = {
  transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' },
  transactionHistoryRows: (query) => history.transactionHistoryRows(query),
};
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
const ledgerOf = (txn: string) => `L${txn}`;
/** MMG's lookup answer in the UAT shape (#1393's suites build it the same way). */
const uatAnswer = (txn: string, amountGyd: number): Record<string, unknown> => ({
  transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
  subType: 'subscriber_mpay', transactionReference: ledgerOf(txn),
  creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
  descriptionText: null,
});
/** MMG's lookup and history both show `txn` paid, for `amountGyd`, naming this checkout. */
function mmgPaid(checkout: { merchantTransactionId: string }, txn: string, amountGyd: number) {
  lookups.set(txn, lookupDetailFrom(uatAnswer(txn, amountGyd), txn));
  history.holds(txn, amountGyd, { external_id: checkout.merchantTransactionId });
}

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;
const phoneBase = 592_648_000_000 + Math.floor(Math.random() * 900_000);
const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const tx = (name: string) => `${name}${RUN}`;
const key = () => `tap-${nanoid(12)}`;

type Actor = { userId: string; token: string };
const inTenant = <T>(tenantId: string | undefined, fn: () => Promise<T>) => (tenantId ? runWithTenant(tenantId, fn) : runWithoutTenant(fn, 'chain-pay-all-fixture'));
const isolated = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'chain-pay-all-isolation');
async function makeUser(roles: UserRole[], activeRole: UserRole, tenantId?: string): Promise<Actor> {
  seq += 1;
  const user = await inTenant(tenantId, () => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Chain', lastName: `O${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(tenantId ? { tenantId } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `chainpay-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

type Branch = { vendorId: string; subId: string; name: string };
type Owner = Actor & { ownerId: string; branches: Branch[]; tenantId?: string };
type BranchSpec = { status?: SubscriptionStatus; balance?: number; name?: string; dueInDays?: number };

/** An owner with one store per spec (each its own weekly fee of GY$2,100), every clock mapped as the billing cutover maps it. */
async function makeChain(specs: BranchSpec[], opts: { tenantId?: string; stepUp?: boolean } = {}): Promise<Owner> {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER', opts.tenantId);
  const ownerRow = await inTenant(opts.tenantId, () => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const branches: Branch[] = [];
  for (const spec of specs) {
    seq += 1;
    const name = spec.name ?? `Chain Branch ${seq}`;
    const created = await inTenant(opts.tenantId, async () => {
      const vendor = await app.prisma.vendor.create({
        data: {
          ownerId: ownerRow.id, name, slug: `chain-branch-${nanoid(6).toLowerCase()}`,
          vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
          addressLine1: '1 Chain Street', city: 'Georgetown', region: 'Demerara-Mahaica',
          latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
          ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
        },
      });
      vendorIds.push(vendor.id);
      const due = new Date(Date.now() + (spec.dueInDays ?? 3) * DAY);
      const status = spec.status ?? 'ACTIVE';
      const sub = await app.prisma.subscription.create({
        data: {
          vendorId: vendor.id, type: 'RESTAURANT', status, weeklyRate: 2100,
          currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
          ...(status === 'TRIAL' ? { trialEndDate: due } : {}),
          ...(status === 'SUSPENDED' ? { suspendedAt: new Date(Date.now() - DAY), failedAttempts: 3, nextRetryAt: new Date(Date.now() + DAY) } : {}),
          prepaidBalance: { create: { balance: spec.balance ?? 0 } },
        },
      });
      subIds.push(sub.id);
      return { vendorId: vendor.id, subId: sub.id, name };
    });
    await inTenant(opts.tenantId, () => readDunningClock(app.prisma, created.subId));
    branches.push(created);
  }
  if (opts.stepUp !== false) await grantStepUp(app, owner.token);
  return { ...owner, ownerId: ownerRow.id, branches, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) };
}

const headersOf = (actor: Actor, vendorId: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${actor.token}`, 'x-client-platform': 'ios', 'x-vendor-id': vendorId, ...extra,
});
const listOf = (o: Owner, actor: Actor = o) => isolated(() => app.inject({ method: 'GET', url: '/api/v1/vendor/subscription/chain-fees', headers: headersOf(actor, o.branches[0]!.vendorId) }));
type Confirmed = { branches: Array<{ subscriptionId: string; amountGyd: number }>; totalGyd: number };
const payAll = (o: Owner, confirmed: Confirmed, clientKey: string | null = key(), actor: Actor = o) => isolated(() => app.inject({
  method: 'POST', url: '/api/v1/vendor/subscription/chain-fees/mmg-checkout',
  headers: { 'content-type': 'application/json', ...(clientKey ? { 'idempotency-key': clientKey } : {}), ...headersOf(actor, o.branches[0]!.vendorId) },
  payload: confirmed,
}));
const followChain = (o: Owner, ref: string) => isolated(() => app.inject({ method: 'GET', url: `/api/v1/vendor/subscription/chain-fees/mmg-checkout/${ref}`, headers: headersOf(o, o.branches[0]!.vendorId) }));
/** A branch's OWN Pay tap (the single-branch checkout route). */
const payOne = (o: Owner, b: Branch) => isolated(() => app.inject({
  method: 'POST', url: '/api/v1/vendor/subscription/mmg-checkout',
  headers: { 'content-type': 'application/json', 'idempotency-key': key(), ...headersOf(o, b.vendorId) }, payload: {},
}));
const feeScreen = (o: Owner, b: Branch) => isolated(() => app.inject({ method: 'GET', url: '/api/v1/vendor/subscription', headers: headersOf(o, b.vendorId) }));
const ret = (params: unknown) => isolated(() => app.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: { outcome: 'success', params } }));
const replyOf = (row: { merchantTransactionId: string }, code: string, txn?: string) =>
  sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, ...(txn ? { transactionId: txn } : {}), ResultCode: code });

/** The list the owner is shown, as the confirmation the client sends back. */
async function confirmedList(o: Owner): Promise<Confirmed> {
  const res = await listOf(o);
  expect(res.statusCode, res.body).toBe(200);
  const data = res.json().data as { branches: Array<{ subscriptionId: string; state: string; amountGyd: number | null }>; totalGyd: number };
  return {
    branches: data.branches.filter((b) => b.state === 'DUE').map((b) => ({ subscriptionId: b.subscriptionId, amountGyd: b.amountGyd! })),
    totalGyd: data.totalGyd,
  };
}
async function openPayAll(o: Owner) {
  const res = await payAll(o, await confirmedList(o));
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { ref: string; checkoutUrl: string; amountGyd: number };
  return { ...data, row: await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: data.ref } }) };
}
const partsOf = (ref: string) => app.prisma.mmgCheckoutPart.findMany({ where: { checkoutId: ref }, orderBy: { subscriptionId: 'asc' } });
const holdsOf = (subscriptionId: string) => app.prisma.paymentConfirmationHold.findMany({ where: { subscriptionId }, orderBy: { createdAt: 'asc' } });
const approvalIds: string[] = [];
const activeHoldsOf = (subscriptionId: string) => app.prisma.paymentConfirmationHold.findMany({ where: { subscriptionId, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } } });
const walletOf = async (subscriptionId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } })).balance);
const checkoutTopups = (subscriptionId: string) => app.prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP', idempotencyKey: { startsWith: 'mmg-checkout:' } } });
const toldOf = (userId: string, status: string) => app.prisma.notification.findMany({
  where: { userId, AND: [{ data: { path: ['kind'], equals: 'billing_mmg_checkout' } }, { data: { path: ['status'], equals: status } }] },
});

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
  billing = new BillingService(server.prisma, notifications, getPaymentProvider());
  service = new MmgCheckoutService(server.prisma, billing, notifications, { checkout: () => checkoutProvider(), lookup: () => lookup });
  const runtime: MmgCheckoutRuntime = { service, checkout: () => checkoutProvider(), notifications };
  server.decorate(MMG_CHECKOUT_RUNTIME_DECORATION, runtime);
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
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
  process.env['MMG_CHECKOUT_ENABLED'] = '1';
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  zoneBefore = process.env['MMG_CHECKOUT_CREATION_ZONE'];
  process.env['MMG_CHECKOUT_CREATION_ZONE'] = 'GUYANA_WALL_CLOCK';
  resetKeyProviderForTests();
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((res, rej) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? rej(err) : res({ publicKey, privateKey })));
  });
  sandbox = new SandboxMmgCheckoutProvider({ request: pair, result: pair }, 'GUYANA_WALL_CLOCK');
  checkoutProvider = () => sandbox;
  app = await buildApp();
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
}, 120_000);

beforeEach(() => {
  checkoutProvider = () => sandbox;
  resetFeeCheckoutSwitchCache();
  history.reset();
});

afterAll(async () => {
  await isolated(async () => {
    const chainIntents = await app.prisma.mmgCheckoutIntent.findMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { chainOwner: { userId: { in: userIds } } }] }, select: { id: true } });
    const intentIds = chainIntents.map((i) => i.id);
    await app.prisma.privilegedApproval.deleteMany({ where: { id: { in: approvalIds } } });
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.mmgCheckoutPart.deleteMany({ where: { checkoutId: { in: intentIds } } });
    await app.prisma.mmgCheckoutObservation.deleteMany({ where: { OR: [{ intentId: { in: intentIds } }, { intentId: null, createdAt: { gte: startedAt } }] } });
    await app.prisma.mmgCheckoutKey.deleteMany({ where: { intentId: { in: intentIds } } });
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { id: { in: intentIds } } });
    await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
    await app.prisma.platformConfig.deleteMany({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
    const receipts = await app.prisma.feeReceipt.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
    await app.prisma.feeReceiptAllocation.deleteMany({ where: { receiptId: { in: receipts.map((r) => r.id) } } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await purgeFixtureAuditTrail(app.prisma, userIds, 'chain-pay-all');
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

describe('P1 the list: each branch with its own Pay amount, confirmed by the owner first', () => {
  it('lists every branch: due ones at their own Pay amount, a trial and a paid-ahead branch not charged, and the total', async () => {
    const o = await makeChain([
      { balance: 600, name: 'A Branch' }, { status: 'SUSPENDED', name: 'B Branch' }, { status: 'TRIAL', name: 'C Branch' }, { balance: 4200, name: 'D Branch' },
      // E paid the coming week already (its next fee is due in 10 days): it owes the week after, but Swift takes one week ahead at most.
      { dueInDays: 10, name: 'E Branch' },
    ]);
    const res = await listOf(o);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    const byName = Object.fromEntries((data.branches as Array<{ branchName: string; state: string; amountGyd: number | null }>).map((b) => [b.branchName, b]));
    // A owes the coming week less its credit (2,100 - 600); B is suspended and owes the week; C is in its free trial;
    // D holds two weeks already (more than one week ahead is never taken).
    expect(byName['A Branch']).toMatchObject({ state: 'DUE', amountGyd: 1500 });
    expect(byName['B Branch']).toMatchObject({ state: 'DUE', amountGyd: 2100 });
    expect(byName['C Branch']).toMatchObject({ state: 'TRIAL', amountGyd: null });
    expect(byName['D Branch']).toMatchObject({ state: 'NOTHING_DUE', amountGyd: null });
    expect(byName['E Branch']).toMatchObject({ state: 'NOTHING_DUE', amountGyd: null });
    expect((await feeScreen(o, o.branches[4]!)).json().data.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    expect(data).toMatchObject({ totalGyd: 3600, currencyCode: 'GYD', payable: true, recentCheckouts: [] });
    // Each DUE amount is exactly what that branch's own fee screen offers.
    const screenA = (await feeScreen(o, o.branches[0]!)).json().data;
    expect(screenA.payActions[0]).toMatchObject({ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1500 });
  });

  it('owner only, a fresh "confirm it is you", and an Idempotency-Key, before anything is priced or opened', async () => {
    const o = await makeChain([{}, {}], { stepUp: false });
    const confirmed = await confirmedList(o);
    const noStepUp = await payAll(o, confirmed);
    expect(noStepUp.statusCode, noStepUp.body).toBe(403);
    expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');
    await grantStepUp(app, o.token);
    const noKey = await payAll(o, confirmed, null);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    // A manager of the store never pays for the owner's branches.
    const manager = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    await app.prisma.vendorStaff.create({ data: { vendorId: o.branches[0]!.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: o.userId } });
    await grantStepUp(app, manager.token);
    expect((await listOf(o, manager)).statusCode).toBe(403);
    expect((await payAll(o, confirmed, key(), manager)).statusCode).toBe(403);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(0);
  });

  it('a store-review demo owner sees the list but never opens an MMG page', async () => {
    const id = `chainpay-review-${nanoid(6).toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id, slug: id, name: 'Chain pay review fiction', kind: 'REVIEW', isActive: true } });
    tenantIds.push(id);
    await runWithTenant(id, () => app.prisma.reviewSession.create({ data: { tenantId: id, expiresAt: new Date(Date.now() + DAY) } }));
    const o = await makeChain([{}, {}], { tenantId: id });
    const list = await listOf(o);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.payable).toBe(false);
    const refused = await payAll(o, { branches: o.branches.map((b) => ({ subscriptionId: b.subId, amountGyd: 2100 })), totalGyd: 4200 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('PAY_ACTION_OFF');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(0);
  });
});

describe('P2/P3 one checkout for the confirmed list, every branch held', () => {
  it('one MMG page asks for the total; a part per branch; each branch clock held; each branch own Pay is off and refused', async () => {
    const o = await makeChain([{ balance: 600 }, { status: 'SUSPENDED' }, { status: 'TRIAL' }]);
    const [a, b, trial] = o.branches as [Branch, Branch, Branch];
    const { ref, checkoutUrl, amountGyd, row } = await openPayAll(o);
    expect(amountGyd).toBe(3600);
    expect(row).toMatchObject({ subscriptionId: null, chainOwnerId: o.ownerId, status: 'OPEN', createdByUserId: o.userId });
    expect(Number(row.amount)).toBe(3600);
    // What MMG reads from the page is exactly what was written down.
    expect(sandbox.sandboxReadRequest(checkoutUrl)).toMatchObject({ amount: '3600', merchantTransactionId: row.merchantTransactionId, merchantId: SANDBOX_MERCHANT_ID });
    const parts = await partsOf(ref);
    expect(parts.map((p) => [p.subscriptionId, Number(p.amount)]).sort()).toEqual([[a.subId, 1500], [b.subId, 2100]].sort());
    for (const branch of [a, b]) {
      const holds = await activeHoldsOf(branch.subId);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ status: 'ACTIVE', checkoutId: null, checkoutPartId: parts.find((p) => p.subscriptionId === branch.subId)!.id });
      expect((await readFeePaymentDecision(app.prisma, branch.subId)).reason).toBe('PAYMENT_CONFIRMING');
      expect((await feeScreen(o, branch)).json().data.payActions[0]).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
      const own = await payOne(o, branch);
      expect(own.statusCode, own.body).toBe(409);
      expect(own.json().error.code).toBe('PAYMENT_CONFIRMING');
      expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: branch.subId } })).toBe(0);
    }
    // The trial branch was not covered and is not held.
    expect(await activeHoldsOf(trial.subId)).toHaveLength(0);
    // The list now says those branches are being confirmed: nothing is offered twice.
    const after = (await listOf(o)).json().data;
    expect(after.totalGyd).toBe(0);
    expect(after.branches.filter((x: { state: string }) => x.state === 'PAYMENT_CONFIRMING')).toHaveLength(2);
    expect(after.recentCheckouts[0]).toMatchObject({ ref, status: 'OPEN', amountGyd: 3600 });
    // Following it names the branches and shares; another tap with the same key gets the same checkout.
    const followed = await followChain(o, ref);
    expect(followed.json().data.branches.map((x: { amountGyd: number }) => x.amountGyd).sort()).toEqual([1500, 2100]);
  });

  it('the same key, or a second tap while it is open, gets the same checkout back; never a second page', async () => {
    const o = await makeChain([{}, {}]);
    const confirmed = await confirmedList(o);
    const k = key();
    const first = await payAll(o, confirmed, k);
    expect(first.statusCode, first.body).toBe(201);
    const again = await payAll(o, confirmed, k);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.ref).toBe(first.json().data.ref);
    const other = await payAll(o, confirmed);
    expect(other.statusCode).toBe(200);
    expect(other.json().data.ref).toBe(first.json().data.ref);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(1);
    // A key that answered a pay-all never answers a single branch tap.
    const single = await isolated(() => app.inject({
      method: 'POST', url: '/api/v1/vendor/subscription/mmg-checkout',
      headers: { 'content-type': 'application/json', 'idempotency-key': k, ...headersOf(o, o.branches[0]!.vendorId) }, payload: {},
    }));
    expect(single.statusCode).toBe(409);
    expect(single.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([
    ['an amount the owner did not see', (c: Confirmed) => ({ ...c, branches: c.branches.map((b, i) => (i === 0 ? { ...b, amountGyd: b.amountGyd - 1 } : b)) })],
    ['a branch missing from the confirmed list', (c: Confirmed) => ({ branches: c.branches.slice(1), totalGyd: c.totalGyd - c.branches[0]!.amountGyd })],
    ['a branch the owner did not have due', (c: Confirmed) => ({ branches: [...c.branches, { subscriptionId: 'cxnotabranchofyours0000000', amountGyd: 2100 }], totalGyd: c.totalGyd + 2100 })],
    ['a total that is not the sum', (c: Confirmed) => ({ ...c, totalGyd: c.totalGyd + 1 })],
    ['the same branch twice', (c: Confirmed) => ({ branches: [c.branches[0]!, c.branches[0]!], totalGyd: c.branches[0]!.amountGyd * 2 })],
  ])('P2 refuses %s before any page exists (PAYMENT_QUOTE_CHANGED)', async (_label, alter) => {
    const o = await makeChain([{}, {}]);
    const res = await payAll(o, alter(await confirmedList(o)));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_QUOTE_CHANGED');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(0);
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(0);
  });

  it('P2 a branch paid on its own after the list was shown: the stale list is refused, nothing is created, the branch own checkout stands', async () => {
    const o = await makeChain([{}, {}]);
    const confirmed = await confirmedList(o);
    const own = await payOne(o, o.branches[0]!);
    expect(own.statusCode, own.body).toBe(201);
    const res = await payAll(o, confirmed);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_QUOTE_CHANGED');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(0);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: o.branches[0]!.subId, status: 'OPEN' } })).toBe(1);
    // The fresh list offers only the other branch, and paying that works.
    const fresh = await confirmedList(o);
    expect(fresh.branches.map((b) => b.subscriptionId)).toEqual([o.branches[1]!.subId]);
    expect((await payAll(o, fresh)).statusCode).toBe(201);
  });

  it('P2 money credited to a branch meanwhile (its wallet moved): refused before any page', async () => {
    const o = await makeChain([{}, {}]);
    const confirmed = await confirmedList(o);
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: o.branches[1]!.subId }, data: { balance: 100 } });
    const res = await payAll(o, confirmed);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_QUOTE_CHANGED');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(0);
  });

  it('P3 a branch own Pay and the pay-all racing: never both open, never two holds on a branch', async () => {
    for (let round = 0; round < 4; round += 1) {
      const o = await makeChain([{}, {}]);
      const confirmed = await confirmedList(o);
      const [single, all] = await Promise.all([payOne(o, o.branches[0]!), payAll(o, confirmed)]);
      const singleOpen = single.statusCode === 201;
      const allOpen = all.statusCode === 201;
      expect(singleOpen && allOpen, `round ${round}: ${single.statusCode} ${single.body} / ${all.statusCode} ${all.body}`).toBe(false);
      expect(singleOpen || allOpen, `round ${round}: one of them opens`).toBe(true);
      if (!singleOpen) expect(single.json().error.code).toBe('PAYMENT_CONFIRMING');
      if (!allOpen) expect(['PAYMENT_QUOTE_CHANGED', 'PAYMENT_CONFIRMING']).toContain(all.json().error.code);
      for (const b of o.branches) expect((await activeHoldsOf(b.subId)).length).toBeLessThanOrEqual(1);
      const open = await app.prisma.mmgCheckoutIntent.count({ where: { OR: [{ subscriptionId: o.branches[0]!.subId }, { chainOwnerId: o.ownerId }], status: 'OPEN' } });
      expect(open).toBe(1);
    }
  });

  it('P3 two pay-all taps racing with different keys: one checkout', async () => {
    const o = await makeChain([{}, {}]);
    const confirmed = await confirmedList(o);
    const answers = await Promise.all([payAll(o, confirmed), payAll(o, confirmed), payAll(o, confirmed)]);
    const refs = new Set(answers.filter((r) => r.statusCode < 300).map((r) => r.json().data.ref));
    expect(refs.size).toBe(1);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(1);
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(1);
  });
});

describe('P4 credited only after MMG confirms the exact total, then to each branch exactly its share', () => {
  it('one MMG identity, a top-up per branch of exactly its share, a receipt per branch, every hold settled; the suspended branch is restored', async () => {
    const o = await makeChain([{ balance: 600 }, { status: 'SUSPENDED' }]);
    const [a, b] = o.branches as [Branch, Branch];
    const { ref, row } = await openPayAll(o);
    const parts = await partsOf(ref);
    const txn = tx('E1PAY');
    mmgPaid(row, txn, 3600);
    const answer = await ret({ token: replyOf(row, '0', txn) });
    expect(answer.json().data.state).toBe('CONFIRMED');
    const done = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } });
    expect(done).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
    const identity = await app.prisma.providerPayment.findUniqueOrThrow({ where: { id: done.providerPaymentId! } });
    expect(identity).toMatchObject({ status: 'CREDITED', subscriptionId: null, creditedPaymentId: `mco:${ref}` });
    expect(Number(identity.amount)).toBe(3600);
    for (const branch of [a, b]) {
      const part = parts.find((p) => p.subscriptionId === branch.subId)!;
      const topups = await checkoutTopups(branch.subId);
      expect(topups).toHaveLength(1);
      expect(topups[0]!.idempotencyKey).toBe(`mmg-checkout:pp:${identity.id}:${part.id}`);
      expect(Number(topups[0]!.amount)).toBe(Number(part.amount));
      const receipt = await app.prisma.feeReceipt.findUniqueOrThrow({ where: { billingEventId: topups[0]!.id } });
      expect(Number(receipt.amount)).toBe(Number(part.amount));
      expect(receipt.channel).toBe('MMG_CHECKOUT');
      // Its own hold is settled; nothing pauses the branch any more.
      expect(await activeHoldsOf(branch.subId)).toHaveLength(0);
      expect((await holdsOf(branch.subId)).every((h) => h.status === 'PAID')).toBe(true);
    }
    // The suspended branch's week was paid from its own share (and recorded against its receipt); it is restored.
    const restored = await app.prisma.subscription.findUniqueOrThrow({ where: { id: b.subId } });
    expect(restored.status).toBe('ACTIVE');
    const bReceipt = await app.prisma.feeReceipt.findFirstOrThrow({ where: { subscriptionId: b.subId } });
    const weeks = await app.prisma.feeReceiptAllocation.findMany({ where: { receiptId: bReceipt.id, kind: 'WEEK' } });
    expect(weeks.map((w) => Number(w.amount))).toEqual([2100]);
    expect(await walletOf(b.subId)).toBe(0);
    // The owner hears once, for both branches.
    const told = await toldOf(o.userId, 'CONFIRMED');
    expect(told).toHaveLength(1);
    expect(told[0]!.data).toMatchObject({ ref, chainCheckout: true });
    // MMG repeating itself, or the poll, credits nothing more.
    await ret({ token: replyOf(row, '0', txn) });
    await service.pollIntents();
    for (const branch of [a, b]) expect(await checkoutTopups(branch.subId)).toHaveLength(1);
    expect(await app.prisma.providerPayment.count({ where: { creditedPaymentId: `mco:${ref}` } })).toBe(2); // the transaction and its ledger number
  });

  it('a lookup for a different amount is held for a person: nothing is credited, every branch stays paused', async () => {
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    const txn = tx('E1SHORT');
    mmgPaid(row, txn, 2100); // one branch's worth, not the total MMG was asked for
    const answer = await ret({ token: replyOf(row, '0', txn) });
    expect(answer.json().data.state).toBe('CONFIRMING');
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } }))).toMatchObject({ status: 'HELD', reason: 'AMOUNT_MISMATCH' });
    for (const b of o.branches) {
      expect(await checkoutTopups(b.subId)).toHaveLength(0);
      const holds = await activeHoldsOf(b.subId);
      // Still paused, by the same hold its share took when the page opened (as a single checkout's hold stays).
      expect(holds).toHaveLength(1);
      expect(holds[0]!.status).toBe('ACTIVE');
      expect((await payOne(o, b)).json().error.code).toBe('PAYMENT_CONFIRMING');
    }
    expect(await app.prisma.providerPayment.count({ where: { providerTxnId: txn.toUpperCase() } })).toBe(0);
    expect(await toldOf(o.userId, 'HELD')).toHaveLength(1);
    // The finance queue shows each branch's share of the held payment, with the checkout's Swift reference.
    const tenantId = (await activeHoldsOf(o.branches[0]!.subId))[0]!.tenantId;
    const queue = await runWithTenant(tenantId, () => confirmationReviewQueue(app.prisma, tenantId));
    const mine = queue.filter((q) => o.branches.some((b) => b.subId === q.subscriptionId));
    expect(mine).toHaveLength(2);
    expect(mine.every((q) => q.source === 'MMG_CHAIN_CHECKOUT' && q.swiftReference === row.merchantTransactionId)).toBe(true);
  });

  it('a branch own share is never proven PAID by hand on its own: only the checkout verified credit settles it', async () => {
    const o = await makeChain([{}, {}]);
    const { row } = await openPayAll(o);
    mmgPaid(row, tx('E1HAND'), 2100);
    await ret({ token: replyOf(row, '0', tx('E1HAND')) });
    const hold = (await activeHoldsOf(o.branches[0]!.subId))[0]!;
    const clock = await readDunningClock(app.prisma, o.branches[0]!.subId);
    await expect(resolveFinanceConfirmation(app.prisma, {
      id: hold.id, tenantId: hold.tenantId, actorId: 'finance-test', sourceId: hold.checkoutPartId!, epoch: hold.sourceEpoch,
      clockVersion: clock.version, decision: 'PAID', evidenceReference: 'statement says paid',
    }, async () => {})).rejects.toMatchObject({ code: 'SETTLEMENT_EVIDENCE_REQUIRED' });
  });
});

describe('P5 not paid, expired and late answers: as a single checkout, for every branch at once', () => {
  it('MMG answers not paid: released for every branch; each branch own Pay works again', async () => {
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    const answer = await ret({ token: replyOf(row, '2') });
    expect(answer.json().data.state).toBe('NOT_PAID');
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('NOT_PAID');
    for (const b of o.branches) {
      expect(await activeHoldsOf(b.subId)).toHaveLength(0);
      expect((await holdsOf(b.subId))[0]!.status).toBe('PROVEN_UNPAID');
    }
    expect(await toldOf(o.userId, 'NOT_PAID')).toHaveLength(1);
    expect((await payOne(o, o.branches[0]!)).statusCode).toBe(201);
  });

  it('expired with no answer: stays a confirmation for every branch; a person who confirms it was not paid releases them all at once', async () => {
    const o = await makeChain([{}, {}]);
    const { ref } = await openPayAll(o);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await service.pollIntents();
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('EXPIRED');
    for (const b of o.branches) {
      expect(await activeHoldsOf(b.subId)).toHaveLength(1);
      expect((await payOne(o, b)).json().error.code).toBe('PAYMENT_CONFIRMING');
    }
    // A new pay-all is refused too (the branches are being confirmed): never a second page.
    const again = await payAll(o, { branches: o.branches.map((b) => ({ subscriptionId: b.subId, amountGyd: 2100 })), totalGyd: 4200 });
    expect(again.statusCode).toBe(409);
    const hold = (await activeHoldsOf(o.branches[1]!.subId))[0]!;
    const clock = await readDunningClock(app.prisma, o.branches[1]!.subId);
    await resolveFinanceConfirmation(app.prisma, {
      id: hold.id, tenantId: hold.tenantId, actorId: 'finance-test', sourceId: hold.checkoutPartId!, epoch: hold.sourceEpoch,
      clockVersion: clock.version, decision: 'UNPAID', evidenceReference: 'statement checked',
    }, async () => {});
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('NOT_PAID');
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(0);
    expect((await confirmedList(o)).totalGyd).toBe(4200);
  });

  it('a late MMG confirmation after a release still credits every branch (each branch own verified correction)', async () => {
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    await ret({ token: replyOf(row, '2') });
    for (const b of o.branches) expect((await holdsOf(b.subId))[0]!.status).toBe('PROVEN_UNPAID');
    // The race this models: a verifier that read MMG's confirmation credits after a not-paid answer released the
    // branches (the credit path is the same one a confirming checkout takes).
    const txn = tx('E1LATE');
    mmgPaid(row, txn, 4200);
    const current = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } });
    const confirm = (service as unknown as { confirm: (i: unknown, t: string, l: string, n: Date) => Promise<string> }).confirm.bind(service);
    expect(await confirm(current, txn, ledgerOf(txn), new Date())).toBe('CONFIRMED');
    for (const b of o.branches) {
      expect(await checkoutTopups(b.subId)).toHaveLength(1);
      const hold = (await holdsOf(b.subId))[0]!;
      const history = hold.resolutionHistory as Array<{ status: string }>;
      expect(history.some((h) => h.status === 'VERIFIED_POSITIVE_CORRECTION')).toBe(true);
    }
  });
});

describe('[REVIEW-M #2224 S3-1] an abandoned pay-all is closed by MMG\'s own records, for every branch at once', () => {
  const MIN = 60_000;
  /** A confirmed pay-all of another owner: the control that proves MMG's history is read whole. */
  async function control() {
    const other = await makeChain([{}]);
    const { row } = await openPayAll(other);
    const txn = tx(`E1CTRL${nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`);
    mmgPaid(row, txn, Number(row.amount));
    expect((await ret({ token: replyOf(row, '0', txn) })).json().data.state).toBe('CONFIRMED');
  }
  const after = (row: { expiresAt: Date }, ms: number) => new Date(row.expiresAt.getTime() + ms);

  it('MMG shows no payment: closed as not paid by the system, every branch released and able to pay again, one audit naming every hold', async () => {
    await control();
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    await service.pollIntents(after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS - 5 * MIN));
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('EXPIRED');
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(1);
    await service.pollIntents(after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
    expect(await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_HISTORY_CONFIRMED_UNPAID' });
    const holds = await app.prisma.paymentConfirmationHold.findMany({ where: { checkoutPart: { is: { checkoutId: ref } } } });
    expect(holds).toHaveLength(2);
    expect(holds.every((h) => h.status === 'PROVEN_UNPAID' && h.resolvedBy === NO_REPLY_CHECK_ACTOR)).toBe(true);
    const audit = await app.prisma.auditLog.findFirstOrThrow({ where: { action: NO_REPLY_CLOSE_AUDIT, entityId: { in: holds.map((h) => h.id) } } });
    expect(((audit.changes as Record<string, unknown>)['coveredHolds'] as unknown[]).length).toBe(2);
    expect((await payOne(o, o.branches[0]!)).statusCode).toBe(201);
  });

  it('an MMG payment on ANY covered branch since the page opened leaves it to the admins', async () => {
    await control();
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    await app.prisma.providerPayment.create({ data: {
      tenantId: row.tenantId, provider: 'MMG', providerTxnId: tx('E1OTHERBRANCH'), status: 'OPEN', amount: 2100, currencyCode: 'GYD', subscriptionId: o.branches[1]!.subId,
    } });
    await service.pollIntents(after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('EXPIRED');
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(1);
  });

  // [REVIEW-G #2224 H2] A second-admin request on ANY branch's hold (not only the first one found) leaves the whole
  // pay-all to the admins: tried on each branch's hold in turn, the checkout is never closed while one is waiting.
  it('a second-admin request on any one branch\'s hold leaves the whole pay-all to the admins', async () => {
    await control();
    for (const pick of [0, 1, 2]) {
      const o = await makeChain([{}, {}, {}]);
      const { ref, row } = await openPayAll(o);
      const hold = (await activeHoldsOf(o.branches[pick]!.subId))[0]!;
      const approval = await app.prisma.privilegedApproval.create({ data: {
        tenantId: row.tenantId, action: CONFIRMATION_RESOLVE_ACTION, cls: 'C4', capability: 'billing.payment.attach', entityId: hold.id, fingerprint: `fp-${RUN}-${pick}`,
        bodySnapshot: { params: { id: hold.id }, body: { decision: 'PAID', sourceId: ref }, query: {} },
        status: 'PENDING', requestedBy: 'admin-fixture', reason: 'Partner sent an MMG receipt; checking it against the statement.',
        expiresAt: new Date(after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS).getTime() + 3 * 86_400_000),
      } });
      approvalIds.push(approval.id);
      await service.pollIntents(after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
      expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status, `request on branch ${pick}`).toBe('EXPIRED');
      for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(1);
    }
  });

  // [REVIEW-G #2224 H7] The close re-reads EVERY covered hold under the locks: one that is no longer ACTIVE (here a
  // settlement being applied on one branch) stops the close for all of them (nothing is released for any branch).
  it('a covered hold no longer active stops the close for every branch', async () => {
    await control();
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    const hold = (await activeHoldsOf(o.branches[1]!.subId))[0]!;
    await app.prisma.paymentConfirmationHold.update({ where: { id: hold.id }, data: { status: 'SETTLEMENT_APPLY_PENDING', reason: 'SETTLEMENT_APPLY_PENDING' } });
    await service.pollIntents(after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('EXPIRED');
    const holds = await app.prisma.paymentConfirmationHold.findMany({ where: { checkoutPart: { is: { checkoutId: ref } } } });
    expect(holds.some((h) => h.status === 'PROVEN_UNPAID')).toBe(false);
  });

  it('a record naming it after the close puts it back in front of a person: every branch paused again, nothing credited', async () => {
    await control();
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    const closedAt = after(row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN);
    await service.pollIntents(closedAt);
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('NOT_PAID');
    history.holds(tx('E1AFTERCLOSE'), Number(row.amount), { external_id: row.merchantTransactionId, modificationDate: mmgTimeOf(new Date(closedAt.getTime() + 10 * MIN)) });
    await service.pollIntents(new Date(closedAt.getTime() + 31 * MIN));
    expect(await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).toMatchObject({ status: 'HELD', reason: 'LATE_PAYMENT_LIKELY_AFTER_AUTO_CLOSE', providerPaymentId: null });
    for (const b of o.branches) {
      const holds = await activeHoldsOf(b.subId);
      expect(holds).toHaveLength(1);
      expect(holds[0]!.reason).toBe('LATE_POSITIVE_REVIEW');
      expect(await checkoutTopups(b.subId)).toHaveLength(0);
    }
  });
});

describe('[REVIEW-G #2224 S4-1] every outcome reaches every branch', () => {
  it('MMG\'s lookup declines the payment it answered for: not paid, every branch released', async () => {
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    const txn = tx('E1DECLINED');
    lookups.set(txn, { ...lookupDetailFrom({ ...uatAnswer(txn, Number(row.amount)), transactionStatus: 'failed' }, txn), echoedReferences: [row.merchantTransactionId] } as MmgLookupDetail);
    expect((await ret({ token: replyOf(row, '0', txn) })).json().data.state).toBe('NOT_PAID');
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('NOT_PAID');
    for (const b of o.branches) {
      expect(await activeHoldsOf(b.subId)).toHaveLength(0);
      expect((await holdsOf(b.subId))[0]!.status).toBe('PROVEN_UNPAID');
    }
  });

  it('a paid-looking MMG record after a not-paid answer is held for a person: EVERY branch paused again', async () => {
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    const txn = tx('E1LATEPAID');
    expect((await ret({ token: replyOf(row, '2', txn) })).json().data.state).toBe('NOT_PAID');
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(0);
    mmgPaid(row, txn, Number(row.amount));
    await service.pollIntents(new Date(Date.now() + 7 * 3_600_000));
    expect((await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } })).status).toBe('HELD');
    for (const b of o.branches) {
      const holds = await activeHoldsOf(b.subId);
      expect(holds).toHaveLength(1);
      expect(holds[0]!.reason).toBe('LATE_POSITIVE_REVIEW');
      expect(await checkoutTopups(b.subId)).toHaveLength(0);
    }
  });

  it('another owner\'s pay-all is not found (404), and neither is a single checkout ref', async () => {
    const a = await makeChain([{}, {}]);
    const b = await makeChain([{}, {}]);
    const { ref } = await openPayAll(a);
    const res = await followChain(b, ref);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CHECKOUT_NOT_FOUND');
    const single = await payOne(b, b.branches[0]!);
    expect((await followChain(b, single.json().data.ref)).statusCode).toBe(404);
  });
});

describe('[REVIEW-M #2224 S4-2] an open pay-all is handed back only for the list it was opened for', () => {
  it('a tap from a stale list is shown the list again (409, naming the open checkout), never sent to pay another list', async () => {
    const o = await makeChain([{}, {}]);
    const { ref } = await openPayAll(o);
    const stale = { branches: [{ subscriptionId: o.branches[0]!.subId, amountGyd: 2100 }], totalGyd: 2100 };
    const res = await payAll(o, stale);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'PAYMENT_QUOTE_CHANGED', details: { ref } });
  });
});

describe('support and account deletion see a pay-all checkout', () => {
  it('support finds it by the owner phone and names the branches it paid (it pays no single subscription)', async () => {
    const o = await makeChain([{ name: 'North Branch' }, { name: 'South Branch' }]);
    const { ref, row } = await openPayAll(o);
    const phone = (await app.prisma.user.findUniqueOrThrow({ where: { id: o.userId }, select: { phone: true } })).phone;
    const found = await runWithTenant(row.tenantId, () => searchMmgCheckouts(app.prisma, { tenantId: row.tenantId, q: phone, limit: 20 }));
    const mine = found.data.find((r) => r.id === ref);
    expect(mine).toBeDefined();
    expect(mine!.matchedBy).toContain('PARTNER_PHONE');
    expect(mine!.partner).toMatchObject({ kind: 'VENDOR', subscriptionId: null, displayName: 'All branches (2): North Branch, South Branch' });
    expect(mine!.partner.maskedPhone).not.toBe(phone);
  });

  it('a pay-all checkout MMG answered not paid still blocks deleting the account while a late MMG answer may come', async () => {
    const o = await makeChain([{}, {}]);
    const { row } = await openPayAll(o);
    await ret({ token: replyOf(row, '2') });
    for (const b of o.branches) expect(await activeHoldsOf(b.subId)).toHaveLength(0);
    const obligations = await app.prisma.$transaction((t) => partnerObligations(t, o.userId));
    expect(obligations.pendingFeePaymentCount).toBe(1);
  });
});

describe('the database refuses a malformed chain checkout', () => {
  async function chainRow(o: Owner, amount: number) {
    const donor = await openPayAll(await makeChain([{}]));
    return {
      tenantId: donor.row.tenantId, subscriptionId: null, chainOwnerId: o.ownerId, merchantTransactionId: newMerchantTransactionId(),
      amount, currencyCode: 'GYD', createdByUserId: o.userId, platform: 'ios',
      checkoutUrlSealed: donor.row.checkoutUrlSealed, checkoutUrlDek: donor.row.checkoutUrlDek,
      expiresAt: new Date(Date.now() + MMG_CHECKOUT_TTL_MS),
    };
  }

  it('parts that do not add up to the amount, no parts at all, or a branch of another owner are refused at commit', async () => {
    const o = await makeChain([{}, {}]);
    const stranger = await makeChain([{}]);
    const data = await chainRow(o, 4200);
    await expect(app.prisma.$transaction(async (t) => {
      const intent = await t.mmgCheckoutIntent.create({ data });
      await t.mmgCheckoutPart.create({ data: { tenantId: intent.tenantId, checkoutId: intent.id, subscriptionId: o.branches[0]!.subId, amount: 2100, currencyCode: 'GYD' } });
    })).rejects.toThrow(/add up/);
    await expect(app.prisma.$transaction(async (t) => { await t.mmgCheckoutIntent.create({ data: { ...data, merchantTransactionId: newMerchantTransactionId() } }); })).rejects.toThrow(/add up/);
    await expect(app.prisma.$transaction(async (t) => {
      const intent = await t.mmgCheckoutIntent.create({ data: { ...data, amount: 2100, merchantTransactionId: newMerchantTransactionId() } });
      await t.mmgCheckoutPart.create({ data: { tenantId: intent.tenantId, checkoutId: intent.id, subscriptionId: stranger.branches[0]!.subId, amount: 2100, currencyCode: 'GYD' } });
    })).rejects.toThrow(/own branches/);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { chainOwnerId: o.ownerId } })).toBe(0);
  });

  it('a checkout naming both a subscription and an owner, a changed part, or a single-checkout hold on a chain checkout are refused', async () => {
    const o = await makeChain([{}, {}]);
    const data = await chainRow(o, 4200);
    await expect(app.prisma.mmgCheckoutIntent.create({ data: { ...data, subscriptionId: o.branches[0]!.subId } })).rejects.toThrow();
    const { ref } = await openPayAll(o);
    const part = (await partsOf(ref))[0]!;
    await expect(app.prisma.mmgCheckoutPart.update({ where: { id: part.id }, data: { amount: 1 } })).rejects.toThrow(/immutable/);
    const clock = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: part.subscriptionId } });
    await expect(app.prisma.paymentConfirmationHold.create({ data: {
      tenantId: clock.tenantId, subscriptionId: part.subscriptionId, clockId: clock.id, sourceEpoch: clock.epoch, checkoutId: ref,
      reason: 'TEST', beganAt: new Date(), reviewDueAt: new Date(Date.now() + DAY),
    } })).rejects.toThrow();
  });

  it('the coverage census counts a covered branch whose hold is missing', async () => {
    const census = async () => Number((await app.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT billing_confirmation_missing_coverage() AS n`)[0]!.n);
    const o = await makeChain([{}, {}]);
    const before = await census();
    const { ref } = await openPayAll(o);
    expect(await census()).toBe(before);
    const part = (await partsOf(ref))[0]!;
    await app.prisma.paymentConfirmationHold.deleteMany({ where: { checkoutPartId: part.id } });
    expect(await census()).toBe(before + 1);
    // The repair path finds it again (every read of the clock discovers unresolved sources).
    await readDunningClock(app.prisma, part.subscriptionId);
    expect(await census()).toBe(before);
  });

  it('a chain payment is never returned through the MMG reversal tool', async () => {
    const o = await makeChain([{}, {}]);
    const { ref, row } = await openPayAll(o);
    mmgPaid(row, tx('E1REV'), 4200);
    await ret({ token: replyOf(row, '0', tx('E1REV')) });
    const intent = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } });
    expect(intent.status).toBe('CONFIRMED');
    expect(await app.prisma.$transaction((t) => reversalEligibilityInTx(t, intent, 4200, new Date()))).toEqual({ ok: false, code: 'CHAIN_CHECKOUT' });
  });
});
