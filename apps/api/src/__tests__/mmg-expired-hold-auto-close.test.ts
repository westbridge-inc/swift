import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_CHECKOUT_TTL_MS, MmgCheckoutService, mmgCreationInstant } from '../modules/billing/mmg-checkout.service';
import { resolveFinanceConfirmation } from '../modules/billing/confirmation-finance';
import { readFeePaymentDecision } from '../modules/billing/fee-payment-authority';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { FakeMmgHistory, mmgHistoryRow, mmgTimeOf } from './helpers/mmg-history-fake';
import { testPhone } from './helpers/fixture-ids';
import { resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type SandboxCheckoutKeys } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, type MmgCheckoutLookupClient, type MmgHistoryAnswer, type MmgHistoryQuery, type MmgLookupDetail } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// [HOLD-AUTO · owner ruling 25 Oct "Auto-close via MMG check"] A partner opened
// the MMG weekly-fee page and left it: the checkout EXPIRED with no reply, and
// its payment-confirmation hold stayed ACTIVE (Pay button hidden, billing
// clock frozen) until two admins closed it as NOT PAID (staging, 25 Oct).
// Now Swift asks MMG's own records. ONLY when MMG's Transaction History,
// proven healthy by a control (the tenant's own confirmed checkout, read the
// same way, comes back as exactly its MMG record), covers the whole window
// and shows no payment that could be this checkout's, is the hold closed as
// NOT PAID by the system: audited, the admin close's records, nothing
// credited, the clock resumed as the admin close resumes it. A row that could
// match, a failed or partial read, a failed control, a reply, a settlement, a
// provider payment or a second-admin request already raised: nothing changes,
// the admins keep it as today, and MMG is asked again on a bounded schedule.
// Times: MMG is asked from the checkout's opening (less MMG's 2-minute
// tolerance and 10-minute margin) up to the check itself less 2 minutes
// [REVIEW-M S3-1: MMG's page may outlive our deadline, U8]; the first check is
// 42 minutes after the deadline, then 30m, 1h, 2h, 4h, 8h, 16h, 24h x3 (10).
// ---------------------------------------------------------------------------

const MIN = 60_000;
const DAY = 86_400_000;
const FIRST_CHECK = 42 * MIN;
const BACKOFF = [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 480 * MIN, 960 * MIN, DAY, DAY, DAY];
const ACTOR = 'mmg-history-check';
const AUDIT = 'MMG_EXPIRED_HOLD_AUTO_CLOSED';
const RESOLVE_ACTION = 'POST /billing/confirmations/:id/resolve';

let app: FastifyInstance;
let billing: BillingService;
let sandbox: SandboxMmgCheckoutProvider;
let keys: SandboxCheckoutKeys;
let service: MmgCheckoutService;
let kekBefore: string | undefined;

const lookups = new Map<string, MmgLookupDetail>();
const history = new FakeMmgHistory();
/** A fault MMG answers instead of its history, for the queries it matches. */
let historyFault: ((query: MmgHistoryQuery) => MmgHistoryAnswer | null) | null = null;
const lookup: MmgCheckoutLookupClient = {
  transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' },
  transactionHistoryRows: async (query) => historyFault?.(query) ?? history.transactionHistoryRows(query),
};
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
const uatAnswer = (txn: string, amountGyd: number): Record<string, unknown> => ({
  transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
  subType: 'subscriber_mpay', transactionReference: `L${txn}`,
  creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
  descriptionText: null,
});
/** MMG's lookup and history both hold this payment of the checkout, made now. */
function approved(checkout: { merchantTransactionId: string }, txn: string, amountGyd: number) {
  lookups.set(txn, { ...lookupDetailFrom(uatAnswer(txn, amountGyd), txn), echoedReferences: [checkout.merchantTransactionId] });
  history.holds(txn, amountGyd, { external_id: checkout.merchantTransactionId });
}

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const tenantIds: string[] = [];
const approvalIds: string[] = [];
const strayObservationIds: string[] = [];
let seq = 0;
const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const tx = (name: string) => `${name}${RUN}`;

async function makeSub(opts: { due?: Date; tenantId?: string } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Hold', lastName: `Auto${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
  } });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Hold Auto Store ${seq}`, slug: `hold-auto-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Checkout Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isVerified: true, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
  } });
  vendorIds.push(vendor.id);
  const due = opts.due ?? new Date(Date.now() - MIN);
  const sub = await app.prisma.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
    currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    prepaidBalance: { create: { balance: 0 } },
  } });
  subIds.push(sub.id);
  return { userId: user.id, subId: sub.id };
}
const key = () => `test-${nanoid(12)}`;
const start = (s: { subId: string; userId: string }) => service.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'ios', clientKey: key() });
const intentOf = (id: string) => app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id } });
const holdOf = (checkoutId: string) => app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { checkoutId } });
const clockOf = (subscriptionId: string) => app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
const checksOf = (intentId: string) => app.prisma.mmgCheckoutObservation.findMany({ where: { intentId, source: 'HISTORY', detail: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const auditsOf = (holdId: string) => app.prisma.auditLog.findMany({ where: { entityId: holdId, action: AUDIT } });
const topups = (subscriptionId: string) => app.prisma.billingEvent.count({ where: { subscriptionId, type: 'PREPAID_TOPUP' } });
const walletOf = async (subscriptionId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } })).balance);
const replyFor = (merchantTransactionId: string, txn: string) => sandbox.sandboxReplyToken({ merchantTransactionId, transactionId: txn, ResultCode: '0' });
const reply = (row: { merchantTransactionId: string }, txn: string) =>
  service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, txn) } });
const at = (row: { expiresAt: Date }, afterDeadline: number) => new Date(row.expiresAt.getTime() + afterDeadline);
const bodyOf = (o: { body: unknown }) => o.body as Record<string, unknown>;
/** The window MMG is asked about for this checkout, as instants. */
const queriesFor = (row: { createdAt: Date; expiresAt: Date }) => history.queries.filter((q) => {
  const to = mmgCreationInstant(q.todate, 'GUYANA_WALL_CLOCK');
  const from = mmgCreationInstant(q.fromdate, 'GUYANA_WALL_CLOCK');
  return to !== null && from !== null && from <= row.createdAt.getTime() && to >= row.expiresAt.getTime() + 40 * MIN;
});

let controls = 0;
/** This tenant's confirmed checkout (credited through the real verifier): the control. */
async function confirmedControl() {
  const s = await makeSub({ due: new Date(Date.now() + 3 * DAY) });
  const row = await intentOf((await start(s)).checkout.ref);
  const txn = tx(`CTRL${++controls}X`);
  approved(row, txn, 2100);
  expect(await reply(row, txn)).toBe('CONFIRMED');
  return { s, row: await intentOf(row.id), txn };
}
/** A partner opens the MMG page and leaves it. */
async function abandoned(opts: { tenantId?: string } = {}) {
  const s = await makeSub(opts);
  const started = opts.tenantId ? await runWithTenant(opts.tenantId, () => start(s)) : await start(s);
  const row = await intentOf(started.checkout.ref);
  return { s, row };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER'];
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
  });
  keys = { request: pair, result: pair };
  sandbox = new SandboxMmgCheckoutProvider(keys, 'GUYANA_WALL_CLOCK');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  const notifications = new NotificationService(app.prisma, app.io);
  billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  service = new MmgCheckoutService(app.prisma, billing, notifications, { checkout: () => sandbox, lookup: () => lookup });
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
}, 120_000);

beforeEach(() => {
  resetFeeCheckoutSwitchCache();
  history.reset();
  lookups.clear();
  historyFault = null;
});

afterAll(async () => {
  await app.prisma.privilegedApproval.deleteMany({ where: { id: { in: approvalIds } } });
  await app.prisma.mmgCheckoutObservation.deleteMany({ where: { id: { in: strayObservationIds } } });
  await cleanupBillingClocks(app.prisma, subIds);
  const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
  await app.prisma.mmgCheckoutObservation.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
  await app.prisma.mmgCheckoutKey.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
  await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
  await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.receiptCounter.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK'];
  else process.env['MASTER_KEK'] = kekBefore;
  resetKeyProviderForTests();
});

describe('an abandoned MMG page: closed as NOT PAID only on MMG’s own word', () => {
  it('MMG’s history, proven healthy by the control, covers the window and shows no payment: closed by the system, audited, nothing credited, the Pay button back', async () => {
    const control = await confirmedControl();
    const { s, row } = await abandoned();
    const before = await holdOf(row.id);
    expect(before.status).toBe('ACTIVE');
    const wallet = await walletOf(s.subId);

    // Not before the whole window is in the past: nothing asked, nothing written.
    await service.pollIntents(at(row, FIRST_CHECK - 5 * MIN));
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect(await checksOf(row.id)).toHaveLength(0);
    expect(queriesFor(row)).toHaveLength(0);

    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    // MMG was asked from the page's opening up to the check itself (less 2 minutes).
    const asked = queriesFor(row);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(mmgCreationInstant(asked[0]!.todate, 'GUYANA_WALL_CLOCK')).toBeGreaterThanOrEqual(at(row, FIRST_CHECK + MIN).getTime() - 2 * MIN);
    const checks = await checksOf(row.id);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.failure).toBe('HISTORY_NOT_FOUND');
    expect(bodyOf(checks[0]!)).toMatchObject({ purpose: 'NO_REPLY_EXPIRY_CHECK', decision: 'NO_PAYMENT', naming: [], truncated: false,
      explained: 1, unexplained: 0, control: { checkoutId: control.row.id, found: true } });

    const hold = await holdOf(row.id);
    expect(hold).toMatchObject({ status: 'PROVEN_UNPAID', resolvedBy: ACTOR, resolutionEvidence: `mmg-history-none:${checks[0]!.id}` });
    expect(hold.resolutionHistory).toEqual([{ status: 'PROVEN_UNPAID', at: expect.any(String), actor: ACTOR, reference: `mmg-history-none:${checks[0]!.id}`, epoch: before.sourceEpoch }]);
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_HISTORY_CONFIRMED_UNPAID', nextCheckAt: null, providerPaymentId: null, mmgTransactionId: null });
    const audits = await auditsOf(hold.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBeNull();
    expect(audits[0]!.changes).toMatchObject({ confirmationId: hold.id, subscriptionId: s.subId, sourceId: row.id, epoch: before.sourceEpoch,
      decision: 'UNPAID', evidenceReference: hold.resolutionEvidence, status: 'PROVEN_UNPAID', actor: ACTOR, controlCheckoutId: control.row.id });
    // Nothing credited.
    expect(await topups(s.subId)).toBe(0);
    expect(await walletOf(s.subId)).toBe(wallet);
    expect(await app.prisma.providerPayment.count({ where: { subscriptionId: s.subId } })).toBe(0);
    // The clock runs again and the partner may pay.
    expect((await clockOf(s.subId)).pausedAt).toBeNull();
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: true, reason: null });
    const fresh = await start(s);
    expect(fresh.created).toBe(true);
    expect(fresh.checkout.ref).not.toBe(row.id);
  });

  it('MMG shows a payment naming this checkout: untouched, the admins keep it', async () => {
    await confirmedControl();
    const { s, row } = await abandoned();
    history.holds(tx('PAIDLATE'), 2100, { external_id: row.merchantTransactionId, modificationDate: mmgTimeOf(new Date(row.createdAt.getTime() + 10 * MIN)) });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE', resolvedAt: null, resolvedBy: null });
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
    const checks = await checksOf(row.id);
    expect(checks).toHaveLength(1);
    expect(bodyOf(checks[0]!)).toMatchObject({ decision: 'PAYMENT_MAY_MATCH', unexplained: 0 });
    expect(bodyOf(checks[0]!)['naming']).toHaveLength(1);
    expect(await auditsOf((await holdOf(row.id)).id)).toHaveLength(0);
    expect(await topups(s.subId)).toBe(0);
  });

  it('[REVIEW-M S3-1] a payment MMG recorded after our deadline and its half hour, but before the check, is seen: untouched', async () => {
    await confirmedControl();
    const { s, row } = await abandoned();
    // MMG kept its page open past our deadline (its own limit is unconfirmed, U8): the partner paid an hour after it, and no reply came.
    history.holds(tx('PASTDEADLINE'), Number(row.amount), { external_id: row.merchantTransactionId, modificationDate: mmgTimeOf(at(row, 60 * MIN)) });
    await service.pollIntents(at(row, 120 * MIN)); // the first check runs later than its earliest time
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE', resolvedBy: null });
    const checks = await checksOf(row.id);
    expect(checks).toHaveLength(1);
    expect(bodyOf(checks[0]!)).toMatchObject({ decision: 'PAYMENT_MAY_MATCH' });
    expect(bodyOf(checks[0]!)['naming']).toHaveLength(1);
    expect(await topups(s.subId)).toBe(0);
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
  });

  it('MMG shows a payment Swift cannot explain (not another confirmed checkout’s own): untouched, and that payment is never stored', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    const stranger = tx('STRANGER');
    history.holds(stranger, 2100, { external_id: '991234567890123456', modificationDate: mmgTimeOf(new Date(row.createdAt.getTime() + 5 * MIN)) });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    const checks = await checksOf(row.id);
    expect(checks).toHaveLength(1);
    expect(bodyOf(checks[0]!)).toMatchObject({ decision: 'PAYMENT_MAY_MATCH', naming: [], unexplained: 1, explained: 1 });
    expect(JSON.stringify(checks[0]!.body)).not.toContain(stranger);
  });

  it('a row naming another of our checkouts that was never credited is not explained: untouched', async () => {
    await confirmedControl();
    const other = await abandoned();
    const { row } = await abandoned();
    history.holds(tx('OTHERS'), 2100, { external_id: other.row.merchantTransactionId, modificationDate: mmgTimeOf(new Date(row.createdAt.getTime() + 5 * MIN)) });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(bodyOf((await checksOf(row.id))[0]!)).toMatchObject({ decision: 'PAYMENT_MAY_MATCH', unexplained: 1 });
  });

  it('MMG’s answer cut at the row limit is not "no payment": untouched', async () => {
    const control = await confirmedControl();
    const { row } = await abandoned();
    const controlRow = history.rows.get(control.txn)!;
    historyFault = (query) => {
      const to = mmgCreationInstant(query.todate, 'GUYANA_WALL_CLOCK')!;
      if (to < row.expiresAt.getTime() + 40 * MIN) return null;
      return { outcome: 'rows', rows: Array.from({ length: query.rows }, () => controlRow) };
    };
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(bodyOf((await checksOf(row.id))[0]!)).toMatchObject({ decision: 'HISTORY_INCOMPLETE', truncated: true });
  });
});

describe('the read itself must be healthy: a control, or nothing is decided', () => {
  it('MMG cannot be read for the window: untouched, asked again on the schedule, then closed once MMG answers', async () => {
    await confirmedControl();
    const { s, row } = await abandoned();
    const first = at(row, FIRST_CHECK + MIN);
    historyFault = (query) => (mmgCreationInstant(query.todate, 'GUYANA_WALL_CLOCK')! >= row.expiresAt.getTime() + 40 * MIN
      ? { outcome: 'error', reason: 'MMG history unreachable: timeout' } : null);
    await service.pollIntents(first);
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    let checks = await checksOf(row.id);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.failure).toBe('HISTORY_FAILED');
    expect(bodyOf(checks[0]!)).toMatchObject({ decision: 'HISTORY_FAILED' });
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();

    // Not again before its wait is over (checks are timed by when they were written down).
    const written = checks[0]!.createdAt.getTime();
    const asked = queriesFor(row).length;
    await service.pollIntents(new Date(Math.max(first.getTime(), written) + 10 * MIN));
    expect(await checksOf(row.id)).toHaveLength(1);
    expect(queriesFor(row)).toHaveLength(asked);

    historyFault = null;
    await service.pollIntents(new Date(Math.max(first.getTime(), written) + BACKOFF[0]! + MIN));
    checks = await checksOf(row.id);
    expect(checks).toHaveLength(2);
    expect(bodyOf(checks[1]!)).toMatchObject({ decision: 'NO_PAYMENT' });
    expect(await holdOf(row.id)).toMatchObject({ status: 'PROVEN_UNPAID', resolvedBy: ACTOR });
  });

  it('MMG unreachable for the control too: untouched, the window never read', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    historyFault = () => ({ outcome: 'error', reason: 'MMG history HTTP 503' });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    const checks = await checksOf(row.id);
    expect(checks).toHaveLength(1);
    expect(bodyOf(checks[0]!)).toMatchObject({ decision: 'CONTROL_FAILED', control: { found: false } });
    expect(queriesFor(row)).toHaveLength(0);
  });

  it('an empty window proves nothing when MMG does not show the control’s own payment either: untouched', async () => {
    const control = await confirmedControl();
    const { row } = await abandoned();
    history.rows.delete(control.txn); // the window answers no rows, but neither does the control
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    expect(bodyOf((await checksOf(row.id))[0]!)).toMatchObject({ decision: 'CONTROL_FAILED', control: { found: false } });
  });

  it('a control whose MMG record does not name its own checkout proves nothing: untouched', async () => {
    const control = await confirmedControl();
    const { row } = await abandoned();
    history.holds(control.txn, 2100, { external_id: '123456789012345678' });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(bodyOf((await checksOf(row.id))[0]!)).toMatchObject({ decision: 'CONTROL_FAILED', control: { found: false } });
  });

  it('MMG’s times read in the wrong zone fail the control: untouched', async () => {
    const control = await confirmedControl();
    const { row } = await abandoned();
    // MMG writes and reads its times in UTC while Swift reads them as Guyana
    // wall clock: every window Swift asks for lands four hours off, so the
    // control's own payment is not in its window (and an empty window means nothing).
    history.zone = 'UTC';
    history.holds(control.txn, 2100, { external_id: control.row.merchantTransactionId, modificationDate: mmgTimeOf(new Date(), 'UTC') });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(bodyOf((await checksOf(row.id))[0]!)).toMatchObject({ decision: 'CONTROL_FAILED' });
  });

  it('a tenant with no confirmed checkout to prove the read with: MMG is not asked, the admins keep it', async () => {
    const tenantId = `ten-holdauto-${RUN.toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id: tenantId, name: 'Hold auto tenant', slug: `hold-auto-${RUN.toLowerCase()}` } });
    tenantIds.push(tenantId);
    await confirmedControl(); // another tenant's confirmed checkout never proves this one's read
    const { row } = await abandoned({ tenantId });
    expect(row.tenantId).toBe(tenantId);
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await checksOf(row.id)).toHaveLength(0);
    expect(queriesFor(row)).toHaveLength(0);
  });

  it('the schedule is bounded: ten checks, then the admins alone', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    historyFault = () => ({ outcome: 'error', reason: 'MMG history HTTP 500' });
    let when = at(row, FIRST_CHECK + MIN);
    for (let i = 0; i < 10; i += 1) {
      await service.pollIntents(when);
      const checks = await checksOf(row.id);
      expect(checks).toHaveLength(i + 1);
      const last = Math.max(when.getTime(), checks[i]!.createdAt.getTime());
      when = new Date(last + (BACKOFF[i] ?? DAY) + MIN);
    }
    await service.pollIntents(new Date(when.getTime() + 30 * DAY));
    expect(await checksOf(row.id)).toHaveLength(10);
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('never: a reply, a settlement, a provider payment or a second-admin request', () => {
  it('a Mark PAID (or any close) request waiting for a second admin: untouched, MMG not asked; once refused, MMG decides', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    const hold = await holdOf(row.id);
    const approval = await app.prisma.privilegedApproval.create({ data: {
      action: RESOLVE_ACTION, cls: 'C4', capability: 'billing.payment.attach', entityId: hold.id, fingerprint: `fp-${RUN}`,
      bodySnapshot: { params: { id: hold.id }, body: { decision: 'PAID', sourceId: row.id }, query: {} },
      status: 'PENDING', requestedBy: 'admin-fixture', reason: 'Partner sent an MMG receipt; checking it against the statement.',
      expiresAt: new Date(Date.now() + 3 * DAY),
    } });
    approvalIds.push(approval.id);
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await checksOf(row.id)).toHaveLength(0);
    expect(queriesFor(row)).toHaveLength(0);
    await app.prisma.privilegedApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', approvedBy: 'admin-fixture-2', decidedAt: new Date() } });
    await service.pollIntents(at(row, FIRST_CHECK + 2 * MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    await app.prisma.privilegedApproval.update({ where: { id: approval.id }, data: { status: 'REJECTED' } });
    await service.pollIntents(at(row, FIRST_CHECK + 3 * MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'PROVEN_UNPAID', resolvedBy: ACTOR });
  });

  it('a hold applying a settlement is never closed', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    const hold = await holdOf(row.id);
    await app.prisma.paymentConfirmationHold.update({ where: { id: hold.id }, data: { status: 'SETTLEMENT_APPLY_PENDING', reason: 'SETTLEMENT_APPLY_PENDING' } });
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'SETTLEMENT_APPLY_PENDING', resolvedAt: null });
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    expect(await checksOf(row.id)).toHaveLength(0);
  });

  it('a provider payment on record for the checkout, or any MMG payment on the fee since it opened: never closed', async () => {
    await confirmedControl();
    const credited = await abandoned();
    await app.prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: tx('PPMCO'), status: 'OPEN', creditedPaymentId: `mco:${credited.row.id}`,
      amount: 2100, currencyCode: 'GYD', tenantId: credited.row.tenantId } });
    const paid = await abandoned();
    await app.prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: tx('PPSUB'), status: 'CREDITED', subscriptionId: paid.s.subId,
      creditedPaymentId: `agent:${RUN}`, creditedAt: new Date(), amount: 2100, currencyCode: 'GYD', tenantId: paid.row.tenantId } });
    await service.pollIntents(at(paid.row, FIRST_CHECK + MIN));
    for (const row of [credited.row, paid.row]) {
      expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
      expect(await checksOf(row.id)).toHaveLength(0);
    }
  });

  it('a reply nobody could tie to a checkout, while this page could have been paid: never closed (it may be this one’s)', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    const stray = await app.prisma.mmgCheckoutObservation.create({ data: {
      intentId: null, source: 'RETURN', detail: 'success', failure: 'NO_TOKEN', createdAt: new Date(row.createdAt.getTime() + 3 * MIN),
    } });
    strayObservationIds.push(stray.id);
    try {
      await service.pollIntents(at(row, FIRST_CHECK + MIN));
      expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
      expect(await checksOf(row.id)).toHaveLength(0);
    } finally {
      await app.prisma.mmgCheckoutObservation.delete({ where: { id: stray.id } });
    }
  });

  it('[REVIEW-M S3-1] an untied reply after our deadline and its half hour, but before the check, keeps it too', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    const stray = await app.prisma.mmgCheckoutObservation.create({ data: {
      intentId: null, source: 'NOTIFY', detail: 'notify', failure: 'INVALID_RESPONSE', createdAt: at(row, 60 * MIN),
    } });
    strayObservationIds.push(stray.id);
    try {
      await service.pollIntents(at(row, 120 * MIN));
      expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
      expect(await checksOf(row.id)).toHaveLength(0);
    } finally {
      await app.prisma.mmgCheckoutObservation.delete({ where: { id: stray.id } });
    }
  });

  it('a checkout MMG sent the partner back from is never this path: its own lookup decides', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    expect(await reply(row, tx('UNKNOWNTX'))).toBe('CONFIRMING'); // MMG does not know it
    await service.pollIntents(new Date(Date.now() + DAY + 60 * MIN));
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'LOOKUP_NEVER_CONFIRMED' });
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await checksOf(row.id)).toHaveLength(0);
  });
});

describe('once, and the same as the admins’ close', () => {
  it('two polls at once close it exactly once; later polls leave it alone', async () => {
    await confirmedControl();
    const { row } = await abandoned();
    const when = at(row, FIRST_CHECK + MIN);
    await service.pollIntents(at(row, MIN)); // expired
    await Promise.all([service.pollIntents(when), service.pollIntents(when)]);
    const hold = await holdOf(row.id);
    expect(hold.status).toBe('PROVEN_UNPAID');
    expect(hold.resolutionHistory).toHaveLength(1);
    expect(await auditsOf(hold.id)).toHaveLength(1);
    const expiryChecks = async () => (await checksOf(row.id)).filter((o) => bodyOf(o)['purpose'] === 'NO_REPLY_EXPIRY_CHECK');
    const checks = (await expiryChecks()).length;
    await service.pollIntents(new Date(when.getTime() + 2 * DAY));
    expect(await expiryChecks()).toHaveLength(checks);
    expect((await holdOf(row.id)).resolutionHistory).toHaveLength(1);
    expect(await auditsOf(hold.id)).toHaveLength(1);
  });

  it('leaves the same records as the admins’ NOT PAID close: hold, checkout, clock and the Pay button', async () => {
    await confirmedControl();
    const byAdmin = await abandoned();
    const bySystem = await abandoned();
    await service.pollIntents(at(bySystem.row, MIN)); // both expired, neither due for MMG yet
    const hold = await holdOf(byAdmin.row.id);
    const clock = await clockOf(byAdmin.s.subId);
    await resolveFinanceConfirmation(app.prisma, { id: hold.id, tenantId: hold.tenantId, actorId: 'finance-test', sourceId: byAdmin.row.id,
      epoch: hold.sourceEpoch, clockVersion: clock.version, decision: 'UNPAID', evidenceReference: 'statement-checked' }, async () => {});
    await service.pollIntents(at(bySystem.row, FIRST_CHECK + MIN));
    const [a, b] = await Promise.all([holdOf(byAdmin.row.id), holdOf(bySystem.row.id)]);
    expect(b.status).toBe(a.status);
    expect(Object.keys((b.resolutionHistory as Record<string, unknown>[])[0]!).sort()).toEqual(Object.keys((a.resolutionHistory as Record<string, unknown>[])[0]!).sort());
    const [ca, cb] = await Promise.all([intentOf(byAdmin.row.id), intentOf(bySystem.row.id)]);
    expect({ status: cb.status, nextCheckAt: cb.nextCheckAt }).toEqual({ status: ca.status, nextCheckAt: ca.nextCheckAt });
    const [ka, kb] = await Promise.all([clockOf(byAdmin.s.subId), clockOf(bySystem.s.subId)]);
    for (const k of [ka, kb]) {
      expect(k.pausedAt).toBeNull();
      expect(k.resumedAt).not.toBeNull();
      expect(k.runningSince!.getTime()).toBe(Math.max(k.resumedAt!.getTime(), k.dueAt.getTime()));
    }
    expect(kb.epoch).toBe(ka.epoch);
    for (const sub of [byAdmin.s, bySystem.s]) {
      expect(await readFeePaymentDecision(app.prisma, sub.subId)).toEqual({ allowed: true, reason: null });
      expect(await topups(sub.subId)).toBe(0);
    }
    const [sa, sb] = await Promise.all([byAdmin.s, bySystem.s].map((x) => app.prisma.subscription.findUniqueOrThrow({ where: { id: x.subId } })));
    expect({ status: sb!.status, failedAttempts: sb!.failedAttempts }).toEqual({ status: sa!.status, failedAttempts: sa!.failedAttempts });
  });

  it('money MMG shows after the close is never dropped: a late paid answer retakes the pause for a person', async () => {
    await confirmedControl();
    const { s, row } = await abandoned();
    await service.pollIntents(at(row, FIRST_CHECK + MIN));
    expect(await holdOf(row.id)).toMatchObject({ status: 'PROVEN_UNPAID', resolvedBy: ACTOR });
    const late = tx('LATEPAID');
    approved(row, late, Number(row.amount));
    await reply(row, late);
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD' });
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE', reason: 'LATE_POSITIVE_REVIEW' });
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
  });
});

describe('[REVIEW-M S3-1 (b)] a week of watching MMG after an automatic close: a late record is never lost', () => {
  const WATCH = 'NO_REPLY_POST_CLOSE_WATCH';
  const watchesOf = async (intentId: string) => (await checksOf(intentId)).filter((o) => bodyOf(o)['purpose'] === WATCH);
  const later = (t: Date, ms: number) => new Date(t.getTime() + ms);
  async function autoClosed() {
    await confirmedControl();
    const { s, row } = await abandoned();
    const closedAt = at(row, FIRST_CHECK + MIN);
    await service.pollIntents(closedAt);
    expect(await holdOf(row.id)).toMatchObject({ status: 'PROVEN_UNPAID', resolvedBy: ACTOR });
    return { s, row, closedAt };
  }
  const operator = async () => {
    const user = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Test', lastName: 'Operator', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true } });
    userIds.push(user.id);
    return user;
  };
  const pagesAbout = async (operatorId: string, checkoutId: string, alert: string) => (await app.prisma.notification.findMany({
    where: { userId: operatorId, data: { path: ['checkoutId'], equals: checkoutId } },
  })).filter((n) => (n.data as Record<string, unknown>)['alert'] === alert);

  it('MMG shows a payment naming the checkout after the close: held for a person, the pause retaken, nothing credited', async () => {
    const op = await operator();
    const { s, row, closedAt } = await autoClosed();
    const wallet = await walletOf(s.subId);
    // The first read, half an hour after the close, finds nothing.
    await service.pollIntents(later(closedAt, 31 * MIN));
    let watches = await watchesOf(row.id);
    expect(watches).toHaveLength(1);
    expect(bodyOf(watches[0]!)).toMatchObject({ decision: 'WATCH_CLEAR', records: [] });
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID' });
    // MMG then shows the partner's payment, made two hours after the close on a page MMG kept open, with no reply.
    history.holds(tx('AFTERCLOSE'), Number(row.amount), { external_id: row.merchantTransactionId, modificationDate: mmgTimeOf(later(closedAt, 120 * MIN)) });
    await service.pollIntents(later(closedAt, 31 * MIN + 6 * 60 * MIN + MIN));
    watches = await watchesOf(row.id);
    expect(watches).toHaveLength(2);
    expect(bodyOf(watches[1]!)).toMatchObject({ decision: 'LATE_RECORD' });
    // Only the parsed fields of the row are kept, never its parties.
    expect(bodyOf(watches[1]!)['records']).toEqual([{ likely: true, externalIdExact: true, statusText: 'completed', amountMinor: Number(row.amount) * 100,
      currencyCode: 'GYD', transactionReference: tx('AFTERCLOSE'), modificationDate: expect.any(String) }]);
    expect(JSON.stringify(watches[1]!.body)).not.toContain('accountid');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'LATE_PAYMENT_LIKELY_AFTER_AUTO_CLOSE', providerPaymentId: null });
    expect(await holdOf(row.id)).toMatchObject({ status: 'ACTIVE', reason: 'LATE_POSITIVE_REVIEW' });
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
    expect(await topups(s.subId)).toBe(0);
    expect(await walletOf(s.subId)).toBe(wallet);
    const pages = await pagesAbout(op.id, row.id, 'mmg-checkout-held');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toContain('LATE PAYMENT LIKELY');
    expect(await app.prisma.notification.count({ where: { userId: s.userId, data: { path: ['status'], equals: 'HELD' } } })).toBe(1);
    expect(await app.prisma.auditLog.count({ where: { entityId: row.id, action: 'MMG_AUTO_CLOSED_CHECKOUT_LATE_RECORD' } })).toBe(1);
    // Held: the watch is over.
    await service.pollIntents(later(closedAt, 2 * DAY));
    expect(await watchesOf(row.id)).toHaveLength(2);
  });

  it('only a record naming the checkout counts; MMG is read in slices from where the last clean read ended', async () => {
    const { row, closedAt } = await autoClosed();
    const stranger = tx('NOTOURS');
    history.holds(stranger, 2100, { external_id: '991234567890123457', modificationDate: mmgTimeOf(later(closedAt, 60 * MIN)) });
    await service.pollIntents(later(closedAt, 31 * MIN));
    await service.pollIntents(later(closedAt, 31 * MIN + 6 * 60 * MIN + MIN));
    const watches = await watchesOf(row.id);
    expect(watches.map((w) => bodyOf(w)['decision'])).toEqual(['WATCH_CLEAR', 'WATCH_CLEAR']);
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID' });
    expect(JSON.stringify(watches.map((w) => w.body))).not.toContain(stranger);
    const first = bodyOf(watches[0]!);
    const second = bodyOf(watches[1]!);
    const lastTo = (first['slices'] as Array<{ todate: string }>).at(-1)!.todate;
    const nextFrom = (second['slices'] as Array<{ fromdate: string }>)[0]!.fromdate;
    // Each read starts where the last clean one ended (less MMG's tolerance and margin): no hour is skipped.
    expect(mmgCreationInstant(nextFrom, 'GUYANA_WALL_CLOCK')!).toBeLessThanOrEqual(mmgCreationInstant(lastTo, 'GUYANA_WALL_CLOCK')!);
    for (const slice of second['slices'] as Array<{ fromdate: string; todate: string }>) {
      expect(mmgCreationInstant(slice.todate, 'GUYANA_WALL_CLOCK')! - mmgCreationInstant(slice.fromdate, 'GUYANA_WALL_CLOCK')!).toBeLessThanOrEqual(72 * MIN + 1000);
    }
  });

  it('MMG cannot be read: nothing changes and the same hours are read again; the record is found once MMG answers', async () => {
    const { row, closedAt } = await autoClosed();
    history.holds(tx('AFTERFAIL'), Number(row.amount), { external_id: row.merchantTransactionId, modificationDate: mmgTimeOf(later(closedAt, 5 * MIN)) });
    historyFault = () => ({ outcome: 'error', reason: 'MMG history HTTP 503' });
    await service.pollIntents(later(closedAt, 31 * MIN));
    const failed = await watchesOf(row.id);
    expect(failed).toHaveLength(1);
    expect(bodyOf(failed[0]!)).toMatchObject({ decision: 'WATCH_READ_FAILED' });
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID' });
    historyFault = null;
    await service.pollIntents(later(closedAt, 31 * MIN + 6 * 60 * MIN + MIN));
    expect(bodyOf((await watchesOf(row.id))[1]!)).toMatchObject({ decision: 'LATE_RECORD' });
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'LATE_PAYMENT_LIKELY_AFTER_AUTO_CLOSE' });
  });

  it('a row in which our reference merely appears is still held for a person, labelled a possible match (never credited)', async () => {
    const op = await operator();
    const { s, row, closedAt } = await autoClosed();
    history.holds(tx('MENTION'), 999, { external_id: '991234567890123459', descriptionText: `ref ${row.merchantTransactionId}`, modificationDate: mmgTimeOf(later(closedAt, 10 * MIN)) });
    await service.pollIntents(later(closedAt, 31 * MIN));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'POSSIBLE_MATCH_AFTER_AUTO_CLOSE' });
    expect(bodyOf((await watchesOf(row.id))[0]!)['records']).toEqual([expect.objectContaining({ likely: false, externalIdExact: false, amountMinor: 99900 })]);
    const pages = await pagesAbout(op.id, row.id, 'mmg-checkout-held');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toContain('Possible match, check MMG');
    expect(await topups(s.subId)).toBe(0);
  });

  it('a record found but not held (a failing hold) is tried again at once, then the admins are paged and the watch ends', async () => {
    const op = await operator();
    const { row, closedAt } = await autoClosed();
    history.holds(tx('UNHELD'), Number(row.amount), { external_id: row.merchantTransactionId, modificationDate: mmgTimeOf(later(closedAt, 10 * MIN)) });
    const target = service as unknown as { hold: (...args: unknown[]) => Promise<string> };
    const realHold = target.hold;
    target.hold = async () => 'NOT_PAID';
    try {
      await service.pollIntents(later(closedAt, 31 * MIN));
      expect((await watchesOf(row.id)).map((w) => bodyOf(w)['decision'])).toEqual(['LATE_RECORD']);
      expect(await pagesAbout(op.id, row.id, 'mmg-auto-close-late-record-unheld')).toHaveLength(0);
      await service.pollIntents(later(closedAt, 33 * MIN));
      expect((await watchesOf(row.id)).map((w) => bodyOf(w)['decision'])).toEqual(['LATE_RECORD', 'LATE_RECORD', 'LATE_RECORD_UNHELD']);
      const pages = await pagesAbout(op.id, row.id, 'mmg-auto-close-late-record-unheld');
      expect(pages).toHaveLength(1);
      expect(pages[0]!.body).toContain('LATE PAYMENT LIKELY');
      await service.pollIntents(later(closedAt, 2 * DAY));
      expect(await watchesOf(row.id)).toHaveLength(3);
    } finally {
      target.hold = realHold;
    }
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID' });
  });

  it('a worker stopped past the whole week still decides every automatic close: it catches up, and pages the admins once if MMG cannot be read', async () => {
    const op = await operator();
    const caught = await autoClosed();
    history.holds(tx('DURINGDOWN'), Number(caught.row.amount), { external_id: caught.row.merchantTransactionId, modificationDate: mmgTimeOf(later(caught.closedAt, 3 * DAY)) });
    let when = later(caught.closedAt, 10 * DAY); // nothing ran for ten days
    for (let i = 0; i < 40 && (await intentOf(caught.row.id)).status === 'NOT_PAID'; i += 1) {
      await service.pollIntents(when);
      when = later(when, 2 * MIN);
    }
    expect(await intentOf(caught.row.id)).toMatchObject({ status: 'HELD', reason: 'LATE_PAYMENT_LIKELY_AFTER_AUTO_CLOSE' });
    expect((await watchesOf(caught.row.id)).map((w) => bodyOf(w)['decision'])).toContain('WATCH_BEHIND');

    const blind = await autoClosed();
    historyFault = () => ({ outcome: 'error', reason: 'MMG history HTTP 502' });
    await service.pollIntents(later(blind.closedAt, 10 * DAY));
    expect(bodyOf((await watchesOf(blind.row.id)).at(-1)!)).toMatchObject({ decision: 'WATCH_ENDED_INCOMPLETE' });
    expect(await pagesAbout(op.id, blind.row.id, 'mmg-auto-close-unwatched')).toHaveLength(1);
    await service.pollIntents(later(blind.closedAt, 11 * DAY));
    expect(await pagesAbout(op.id, blind.row.id, 'mmg-auto-close-unwatched')).toHaveLength(1);
    expect(await intentOf(blind.row.id)).toMatchObject({ status: 'NOT_PAID' });
  });

  it('an hour MMG answers only in part (cut at the row limit) is not read as clean: coverage stays, it is read again', async () => {
    const { row, closedAt } = await autoClosed();
    const filler = mmgHistoryRow(tx('FILLER'), 2100, { external_id: '991234567890123458' });
    historyFault = (query) => (mmgCreationInstant(query.fromdate, 'GUYANA_WALL_CLOCK')! >= closedAt.getTime() - 20 * MIN
      ? { outcome: 'rows', rows: Array.from({ length: query.rows }, () => filler) } : null);
    await service.pollIntents(later(closedAt, 31 * MIN));
    const watches = await watchesOf(row.id);
    expect(watches).toHaveLength(1);
    expect(bodyOf(watches[0]!)).toMatchObject({ decision: 'WATCH_INCOMPLETE', coveredUntilMs: closedAt.getTime() - 2 * MIN });
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID' });
  });

  it('bounded: a week read clean ends quietly; a week that could not be read whole pages the admins once, then stops', async () => {
    const op = await operator();
    const clean = await autoClosed();
    let when = later(clean.closedAt, 31 * MIN);
    for (let i = 0; i < 40 && when.getTime() < clean.closedAt.getTime() + 8 * DAY; i += 1) {
      await service.pollIntents(when);
      when = later(when, 6 * 60 * MIN + MIN);
    }
    const reads = (await watchesOf(clean.row.id)).length;
    expect(bodyOf((await watchesOf(clean.row.id)).at(-1)!)['coveredUntilMs']).toBeGreaterThanOrEqual(clean.closedAt.getTime() + 7 * DAY);
    await service.pollIntents(later(clean.closedAt, 9 * DAY));
    expect(await watchesOf(clean.row.id)).toHaveLength(reads);
    expect(await pagesAbout(op.id, clean.row.id, 'mmg-auto-close-unwatched')).toHaveLength(0);

    const blind = await autoClosed();
    historyFault = () => ({ outcome: 'error', reason: 'MMG history HTTP 500' });
    await service.pollIntents(later(blind.closedAt, 31 * MIN));
    await service.pollIntents(later(blind.closedAt, 8 * DAY + MIN));
    const watches = await watchesOf(blind.row.id);
    expect(bodyOf(watches.at(-1)!)).toMatchObject({ decision: 'WATCH_ENDED_INCOMPLETE' });
    expect(await pagesAbout(op.id, blind.row.id, 'mmg-auto-close-unwatched')).toHaveLength(1);
    await service.pollIntents(later(blind.closedAt, 8 * DAY + 7 * 60 * MIN));
    expect(await watchesOf(blind.row.id)).toHaveLength(watches.length);
    expect(await intentOf(blind.row.id)).toMatchObject({ status: 'NOT_PAID' });
  });
});

// The checkout TTL these times assume.
it('the window arithmetic matches the checkout lifetime', () => {
  expect(MMG_CHECKOUT_TTL_MS).toBe(30 * MIN);
});
