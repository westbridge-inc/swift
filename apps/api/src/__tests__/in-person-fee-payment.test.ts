import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { loginWithOtp } from './helpers/otp';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { beginConfirmationInTx } from '../modules/billing/dunning-clock';
import { noLivePayPath } from '../modules/billing/fee-pause';
import { feeReceiptDocument } from '../modules/billing/fee-receipt';
import { validateInPersonAsk } from '../modules/billing/in-person-payment';
import { ensureLedgerAccounts } from '../modules/billing/ledger';
import { runWithTenant } from '../plugins/tenant-context';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [OWNER 5 Nov 2026] A weekly fee paid directly to Westbridge Inc. in person, by
// cash, cheque or bank transfer, recorded in the console. Its own door: it works
// while BILLING_TOPUP_HOLD=1 keeps the top-up and agent cash off, and it takes
// every rule of the MMG door except the money rail.
// ---------------------------------------------------------------------------

const PHONE_BASE = 592_019_000_000 + Math.floor(Math.random() * 8_000_000);
const WEEK = 7 * 86_400_000;
let app: FastifyInstance;
let adminToken: string;
let plainAdminToken: string;
let billing: BillingService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

type SubOverrides = Partial<{ status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'PAUSED'; feeWaived: boolean; currencyCode: string; nextBillingDate: Date; isTrialActive: boolean; trialEndDate: Date }>;

async function makeSub(over: SubOverrides = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Paid', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Counter Kitchen ${seq}`, slug: `counter-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${PHONE_BASE + 700_000 + seq}`,
      addressLine1: '8 Command St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const next = over.nextBillingDate ?? new Date(Date.now() + 3 * 86_400_000);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: over.status ?? 'ACTIVE', weeklyRate: 5000, billingMethod: 'CASH',
      currentPeriodStart: new Date(next.getTime() - WEEK), currentPeriodEnd: next, nextBillingDate: next,
      feeWaived: over.feeWaived ?? false, currencyCode: over.currencyCode ?? 'GYD',
      isTrialActive: over.isTrialActive ?? false, trialEndDate: over.trialEndDate ?? null,
    },
  });
  subIds.push(sub.id);
  return sub;
}

const ref = (prefix: string) => `${prefix}-${nanoid(10).replace(/[_-]/g, 'X').toUpperCase()}`;
const headers = (token = adminToken) => ({ 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const url = (id: string) => `/api/v1/admin/subscriptions/${id}/in-person-payment`;
const cash = (over: Record<string, unknown> = {}) => ({ method: 'CASH', amount: 5000, reference: ref('RCPT'), receipt: 'PRINTED', ...over });
const cheque = (over: Record<string, unknown> = {}) => ({ method: 'CHEQUE', amount: 5000, reference: ref('CHQ'), cleared: true, ...over });
const transfer = (over: Record<string, unknown> = {}) => ({ method: 'BANK_TRANSFER', amount: 5000, reference: ref('BANK'), seenInBank: true, ...over });
const pay = (id: string, payload: Record<string, unknown>, token = adminToken) => injectWithApproval(app, { method: 'POST', url: url(id), payload, headers: headers(token) });
const ask = (id: string, payload: Record<string, unknown>, token = adminToken) => app.inject({ method: 'POST', url: url(id), payload, headers: headers(token) });
const code = (res: { json: () => any }) => res.json().error?.code ?? res.json().code;
const asks = (id: string) => app.prisma.privilegedApproval.count({ where: { entityId: id, action: 'POST /subscriptions/:id/in-person-payment' } });
const credits = (id: string) => app.prisma.billingEvent.count({ where: { subscriptionId: id, type: 'PREPAID_TOPUP' } });
const balance = async (id: string) => Number((await app.prisma.prepaidBalance.findUnique({ where: { subscriptionId: id } }))?.balance ?? 0);
let secondToken: string | null = null;
/** A second admin who decides an ask, so the test can act between the decision and the Execute button. */
async function approve(approvalId: string) {
  if (!secondToken) {
    const second = await app.prisma.user.create({ data: { phone: `+${PHONE_BASE + 800_000}`, firstName: 'Two', lastName: 'Admin', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
    userIds.push(second.id);
    secondToken = app.jwt.sign({ userId: second.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: second.id, token: secondToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'in-person-two', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  }
  const res = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, headers: headers(secondToken), payload: { approve: true, note: 'Seen the receipt book' } });
  expect(res.statusCode).toBe(200);
}
const execute = (approvalId: string) => app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/apply`, headers: headers() });
const entries = (idempotencyKey: string) => app.prisma.ledgerEntry.findMany({ where: { transaction: { idempotencyKey } }, select: { accountCode: true, debit: true, credit: true, subledgerId: true } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // What production runs: top-ups and agent cash held.
  process.env['BILLING_TOPUP_HOLD'] = '1';
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
  await ensureLedgerAccounts(app.prisma);
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken; // seeded SUPER_ADMIN
  const plain = await app.prisma.user.create({
    data: { phone: `+${PHONE_BASE + 900_000}`, firstName: 'Plain', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
  });
  userIds.push(plain.id);
  plainAdminToken = app.jwt.sign({ userId: plain.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: plain.id, token: plainAdminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'in-person-plain', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterEach(() => { delete process.env['MMG_DRIVER']; });

afterAll(async () => {
  delete process.env['BILLING_TOPUP_HOLD'];
  await app.prisma.privilegedApproval.deleteMany({ where: { entityId: { in: subIds } } });
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await purgeAuditLogs(app.prisma, { entity: 'Subscription', entityId: { in: subIds } }, 'test-cleanup:in-person-fee');
  await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await cleanupSecondApprovers(app);
  await app.close();
});

describe('the door works while the hold stands, and the hold still holds', () => {
  it('under BILLING_TOPUP_HOLD=1 the top-up is refused and an in-person payment records', async () => {
    const sub = await makeSub();
    const held = await injectWithApproval(app, { method: 'POST', url: `/api/v1/admin/subscriptions/${sub.id}/topup`, payload: { amount: 5000, reference: ref('BANK') }, headers: { ...headers(), 'idempotency-key': `attempt-${nanoid(12)}` } });
    expect(held.statusCode).toBe(503);
    expect(code(held)).toBe('TOPUP_ON_HOLD');
    const res = await pay(sub.id, cash());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: { balance: 5000, currencyCode: 'GYD' } });
    expect(await credits(sub.id)).toBe(1);
  });

  it('the production boot guard and the deploy guard for the hold are untouched', () => {
    const boot = readFileSync(join(__dirname, '../utils/boot-config.ts'), 'utf8');
    expect(boot).toContain("if (env['BILLING_TOPUP_HOLD'] !== '1') {");
    expect(readFileSync(join(__dirname, '../modules/billing/in-person-payment.ts'), 'utf8')).not.toMatch(/manualFeeCreditHeld|process\.env/);
  });
});

describe('one command: credit, receipt, ledger, audit, a notice', () => {
  it('cash lands in its own account, never MMG, with a receipt that says how it was paid', async () => {
    const sub = await makeSub();
    const body = cash();
    const res = await pay(sub.id, body);
    expect(res.statusCode).toBe(200);
    const key = `in-person:${body.reference}`;
    const event = await app.prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect(event).toMatchObject({ subscriptionId: sub.id, type: 'PREPAID_TOPUP', currencyCode: 'GYD' });
    expect(Number(event.amount)).toBe(5000);
    const posted = await entries(`ledger:${key}`);
    expect(posted.map((e) => [e.accountCode, Number(e.debit), Number(e.credit)]).sort()).toEqual([['CASH_ON_HAND', 5000, 0], ['WALLET_LIABILITY', 0, 5000]]);
    const receipt = await app.prisma.feeReceipt.findUniqueOrThrow({ where: { billingEventId: event.id } });
    expect(receipt).toMatchObject({ channel: 'IN_PERSON_CASH', mmgRef: body.reference });
    expect(res.json().data.receiptNumber).toBe(receipt.receiptNumber);
    const doc = await feeReceiptDocument(app.prisma, receipt.receiptNumber);
    expect(doc?.lines).toContain(`Paid in person to Westbridge Inc. by cash. Reference: ${body.reference}`);
    expect(doc?.lines).toContain('Not a VAT invoice');
    const audit = await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: sub.id, action: 'ADMIN POST /api/v1/admin/subscriptions/:id/in-person-payment', changes: { path: ['billingEventId'], equals: event.id } } });
    expect(audit.changes).toMatchObject({ method: 'CASH', amount: 5000, reference: body.reference, receipt: 'PRINTED', receiptNumber: receipt.receiptNumber });
    expect((audit.changes as Record<string, unknown>)['approvalId']).toBeTruthy();
    const command = await app.prisma.topUpCommand.findUniqueOrThrow({ where: { billingEventId: event.id } });
    expect(command).toMatchObject({ providerRef: `IN_PERSON:${body.reference}` });
    expect(command.tailDoneAt).not.toBeNull();
    const owner = await app.prisma.vendorOwner.findFirstOrThrow({ where: { vendors: { some: { id: sub.vendorId! } } } });
    expect(await app.prisma.notification.count({ where: { userId: owner.userId, title: 'Weekly fee received' } })).toBe(1);
    expect(posted.find((e) => e.accountCode === 'WALLET_LIABILITY')?.subledgerId).toBe(sub.id);
    expect(await balance(sub.id)).toBe(5000);
  });

  it.each([
    ['a cleared cheque', cheque, 'IN_PERSON_CHEQUE', 'by cheque (cleared)'],
    ['a bank transfer', transfer, 'IN_PERSON_BANK_TRANSFER', 'by bank transfer'],
  ])('%s lands in the bank account, never MMG', async (_name, make, channel, words) => {
    const sub = await makeSub();
    const body = make();
    expect((await pay(sub.id, body)).statusCode).toBe(200);
    const posted = await entries(`ledger:in-person:${body['reference']}`);
    expect(posted.map((e) => e.accountCode).sort()).toEqual(['BANK_LOCAL', 'WALLET_LIABILITY']);
    const receipt = await app.prisma.feeReceipt.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(receipt.channel).toBe(channel);
    expect((await feeReceiptDocument(app.prisma, receipt.receiptNumber))?.lines.join('\n')).toContain(words);
  });

  it('it runs through the real Apply button, which sends no idempotency key', async () => {
    const sub = await makeSub();
    const first = await ask(sub.id, cash());
    expect(first.statusCode).toBe(202);
    const id = first.json().error.details.approvalId as string;
    await approve(id);
    expect((await execute(id)).statusCode).toBe(200);
    expect(await balance(sub.id)).toBe(5000);
  });

  it('paying while behind reinstates through the same tail as every other payment', async () => {
    const sub = await makeSub({ status: 'PAST_DUE', nextBillingDate: new Date(Date.now() - 3_600_000) });
    expect((await pay(sub.id, cash())).statusCode).toBe(200);
    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.status).toBe('ACTIVE');
    expect(await balance(sub.id)).toBe(0);
    const receipt = await app.prisma.feeReceipt.findFirstOrThrow({ where: { subscriptionId: sub.id, channel: 'IN_PERSON_CASH' } });
    expect((await feeReceiptDocument(app.prisma, receipt.receiptNumber))?.lines.join('\n')).toMatch(/Week covered/);
  });
});

describe('who may ask', () => {
  it('a plain admin is refused before any ask exists', async () => {
    const sub = await makeSub();
    const res = await ask(sub.id, cash(), plainAdminToken);
    expect(res.statusCode).toBe(403);
    expect(await asks(sub.id)).toBe(0);
    expect(await credits(sub.id)).toBe(0);
  });

  it('nothing is credited without a second person: the first answer is the ask', async () => {
    const sub = await makeSub();
    const res = await ask(sub.id, cash());
    expect(res.statusCode).toBe(202);
    expect(code(res)).toBe('APPROVAL_REQUIRED');
    expect(await credits(sub.id)).toBe(0);
    await app.prisma.privilegedApproval.deleteMany({ where: { entityId: sub.id } });
  });

  it('the requester cannot approve their own ask', async () => {
    const sub = await makeSub();
    const id = (await ask(sub.id, cash())).json().error.details.approvalId as string;
    const self = await app.inject({ method: 'POST', url: `/api/v1/admin/approvals/${id}/decide`, headers: headers(), payload: { approve: true, note: 'Mine' } });
    expect(self.statusCode).toBeGreaterThanOrEqual(400);
    const replay = await app.inject({ method: 'POST', url: url(sub.id), payload: cash(), headers: { ...headers(), [APPROVAL_HEADER]: id } });
    expect(replay.statusCode).toBe(403);
    expect(await credits(sub.id)).toBe(0);
    await app.prisma.privilegedApproval.deleteMany({ where: { entityId: sub.id } });
  });
});

describe('an ask that could never be recorded is refused when it is asked', () => {
  it.each([
    ['no method', { amount: 5000, reference: 'RCPT-1234' }, 'VALIDATION_ERROR'],
    ['an agent as the method', { method: 'AGENT', amount: 5000, reference: 'RCPT-1234' }, 'VALIDATION_ERROR'],
    ['a Swift Number as the method', { method: 'SWIFT_NUMBER', amount: 5000, reference: 'RCPT-1234' }, 'VALIDATION_ERROR'],
    ['no reference', { method: 'CASH', amount: 5000, reference: '', receipt: 'PRINTED' }, 'IN_PERSON_REFERENCE_REQUIRED'],
    ['a reference that is not one', { method: 'CASH', amount: 5000, reference: '??', receipt: 'PRINTED' }, 'IN_PERSON_REFERENCE_INVALID'],
    ['cents', { method: 'CASH', amount: 5000.5, reference: 'RCPT-1234', receipt: 'PRINTED' }, 'VALIDATION_ERROR'],
    ['a zero amount', { method: 'CASH', amount: 0, reference: 'RCPT-1234', receipt: 'PRINTED' }, 'VALIDATION_ERROR'],
    ['cash with no receipt', { method: 'CASH', amount: 5000, reference: 'RCPT-1234' }, 'VALIDATION_ERROR'],
    ['a cheque not said to be cleared', { method: 'CHEQUE', amount: 5000, reference: 'CHQ-1234' }, 'VALIDATION_ERROR'],
    ['a cheque said not to be cleared', { method: 'CHEQUE', amount: 5000, reference: 'CHQ-1234', cleared: false }, 'VALIDATION_ERROR'],
    ['a transfer not seen in the bank', { method: 'BANK_TRANSFER', amount: 5000, reference: 'BANK-1234' }, 'VALIDATION_ERROR'],
    ['a field nobody asked for', { method: 'CASH', amount: 5000, reference: 'RCPT-1234', receipt: 'SENT', agentId: 'x' }, 'VALIDATION_ERROR'],
  ])('%s', async (_name, payload, expected) => {
    const sub = await makeSub();
    const res = await ask(sub.id, payload as Record<string, unknown>);
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe(expected);
    expect(await asks(sub.id)).toBe(0);
  });

  it('the cheque refusal says so in plain words', async () => {
    const sub = await makeSub();
    const res = await ask(sub.id, { method: 'CHEQUE', amount: 5000, reference: 'CHQ-1234', cleared: false });
    expect(JSON.stringify(res.json())).toContain('A cheque counts only once it has cleared');
  });

  it.each([
    ['a waived fee', { feeWaived: true }, 'FEE_NOT_PAYABLE'],
    ['stopped billing', { status: 'PAUSED' }, 'FEE_NOT_PAYABLE'],
    ['a cancelled account', { status: 'CANCELLED' }, 'FEE_NOT_PAYABLE'],
    ['an account not billed in GYD', { currencyCode: 'USD' }, 'IN_PERSON_GYD_ONLY'],
  ] as const)('%s', async (_name, over, expected) => {
    const sub = await makeSub(over as SubOverrides);
    const res = await ask(sub.id, cash());
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe(expected);
    expect(await asks(sub.id)).toBe(0);
  });
});

describe('an ask names a real account of this market', () => {
  it('an account that does not exist is not found, and nothing is asked', async () => {
    const res = await ask('no-such-subscription', cash());
    expect(res.statusCode).toBe(404);
    expect(await asks('no-such-subscription')).toBe(0);
  });

  it('another market cannot ask: its receipts are not ready, so it never waits for that refusal', async () => {
    const sub = await makeSub();
    await expect(runWithTenant('another-market', () => validateInPersonAsk(app.prisma, sub.id, cash())))
      .rejects.toMatchObject({ code: 'TENANT_BILLING_UNAVAILABLE' });
  });
});

describe('the MMG door\'s rules', () => {
  it('the one-week limit: the next week fits, the one after does not, and the refusal names what is left', async () => {
    const sub = await makeSub();
    const over = await ask(sub.id, cash({ amount: 6000 }));
    expect(over.statusCode).toBe(409);
    expect(code(over)).toBe('PAY_AHEAD_LIMIT');
    expect(JSON.stringify(over.json())).toContain('5,000');
    expect(await asks(sub.id)).toBe(0);
    expect((await pay(sub.id, cash())).statusCode).toBe(200);
    const full = await ask(sub.id, cash({ amount: 1000 }));
    expect(code(full)).toBe('PAY_AHEAD_LIMIT');
  });

  it('money that fills the room during the wait stops the approved request, and nothing is credited twice', async () => {
    const sub = await makeSub();
    const body = cash();
    const asked = await ask(sub.id, body);
    expect(asked.statusCode).toBe(202);
    const id = asked.json().error.details.approvalId as string;
    await approve(id);
    await billing.recordTopUp(sub.id, 5000, 'test-other-channel', undefined, `attempt-${nanoid(12)}`);
    const applied = await execute(id);
    expect(applied.statusCode).toBe(409);
    expect(JSON.stringify(applied.json())).toContain('already paid');
    expect(await balance(sub.id)).toBe(5000);
    expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `in-person:${body.reference}` } })).toBe(0);
  });

  it('a week that is due is not ahead: it fits on top of the limit', async () => {
    const sub = await makeSub({ status: 'PAST_DUE', nextBillingDate: new Date(Date.now() - 3_600_000) });
    expect((await ask(sub.id, cash({ amount: 10_001 }))).statusCode).toBe(409);
    expect((await pay(sub.id, cash({ amount: 10_000 }))).statusCode).toBe(200);
  });

  it('during a free trial the weeks of the trial are not ahead, and the limit still stands', async () => {
    const end = new Date(Date.now() + 10 * 86_400_000);
    const sub = await makeSub({ status: 'TRIAL', isTrialActive: true, trialEndDate: end, nextBillingDate: end });
    expect((await ask(sub.id, cash({ amount: 5001 }))).statusCode).toBe(409);
    expect((await pay(sub.id, cash())).statusCode).toBe(200);
    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh).toMatchObject({ status: 'TRIAL', isTrialActive: true });
    expect(fresh.nextBillingDate.getTime()).toBe(end.getTime());
    expect(await balance(sub.id)).toBe(5000);
  });

  it('while the fee is paused nothing is owed, so no money is taken', async () => {
    const sub = await makeSub();
    process.env['MMG_DRIVER'] = 'disabled';
    const res = await ask(sub.id, cash());
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('FEE_PAUSED');
    expect(await asks(sub.id)).toBe(0);
  });

  it('this door never counts as a live way to pay: the fee pause reads only the server\'s switches', async () => {
    const sub = await makeSub();
    expect((await pay(sub.id, cash())).statusCode).toBe(200);
    process.env['MMG_DRIVER'] = 'disabled';
    expect(await noLivePayPath(app.prisma)).toBe(true);
    expect(readFileSync(join(__dirname, '../modules/billing/fee-pause.ts'), 'utf8')).not.toMatch(/in-person|inPerson/);
  });

  it('a payment being confirmed blocks the ask, and blocks the approved request if it began during the wait', async () => {
    const asked = await makeSub();
    const waiting = await ask(asked.id, cash());
    expect(waiting.statusCode).toBe(202);
    const id = waiting.json().error.details.approvalId as string;
    await app.prisma.privilegedApproval.update({ where: { id }, data: { status: 'CANCELLED' } });

    const begin = (subscriptionId: string) => app.prisma.$transaction(async (tx) => {
      const payment = await tx.subscriptionPayment.create({ data: { subscriptionId, amount: 5000, paymentMethod: 'CARD', status: 'UNKNOWN', periodStart: new Date(), periodEnd: new Date(Date.now() + WEEK), clientKey: `in-person-${nanoid(8)}` } });
      await beginConfirmationInTx(tx, subscriptionId, { paymentId: payment.id }, 'CARD_AUTHORIZATION_PENDING', new Date());
    });
    await begin(asked.id);
    const refused = await ask(asked.id, cash());
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('PAYMENT_CONFIRMING');
    expect(await credits(asked.id)).toBe(0);

    const late = await makeSub();
    const body = cash();
    const lateAsk = await ask(late.id, body);
    expect(lateAsk.statusCode).toBe(202);
    const lateId = lateAsk.json().error.details.approvalId as string;
    await approve(lateId);
    await begin(late.id);
    const applied = await execute(lateId);
    expect(applied.statusCode).toBe(409);
    expect(JSON.stringify(applied.json())).toContain('is being confirmed');
    expect(await credits(late.id)).toBe(0);
  });
});

describe('one reference credits once', () => {
  it('the same reference on another account, by another method, or spelled in lower case is refused', async () => {
    const first = await makeSub();
    const second = await makeSub();
    const reference = ref('BOOK');
    expect((await pay(first.id, cash({ reference }))).statusCode).toBe(200);
    for (const res of [
      await ask(second.id, cash({ reference })),
      await ask(second.id, cheque({ reference })),
      await ask(second.id, transfer({ reference: reference.toLowerCase() })),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('IN_PERSON_REFERENCE_USED');
    }
    expect(await asks(second.id)).toBe(0);
  });

  it('two approved asks racing on one reference: exactly one credits', async () => {
    const [a, b] = [await makeSub(), await makeSub()];
    const reference = ref('RACE');
    const [x, y] = await Promise.all([pay(a.id, cash({ reference })), pay(b.id, cash({ reference }))]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect((await credits(a.id)) + (await credits(b.id))).toBe(1);
  });

  it('a reference that names money already on record elsewhere is refused', async () => {
    const other = await makeSub();
    const reference = ref('MMGTXN');
    await app.prisma.billingEvent.create({ data: { subscriptionId: other.id, type: 'PREPAID_TOPUP', amount: 100, currencyCode: 'GYD', idempotencyKey: `mmg-checkout:test:${nanoid(8)}`, paymentRef: reference } });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: other.id, balance: 100, currencyCode: 'GYD' } });
    const sub = await makeSub();
    const res = await ask(sub.id, transfer({ reference }));
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('IN_PERSON_REFERENCE_USED');
  });
});

describe('the refund is the credit refund, and its books are true', () => {
  const refundUrl = (id: string, step: string) => `/api/v1/admin/subscriptions/${id}/refund-credit/${step}`;
  const refundStep = (id: string, step: string, payload: Record<string, unknown>) => injectWithApproval(app, { method: 'POST', url: refundUrl(id, step), payload, headers: headers() });

  it.each([
    ['CASH', 'CASH_ON_HAND'],
    ['CHEQUE', 'BANK_LOCAL'],
    ['BANK_TRANSFER', 'BANK_LOCAL'],
  ])('money paid in person goes back by %s and leaves %s', async (method, account) => {
    const sub = await makeSub();
    expect((await pay(sub.id, cash())).statusCode).toBe(200);
    const aside = await refundStep(sub.id, 'set-aside', { amount: 5000 });
    expect(aside.statusCode).toBe(200);
    const setAsideId = aside.json().data.billingEventId as string;
    expect(await balance(sub.id)).toBe(0);
    const reference = ref('BACK');
    const paidBack = await refundStep(sub.id, 'paid', { amount: 5000, method, reference, setAsideId });
    expect(paidBack.statusCode).toBe(200);
    const posted = await entries(`ledger:credit-refund-paid:${reference}`);
    expect(posted.map((e) => [e.accountCode, Number(e.debit), Number(e.credit)]).sort()).toEqual([[account, 0, 5000], ['REFUND_PAYABLE', 5000, 0]].sort());
  });

  it('a refund can never name the in-person reference that brought the money in', async () => {
    const sub = await makeSub();
    const body = cash();
    expect((await pay(sub.id, body)).statusCode).toBe(200);
    const aside = await refundStep(sub.id, 'set-aside', { amount: 5000 });
    const res = await refundStep(sub.id, 'paid', { amount: 5000, method: 'CASH', reference: body.reference, setAsideId: aside.json().data.billingEventId });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('REFUND_REFERENCE_IS_A_PAYMENT');
  });

  it('money already used on a week is not there to refund: nothing is invented', async () => {
    const sub = await makeSub({ status: 'PAST_DUE', nextBillingDate: new Date(Date.now() - 3_600_000) });
    expect((await pay(sub.id, cash())).statusCode).toBe(200);
    const res = await refundStep(sub.id, 'set-aside', { amount: 5000 });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('NO_FEE_CREDIT');
  });
});

describe('finance reads them apart from MMG', () => {
  it('lists each payment with its method, totals each method, and shows the cash not yet banked; no names', async () => {
    const cashOnHand = async () => (await app.inject({ method: 'GET', url: '/api/v1/admin/finance/in-person-payments', headers: headers() })).json().data.cashOnHandGyd as number;
    const before = await cashOnHand();
    const sub = await makeSub();
    const body = transfer();
    expect((await pay(sub.id, body)).statusCode).toBe(200);
    const other = await makeSub();
    expect((await pay(other.id, cash())).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/in-person-payments', headers: headers() });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.rows.find((r: { reference: string }) => r.reference === body.reference)).toMatchObject({ method: 'BANK_TRANSFER', amount: 5000 });
    expect(data.totals.map((t: { method: string }) => t.method)).toEqual(expect.arrayContaining(['CASH', 'BANK_TRANSFER']));
    expect(data.cashOnHandGyd).toBe(before + 5000);
    expect(JSON.stringify(data)).not.toContain('Counter Kitchen');
  });

  it('an MMG receipt never appears in the list, and the cash journal names the channel', async () => {
    const sub = await makeSub();
    const mmg = await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'PREPAID_TOPUP', amount: 100, currencyCode: 'GYD', idempotencyKey: `mmg-checkout:test:${nanoid(8)}` } });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 100, currencyCode: 'GYD' } });
    const number = `SWF-TEST-${nanoid(8)}`;
    await app.prisma.feeReceipt.create({ data: { receiptNumber: number, subscriptionId: sub.id, billingEventId: mmg.id, amount: 100, channel: 'MMG_CHECKOUT', mmgRef: ref('MMG') } });
    const paid = await makeSub();
    const body = cheque();
    expect((await pay(paid.id, body)).statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/admin/finance/in-person-payments', headers: headers() })).json().data;
    expect(list.rows.map((r: { receiptNumber: string }) => r.receiptNumber)).not.toContain(number);
    expect(list.rows.every((r: { method: string | null }) => r.method !== null)).toBe(true);
    const journal = await app.inject({ method: 'GET', url: `/api/v1/admin/billing/cash-journal?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`, headers: headers() });
    expect(journal.statusCode).toBe(200);
    expect(journal.body).toContain('IN_PERSON_CHEQUE');
  });
});
