import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { MmgFeeReversalService, MMG_FEE_REVERSAL_SWITCH } from '../modules/billing/mmg-fee-reversal';
import { readFeePaymentDecision } from '../modules/billing/fee-payment-authority';
import { hasConfirmationInTx } from '../modules/billing/dunning-clock';
import { runBillingInvariants } from '../modules/billing/invariants';
import { partnerObligations } from '../modules/user/partner-wind-down';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { ensureLedgerAccounts } from '../modules/billing/ledger';
import { getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type SandboxCheckoutKeys } from '../providers/mmg/mmg-checkout';
import {
  SandboxMmgProvider, lookupDetailFrom, sandboxAddHistory, sandboxResetMmg, sandboxScriptReversal, sandboxSetTxStatus,
  type MmgLookupClient, type MmgLookupDetail, type MmgReversalClient,
} from '../providers/mmg/mmg-provider';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [MMG REVERSAL · owner decision #11, 13 Oct] Return a WHOLE weekly-fee
// payment to the partner's MMG account.
//
// Only a payment Swift credited on MMG's own proof; only the whole amount;
// only while the fee balance still holds it. A durable claim before MMG is
// asked; MMG asked once; only MMG's LOOKUP decides; the fee balance debited
// exactly once, on that proof; anything unclear is HELD for a person — never
// a silent drop, never a guess. The payments here are real checkouts, credited
// through the real checkout service on a scripted MMG lookup (as in
// mmg-checkout-service.test.ts); the reversal talks to the MMG sandbox.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const FEE = 2100;
let app: FastifyInstance;
let billing: BillingService;
let notifications: NotificationService;
let checkoutService: MmgCheckoutService;
let reversals: MmgFeeReversalService;
let keys: SandboxCheckoutKeys;
let sandbox: SandboxMmgCheckoutProvider;
let kekBefore: string | undefined;
let switchBefore: string | undefined;
let admin: { token: string; userId: string };

/** MMG's lookup as the checkout verifier reads it (scripted per transaction, UAT shape). */
const lookups = new Map<string, MmgLookupDetail>();
const checkoutLookup: MmgLookupClient = { transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' } };
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
const uatAnswer = (txn: string, amountGyd: number): Record<string, unknown> => ({
  transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
  subType: 'subscriber_mpay', transactionReference: `L${txn}`,
  creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'description', value: '' }],
});

/** The reversal's MMG: the sandbox (stateful per transaction), counted. */
const reversalCalls: string[] = [];
const mmg = new SandboxMmgProvider();
const reversalClient: MmgReversalClient = {
  reverseTransaction: async (req) => { reversalCalls.push(req.transactionId); return mmg.reverseTransaction(req); },
  transactionLookupDetail: (id) => mmg.transactionLookupDetail(id),
};

const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_647_000_000 + Math.floor(Math.random() * 900_000);
const REASON = 'Partner paid this week twice by mistake; returning the second payment';

async function makeSub(opts: { balance?: number; due?: Date } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Rev', lastName: `P${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Reversal Store ${seq}`, slug: `reversal-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+${phoneBase + 5000 + seq}`, addressLine1: '1 Reversal Street', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
  } });
  vendorIds.push(vendor.id);
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: FEE, billingMethod: 'CASH',
    currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    prepaidBalance: { create: { balance: opts.balance ?? 0 } },
  } });
  subIds.push(sub.id);
  return { userId: user.id, subId: sub.id };
}

/** A weekly-fee payment Swift credited on MMG's proof: a real checkout, confirmed. */
async function paidCheckout(opts: { due?: Date } = {}) {
  const s = await makeSub(opts);
  const { checkout } = await checkoutService.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'ios', clientKey: `rev-${nanoid(12)}` });
  const row = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: checkout.ref } });
  const txn = `RV${seq}${RUN}`;
  const amount = Number(row.amount);
  lookups.set(txn, lookupDetailFrom(uatAnswer(txn, amount), txn));
  const token = sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0', secretKey: 'x' });
  expect(await checkoutService.observeReply({ source: 'RETURN', outcome: 'success', params: { token } })).toBe('CONFIRMED');
  // MMG's merchant API knows the transaction too (the reversal's lookup).
  sandboxAddHistory({ transactionId: txn, status: 'approved', amountMinor: amount * 100, currencyCode: 'GYD' });
  return { ...s, checkoutId: row.id, txn, amount };
}

/** What MMG's merchant API says about a transaction now (the sandbox the route also talks to). */
const mmgSays = async (txn: string) => { const d = await mmg.transactionLookupDetail(txn); return d.outcome === 'found' ? d.status : d.outcome; };
const walletOf = async (subId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance);
const reversalEvents = (subId: string) => app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: 'PREPAID_REVERSAL' } });
const rowsFor = (checkoutId: string) => app.prisma.mmgFeeReversal.findMany({ where: { checkoutId }, orderBy: { createdAt: 'asc' } });
const ask = (checkoutId: string, amountGyd: number) => runWithTenant('swift-default', () =>
  reversals.requestReversal({ tenantId: 'swift-default', checkoutId, amountGyd, reason: REASON, actorId: admin.userId, approvalId: null }, async () => {}));
/** Wallet provability for one payer [billing invariant 1] and its ledger subledger [invariant 6]. */
async function booksBalance(subId: string) {
  const [topups, settles, reversed, ledger] = await Promise.all([
    app.prisma.billingEvent.aggregate({ where: { subscriptionId: subId, type: 'PREPAID_TOPUP' }, _sum: { amount: true } }),
    app.prisma.subscriptionPayment.aggregate({ where: { subscriptionId: subId, status: 'CAPTURED', externalRef: 'prepaid' }, _sum: { amount: true } }),
    app.prisma.billingEvent.aggregate({ where: { subscriptionId: subId, type: 'PREPAID_REVERSAL' }, _sum: { amount: true } }),
    app.prisma.ledgerEntry.aggregate({ where: { accountCode: 'WALLET_LIABILITY', subledgerId: subId }, _sum: { credit: true, debit: true } }),
  ]);
  return {
    events: Number(topups._sum.amount ?? 0) - Number(settles._sum.amount ?? 0) - Number(reversed._sum.amount ?? 0),
    ledger: Number(ledger._sum.credit ?? 0) - Number(ledger._sum.debit ?? 0),
    wallet: await walletOf(subId),
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  delete process.env['MMG_DRIVER'];
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  switchBefore = process.env[MMG_FEE_REVERSAL_SWITCH];
  process.env[MMG_FEE_REVERSAL_SWITCH] = 'on';
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
  });
  keys = { request: pair, result: pair };
  sandbox = new SandboxMmgCheckoutProvider(keys, 'GUYANA_WALL_CLOCK');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await ensureLedgerAccounts(app.prisma);
  notifications = new NotificationService(app.prisma, app.io);
  billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  checkoutService = new MmgCheckoutService(app.prisma, billing, notifications, { checkout: () => sandbox, lookup: () => checkoutLookup, reversal: () => reversalClient });
  reversals = new MmgFeeReversalService({ prisma: app.prisma, billing, notifications, client: () => reversalClient });
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
  void getKeyProvider;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + 9000}`, firstName: 'Finance', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'mmg-reversal', deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  admin = { token, userId: user.id };
}, 120_000);

beforeEach(() => {
  reversalCalls.length = 0;
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.mmgFeeReversal.deleteMany({ where: { subscriptionId: { in: subIds } } });
    const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
    await app.prisma.mmgCheckoutObservation.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
    await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.mmgAgentPayment.deleteMany({ where: { mmgTxnId: { endsWith: RUN } } }).catch(() => {});
    await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionRefund.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: admin.userId } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:mmg-fee-reversal').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }, 'test-cleanup:mmg-fee-reversal');
  sandboxResetMmg();
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = kekBefore;
  if (switchBefore === undefined) delete process.env[MMG_FEE_REVERSAL_SWITCH]; else process.env[MMG_FEE_REVERSAL_SWITCH] = switchBefore;
  resetKeyProviderForTests();
});

const reverseRoute = (checkoutId: string, body: Record<string, unknown>) => ({
  method: 'POST' as const,
  url: `/api/v1/admin/billing/mmg-checkouts/${checkoutId}/reverse`,
  headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  payload: { ...body, reason: REASON },
});

describe('[MMG REVERSAL] the admin action: two people, then MMG, then MMG\'s proof', () => {
  it('needs a second person first: the ask alone changes nothing and asks MMG nothing', async () => {
    const p = await paidCheckout();
    const res = await app.inject(reverseRoute(p.checkoutId, { amountGyd: p.amount }));
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().error.code).toBe('APPROVAL_REQUIRED');
    expect(await mmgSays(p.txn), 'MMG was not asked').toBe('approved');
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
    expect(await walletOf(p.subId)).toBe(p.amount);
  });

  it('approved: MMG reverses, its lookup proves it, the fee balance is debited ONCE, books balance, the partner is told', async () => {
    const p = await paidCheckout();
    expect(await walletOf(p.subId)).toBe(p.amount);
    const res = await injectWithApproval(app, reverseRoute(p.checkoutId, { amountGyd: p.amount }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.state).toBe('REVERSED');

    const [row] = await rowsFor(p.checkoutId);
    expect(row).toMatchObject({ state: 'REVERSED', mmgTransactionId: p.txn, lookupStatus: 'ORIGINAL_REVERSED' });
    expect(row!.approvalId).toBeTruthy();
    expect(row!.walletDebitedAt).toBeTruthy();
    expect(await walletOf(p.subId)).toBe(0);
    const events = await reversalEvents(p.subId);
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.amount)).toBe(p.amount);
    expect(events[0]!.id).toBe(row!.billingEventId);
    // The reversing posting: the wallet owes less, MMG clearing holds less.
    const posting = await app.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `ledger:mmg-reversal:${row!.id}` }, include: { entries: true } });
    expect(posting.entries.map((e) => [e.accountCode, Number(e.debit), Number(e.credit)]).sort()).toEqual([
      ['CLEARING_MMG', 0, p.amount], ['WALLET_LIABILITY', p.amount, 0],
    ]);
    expect(await booksBalance(p.subId)).toEqual({ events: 0, ledger: 0, wallet: 0 });
    // The nightly invariants agree: the wallet is provable from its events, and equals its ledger subledger.
    const report = await runBillingInvariants(app.prisma);
    expect(report.walletMismatches.filter((m) => m.subscriptionId === p.subId)).toEqual([]);
    expect(report.ledgerWalletMismatches.filter((m) => m.subscriptionId === p.subId)).toEqual([]);
    // Billing is free again once the return is settled.
    expect(await app.prisma.$transaction((tx) => hasConfirmationInTx(tx, p.subId, new Date()))).toBe(false);
    // The MMG transaction stays CREDITED: it can never be credited again.
    expect((await app.prisma.providerPayment.findMany({ where: { creditedPaymentId: `mco:${p.checkoutId}` } })).every((r) => r.status === 'CREDITED')).toBe(true);
    // The audit row of the approved act names the reversal.
    const audit = await app.prisma.auditLog.findFirst({ where: { action: { contains: '/reverse' }, changes: { path: ['reversalId'], equals: row!.id } } });
    expect(audit).toBeTruthy();
    // The partner, in plain words.
    const told = await app.prisma.notification.findMany({ where: { userId: p.userId, data: { path: ['status'], equals: 'REVERSED' } } });
    expect(told).toHaveLength(1);
    // [review S4] MMG returns the money to the account that paid, which may not be the partner's own.
    expect(told[0]!.body).toMatch(/^Your payment of .*2,?100.* on .+ was returned to the MMG account it was paid from\.$/);
    expect(await mmgSays(p.txn)).toBe('reversed');

    // A second ask is refused before anything is claimed or sent.
    const again = await injectWithApproval(app, reverseRoute(p.checkoutId, { amountGyd: p.amount }));
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REVERSED');
    expect(await rowsFor(p.checkoutId)).toHaveLength(1);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('the whole amount only: a different amount is refused (MMG reverses in full)', async () => {
    const p = await paidCheckout();
    const res = await injectWithApproval(app, reverseRoute(p.checkoutId, { amountGyd: p.amount - 100 }));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('AMOUNT_MISMATCH');
    expect(await mmgSays(p.txn)).toBe('approved');
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
  });

  it('switched off (the default until the owner\'s UAT run): refused, nothing written, MMG not asked', async () => {
    const p = await paidCheckout();
    delete process.env[MMG_FEE_REVERSAL_SWITCH];
    try {
      const res = await injectWithApproval(app, reverseRoute(p.checkoutId, { amountGyd: p.amount }));
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error.code).toBe('REVERSAL_OFF');
    } finally {
      process.env[MMG_FEE_REVERSAL_SWITCH] = 'on';
    }
    expect(await mmgSays(p.txn)).toBe('approved');
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
  });

  it('MMG fully off on this server (MMG_DRIVER=disabled): refused before any claim, MMG not asked, the page offers no return', async () => {
    const p = await paidCheckout();
    const driverBefore = process.env['MMG_DRIVER'];
    process.env['MMG_DRIVER'] = 'disabled';
    try {
      await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({ code: 'MMG_DISABLED' });
      const page = await app.inject({ method: 'GET', url: `/api/v1/admin/billing/mmg-checkouts/${p.checkoutId}/reversal`, headers: { authorization: `Bearer ${admin.token}` } });
      expect(page.statusCode, page.body).toBe(200);
      expect(page.json().data).toMatchObject({ switchedOn: false });
    } finally {
      if (driverBefore === undefined) delete process.env['MMG_DRIVER']; else process.env['MMG_DRIVER'] = driverBefore;
    }
    expect(reversalCalls).toEqual([]);
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
    expect(await mmgSays(p.txn)).toBe('approved');
  });

  it('the reversal client under MMG_DRIVER=disabled refuses explicitly (never a sandbox answer, never an unknown-driver crash)', async () => {
    const { getMmgReversalClient } = await import('../providers/mmg/mmg-provider');
    const off = getMmgReversalClient({ MMG_DRIVER: 'disabled', NODE_ENV: 'production' });
    await expect(off.reverseTransaction({ transactionId: 'T1' })).rejects.toMatchObject({ code: 'MMG_DISABLED' });
    await expect(off.transactionLookupDetail('T1')).rejects.toMatchObject({ code: 'MMG_DISABLED' });
  });

  it('the payment page shows whether it can be returned, and why not', async () => {
    const p = await paidCheckout();
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/billing/mmg-checkouts/${p.checkoutId}/reversal`, headers: { authorization: `Bearer ${admin.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ checkoutId: p.checkoutId, amountGyd: p.amount, canReverse: true, switchedOn: true, reversals: [] });
  });
});

describe('[MMG REVERSAL] only a payment Swift credited on MMG\'s proof, whole and unspent', () => {
  it('a payment that is not confirmed is refused', async () => {
    const s = await makeSub();
    const { checkout } = await checkoutService.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'ios', clientKey: `rev-${nanoid(12)}` });
    await expect(ask(checkout.ref, FEE)).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
    expect(reversalCalls).toEqual([]);
  });

  it('a PROVIDER_ID_CONFLICT on the same MMG transaction (any spelling): never reversed — no claim, no call', async () => {
    const p = await paidCheckout();
    await app.prisma.mmgAgentPayment.create({ data: {
      // a different spelling of the same MMG number: the conflict is found canonically
      channel: 'MMG_AGENT_WEBHOOK', externalId: `conflict-${p.txn}`, mmgTxnId: ` ${p.txn.toLowerCase()} `, sanRaw: 'conflict', amount: p.amount,
      currencyCode: 'GYD', paidAt: new Date(), status: 'UNMATCHED', failureCode: 'PROVIDER_ID_CONFLICT', raw: {},
    } });
    await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({
      code: 'IDENTITY_CONFLICT', message: "This payment is under an MMG reference check — it can't be reversed; escalate with the MMG statement line.",
    });
    expect(reversalCalls).toEqual([]);
    expect(await rowsFor(p.checkoutId), 'no claim row').toHaveLength(0);
    expect(await walletOf(p.subId)).toBe(p.amount);
    // and the payment page says so before anyone asks
    const view = await runWithTenant('swift-default', () => reversals.view({ tenantId: 'swift-default', checkoutId: p.checkoutId }));
    expect(view).toMatchObject({ canReverse: false, refusal: { code: 'IDENTITY_CONFLICT' } });
  });

  it('another checkout naming the same MMG number: never reversed — no claim, no call', async () => {
    const p = await paidCheckout();
    const other = await makeSub();
    const { checkout } = await checkoutService.createCheckout({ subscriptionId: other.subId, userId: other.userId, platform: 'ios', clientKey: `rev-${nanoid(12)}` });
    await app.prisma.mmgCheckoutIntent.update({ where: { id: checkout.ref }, data: { status: 'HELD', candidates: [p.txn], reason: 'ALREADY_CREDITED' } });
    await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
    expect(reversalCalls).toEqual([]);
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
  });

  it('a held duplicate identity on the same MMG number: never reversed', async () => {
    const p = await paidCheckout();
    await app.prisma.providerPayment.create({ data: {
      provider: 'MMG', providerTxnId: p.txn, status: 'HELD_DUPLICATE', amount: p.amount, currencyCode: 'GYD', tenantId: 'swift-default',
    } });
    await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
    expect(reversalCalls).toEqual([]);
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
  });

  it('money already spent on a week is not returned here (the fee balance no longer holds it)', async () => {
    // Due now: the payment pays the running week the moment it is credited.
    const p = await paidCheckout({ due: new Date(Date.now() - 60_000) });
    expect(await walletOf(p.subId)).toBe(0);
    await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({ code: 'MONEY_ALREADY_USED' });
    expect(reversalCalls).toEqual([]);
  });

  it('two asks at once: exactly one claim, MMG asked once, the balance debited once', async () => {
    const p = await paidCheckout();
    const both = await Promise.allSettled([ask(p.checkoutId, p.amount), ask(p.checkoutId, p.amount)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    // [DS1112 S4] the payer's billing lock serialises them: a clean refusal, never a raw unique violation
    expect(['ALREADY_REVERSING', 'ALREADY_REVERSED']).toContain(refused.reason.code);
    expect(reversalCalls).toEqual([p.txn]);
    expect(await rowsFor(p.checkoutId)).toHaveLength(1);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
    expect(await walletOf(p.subId)).toBe(0);
  });
});

describe('[MMG REVERSAL] only MMG\'s lookup decides — a lost answer is never guessed', () => {
  it('MMG reversed but its answer was LOST: the lookup proves it, debited once', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'lost');
    const row = await ask(p.checkoutId, p.amount);
    expect(row.state).toBe('REVERSED');
    expect(row.providerStatus).toBe('error');
    expect(await walletOf(p.subId)).toBe(0);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('no answer and MMG did nothing: HELD for a person, the balance untouched, operators paged, billing paused', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const row = await ask(p.checkoutId, p.amount);
    expect(row).toMatchObject({ state: 'HELD', heldReason: 'NO_ANSWER_FROM_MMG' });
    expect(await walletOf(p.subId)).toBe(p.amount);
    expect(await reversalEvents(p.subId)).toHaveLength(0);
    const paged = await app.prisma.notification.findMany({ where: { userId: admin.userId, data: { path: ['reversalId'], equals: row.id } } });
    expect(paged.length).toBeGreaterThanOrEqual(1);
    // While it is open the partner is not asked to pay beside it, billing sends
    // and spends nothing, and the account cannot close around it.
    expect(await readFeePaymentDecision(app.prisma, p.subId)).toMatchObject({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
    expect(await app.prisma.$transaction((tx) => hasConfirmationInTx(tx, p.subId, new Date()))).toBe(true);
    const obligations = await app.prisma.$transaction((tx) => partnerObligations(tx, p.userId));
    expect(obligations.pendingFeePaymentCount).toBeGreaterThanOrEqual(1);
    // "Check with MMG": MMG still shows the payment standing and never refused — still a person's.
    const checked = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id }));
    expect(checked.state).toBe('HELD');
    expect(await walletOf(p.subId)).toBe(p.amount);
  });

  it('MMG refused and its lookup shows the payment standing: FAILED, nothing changed, and it may be asked again', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'declined');
    const row = await ask(p.checkoutId, p.amount);
    expect(row).toMatchObject({ state: 'FAILED', providerStatus: 'declined', lookupStatus: 'STANDING' });
    expect(row.failedAt).toBeTruthy();
    expect(await walletOf(p.subId)).toBe(p.amount);
    expect(await reversalEvents(p.subId)).toHaveLength(0);
    expect(await readFeePaymentDecision(app.prisma, p.subId)).not.toMatchObject({ reason: 'PAYMENT_CONFIRMING' });
    // A refused attempt frees the payment for another.
    sandboxScriptReversal(p.txn, 'reversed');
    const second = await ask(p.checkoutId, p.amount);
    expect(second.state).toBe('REVERSED');
    expect(await rowsFor(p.checkoutId)).toHaveLength(2);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('MMG says "already reversed" while its lookup shows the payment standing: a contradiction, HELD', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'duplicate');
    const row = await ask(p.checkoutId, p.amount);
    expect(row).toMatchObject({ state: 'HELD', heldReason: 'MMG_SAYS_ALREADY_REVERSED' });
    expect(await walletOf(p.subId)).toBe(p.amount);
  });

  it('MMG accepted (pending): SENT until the lookup proves it; "Check with MMG" then debits ONCE, and again changes nothing', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const row = await ask(p.checkoutId, p.amount);
    expect(row.state).toBe('SENT');
    expect(await walletOf(p.subId)).toBe(p.amount);
    sandboxSetTxStatus(p.txn, 'reversed'); // MMG finishes
    const done = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id }));
    expect(done.state).toBe('REVERSED');
    const again = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id }));
    expect(again.state).toBe('REVERSED');
    expect(await reversalEvents(p.subId)).toHaveLength(1);
    expect(await walletOf(p.subId)).toBe(0);
  });

  it('the checkout poll settles a pending reversal on its own once MMG\'s lookup proves it', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const row = await ask(p.checkoutId, p.amount);
    expect(row.state).toBe('SENT');
    sandboxSetTxStatus(p.txn, 'reversed');
    // The sweep re-reads an open reversal at most every ten minutes.
    await checkoutService.pollIntents(new Date(Date.now() + 11 * 60_000));
    expect((await app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('REVERSED');
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('MMG proves the return but the balance no longer holds it: HELD for a person, never below zero', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const row = await ask(p.checkoutId, p.amount);
    // The balance moved by some path outside this pause (simulated).
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: 0 } });
    sandboxSetTxStatus(p.txn, 'reversed');
    const after = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id }));
    expect(after).toMatchObject({ state: 'HELD', heldReason: 'WALLET_NO_LONGER_HOLDS_IT' });
    expect(await reversalEvents(p.subId)).toHaveLength(0);
    expect(await walletOf(p.subId)).toBe(0);
  });
});

const resolve = (reversalId: string, outcome: 'NOT_RETURNED' | 'RETURNED', mmgReference: string) => runWithTenant('swift-default', () =>
  reversals.resolveHeld({ tenantId: 'swift-default', reversalId, outcome, mmgReference, actorId: admin.userId }, async () => {}));

describe('[DS1112] a HELD return always has a way out — on MMG\'s evidence, never a guess', () => {
  it('"MMG shows nothing was returned" (two people): FAILED with the MMG reference, billing resumes, and it can be asked again', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    expect(held.state).toBe('HELD');
    // MMG's words are kept shaped, never raw
    expect(held.providerReason).toBe('MMG reversal unreachable (sandbox) timeout');
    const resolveRoute = {
      method: 'POST' as const, url: `/api/v1/admin/billing/mmg-fee-reversals/${held.id}/resolve`,
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
      payload: { outcome: 'NOT_RETURNED', mmgReference: 'MMG-STMT-0001', reason: REASON },
    };
    // a money decision: a second person first
    const asked = await app.inject(resolveRoute);
    expect(asked.statusCode, asked.body).toBe(202);
    expect((await app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('HELD');
    const res = await injectWithApproval(app, resolveRoute);
    expect(res.statusCode, res.body).toBe(200);
    const row = await app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id: held.id } });
    expect(row).toMatchObject({ state: 'FAILED', resolution: 'NOT_RETURNED', resolvedBy: admin.userId, resolutionNote: 'MMG-STMT-0001' });
    expect(await walletOf(p.subId)).toBe(p.amount);
    expect(await app.prisma.$transaction((tx) => hasConfirmationInTx(tx, p.subId, new Date()))).toBe(false);
    const audit = await app.prisma.auditLog.findFirst({ where: { entityId: held.id, action: { contains: '/resolve' } } });
    expect(audit).toBeTruthy();
    sandboxScriptReversal(p.txn, 'reversed');
    expect((await ask(p.checkoutId, p.amount)).state).toBe('REVERSED');
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('"nothing was returned" is refused when MMG shows the return, and when the return is not held', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    sandboxSetTxStatus(p.txn, 'reversed'); // MMG's records now show it returned
    await expect(resolve(held.id, 'NOT_RETURNED', 'MMG-STMT-0002')).rejects.toMatchObject({ code: 'MMG_SHOWS_RETURNED' });
    expect((await app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('HELD');
    const p2 = await paidCheckout();
    sandboxScriptReversal(p2.txn, 'pending');
    const sent = await ask(p2.checkoutId, p2.amount);
    expect(sent.state).toBe('SENT');
    await expect(resolve(sent.id, 'NOT_RETURNED', 'MMG-STMT-0003')).rejects.toMatchObject({ code: 'NOT_HELD' });
    // MMG's records show neither the return nor the payment standing (still processing): not closed
    const p3 = await paidCheckout();
    sandboxScriptReversal(p3.txn, 'error');
    const held3 = await ask(p3.checkoutId, p3.amount);
    sandboxSetTxStatus(p3.txn, 'pending');
    await expect(resolve(held3.id, 'NOT_RETURNED', 'MMG-STMT-0004')).rejects.toMatchObject({ code: 'PAYMENT_NOT_STANDING' });
    expect((await app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id: held3.id } })).state).toBe('HELD');
  });

  it('"returned, here is MMG\'s reference": booked only if MMG\'s lookup proves that reversal, exactly once', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error'); // no answer, and MMG's lookup of the original keeps showing it successful
    const held = await ask(p.checkoutId, p.amount);
    await expect(resolve(held.id, 'RETURNED', `NOPE${RUN}`)).rejects.toMatchObject({ code: 'NO_PROOF' });
    expect((await app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('HELD');
    // the statement shows MMG's reversal transaction for this payment
    const reversalRef = `REV${seq}${RUN}`;
    sandboxAddHistory({ transactionId: reversalRef, status: 'approved', amountMinor: p.amount * 100, currencyCode: 'GYD' });
    const done = await resolve(held.id, 'RETURNED', reversalRef);
    expect(done).toMatchObject({ state: 'REVERSED', resolution: 'RETURNED_BY_REFERENCE', lookupStatus: 'REVERSAL_COMPLETED' });
    expect(await walletOf(p.subId)).toBe(0);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('MMG proves the return but booking it fails: HELD and paged, never retried silently', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const row = await ask(p.checkoutId, p.amount);
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { currencyCode: 'USD' } });
    try {
      sandboxSetTxStatus(p.txn, 'reversed');
      const after = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id }));
      expect(after.state).toBe('HELD');
      expect(after.heldReason).toMatch(/^APPLY_FAILED/);
      expect(await reversalEvents(p.subId)).toHaveLength(0);
      const paged = await app.prisma.notification.findMany({ where: { userId: admin.userId, data: { path: ['reversalId'], equals: row.id } } });
      expect(paged.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { currencyCode: 'GYD' } });
    }
    // once the books are right, "Check with MMG" books it
    const fixed = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id }));
    expect(fixed.state).toBe('REVERSED');
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('two checks at once after MMG proves it: both answer REVERSED, the balance is debited once', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const row = await ask(p.checkoutId, p.amount);
    sandboxSetTxStatus(p.txn, 'reversed');
    const both = await Promise.all([
      runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id })),
      runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: row.id })),
    ]);
    expect(both.map((r) => r.state)).toEqual(['REVERSED', 'REVERSED']);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
    expect(await walletOf(p.subId)).toBe(0);
  });

  it('MMG\'s raw words are shaped before they are kept', async () => {
    const { shapeProviderText } = await import('../modules/billing/mmg-fee-reversal');
    expect(shapeProviderText('MMG reversal HTTP 503: {"message":"<b>busy</b>"}')).toBe('MMG reversal HTTP 503: message:bbusy/b');
    expect(shapeProviderText('x'.repeat(500))!.length).toBe(120);
    expect(shapeProviderText('')).toBeNull();
  });
});

const resolveAs = (reversalId: string, outcome: 'NOT_RETURNED' | 'RETURNED' | 'RETURNED_NOT_BOOKED', mmgReference: string, service = reversals) => runWithTenant('swift-default', () =>
  service.resolveHeld({ tenantId: 'swift-default', reversalId, outcome, mmgReference, actorId: admin.userId }, async () => {}));
const reversalRow = (id: string) => app.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id } });

describe('[DS1115] a person\'s answer is bound to THIS payment, and every held return can be closed', () => {
  it('S2: a reference that names a payment Swift knows (this payment\'s own MMG ledger line, or another payment) is refused, even when MMG shows it approved for the amount', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    expect(held.state).toBe('HELD');
    const own = await app.prisma.providerPayment.findMany({ where: { creditedPaymentId: `mco:${p.checkoutId}` }, select: { providerTxnId: true } });
    const ledger = own.map((r) => r.providerTxnId).find((n) => n.toUpperCase() !== p.txn.toUpperCase());
    expect(ledger, 'the checkout recorded MMG\'s ledger number too').toBeTruthy();
    // MMG's lookup of the original's own statement line: approved, the very same amount — a payment, not a return
    sandboxAddHistory({ transactionId: ledger!, status: 'approved', amountMinor: p.amount * 100, currencyCode: 'GYD' });
    await expect(resolveAs(held.id, 'RETURNED', ledger!)).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
    await expect(resolveAs(held.id, 'RETURNED', ` ${ledger!.toLowerCase()} `)).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
    const other = await paidCheckout();
    await expect(resolveAs(held.id, 'RETURNED', other.txn)).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
    expect((await reversalRow(held.id)).state).toBe('HELD');
    expect(await walletOf(p.subId)).toBe(p.amount);
    expect(await reversalEvents(p.subId)).toHaveLength(0);
  });

  it('S3: MMG returned it but the money already paid for a week — "returned" is refused; "returned, not booked" closes it on MMG\'s proof, frees billing and is never asked again', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const sent = await ask(p.checkoutId, p.amount);
    expect(sent.state).toBe('SENT');
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: 0 } }); // the money paid for a week meanwhile
    sandboxSetTxStatus(p.txn, 'reversed');
    const held = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: sent.id }));
    expect(held).toMatchObject({ state: 'HELD', heldReason: 'WALLET_NO_LONGER_HOLDS_IT' });
    await expect(resolveAs(held.id, 'RETURNED', `STMT${RUN}A`)).rejects.toMatchObject({ code: 'RETURN_NOT_BOOKABLE' });
    expect((await reversalRow(held.id)).resolution).toBeNull();
    const closed = await resolveAs(held.id, 'RETURNED_NOT_BOOKED', `STMT${RUN}B`);
    expect(closed).toMatchObject({ state: 'FAILED', resolution: 'RETURNED_NOT_BOOKED', resolvedBy: admin.userId, resolutionNote: `STMT${RUN}B` });
    expect(await walletOf(p.subId)).toBe(0);
    expect(await reversalEvents(p.subId)).toHaveLength(0);
    expect(await app.prisma.$transaction((tx) => hasConfirmationInTx(tx, p.subId, new Date()))).toBe(false);
    await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    // only a return MMG proved after the money was used is closed this way
    const q = await paidCheckout();
    sandboxScriptReversal(q.txn, 'error');
    const noAnswer = await ask(q.checkoutId, q.amount);
    await expect(resolveAs(noAnswer.id, 'RETURNED_NOT_BOOKED', `STMT${RUN}C`)).rejects.toMatchObject({ code: 'NOT_SHORT' });
  });

  it('S3: closed as "not returned", then MMG returns it after all — the checkout poll notices within a week and pages once, even with nothing else open', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    expect((await resolveAs(held.id, 'NOT_RETURNED', `STMT${RUN}D`)).state).toBe('FAILED');
    // [review S2-1] The production path: the poll, with no other return open anywhere.
    await app.prisma.mmgFeeReversal.updateMany({ where: { state: { in: ['SENDING', 'SENT', 'HELD'] } }, data: { state: 'FAILED', failedAt: new Date(), lookupStatus: 'STANDING' } });
    expect(await app.prisma.mmgFeeReversal.count({ where: { state: { in: ['SENDING', 'SENT', 'HELD'] } } })).toBe(0);
    sandboxSetTxStatus(p.txn, 'reversed');
    const pages = async () => (await app.prisma.notification.findMany({ where: { data: { path: ['alert'], equals: 'mmg-fee-reversal-returned-after-close' } } }))
      .filter((n) => (n.data as Record<string, unknown>)['reversalId'] === held.id);
    const later = new Date(Date.now() + 60 * 60_000);
    await checkoutService.pollIntents(later);
    const first = await pages();
    expect(first.length).toBeGreaterThan(0);
    expect((await reversalRow(held.id)).lookupStatus).toBe('RETURNED_AFTER_CLOSE');
    await checkoutService.pollIntents(new Date(later.getTime() + 60 * 60_000));
    expect(await pages()).toHaveLength(first.length);
  });

  it('S4: MMG cannot be asked right now — a clean refusal, nothing changed', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    const down = new MmgFeeReversalService({ prisma: app.prisma, billing, notifications, client: () => ({ ...reversalClient, transactionLookupDetail: async () => { throw new Error('connection reset'); } }) });
    await expect(resolveAs(held.id, 'NOT_RETURNED', `STMT${RUN}E`, down)).rejects.toMatchObject({ code: 'MMG_LOOKUP_UNAVAILABLE' });
    await expect(resolveAs(held.id, 'RETURNED', `STMT${RUN}F`, down)).rejects.toMatchObject({ code: 'MMG_LOOKUP_UNAVAILABLE' });
    expect((await reversalRow(held.id))).toMatchObject({ state: 'HELD', resolution: null });
  });

  it('S4: the database keeps a resolution written once, and binds each outcome to its state', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    await resolveAs(held.id, 'NOT_RETURNED', `STMT${RUN}G`);
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: held.id }, data: { resolution: 'RETURNED_BY_REFERENCE' } })).rejects.toThrow();
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: held.id }, data: { resolutionNote: 'rewritten' } })).rejects.toThrow();
    const q = await paidCheckout();
    sandboxScriptReversal(q.txn, 'error');
    const held2 = await ask(q.checkoutId, q.amount);
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: held2.id }, data: { resolution: 'NOT_RETURNED', resolvedBy: 'x', resolutionNote: 'y' } })).rejects.toThrow();
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: held2.id }, data: { resolution: 'RETURNED_NOT_BOOKED', resolvedBy: 'x', resolutionNote: 'y' } })).rejects.toThrow();
  });
});

describe('[security review, 14 Oct] every decision is taken on the row and the books as they are when it is written', () => {
  const settleAt = (id: string, now: Date) => runWithTenant('swift-default', () => reversals.settle(id, { now }));

  it('R1: "returned, not booked" is refused if the books hold the money again by the time it is written (stale approval)', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const sent = await ask(p.checkoutId, p.amount);
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: 0 } });
    sandboxSetTxStatus(p.txn, 'reversed');
    const held = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: sent.id }));
    expect(held).toMatchObject({ state: 'HELD', heldReason: 'WALLET_NO_LONGER_HOLDS_IT' });
    // asked while the money was used; finance then put it back before the second admin approved
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: p.amount } });
    await expect(resolveAs(held.id, 'RETURNED_NOT_BOOKED', `STMT${RUN}H`)).rejects.toMatchObject({ code: 'RETURN_NOW_BOOKABLE' });
    expect(await reversalRow(held.id)).toMatchObject({ state: 'HELD', resolution: null });
    // the return is booked once, on MMG's proof
    const booked = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: held.id }));
    expect(booked.state).toBe('REVERSED');
    expect(await walletOf(p.subId)).toBe(0);
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('R2: a reversal reference that already proved one return can never prove another (even when MMG had named its own)', async () => {
    const a = await paidCheckout();
    sandboxScriptReversal(a.txn, 'pending');
    const sentA = await ask(a.checkoutId, a.amount);
    expect(sentA.state).toBe('SENT');
    const heldA = await settleAt(sentA.id, new Date(Date.now() + 25 * 3_600_000));
    expect(heldA.state).toBe('HELD');
    expect(heldA.providerReference, 'MMG named a reference: a typed one is kept only as the note').toBeTruthy();
    const typed = `REVT${seq}${RUN}`;
    sandboxAddHistory({ transactionId: typed, status: 'approved', amountMinor: a.amount * 100, currencyCode: 'GYD' });
    expect((await resolveAs(heldA.id, 'RETURNED', typed)).state).toBe('REVERSED');
    const b = await paidCheckout();
    sandboxScriptReversal(b.txn, 'error');
    const heldB = await ask(b.checkoutId, b.amount);
    await expect(resolveAs(heldB.id, 'RETURNED', typed)).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
    await expect(resolveAs(heldB.id, 'RETURNED', ` ${typed.toLowerCase()} `)).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
    expect(await reversalRow(heldB.id)).toMatchObject({ state: 'HELD', resolution: null });
    expect(await walletOf(b.subId)).toBe(b.amount);
    expect(await reversalEvents(b.subId)).toHaveLength(0);
  });

  it('R5: a stale tick never closes a return a person has already resolved', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    // MMG's refusal on record, and a person's "returned" answer written, its booking about to follow
    await app.prisma.mmgFeeReversal.update({ where: { id: held.id }, data: { providerStatus: 'declined', providerReason: 'MMG refused the reversal' } });
    await app.prisma.mmgFeeReversal.update({ where: { id: held.id }, data: { resolution: 'RETURNED_BY_REFERENCE', resolvedBy: admin.userId, resolutionNote: `REVS${RUN}` } });
    const after = await settleAt(held.id, new Date());
    expect(after).toMatchObject({ state: 'HELD', resolution: 'RETURNED_BY_REFERENCE' });
  });
});

describe('[DS1117] every MMG number Swift recorded is known; a held return never sticks half-resolved', () => {
  it('S2: a push-rail payment, an MMG refund or a billing event reference is a payment Swift recorded, never a return', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    const other = await paidCheckout();
    const push = `PUSH${seq}${RUN}`;
    const refund = `RFND${seq}${RUN}`;
    const event = `EVNT${seq}${RUN}`;
    const pay = await app.prisma.subscriptionPayment.create({ data: { subscriptionId: other.subId, amount: p.amount, status: 'CAPTURED', paymentMethod: 'MOBILE_MONEY',
      externalRef: push, periodStart: new Date(Date.now() - 7 * DAY), periodEnd: new Date(), paidAt: new Date() } });
    await app.prisma.subscriptionRefund.create({ data: { subscriptionId: other.subId, paymentId: pay.id, amount: p.amount, refundType: 'FULL', reason: 'test',
      processedBy: admin.userId, refundDestination: 'MMG', status: 'COMPLETED', externalRef: refund } });
    await app.prisma.billingEvent.create({ data: { subscriptionId: other.subId, type: 'CHARGE_SUCCESS', amount: p.amount, currencyCode: 'GYD',
      idempotencyKey: `ds1117:${event}`, paymentRef: event } });
    for (const ref of [push, refund, event]) {
      sandboxAddHistory({ transactionId: ref, status: 'approved', amountMinor: p.amount * 100, currencyCode: 'GYD' });
      await expect(resolveAs(held.id, 'RETURNED', ref), ref).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
    }
    expect(await reversalRow(held.id)).toMatchObject({ state: 'HELD', resolution: null });
    expect(await reversalEvents(p.subId)).toHaveLength(0);
  });

  it('S3: "returned" books in the same transaction it is written: if the booking cannot happen, nothing is written and the return can still be closed', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    const typed = `REVW${seq}${RUN}`;
    sandboxAddHistory({ transactionId: typed, status: 'approved', amountMinor: p.amount * 100, currencyCode: 'GYD' });
    // the money is drained between the check and the booking (another path, a race)
    const short = vi.spyOn(billing, 'debitWalletForReversalInTx').mockResolvedValueOnce({ short: true });
    try {
      await expect(resolveAs(held.id, 'RETURNED', typed)).rejects.toMatchObject({ code: 'RETURN_NOT_BOOKABLE' });
    } finally {
      short.mockRestore();
    }
    expect(await reversalRow(held.id)).toMatchObject({ state: 'HELD', resolution: null });
    expect(await reversalEvents(p.subId)).toHaveLength(0);
    // nothing stuck: the same answer now books it once
    expect((await resolveAs(held.id, 'RETURNED', typed)).state).toBe('REVERSED');
    expect(await reversalEvents(p.subId)).toHaveLength(1);
  });

  it('S4: MMG\'s lookup that cannot be read is "MMG unavailable", never "not standing" or "no proof"', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    const unread = new MmgFeeReversalService({ prisma: app.prisma, billing, notifications, client: () => ({ ...reversalClient, transactionLookupDetail: async () => ({ outcome: 'error' as const }) }) as never });
    await expect(resolveAs(held.id, 'NOT_RETURNED', `STMT${RUN}J`, unread)).rejects.toMatchObject({ code: 'MMG_LOOKUP_UNAVAILABLE' });
    await expect(resolveAs(held.id, 'RETURNED', `STMT${RUN}K`, unread)).rejects.toMatchObject({ code: 'MMG_LOOKUP_UNAVAILABLE' });
    expect(await reversalRow(held.id)).toMatchObject({ state: 'HELD', resolution: null });
  });

  it('S4: a return held because the money already paid for a week keeps that reason through a flaky lookup', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'pending');
    const sent = await ask(p.checkoutId, p.amount);
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: 0 } });
    sandboxSetTxStatus(p.txn, 'reversed');
    const held = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: sent.id }));
    expect(held.heldReason).toBe('WALLET_NO_LONGER_HOLDS_IT');
    sandboxSetTxStatus(p.txn, 'approved'); // a flaky read: MMG's lookup briefly does not show the return
    const later = await runWithTenant('swift-default', () => reversals.settle(held.id, { now: new Date(Date.now() + 25 * 3_600_000) }));
    expect(later).toMatchObject({ state: 'HELD', heldReason: 'WALLET_NO_LONGER_HOLDS_IT' });
  });
});

describe('[DS1118] a typed reference is checked against EVERY money reference Swift records', () => {
  it('S2: a payout\'s MMG reference (recorded in payout requests) is never a return', async () => {
    const p = await paidCheckout();
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    const payoutRef = `PAYO${seq}${RUN}`;
    const payout = await app.prisma.payoutRequest.create({ data: { userId: admin.userId, amount: p.amount, netAmount: p.amount, method: 'MOBILE_MONEY', destination: {}, externalRef: payoutRef } });
    try {
      sandboxAddHistory({ transactionId: payoutRef, status: 'approved', amountMinor: p.amount * 100, currencyCode: 'GYD' });
      await expect(resolveAs(held.id, 'RETURNED', payoutRef)).rejects.toMatchObject({ code: 'NOT_A_REVERSAL' });
      expect(await reversalRow(held.id)).toMatchObject({ state: 'HELD', resolution: null });
      expect(await reversalEvents(p.subId)).toHaveLength(0);
    } finally {
      await app.prisma.payoutRequest.delete({ where: { id: payout.id } });
    }
  });

  it('the list covers every money-reference column in the schema (a new one must be added, or named as not money)', async () => {
    const { KNOWN_PAYMENT_REFERENCE_COLUMNS } = await import('../modules/billing/mmg-fee-reversal');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    // Reference-named columns that are not money: documents, audit chain, moderation, validators.
    const NOT_MONEY = new Set(['verification_documents.kycRef', 'validator.implRef', 'doc_field.validatorRef', 'extraction_run.processorRef',
      'content_reports.authorityRef', 'content_reports.enforcementRef', 'audit_chain.subjectRef', 'audit_chain.submissionRef',
      'doc_type.externalProcessingDecisionRef']);
    // Columns the census reads on its own terms (this return's own row is excluded there).
    const HANDLED = new Set(['mmg_fee_reversals.providerReference', 'mmg_fee_reversals.mmgTransactionId']);
    const listed = new Set(KNOWN_PAYMENT_REFERENCE_COLUMNS.map(([t, c]) => `${t}.${c}`));
    const missing: string[] = [];
    for (const block of schema.split(/\nmodel /).slice(1)) {
      const table = /@@map\("([a-z_0-9]+)"\)/.exec(block)?.[1];
      if (!table) continue;
      for (const m of block.matchAll(/^\s+([a-zA-Z]+(?:Ref|ref|Reference|reference|TxnId|TransactionId))\s+String/gm)) {
        const key = `${table}.${m[1]}`;
        if (!listed.has(key) && !NOT_MONEY.has(key) && !HANDLED.has(key)) missing.push(key);
      }
    }
    expect(missing, 'add these to KNOWN_PAYMENT_REFERENCE_COLUMNS, or to NOT_MONEY with a reason').toEqual([]);
    expect(listed.size, 'the list names real columns').toBeGreaterThan(20);
  });

  it('the check\'s SQL reads exactly the listed columns, written out statically (the list and the SQL cannot drift)', async () => {
    const { KNOWN_PAYMENT_REFERENCE_COLUMNS } = await import('../modules/billing/mmg-fee-reversal');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '../modules/billing/mmg-fee-reversal.ts'), 'utf8');
    const start = source.indexOf('async function namesAKnownPayment(');
    expect(start, 'the check is still a function in mmg-fee-reversal.ts').toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    // every listed column has its own subquery, the typed reference always a bound parameter
    const absent = KNOWN_PAYMENT_REFERENCE_COLUMNS
      .filter(([table, column]) => !body.includes(
        '(SELECT count(*) FROM "' + table + '" WHERE mmg_txn_canon("' + column + '") = mmg_txn_canon(${reference}))'))
      .map(([table, column]) => `${table}.${column}`);
    expect(absent, 'each listed column needs its subquery in namesAKnownPayment').toEqual([]);
    // and the SQL reads nothing the list does not name, each column once
    const inSql = [...body.matchAll(/FROM "([a-z_0-9]+)" WHERE mmg_txn_canon\("([A-Za-z0-9]+)"\)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect([...inSql].sort()).toEqual(KNOWN_PAYMENT_REFERENCE_COLUMNS.map(([t, c]) => `${t}.${c}`).sort());
    expect(new Set(inSql).size).toBe(inSql.length);
  });
});

describe('[MMG REVERSAL] the record only moves forward', () => {
  it('the database refuses a backwards state, a rewritten amount, and a second wallet debit', async () => {
    const p = await paidCheckout();
    const row = await ask(p.checkoutId, p.amount);
    expect(row.state).toBe('REVERSED');
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: row.id }, data: { state: 'SENT' } })).rejects.toThrow(/only moves forward/);
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: row.id }, data: { amount: 1 } })).rejects.toThrow(/written once/);
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: row.id }, data: { walletDebitedAt: new Date() } })).rejects.toThrow(/written once/);
    // and a debited wallet can only belong to a REVERSED row
    const p2 = await paidCheckout();
    sandboxScriptReversal(p2.txn, 'error');
    const held = await ask(p2.checkoutId, p2.amount);
    await expect(app.prisma.mmgFeeReversal.update({ where: { id: held.id }, data: { walletDebitedAt: new Date() } })).rejects.toThrow();
    // one live reversal per payment, in the database itself
    await expect(app.prisma.mmgFeeReversal.create({ data: {
      tenantId: held.tenantId, subscriptionId: held.subscriptionId, checkoutId: held.checkoutId, providerPaymentId: held.providerPaymentId,
      mmgTransactionId: held.mmgTransactionId, amount: held.amount, currencyCode: held.currencyCode, reason: REASON,
      requestedBy: admin.userId, sentAt: new Date(),
    } })).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('[MMG REVERSAL · Opus S3 pattern] the rollback guard cannot be blinded by row-level security', () => {
  it('switches row security off for its transaction before it looks for reversal rows', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261014130000_mmg_fee_reversals/rollback.sql'), 'utf8');
    const begin = sql.indexOf('BEGIN;');
    const off = sql.indexOf('SET LOCAL row_security = off;');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(off, 'mmg_fee_reversals forces row security: a non-bypass role must get an error, never an empty table').toBeGreaterThan(begin);
    expect(off).toBeLessThan(sql.indexOf('IF EXISTS'));
  });
});

describe('[review #1654] what MMG names is checked, one reference books once, nothing closes under a return in flight', () => {
  /** MMG answers the reversal "pending", naming `named(txn)`; the lookup is the sandbox's, with the
   *  payment's own ledger number set when `ledger` is given. */
  const namingClient = (named: (txn: string) => string, ledger?: { txn: string; ledgerRef: string }): MmgReversalClient => ({
    reverseTransaction: async (req) => { reversalCalls.push(req.transactionId); return { status: 'pending', transactionId: named(req.transactionId) }; },
    transactionLookupDetail: async (id) => {
      const detail = await mmg.transactionLookupDetail(id);
      return ledger && id === ledger.txn && detail.outcome === 'found' ? { ...detail, ledgerReference: ledger.ledgerRef } : detail;
    },
  });
  const serviceWith = (client: MmgReversalClient) => new MmgFeeReversalService({ prisma: app.prisma, billing, notifications, client: () => client });
  const askWith = (service: MmgFeeReversalService, checkoutId: string, amountGyd: number) => runWithTenant('swift-default', () =>
    service.requestReversal({ tenantId: 'swift-default', checkoutId, amountGyd, reason: REASON, actorId: admin.userId, approvalId: null }, async () => {}));

  it('S2-2: MMG\'s reply names the payment\'s own ledger number — never proof: nothing deducted, nothing booked', async () => {
    const p = await paidCheckout();
    const ledgerRef = `LG${p.txn}`;
    // MMG's lookup of the payment's ledger number answers the payment itself: successful, same amount.
    sandboxAddHistory({ transactionId: ledgerRef, status: 'approved', amountMinor: p.amount * 100, currencyCode: 'GYD' });
    const before = await walletOf(p.subId);
    const row = await askWith(serviceWith(namingClient(() => ledgerRef, { txn: p.txn, ledgerRef })), p.checkoutId, p.amount);
    expect(row.state).not.toBe('REVERSED');
    expect(await walletOf(p.subId)).toBe(before);
    expect(await reversalEvents(p.subId)).toHaveLength(0);
  });

  it('S2-2: MMG\'s reply names another payment Swift has on record — held for a person, nothing deducted', async () => {
    const p = await paidCheckout();
    const q = await paidCheckout();
    const before = await walletOf(p.subId);
    const service = serviceWith(namingClient(() => q.txn));
    const row = await askWith(service, p.checkoutId, p.amount);
    expect(row).toMatchObject({ state: 'HELD', heldReason: 'MMG_NAMED_A_PAYMENT' });
    expect(await walletOf(p.subId)).toBe(before);
    expect(await reversalEvents(p.subId)).toHaveLength(0);
    // [DS1124 S2] It can be closed: MMG shows the payment standing, and a payment is never a return.
    expect(await resolveAs(row.id, 'NOT_RETURNED', `STMT${RUN}N`, service)).toMatchObject({ state: 'FAILED', resolution: 'NOT_RETURNED' });
  });

  it('S3-1: two held returns closed "returned" at once with ONE reversal reference — exactly one books', async () => {
    const p1 = await paidCheckout();
    const p2 = await paidCheckout();
    sandboxScriptReversal(p1.txn, 'error');
    sandboxScriptReversal(p2.txn, 'error');
    const h1 = await ask(p1.checkoutId, p1.amount);
    const h2 = await ask(p2.checkoutId, p2.amount);
    const reference = `RVSL${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`;
    sandboxAddHistory({ transactionId: reference, status: 'approved', amountMinor: p1.amount * 100, currencyCode: 'GYD' });
    const results = await Promise.allSettled([resolveAs(h1.id, 'RETURNED', reference), resolveAs(h2.id, 'RETURNED', reference)]);
    const states = [(await reversalRow(h1.id)).state, (await reversalRow(h2.id)).state];
    expect(states.filter((state) => state === 'REVERSED')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: 'NOT_A_REVERSAL' });
    expect((await reversalEvents(p1.subId)).length + (await reversalEvents(p2.subId)).length).toBe(1);
  });

  it('S4: a server that cannot build MMG\'s client refuses before anything is written; a payer\'s number never lands in MMG\'s stored words', async () => {
    const p = await paidCheckout();
    const broken = new MmgFeeReversalService({ prisma: app.prisma, billing, notifications, client: () => { throw new Error('Unknown MMG_DRIVER: typo'); } });
    await expect(askWith(broken, p.checkoutId, p.amount)).rejects.toThrow(/Unknown MMG_DRIVER/);
    expect(await rowsFor(p.checkoutId)).toHaveLength(0);
    const { shapeProviderText } = await import('../modules/billing/mmg-fee-reversal');
    expect(shapeProviderText('Refused: payer 5926001234 has no funds')).toBe('Refused: payer (number) has no funds');
    expect(shapeProviderText('Refused: payer 592-600 1234 has no funds')).toBe('Refused: payer (number) has no funds');
  });

  it('[security review: sibling-path parity] two "returned, not booked" closes at once proven by ONE reversal reference — exactly one closes', async () => {
    const heldShort = async () => {
      const p = await paidCheckout();
      sandboxScriptReversal(p.txn, 'error'); // no answer: MMG named no reversal
      const held = await ask(p.checkoutId, p.amount);
      await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: 0 } });
      sandboxSetTxStatus(p.txn, 'reversed');
      const short = await runWithTenant('swift-default', () => reversals.check({ tenantId: 'swift-default', reversalId: held.id }));
      expect(short.heldReason).toBe('WALLET_NO_LONGER_HOLDS_IT');
      sandboxSetTxStatus(p.txn, 'approved'); // MMG's lookup of the original no longer shows it: only the typed reversal proves
      return { p, id: held.id };
    };
    const a = await heldShort();
    const b = await heldShort();
    const reference = `RVNB${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`;
    sandboxAddHistory({ transactionId: reference, status: 'approved', amountMinor: a.p.amount * 100, currencyCode: 'GYD' });
    const results = await Promise.allSettled([resolveAs(a.id, 'RETURNED_NOT_BOOKED', reference), resolveAs(b.id, 'RETURNED_NOT_BOOKED', reference)]);
    const closed = [await reversalRow(a.id), await reversalRow(b.id)].filter((r) => r.resolution === 'RETURNED_NOT_BOOKED');
    expect(closed).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: 'NOT_A_REVERSAL' });
  });

  it('S3-2: a reversal MMG named is still pending — "not returned" is refused, so MMG is never asked a second time', async () => {
    const p = await paidCheckout();
    const pendingReversal = `PEND${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`;
    sandboxAddHistory({ transactionId: pendingReversal, status: 'pending', amountMinor: p.amount * 100, currencyCode: 'GYD' });
    const service = serviceWith(namingClient(() => pendingReversal));
    const sent = await askWith(service, p.checkoutId, p.amount);
    expect(sent.state).toBe('SENT');
    const held = await runWithTenant('swift-default', () => service.settle(sent.id, { now: new Date(Date.now() + 25 * 3_600_000) }));
    expect(held).toMatchObject({ state: 'HELD', heldReason: 'NOT_PROVEN_IN_TIME' });
    await expect(resolveAs(held.id, 'NOT_RETURNED', `STMT${RUN}P`, service)).rejects.toMatchObject({ code: 'MMG_RETURN_IN_FLIGHT' });
    expect(await reversalRow(held.id)).toMatchObject({ state: 'HELD', resolution: null });
    // [DS1124 S3] Bounded: a week after the request it can be closed (the late watch still pages if MMG completes it).
    const weekLater = new Date(sent.sentAt.getTime() + 8 * 24 * 3_600_000);
    const closed = await runWithTenant('swift-default', () => service.resolveHeld({ tenantId: 'swift-default', reversalId: held.id, outcome: 'NOT_RETURNED', mmgReference: `STMT${RUN}Q`, actorId: admin.userId }, async () => {}, weekLater));
    expect(closed).toMatchObject({ state: 'FAILED', resolution: 'NOT_RETURNED' });
  });
});
