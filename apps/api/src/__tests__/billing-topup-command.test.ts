import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { BillingService, type BillingObserver } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { billingTopupMissingKeyCounter, billingTopupDuplicateFingerprintCounter } from '../plugins/observability';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [M-08 · S0] The prepaid top-up is ONE command.
//
// Before: without an Idempotency-Key the service minted a time-based key, so
// an admin's retry after a lost response credited twice; and the audit row,
// the payer's notice and the immediate re-bill ran after the commit as
// separate hopes. Now the key is required, the key + request fingerprint own
// the result, the credit / receipt / ledger / audit / command commit together,
// and the downstream tail is owed on the command until it completes.
// ---------------------------------------------------------------------------

const PHONE_BASE = 592_008_000_000 + Math.floor(Math.random() * 8_000_000);
let app: FastifyInstance;
let adminToken: string;
let adminUserId: string;
let billing: BillingService;
let notifications: NotificationService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

/** The failpoint: armed once, it throws inside the command's transaction. */
let armed = false;
const observer: BillingObserver = {
  afterTopUpCommandStaged: async () => {
    if (!armed) return;
    armed = false;
    throw new Error('failpoint: the process died after the credit, before the commit');
  },
};

async function makeVendorSub(status: 'ACTIVE' | 'PAST_DUE' = 'ACTIVE') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Topup', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Topup Kitchen ${seq}`, slug: `topup-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${PHONE_BASE + 700_000 + seq}`,
      addressLine1: '8 Command St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status, weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  subIds.push(sub.id);
  return { sub, userId: user.id };
}

const hashOf = (subscriptionId: string, amount: number, reference: string | null = null) =>
  createHash('sha256').update(JSON.stringify({ subscriptionId, amount, reference })).digest('hex');

async function facts(subscriptionId: string) {
  const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, select: { id: true, idempotencyKey: true } });
  return {
    credits: events.length,
    receipts: await app.prisma.feeReceipt.count({ where: { subscriptionId } }),
    postings: await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: { in: events.map((e) => `ledger:${e.idempotencyKey}`) } } }),
    // [ADM-002] The admin route writes the canonical row inside the command
    // transaction (`ADMIN POST …/topup`, carrying billingEventId); the service's
    // own PREPAID_TOPUP row stands only when nothing upstream audits. A replayed
    // request is recorded by the backstop as a request that credited nothing —
    // so `audits` counts rows that carry a credit, which is what it measured.
    audits: (await app.prisma.auditLog.findMany({ where: { entityId: subscriptionId, action: { in: ['PREPAID_TOPUP', 'ADMIN POST /api/v1/admin/subscriptions/:id/topup'] } }, select: { changes: true } }))
      .filter((r) => typeof (r.changes as Record<string, unknown> | null)?.['billingEventId'] === 'string').length,
    commands: await app.prisma.topUpCommand.count({ where: { subscriptionId } }),
    balance: Number((await app.prisma.prepaidBalance.findUnique({ where: { subscriptionId } }))?.balance ?? 0),
  };
}

const topup = (id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => injectWithApproval(app, {
  method: 'POST', url: `/api/v1/admin/subscriptions/${id}/topup`, payload: body,
  headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', ...headers },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = admin.json().data.tokens.accessToken;
  adminUserId = admin.json().data.user.id;
  notifications = new NotificationService(app.prisma, app.io);
  billing = new BillingService(app.prisma, notifications, getPaymentProvider(), observer);
});

afterAll(async () => {
  delete process.env['BILLING_TOPUP_HOLD'];
  await app.prisma.topUpCommand.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await purgeAuditLogs(app.prisma, { entity: 'Subscription', entityId: { in: subIds } }, 'test-cleanup:billing-topup-command');
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

describe('[M-08] the key is required — the register’s first red test', () => {
  it('two identical retries without a key are both refused with a required-key error, and nothing is credited', async () => {
    const { sub } = await makeVendorSub();
    const before = (await billingTopupMissingKeyCounter.get()).values[0]?.value ?? 0;
    const a = await topup(sub.id, { amount: 5000, reference: 'bank-1' });
    const b = await topup(sub.id, { amount: 5000, reference: 'bank-1' });
    expect([a.statusCode, b.statusCode]).toEqual([400, 400]);
    expect(a.json().error?.code ?? a.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await facts(sub.id)).toEqual({ credits: 0, receipts: 0, postings: 0, audits: 0, commands: 0, balance: 0 });
    expect((await billingTopupMissingKeyCounter.get()).values[0]?.value).toBe(before + 2);
    // The service refuses too — the key is not a route convenience.
    await expect(billing.recordTopUp(sub.id, 5000, adminUserId, 'bank-1', '')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(billing.recordTopUpCommand({ adminId: adminUserId, idempotencyKey: 'short', requestHash: hashOf(sub.id, 5000), subscriptionId: sub.id, amount: 5000, reference: refFor('SHORTKEY') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(await facts(sub.id)).toEqual({ credits: 0, receipts: 0, postings: 0, audits: 0, commands: 0, balance: 0 });
  });

  it('with a key: one command — credit, receipt, ledger posting, audit row and the stored result — and the same key replays it verbatim', async () => {
    const { sub } = await makeVendorSub();
    const key = `attempt-${nanoid(12)}`;
    // ONE transfer, replayed — so one reference, but unique to this run.
    const transfer = refFor('BANK2');
    const first = await topup(sub.id, { amount: 5000, reference: transfer }, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ success: true, replayed: false, data: { balance: 5000, currencyCode: 'GYD' } });
    expect(await facts(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, audits: 1, commands: 1, balance: 5000 });
    const again = await topup(sub.id, { amount: 5000, reference: transfer }, { 'idempotency-key': key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ success: true, replayed: true, data: { balance: 5000, currencyCode: 'GYD' } });
    expect(await facts(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, audits: 1, commands: 1, balance: 5000 });
    const audit = await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: sub.id, action: { in: ['PREPAID_TOPUP', 'ADMIN POST /api/v1/admin/subscriptions/:id/topup'] } } });
    // [A-12] Stored upper-cased: normalisation is what makes the unique index
    // work, so the same transfer typed two ways cannot occupy two rows.
    expect(audit.changes).toMatchObject({ amount: 5000, reference: transfer, idempotencyKey: key });
  });

  it('the same key under a different request is refused, counted, and credits nothing more', async () => {
    const { sub } = await makeVendorSub();
    const key = `attempt-${nanoid(12)}`;
    const before = (await billingTopupDuplicateFingerprintCounter.get()).values[0]?.value ?? 0;
    expect((await topup(sub.id, { amount: 5000, reference: refFor('REUSE') }, { 'idempotency-key': key })).statusCode).toBe(200);
    const reused = await topup(sub.id, { amount: 9000, reference: refFor('REUSE2') }, { 'idempotency-key': key });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error?.code ?? reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await facts(sub.id)).balance).toBe(5000);
    expect((await billingTopupDuplicateFingerprintCounter.get()).values[0]?.value).toBe(before + 1);
  });
});

describe('[M-08] a failpoint after the credit — the register’s second red test', () => {
  it('the process dies after the credit is staged: nothing stands — no credit, receipt, posting, audit or command — and the retry converges to one', async () => {
    const { sub } = await makeVendorSub();
    const key = `attempt-${nanoid(12)}`;
    armed = true;
    // ONE real transfer across all three attempts, so ONE reference.
    const transferRef = refFor('FAILPOINT');
    await expect(billing.recordTopUpCommand({ adminId: adminUserId, idempotencyKey: key, requestHash: hashOf(sub.id, 5000), subscriptionId: sub.id, amount: 5000, reference: transferRef })).rejects.toThrow(/failpoint/);
    expect(await facts(sub.id)).toEqual({ credits: 0, receipts: 0, postings: 0, audits: 0, commands: 0, balance: 0 });
    const retry = await billing.recordTopUpCommand({ adminId: adminUserId, idempotencyKey: key, requestHash: hashOf(sub.id, 5000), subscriptionId: sub.id, amount: 5000, reference: transferRef });
    expect(retry.replayed).toBe(false);
    expect(await facts(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, audits: 1, commands: 1, balance: 5000 });
    const again = await billing.recordTopUpCommand({ adminId: adminUserId, idempotencyKey: key, requestHash: hashOf(sub.id, 5000), subscriptionId: sub.id, amount: 5000, reference: transferRef });
    expect(again).toMatchObject({ replayed: true, commandId: retry.commandId, result: retry.result });
  });

  it('the tail fails after the commit: the credit stands, the tail is owed on the command, and the drain completes it once', async () => {
    const { sub, userId } = await makeVendorSub('PAST_DUE');
    const key = `attempt-${nanoid(12)}`;
    const spy = vi.spyOn(NotificationService.prototype, 'send').mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const res = await billing.recordTopUpCommand({ adminId: adminUserId, idempotencyKey: key, requestHash: hashOf(sub.id, 5000), subscriptionId: sub.id, amount: 5000, reference: refFor('TAIL') });
      expect(res.replayed).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect((await facts(sub.id)).credits).toBe(1);
    let command = await app.prisma.topUpCommand.findUniqueOrThrow({ where: { billingEventId: (await app.prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).id } });
    expect({ done: command.tailDoneAt, attempts: command.tailAttempts, error: command.lastError }).toEqual({ done: null, attempts: 1, error: 'notification unavailable' });
    // The poll's drain: the notice goes out and, being PAST_DUE, the re-bill runs — once.
    const drained = await billing.drainTopUpTails({ olderThanMs: 0 });
    expect(drained.done).toBeGreaterThanOrEqual(1);
    command = await app.prisma.topUpCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(command.tailDoneAt).not.toBeNull();
    expect(await app.prisma.notification.count({ where: { userId, title: 'Top-up received' } })).toBe(1);
    const sub2 = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(sub2.status).toBe('ACTIVE'); // the owed re-bill reinstated the payer
    // Draining again does nothing: the tail is done.
    const again = await billing.drainTopUpTails({ olderThanMs: 0 });
    expect(await app.prisma.notification.count({ where: { userId, title: 'Top-up received' } })).toBe(1);
    expect(again.retried).toBe(0);
  });
});

describe('[M-08 · operations] rollback is hold-only', () => {
  it('BILLING_TOPUP_HOLD=1 refuses every top-up, keyed or not, and records nothing', async () => {
    const { sub } = await makeVendorSub();
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const held = await topup(sub.id, { amount: 5000, reference: refFor('HELD') }, { 'idempotency-key': `attempt-${nanoid(12)}` });
      expect(held.statusCode).toBe(503);
      expect(held.json().error?.code ?? held.json().code).toBe('TOPUP_ON_HOLD');
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
    expect(await facts(sub.id)).toEqual({ credits: 0, receipts: 0, postings: 0, audits: 0, commands: 0, balance: 0 });
  });
});


// ---------------------------------------------------------------------------
// [A-12] THE IDEMPOTENCY KEY IS NOT THE TRANSFER'S IDENTITY.
//
// M-08 made the same REQUEST safe to repeat: a key, scoped to one admin, that
// replays its own result. It says nothing about the same real-world TRANSFER
// being credited twice — under a fresh key, or by a second operator working
// from the same bank statement. `providerRef` is that identity.
// ---------------------------------------------------------------------------
// A reference the shape actually accepts: `nanoid` draws from an alphabet that
// includes `-` and `_`, and a reference may not END in one. Roughly three runs
// in a hundred produced a trailing `-` and a 400 that had nothing to do with
// what the test was grading. Alphanumeric, always.
const refFor = (prefix: string) => `${prefix}-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`.toUpperCase();

const waiveFee = (id: string, body: Record<string, unknown>) => injectWithApproval(app, {
  method: 'PUT', url: `/api/v1/admin/subscriptions/${id}/waive-fee`, payload: body,
  headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
});

describe('[A-12] one transfer credits one subscription, once', () => {
  it('a top-up with no reference is refused — a credit with no evidence is not a credit', async () => {
    const { sub } = await makeVendorSub();
    const res = await topup(sub.id, { amount: 5000 }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(res.statusCode).toBe(400);
    expect(await facts(sub.id)).toMatchObject({ credits: 0, balance: 0 });
  });

  it('nothing entered and something wrong are different mistakes', async () => {
    const { sub } = await makeVendorSub();
    const blank = await topup(sub.id, { amount: 5000, reference: '   ' }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(blank.json().error.code).toBe('TOPUP_REFERENCE_REQUIRED');
    const junk = await topup(sub.id, { amount: 5000, reference: '!!' }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(junk.json().error.code).toBe('TOPUP_REFERENCE_INVALID');
    expect(await facts(sub.id)).toMatchObject({ credits: 0, balance: 0 });
  });

  it('the SAME transfer under a FRESH key is refused — the case the idempotency key cannot see', async () => {
    const { sub } = await makeVendorSub();
    const other = await makeVendorSub();
    const transfer = refFor('MMG');

    const first = await topup(sub.id, { amount: 5000, reference: transfer }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(first.statusCode).toBe(200);

    // A different key, and even a different subscription: it is still one
    // transfer, and it has already been credited.
    const again = await topup(sub.id, { amount: 5000, reference: transfer }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TOPUP_REFERENCE_ALREADY_CREDITED');

    const elsewhere = await topup(other.sub.id, { amount: 5000, reference: transfer }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(elsewhere.statusCode).toBe(409);

    expect(await facts(sub.id)).toMatchObject({ credits: 1, balance: 5000 });
    expect(await facts(other.sub.id)).toMatchObject({ credits: 0, balance: 0 });
  });

  it('the same transfer typed in a different case is the same transfer', async () => {
    const { sub } = await makeVendorSub();
    const transfer = refFor('BANK');
    expect((await topup(sub.id, { amount: 5000, reference: transfer }, { 'idempotency-key': `attempt-${nanoid(12)}` })).statusCode).toBe(200);
    const lower = await topup(sub.id, { amount: 5000, reference: transfer.toLowerCase() }, { 'idempotency-key': `attempt-${nanoid(12)}` });
    expect(lower.statusCode).toBe(409);
    expect(await facts(sub.id)).toMatchObject({ credits: 1, balance: 5000 });
  });

  it('money is exact or refused — a top-up is never a float', async () => {
    const { sub } = await makeVendorSub();
    for (const amount of [5000.5, 0.001, 0, -100]) {
      const res = await topup(sub.id, { amount, reference: refFor('EXACT') }, { 'idempotency-key': `attempt-${nanoid(12)}` });
      expect(res.statusCode, `amount ${amount}`).toBe(400);
    }
    expect(await facts(sub.id)).toMatchObject({ credits: 0, balance: 0 });
  });
});

describe('[A-12] a waived fee records why', () => {
  it('refuses a waiver with no reason, and one with no substance', async () => {
    const { sub } = await makeVendorSub();
    expect((await waiveFee(sub.id, {})).statusCode).toBe(400);
    expect((await waiveFee(sub.id, { reason: '   ' })).statusCode).toBe(400);
    expect((await waiveFee(sub.id, { reason: 'ok' })).statusCode).toBe(400);
    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.feeWaived).toBe(false);
  });

  it('stores the operator’s own words — never a default standing in for a reason', async () => {
    const { sub } = await makeVendorSub();
    const res = await waiveFee(sub.id, { reason: 'Outage on 2 Sep — vendor could not trade for three days' });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(fresh.feeWaived).toBe(true);
    expect(fresh.feeWaivedReason).toBe('Outage on 2 Sep — vendor could not trade for three days');
    expect(fresh.feeWaivedReason).not.toBe('Waived by admin');
    expect(fresh.feeWaivedBy).toBeTruthy();
  });
});
