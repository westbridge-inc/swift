import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Prisma, SubscriptionStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_CHECKOUT_TTL_MS, MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { openCheckoutUrl } from '../modules/billing/checkout-url-seal';
import {
  PROVIDER_IDENTITY_BACKFILL_KEY,
  ensureProviderIdentityBackfill,
  resetProviderIdentityBackfillCacheForTests,
  runProviderIdentityBackfill,
} from '../modules/billing/provider-identity-backfill';
import { getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
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
// And the AX353 findings: F1 a credit is bound to MMG's own echo of THIS
// checkout's reference · F2 every channel claims one identity, history is
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
let service: MmgCheckoutService;
let checkoutProvider: () => MmgCheckoutProvider;
let kekBefore: string | undefined;

const lookups = new Map<string, MmgLookupDetail>();
const lookedUp: string[] = [];
const lookup: MmgLookupClient = { transactionLookupDetail: async (id) => {
  lookedUp.push(id);
  return lookups.get(id) ?? { outcome: 'not_found' };
} };
type Found = Extract<MmgLookupDetail, { outcome: 'found' }>;
function approved(txn: string, amountGyd: number, patch: Partial<Found> = {}) {
  lookups.set(txn, {
    outcome: 'found', transactionId: txn, status: 'approved', amountMinor: amountGyd * 100, currencyCode: 'GYD',
    creditParties: [SANDBOX_MERCHANT_ID], createdAt: null, echoedReferences: [], raw: { transactionReference: txn }, ...patch,
  });
}
/** [F1] MMG's answer echoing THIS checkout's reference in its confirmed reference field. */
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
const identityOf = (txn: string) => app.prisma.providerPayment.findUnique({ where: { provider_providerTxnId: { provider: 'MMG', providerTxnId: txn.trim().toUpperCase() } } });
const subWithRelations = (subscriptionId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subscriptionId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
/** A checkout MMG sent back naming this transaction (the push rail's ids fail the reply's id shape, so it is set directly). */
async function confirmingWith(ref: string, txn: string) {
  await app.prisma.mmgCheckoutIntent.update({ where: { id: ref }, data: { status: 'CONFIRMING', candidates: [txn], replyAt: new Date(), nextCheckAt: new Date() } });
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
  // [F2] The startup guard, once: every earlier credit on this database carries its identity.
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
}, 120_000);

beforeEach(() => {
  lookedUp.length = 0;
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
  await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
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

describe('[F3] an Idempotency-Key keeps its answer', () => {
  it('a key handed another tap’s open checkout is bound to it: once that is paid, the key opens nothing new', async () => {
    const s = await makeSub();
    const first = await start(s, key());
    const k2 = key();
    expect((await start(s, k2)).checkout.ref).toBe(first.checkout.ref);
    const row = await intentOf(first.checkout.ref);
    approved(tx('F3TX1'), 2100, echoOf(row));
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
    approved(txn, 2100, echoOf(row));
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

  it('[F1] until MMG’s reference field is confirmed, an exact approved payment is held for a person, never credited', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('UNBOUNDTX1'), 2100);
    expect(await reply(row, tx('UNBOUNDTX1'))).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_NOT_ECHOED' });
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(tx('UNBOUNDTX1'))).toBeNull();
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(1);
  });

  it('[F1] a forged reply naming another payer’s transaction is held, and the real payer is still credited', async () => {
    const payer = await makeSub();
    const forger = await makeSub();
    const paid = await intentOf((await start(payer)).checkout.ref);
    const forged = await intentOf((await start(forger)).checkout.ref);
    // MMG's record of the payer's real payment names the payer's own checkout.
    approved(tx('PAIDTX1'), 2100, { ...echoOf(paid), raw: { transactionReference: tx('PAIDTX1'), merchantReference: paid.merchantTransactionId } });
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
    approved(tx('MISMATCHTX1'), 2100, { echoedReferences: ['179000000000066666'] });
    await reply(row, tx('MISMATCHTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_MISMATCH' });

    const s2 = await makeSub();
    const row2 = await intentOf((await start(s2)).checkout.ref);
    approved(tx('AMBIGUOUSTX1'), 2100, { echoedReferences: [row2.merchantTransactionId, '179000000000077777'] });
    await reply(row2, tx('AMBIGUOUSTX1'));
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_AMBIGUOUS' });
    expect([...await topups(s.subId), ...await topups(s2.subId)]).toHaveLength(0);
  });

  it('[I6] MMG’s record of THIS checkout with a different amount is held for a person; nothing credits', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('HELDTX1'), 2000, echoOf(row));
    expect(await reply(row, tx('HELDTX1'))).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'AMOUNT_MISMATCH' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('a mismatch that may concern another transaction waits instead of holding a payment still arriving; our reference in a description binds nothing', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('WEAKTX1'), 2000, { raw: { transactionReference: tx('WEAKTX1'), description: `Swift ${row.merchantTransactionId}` } });
    await reply(row, tx('WEAKTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'CONFIRMING', reason: 'SEEN:HOLD:AMOUNT_MISMATCH' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[I3] a transaction another channel already credited is never credited again', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    await app.prisma.providerPayment.create({
      data: { provider: 'MMG', providerTxnId: tx('TAKENTX1'), status: 'CREDITED', creditedPaymentId: 'agent-observation', subscriptionId: s.subId, amount: 2100, currencyCode: 'GYD', creditedAt: new Date() },
    });
    approved(tx('TAKENTX1'), 2100, echoOf(row));
    await reply(row, tx('TAKENTX1'));
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it('[I3] and an admin top-up naming a transaction a checkout credited is refused', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('BOTHTX1'), 2100, echoOf(row));
    await reply(row, tx('BOTHTX1'));
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
    approved(tx('OBSTX1'), 2100, echoOf(row));
    // A repeated key reaches the API as an array; every value is tried.
    await service.observeReply({ source: 'RETURN', outcome: 'success', params: { token: ['not-a-token', replyFor(row.merchantTransactionId, tx('OBSTX1'))] } });
    const seen = await app.prisma.mmgCheckoutObservation.findMany({ where: { intentId: row.id }, orderBy: { createdAt: 'asc' } });
    expect(seen.map((o) => o.source)).toEqual(['RETURN', 'LOOKUP']);
    expect(JSON.stringify(seen[0]!.body)).not.toContain('must-not-be-stored');
    expect(seen[0]!.shape).toMatchObject({ merchantTransactionId: 'string', transactionId: 'string', ResultCode: 'string' });

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
        approved(tx(`UNSEALCONFIRMED${kind.toUpperCase()}`), 2100, echoOf(row));
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
    approved(transactionId, 2100); // unchanged empty lookup-reference policy must hold it
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
      expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: 'REFERENCE_NOT_ECHOED' });
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
    approved(txn, 2100, echoOf(row));
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
    approved(txn, 2100, echoOf(row));
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
    approved(known, 2100, echoOf(row));
    expect(await send(row.merchantTransactionId, official, '0', {
      paymentRef: known, nested: { transactionId: known }, ResultMessage: known, htmlResponse: known,
    })).toBe('CONFIRMING');
    expect(lookedUp).toEqual([official]);
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it.each(['0', '1', '2', '6', '7'])('ResultCode %s credits only after the bound server lookup confirms payment', async (code) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`PAIDCODE${code}`);
    expect(await send(row.merchantTransactionId, txn, code)).toBe('CONFIRMING');
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(0);
    approved(txn, 2100, echoOf(row));
    expect(await send(row.merchantTransactionId, txn, code)).toBe('CONFIRMED');
    expect(await topups(s.subId)).toHaveLength(1);
    expect((await intentOf(row.id)).outcomeHint).toBe(`MMG_RESULT_${code}`);
  });

  it.each(['1', '2', '6', '7'])('ResultCode %s declares NOT_PAID only on a bound authoritative failure', async (code) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`FAILED${code}`);
    approved(txn, 2100, { status: 'declined' });
    expect(await send(row.merchantTransactionId, txn, code)).toBe('CONFIRMING');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(0);
    approved(txn, 2100, { status: 'declined', ...echoOf(row) });
    expect(await send(row.merchantTransactionId, txn, code)).toBe('NOT_PAID');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(1);
    expect(await topups(s.subId)).toHaveLength(0);
  });

  it.each([['3', 'INVALID_SECRET_KEY'], ['4', 'MERCHANT_ID_MISMATCH'], ['5', 'TOKEN_DECRYPTION_FAILED']])('ResultCode %s holds uncredited checkout and alerts operations once', async (code, reason) => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const txn = tx(`CONFIG${code}`);
    approved(txn, 2100, echoOf(row));
    const operator = await app.prisma.user.create({ data: {
      phone: `+${phoneBase + 20000 + seq}`, firstName: 'Test', lastName: 'Operator', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true,
    } });
    userIds.push(operator.id);
    for (let n = 0; n < 2; n += 1) expect(await send(row.merchantTransactionId, txn, code)).toBe('CONFIRMING');
    expect(await intentOf(row.id)).toMatchObject({ status: 'HELD', reason: `MMG_RESULT_${code}_${reason}`, nextCheckAt: null });
    expect(lookedUp).toEqual([]);
    expect(await topups(s.subId)).toHaveLength(0);
    expect(await identityOf(txn)).toBeNull();
    expect(await toldOf(s.userId, 'HELD')).toHaveLength(1);
    const alerts = await app.prisma.notification.findMany({ where: { userId: operator.id, data: { path: ['checkoutId'], equals: row.id } } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ alert: 'mmg-checkout-held', reason: `MMG_RESULT_${code}_${reason}` });
    expect(JSON.stringify(alerts)).not.toContain('Provider content');
    expect(JSON.stringify(alerts)).not.toContain('Provider message');
    // A later success hint cannot resume a held configuration failure.
    expect(await send(row.merchantTransactionId, txn, '0')).toBe('CONFIRMING');
    expect((await intentOf(row.id)).status).toBe('HELD');
    expect(await topups(s.subId)).toHaveLength(0);
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

  it('the error path naming no transaction at all is still confirming, never "not paid"', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    const token = sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, ResultCode: '1' });
    expect(await service.observeReply({ source: 'RETURN', outcome: 'error', params: { token } })).toBe('CONFIRMING');
    expect((await intentOf(row.id)).status).toBe('CONFIRMING');
  });

  it('a decline MMG does not tie to this checkout never says "not paid"', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('DECLINEDTX1'), 2100, { status: 'declined' });
    expect(await reply(row, tx('DECLINEDTX1'), 'error')).toBe('CONFIRMING');
    await service.pollIntents(new Date(Date.now() + DAY + 60_000));
    expect((await intentOf(row.id)).status).toBe('EXPIRED');
    expect(await toldOf(s.userId, 'NOT_PAID')).toHaveLength(0);
  });

  it('MMG’s answer for THIS checkout that the payment failed is NOT_PAID, and the partner hears it once', async () => {
    const s = await makeSub();
    const row = await intentOf((await start(s)).checkout.ref);
    approved(tx('BOUNDDECLINETX1'), 2100, { status: 'declined', ...echoOf(row) });
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

    approved(tx('LATETX1'), 2100, echoOf(row));
    expect(await reply(row, tx('LATETX1'))).toBe('CONFIRMED');
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
    await reply(q, tx('QUIETTX1'));
    const dayLater = new Date(Date.now() + DAY + 60_000);
    await service.pollIntents(dayLater);
    expect((await intentOf(q.id)).status).toBe('EXPIRED');

    const odd = await makeSub();
    const o = await intentOf((await start(odd)).checkout.ref);
    approved(tx('ODDTX1'), 2100, { creditParties: ['5926999999'] });
    await reply(o, tx('ODDTX1'));
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
    approved(tx('GUARDTX1'), 2100, echoOf(row));
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
    approved(tx('LEGACYTX1'), 2100, echoOf(row));
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
    approved(tx('OLDPUSHTX1'), 2100, echoOf(row));
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
    approved(tx('OLDTOPUPTX1'), 2100, echoOf(row2));
    await reply(row2, tx('OLDTOPUPTX1'));
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'ALREADY_CREDITED' });
    expect(await identityOf(tx('OLDPUSHTX1'))).toBeNull();
    expect(await identityOf(tx('OLDTOPUPTX1'))).toBeNull();
  });

  it('the push rail learning its MMG id after a checkout credited that transaction is held, never credited twice', async () => {
    const s = await makeSub({ due: new Date(Date.now() - 60_000), mmgPayer: '6091182' });
    expect(await billing.billSubscription(await subWithRelations(s.subId) as never)).toBe('pending');
    const push = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: s.subId, paymentMethod: 'MOBILE_MONEY' } });
    const txn = push.externalRef!;
    // The push rail's initiate had not learnt its MMG id yet (UNKNOWN, no id).
    await app.prisma.subscriptionPayment.update({ where: { id: push.id }, data: { status: 'UNKNOWN', externalRef: null } });

    const row = await intentOf((await start(s)).checkout.ref);
    approved(txn, Number(row.amount), echoOf(row));
    await confirmingWith(row.id, txn);
    await service.pollIntents(new Date());
    expect((await intentOf(row.id)).status).toBe('CONFIRMED');

    // Now the push rail adopts that same MMG id from history and settles it.
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
      const row = await intentOf((await start(s)).checkout.ref);
      approved(txn, Number(row.amount), echoOf(row));
      await confirmingWith(row.id, txn);

      await Promise.all([billing.pollPendingMmgCharges(new Date()), service.pollIntents(new Date())]);

      expect(await creditsOf(s.subId, txn, push.id)).toBe(1);
      expect((await identityOf(txn))?.status).toBe('CREDITED');
      expect((await intentOf(row.id)).status).not.toBe('CONFIRMED');
    }
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
    approved(tx('TENANTTX1'), 2100, echoOf(row));
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
    approved(tx('FOREIGNTX1'), 2100, echoOf(row2));
    await reply(row2, tx('FOREIGNTX1'));
    expect(await intentOf(row2.id)).toMatchObject({ status: 'HELD', reason: 'TENANT_CONFLICT_ON_RECORD' });
    expect(await identityOf(tx('FOREIGNTX1'))).toMatchObject({ status: 'OPEN', tenantId: 'swift-default' });
    expect(await topups(t2.subId)).toHaveLength(0);
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
    approved(tx('TWINTX1'), 2100, echoOf(row));
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
    approved(tx('POLLRACETX1'), 2100, echoOf(row));
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
