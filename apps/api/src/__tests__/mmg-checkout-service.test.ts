import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_CHECKOUT_TTL_MS, MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import type { MmgLookupClient, MmgLookupDetail } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// The MMG weekly-fee checkout against the database (MMG-CHECKOUT-API.md).
// The sandbox runs the REAL request/reply cryptography under this file's own
// keys; the MMG lookup is scripted per transaction. Invariants from the plan:
//   I1 server-priced · I2 only MMG's lookup credits · I3 one MMG transaction,
//   one credit across channels · I4 one open checkout per subscription ·
//   I5 a checkout in flight pauses billing, a credit re-bills at once ·
//   I6 a mismatch holds for a person · I8 expiry is not failure ·
//   I9 every reply and lookup is written down first.
// Phones: +592646… (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
let billing: BillingService;
let notifications: NotificationService;
let sandbox: SandboxMmgCheckoutProvider;
let service: MmgCheckoutService;
let checkoutProvider: () => MmgCheckoutProvider;

const lookups = new Map<string, MmgLookupDetail>();
const lookup: MmgLookupClient = { transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' } };
function approved(txn: string, amountGyd: number, patch: Partial<Extract<MmgLookupDetail, { outcome: 'found' }>> = {}) {
  lookups.set(txn, {
    outcome: 'found', transactionId: txn, status: 'approved', amountMinor: amountGyd * 100, currencyCode: 'GYD',
    creditParties: [SANDBOX_MERCHANT_ID], createdAt: null, raw: { transactionReference: txn }, ...patch,
  });
}

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_646_000_000 + Math.floor(Math.random() * 900_000);

async function makeSub(opts: { status?: SubscriptionStatus; balance?: number; due?: Date } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Fee', lastName: `P${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Checkout Store ${seq}`, slug: `checkout-store-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
      addressLine1: '1 Checkout Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      ...(opts.status === 'SUSPENDED' ? { suspendedAt: new Date(Date.now() - DAY), failedAttempts: 3, nextRetryAt: new Date(Date.now() + DAY) } : {}),
      prepaidBalance: { create: { balance: opts.balance ?? 0 } },
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, vendorId: vendor.id, subId: sub.id };
}

const key = () => `test-${nanoid(12)}`;
/** MMG transaction ids unique to this run: provider identities outlive a run, so ids never repeat across runs. */
const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const tx = (name: string) => `${name}${RUN}`;
const start = (s: { subId: string; userId: string }, clientKey = key(), platform: 'ios' | 'android' | 'web' | 'unknown' = 'ios') =>
  service.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform, clientKey });
const intentOf = (ref: string) => app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: ref } });
const topups = (subscriptionId: string) => app.prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' } });
const walletOf = async (subscriptionId: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId } })).balance);
/** A reply as MMG's page would send it back: field names are UNCONFIRMED, so these are deliberately arbitrary. */
const replyFor = (merchantTransactionId: string, txn: string) => sandbox.sandboxReplyToken({ orderRef: merchantTransactionId, paymentRef: txn, code: 0, secretKey: 'must-not-be-stored' });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
  });
  sandbox = new SandboxMmgCheckoutProvider({ request: pair, result: pair });
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  notifications = new NotificationService(app.prisma, app.io);
  billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  checkoutProvider = () => sandbox;
  service = new MmgCheckoutService(app.prisma, billing, notifications, { checkout: () => checkoutProvider(), lookup: () => lookup });
}, 120_000);

beforeEach(() => {
  checkoutProvider = () => sandbox;
  resetFeeCheckoutSwitchCache();
});

afterAll(async () => {
  const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
  await app.prisma.mmgCheckoutObservation.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
  await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
  await app.prisma.platformConfig.deleteMany({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
  await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('starting a checkout — server-priced, written down first, one open at a time', () => {
  it('[I1] prices it here, persists it, then hands out the MMG page carrying exactly that', async () => {
    const s = await makeSub({ balance: 600 });
    const { created, checkout } = await start(s);
    expect(created).toBe(true);
    expect(checkout).toMatchObject({ status: 'OPEN', amountGyd: 1500, currencyCode: 'GYD' });
    const row = await intentOf(checkout.ref);
    expect(row.subscriptionId).toBe(s.subId);
    expect(Number(row.amount)).toBe(1500);
    // What MMG will read from the page is what was persisted.
    const asked = sandbox.sandboxReadRequest(checkout.checkoutUrl!);
    expect(asked).toMatchObject({ amount: '1500', merchantTransactionId: row.merchantTransactionId, merchantId: SANDBOX_MERCHANT_ID });
  });

  it('nothing due: one week, banked as credit toward the next bill', async () => {
    const s = await makeSub({ balance: 5000 });
    expect((await start(s)).checkout.amountGyd).toBe(2100);
  });

  it('[I4] the same key, or any second tap while one is open, gets the same checkout back', async () => {
    const s = await makeSub();
    const k = key();
    const first = await start(s, k);
    const again = await start(s, k);
    const second = await start(s);
    expect(again).toEqual({ created: false, checkout: first.checkout });
    expect(second.created).toBe(false);
    expect(second.checkout.ref).toBe(first.checkout.ref);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
  });

  it('[I4] the database itself refuses a second open checkout for one subscription', async () => {
    const s = await makeSub();
    const { checkout } = await start(s);
    const row = await intentOf(checkout.ref);
    await expect(app.prisma.mmgCheckoutIntent.create({
      data: { ...row, id: undefined, merchantTransactionId: '179000000000099999', clientKey: key(), mmgTransactionId: null, providerPaymentId: null, candidates: [] } as never,
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a missing or malformed key, and a key reused for another subscription', async () => {
    const s = await makeSub();
    const other = await makeSub();
    for (const bad of [undefined, '', 'short', 'has spaces in it', 'x'.repeat(129)]) {
      await expect(service.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'ios', clientKey: bad }))
        .rejects.toMatchObject({ statusCode: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const k = key();
    await start(s, k);
    await expect(service.createCheckout({ subscriptionId: other.subId, userId: s.userId, platform: 'ios', clientKey: k }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('a checkout being confirmed refuses a new one, naming it, so nobody pays twice', async () => {
    const s = await makeSub();
    const { checkout } = await start(s);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: checkout.ref }, data: { status: 'CONFIRMING' } });
    await expect(start(s)).rejects.toMatchObject({ statusCode: 409, code: 'CHECKOUT_CONFIRMING', details: { ref: checkout.ref } });
  });

  it('an open checkout past its time is expired and a fresh one started', async () => {
    const s = await makeSub();
    const old = (await start(s)).checkout;
    await app.prisma.mmgCheckoutIntent.update({ where: { id: old.ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await start(s);
    expect(fresh.created).toBe(true);
    expect(fresh.checkout.ref).not.toBe(old.ref);
    expect((await intentOf(old.ref)).status).toBe('EXPIRED');
  });

  it('PAY_ACTION_OFF when the checkout is not configured, the platform is switched off, or the plan is stopped', async () => {
    const s = await makeSub();
    checkoutProvider = () => ({ driver: 'disabled', merchantId: null }) as unknown as MmgCheckoutProvider;
    await expect(start(s)).rejects.toMatchObject({ statusCode: 409, code: 'PAY_ACTION_OFF' });
    checkoutProvider = () => sandbox;
    await app.prisma.platformConfig.upsert({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY }, create: { key: FEE_CHECKOUT_PLATFORMS_KEY, value: { ios: false } }, update: { value: { ios: false } } });
    resetFeeCheckoutSwitchCache();
    await expect(start(s, key(), 'ios')).rejects.toMatchObject({ code: 'PAY_ACTION_OFF' });
    await expect(start(s, key(), 'unknown')).rejects.toMatchObject({ code: 'PAY_ACTION_OFF' });
    expect((await start(s, key(), 'android')).created).toBe(true);
    await app.prisma.platformConfig.delete({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
    resetFeeCheckoutSwitchCache();
    const paused = await makeSub({ status: 'PAUSED' });
    await expect(start(paused)).rejects.toMatchObject({ code: 'PAY_ACTION_OFF' });
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: paused.subId } })).toBe(0);
  });
});

describe('the reply and the lookup — only MMG’s own records credit', () => {
  it('[I2 I3 I5] a verified reply credits once, reinstates at once, and a replay changes nothing', async () => {
    const s = await makeSub({ status: 'SUSPENDED' });
    const { checkout } = await start(s);
    const row = await intentOf(checkout.ref);
    const txn = `MMGTX${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, '7')}9`;
    approved(txn, 2100);
    const token = replyFor(row.merchantTransactionId, txn);

    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token } })).toBe('CONFIRMED');
    const confirmed = await intentOf(checkout.ref);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
    const identity = await app.prisma.providerPayment.findUniqueOrThrow({ where: { id: confirmed.providerPaymentId! } });
    expect(identity).toMatchObject({ provider: 'MMG', providerTxnId: txn, status: 'CREDITED', creditedPaymentId: `mco:${checkout.ref}`, subscriptionId: s.subId });
    const credits = await topups(s.subId);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.idempotencyKey).toBe(`mmg-checkout:pp:${identity.id}`);
    // [I5] the credit re-billed at once: the week is paid and the store is back.
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } });
    expect(sub.status).toBe('ACTIVE');
    expect(await walletOf(s.subId)).toBe(0);
    // The partner hears it once, and a multi-store owner's app knows which store.
    const told = await app.prisma.notification.findMany({ where: { userId: s.userId, data: { path: ['kind'], equals: 'billing_mmg_checkout' } } });
    expect(told).toHaveLength(1);
    expect(told[0]!.data).toMatchObject({ ref: checkout.ref, status: 'CONFIRMED', vendorId: s.vendorId, subscriptionId: s.subId });

    // MMG's server and a page refresh repeat it: nothing moves again.
    expect(await service.observeReply({ source: 'NOTIFY', outcome: 'notify', params: { payload: token } })).toBe('CONFIRMED');
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token } })).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await app.prisma.notification.count({ where: { userId: s.userId, data: { path: ['kind'], equals: 'billing_mmg_checkout' } } })).toBe(1);
  });

  it('the redirect alone never credits: a transaction MMG does not know leaves it confirming, the wallet untouched', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, tx('UNKNOWNTX1')) } })).toBe('CONFIRMING');
    const after = await intentOf(row.id);
    expect(after.status).toBe('CONFIRMING');
    expect(after.nextCheckAt).not.toBeNull();
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('MMG sending the partner back on its error path, with nothing paid, is NOT_PAID', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    expect(await service.observeReply({ source: 'RETURN', outcome: 'error', params: { token: replyFor(row.merchantTransactionId, tx('NOSUCHTX1')) } })).toBe('NOT_PAID');
    expect((await intentOf(row.id)).status).toBe('NOT_PAID');
  });

  it('[I6] MMG’s record of THIS checkout with a different amount is held for a person; nothing credits', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('HELDTX1'), 2000, { raw: { transactionReference: tx('HELDTX1'), description: `Swift ${row.merchantTransactionId}` } });
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, tx('HELDTX1')) } })).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'AMOUNT_MISMATCH' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('a mismatch that may concern another transaction waits instead of holding a payment still arriving', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('WEAKTX1'), 2000);
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, tx('WEAKTX1')) } });
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'SEEN:HOLD:AMOUNT_MISMATCH' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[I3] a transaction another channel already credited is never credited again', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    await app.prisma.providerPayment.create({
      data: { provider: 'MMG', providerTxnId: tx('TAKENTX1'), status: 'CREDITED', creditedPaymentId: 'agent-observation', subscriptionId: s.subId, amount: 2100, currencyCode: 'GYD', creditedAt: new Date() },
    });
    approved(tx('TAKENTX1'), 2100);
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, tx('TAKENTX1')) } });
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[I3] and an admin top-up naming a transaction a checkout credited is refused', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('BOTHTX1'), 2100);
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, tx('BOTHTX1')) } });
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');
    const admin = await app.prisma.user.create({ data: { phone: `+${phoneBase + 9000 + seq}`, firstName: 'Ad', lastName: 'Min', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true } });
    userIds.push(admin.id);
    await expect(billing.recordTopUpCommand({ adminId: admin.id, idempotencyKey: key(), requestHash: 'h', subscriptionId: s.subId, amount: 2100, reference: tx('BOTHTX1') }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TOPUP_REFERENCE_ALREADY_CREDITED' });
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('[I9] every reply and lookup is written down, secrets dropped; unreadable or unknown replies answer UNKNOWN', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('OBSTX1'), 2100);
    // A repeated key reaches the API as an array; every value is tried.
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: ['not-a-token', replyFor(row.merchantTransactionId, tx('OBSTX1'))] } });
    const seen = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id }, orderBy: { createdAt: 'asc' } });
    expect(seen.map((o) => o.source)).toEqual(['RETURN', 'LOOKUP']);
    expect(JSON.stringify(seen[0]!.body)).not.toContain('must-not-be-stored');
    expect(seen[0]!.shape).toMatchObject({ orderRef: 'string', paymentRef: 'string' });

    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: 'garbage' } })).toBe('UNKNOWN');
    const stranger = sandbox.sandboxReplyToken({ orderRef: '179000000000054321', paymentRef: 'X1' });
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: stranger } })).toBe('UNKNOWN');
    const orphans = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: null, failure: { in: ['NO_TOKEN', 'NO_CHECKOUT'] } }, orderBy: { createdAt: 'desc' }, take: 2 });
    expect(orphans.map((o) => o.failure).sort()).toEqual(['NO_CHECKOUT', 'NO_TOKEN']);
  });
});

describe('time — expiry is not failure, and billing waits for money in flight', () => {
  it('[I8] an unanswered checkout expires with no dunning and no notice; a late MMG confirmation still credits', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const later = new Date(Date.now() + MMG_CHECKOUT_TTL_MS + 60_000);
    await service.pollIntents(later);
    expect((await intentOf(row.id)).status).toBe('EXPIRED');
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } });
    expect(sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(await app.prisma.notification.count({ where: { userId: s.userId, data: { path: ['kind'], equals: 'billing_mmg_checkout' } } })).toBe(0);

    approved(tx('LATETX1'), 2100);
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(row.merchantTransactionId, tx('LATETX1')) } })).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('[I5] while a checkout is open the fee is not charged or dunned; once it expires, billing resumes', async () => {
    const now = new Date();
    const s = await makeSub({ due: new Date(now.getTime() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    await billing.runBillingCycle(now);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });

    const later = new Date(now.getTime() + MMG_CHECKOUT_TTL_MS + 60_000);
    await service.pollIntents(later);
    expect((await intentOf(row.id)).status).toBe('EXPIRED');
    await billing.runBillingCycle(later);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).failedAttempts).toBe(1);
  });

  it('a confirming checkout nobody could verify within a day expires; one MMG says is someone else’s is held', async () => {
    const quiet = await makeSub();
    const q = await intentOf((await start(quiet)).checkout.ref);
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(q.merchantTransactionId, tx('QUIETTX1')) } });
    const dayLater = new Date(Date.now() + DAY + 60_000);
    await service.pollIntents(dayLater);
    expect((await intentOf(q.id)).status).toBe('EXPIRED');

    const odd = await makeSub();
    const o = await intentOf((await start(odd)).checkout.ref);
    approved(tx('ODDTX1'), 2100, { creditParties: ['5926999999'] });
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: replyFor(o.merchantTransactionId, tx('ODDTX1')) } });
    expect((await intentOf(o.id)).status).toBe('CONFIRMING');
    await service.pollIntents(dayLater);
    expect(await intentOf(o.id)).toMatchObject({ status: 'HELD', reason: 'MERCHANT_MISMATCH' });
    expect(await topups(odd.subId)).toHaveLength(0);
  });
});

describe('what a partner may read about a checkout', () => {
  it('only their own; another subscription’s checkout is the same 404 as none at all', async () => {
    const s = await makeSub();
    const other = await makeSub();
    const k = key();
    const { checkout } = await start(s, k);
    expect(await service.getCheckout({ ref: checkout.ref, subscriptionId: s.subId })).toMatchObject({ ref: checkout.ref, status: 'OPEN', amountGyd: 2100, subscriptionStatus: 'ACTIVE' });
    await expect(service.getCheckout({ ref: checkout.ref, subscriptionId: other.subId })).rejects.toMatchObject({ statusCode: 404, code: 'CHECKOUT_NOT_FOUND' });
    await expect(service.getCheckout({ ref: 'nope', subscriptionId: s.subId })).rejects.toMatchObject({ statusCode: 404, code: 'CHECKOUT_NOT_FOUND' });
    // Once the checkout is not open, even its own key never hands the MMG page out again.
    await app.prisma.mmgCheckoutIntent.update({ where: { id: checkout.ref }, data: { status: 'CONFIRMING' } });
    expect((await start(s, k)).checkout).toMatchObject({ ref: checkout.ref, status: 'CONFIRMING', checkoutUrl: null });
  });
});
