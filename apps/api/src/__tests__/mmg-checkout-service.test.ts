import { readFeePaymentDecision } from '../modules/billing/fee-payment-authority';
import { resolveFinanceConfirmation } from '../modules/billing/confirmation-finance';
import { readDunningClock } from '../modules/billing/dunning-clock';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Prisma, SubscriptionStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_CHECKOUT_TTL_MS, MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { FakeMmgHistory, mmgHistoryRow, mmgTimeOf } from './helpers/mmg-history-fake';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { openCheckoutUrl } from '../modules/billing/checkout-url-seal';
import {
  PROVIDER_IDENTITY_BACKFILL_KEY,
  ensureProviderIdentityBackfill,
  resetProviderIdentityBackfillCacheForTests,
  runProviderIdentityBackfill,
} from '../modules/billing/provider-identity-backfill';
import { getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, newMerchantTransactionId, type MmgCheckoutProvider, type MmgCreationZone, type SandboxCheckoutKeys } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, sandboxAddHistory, type MmgHistoryAnswer, type MmgLookupClient, type MmgLookupDetail } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// The MMG weekly-fee checkout against the database (MMG-CHECKOUT-API.md).
// The sandbox runs the REAL request/reply cryptography under this file's own
// keys; the MMG lookup is scripted per transaction. Invariants from the plan:
//   I1 server-priced · I2 only MMG's lookup credits · I3 one MMG transaction,
//   one credit across channels · I4 one open checkout per subscription ·
//   I5 a checkout in flight pauses billing, a credit re-bills at once ·
//   I6 a mismatch holds for a person · I8 expiry is not failure ·
//   I9 every reply and lookup is written down first.
// And the AX353 findings: F1 a credit is tied to THIS checkout by MMG's own
// success answer for it (the owner's ruling of 1 Oct: six conditions, below)
// · F2 every channel claims one identity, history is
// backfilled before checkout credits · F3 a key keeps its answer · F4 an
// expiry never overwrites a newer state · F5 only MMG's answer for THIS
// checkout says "not paid" · F6 the page is sealed at rest · F7 evidence is
// filed under the checkout's own tenant.
// Phones: +592646… (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
let billing: BillingService;
let notifications: NotificationService;
let sandbox: SandboxMmgCheckoutProvider;
/** This file's one RSA pair: every sandbox below shares it, so any of them opens any reply. */
let keys: SandboxCheckoutKeys;
let service: MmgCheckoutService;
let checkoutProvider: () => MmgCheckoutProvider;
let kekBefore: string | undefined;

const lookups = new Map<string, MmgLookupDetail>();
const lookedUp: string[] = [];
/** [7 Oct] MMG's Transaction History (helpers/mmg-history-fake.ts): each test starts empty. */
const history = new FakeMmgHistory();
const lookup: MmgLookupClient = {
  transactionLookupDetail: async (id) => {
    lookedUp.push(id);
    return lookups.get(id) ?? { outcome: 'not_found' };
  },
  transactionHistoryRows: (query) => history.transactionHistoryRows(query),
};
type Found = Extract<MmgLookupDetail, { outcome: 'found' }>;
/** MMG stamps creationDate as Guyana wall-clock time written with a "Z" (UAT, 1 Oct). */
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
/** MMG's own ledger number for a payment: a different number from the reply's transactionId (UAT, 1 Oct). */
const ledgerOf = (txn: string) => `L${txn}`;
/** MMG's lookup answer in the exact UAT shape (evidence/mmg-uat/ROUNDTRIP-PROOF-20261001.md):
 *  transactionStatus, a whole-dollar amount string, currency, creationDate,
 *  transactionReference, the parties as [{ key: "accountid", value }] and
 *  metadata whose description is empty. Created now, inside a fresh checkout's window. */
const uatAnswer = (txn: string, amountGyd: number, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
  subType: 'subscriber_mpay', transactionReference: ledgerOf(txn),
  creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
  descriptionText: null, ...patch,
});
/** MMG's lookup of `txn`, read exactly as the live adapter reads it. `answer`
 *  patches MMG's own fields; `patch` the reading (an echo, a decline).
 *  [7 Oct] MMG's history holds the payment too, made now unless `history`
 *  patches its row (null: history does not have it). */
function approved(checkout: { merchantTransactionId: string }, txn: string, amountGyd: number, patch: Partial<Found> = {}, answer: Record<string, unknown> = {}, historyPatch: Record<string, unknown> | null = {}) {
  lookups.set(txn, { ...lookupDetailFrom(uatAnswer(txn, amountGyd, answer), txn), ...patch });
  if (historyPatch !== null) history.holds(txn, amountGyd, { external_id: checkout.merchantTransactionId, ...historyPatch });
}
/** [F1] MMG's answer echoing THIS checkout's reference in a confirmed reference
 *  field. MMG's lookup carries no such field (UAT, 1 Oct); an echo only ever
 *  adds a contradiction check, it never confirms. */
const echoOf = (row: { merchantTransactionId: string }): Partial<Found> => ({ echoedReferences: [row.merchantTransactionId] });

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;
const phoneBase = 592_646_000_000 + Math.floor(Math.random() * 900_000);

async function makeSub(opts: {
  status?: SubscriptionStatus;
  balance?: number;
  due?: Date;
  tenantId?: string;
  /** The merchant-initiated MMG rail (the push rail), with this payer number. */
  mmgPayer?: string;
  /** A second store of this owner, for one partner with two stores. */
  owner?: { userId: string; ownerId: string };
} = {}) {
  seq += 1;
  let userId: string;
  let ownerId: string;
  if (opts.owner) {
    ({ userId, ownerId } = opts.owner);
  } else {
    const user = await app.prisma.user.create({
      data: {
        phone: `+${phoneBase + seq}`, firstName: 'Fee', lastName: `P${seq}`,
        roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      },
    });
    userIds.push(user.id);
    userId = user.id;
    ownerId = (await app.prisma.vendorOwner.create({ data: { userId: user.id } })).id;
  }
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId, name: `Checkout Store ${seq}`, slug: `checkout-store-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
      addressLine1: '1 Checkout Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
  });
  vendorIds.push(vendor.id);
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100,
      billingMethod: opts.mmgPayer ? 'MOBILE_MONEY' : 'CASH', mmgPayerMsisdn: opts.mmgPayer ?? null,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      ...(opts.status === 'SUSPENDED' ? { suspendedAt: new Date(Date.now() - DAY), failedAttempts: 3, nextRetryAt: new Date(Date.now() + DAY) } : {}),
      prepaidBalance: { create: { balance: opts.balance ?? 0 } },
    },
  });
  subIds.push(sub.id);
  return { userId, ownerId, vendorId: vendor.id, subId: sub.id };
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
const toldOf = (userId: string, status?: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: 'billing_mmg_checkout' } },
}).then((rows) => rows.filter((row) => !status || (row.data as Record<string, unknown>)['status'] === status));
/** The official MMG response fields; only the server lookup is payment evidence. */
const replyFor = (merchantTransactionId: string, txn: string) => sandbox.sandboxReplyToken({ merchantTransactionId, transactionId: txn, ResultCode: '0', secretKey: 'must-not-be-stored' });
const reply = (row: { merchantTransactionId: string }, txn: string, outcome = 'success') =>
  service.observeReply({ source: 'RETURN', outcome, params: { token: replyFor(row.merchantTransactionId, txn) } });
const identityOf = (txn: string) => app.prisma.providerPayment.findFirst({ where: { provider: 'MMG', providerTxnId: txn.trim().toUpperCase(), status: { not: 'HELD_DUPLICATE' } } });
const subWithRelations = (subscriptionId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subscriptionId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
/** A checkout MMG sent back naming this transaction with its success answer,
 *  written down as a reply is (the push rail's ids fail the reply's id shape, so it is set directly). */
async function confirmingWith(ref: string, txn: string) {
  const row = await app.prisma.mmgCheckoutIntent.update({ where: { id: ref }, data: { status: 'CONFIRMING', candidates: [txn], replyAt: new Date(), nextCheckAt: new Date() } });
  await app.prisma.mmgCheckoutObservation.create({ data: {
    tenantId: row.tenantId, intentId: row.id, source: 'RETURN', detail: 'MMG_RESULT_0',
    body: { merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0' },
  } });
}
/** [DS632] The same sandbox (this file's keys) reading MMG's creationDate in another zone, or in none. */
const sandboxIn = (zone: MmgCreationZone | null) => new SandboxMmgCheckoutProvider(keys, zone);
/** MMG's success answer for `txn`, written down as a reply is, as received at `at` through `source`. */
async function answeredAt(row: { id: string; merchantTransactionId: string; tenantId: string }, txn: string, at: Date, source: 'RETURN' | 'NOTIFY') {
  const current = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: row.id } });
  await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: {
    status: 'CONFIRMING', candidates: [...new Set([...current.candidates, txn])],
    replyAt: current.replyAt && current.replyAt < at ? current.replyAt : at, nextCheckAt: new Date(),
  } });
  await app.prisma.mmgCheckoutObservation.create({ data: {
    tenantId: row.tenantId, intentId: row.id, source, detail: 'MMG_RESULT_0', createdAt: at,
    body: { merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0' },
  } });
}
/** The operator pages of one kind about one checkout. */
const pagesAbout = async (operatorId: string, checkoutId: string, alert: string) => (await app.prisma.notification.findMany({
  where: { userId: operatorId, data: { path: ['checkoutId'], equals: checkoutId } },
})).filter((n) => (n.data as Record<string, unknown>)['alert'] === alert);
/** A checkout written before the shared confirmation authority existed. Since
 *  then a checkout cannot open while another payment for the same fee is being
 *  confirmed, so a checkout and a live push request together are only a
 *  pre-cutover pair. Its sealed MMG page is a real one (a donor's). */
async function legacyCheckoutFor(s: { subId: string; userId: string }) {
  const donor = await makeSub();
  const template = await intentOf((await start(donor)).checkout.ref);
  return app.prisma.mmgCheckoutIntent.create({ data: {
    tenantId: template.tenantId, subscriptionId: s.subId, merchantTransactionId: newMerchantTransactionId(),
    amount: template.amount, currencyCode: 'GYD', createdByUserId: s.userId, platform: 'ios',
    checkoutUrlSealed: template.checkoutUrlSealed, checkoutUrlDek: template.checkoutUrlDek,
    expiresAt: new Date(Date.now() + MMG_CHECKOUT_TTL_MS),
  } });
}
/** Every credit of one MMG transaction: the push rail's success or bank, and the checkout's top-up. */
async function creditsOf(subscriptionId: string, txn: string, paymentId?: string) {
  const [pushed, banked, checkout] = await Promise.all([
    app.prisma.billingEvent.count({ where: { subscriptionId, type: 'CHARGE_SUCCESS', paymentRef: txn } }),
    paymentId ? app.prisma.billingEvent.count({ where: { idempotencyKey: `bank:${paymentId}` } }) : Promise.resolve(0),
    app.prisma.billingEvent.count({ where: { subscriptionId, type: 'PREPAID_TOPUP', idempotencyKey: { startsWith: 'mmg-checkout:' } } }),
  ]);
  return pushed + banked + checkout;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // the push rail's sandbox
  // [F6] The MMG page is sealed under the master key; this file's own.
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
  });
  keys = { request: pair, result: pair };
  // [DS632] Staging and UAT read MMG's creationDate as Guyana wall-clock time
  // (MMG_CHECKOUT_CREATION_ZONE=GUYANA_WALL_CLOCK, verified 1 Oct).
  sandbox = new SandboxMmgCheckoutProvider(keys, 'GUYANA_WALL_CLOCK');
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
  // [F2] The startup guard, once: every earlier credit on this database carries its identity.
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
}, 120_000);

beforeEach(() => {
  lookedUp.length = 0;
  checkoutProvider = () => sandbox;
  resetFeeCheckoutSwitchCache();
  history.reset();
});

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
  await app.prisma.mmgCheckoutObservation.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
  await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
  await app.prisma.platformConfig.deleteMany({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
  await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.cardSession.deleteMany({ where: { subscriptionId: { in: subIds } } });
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
      data: { ...row, id: undefined, merchantTransactionId: '179000000000099999', mmgTransactionId: null, providerPaymentId: null, candidates: [] } as never,
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

  it('an open checkout past its time is expired; with no answer from MMG it stays a confirmation until MMG or a person says it was not paid, then a fresh one starts', async () => {
    const s = await makeSub();
    const old = (await start(s)).checkout;
    await app.prisma.mmgCheckoutIntent.update({ where: { id: old.ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // An expired page may still be paid on MMG's side: never a second page yet.
    // [DS633] This refusal names no checkout: details.ref is optional.
    const refused = await start(s).catch((err: unknown) => err);
    expect(refused).toMatchObject({ statusCode: 409, code: 'PAYMENT_CONFIRMING' });
    expect((refused as { details?: { ref?: string } }).details?.ref).toBeUndefined();
    expect((await intentOf(old.ref)).status).toBe('EXPIRED');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
    // A person confirms it was not paid (finance review): the partner may pay again.
    const hold = await holdOf(old.ref);
    const clock = await clockOf(s.subId);
    await resolveFinanceConfirmation(app.prisma, { id: hold.id, tenantId: hold.tenantId, actorId: 'finance-test', sourceId: old.ref,
      epoch: hold.sourceEpoch, clockVersion: clock.version, decision: 'UNPAID', evidenceReference: 'statement checked' }, async () => {});
    const fresh = await start(s);
    expect(fresh.created).toBe(true);
    expect(fresh.checkout.ref).not.toBe(old.ref);
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

describe('[F3] an Idempotency-Key keeps its answer', () => {
  it('a key handed another tap’s open checkout is bound to it: once that is paid, the key opens nothing new', async () => {
    const s = await makeSub();
    const first = await start(s, key());
    const k2 = key();
    expect((await start(s, k2)).checkout.ref).toBe(first.checkout.ref);
    const row = await intentOf(first.checkout.ref);
    approved(row, tx('F3TX1'), 2100, echoOf(row));
    expect(await reply(row, tx('F3TX1'))).toBe('CONFIRMED');
    // The same tap retried after the payment: the paid checkout, never a new page.
    const retried = await start(s, k2);
    expect(retried).toMatchObject({ created: false, checkout: { ref: first.checkout.ref, status: 'CONFIRMED', checkoutUrl: null } });
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
  });

  it('a key refused because a checkout is being confirmed keeps that checkout as its answer', async () => {
    const s = await makeSub();
    const { checkout } = await start(s);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: checkout.ref }, data: { status: 'CONFIRMING' } });
    const refused = key();
    await expect(start(s, refused)).rejects.toMatchObject({ code: 'CHECKOUT_CONFIRMING' });
    await app.prisma.mmgCheckoutIntent.update({ where: { id: checkout.ref }, data: { status: 'NOT_PAID' } });
    expect(await start(s, refused)).toMatchObject({ created: false, checkout: { ref: checkout.ref, status: 'NOT_PAID', checkoutUrl: null } });
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
  });

  it('one key sent for two stores at once: one checkout, the other refused, no page for the wrong store', async () => {
    const one = await makeSub();
    const two = await makeSub({ owner: { userId: one.userId, ownerId: one.ownerId } });
    const k = key();
    const results = await Promise.allSettled([
      service.createCheckout({ subscriptionId: one.subId, userId: one.userId, platform: 'ios', clientKey: k }),
      service.createCheckout({ subscriptionId: two.subId, userId: one.userId, platform: 'ios', clientKey: k }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: { in: [one.subId, two.subId] } } })).toBe(1);
    expect(await app.prisma.mmgCheckoutKey.count({ where: { createdByUserId: one.userId, clientKey: k } })).toBe(1);
  });

  it('one key sent twice at once: one checkout, created once, the same answer twice', async () => {
    const s = await makeSub();
    const k = key();
    const [a, b] = await Promise.all([start(s, k), start(s, k)]);
    expect(a.checkout.ref).toBe(b.checkout.ref);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
  });
});

describe('[F6] the MMG page is sealed at rest', () => {
  it('the row holds no part of the URL; it opens only for the answer, under a wrapped key', async () => {
    const s = await makeSub();
    const { checkout } = await start(s);
    const url = checkout.checkoutUrl!;
    const row = await intentOf(checkout.ref);
    const stored = Buffer.from(row.checkoutUrlSealed).toString('latin1');
    for (const part of [url, new URL(url).host, new URL(url).search.slice(1, 40)]) expect(stored).not.toContain(part);
    expect(Buffer.from(row.checkoutUrlDek).length).toBeGreaterThan(32);
    expect(await openCheckoutUrl(row)).toBe(url);
    const columns = await app.prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'mmg_checkout_intents'`;
    expect(columns.map((c) => c.column_name)).not.toContain('checkoutUrl');
    // The database refuses a bare, unwrapped data key.
    await expect(app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { checkoutUrlDek: Uint8Array.from(randomBytes(32)) } }))
      .rejects.toThrow(/mmg_checkout_intents_sealed_check/);
  });

  it('with no master key there is no checkout at all: nothing is written down', async () => {
    const s = await makeSub();
    const kek = process.env['MASTER_KEK'];
    delete process.env['MASTER_KEK'];
    resetKeyProviderForTests();
    try {
      await expect(start(s)).rejects.toMatchObject({ statusCode: 503, code: 'MMG_CHECKOUT_UNAVAILABLE' });
      expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(0);
    } finally {
      process.env['MASTER_KEK'] = kek;
      resetKeyProviderForTests();
    }
  });
});

describe('the reply and the lookup — only MMG’s own records credit', () => {
  it('[I2 I3 I5] a verified reply credits once, reinstates at once, and a replay changes nothing', async () => {
    const s = await makeSub({ status: 'SUSPENDED' });
    const { checkout } = await start(s);
    const row = await intentOf(checkout.ref);
    const txn = `MMGTX${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, '7')}9`;
    approved(row, txn, 2100, echoOf(row));
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
    const told = await toldOf(s.userId);
    expect(told).toHaveLength(1);
    expect(told[0]!.data).toMatchObject({ ref: checkout.ref, status: 'CONFIRMED', vendorId: s.vendorId, subscriptionId: s.subId });

    // MMG's server and a page refresh repeat it: nothing moves again.
    expect(await service.observeReply({ source: 'NOTIFY', outcome: 'notify', params: { payload: token } })).toBe('CONFIRMED');
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token } })).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await toldOf(s.userId)).toHaveLength(1);
  });

  it('the redirect alone never credits: a transaction MMG does not know leaves it confirming, the wallet untouched', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    expect(await reply(row, tx('UNKNOWNTX1'))).toBe('CONFIRMING');
    const after = await intentOf(row.id);
    expect(after.status).toBe('CONFIRMING');
    expect(after.nextCheckAt).not.toBeNull();
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[owner, 1 Oct] MMG’s success answer for THIS checkout and an exact successful lookup credit with no echo of our reference; a paid lookup MMG never answered success for is held for a person, never credited', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('UNBOUNDTX1'), 2100);
    expect(await reply(row, tx('UNBOUNDTX1'))).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(tx('UNBOUNDTX1'))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}` });

    // ResultCode 7 (timed out) names a payment MMG's lookup shows paid: only
    // MMG's success answer confirms, so a person decides.
    const t = await makeSub();
    const row2 = await intentOf((await start(t)).checkout.ref);
    approved(row2, tx('UNBOUNDTX2'), 2100);
    expect(await codeReply(row2, '7', tx('UNBOUNDTX2'))).toBe('CONFIRMING');
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'NO_SUCCESS_ANSWER' });
    expect(await topups(t.subId)).toHaveLength(0);
    expect(await identityOf(tx('UNBOUNDTX2'))).toBeNull();
    expect(await toldOf(t.userId, 'HELD')).toHaveLength(1);
  });

  it('history binds overlapping checkouts without a lookup echo: the other checkout holds and the actual payer credits once', async () => {
    const payer = await makeSub();
    const other = await makeSub();
    const paid = await intentOf((await start(payer)).checkout.ref);
    const forged = await intentOf((await start(other)).checkout.ref);
    const txn = tx('HISTREFCROSS');
    approved(paid, txn, 2100); // Real lookup shape: no merchant-reference echo.
    expect(lookups.get(txn)).toMatchObject({ echoedReferences: [] });
    expect(await reply(forged, txn)).toBe('CONFIRMING');
    expect(await intentOf(forged.id)).toMatchObject({ status: 'HELD', reason: 'HISTORY_REFERENCE_MISMATCH' });
    expect(await topups(other.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await reply(paid, txn)).toBe('CONFIRMED');
    expect(await topups(payer.subId)).toHaveLength(1);
    expect(await identityOf(txn)).toMatchObject({ creditedPaymentId: `mco:${paid.id}` });
    expect(await reply(paid, txn)).toBe('CONFIRMED');
    expect(await topups(payer.subId)).toHaveLength(1);
  });

  it('[F1] a forged reply naming another payer’s transaction is held, and the real payer is still credited', async () => {
    const payer = await makeSub();
    const forger = await makeSub();
    const paid = await intentOf((await start(payer)).checkout.ref);
    const forged = await intentOf((await start(forger)).checkout.ref);
    // MMG's record of the payer's real payment names the payer's own checkout.
    approved(paid, tx('PAIDTX1'), 2100, { ...echoOf(paid), raw: { transactionReference: tx('PAIDTX1'), merchantReference: paid.merchantTransactionId } });
    // A reply built for the forger's checkout, naming that transaction.
    expect(await reply(forged, tx('PAIDTX1'))).toBe('CONFIRMING');
    expect(await intentOf(forged.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_OF_ANOTHER_CHECKOUT' });
    expect(await topups(forger.subId)).toHaveLength(0);
    expect(await identityOf(tx('PAIDTX1'))).toBeNull();
    // The payer's own return: MMG ties it to their checkout, and it credits once.
    expect(await reply(paid, tx('PAIDTX1'))).toBe('CONFIRMED');
    expect(await topups(payer.subId)).toHaveLength(1);
    expect(await identityOf(tx('PAIDTX1'))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${paid.id}` });
  });

  it('[F1] a contradictory reference is held: a different one, or more than one', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('MISMATCHTX1'), 2100, { echoedReferences: ['179000000000066666'] });
    await reply(row, tx('MISMATCHTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_MISMATCH' });

    const s2 = await makeSub();
    const row2 = await intentOf((await start(s2)).checkout.ref);
    approved(row2, tx('AMBIGUOUSTX1'), 2100, { echoedReferences: [row2.merchantTransactionId, '179000000000077777'] });
    await reply(row2, tx('AMBIGUOUSTX1'));
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_AMBIGUOUS' });
    expect([...await topups(s.subId), ...await topups(s2.subId)]).toHaveLength(0);
  });

  it('[I6] MMG’s record of THIS checkout with a different amount is held for a person; nothing credits', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('HELDTX1'), 2000, echoOf(row));
    expect(await reply(row, tx('HELDTX1'))).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'AMOUNT_MISMATCH' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('a mismatch on a transaction MMG’s success answer does not name waits instead of holding a payment still arriving; our reference in a description binds nothing', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('WEAKTX1'), 2000, { raw: { transactionReference: tx('WEAKTX1'), description: `Swift ${row.merchantTransactionId}` } });
    await codeReply(row, '7', tx('WEAKTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'SEEN:HOLD:AMOUNT_MISMATCH' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[I3] a transaction another channel already credited is never credited again', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    await app.prisma.providerPayment.create({
      data: { provider: 'MMG', providerTxnId: tx('TAKENTX1'), status: 'CREDITED', creditedPaymentId: 'agent-observation', subscriptionId: s.subId, amount: 2100, currencyCode: 'GYD', creditedAt: new Date() },
    });
    approved(row, tx('TAKENTX1'), 2100, echoOf(row));
    await reply(row, tx('TAKENTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[I3] and an admin top-up naming a transaction a checkout credited is refused', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('BOTHTX1'), 2100, echoOf(row));
    await reply(row, tx('BOTHTX1'));
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');
    const admin = await app.prisma.user.create({ data: { phone: `+${phoneBase + 9000 + seq}`, firstName: 'Ad', lastName: 'Min', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true } });
    userIds.push(admin.id);
    await expect(billing.recordTopUpCommand({ adminId: admin.id, idempotencyKey: key(), requestHash: 'h', subscriptionId: s.subId, amount: 2100, reference: tx('BOTHTX1') }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TOPUP_REFERENCE_ALREADY_CREDITED' });
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('[I9] every reply, lookup and history answer is written down, secrets dropped; unreadable or unknown replies answer UNKNOWN', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('OBSTX1'), 2100, echoOf(row));
    // [7 Oct] Someone else's payment in the same minutes: MMG lists it too, Swift never stores it.
    history.holds(tx('SOMEONEELSE'), 3300);
    // A repeated key reaches the API as an array; every value is tried.
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: ['not-a-token', replyFor(row.merchantTransactionId, tx('OBSTX1'))] } });
    const seen = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id }, orderBy: { createdAt: 'asc' } });
    expect(seen.map((o) => o.source)).toEqual(['RETURN', 'LOOKUP', 'HISTORY']);
    expect(JSON.stringify(seen[0]!.body)).not.toContain('must-not-be-stored');
    expect(seen[0]!.shape).toMatchObject({ merchantTransactionId: 'string', transactionId: 'string', ResultCode: 'string' });
    // [7 Oct] The history answer as asked and as decided on: the query, how many rows MMG listed, and only the record of THIS payment.
    expect(history.queries).toHaveLength(1);
    expect(seen[2]).toMatchObject({ detail: tx('OBSTX1'), failure: null });
    expect(seen[2]!.body).toEqual({ query: history.queries[0], rowsReturned: 2, truncated: false, naming: [history.rows.get(tx('OBSTX1'))] });
    expect(JSON.stringify(seen[2]!.body)).not.toContain(tx('SOMEONEELSE'));
    expect(seen[2]!.shape).toMatchObject({ '[].modificationDate': 'string', '[].transactionReference': 'string', '[].transactionReceipt': 'string' });
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');

    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: 'garbage' } })).toBe('UNKNOWN');
    const stranger = sandbox.sandboxReplyToken({ merchantTransactionId: '179000000000054321', transactionId: 'X1', ResultCode: '0' });
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: stranger } })).toBe('UNKNOWN');
    const orphans = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: null, failure: { in: ['NO_TOKEN', 'NO_CHECKOUT'] } }, orderBy: { createdAt: 'desc' }, take: 2 });
    expect(orphans.map((o) => o.failure).sort()).toEqual(['NO_CHECKOUT', 'NO_TOKEN']);
  });
});

describe('concurrent checkout replies and URL emission', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };

  it.each((['CONFIRMING', 'CONFIRMED', 'HELD', 'EXPIRED'] as const).flatMap((status) => ['same', 'new'].map((kind) => ({ status, kind }))))('does not emit a payable URL for a $kind key when unsealing overlaps $status', async ({ status, kind }) => {
    const s = await makeSub();
    const clientKey = key();
    const row = await intentOf((await start(s, clientKey)).checkout.ref);
    const keys = getKeyProvider()!;
    const unwrap = keys.unwrapDek.bind(keys);
    const entered = deferred();
    const release = deferred();
    const spy = vi.spyOn(keys, 'unwrapDek').mockImplementationOnce(async (wrapped) => {
      entered.resolve();
      await release.promise;
      return unwrap(wrapped);
    });
    const waiting = start(s, kind === 'same' ? clientKey : key());
    try {
      await entered.promise;
      if (status === 'CONFIRMED') {
        approved(row, tx(`UNSEALCONFIRMED${kind.toUpperCase()}`), 2100, echoOf(row));
        expect(await reply(row, tx(`UNSEALCONFIRMED${kind.toUpperCase()}`))).toBe('CONFIRMED');
      } else {
        await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { status } });
      }
      release.resolve();
      expect((await waiting).checkout).toMatchObject({ ref: row.id, status, checkoutUrl: null });
    } finally {
      release.resolve();
      await waiting;
      spy.mockRestore();
    }
  });

  it('a fresh start whose own unsealing overlaps a reply hands out no URL: the answer is the checkout as it now stands', async () => {
    // [DS386 #1] The first answer for a newly created checkout goes through the
    // same central responder as every replay: the checkout is written down
    // before its page is unsealed, so a reply can land during that unseal.
    const s = await makeSub();
    const keys = getKeyProvider()!;
    const unwrap = keys.unwrapDek.bind(keys);
    const entered = deferred();
    const release = deferred();
    const spy = vi.spyOn(keys, 'unwrapDek').mockImplementationOnce(async (wrapped) => {
      entered.resolve();
      await release.promise;
      return unwrap(wrapped);
    });
    const waiting = start(s);
    try {
      await entered.promise;
      const row = await app.prisma.mmgCheckoutIntent.findFirstOrThrow({ where: { subscriptionId: s.subId } });
      expect(row.status).toBe('OPEN');
      expect(await reply(row, tx('UNSEALFRESH'))).toBe('CONFIRMING');
      release.resolve();
      expect(await waiting).toMatchObject({ created: true, checkout: { ref: row.id, status: 'CONFIRMING', checkoutUrl: null } });
    } finally {
      release.resolve();
      await waiting.catch(() => undefined);
      spy.mockRestore();
    }
  });

  it('expires an OPEN checkout whose deadline passes during unsealing', async () => {
    const s = await makeSub();
    const clientKey = key();
    const row = await intentOf((await start(s, clientKey)).checkout.ref);
    const keys = getKeyProvider()!;
    const unwrap = keys.unwrapDek.bind(keys);
    const spy = vi.spyOn(keys, 'unwrapDek').mockImplementationOnce(async (wrapped) => {
      await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      return unwrap(wrapped);
    });
    try {
      expect((await start(s, clientKey)).checkout).toMatchObject({ status: 'EXPIRED', checkoutUrl: null });
    } finally { spy.mockRestore(); }
  });

  it('a duplicate-key binding closure rechecks state when its answer is used', async () => {
    const s = await makeSub();
    const clientKey = key();
    const row = await intentOf((await start(s, clientKey)).checkout.ref);
    const internal = service as unknown as { bindKey(who: { userId: string; subscriptionId: string; clientKey: string }, intent: typeof row, now: Date): Promise<{ answer(): Promise<{ checkout: { status: string; checkoutUrl: string | null } }> }> };
    const binding = await internal.bindKey({ userId: s.userId, subscriptionId: s.subId, clientKey }, row, new Date());
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { status: 'HELD' } });
    expect((await binding.answer()).checkout).toMatchObject({ status: 'HELD', checkoutUrl: null });
  });

  it('unions concurrent transactions and retains the earliest reply time', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const delegate = app.prisma.mmgCheckoutIntent;
    const read = delegate.findUnique.bind(delegate);
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let seen = 0;
    const spy = vi.spyOn(delegate, 'findUnique').mockImplementation((async (args: Parameters<typeof read>[0]) => {
      const snapshot = await read(args);
      if (args.where.merchantTransactionId === row.merchantTransactionId) {
        const index = seen++;
        entered[index]!.resolve();
        await release[index]!.promise;
      }
      return snapshot;
    }) as unknown as typeof read);
    const first = reply(row, tx('UNIONA'));
    await entered[0]!.promise;
    const firstEntered = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = reply(row, tx('UNIONB'));
    try {
      await entered[1]!.promise;
      release[0]!.resolve();
      await first;
      release[1]!.resolve();
      await second;
      const after = await intentOf(row.id);
      expect(after.candidates.sort()).toEqual([tx('UNIONA'), tx('UNIONB')].sort());
      expect(after.replyAt!.getTime()).toBeLessThanOrEqual(firstEntered);
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.all([first, second]);
      spy.mockRestore();
    }
  });

  it('reply persistence and CONFIRMING are atomic against deadline expiry, fresh taps and billing', async () => {
    const now = new Date();
    const s = await makeSub({ due: new Date(now.getTime() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    const deadline = new Date(now.getTime() + 60_000);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { expiresAt: deadline } });
    const persisted = deferred();
    const release = deferred();
    const expiryQueued = deferred();
    const transaction = app.prisma.$transaction.bind(app.prisma);
    const txSpy = vi.spyOn(app.prisma, '$transaction').mockImplementation((async (fn: (db: Prisma.TransactionClient) => Promise<unknown>) => transaction(async (db) => {
      const update = db.mmgCheckoutIntent.updateMany.bind(db.mmgCheckoutIntent);
      const hook = vi.spyOn(db.mmgCheckoutIntent, 'updateMany').mockImplementation((async (args: Parameters<typeof update>[0]) => {
        const result = await update(args);
        if (args?.where?.id === row.id && args.data.replyAt !== undefined) {
          persisted.resolve();
          await release.promise;
        }
        return result;
      }) as unknown as typeof update);
      try { return await fn(db); } finally { hook.mockRestore(); }
    })) as unknown as typeof transaction);
    const update = app.prisma.mmgCheckoutIntent.updateMany.bind(app.prisma.mmgCheckoutIntent);
    const expirySpy = vi.spyOn(app.prisma.mmgCheckoutIntent, 'updateMany').mockImplementation((async (args: Parameters<typeof update>[0]) => {
      if (args?.where?.id === row.id && args.data.status === 'EXPIRED') expiryQueued.resolve();
      return update(args);
    }) as unknown as typeof update);
    const response = reply(row, tx('DEADLINERACE'));
    let expiry: Promise<boolean> | undefined;
    try {
      await persisted.promise;
      const internal = service as unknown as { expireUnanswered(id: string, now: Date): Promise<boolean> };
      expiry = internal.expireUnanswered(row.id, new Date(deadline.getTime() + 1));
      await expiryQueued.promise;
      // Observe the actual database wait, not just a queued JavaScript call.
      // Only this lane's database is inspected; the expiry must have reached
      // PostgreSQL before the reply transaction is allowed to commit.
      let blocked = 0;
      for (let attempt = 0; attempt < 100 && blocked === 0; attempt += 1) {
        const rows = await app.prisma.$queryRaw<Array<{ blocked: number }>>`
          SELECT count(*)::int AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%UPDATE%mmg_checkout_intents%'`;
        blocked = rows[0]?.blocked ?? 0;
        if (blocked === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBeGreaterThan(0);
      release.resolve();
      expect(await expiry).toBe(false);
      expect(await response).toBe('CONFIRMING');
      expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', candidates: [tx('DEADLINERACE')] });
    } finally {
      release.resolve();
      await Promise.all([response, expiry]);
      txSpy.mockRestore();
      expirySpy.mockRestore();
    }
    await expect(start(s)).rejects.toMatchObject({ code: 'CHECKOUT_CONFIRMING' });
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
    await billing.runBillingCycle(new Date(deadline.getTime() + 1));
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
  });

  it('a concurrent empty failure reply preserves the transaction before either verifier runs', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const transactionId = tx('EMPTYSECOND');
    approved(row, transactionId, 2100); // MMG answers success and not-paid for one checkout: a person decides
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const verified = [deferred(), deferred()];
    const verifyRelease = deferred();
    const read = app.prisma.mmgCheckoutIntent.findUnique.bind(app.prisma.mmgCheckoutIntent);
    let reads = 0;
    const readSpy = vi.spyOn(app.prisma.mmgCheckoutIntent, 'findUnique').mockImplementation((async (args: Parameters<typeof read>[0]) => {
      const snapshot = await read(args);
      if (args.where.merchantTransactionId === row.merchantTransactionId) {
        const index = reads++;
        entered[index]!.resolve();
        await release[index]!.promise;
      }
      return snapshot;
    }) as unknown as typeof read);
    const internal = service as unknown as { verify(id: string, now: Date): Promise<string> };
    const verify = internal.verify.bind(service);
    let verifies = 0;
    const verifySpy = vi.spyOn(internal, 'verify').mockImplementation(async (id, now) => {
      verified[verifies++]!.resolve();
      await verifyRelease.promise;
      return verify(id, now);
    });
    const first = reply(row, transactionId);
    await entered[0]!.promise;
    const second = service.observeReply({ source: 'NOTIFY', params: { token: sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, ResultCode: '1' }) } });
    try {
      await entered[1]!.promise;
      release[0]!.resolve();
      await verified[0]!.promise;
      release[1]!.resolve();
      await verified[1]!.promise;
      expect((await intentOf(row.id)).candidates).toEqual([transactionId]);
      verifyRelease.resolve();
      await Promise.all([first, second]);
      expect(lookedUp).toContain(transactionId);
      expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'MMG_ANSWERS_DISAGREE' });
      expect(await topups(s.subId)).toHaveLength(0);
    } finally {
      release.forEach((gate) => gate.resolve());
      verifyRelease.resolve();
      await Promise.all([first, second]);
      readSpy.mockRestore();
      verifySpy.mockRestore();
    }
  });

  it('a reply read before a hold cannot add candidates or reschedule the held checkout', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const delegate = app.prisma.mmgCheckoutIntent;
    const read = delegate.findUnique.bind(delegate);
    const entered = deferred();
    const release = deferred();
    const spy = vi.spyOn(delegate, 'findUnique').mockImplementation((async (args: Parameters<typeof read>[0]) => {
      const snapshot = await read(args);
      if (args.where.merchantTransactionId === row.merchantTransactionId) {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    }) as unknown as typeof read);
    const waiting = reply(row, tx('STALEHELD'));
    try {
      await entered.promise;
      await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { status: 'HELD', nextCheckAt: null } });
      release.resolve();
      expect(await waiting).toBe('CONFIRMING');
      expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', candidates: [], replyAt: null, nextCheckAt: null });
    } finally {
      release.resolve();
      await waiting;
      spy.mockRestore();
    }
  });
});

describe('the official MMG response contract', () => {
  const send = (merchantTransactionId: unknown, transactionId: unknown, ResultCode: unknown, extra = {}) =>
    service.observeReply({ source: 'RETURN', outcome: 'success', params: {
      TOKEN: sandbox.sandboxReplyToken({ merchantTransactionId, transactionId, ResultCode, ResultMessage: 'Provider message', htmlResponse: '<b>Provider content</b>', ...extra }),
    } });

  it.each(['missing', 'nested', 'padded', 'substring', 'number'] as const)('rejects a %s merchant reference without looking up or changing a checkout', async (kind) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`REF${kind.toUpperCase()}`);
    approved(row, txn, 2100, echoOf(row));
    const ref = kind === 'padded' ? ` ${row.merchantTransactionId} ` : kind === 'substring' ? `prefix${row.merchantTransactionId}` : kind === 'number' ? Number(row.merchantTransactionId) : undefined;
    expect(await send(ref, txn, '0', { nested: { merchantTransactionId: row.merchantTransactionId }, orderRef: row.merchantTransactionId })).toBe('UNKNOWN');
    expect(await intentOf(row.id)).toMatchObject({ status: 'OPEN', candidates: [], replyAt: null });
    expect(lookedUp).toEqual([]);
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it.each([undefined, 0, '8', '00', ' 0', 'success'])('rejects unknown or non-string ResultCode %s', async (code) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`BADCODE${seq}`);
    approved(row, txn, 2100, echoOf(row));
    expect(await send(row.merchantTransactionId, txn, code)).toBe('UNKNOWN');
    expect((await intentOf(row.id)).status).toBe('OPEN');
    expect(lookedUp).toEqual([]);
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('uses only transactionId, ignoring nested ids, messages and HTML', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const known = tx('OTHERFIELD');
    const official = tx('OFFICIAL');
    approved(row, known, 2100, echoOf(row));
    expect(await send(row.merchantTransactionId, official, '0', {
      paymentRef: known, nested: { transactionId: known }, ResultMessage: known, htmlResponse: known,
    })).toBe('CONFIRMING');
    expect(lookedUp).toEqual([official]);
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('ResultCode 0 credits only after MMG’s lookup confirms the payment', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('PAIDCODE0');
    expect(await send(row.merchantTransactionId, txn, '0')).toBe('CONFIRMING'); // MMG does not know it yet
    expect(await topups(s.subId)).toHaveLength(0);
    approved(row, txn, 2100);
    expect(await send(row.merchantTransactionId, txn, '0')).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
    expect((await intentOf(row.id)).outcomeHint).toBe('MMG_RESULT_0');
  });

  it.each(['1', '2', '6', '7'])('[owner, 1 Oct] after ResultCode %s, a lookup that says paid is held for a person, never credited automatically', async (code) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`PAIDCODE${code}`);
    // 1, 2 and 6 are "not paid" at once; 7 waits for MMG's lookup.
    const notPaid = ['1', '2', '6'].includes(code);
    expect(await send(row.merchantTransactionId, txn, code)).toBe(notPaid ? 'NOT_PAID' : 'CONFIRMING');
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(notPaid ? 1 : 0);
    approved(row, txn, 2100, echoOf(row));
    expect(await send(row.merchantTransactionId, txn, code)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'NO_SUCCESS_ANSWER', outcomeHint: `MMG_RESULT_${code}` });
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
  });

  it.each(['1', '2', '6', '7'])('ResultCode %s declares NOT_PAID once (7 when MMG declines the transaction it named), releases the pause, and credits nothing', async (code) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`FAILED${code}`);
    approved(row, txn, 2100, { status: 'declined' });
    expect(await send(row.merchantTransactionId, txn, code)).toBe('NOT_PAID');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(1);
    expect((await holdOf(row.id)).status).toBe('PROVEN_UNPAID');
    expect(await send(row.merchantTransactionId, txn, code)).toBe('NOT_PAID');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(1);
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
  });

  it.each([['3', 'INVALID_SECRET_KEY'], ['4', 'MERCHANT_ID_MISMATCH'], ['5', 'TOKEN_DECRYPTION_FAILED']])('ResultCode %s is a configuration alert: the checkout is untouched, nothing is looked up or credited, operators are paged once', async (code, reason) => {
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const before = await intentOf(row.id);
    const holdBefore = await holdOf(row.id);
    const txn = tx(`CONFIGONLY${code}`);
    approved(row, txn, 2100, echoOf(row));
    for (let n = 0; n < 2; n += 1) expect(await codeReply(row, code, txn)).toBe('UNKNOWN');
    expect(await intentOf(row.id)).toEqual(before);
    expect(await holdOf(row.id)).toEqual(holdBefore);
    expect(lookedUp).toEqual([]);
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await toldOf(s.userId)).toHaveLength(0);
    const seen = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id, source: 'RETURN' } });
    expect(seen.map((o) => o.detail)).toEqual([`MMG_RESULT_${code}`, `MMG_RESULT_${code}`]);
    const alerts = await app.prisma.notification.findMany({ where: { userId: operator.id, data: { path: ['checkoutId'], equals: row.id } } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ alert: 'mmg-checkout-reply-code', resultCode: code, reason: `MMG_RESULT_${code}_${reason}` });
    expect(JSON.stringify(alerts)).not.toContain('Provider content');
    expect(JSON.stringify(alerts)).not.toContain('Provider message');
    // The untouched checkout still follows MMG's own lookup for a later answer.
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it.each((['CONFIRMED', 'HELD'] as const).flatMap((status) => (['3', '4', '5'] as const).map((code) => ({ status, code }))))(
    'ResultCode $code for a $status checkout is still a configuration alert: paged once, nothing changed, nothing looked up', async ({ status, code }) => {
      const s = await makeSub();
      const operator = await operatorFor();
      const row = await intentOf((await start(s)).checkout.ref);
      if (status === 'CONFIRMED') {
        const paid = tx(`CONFIGPAID${code}`);
        approved(row, paid, 2100, echoOf(row));
        expect(await codeReply(row, '0', paid)).toBe('CONFIRMED');
      } else {
        await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { status: 'HELD', reason: 'REFERENCE_NOT_ECHOED', nextCheckAt: null } });
      }
      const before = await intentOf(row.id);
      const credits = (await topups(s.subId)).length;
      lookedUp.length = 0;
      const txn = tx(`CONFIGLATE${status}${code}`);
      for (let n = 0; n < 2; n += 1) expect(await codeReply(row, code, txn)).toBe('UNKNOWN');
      expect(await intentOf(row.id)).toEqual(before);
      expect(lookedUp).toEqual([]);
      expect(await topups(s.subId)).toHaveLength(credits);
      expect(await identityOf(txn)).toBeNull();
      const alerts = await app.prisma.notification.findMany({ where: { userId: operator.id, data: { path: ['checkoutId'], equals: row.id } } });
      expect(alerts.filter((alert) => (alert.data as { alert?: string }).alert === 'mmg-checkout-reply-code')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// The official ResultCode rules (owner brief, 30 Sep): 1 not registered, 2
// failed and 6 cancelled are "not paid" and release the confirmation pause so
// the partner can pay again; 7 timed out is not paid unless MMG's lookup says
// paid; 3, 4 and 5 are a configuration alert that never touches the checkout.
// A negative answer after a success answer for the same checkout releases
// nothing: MMG's own lookup decides. Nothing here ever credits.
// ---------------------------------------------------------------------------
const holdOf = (checkoutId: string) => app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { checkoutId } });
const clockOf = (subscriptionId: string) => app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
const codeReply = (row: { merchantTransactionId: string }, ResultCode: string, transactionId?: string, source: 'RETURN' | 'NOTIFY' = 'RETURN') =>
  service.observeReply({ source, outcome: source === 'RETURN' ? 'success' : 'notify', params: { token: sandbox.sandboxReplyToken({
    merchantTransactionId: row.merchantTransactionId, ...(transactionId ? { transactionId } : {}), ResultCode,
    ResultMessage: 'Provider message', htmlResponse: '<b>Provider content</b>',
  }) } });
const operatorFor = async () => {
  const operator = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + 30000 + (seq += 1)}`, firstName: 'Test', lastName: 'Operator', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true,
  } });
  userIds.push(operator.id);
  return operator;
};

describe('the official ResultCode rules: MMG’s negative answers release the pause; configuration codes touch nothing', () => {
  it.each(['1', '2', '6'])('ResultCode %s is not paid: NOT_PAID, the confirmation pause is released once, and the partner may pay again', async (code) => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();

    expect(await codeReply(row, code)).toBe('NOT_PAID');
    expect(lookedUp).toEqual([]);
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID', reason: `MMG_RESULT_${code}`, candidates: [], nextCheckAt: null });
    expect(await holdOf(row.id)).toMatchObject({ status: 'PROVEN_UNPAID', resolvedBy: 'mmg-checkout-reply' });
    expect((await clockOf(s.subId)).pausedAt).toBeNull();
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).billingConfirmationPausedAt).toBeNull();
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(1);
    expect(await topups(s.subId)).toHaveLength(0);

    // MMG's server repeating the same answer changes nothing and tells nobody twice.
    expect(await codeReply(row, code, undefined, 'NOTIFY')).toBe('NOT_PAID');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(1);
    expect((await holdOf(row.id)).resolutionHistory).toHaveLength(1);
    // The partner may try again: a fresh tap opens a new MMG page.
    const fresh = await start(s);
    expect(fresh).toMatchObject({ created: true, checkout: { status: 'OPEN' } });
    expect(fresh.checkout.ref).not.toBe(row.id);
    expect(fresh.checkout.checkoutUrl).toEqual(expect.any(String));
  });

  it('a failed reply naming a transaction is released too, and that transaction is still looked at: when MMG then answers success for it and its lookup says paid, the answers disagree and a person decides', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('FAILEDLATEPAID');
    expect(await codeReply(row, '2', txn)).toBe('NOT_PAID');
    const released = await intentOf(row.id);
    expect(released).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_RESULT_2', candidates: [txn] });
    expect(released.nextCheckAt).not.toBeNull();
    expect((await holdOf(row.id)).status).toBe('PROVEN_UNPAID');
    expect((await clockOf(s.subId)).pausedAt).toBeNull();

    approved(row, txn, 2100, echoOf(row));
    expect(await codeReply(row, '0', txn, 'NOTIFY')).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'MMG_ANSWERS_DISAGREE' });
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    await service.pollIntents(new Date(released.nextCheckAt!.getTime() + 1000));
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
  });

  it('a late record MMG shows as paid but that cannot be tied to the checkout, after a released negative, is HELD and pauses the same obligation again', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('FAILEDLATEHELD');
    expect(await codeReply(row, '2', txn)).toBe('NOT_PAID');
    const released = await intentOf(row.id);
    expect((await clockOf(s.subId)).pausedAt).toBeNull();

    approved(row, txn, 2100); // MMG's lookup says paid; MMG never answered success for this checkout
    await service.pollIntents(new Date(released.nextCheckAt!.getTime() + 1000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'NO_SUCCESS_ANSWER' });
    const hold = await holdOf(row.id);
    expect(hold).toMatchObject({ status: 'ACTIVE', resolvedAt: null, resolvedBy: null });
    expect((hold.resolutionHistory as Array<Record<string, unknown>>).map((h) => h['status'])).toEqual(['PROVEN_UNPAID', 'LATE_POSITIVE_REVIEW']);
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(1);
    const alerts = await app.prisma.notification.findMany({ where: { userId: operator.id, data: { path: ['checkoutId'], equals: row.id } } });
    expect(alerts.map((a) => (a.data as Record<string, unknown>)['alert'])).toEqual(['mmg-checkout-held']);
    await expect(start(s)).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_CONFIRMING' });
  });

  it('a late paid-looking record for an OLDER obligation is held for a person but never pauses the newer one', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('OLDEROBLIGATION');
    expect(await codeReply(row, '6', txn)).toBe('NOT_PAID');
    const released = await intentOf(row.id);
    // The partner pays the owed week another way (cash to the wallet, then the
    // ordinary weekly charge): the obligation moves on.
    await app.prisma.$transaction((db) => billing.recordTopUpInTransaction(db, { subscriptionId: s.subId, amount: 2100, recordedBy: 'test-cash', eventKey: `older-obligation:${RUN}` }));
    expect(await billing.billSubscription(await subWithRelations(s.subId) as never)).toBe('succeeded');
    const moved = await clockOf(s.subId);
    expect(moved.epoch).toBeGreaterThan((await holdOf(row.id)).sourceEpoch);
    expect(moved.pausedAt).toBeNull();

    approved(row, txn, 2100);
    await service.pollIntents(new Date(released.nextCheckAt!.getTime() + 1000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'NO_SUCCESS_ANSWER' });
    expect((await holdOf(row.id)).status).toBe('PROVEN_UNPAID');
    expect((await clockOf(s.subId)).pausedAt).toBeNull();
    expect(await topups(s.subId)).toHaveLength(1); // the cash only
  });

  it('after a success answer, a later negative answer releases nothing; when MMG’s lookup then says paid, the answers disagree and a person decides', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('SUCCESSTHENFAIL');
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMING'); // MMG does not know it yet
    expect(await codeReply(row, '2')).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', candidates: [txn] });
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(0);
    await expect(start(s)).rejects.toMatchObject({ code: 'CHECKOUT_CONFIRMING', details: { ref: row.id } });
    approved(row, txn, 2100);
    await service.pollIntents(new Date(Date.now() + 5 * 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'MMG_ANSWERS_DISAGREE' });
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('ResultCode 7 is not paid unless the lookup says paid: no transaction releases; a declined transaction releases; an unknown one keeps the pause', async () => {
    const bare = await makeSub({ due: new Date(Date.now() - 60_000) });
    const b = await intentOf((await start(bare)).checkout.ref);
    expect(await codeReply(b, '7')).toBe('NOT_PAID');
    expect(await intentOf(b.id)).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_RESULT_7' });
    expect((await holdOf(b.id)).status).toBe('PROVEN_UNPAID');

    const declined = await makeSub({ due: new Date(Date.now() - 60_000) });
    const d = await intentOf((await start(declined)).checkout.ref);
    approved(d, tx('TIMEDOUTDECLINED'), 2100, { status: 'declined' }); // not tied to the checkout by MMG's echo
    expect(await codeReply(d, '7', tx('TIMEDOUTDECLINED'))).toBe('NOT_PAID');
    expect(await intentOf(d.id)).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_DECLINED' });
    expect((await holdOf(d.id)).status).toBe('PROVEN_UNPAID');
    expect((await clockOf(declined.subId)).pausedAt).toBeNull();

    const unknown = await makeSub({ due: new Date(Date.now() - 60_000) });
    const u = await intentOf((await start(unknown)).checkout.ref);
    expect(await codeReply(u, '7', tx('TIMEDOUTUNKNOWN'))).toBe('CONFIRMING'); // MMG does not know it
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect(await intentOf(u.id)).toMatchObject({ status: 'EXPIRED', reason: 'LOOKUP_NEVER_CONFIRMED' });
    expect((await holdOf(u.id)).status).toBe('ACTIVE');
    expect((await clockOf(unknown.subId)).pausedAt).not.toBeNull();
    expect(await toldOf(unknown.userId, 'NOT_PAID')).toHaveLength(0);
    for (const sub of [bare, declined, unknown]) expect(await topups(sub.subId)).toHaveLength(0);
  });

  it('a late cancelled answer for an expired, unanswered checkout releases it', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    await service.pollIntents(new Date(Date.now() + MMG_CHECKOUT_TTL_MS + 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'NO_REPLY' });
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect(await codeReply(row, '6')).toBe('NOT_PAID');
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_RESULT_6' });
    expect((await holdOf(row.id)).status).toBe('PROVEN_UNPAID');
    expect((await start(s)).created).toBe(true);
  });
});

describe('[F5] only MMG’s answer for THIS checkout says a payment failed', () => {
  it('the error path with nothing MMG knows keeps confirming, then expires without declaring failure', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    expect(await reply(row, tx('NOSUCHTX1'), 'error')).toBe('CONFIRMING');
    expect((await intentOf(row.id)).status).toBe('CONFIRMING');
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'EXPIRED', reason: 'LOOKUP_NEVER_CONFIRMED' });
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(0);
  });

  it('the error path decides nothing by itself: MMG’s own ResultCode for THIS checkout does', async () => {
    // A success code arriving on the error path still waits for the lookup.
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    expect(await reply(row, tx('ERRORPATHOK'), 'error')).toBe('CONFIRMING');
    expect((await intentOf(row.id)).status).toBe('CONFIRMING');
    // MMG's not-registered answer for this checkout is "not paid", whatever the path.
    const t = await makeSub();
    const row2 = await intentOf((await start(t)).checkout.ref);
    const token = sandbox.sandboxReplyToken({ merchantTransactionId: row2.merchantTransactionId, ResultCode: '1' });
    expect(await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token } })).toBe('NOT_PAID');
    expect(await intentOf(row2.id)).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_RESULT_1' });
  });

  it('a decline MMG does not tie to this checkout never says "not paid"', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('DECLINEDTX1'), 2100, { status: 'declined' });
    expect(await reply(row, tx('DECLINEDTX1'), 'error')).toBe('CONFIRMING');
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect((await intentOf(row.id)).status).toBe('EXPIRED');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(0);
  });

  it('MMG’s answer for THIS checkout that the payment failed is NOT_PAID, and the partner hears it once', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('BOUNDDECLINETX1'), 2100, { status: 'declined', ...echoOf(row) });
    expect(await reply(row, tx('BOUNDDECLINETX1'), 'error')).toBe('NOT_PAID');
    expect(await intentOf(row.id)).toMatchObject({ status: 'NOT_PAID', reason: 'MMG_DECLINED' });
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(1);
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
    expect(await toldOf(s.userId)).toHaveLength(0);

    approved(row, tx('LATETX1'), 2100, echoOf(row));
    expect(await reply(row, tx('LATETX1'))).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('[I5] local checkout expiry keeps collection paused until authoritative confirmation', async () => {
    const now = new Date();
    const s = await makeSub({ due: new Date(now.getTime() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    await billing.runBillingCycle(now);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });

    const later = new Date(now.getTime() + MMG_CHECKOUT_TTL_MS + 60_000);
    await service.pollIntents(later);
    expect((await intentOf(row.id)).status).toBe('EXPIRED');
    await billing.runBillingCycle(later);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).toMatchObject({ failedAttempts: 0, billingConfirmationPausedAt: expect.any(Date), nextRetryAt: null });
  });

  it('a confirming checkout nobody could verify within a day expires; one MMG says is someone else’s is held', async () => {
    const quiet = await makeSub();
    const q = await intentOf((await start(quiet)).checkout.ref);
    await reply(q, tx('QUIETTX1'));
    const dayLater = new Date(Date.now() + DAY + 60_000);
    await service.pollIntents(dayLater);
    expect((await intentOf(q.id)).status).toBe('EXPIRED');

    const odd = await makeSub();
    const o = await intentOf((await start(odd)).checkout.ref);
    approved(o, tx('ODDTX1'), 2100, {}, { creditParty: [{ key: 'accountid', value: '5926999999' }] });
    await codeReply(o, '7', tx('ODDTX1')); // timed out: MMG's success answer never named it
    expect((await intentOf(o.id)).status).toBe('CONFIRMING');
    await service.pollIntents(dayLater);
    expect(await intentOf(o.id)).toMatchObject({ status: 'HELD', reason: 'MERCHANT_MISMATCH' });
    expect(await topups(odd.subId)).toHaveLength(0);
  });

  it('[F4] an expiry that read an OPEN row never overwrites a reply that made it CONFIRMING', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // The partner came back through MMG a moment before the stale expiry ran.
    expect(await reply(row, tx('RACETX1'))).toBe('CONFIRMING');
    expect(await (service as unknown as { expireUnanswered(id: string, now: Date): Promise<boolean> }).expireUnanswered(row.id, new Date())).toBe(false);
    expect((await intentOf(row.id)).status).toBe('CONFIRMING');
    await expect(start(s)).rejects.toMatchObject({ code: 'CHECKOUT_CONFIRMING' });
  });

  it('[F4] a new tap whose expiry lost that race reads again: no second checkout while the first is being confirmed', async () => {
    const s = await makeSub();
    const first = (await start(s)).checkout;
    await app.prisma.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const svc = service as unknown as { expireUnanswered(id: string, now: Date): Promise<boolean> };
    const real = svc.expireUnanswered.bind(service);
    // The reply lands between the tap's read of the stale OPEN row and its expiry.
    svc.expireUnanswered = async (id, now) => {
      await app.prisma.mmgCheckoutIntent.update({ where: { id }, data: { status: 'CONFIRMING', replyAt: new Date() } });
      return real(id, now);
    };
    try {
      await expect(start(s)).rejects.toMatchObject({ code: 'CHECKOUT_CONFIRMING', details: { ref: first.ref } });
    } finally {
      delete (service as unknown as Record<string, unknown>)['expireUnanswered'];
    }
    expect((await intentOf(first.ref)).status).toBe('CONFIRMING');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
  });

  it('[F4] a confirming checkout expires only past its window, and only while it is still confirming', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    await reply(row, tx('WINDOWTX1'));
    const confirming = await intentOf(row.id);
    const svc = service as unknown as { expireUnconfirmed(intent: unknown, now: Date): Promise<string> };
    expect(await svc.expireUnconfirmed(confirming, new Date())).toBe('CONFIRMING');
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { status: 'HELD', reason: 'TEST' } });
    expect(await svc.expireUnconfirmed(confirming, new Date(Date.now() + DAY + 60_000))).toBe('HELD');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'TEST' });
  });
});

describe('[F2] one MMG transaction, one credit, across every channel and every earlier credit', () => {
  it('checkout crediting stays off until the backfill has run; the startup guard runs it and the confirmation then credits', async () => {
    await app.prisma.platformConfig.deleteMany({ where: { key: PROVIDER_IDENTITY_BACKFILL_KEY } });
    resetProviderIdentityBackfillCacheForTests();
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('GUARDTX1'), 2100, echoOf(row));
    expect(await reply(row, tx('GUARDTX1'))).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'IDENTITY_BACKFILL_PENDING' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(tx('GUARDTX1'))).toBeNull();

    await service.pollIntents(new Date(Date.now() + 5 * 60_000));
    const record = await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: PROVIDER_IDENTITY_BACKFILL_KEY } });
    expect(record.value).toMatchObject({ completedAt: expect.any(String) });
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('a transaction an admin top-up credited before identities existed is refused by checkout after the backfill', async () => {
    const s = await makeSub();
    // What a top-up recorded before this release left behind: the credit, its
    // receipt naming the transfer, and no provider identity.
    await app.prisma.$transaction((t) => billing.recordTopUpInTransaction(t, {
      subscriptionId: s.subId, amount: 2100, recordedBy: 'admin-before-identities', reference: tx('LEGACYTX1'), eventKey: `topup:${s.subId}:legacy-${RUN}`,
    }));
    expect(await identityOf(tx('LEGACYTX1'))).toBeNull();
    const filed = await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [s.subId] });
    expect(filed.topups).toBe(1);
    expect(await identityOf(tx('LEGACYTX1'))).toMatchObject({ status: 'CREDITED', subscriptionId: s.subId, tenantId: 'swift-default' });

    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('LEGACYTX1'), 2100, echoOf(row));
    await reply(row, tx('LEGACYTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await walletOf(s.subId)).toBe(2100);
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('the backfill files the push rail’s captured payments, marks an open identity credited, leaves a conflict alone, and changes nothing twice', async () => {
    const s = await makeSub({ mmgPayer: '6091181' });
    const periodStart = new Date(Date.now() - 7 * DAY);
    const captured = (externalRef: string) => app.prisma.subscriptionPayment.create({
      data: { subscriptionId: s.subId, amount: 2100, status: 'CAPTURED', paymentMethod: 'MOBILE_MONEY', externalRef, periodStart, periodEnd: new Date(), paidAt: new Date() },
    });
    const p1 = await captured(`  ${tx('pushtx1').toLowerCase()} `);
    const p2 = await captured(tx('PUSHTX2'));
    const p3 = await captured(tx('PUSHTX3'));
    await app.prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: tx('PUSHTX2'), status: 'OPEN', amount: 2100, currencyCode: 'GYD' } });
    await app.prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: tx('PUSHTX3'), status: 'CREDITED', creditedPaymentId: 'someone-else', amount: 2100, currencyCode: 'GYD', creditedAt: new Date() } });

    const first = await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [s.subId] });
    expect(first).toMatchObject({ push: 2, conflicts: 1 });
    expect(await identityOf(tx('PUSHTX1'))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `push:${p1.id}`, tenantId: 'swift-default', subscriptionId: s.subId });
    expect(await identityOf(tx('PUSHTX2'))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `push:${p2.id}` });
    expect(await identityOf(tx('PUSHTX3'))).toMatchObject({ status: 'CREDITED', creditedPaymentId: 'someone-else' });
    expect(p3.id).toBeTruthy();

    const again = await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [s.subId] });
    expect(again).toMatchObject({ push: 0, topups: 0, agentCash: 0, conflicts: 1 });
  });

  it('the scoped legacy agent-cash backfill keeps each transaction spelling and excludes other subscriptions', async () => {
    const selected = await makeSub();
    const outside = await makeSub();
    const payments: string[] = [];
    const legacy = async (subscriptionId: string, channel: string, externalId: string, mmgTxnId: string | null = null) => {
      const payment = await app.prisma.mmgAgentPayment.create({
        data: { subscriptionId, channel, externalId, mmgTxnId, sanRaw: 'legacy-test', amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'MATCHED', raw: {} },
      });
      payments.push(payment.id);
      return payment;
    };
    try {
      const named = await legacy(selected.subId, 'MMG_AGENT_WEBHOOK', tx('IGNOREDREF'), `\t ${tx('NAMEDTX').toLowerCase()} \n`);
      const manual = await legacy(selected.subId, 'MANUAL_ADMIN', `MANUAL:${tx('MANUALTX').toLowerCase()} `);
      const file = await legacy(selected.subId, 'MMG_SETTLEMENT_FILE', ` ${tx('FILETX').toLowerCase()} `);
      await legacy(outside.subId, 'MMG_AGENT_WEBHOOK', tx('OUTSIDETX'));

      const empty = { push: 0, topups: 0, agentCash: 0, conflicts: 0 };
      expect(await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [] })).toEqual(empty);
      // A caller's scope remains a bound value, even when it contains SQL syntax.
      expect(await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [`${selected.subId}' OR true --`] })).toEqual(empty);
      expect(await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [selected.subId] }))
        .toEqual({ ...empty, agentCash: 3 });
      for (const [transaction, payment] of [[tx('NAMEDTX'), named], [tx('MANUALTX'), manual], [tx('FILETX'), file]] as const) {
        expect(await identityOf(transaction)).toMatchObject({ status: 'CREDITED', creditedPaymentId: payment.id, subscriptionId: selected.subId, tenantId: 'swift-default' });
      }
      expect(await identityOf(tx('IGNOREDREF'))).toBeNull();
      expect(await identityOf(tx('OUTSIDETX'))).toBeNull();
      expect(await walletOf(selected.subId)).toBe(0);
      expect(await topups(selected.subId)).toHaveLength(0);
      expect(await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [selected.subId] })).toEqual(empty);
    } finally {
      await app.prisma.mmgAgentPayment.deleteMany({ where: { id: { in: payments } } });
    }
  });

  it('a credit an older release wrote after the backfill, with no identity, is still never credited again by checkout', async () => {
    // The rolling-deploy window: an instance still on the previous release
    // settles a push payment, or records a top-up command, without claiming the
    // provider identity. The checkout's in-transaction second net refuses both.
    const s = await makeSub({ mmgPayer: '6091186' });
    await app.prisma.subscriptionPayment.create({
      data: { subscriptionId: s.subId, amount: 2100, status: 'CAPTURED', paymentMethod: 'MOBILE_MONEY', externalRef: tx('OLDPUSHTX1'), periodStart: new Date(), periodEnd: new Date(Date.now() + 7 * DAY), paidAt: new Date() },
    });
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('OLDPUSHTX1'), 2100, echoOf(row));
    await reply(row, tx('OLDPUSHTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });

    const t = await makeSub();
    const admin = await app.prisma.user.create({ data: { phone: `+${phoneBase + 9100 + seq}`, firstName: 'Old', lastName: 'Release', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true } });
    userIds.push(admin.id);
    const event = await app.prisma.billingEvent.create({ data: { subscriptionId: t.subId, type: 'PREPAID_TOPUP', amount: 2100, currencyCode: 'GYD', idempotencyKey: `topup:${t.subId}:old-${RUN}` } });
    await app.prisma.topUpCommand.create({
      data: { adminId: admin.id, idempotencyKey: `old-${RUN}`, requestHash: 'h', subscriptionId: t.subId, amount: 2100, reference: tx('OLDTOPUPTX1'), providerRef: tx('OLDTOPUPTX1'), billingEventId: event.id, result: {} },
    });
    const row2 = await intentOf((await start(t)).checkout.ref);
    approved(row2, tx('OLDTOPUPTX1'), 2100, echoOf(row2));
    await reply(row2, tx('OLDTOPUPTX1'));
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await identityOf(tx('OLDPUSHTX1'))).toBeNull();
    expect(await identityOf(tx('OLDTOPUPTX1'))).toBeNull();
  });

  it('the push rail learning its MMG id after a checkout credited that transaction is held, never credited twice', async () => {
    // The push rail's initiate died in transit, so it has not learnt its MMG id (UNKNOWN, no id).
    const s = await makeSub({ due: new Date(Date.now() - 60_000), mmgPayer: '609initerror2' });
    expect(await billing.billSubscription(await subWithRelations(s.subId) as never)).toBe('pending');
    const push = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: s.subId, paymentMethod: 'MOBILE_MONEY' } });
    expect(push).toMatchObject({ status: 'UNKNOWN', externalRef: null });

    // With the shared confirmation authority a checkout cannot open over that
    // request; both can only coexist from before the cutover.
    const row = await legacyCheckoutFor(s);
    const txn = tx('LEARNTX1');
    approved(row, txn, Number(row.amount), echoOf(row));
    await confirmingWith(row.id, txn);
    await service.pollIntents(new Date());
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');

    // Now the push rail adopts that same MMG id, and MMG's lookup reports it
    // approved for the push request, and tries to settle it.
    sandboxAddHistory({ transactionId: txn, status: 'approved', amountMinor: Math.round(Number(push.amount) * 100), currencyCode: 'GYD', reference: push.clientKey! });
    await app.prisma.subscriptionPayment.update({ where: { id: push.id }, data: { status: 'PENDING', externalRef: txn } });
    await billing.pollPendingMmgCharges(new Date());
    const after = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: push.id } });
    expect(after.status).not.toBe('CAPTURED');
    expect(after.failureCode).toBe('SETTLEMENT_MISMATCH');
    expect(await creditsOf(s.subId, txn, push.id)).toBe(1);
    expect(await identityOf(txn)).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}` });
  });

  it('the push rail and a checkout racing on one MMG transaction credit it once', async () => {
    for (let round = 0; round < 2; round += 1) {
      const s = await makeSub({ due: new Date(Date.now() - 60_000), mmgPayer: `609118${3 + round}` });
      expect(await billing.billSubscription(await subWithRelations(s.subId) as never)).toBe('pending');
      const push = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: s.subId, paymentMethod: 'MOBILE_MONEY' } });
      const txn = push.externalRef!;
      // Both instructions open at once can only be a pre-cutover pair now.
      const row = await legacyCheckoutFor(s);
      approved(row, txn, Number(row.amount), echoOf(row));
      await confirmingWith(row.id, txn);

      await Promise.all([billing.pollPendingMmgCharges(new Date()), service.pollIntents(new Date())]);

      expect(await creditsOf(s.subId, txn, push.id)).toBe(1);
      expect((await identityOf(txn))?.status).toBe('CREDITED');
      expect((await intentOf(row.id)).status).not.toBe('CONFIRMED');
    }
  });
});


// [SX386 F2 · #1395 canonical identity] A committed historical agent-cash
// credit is authority whatever its observation says: the delivery that saved
// it may have died with the observation still RECEIVED, or a repair may have
// given it up as UNMATCHED, with no identity, an unlinked OPEN identity, or a
// linked OPEN one, under any of the three event keys agent cash has written.
// After the backfill, a fresh admin command (or a checkout) naming that same
// transaction never posts again: no wallet credit, receipt, counter or ledger.
describe('[SX386 F2] a committed agent credit with a stale observation is never credited twice', () => {
  type Mode = { observation: 'RECEIVED' | 'UNMATCHED'; identity: 'none' | 'open' | 'linked'; key: 'suffix' | 'agent' | 'pp' };
  const modes: Array<[string, Mode]> = [
    ['RECEIVED, no identity, the pre-atomic key', { observation: 'RECEIVED', identity: 'none', key: 'suffix' }],
    ['UNMATCHED, an unlinked OPEN identity, the pre-atomic key', { observation: 'UNMATCHED', identity: 'open', key: 'suffix' }],
    ['RECEIVED, no identity, the original agent key', { observation: 'RECEIVED', identity: 'none', key: 'agent' }],
    ['UNMATCHED, a linked OPEN identity, the original agent key', { observation: 'UNMATCHED', identity: 'linked', key: 'agent' }],
    ['RECEIVED, a linked OPEN identity, the identity key', { observation: 'RECEIVED', identity: 'linked', key: 'pp' }],
  ];
  const adminFor = async () => {
    const admin = await app.prisma.user.create({ data: { phone: `+${phoneBase + 40000 + (seq += 1)}`, firstName: 'F2', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true } });
    userIds.push(admin.id);
    return admin;
  };
  const moneyOf = async (subscriptionId: string) => {
    const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, select: { idempotencyKey: true } });
    return {
      wallet: await walletOf(subscriptionId),
      credits: events.length,
      receipts: await app.prisma.feeReceipt.count({ where: { subscriptionId } }),
      counter: (await app.prisma.receiptCounter.findMany({ where: { tenantId: 'swift-default' } })).reduce((n, c) => n + c.seq, 0),
      ledger: await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: { in: events.map((e) => `ledger:${e.idempotencyKey}`) } } }),
    };
  };
  async function committedLegacyCredit(s: { subId: string }, txn: string, mode: Mode) {
    const identity = mode.identity === 'none' ? null : await app.prisma.providerPayment.create({ data: {
      provider: 'MMG', providerTxnId: txn.toUpperCase(), status: 'OPEN', amount: 2100, currencyCode: 'GYD' } });
    const observation = await app.prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, sanRaw: 'legacy-f2', amount: 2100, currencyCode: 'GYD',
      paidAt: new Date(), status: mode.observation, subscriptionId: s.subId, raw: {},
      ...(mode.identity === 'linked' ? { providerPaymentId: identity!.id } : {}),
    } });
    const eventKey = mode.key === 'pp' ? `agent-cash:pp:${identity!.id}`
      : mode.key === 'agent' ? `agent-cash:${observation.id}` : `topup:${s.subId}:agent:MMG_AGENT_WEBHOOK:${txn}`;
    // The credit committed: wallet, receipt, counter, ledger and event, all at once.
    await app.prisma.$transaction((db) => billing.recordTopUpInTransaction(db, {
      subscriptionId: s.subId, amount: 2100, recordedBy: 'agent-cash:MMG_AGENT_WEBHOOK', reference: txn, eventKey }));
    return { observation, identity };
  }

  it.each(modes)('%s: the backfill then a fresh admin command posts nothing', async (_name, mode) => {
    const s = await makeSub();
    const txn = tx(`F2STALE${mode.observation.slice(0, 1)}${mode.identity.toUpperCase()}${mode.key.toUpperCase()}`);
    const { observation } = await committedLegacyCredit(s, txn, mode);
    const before = await moneyOf(s.subId);
    expect(before).toMatchObject({ wallet: 2100, credits: 1, receipts: 1, ledger: 1 });

    await runProviderIdentityBackfill(app.prisma, { subscriptionIds: [s.subId] });
    const identity = await identityOf(txn);
    expect(identity).toMatchObject({ status: 'CREDITED', creditedPaymentId: observation.id });

    const admin = await adminFor();
    await expect(billing.recordTopUpCommand({ adminId: admin.id, idempotencyKey: key(), requestHash: 'h', subscriptionId: s.subId, amount: 2100, reference: txn }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await moneyOf(s.subId)).toEqual(before);
  });

  it.each(modes)('%s: without any backfill, racing admin commands and a checkout naming it post nothing', async (_name, mode) => {
    const s = await makeSub();
    const txn = tx(`F2RACE${mode.observation.slice(0, 1)}${mode.identity.toUpperCase()}${mode.key.toUpperCase()}`);
    await committedLegacyCredit(s, txn, mode);
    const before = await moneyOf(s.subId);
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, txn, 2100, echoOf(row));
    await confirmingWith(row.id, txn);
    const admin = await adminFor();
    const results = await Promise.allSettled([
      billing.recordTopUpCommand({ adminId: admin.id, idempotencyKey: key(), requestHash: 'h1', subscriptionId: s.subId, amount: 2100, reference: txn }),
      billing.recordTopUpCommand({ adminId: admin.id, idempotencyKey: key(), requestHash: 'h2', subscriptionId: s.subId, amount: 2100, reference: txn }),
      service.pollIntents(new Date()),
    ]);
    expect(results.slice(0, 2).every((r) => r.status === 'rejected')).toBe(true);
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await moneyOf(s.subId)).toEqual(before);
  });
});

describe('[F2] a historical conflict never stops the backfill from completing, and never licenses a second credit', () => {
  it('records completion with the conflict counted, pages operators once, never re-runs, and the conflicted transaction still never credits again', async () => {
    const operator = await operatorFor();
    // A transaction two channels credited before identities existed: the push
    // rail captured it, and an admin top-up receipt names the same transfer.
    const s = await makeSub({ mmgPayer: '6091189' });
    const txn = tx('DOUBLEHISTORY');
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId: s.subId, amount: 2100, status: 'CAPTURED', paymentMethod: 'MOBILE_MONEY',
      externalRef: txn, periodStart: new Date(Date.now() - 7 * DAY), periodEnd: new Date(), paidAt: new Date() } });
    await app.prisma.$transaction((db) => billing.recordTopUpInTransaction(db, {
      subscriptionId: s.subId, amount: 2100, recordedBy: 'admin-before-identities', reference: txn, eventKey: `topup:${s.subId}:double-${RUN}`,
    }));
    await app.prisma.platformConfig.deleteMany({ where: { key: PROVIDER_IDENTITY_BACKFILL_KEY } });
    resetProviderIdentityBackfillCacheForTests();
    const pagesBefore = await app.prisma.notification.count({ where: { userId: operator.id, data: { path: ['alert'], equals: 'provider-identity-backfill-conflicts' } } });

    await service.pollIntents(new Date());
    const record = await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: PROVIDER_IDENTITY_BACKFILL_KEY } });
    expect(record.value).toMatchObject({ completedAt: expect.any(String), conflicts: expect.any(Number) });
    expect((record.value as Record<string, number>)['conflicts']).toBeGreaterThanOrEqual(2);
    await service.pollIntents(new Date());
    await service.pollIntents(new Date());
    const pages = await app.prisma.notification.count({ where: { userId: operator.id, data: { path: ['alert'], equals: 'provider-identity-backfill-conflicts' } } });
    expect(pages - pagesBefore).toBe(1);
    expect(await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: PROVIDER_IDENTITY_BACKFILL_KEY } })).toMatchObject({ value: record.value });

    // Checkout crediting is on, and that transaction is refused whole.
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, txn, 2100, echoOf(row));
    await reply(row, txn);
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await walletOf(s.subId)).toBe(2100);
    expect(await topups(s.subId)).toHaveLength(1);
  });
});

describe('unmatched reply observations are pruned; a checkout’s own evidence is kept', () => {
  it('prunes unreadable replies after a week and decrypted-but-unmatched ones after 90 days, never a checkout’s own rows', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const make = (data: Prisma.MmgCheckoutObservationUncheckedCreateInput) => app.prisma.mmgCheckoutObservation.create({ data });
    const oldGarbage = await make({ source: 'RETURN', detail: 'success', failure: 'NO_TOKEN', createdAt: ago(8) });
    const freshGarbage = await make({ source: 'NOTIFY', failure: 'NO_TOKEN', createdAt: ago(6) });
    const recentStranger = await make({ source: 'RETURN', failure: 'NO_CHECKOUT', body: { merchantTransactionId: '179000000000054321' }, createdAt: ago(30) });
    const oldStranger = await make({ source: 'RETURN', failure: 'NO_CHECKOUT', body: { merchantTransactionId: '179000000000054322' }, createdAt: ago(91) });
    const oldInvalid = await make({ source: 'NOTIFY', failure: 'INVALID_RESPONSE', createdAt: ago(91) });
    const ownReply = await make({ tenantId: row.tenantId, intentId: row.id, source: 'RETURN', detail: 'MMG_RESULT_0', createdAt: ago(400) });
    const ownLookupMiss = await make({ tenantId: row.tenantId, intentId: row.id, source: 'LOOKUP', failure: 'LOOKUP_NOT_FOUND', createdAt: ago(400) });

    await service.pollIntents(now);
    const left = new Set((await app.prisma.mmgCheckoutObservation.findMany({ where: { id: { in: [oldGarbage, freshGarbage, recentStranger, oldStranger, oldInvalid, ownReply, ownLookupMiss].map((o) => o.id) } }, select: { id: true } })).map((o) => o.id));
    expect(left.has(oldGarbage.id)).toBe(false);
    expect(left.has(oldStranger.id)).toBe(false);
    expect(left.has(oldInvalid.id)).toBe(false);
    expect([freshGarbage, recentStranger, ownReply, ownLookupMiss].every((o) => left.has(o.id))).toBe(true);
  });

  it('one pass deletes at most one bounded batch, oldest first', async () => {
    const now = new Date();
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) {
      ids.push((await app.prisma.mmgCheckoutObservation.create({ data: { source: 'RETURN', failure: 'NO_TOKEN', createdAt: new Date(now.getTime() - (8 + n) * DAY) } })).id);
    }
    const pruned = await service.pruneUnmatchedObservations(now, 5);
    expect(pruned).toBe(5);
    const left = await app.prisma.mmgCheckoutObservation.findMany({ where: { id: { in: ids } }, select: { id: true } });
    expect(left.map((o) => o.id).sort()).toEqual(ids.slice(0, 2).sort()); // the two youngest remain
    expect(await service.pruneUnmatchedObservations(now, 5)).toBeGreaterThanOrEqual(2);
    expect(await app.prisma.mmgCheckoutObservation.count({ where: { id: { in: ids } } })).toBe(0);
  });
});

describe('[F7] payment evidence is filed under the checkout’s own tenant', () => {
  it('its replies, lookups and credit identity carry the checkout’s tenant; another tenant’s identity is never claimed', async () => {
    const tenantId = `ten-f7-${RUN.toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id: tenantId, name: 'F7 checkout tenant', slug: `f7-checkout-${RUN.toLowerCase()}` } });
    tenantIds.push(tenantId);
    const t = await makeSub({ tenantId });
    const { checkout } = await runWithTenant(tenantId, () => start(t));
    const row = await intentOf(checkout.ref);
    expect(row.tenantId).toBe(tenantId);
    const year = new Date().getUTCFullYear();
    const counter = async (tenant: string) => (await app.prisma.receiptCounter.findUnique({ where: { tenantId_year: { tenantId: tenant, year } } }))?.seq ?? 0;
    const defaultBefore = await counter('swift-default');
    const ownBefore = await counter(tenantId);
    approved(row, tx('TENANTTX1'), 2100, echoOf(row));
    expect(await reply(row, tx('TENANTTX1'))).toBe('CONFIRMED');
    const seen = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id } });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen.map((o) => o.tenantId))).toEqual(new Set([tenantId]));
    expect(await identityOf(tx('TENANTTX1'))).toMatchObject({ status: 'CREDITED', tenantId });
    const receipts = await app.prisma.feeReceipt.findMany({ where: { subscriptionId: t.subId } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ tenantId, billingEventId: (await topups(t.subId))[0]!.id });
    expect(await counter(tenantId)).toBe(ownBefore + 1);
    expect(await counter('swift-default')).toBe(defaultBefore);
    expect(await reply(row, tx('TENANTTX1'))).toBe('CONFIRMED');
    expect(await app.prisma.feeReceipt.count({ where: { subscriptionId: t.subId } })).toBe(1);
    expect(await counter(tenantId)).toBe(ownBefore + 1);
    expect(await counter('swift-default')).toBe(defaultBefore);

    // An identity another tenant's channel minted is never this checkout's to claim.
    const t2 = await makeSub({ tenantId });
    const row2 = await intentOf((await runWithTenant(tenantId, () => start(t2))).checkout.ref);
    await app.prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: tx('FOREIGNTX1'), status: 'OPEN', amount: 2100, currencyCode: 'GYD' } });
    approved(row2, tx('FOREIGNTX1'), 2100, echoOf(row2));
    await reply(row2, tx('FOREIGNTX1'));
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'TENANT_CONFLICT_ON_RECORD' });
    expect(await identityOf(tx('FOREIGNTX1'))).toMatchObject({ status: 'OPEN', tenantId: 'swift-default' });
    expect(await topups(t2.subId)).toHaveLength(0);
  });
});

describe('[DS633] an Idempotency-Key is filed under its checkout’s tenant', () => {
  it('a key bound to an open checkout carries that checkout’s tenant, even when bound with no tenant in context', async () => {
    const tenantId = `ten-key-${RUN.toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id: tenantId, name: 'Checkout key tenant', slug: `key-tenant-${RUN.toLowerCase()}` } });
    tenantIds.push(tenantId);
    const t = await makeSub({ tenantId });
    const first = await runWithTenant(tenantId, () => start(t));
    expect((await intentOf(first.checkout.ref)).tenantId).toBe(tenantId);
    // A second tap with a new key, answered with the open checkout, as system work would be.
    const next = key();
    const again = await runAsSystem('ds633-checkout-key-tenant', () => start(t, next));
    expect(again).toMatchObject({ created: false, checkout: { ref: first.checkout.ref } });
    const bound = await app.prisma.mmgCheckoutKey.findUniqueOrThrow({ where: { createdByUserId_clientKey: { createdByUserId: t.userId, clientKey: next } } });
    expect(bound).toMatchObject({ intentId: first.checkout.ref, tenantId });
  });
});

describe('the shared wallet receipt tenant', () => {
  it('a matching named tenant owns the receipt and counter, and failure rolls credit and receipt back together', async () => {
    const tenantId = `ten-rollback-${RUN.toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id: tenantId, name: 'Receipt rollback test', slug: `rollback-${RUN.toLowerCase()}` } });
    tenantIds.push(tenantId);
    const s = await makeSub({ tenantId });
    const eventKey = `receipt-rollback:${RUN}`;
    await expect(runWithTenant(tenantId, () => app.prisma.$transaction(async (db) => {
      await billing.recordTopUpInTransaction(db, { subscriptionId: s.subId, amount: 2100, recordedBy: 'test', eventKey });
      const receipt = await db.feeReceipt.findFirstOrThrow({ where: { subscriptionId: s.subId } });
      expect(receipt.tenantId).toBe(tenantId);
      expect(await db.receiptCounter.count({ where: { tenantId } })).toBe(1);
      throw new Error('TEST_ROLLBACK_RECEIPT');
    }))).rejects.toThrow('TEST_ROLLBACK_RECEIPT');
    expect(await walletOf(s.subId)).toBe(0);
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await app.prisma.feeReceipt.count({ where: { subscriptionId: s.subId } })).toBe(0);
    expect(await app.prisma.receiptCounter.count({ where: { tenantId } })).toBe(0);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:${eventKey}` } })).toBe(0);
  });

  it('the common credit helper refuses a request tenant that differs from the trusted payer', async () => {
    const s = await makeSub();
    const credit = billing as unknown as { creditWalletInTx(db: Prisma.TransactionClient, opts: { subscriptionId: string; amount: number; currencyCode: string; eventKey: string; note: string; channel: string }): Promise<unknown> };
    await expect(runWithTenant(`wrong-${RUN}`, () => app.prisma.$transaction((db) => credit.creditWalletInTx(db, {
      subscriptionId: s.subId, amount: 2100, currencyCode: 'GYD', eventKey: `wrong-tenant:${RUN}`, note: 'Test', channel: 'TEST',
    })))).rejects.toMatchObject({ code: 'SUBSCRIPTION_TENANT_MISMATCH' });
    expect(await walletOf(s.subId)).toBe(0);
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await app.prisma.feeReceipt.count({ where: { subscriptionId: s.subId } })).toBe(0);
    await expect(app.prisma.$transaction((db) => billing.recordTopUpInTransaction(db, {
      subscriptionId: s.subId, amount: 2100, recordedBy: 'test', eventKey: `expected-tenant:${RUN}`, expectedTenantId: `wrong-${RUN}`,
    }))).rejects.toMatchObject({ code: 'PROVIDER_TXN_TENANT_CONFLICT' });
    expect(await walletOf(s.subId)).toBe(0);
  });
});

describe('concurrency — racing verifiers credit once', () => {
  it('two replies for one checkout at once credit it once and tell the partner once', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('TWINTX1'), 2100, echoOf(row));
    const token = replyFor(row.merchantTransactionId, tx('TWINTX1'));
    const answers = await Promise.all([
      service.observeReply({ source: 'RETURN', outcome: 'success', params: { token } }),
      service.observeReply({ source: 'NOTIFY', outcome: 'notify', params: { payload: token } }),
    ]);
    expect(answers).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await toldOf(s.userId, 'CONFIRMED')).toHaveLength(1);
  });

  it('a reply and the poll at once credit it once', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('POLLRACETX1'), 2100, echoOf(row));
    await confirmingWith(row.id, tx('POLLRACETX1'));
    await Promise.all([reply(row, tx('POLLRACETX1')), service.pollIntents(new Date()), service.pollIntents(new Date())]);
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
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


describe('shared confirmation authority fences a new MMG page', () => {
  it('the shared PayActions hint is read-only and fails closed on missing clock coverage and undiscovered uncertainty', async () => {
    const s = await makeSub();
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'BILLING_REVIEW_REQUIRED' });
    expect(await app.prisma.billingDunningClock.count({ where: { subscriptionId: s.subId } })).toBe(0);
    await readDunningClock(app.prisma, s.subId);
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: true, reason: null });
    await uncertainCard(s);
    const before = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: s.subId } });
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
    expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: s.subId } })).toBe(0);
    expect(await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: s.subId } })).toEqual(before);
    await expect(start(s)).rejects.toMatchObject({ code: 'PAYMENT_CONFIRMING' });
    expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: s.subId, status: 'ACTIVE' } })).toBe(1);
  });

  async function uncertainCard(s: Awaited<ReturnType<typeof makeSub>>, session = false) {
    const sub = await subWithRelations(s.subId);
    if (session) return app.prisma.cardSession.create({ data: { subscriptionId: s.subId, userId: s.userId,
      purpose: 'PAY_NOW', provider: 'simulator', environment: 'sandbox', providerAccount: 'synthetic-clock',
      stateHash: 'a'.repeat(64), amount: 2100, currencyCode: 'GYD', periodStart: sub.nextBillingDate,
      status: 'OPEN', failureCode: 'REQUIRES_ACTION', expiresAt: new Date(Date.now() + DAY) } });
    return app.prisma.subscriptionPayment.create({ data: { subscriptionId: s.subId, amount: 2100, paymentMethod: 'CARD',
      status: 'UNKNOWN', periodStart: sub.nextBillingDate, periodEnd: new Date(+sub.nextBillingDate + 7 * DAY),
      failureRaw: { providerEffect: 'AUTHORIZED' } } });
  }
  it.each(['legacy-card', 'card-3ds', 'mmg-pending', 'mmg-held', 'mmg-expired'] as const)(
    '%s cannot authorize a second payable MMG instruction', async (kind) => {
      const s = await makeSub();
      let originalCount = 0;
      if (kind === 'legacy-card' || kind === 'card-3ds') await uncertainCard(s, kind === 'card-3ds');
      else if (kind === 'mmg-pending') {
        const sub = await subWithRelations(s.subId);
        await app.prisma.subscriptionPayment.create({ data: { subscriptionId: s.subId, amount: 2100,
          paymentMethod: 'MOBILE_MONEY', status: 'PENDING', externalRef: tx('HELDPRIOR'), clientKey: key(),
          periodStart: sub.nextBillingDate, periodEnd: new Date(+sub.nextBillingDate + 7 * DAY), failureRaw: { providerEffect: 'AUTHORIZED' } } });
      } else {
        const first = await start(s);
        await app.prisma.mmgCheckoutIntent.update({ where: { id: first.checkout.ref }, data: { status: kind === 'mmg-held' ? 'HELD' : 'EXPIRED' } });
        originalCount = 1;
      }
      await expect(start(s)).rejects.toMatchObject({ code: 'PAYMENT_CONFIRMING' });
      expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(originalCount);
      expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: s.subId, status: 'ACTIVE' } })).toBeGreaterThan(0);
      expect((await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: s.subId } })).pausedAt).not.toBeNull();
    });

  const barrier = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  };
  it('a card uncertainty committed during async page sealing wins before MMG reservation', async () => {
    const s = await makeSub();
    const keys = getKeyProvider()!;
    const wrap = keys.wrapDek.bind(keys);
    const entered = barrier(); const release = barrier();
    const spy = vi.spyOn(keys, 'wrapDek').mockImplementationOnce(async (dek) => {
      entered.release(); await release.promise; return wrap(dek);
    });
    const pending = start(s).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    try {
      await entered.promise;
      await uncertainCard(s);
      release.release();
      expect((await pending).error).toMatchObject({ code: 'PAYMENT_CONFIRMING' });
      expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(0);
    } finally { release.release(); await pending; spy.mockRestore(); }
  });

  it.each(['rate', 'wallet', 'period'] as const)('a changed %s during sealing rejects the stale quote before reservation', async (kind) => {
    const s = await makeSub();
    const keys = getKeyProvider()!;
    const wrap = keys.wrapDek.bind(keys);
    const entered = barrier(); const release = barrier();
    const spy = vi.spyOn(keys, 'wrapDek').mockImplementationOnce(async (dek) => {
      entered.release(); await release.promise; return wrap(dek);
    });
    const pending = start(s).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    try {
      await entered.promise;
      if (kind === 'rate') await app.prisma.subscription.update({ where: { id: s.subId }, data: { weeklyRate: 2500 } });
      else if (kind === 'wallet') await app.prisma.prepaidBalance.update({ where: { subscriptionId: s.subId }, data: { balance: 600 } });
      else {
        const sub = await subWithRelations(s.subId);
        await app.prisma.subscription.update({ where: { id: s.subId }, data: {
          nextBillingDate: new Date(+sub.nextBillingDate + 7 * DAY),
          currentPeriodStart: sub.nextBillingDate, currentPeriodEnd: new Date(+sub.nextBillingDate + 7 * DAY),
        } });
      }
      release.release();
      expect((await pending).error).toMatchObject({ code: 'PAYMENT_QUOTE_CHANGED' });
      expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(0);
    } finally { release.release(); await pending; spy.mockRestore(); }
    expect((await start(s)).checkout.amountGyd).toBe(kind === 'rate' ? 2500 : kind === 'wallet' ? 1500 : 2100);
  });
  it.each(['same-key', 'new-key'] as const)('a %s replay keeps its intent but cannot emit a URL after a cross-rail hold wins during unseal', async (kind) => {
    const s = await makeSub();
    const originalKey = key();
    const first = await start(s, originalKey);
    const keys = getKeyProvider()!;
    const unwrap = keys.unwrapDek.bind(keys);
    const entered = barrier(); const release = barrier();
    const spy = vi.spyOn(keys, 'unwrapDek').mockImplementationOnce(async (dek) => {
      entered.release(); await release.promise; return unwrap(dek);
    });
    const replayKey = kind === 'same-key' ? originalKey : key();
    const pending = start(s, replayKey).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    try {
      await entered.promise;
      await uncertainCard(s);
      release.release();
      expect((await pending).error).toMatchObject({ code: 'PAYMENT_CONFIRMING', details: { ref: first.checkout.ref } });
      expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(1);
      expect(await app.prisma.mmgCheckoutKey.findFirst({ where: { createdByUserId: s.userId, clientKey: replayKey } }))
        .toMatchObject({ intentId: first.checkout.ref });
      expect((await intentOf(first.checkout.ref)).status).toBe('OPEN');
    } finally { release.release(); await pending; spy.mockRestore(); }
  });

});

// ---------------------------------------------------------------------------
// [owner, 1 Oct] MMG weekly-fee payments confirm AUTOMATICALLY only when all
// six hold: (1) MMG answered ResultCode 0 for THIS checkout, naming the
// transaction, while it was open; (2) MMG's lookup says "successful"; (3) the
// money went to our merchant's "accountid"; (4) exactly the amount, in GYD;
// (5) created inside the checkout's window (two minutes' tolerance); (6)
// neither the transaction nor MMG's ledger number for it was ever credited.
// Anything else is HELD for a person: nothing credited, no reminders, no
// suspension, operators alerted once. MMG's answers come through the browser
// return door or the notify door, whichever is first; both are idempotent.
// Lookups use the exact UAT shape (evidence/mmg-uat/ROUNDTRIP-PROOF-20261001.md).
// ---------------------------------------------------------------------------
describe('[owner, 1 Oct] automatic confirmation of an MMG weekly-fee payment', () => {
  const heldAlerts = async (operatorId: string, checkoutId: string) => (await app.prisma.notification.findMany({
    where: { userId: operatorId, data: { path: ['checkoutId'], equals: checkoutId } },
  })).filter((n) => (n.data as Record<string, unknown>)['alert'] === 'mmg-checkout-held');

  it('the UAT round trip: MMG’s answer through the notify door, then the return door, credits once; both MMG numbers are claimed once', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const row = await intentOf((await start(s)).checkout.ref);
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    const txn = tx('UATROUNDTRIP');
    // MMG's lookup answer, field for field as UAT returned it.
    lookups.set(txn, lookupDetailFrom({
      transactionStatus: 'successful', amount: '2100', currency: 'GYD', creationDate: gyStamp(new Date()),
      subType: 'subscriber_mpay', transactionReference: ledgerOf(txn),
      creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
      metadata: [{ key: 'amount', value: '2100' }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
      descriptionText: null,
    }, txn));
    history.holds(txn, 2100, { external_id: row.merchantTransactionId });
    expect(await codeReply(row, '0', txn, 'NOTIFY')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', txn, 'RETURN')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', txn, 'NOTIFY')).toBe('CONFIRMED');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(txn)).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}`, subscriptionId: s.subId });
    expect(await identityOf(ledgerOf(txn))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}`, subscriptionId: s.subId });
    expect(await toldOf(s.userId, 'CONFIRMED')).toHaveLength(1);
    expect((await holdOf(row.id)).status).toBe('PAID');
    expect((await clockOf(s.subId)).pausedAt).toBeNull();
    expect(lookedUp.filter((id) => id === txn)).toHaveLength(1);
  });

  it.each([
    ['MMG’s word for it is not "successful"', { transactionStatus: 'completed' }, 'STATUS_NOT_SUCCESSFUL'],
    ['the money went to another merchant', { creditParty: [{ key: 'accountid', value: '5926999999' }] }, 'MERCHANT_MISMATCH'],
    ['our number is not under "accountid"', { creditParty: [{ key: 'msisdn', value: SANDBOX_MERCHANT_ID }] }, 'MERCHANT_UNCONFIRMED'],
    ['[DS632] an "accountid" entry with an empty value beside ours', { creditParty: [{ key: 'accountid', value: '' }, { key: 'accountid', value: SANDBOX_MERCHANT_ID }] }, 'MERCHANT_MISMATCH'],
    ['[DS632] an "accountid" entry with no value beside ours', { creditParty: [{ key: 'accountid' }, { key: 'accountid', value: SANDBOX_MERCHANT_ID }] }, 'MERCHANT_MISMATCH'],
    ['one dollar short', { amount: '2099' }, 'AMOUNT_MISMATCH'],
    ['another currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['no ledger number', { transactionReference: undefined }, 'LEDGER_REFERENCE_MISSING'],
  ] as const)('%s: HELD for a person, nothing credited, the pause kept, operators alerted once', async (_label, answer, reason) => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`AUTOHOLD${reason.replace(/_/g, '')}${seq}`);
    approved(row, txn, 2100, {}, answer);
    expect(await codeReply(row, '0', txn, 'NOTIFY')).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason });
    // The other door repeats MMG's answer: nothing moves, nobody is told twice.
    expect(await codeReply(row, '0', txn, 'RETURN')).toBe('CONFIRMING');
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await identityOf(ledgerOf(txn))).toBeNull();
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(1);
    expect(await heldAlerts(operator.id, row.id)).toHaveLength(1);
  });

  it('[DS632] condition (3) is the checkout’s own merchant only: a payment to the push rail’s number (MMG_MERCHANT_ID) is HELD, never credited', async () => {
    const before = process.env['MMG_MERCHANT_ID'];
    process.env['MMG_MERCHANT_ID'] = '5926999911';
    try {
      const s = await makeSub();
      const row = await intentOf((await start(s)).checkout.ref);
      const txn = tx('PUSHRAILNUMBER');
      approved(row, txn, 2100, {}, { creditParty: [{ key: 'accountid', value: '5926999911' }] });
      expect(await codeReply(row, '0', txn)).toBe('CONFIRMING');
      expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'MERCHANT_MISMATCH' });
      expect(await topups(s.subId)).toHaveLength(0);
      expect(await identityOf(txn)).toBeNull();
      // The same payment to the checkout's own merchant confirms.
      const t = await makeSub();
      const own = await intentOf((await start(t)).checkout.ref);
      approved(own, tx('CHECKOUTNUMBER'), 2100);
      expect(await codeReply(own, '0', tx('CHECKOUTNUMBER'))).toBe('CONFIRMED');
    } finally {
      if (before === undefined) delete process.env['MMG_MERCHANT_ID'];
      else process.env['MMG_MERCHANT_ID'] = before;
    }
  });

  it('MMG’s success answer that reaches us after the checkout closed is HELD, even with an exact payment made in time', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const opened = new Date(Date.now() - 40 * 60_000);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { createdAt: opened, expiresAt: new Date(opened.getTime() + MMG_CHECKOUT_TTL_MS) } });
    const txn = tx('LATEANSWER');
    approved(row, txn, 2100, {}, {}, { modificationDate: gyStamp(new Date(opened.getTime() + 60_000)) });
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'SUCCESS_ANSWER_AFTER_CLOSE' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('MMG answering success for two transactions on one checkout is HELD: a person decides which', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('TWOANSWERS2'), 2100);
    expect(await codeReply(row, '0', tx('TWOANSWERS1'), 'NOTIFY')).toBe('CONFIRMING'); // MMG does not know it yet
    approved(row, tx('TWOANSWERS1'), 2100);
    expect(await codeReply(row, '0', tx('TWOANSWERS2'), 'RETURN')).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'MMG_ANSWERS_DISAGREE' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[6] a payment another channel credited by MMG’s ledger number is HELD, and neither number is claimed', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('LEDGERTAKEN');
    await app.prisma.providerPayment.create({
      data: { provider: 'MMG', providerTxnId: ledgerOf(txn), status: 'CREDITED', creditedPaymentId: 'agent-observation', subscriptionId: s.subId, amount: 2100, currencyCode: 'GYD', creditedAt: new Date() },
    });
    approved(row, txn, 2100);
    expect(await reply(row, txn)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await identityOf(txn)).toBeNull();
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[6] the push rail’s captured payment naming MMG’s ledger number is never credited again by checkout', async () => {
    const s = await makeSub();
    const txn = tx('LEDGERPUSHED');
    await app.prisma.subscriptionPayment.create({
      data: { subscriptionId: s.subId, amount: 2100, status: 'CAPTURED', paymentMethod: 'MOBILE_MONEY', externalRef: ledgerOf(txn), periodStart: new Date(), periodEnd: new Date(Date.now() + 7 * DAY), paidAt: new Date() },
    });
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, txn, 2100);
    await reply(row, txn);
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await identityOf(txn)).toBeNull();
  });

  it('[6] an admin top-up naming MMG’s ledger number of a payment a checkout credited is refused', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('LEDGERTOPUP');
    approved(row, txn, 2100);
    expect(await reply(row, txn)).toBe('CONFIRMED');
    const admin = await app.prisma.user.create({ data: { phone: `+${phoneBase + 9200 + (seq += 1)}`, firstName: 'Ad', lastName: 'Min', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true } });
    userIds.push(admin.id);
    await expect(billing.recordTopUpCommand({ adminId: admin.id, idempotencyKey: key(), requestHash: 'h', subscriptionId: s.subId, amount: 2100, reference: ledgerOf(txn) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TOPUP_REFERENCE_ALREADY_CREDITED' });
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('[DS632] after a checkout is CONFIRMED, MMG’s success answer naming ANOTHER transaction is written down and operators are told once that money was received and not applied; nothing is credited', async () => {
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const paid = tx('APPLIEDTX');
    approved(row, paid, 2100);
    expect(await codeReply(row, '0', paid, 'RETURN')).toBe('CONFIRMED');
    // MMG repeating the credited payment, by either of its numbers, is not new money.
    expect(await codeReply(row, '0', paid, 'NOTIFY')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', ledgerOf(paid), 'NOTIFY')).toBe('CONFIRMED');
    // ...however MMG spells it: identities are compared canonically (mmg_txn_canon).
    expect(await codeReply(row, '0', ledgerOf(paid).toLowerCase(), 'NOTIFY')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', paid.toLowerCase(), 'RETURN')).toBe('CONFIRMED');
    expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied')).toHaveLength(0);

    const other = tx('UNAPPLIEDTX');
    approved(row, other, 2100);
    lookedUp.length = 0;
    expect(await codeReply(row, '0', other, 'NOTIFY')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', other, 'RETURN')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', tx('UNAPPLIEDTX2'), 'NOTIFY')).toBe('CONFIRMED');
    // Written down, never looked up for credit, never credited.
    const named = (await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id, source: { in: ['RETURN', 'NOTIFY'] } } }))
      .filter((o) => (o.body as Record<string, unknown> | null)?.['transactionId'] === other);
    expect(named).toHaveLength(2);
    expect(lookedUp).toEqual([]);
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: paid });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(other)).toBeNull();
    // [Sol, DS659 · delta3] Operators are told once PER TRANSACTION, whichever
    // door and however often: the same payment collapses, a different one pages.
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.title).toMatch(/money received and not applied/i);
    expect(pages.map((page) => (page.data as Record<string, unknown>)['transactionId']).sort()).toEqual([other, tx('UNAPPLIEDTX2')].sort());
    // A third different payment pages too; repeats of any of them page no more.
    expect(await codeReply(row, '0', tx('UNAPPLIEDTX3'), 'RETURN')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', tx('UNAPPLIEDTX3'), 'NOTIFY')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', other, 'NOTIFY')).toBe('CONFIRMED');
    // The same MMG transaction spelled in lower case is the same payment (mmg_txn_canon).
    expect(await codeReply(row, '0', other.toLowerCase(), 'RETURN')).toBe('CONFIRMED');
    const after = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(after.map((page) => (page.data as Record<string, unknown>)['transactionId']).sort()).toEqual([other, tx('UNAPPLIEDTX2'), tx('UNAPPLIEDTX3')].sort());
    expect(await topups(s.subId)).toHaveLength(1);
    // The partner hears nothing new.
    expect(await toldOf(s.userId, 'CONFIRMED')).toHaveLength(1);
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(0);
  });

  it('[Sol] a second payment whose reply merges while a verifier confirms the first is written down, never credited, and operators are told once', async () => {
    // The interleaving, made deterministic: verifier A has read the checkout's
    // answers (transaction 1 only) and waits on MMG's lookup; reply B (transaction
    // 2) is written down and merged while the checkout is still CONFIRMING; A then
    // confirms transaction 1; only then does B's own verification run.
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const first = tx('RACEFIRST');
    const second = tx('RACESECOND');
    approved(row, first, 2100);
    approved(row, second, 2100);
    await confirmingWith(row.id, first);
    const barrier = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
    const aInLookup = barrier();
    const releaseA = barrier();
    const bAtVerify = barrier();
    const aDone = barrier();
    const plainLookup = lookup.transactionLookupDetail;
    lookup.transactionLookupDetail = async (id) => {
      if (id === first) { aInLookup.open(); await releaseA.wait; }
      return plainLookup(id);
    };
    const target = service as unknown as { verify: (id: string, now: Date) => Promise<string> };
    const plainVerify = target.verify.bind(service);
    let calls = 0;
    const spy = vi.spyOn(target, 'verify').mockImplementation(async (id, now) => {
      if (id === row.id && (calls += 1) === 2) { bAtVerify.open(); await aDone.wait; }
      return plainVerify(id, now);
    });
    try {
      const a = service.pollIntents(new Date());
      await aInLookup.wait;
      const b = codeReply(row, '0', second, 'NOTIFY');
      await bAtVerify.wait;
      expect((await intentOf(row.id)).candidates).toEqual([first, second]);
      releaseA.open();
      await a;
      aDone.open();
      expect(await b).toBe('CONFIRMED');
    } finally {
      spy.mockRestore();
      lookup.transactionLookupDetail = plainLookup;
    }
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(second)).toBeNull();
    const named = (await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id, source: 'NOTIFY' } }))
      .filter((o) => (o.body as Record<string, unknown> | null)?.['transactionId'] === second);
    expect(named).toHaveLength(1);
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toMatchObject({ checkoutId: row.id, transactionId: second });
  });

  it('[Sol delta2] the same race with the reply paused INSIDE its own verification: its lookups fail, it reschedules a checkout another verifier has just confirmed, and operators are still told once', async () => {
    // Verifier A waits on MMG's lookup of transaction 1. Reply B (transaction 2)
    // merges, then starts its own verification, reading the checkout as
    // CONFIRMING; it waits on its lookup of transaction 2. A confirms
    // transaction 1. B's lookups fail (an error, then not found), so B
    // reschedules: a compare-and-set that now matches no row.
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const first = tx('RESCHEDFIRST');
    const second = tx('RESCHEDSECOND');
    approved(row, first, 2100);
    await confirmingWith(row.id, first);
    const barrier = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
    const aInLookup = barrier();
    const releaseA = barrier();
    const bInLookup = barrier();
    const aDone = barrier();
    const plainLookup = lookup.transactionLookupDetail;
    let firstCalls = 0;
    lookup.transactionLookupDetail = async (id) => {
      if (id === first && (firstCalls += 1) === 1) { aInLookup.open(); await releaseA.wait; return plainLookup(id); }
      if (id === first) return { outcome: 'error', reason: 'MMG lookup HTTP 503' };
      if (id === second) { bInLookup.open(); await aDone.wait; return { outcome: 'not_found' }; }
      return plainLookup(id);
    };
    let answer: string | undefined;
    try {
      const a = service.pollIntents(new Date());
      await aInLookup.wait;
      const b = codeReply(row, '0', second, 'NOTIFY').then((state) => { answer = state; });
      await bInLookup.wait;
      expect((await intentOf(row.id)).status).toBe('CONFIRMING');
      releaseA.open();
      await a;
      expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
      aDone.open();
      await b;
    } finally {
      lookup.transactionLookupDetail = plainLookup;
    }
    // The page is the point: the second payment is recorded and never credited.
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toMatchObject({ checkoutId: row.id, transactionId: second });
    // The reply answers what is committed, not what it read before the race.
    expect(answer).toBe('CONFIRMED');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(second)).toBeNull();
    const named = (await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id, source: 'NOTIFY' } }))
      .filter((o) => (o.body as Record<string, unknown> | null)?.['transactionId'] === second);
    expect(named).toHaveLength(1);
  });

  it('[Sol delta2 · mirror] the reply finishes its whole verification before the slower verifier confirms: the confirming verifier tells operators once', async () => {
    // Verifier A read the checkout's answers (transaction 1 only) and waits on
    // MMG's lookup. Reply B (transaction 2) is written down, merges, verifies
    // (its lookups fail), reschedules and reads the checkout again: still
    // CONFIRMING, so B has nothing to page about and answers CONFIRMING. Only
    // then does A confirm transaction 1. A's credit is the last word, so A must
    // see the success answer B wrote down and page.
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const first = tx('MIRRORFIRST');
    const second = tx('MIRRORSECOND');
    approved(row, first, 2100);
    await confirmingWith(row.id, first);
    const barrier = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
    const aInLookup = barrier();
    const releaseA = barrier();
    const plainLookup = lookup.transactionLookupDetail;
    let firstCalls = 0;
    lookup.transactionLookupDetail = async (id) => {
      if (id === first && (firstCalls += 1) === 1) { aInLookup.open(); await releaseA.wait; return plainLookup(id); }
      if (id === first) return { outcome: 'error', reason: 'MMG lookup HTTP 503' };
      if (id === second) return { outcome: 'not_found' };
      return plainLookup(id);
    };
    try {
      const a = service.pollIntents(new Date());
      await aInLookup.wait;
      // B runs to its end while A still waits: nothing is confirmed yet.
      expect(await codeReply(row, '0', second, 'NOTIFY')).toBe('CONFIRMING');
      expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', candidates: [first, second] });
      expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied')).toHaveLength(0);
      releaseA.open();
      await a;
    } finally {
      lookup.transactionLookupDetail = plainLookup;
    }
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(second)).toBeNull();
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toMatchObject({ checkoutId: row.id, transactionId: second });
    // A later reply for either payment changes nothing and pages no more.
    expect(await codeReply(row, '0', second, 'RETURN')).toBe('CONFIRMED');
    expect(await codeReply(row, '0', first, 'RETURN')).toBe('CONFIRMED');
    expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied')).toHaveLength(1);
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it('[Sol delta3] the mirror race when the credit comes from a reply, not the poll: the crediting verifier pages at once', async () => {
    // Reply A (transaction 1, again) verifies and waits on its lookup, having
    // read only transaction 1's answers; reply B (transaction 2) merges,
    // verifies (lookups fail) and answers CONFIRMING; then A credits. No poll
    // runs: only the verifier that credits can page about B now.
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const first = tx('REPLYFIRST');
    const second = tx('REPLYSECOND');
    approved(row, first, 2100);
    await confirmingWith(row.id, first);
    const barrier = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
    const aInLookup = barrier();
    const releaseA = barrier();
    const plainLookup = lookup.transactionLookupDetail;
    let firstCalls = 0;
    lookup.transactionLookupDetail = async (id) => {
      if (id === first && (firstCalls += 1) === 1) { aInLookup.open(); await releaseA.wait; return plainLookup(id); }
      if (id === first) return { outcome: 'error', reason: 'MMG lookup HTTP 503' };
      if (id === second) return { outcome: 'not_found' };
      return plainLookup(id);
    };
    const reconcile = vi.spyOn(service, 'reconcileUnappliedPages');
    try {
      const a = codeReply(row, '0', first, 'RETURN');
      await aInLookup.wait;
      expect(await codeReply(row, '0', second, 'NOTIFY')).toBe('CONFIRMING');
      releaseA.open();
      expect(await a).toBe('CONFIRMED');
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      reconcile.mockRestore();
      lookup.transactionLookupDetail = plainLookup;
    }
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
    expect(await topups(s.subId)).toHaveLength(1);
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toMatchObject({ checkoutId: row.id, transactionId: second });
  });

  it('[Sol delta3] the crediting verifier sees every transaction the answers name, however many repeat the credited one', async () => {
    // Sol's schedule: many success answers name transaction 1 (Sol's fifty;
    // here 250, more than one page of the sweep's reads); the poll reads them
    // and waits on transaction 1's lookup; reply B (transaction 2) is the next
    // answer, its lookups fail and it reschedules; the poll then credits
    // transaction 1. Transaction 2 must still be paged.
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const first = tx('MANYFIRST');
    const second = tx('MANYSECOND');
    approved(row, first, 2100);
    await confirmingWith(row.id, first);
    await app.prisma.mmgCheckoutObservation.createMany({ data: Array.from({ length: 249 }, (_, i) => ({
      tenantId: row.tenantId, intentId: row.id, source: i % 2 ? 'NOTIFY' : 'RETURN', detail: 'MMG_RESULT_0',
      body: { merchantTransactionId: row.merchantTransactionId, transactionId: first, ResultCode: '0' },
    })) });
    const barrier = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
    const aInLookup = barrier();
    const releaseA = barrier();
    const plainLookup = lookup.transactionLookupDetail;
    let firstCalls = 0;
    lookup.transactionLookupDetail = async (id) => {
      if (id === first && (firstCalls += 1) === 1) { aInLookup.open(); await releaseA.wait; return plainLookup(id); }
      if (id === first) return { outcome: 'error', reason: 'MMG lookup HTTP 503' };
      if (id === second) return { outcome: 'not_found' };
      return plainLookup(id);
    };
    try {
      const a = service.pollIntents(new Date());
      await aInLookup.wait;
      expect(await codeReply(row, '0', second, 'NOTIFY')).toBe('CONFIRMING');
      expect(await app.prisma.mmgCheckoutObservation.count({ where: { intentId: row.id, source: { in: ['RETURN', 'NOTIFY'] } } })).toBe(251);
      releaseA.open();
      await a;
    } finally {
      lookup.transactionLookupDetail = plainLookup;
    }
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(second)).toBeNull();
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toMatchObject({ checkoutId: row.id, transactionId: second });
  });

  it('[Sol, DS659 · delta3] a page that could not be saved when the payment was credited is sent by a later poll, exactly once', async () => {
    // The mirror schedule (the reply finishes before the credit), with the
    // operators' page failing to save at the credit. The checkout is CONFIRMED
    // and leaves polling; the poll's reconcile still finds the unapplied
    // payment and pages it, once, however often it runs.
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const first = tx('LOSTFIRST');
    const second = tx('LOSTSECOND');
    approved(row, first, 2100);
    await confirmingWith(row.id, first);
    const barrier = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { open, wait }; };
    const aInLookup = barrier();
    const releaseA = barrier();
    const plainLookup = lookup.transactionLookupDetail;
    let firstCalls = 0;
    lookup.transactionLookupDetail = async (id) => {
      if (id === first && (firstCalls += 1) === 1) { aInLookup.open(); await releaseA.wait; return plainLookup(id); }
      if (id === first) return { outcome: 'error', reason: 'MMG lookup HTTP 503' };
      if (id === second) return { outcome: 'not_found' };
      return plainLookup(id);
    };
    const plainSend = notifications.send.bind(notifications);
    // Saving the operators' page fails (send() then answers '', as on a failed insert).
    const failing = vi.spyOn(notifications, 'send').mockImplementation(async (payload) =>
      ((payload.data as Record<string, unknown> | undefined)?.['alert'] === 'mmg-checkout-unapplied' ? '' : plainSend(payload)));
    try {
      const a = service.pollIntents(new Date());
      await aInLookup.wait;
      expect(await codeReply(row, '0', second, 'NOTIFY')).toBe('CONFIRMING');
      releaseA.open();
      await a;
      // [Fable S4-3] While pages cannot be saved, the reconcile reports none sent.
      expect(await service.reconcileUnappliedPages(new Date())).toBe(0);
    } finally {
      failing.mockRestore();
      lookup.transactionLookupDetail = plainLookup;
    }
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: first });
    expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied')).toHaveLength(0);
    // The next poll pages it; a later poll finds the page and sends nothing more.
    await service.pollIntents(new Date());
    expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied')).toHaveLength(1);
    // [Fable S4-4] ...even when the database's clock runs an hour behind the
    // app's (the page's saved time then reads earlier than the credit).
    const confirmedAt = (await intentOf(row.id)).confirmedAt!;
    const [saved] = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    // Every operator's copy of the page (one per admin, the same key).
    const copies = await app.prisma.notification.updateMany({ where: { dedupeKey: saved!.dedupeKey! }, data: { createdAt: new Date(confirmedAt.getTime() - 3_600_000) } });
    expect(copies.count).toBeGreaterThanOrEqual(1);
    expect((await app.prisma.notification.findUniqueOrThrow({ where: { id: saved!.id } })).createdAt.getTime()).toBe(confirmedAt.getTime() - 3_600_000);
    expect(await service.reconcileUnappliedPages(new Date())).toBe(0);
    const watching = vi.spyOn(notifications, 'send');
    try {
      await service.pollIntents(new Date());
      expect(watching.mock.calls.filter(([payload]) => (payload.data as Record<string, unknown> | undefined)?.['alert'] === 'mmg-checkout-unapplied')).toHaveLength(0);
    } finally {
      watching.mockRestore();
    }
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-unapplied');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toMatchObject({ checkoutId: row.id, transactionId: second });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(second)).toBeNull();
  });

  it('the return door and the notify door at once, both carrying MMG’s answer, credit once', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('BOTHDOORS');
    approved(row, txn, 2100);
    const answers = await Promise.all([codeReply(row, '0', txn, 'RETURN'), codeReply(row, '0', txn, 'NOTIFY')]);
    expect(answers).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(ledgerOf(txn))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}` });
    expect(await toldOf(s.userId, 'CONFIRMED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [DS632] Condition (5) holds only as well as the zone MMG's creationDate is
// read in: MMG_CHECKOUT_CREATION_ZONE, GUYANA_WALL_CLOCK (what MMG UAT writes,
// verified 1 Oct) or UTC. Unset, nothing is confirmed automatically. And MMG
// cannot have created a payment after Swift first heard of it.
// ---------------------------------------------------------------------------
describe('[DS632 · 7 Oct] MMG’s time for the payment (its history record) is read in the configured zone', () => {
  it('unset: no MMG payment is confirmed automatically; it is HELD (CREATION_ZONE_UNVERIFIED), nothing credited, the pause kept, operators alerted once', async () => {
    checkoutProvider = () => sandboxIn(null);
    const s = await makeSub({ due: new Date(Date.now() - 60_000) });
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('ZONEUNSET');
    approved(row, txn, 2100);
    expect(await codeReply(row, '0', txn, 'NOTIFY')).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'CREATION_ZONE_UNVERIFIED' });
    expect(await codeReply(row, '0', txn, 'RETURN')).toBe('CONFIRMING');
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await identityOf(ledgerOf(txn))).toBeNull();
    expect((await holdOf(row.id)).status).toBe('ACTIVE');
    expect((await clockOf(s.subId)).pausedAt).not.toBeNull();
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(1);
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-held');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toMatch(/MMG_CHECKOUT_CREATION_ZONE/);
  });

  it.each([
    ['MMG writes true UTC and Swift is configured UTC', 'UTC'],
    ['MMG writes Guyana time, as in UAT, and Swift is configured GUYANA_WALL_CLOCK', 'GUYANA_WALL_CLOCK'],
  ] as const)('the DS632 scenario, both ways (%s): a real payment made 3h48m before the checkout is never credited to it (MMG’s history for the checkout’s time has no record of it, HELD when the window ends); one made five minutes before is HELD at once; a payment made inside the checkout is credited', async (_label, zone) => {
    checkoutProvider = () => sandboxIn(zone);
    history.zone = zone;
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const early = tx(`DSEARLY${zone === 'UTC' ? 'U' : 'G'}`);
    // The lookup stamps its own moment (MMG, 7 Oct): it says nothing about when the payment was made.
    approved(row, early, 2100, {}, { creationDate: mmgTimeOf(new Date(), zone) }, { modificationDate: mmgTimeOf(new Date(row.createdAt.getTime() - (3 * 60 + 48) * 60_000), zone) });
    expect(await codeReply(row, '0', early)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'SEEN:HOLD:PAYMENT_TIME_NOT_IN_HISTORY' });
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'PAYMENT_TIME_NOT_IN_HISTORY' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(early)).toBeNull();
    expect(await identityOf(ledgerOf(early))).toBeNull();

    const n = await makeSub();
    const nearRow = await intentOf((await start(n)).checkout.ref);
    const near = tx(`DSNEAR${zone === 'UTC' ? 'U' : 'G'}`);
    approved(nearRow, near, 2100, {}, { creationDate: mmgTimeOf(new Date(), zone) }, { modificationDate: mmgTimeOf(new Date(nearRow.createdAt.getTime() - 5 * 60_000), zone) });
    expect(await codeReply(nearRow, '0', near)).toBe('CONFIRMING');
    expect(await intentOf(nearRow.id)).toMatchObject({ status: 'HELD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW' });
    expect(await topups(n.subId)).toHaveLength(0);
    expect(await identityOf(near)).toBeNull();

    const t = await makeSub();
    const paidRow = await intentOf((await start(t)).checkout.ref);
    const paid = tx(`DSINTIME${zone === 'UTC' ? 'U' : 'G'}`);
    approved(paidRow, paid, 2100, {}, { creationDate: mmgTimeOf(new Date(), zone) }, { modificationDate: mmgTimeOf(new Date(), zone) });
    expect(await codeReply(paidRow, '0', paid)).toBe('CONFIRMED');
    expect(await topups(t.subId)).toHaveLength(1);
    expect(await identityOf(paid)).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${paidRow.id}` });
  });

  it('MMG writing true UTC while Swift reads Guyana time: MMG’s history, asked four hours early, has no record of the payment, so it is never credited; HELD when the window ends, operators told once to check MMG_CHECKOUT_CREATION_ZONE', async () => {
    history.zone = 'UTC';
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('TRUEUTCREADASGY');
    approved(row, txn, 2100, {}, { creationDate: new Date().toISOString() }, { modificationDate: new Date().toISOString() });
    expect(await codeReply(row, '0', txn, 'NOTIFY')).toBe('CONFIRMING');
    expect(await codeReply(row, '0', txn, 'RETURN')).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'SEEN:HOLD:PAYMENT_TIME_NOT_IN_HISTORY' });
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'PAYMENT_TIME_NOT_IN_HISTORY' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await identityOf(ledgerOf(txn))).toBeNull();
    const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-held');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toMatch(/transaction history did not show it/);
    expect(pages[0]!.body).toMatch(/MMG_CHECKOUT_CREATION_ZONE/);
  });

  it('the bound is the FIRST reply naming the transaction, whichever door brought it', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const opened = new Date(Date.now() - 20 * 60_000);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { createdAt: opened, expiresAt: new Date(opened.getTime() + MMG_CHECKOUT_TTL_MS) } });
    const txn = tx('FIRSTREPLY');
    // MMG's server named it two minutes in; the browser came back fifteen minutes in.
    await answeredAt(row, txn, new Date(opened.getTime() + 2 * 60_000), 'NOTIFY');
    await answeredAt(row, txn, new Date(opened.getTime() + 15 * 60_000), 'RETURN');
    // MMG's history dates the payment ten minutes in: inside the window, before
    // the second reply, but after the first one plus two minutes.
    approved(row, txn, 2100, {}, {}, { modificationDate: gyStamp(new Date(opened.getTime() + 10 * 60_000)) });
    await service.pollIntents(new Date());
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'PAYMENT_TIME_AFTER_REPLY' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
  });

  it('the 1 Oct UAT round trip, at its exact times (MMG’s history record of it), still confirms with GUYANA_WALL_CLOCK', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    // Opened 15:38:19 Guyana time; MMG's reply read at 15:39:05; [7 Oct] MMG's history dates
    // the payment 15:38:31, written with a "Z"; the lookup, asked on 7 Oct, stamps its own moment.
    const opened = new Date('2026-10-01T19:38:19Z');
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { createdAt: opened, expiresAt: new Date(opened.getTime() + MMG_CHECKOUT_TTL_MS) } });
    const txn = tx('UATEXACT');
    await answeredAt(row, txn, new Date('2026-10-01T19:39:05Z'), 'RETURN');
    approved(row, txn, 2100, {}, { creationDate: '2026-10-07T12:21:18.777Z' }, { modificationDate: '2026-10-01T15:38:31.000Z' });
    await service.pollIntents(new Date());
    // Swift asked MMG for exactly the checkout's time, written as MMG reads it.
    expect(history.queries.at(-1)).toEqual({ fromdate: '2026-10-01T15:26:19.000Z', todate: '2026-10-01T15:51:05.000Z', rows: 100 });
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(txn)).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}` });
    expect(await identityOf(ledgerOf(txn))).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}` });
  });
});

// ---------------------------------------------------------------------------
// [7 Oct] Condition (5) reads the payment's time from MMG's Transaction
// History (MMG: the lookup's creationDate is the moment of the LOOKUP;
// history's modificationDate is when the payment was made). Fail-closed: no
// record, more than one, one that disagrees, an unreadable time, or history
// MMG cannot answer in full: never credited.
// ---------------------------------------------------------------------------
describe('[7 Oct] condition (5): the payment’s time comes from MMG’s Transaction History, never the lookup’s clock', () => {
  it.each([['missing', undefined], ['different', '1790883498'], ['numeric', 1790883499]])(
    'history external_id %s holds immediately, stores the evidence, and tells the operator why', async (_name, external_id) => {
      const s = await makeSub();
      const operator = await operatorFor();
      const row = await intentOf((await start(s)).checkout.ref);
      const txn = tx(`HISTREF${_name.toUpperCase()}`);
      approved(row, txn, 2100, {}, {}, { external_id });
      await codeReply(row, '0', txn);
      expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'HISTORY_REFERENCE_MISMATCH' });
      expect(await topups(s.subId)).toHaveLength(0);
      expect(await identityOf(txn)).toBeNull();
      expect(await identityOf(ledgerOf(txn))).toBeNull();
      const observation = await app.prisma.mmgCheckoutObservation.findFirstOrThrow({ where: { intentId: row.id, source: 'HISTORY' } });
      expect(observation.body).toMatchObject({ naming: [{ transactionReference: txn, transactionReceipt: txn }] });
      const pages = await pagesAbout(operator.id, row.id, 'mmg-checkout-held');
      expect(pages).toHaveLength(1);
      expect(pages[0]!.body).toContain('checkout reference');
      expect(pages[0]!.body).toContain('Nothing was credited');
      await codeReply(row, '0', txn, 'NOTIFY');
      expect(await topups(s.subId)).toHaveLength(0);
      expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-held')).toHaveLength(1);
    });

  it('a late lookup of an in-time payment CONFIRMS: MMG stamps creationDate with the lookup’s own moment, and its history dates the payment', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('LATELOOKUP');
    // The payment is in MMG's history from the start; MMG's first lookup cannot answer yet.
    history.holds(txn, 2100, { external_id: row.merchantTransactionId });
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMING');
    expect(history.queries).toHaveLength(0);
    // Three and a half minutes later MMG answers, its creationDate the moment of that lookup.
    const later = new Date(Date.now() + 3.5 * 60_000);
    approved(row, txn, 2100, {}, { creationDate: gyStamp(later) }, null);
    await service.pollIntents(later);
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
    expect(await topups(s.subId)).toHaveLength(1);
    expect(await identityOf(txn)).toMatchObject({ status: 'CREDITED', creditedPaymentId: `mco:${row.id}` });
  });

  it('the lookup’s creationDate decides nothing: missing, unreadable or a week old, the payment confirms by its history time', async () => {
    for (const [name, creationDate] of [['NOSTAMP', undefined], ['BADSTAMP', 'yesterday'], ['OLDSTAMP', gyStamp(new Date(Date.now() - 7 * DAY))]] as const) {
      const s = await makeSub();
      const row = await intentOf((await start(s)).checkout.ref);
      approved(row, tx(name), 2100, {}, { creationDate });
      expect(await codeReply(row, '0', tx(name)), name).toBe('CONFIRMED');
      expect(await topups(s.subId)).toHaveLength(1);
    }
  });

  it('MMG’s history not showing the payment yet: never credited, still confirming; credited once history shows it, in time', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx('HISTLAG');
    approved(row, txn, 2100, {}, {}, null);
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'SEEN:HOLD:PAYMENT_TIME_NOT_IN_HISTORY' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id, source: 'HISTORY' }, select: { detail: true, failure: true } }))
      .toEqual([{ detail: txn, failure: 'HISTORY_NOT_FOUND' }]);
    history.holds(txn, 2100, { external_id: row.merchantTransactionId });
    await service.pollIntents(new Date(Date.now() + 5 * 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMED', mmgTransactionId: txn });
    expect(await topups(s.subId)).toHaveLength(1);
  });

  it.each([
    ['never shows it', 'HISTNEVER', (_txn: string): void => undefined, 'PAYMENT_TIME_NOT_IN_HISTORY', 'HISTORY_NOT_FOUND'],
    ['cannot be read (MMG answers HTTP 503)', 'HISTDOWN', (_txn: string): void => { history.answer = async (): Promise<MmgHistoryAnswer> => ({ outcome: 'error', reason: 'MMG history HTTP 503' }); }, 'PAYMENT_TIME_UNAVAILABLE', 'HISTORY_FAILED'],
    ['is cut short at the row limit, the record of it included', 'HISTFULL', (txn: string, ref: string): void => {
      history.answer = async (query): Promise<MmgHistoryAnswer> => ({ outcome: 'rows', rows: [mmgHistoryRow(txn, 2100, { external_id: ref }), ...Array.from({ length: query.rows - 1 }, (_, i) => mmgHistoryRow(`OTHER${i}`, 10))] });
    }, 'PAYMENT_TIME_UNAVAILABLE', null],
  ] as const)('MMG’s history %s: never credited; the checkout keeps confirming, and when the window ends it is HELD for a person, operators and partner told once', async (_label, name, arrange, reason, failure) => {
    const s = await makeSub();
    const operator = await operatorFor();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(name);
    approved(row, txn, 2100, {}, {}, null);
    arrange(txn, row.merchantTransactionId);
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: `SEEN:HOLD:${reason}` });
    expect((await app.prisma.mmgCheckoutObservation.findFirstOrThrow({ where: { intentId: row.id, source: 'HISTORY' } })).failure).toBe(failure);
    await service.pollIntents(new Date(Date.now() + 5 * 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: `SEEN:HOLD:${reason}` });
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await identityOf(ledgerOf(txn))).toBeNull();
    expect(await pagesAbout(operator.id, row.id, 'mmg-checkout-held')).toHaveLength(1);
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(1);
  });

  it.each([
    ['two records of it', 'HISTTWO', (txn: string, ref: string): void => { history.answer = async (): Promise<MmgHistoryAnswer> => ({ outcome: 'rows', rows: [mmgHistoryRow(txn, 2100, { external_id: ref }), mmgHistoryRow(txn, 2100, { external_id: ref })] }); }, 'PAYMENT_TIME_AMBIGUOUS'],
    ['a record that is not "completed"', 'HISTPENDING', (txn: string, ref: string): void => history.holds(txn, 2100, { external_id: ref, transactionStatus: 'pending' }), 'PAYMENT_TIME_DISAGREES'],
    ['a record of another amount', 'HISTAMOUNT', (txn: string, ref: string): void => history.holds(txn, 2099, { external_id: ref }), 'PAYMENT_TIME_DISAGREES'],
    ['a record naming it under only one of its two numbers', 'HISTONENUMBER', (txn: string, ref: string): void => history.holds(txn, 2100, { external_id: ref, transactionReceipt: 'X1' }), 'PAYMENT_TIME_DISAGREES'],
    ['a record whose time cannot be read', 'HISTBADTIME', (txn: string, ref: string): void => { history.answer = async (): Promise<MmgHistoryAnswer> => ({ outcome: 'rows', rows: [mmgHistoryRow(txn, 2100, { external_id: ref, modificationDate: 'yesterday' })] }); }, 'PAYMENT_TIME_UNREADABLE'],
  ] as const)('MMG’s history holds %s: HELD for a person at once, nothing credited', async (_label, name, arrange, reason) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(name);
    approved(row, txn, 2100, {}, {}, null);
    arrange(txn, row.merchantTransactionId);
    expect(await codeReply(row, '0', txn)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
  });

  it('a late check of an expired checkout whose payment MMG’s answer ties to it, but whose time history cannot show: HELD at once for a person, never left to lapse', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const opened = new Date(Date.now() - 40 * 60_000);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { createdAt: opened, expiresAt: new Date(opened.getTime() + MMG_CHECKOUT_TTL_MS) } });
    const txn = tx('LATECHECKSOFT');
    await answeredAt(row, txn, new Date(opened.getTime() + 60_000), 'RETURN');
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { status: 'EXPIRED', reason: 'LOOKUP_NEVER_CONFIRMED', nextCheckAt: new Date() } });
    approved(row, txn, 2100, {}, {}, null);
    await service.pollIntents(new Date());
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'PAYMENT_TIME_NOT_IN_HISTORY' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
  });

  it('MMG’s history is asked only for a payment its lookup calls "successful", in a configured zone: never for a pending or unknown one, or with no zone set', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(row, tx('PENDINGNOHIST'), 2100, {}, { transactionStatus: 'pending' });
    expect(await codeReply(row, '0', tx('PENDINGNOHIST'))).toBe('CONFIRMING');
    const t = await makeSub();
    const unknownRow = await intentOf((await start(t)).checkout.ref);
    expect(await codeReply(unknownRow, '0', tx('UNKNOWNNOHIST'))).toBe('CONFIRMING');
    checkoutProvider = () => sandboxIn(null);
    const u = await makeSub();
    const unzoned = await intentOf((await start(u)).checkout.ref);
    approved(row, tx('NOZONENOHIST'), 2100);
    expect(await codeReply(unzoned, '0', tx('NOZONENOHIST'))).toBe('CONFIRMING');
    expect(await intentOf(unzoned.id)).toMatchObject({ status: 'HELD', reason: 'CREATION_ZONE_UNVERIFIED' });
    expect(history.queries).toHaveLength(0);
  });
});
