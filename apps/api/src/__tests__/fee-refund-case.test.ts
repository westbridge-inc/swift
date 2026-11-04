import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Prisma } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { MmgFeeReversalService, MMG_FEE_REVERSAL_SWITCH } from '../modules/billing/mmg-fee-reversal';
import { businessDaysDue, FEE_REFUND_OVERDUE_KEY, FEE_REFUND_OVERDUE_TITLE, feeRefundCaseOf, listFeeRefundCases, openFeeRefundCase, sweepFeeRefundCases } from '../modules/billing/fee-refund-case';
import { JOB_RECOVERY } from '../jobs/recovery-policy';
import { alertClassOf } from '../providers/notifications/alert-class';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';
import { escalateOverdueOpsAlerts } from '../modules/safety/ops-alert';
import { gsm7Parts, isGsm7Message } from '../utils/sms-text';
import { testPhone } from './helpers/fixture-ids';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { ensureLedgerAccounts } from '../modules/billing/ledger';
import { getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type SandboxCheckoutKeys } from '../providers/mmg/mmg-checkout';
import {
  SandboxMmgProvider, lookupDetailFrom, sandboxAddHistory, sandboxResetMmg, sandboxScriptReversal, sandboxSetTxStatus,
  type MmgCheckoutLookupClient, type MmgLookupDetail, type MmgReversalClient,
} from '../providers/mmg/mmg-provider';
import { FakeMmgHistory } from './helpers/mmg-history-fake';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { purgeAuditLogs } from '../lib/audit-immutability';

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
/** [7 Oct] MMG's Transaction History, which ties a payment to its checkout and gives its time. */
const history = new FakeMmgHistory();
const checkoutLookup: MmgCheckoutLookupClient = {
  transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' },
  transactionHistoryRows: (query) => history.transactionHistoryRows(query),
};
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
const chainIntentIds: string[] = [];
let seq = 0;
const phoneBase = 592_648_000_000 + Math.floor(Math.random() * 900_000);
const REASON = 'Partner paid this week twice by mistake and asked for the second payment back';
const walletOf = async (subId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance);
/** The table's guard refuses a delete: a test's cleanup goes around it for this transaction only. */
const removeCases = (where: Prisma.FeeRefundCaseWhereInput) => app.prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
  await tx.feeRefundCase.deleteMany({ where });
});

async function makeSub(opts: { balance?: number; due?: Date } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Case', lastName: `P${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Refund Case Store ${seq}`, slug: `refund-case-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+${phoneBase + 5000 + seq}`, addressLine1: '1 Refund Street', city: 'Georgetown', region: 'Demerara-Mahaica',
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
  const { checkout } = await checkoutService.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'ios', clientKey: `rcase-${nanoid(12)}` });
  const row = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: checkout.ref } });
  const txn = `RC${seq}${RUN}`;
  const amount = Number(row.amount);
  lookups.set(txn, lookupDetailFrom(uatAnswer(txn, amount), txn));
  history.holds(txn, amount, { external_id: row.merchantTransactionId });
  const token = sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0', secretKey: 'x' });
  expect(await checkoutService.observeReply({ source: 'RETURN', outcome: 'success', params: { token } })).toBe('CONFIRMED');
  // MMG's merchant API knows the transaction too (the reversal's lookup).
  sandboxAddHistory({ transactionId: txn, status: 'approved', amountMinor: amount * 100, currencyCode: 'GYD' });
  return { ...s, checkoutId: row.id, txn, amount };
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
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'fee-refund-case', deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  admin = { token, userId: user.id };
}, 120_000);

beforeEach(() => {
  reversalCalls.length = 0;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlert: { title: FEE_REFUND_OVERDUE_TITLE } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { title: FEE_REFUND_OVERDUE_TITLE } }).catch(() => {});
    await removeCases({ subscriptionId: { in: subIds } });
    await app.prisma.mmgFeeReversal.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.$transaction(async (tx) => {
      await tx.mmgCheckoutPart.deleteMany({ where: { checkoutId: { in: chainIntentIds } } });
      await tx.mmgCheckoutIntent.deleteMany({ where: { id: { in: chainIntentIds } } });
    });
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
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:fee-refund-case').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }, 'test-cleanup:fee-refund-case');
  sandboxResetMmg();
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = kekBefore;
  if (switchBefore === undefined) delete process.env[MMG_FEE_REVERSAL_SWITCH]; else process.env[MMG_FEE_REVERSAL_SWITCH] = switchBefore;
  resetKeyProviderForTests();
});


const ONCALL = testPhone();
const ROUTE = (checkoutId: string) => `/api/v1/admin/billing/mmg-checkouts/${checkoutId}/refund-case`;
const headers = (token = admin.token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON });
const open = (checkoutId: string, kind = 'DUPLICATE') => app.inject({ method: 'POST', url: ROUTE(checkoutId), headers: headers(), payload: { kind, reason: REASON } });
const caseOf = (checkoutId: string) => runWithoutTenant(() => app.prisma.feeRefundCase.findUniqueOrThrow({ where: { checkoutId } }), 'test-read:fee-refund-case');
const asTenant = <T>(run: () => Promise<T>) => runWithTenant('swift-default', run);
const ask = (checkoutId: string, amountGyd: number) => asTenant(() =>
  reversals.requestReversal({ tenantId: 'swift-default', checkoutId, amountGyd, reason: REASON, actorId: admin.userId, approvalId: null }, async () => {}));
const deps = (who = [admin.userId]) => ({ prisma: app.prisma, redis: app.redis, notifications, resolveRecipients: async () => who });
const sweep = (now = new Date()) => runWithoutTenant(() => sweepFeeRefundCases(deps(), now), 'test:fee-refund-case');
const pages = () => runWithoutTenant(() => app.prisma.opsAlert.findMany({ where: { title: FEE_REFUND_OVERDUE_TITLE }, orderBy: { createdAt: 'asc' } }), 'test-read:fee-refund-case');
const texts = () => devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL);
const raw = (sql: string, ...values: unknown[]) => runWithoutTenant(() => app.prisma.$executeRawUnsafe(sql, ...values), 'test-write:fee-refund-case');
const AFTER_DUE = (row: { dueBy: Date }) => new Date(row.dueBy.getTime() + 60_000);

async function clearOverdue() {
  await app.redis.del(FEE_REFUND_OVERDUE_KEY);
  await runWithoutTenant(async () => {
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlert: { title: FEE_REFUND_OVERDUE_TITLE } } });
    await app.prisma.opsAlert.deleteMany({ where: { title: FEE_REFUND_OVERDUE_TITLE } });
    await removeCases({ state: 'OPEN' });
  }, 'test-cleanup:fee-refund-case');
  resetDevChannelLog();
}

// ---------------------------------------------------------------------------
// [Row 156 · owner 1 Oct 2026] "Weekly-fee refunds: none, except a duplicate or
// mistaken payment, refunded through MMG within 3 business days." Asserted, on
// real checkouts and the real return:
//  1. the clock: 3 Monday-to-Friday days after the ask, Guyana time, no holiday list;
//  2. recording the ask needs an admin, a reason and the right to do it, writes
//     an audit row, and moves no money and asks MMG nothing;
//  3. a case closes on a REVERSED reversal of this very payment and nothing else,
//     and the database itself refuses any other way, so a typed number never can;
//  4. a case MMG cannot serve stays open, and goes overdue, even with the switch off;
//  5. overdue cases share ONE platform page: GSM-7, one part, inside the SMS cap,
//     never an SOS, closed when none is overdue.
// ---------------------------------------------------------------------------

describe('[Row 156 1] the clock', () => {
  const guyana = (iso: string) => new Date(`${iso}-04:00`);
  it.each([
    ['Monday', '2026-11-02T10:00:00', '2026-11-05'],
    ['Tuesday', '2026-11-03T10:00:00', '2026-11-06'],
    ['Wednesday', '2026-11-04T10:00:00', '2026-11-09'],
    ['Thursday', '2026-11-05T10:00:00', '2026-11-10'],
    ['Friday', '2026-11-06T10:00:00', '2026-11-11'],
    ['Saturday', '2026-11-07T10:00:00', '2026-11-11'],
    ['Sunday', '2026-11-08T10:00:00', '2026-11-11'],
    ['a Friday night, already Saturday in UTC', '2026-11-06T22:30:00', '2026-11-11'],
    ['a Sunday night, already Monday in UTC', '2026-11-08T22:30:00', '2026-11-11'],
  ])('asked on %s: due at the end of the third working day after it, Guyana time', (_name, asked, day) => {
    expect(businessDaysDue(guyana(asked)).toISOString()).toBe(guyana(`${day}T23:59:59.999`).toISOString());
  });

  it('a public holiday counts as a working day: the date only ever falls early, never late', () => {
    // 25 and 26 December 2026 are a Friday and a Saturday; the Friday is counted.
    expect(businessDaysDue(guyana('2026-12-23T10:00:00')).toISOString()).toBe(guyana('2026-12-28T23:59:59.999').toISOString());
  });
});

describe('[Row 156 2] recording the ask', () => {
  it('opens a case on a confirmed payment: the clock, the words, an audit row, and no money moved', async () => {
    const p = await paidCheckout();
    const wallet = await walletOf(p.subId);
    const before = Date.now();
    const res = await open(p.checkoutId, 'MISTAKEN');
    expect(res.statusCode).toBe(200);
    const row = await caseOf(p.checkoutId);
    expect(row).toMatchObject({ state: 'OPEN', kind: 'MISTAKEN', reason: REASON, openedByUserId: admin.userId, subscriptionId: p.subId, tenantId: 'swift-default', currencyCode: 'GYD', reversalId: null, refundedAt: null });
    expect(Number(row.amount)).toBe(p.amount);
    expect(row.dueBy.toISOString()).toBe(businessDaysDue(new Date(before)).toISOString());
    expect(res.json().data).toMatchObject({ id: row.id, state: 'OPEN', overdue: false, amount: p.amount });
    // no money, no MMG
    expect(await walletOf(p.subId)).toBe(wallet);
    expect(reversalCalls).toEqual([]);
    expect(await runWithoutTenant(() => app.prisma.mmgFeeReversal.count({ where: { checkoutId: p.checkoutId } }), 'test-read:fee-refund-case')).toBe(0);
    // the audit row names the case
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findFirst({ where: { userId: admin.userId, changes: { path: ['caseId'], equals: row.id } } }), 'test-read:fee-refund-case');
    expect(audit).not.toBeNull();
  });

  it('reads back on the payment and in the list, the nearest due date first', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const one = await app.inject({ method: 'GET', url: ROUTE(p.checkoutId), headers: headers() });
    expect(one.json().data).toMatchObject({ checkoutId: p.checkoutId, state: 'OPEN' });
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/billing/fee-refund-cases?state=OPEN', headers: headers() });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((c: { checkoutId: string }) => c.checkoutId)).toContain(p.checkoutId);
    const none = await paidCheckout();
    expect((await app.inject({ method: 'GET', url: ROUTE(none.checkoutId), headers: headers() })).json().data).toBeNull();
  });

  it('reading one is a sensitive read: on the payment-detail capability, recorded with ids only, never what the partner said', async () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /billing/fee-refund-cases']).toMatchObject({ cls: 'C1', capability: 'billing.mmg.read' });
    expect(ADMIN_ROUTE_AUTHORITY['GET /billing/mmg-checkouts/:id/refund-case']).toMatchObject({ cls: 'C1', capability: 'billing.mmg.read' });
    const p = await paidCheckout();
    await open(p.checkoutId);
    const row = await caseOf(p.checkoutId);
    const read = { authorization: `Bearer ${admin.token}` };
    expect((await app.inject({ method: 'GET', url: ROUTE(p.checkoutId), headers: read })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/billing/fee-refund-cases?state=OPEN', headers: read })).statusCode).toBe(200);
    const rowsOf = (queryType: string) => runWithoutTenant(() => app.prisma.auditLog.findMany({ where: { userId: admin.userId, changes: { path: ['queryType'], equals: queryType } }, orderBy: { createdAt: 'desc' }, take: 1 }), 'test-read:fee-refund-case');
    const [one] = await rowsOf('REFUND_CASE');
    const [list] = await rowsOf('REFUND_CASES');
    expect(one!.changes).toMatchObject({ checkoutId: p.checkoutId, matchedIds: row.id, matchedCount: 1 });
    expect((list!.changes as { matchedIds: string }).matchedIds).toContain(row.id);
    for (const audit of [one!, list!]) expect(JSON.stringify(audit.changes)).not.toContain(REASON);

    const none = await paidCheckout();
    expect((await app.inject({ method: 'GET', url: ROUTE(none.checkoutId), headers: read })).json().data).toBeNull();
    const [empty] = await rowsOf('REFUND_CASE');
    expect(empty!.changes).toMatchObject({ checkoutId: none.checkoutId, matchedIds: '', matchedCount: 0 });
  });

  it('a pay-all payment has no single payer: refused by name', async () => {
    const s = await makeSub();
    const owner = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId: s.userId } });
    const intent = await app.prisma.$transaction(async (tx) => {
      const made = await tx.mmgCheckoutIntent.create({ data: {
        tenantId: 'swift-default', chainOwnerId: owner.id, merchantTransactionId: `${Date.now()}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`.padEnd(18, '0').slice(0, 18), amount: FEE, currencyCode: 'GYD',
        createdByUserId: s.userId, platform: 'ios', checkoutUrlSealed: new Uint8Array(40).fill(1), checkoutUrlDek: new Uint8Array(40).fill(1), expiresAt: new Date(Date.now() + 600_000),
      } as never });
      await tx.mmgCheckoutPart.create({ data: { tenantId: made.tenantId, checkoutId: made.id, subscriptionId: s.subId, amount: FEE, currencyCode: 'GYD' } });
      return made;
    });
    chainIntentIds.push(intent.id);
    const res = await open(intent.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHAIN_CHECKOUT');
  });

  it('another market reaches neither a payment nor a case', async () => {
    const held = await paidCheckout();
    await open(held.checkoutId);
    const free = await paidCheckout();
    const elsewhere = 'another-market';
    await expect(runWithoutTenant(() => openFeeRefundCase(app.prisma, { tenantId: elsewhere, checkoutId: free.checkoutId, kind: 'DUPLICATE', reason: REASON, actorId: admin.userId }, async () => {}), 'test:fee-refund-case'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await runWithoutTenant(() => feeRefundCaseOf(app.prisma, { tenantId: elsewhere, checkoutId: held.checkoutId }), 'test-read:fee-refund-case')).toBeNull();
    expect(await runWithoutTenant(() => listFeeRefundCases(app.prisma, { tenantId: elsewhere }), 'test-read:fee-refund-case')).toEqual([]);
  });

  it('one case per payment, even at the same moment', async () => {
    const p = await paidCheckout();
    const both = await Promise.all([open(p.checkoutId), open(p.checkoutId)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.statusCode === 409)!.json().error.code).toBe('REFUND_CASE_EXISTS');
    expect((await open(p.checkoutId)).statusCode).toBe(409);
  });

  it('needs a reason: nothing is written without one', async () => {
    const p = await paidCheckout();
    const res = await app.inject({ method: 'POST', url: ROUTE(p.checkoutId), headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, payload: { kind: 'DUPLICATE' } });
    expect(res.statusCode).toBe(400);
    expect(await runWithoutTenant(() => app.prisma.feeRefundCase.count({ where: { checkoutId: p.checkoutId } }), 'test-read:fee-refund-case')).toBe(0);
  });

  it('takes a duplicate or a mistaken payment, nothing else, and no typed MMG number at all', async () => {
    const p = await paidCheckout();
    expect((await open(p.checkoutId, 'GOODWILL')).statusCode).toBe(400);
    const typed = await app.inject({ method: 'POST', url: ROUTE(p.checkoutId), headers: headers(), payload: { kind: 'DUPLICATE', reason: REASON, reversalId: 'typed', mmgReference: 'TYPED123', state: 'REFUNDED', amountGyd: 1 } });
    expect(typed.statusCode).toBe(200);
    expect(await caseOf(p.checkoutId)).toMatchObject({ state: 'OPEN', reversalId: null });
    expect(Number((await caseOf(p.checkoutId)).amount)).toBe(p.amount);
  });

  it('a payment not confirmed by MMG has nothing to give back', async () => {
    const s = await makeSub();
    const { checkout } = await checkoutService.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'ios', clientKey: `rcase-${nanoid(12)}` });
    const res = await open(checkout.ref);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_CONFIRMED');
  });

  it('a payment already returned has no case to open; a checkout that does not exist is a 404', async () => {
    const p = await paidCheckout();
    await ask(p.checkoutId, p.amount);
    const res = await open(p.checkoutId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_REVERSED');
    expect((await open('no-such-checkout')).statusCode).toBe(404);
  });

  it('an admin without the right is refused, and a partner never reaches it', async () => {
    const p = await paidCheckout();
    const narrow = await runWithoutTenant(() => app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Narrow', lastName: `Admin${RUN}`, roles: ['ADMIN'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['billing.read'] } },
    } }), 'test-fixture:fee-refund-case');
    userIds.push(narrow.id);
    const token = app.jwt.sign({ userId: narrow.id, role: 'ADMIN', jti: nanoid(8) });
    await runWithoutTenant(() => app.prisma.session.create({ data: { userId: narrow.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'fee-refund-case', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }), 'test-fixture:fee-refund-case');
    const res = await app.inject({ method: 'POST', url: ROUTE(p.checkoutId), headers: headers(token), payload: { kind: 'DUPLICATE', reason: REASON } });
    expect(res.statusCode).toBe(403);
    const partner = app.jwt.sign({ userId: p.userId, role: 'VENDOR_OWNER', jti: nanoid(8) });
    await runWithoutTenant(() => app.prisma.session.create({ data: { userId: p.userId, token: partner, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'fee-refund-case', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }), 'test-fixture:fee-refund-case');
    expect((await app.inject({ method: 'POST', url: ROUTE(p.checkoutId), headers: headers(partner), payload: { kind: 'DUPLICATE', reason: REASON } })).statusCode).toBe(403);
    expect(await runWithoutTenant(() => app.prisma.feeRefundCase.count({ where: { checkoutId: p.checkoutId } }), 'test-read:fee-refund-case')).toBe(0);
  });
});

describe('[Row 156 3] a case closes on MMG\'s proof and nothing else', () => {
  it('a return MMG\'s lookup proved closes it, naming that reversal and its moment', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const reversal = await ask(p.checkoutId, p.amount);
    expect(reversal.state).toBe('REVERSED');
    expect((await sweep()).refunded).toBe(1);
    const row = await caseOf(p.checkoutId);
    expect(row).toMatchObject({ state: 'REFUNDED', reversalId: reversal.id });
    expect(row.refundedAt?.toISOString()).toBe(reversal.reversedAt?.toISOString());
    expect((await sweep()).refunded).toBe(0);
  });

  it.each([
    ['MMG refused', 'declined', 'FAILED'],
    ['MMG gave no answer', 'error', 'HELD'],
    ['MMG said it is working on it', 'pending', 'SENT'],
  ])('%s: the case stays open', async (_name, script, state) => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    sandboxScriptReversal(p.txn, script as never);
    expect((await ask(p.checkoutId, p.amount)).state).toBe(state);
    expect((await sweep()).refunded).toBe(0);
    expect(await caseOf(p.checkoutId)).toMatchObject({ state: 'OPEN', reversalId: null });
  });

  it('another payment\'s return closes nothing', async () => {
    const mine = await paidCheckout();
    const other = await paidCheckout();
    await open(mine.checkoutId);
    await ask(other.checkoutId, other.amount);
    expect((await sweep()).refunded).toBe(0);
    expect((await caseOf(mine.checkoutId)).state).toBe('OPEN');
  });

  it('the database refuses every other close, whoever writes it', async () => {
    const p = await paidCheckout();
    const other = await paidCheckout();
    await open(p.checkoutId);
    const otherReversal = await ask(other.checkoutId, other.amount);
    const held = await paidCheckout();
    await open(held.checkoutId);
    sandboxScriptReversal(held.txn, 'error');
    const heldReversal = await ask(held.checkoutId, held.amount);
    const row = await caseOf(p.checkoutId);
    const close = (id: string, reversalId: string | null) => raw(`UPDATE fee_refund_cases SET state = 'REFUNDED', "reversalId" = $1, "refundedAt" = now() WHERE id = $2`, reversalId, id);
    await expect(close(row.id, null)).rejects.toThrow(/fee_refund_cases_closed_check|only MMG's proof/);
    await expect(close(row.id, 'typed-by-a-person')).rejects.toThrow(/only MMG's proof/);
    await expect(close(row.id, otherReversal.id)).rejects.toThrow(/only MMG's proof/);
    await expect(close((await caseOf(held.checkoutId)).id, heldReversal.id)).rejects.toThrow(/only MMG's proof/);
    expect((await caseOf(p.checkoutId)).state).toBe('OPEN');
  });

  it('what was asked is written once, a case is born open, and a refunded case is final', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const row = await caseOf(p.checkoutId);
    for (const change of [`amount = 1`, `reason = 'x'`, `kind = 'MISTAKEN'`, `"dueBy" = now() + interval '30 days'`, `"openedByUserId" = 'x'`, `"subscriptionId" = 'x'`, `"checkoutId" = 'x'`]) {
      await expect(raw(`UPDATE fee_refund_cases SET ${change} WHERE id = $1`, row.id), change).rejects.toThrow(/written once|violates foreign key/);
    }
    const q = await paidCheckout();
    await expect(raw(`INSERT INTO fee_refund_cases (id, "tenantId", "subscriptionId", "checkoutId", kind, reason, "openedByUserId", amount, "currencyCode", "dueBy", state, "reversalId", "refundedAt", "updatedAt")
      VALUES ('x-${nanoid(6)}', 'swift-default', $1, $2, 'DUPLICATE', 'x', 'x', 1, 'GYD', now(), 'REFUNDED', 'y', now(), now())`, q.subId, q.checkoutId)).rejects.toThrow(/born OPEN/);
    const reversal = await ask(p.checkoutId, p.amount);
    await sweep();
    await expect(raw(`UPDATE fee_refund_cases SET state = 'OPEN', "reversalId" = NULL, "refundedAt" = NULL WHERE id = $1`, row.id)).rejects.toThrow(/final/);
    await expect(raw(`UPDATE fee_refund_cases SET "refundedAt" = now() WHERE id = $1`, row.id)).rejects.toThrow(/final/);
    expect((await caseOf(p.checkoutId)).reversalId).toBe(reversal.id);
  });

  /** MMG returned it after the money had paid for a week: a person closes the return on MMG's proof, and the wallet stays. */
  const returnedNotBooked = async (p: { checkoutId: string; subId: string; txn: string; amount: number }, reference: string) => {
    sandboxScriptReversal(p.txn, 'pending');
    const sent = await ask(p.checkoutId, p.amount);
    await app.prisma.prepaidBalance.update({ where: { subscriptionId: p.subId }, data: { balance: 0 } });
    sandboxSetTxStatus(p.txn, 'reversed');
    const held = await asTenant(() => reversals.check({ tenantId: 'swift-default', reversalId: sent.id }));
    expect(held).toMatchObject({ state: 'HELD', heldReason: 'WALLET_NO_LONGER_HOLDS_IT' });
    return asTenant(() => reversals.resolveHeld({ tenantId: 'swift-default', reversalId: held.id, outcome: 'RETURNED_NOT_BOOKED', mmgReference: reference, actorId: admin.userId }, async () => {}));
  };

  it('a return closed as returned, not booked, closes the case: MMG proved the money went back', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const closed = await returnedNotBooked(p, `CASEB${seq}`);
    expect(closed).toMatchObject({ state: 'FAILED', resolution: 'RETURNED_NOT_BOOKED' });
    expect((await sweep()).refunded).toBe(1);
    const row = await caseOf(p.checkoutId);
    expect(row).toMatchObject({ state: 'REFUNDED', reversalId: closed.id });
    expect(row.refundedAt?.toISOString()).toBe(closed.failedAt?.toISOString());
  });

  it('no case opens on such a payment: the return\'s own rule says it went back', async () => {
    const p = await paidCheckout();
    await returnedNotBooked(p, `CASEC${seq}`);
    const res = await open(p.checkoutId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_REVERSED');
  });

  it('a person\'s "not returned" is not proof: the sweep leaves it and the database refuses it', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    sandboxScriptReversal(p.txn, 'error');
    const held = await ask(p.checkoutId, p.amount);
    expect(held.state).toBe('HELD');
    const answered = await asTenant(() => reversals.resolveHeld({ tenantId: 'swift-default', reversalId: held.id, outcome: 'NOT_RETURNED', mmgReference: `CASED${seq}`, actorId: admin.userId }, async () => {}));
    expect(answered).toMatchObject({ state: 'FAILED', resolution: 'NOT_RETURNED' });
    expect((await sweep()).refunded).toBe(0);
    const row = await caseOf(p.checkoutId);
    await expect(raw(`UPDATE fee_refund_cases SET state = 'REFUNDED', "reversalId" = $1, "refundedAt" = now() WHERE id = $2`, held.id, row.id)).rejects.toThrow(/only MMG's proof/);
  });

  it('a case is never deleted, whoever asks', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const row = await caseOf(p.checkoutId);
    await expect(raw('DELETE FROM fee_refund_cases WHERE id = $1', row.id)).rejects.toThrow(/a case is never deleted/);
    expect(await caseOf(p.checkoutId)).toMatchObject({ id: row.id, state: 'OPEN' });
  });

  it('no route or console word can close one: the module writes REFUNDED in the sweep alone', () => {
    const module = readFileSync(join(__dirname, '..', 'modules', 'billing', 'fee-refund-case.ts'), 'utf8');
    expect(module.match(/state: 'REFUNDED'/g)).toHaveLength(1);
    const routes = readFileSync(join(__dirname, '..', 'modules', 'admin', 'admin.routes.ts'), 'utf8');
    expect(routes).not.toMatch(/feeRefundCase\.(update|updateMany|upsert)/);
  });
});

describe('[Row 156 4 + 5] overdue: one bounded platform page', () => {
  beforeEach(async () => { await clearOverdue(); process.env['OPS_ONCALL_PHONES'] = ONCALL; });

  it('with the switch off a case still opens, the return is refused, and it goes overdue', async () => {
    const p = await paidCheckout();
    delete process.env[MMG_FEE_REVERSAL_SWITCH];
    try {
      expect((await open(p.checkoutId)).statusCode).toBe(200);
      await expect(ask(p.checkoutId, p.amount)).rejects.toMatchObject({ code: 'REVERSAL_OFF' });
    } finally { process.env[MMG_FEE_REVERSAL_SWITCH] = 'on'; }
    const row = await caseOf(p.checkoutId);
    expect(await sweep(AFTER_DUE(row))).toEqual({ refunded: 0, overdue: 1 });
    expect((await caseOf(p.checkoutId)).state).toBe('OPEN');
    expect(await pages()).toHaveLength(1);
  });

  it('nothing pages before the due date', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const row = await caseOf(p.checkoutId);
    expect(await sweep(new Date(row.dueBy.getTime() - 60_000))).toEqual({ refunded: 0, overdue: 0 });
    expect(await pages()).toHaveLength(0);
  });

  it('is a platform page, never an SOS: one text, GSM-7, one part, and every overdue case shares it', async () => {
    const a = await paidCheckout(); const b = await paidCheckout();
    await open(a.checkoutId); await open(b.checkoutId);
    const when = AFTER_DUE(await caseOf(b.checkoutId));
    expect((await sweep(when)).overdue).toBe(2);
    await sweep(when);
    const [page, ...rest] = await pages();
    expect(rest).toEqual([]);
    expect(page).toMatchObject({ kind: 'PLATFORM', tenantId: null, sosAlertId: null });
    expect(page!.body).toContain('2 weekly-fee refund case(s) are past their 3 business days.');
    expect(texts()).toHaveLength(1);
    expect(isGsm7Message(texts()[0]!.body)).toBe(true);
    expect(gsm7Parts(texts()[0]!.body)).toBe(1);
    expect(texts()[0]!.body).toBe(`Swift ops: ${FEE_REFUND_OVERDUE_TITLE}. Acknowledge it in Mission Control > Ops alerts.`);
    expect(alertClassOf('ops_fee_refund_overdue')).toBe('standard');
    // the SMS cap holds it: no reminder inside 2 hours
    const t0 = page!.createdAt.getTime();
    for (const s of [300, 900, 3600, 7000]) await runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications, getChannels().sms, { now: new Date(t0 + s * 1000), limit: 100, alertIds: [page!.id], smsDay: app.redis }), 'test:fee-refund-case');
    expect(texts()).toHaveLength(1);
  });

  it('a second case overdue after the page closed pages at once, not a day later', async () => {
    const first = await paidCheckout();
    await open(first.checkoutId);
    const due = AFTER_DUE(await caseOf(first.checkoutId));
    await sweep(due);
    expect(await pages()).toHaveLength(1);
    await ask(first.checkoutId, first.amount);
    expect(await sweep(due)).toEqual({ refunded: 1, overdue: 0 });
    const second = await paidCheckout();
    await open(second.checkoutId);
    await sweep(AFTER_DUE(await caseOf(second.checkoutId)));
    const rows = await pages();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.closedAt).toBeNull();
  });

  it('closes when nothing is overdue any more', async () => {
    const p = await paidCheckout();
    await open(p.checkoutId);
    const row = await caseOf(p.checkoutId);
    await sweep(AFTER_DUE(row));
    expect((await pages())[0]!.closedAt).toBeNull();
    await ask(p.checkoutId, p.amount);
    expect(await sweep(AFTER_DUE(row))).toEqual({ refunded: 1, overdue: 0 });
    expect((await pages())[0]).toMatchObject({ closeReason: 'no-refund-overdue' });
    expect((await pages())[0]!.closedAt).not.toBeNull();
  });
});

describe('[Row 156] the job', () => {
  it('is a registered, replay-safe job every fifteen minutes', () => {
    expect(JOB_RECOVERY['fee-refund-case-sweep']).toMatchObject({ policy: 'SAFE_REPLAY' });
    const queue = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');
    expect(queue).toMatch(/verificationQueue\.add\('fee-refund-case-sweep', \{\}, \{\s*repeat: \{ every: 15 \* 60_000 \}/);
  });
});
