import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createHmac, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerTenantHeaderScope } from '../../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { rateLimitKey } from '../../utils/rate-limit-key';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { agentCashRoutes } from '../../modules/billing/agent-cash.routes';
import { BillingService } from '../../modules/billing/billing.service';
import { SubscriptionService } from '../../modules/subscription/subscription.service';
import { NotificationService } from '../../modules/notification/notification.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { getMmgProvider, sandboxResetMmg, sandboxSetTxStatus } from '../../providers/mmg/mmg-provider';
import { purgeAuditLogs } from '../../lib/audit-immutability';

// ---------------------------------------------------------------------------
// GOLD-2 · VEND-04 + MONEY-03 — the partner's weekly fee: the rate card, the
// weekly bill, dunning, agent cash, the MMG merchant request, and stopping.
//
// The production composition (app.ts: rate limiting, tenant context per
// request, the empty-JSON parser, the vendor-header scope) with the real
// customer, vendor, admin and agent-cash route modules, real sessions and a
// real database. Billing runs through the worker's own entry points, built
// exactly as jobs/queue.ts builds them: the store is activated at the rate
// card's price by `startTrialForVendor` (what store approval calls),
// `convertExpiredTrials` is the convert-trials job, `runBillingCycle` the
// process-billing job's billing step, and `pollPendingMmgCharges` the
// poll-mmg-billing job's settlement step. The MMG provider is the sandbox the
// suite runs on; a payer's approval is scripted per transaction. Each clock
// that must pass (a trial, a retry, a poll backoff, a week) is moved on the
// single aging input of this file's own row. Asserted on durable rows:
//   · VEND-04: the week is priced by the owner's rate card; unpaid weeks dun
//     to suspension; one agent-cash payment reinstates with one receipt and
//     balanced books; its replay changes nothing
//   · VEND-04: closing the account stops billing for good; cash paid to the
//     closed account is never credited
//   · VEND-04 (E12): the owner stops and resumes the fee self-serve; a stopped
//     store pauses at its period end and resumes like any renewal
//   · MONEY-03: the agent channel credits once — a forged, stale or unsigned
//     notice, the transport retry and the settlement file never add a second
//     credit; the channel ships dark without its secret
//   · MONEY-03: the MMG merchant request settles the week once on approval;
//     a decline duns; cash paid while a request is pending pays the next week;
//     an approval after the account closed banks once and never reopens it
//     (E13 — fixed by #1280)
//   · [G2-F1] the weekly fee is billed in GYD (fixed by G2-F1)
// ---------------------------------------------------------------------------

// This file's own fixture block (+5920324nnn, 11 characters); user, store and
// payer phones and the crash-recovery purge all share this ONE constant.
const PHONE_PREFIX = '+5920324';
const FIXTURE = 'gold2-money-fixture';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// The owner rate card (ops/platform-config.ts guyanaTiers, 2026-09-22): a new
// store with no catalogue yet bills the small-vendor rate, GYD 15,000 a week.
const RATE_CARD_SMALL_VENDOR = 15_000;
// The agent channel's signing material exists only for this process's run.
const webhookSigning = randomBytes(24).toString('hex');
const REASON = { 'x-swift-reason': 'GOLD-2 golden journey: reconciling the MMG agent settlement file' };

let app: FastifyInstance;
let billing: BillingService;
let subscriptions: SubscriptionService;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Partner = { owner: Actor; vendorId: string; subId: string; san: string };
let admin: Actor;
let approver: Actor;
let outsider: Actor;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { admin?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Fee${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `g2f-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** A store activated the way store approval activates it: the subscription
 *  is born by `startTrialForVendor`, priced by the rate card, with its SAN. */
async function makePartner(firstName: string): Promise<Partner> {
  const owner = await makeUser(firstName, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: `${firstName} Kitchen`, slug: `gold2-fee-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: `${seq} Ledger Lane`, city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.155, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  }));
  const sub = await sys(() => subscriptions.startTrialForVendor(vendor.id));
  const row = await subRow(sub.id);
  expect(row.san).toMatch(/^\d{10}$/);
  return { owner, vendorId: vendor.id, subId: sub.id, san: row.san! };
}

const subRow = (id: string) => sys(() => app.prisma.subscription.findUniqueOrThrow({ where: { id } }));
const vendorRow = (id: string) => sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { status: true, acceptingOrders: true } }));
const eventsOf = async (subscriptionId: string) => (await sys(() => app.prisma.billingEvent.findMany({
  where: { subscriptionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { type: true, amount: true, idempotencyKey: true },
}))).map((e) => ({ type: e.type, amount: e.amount == null ? null : Number(e.amount), key: e.idempotencyKey }));
const countEvents = (subscriptionId: string, type: string) => sys(() => app.prisma.billingEvent.count({ where: { subscriptionId, type: type as never } }));
const wallet = async (subscriptionId: string) => Number((await sys(() => app.prisma.prepaidBalance.findUnique({ where: { subscriptionId } })))?.balance ?? 0);
const mmgPayments = (subscriptionId: string) => sys(() => app.prisma.subscriptionPayment.findMany({ where: { subscriptionId, paymentMethod: 'MOBILE_MONEY' }, orderBy: { createdAt: 'asc' } }));
const noticesTo = async (userId: string) => (await sys(() => app.prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { title: true } }))).map((n) => n.title);

/** The 14-day trial ends (its aging input), and the convert-trials job runs. */
async function trialEnds(p: Partner) {
  await sys(() => app.prisma.subscription.update({ where: { id: p.subId }, data: { trialEndDate: new Date(Date.now() - 60_000) } }));
  const convertedFrom = Date.now();
  await subscriptions.convertExpiredTrials();
  const row = await subRow(p.subId);
  expect({ status: row.status, isTrialActive: row.isTrialActive }).toEqual({ status: 'ACTIVE', isTrialActive: false });
  // Converted and immediately due, so the next billing cycle charges it.
  expect(row.nextBillingDate.getTime()).toBeGreaterThanOrEqual(convertedFrom - 1000);
  expect(row.nextBillingDate.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  return row.nextBillingDate;
}
/** The day's retry clock passes (its aging input). */
const retryClockPasses = (subscriptionId: string) => sys(() => app.prisma.subscription.update({ where: { id: subscriptionId }, data: { nextRetryAt: new Date(Date.now() - 1000) } }));
/** The poller's per-row backoff passes (its aging input). */
const pollBackoffPasses = (paymentId: string) => sys(() => app.prisma.subscriptionPayment.update({ where: { id: paymentId }, data: { lastPolledAt: new Date(Date.now() - 10 * 60_000) } }));

function signedRequest(url: string, body: unknown, over: { ts?: number; sig?: string; unsigned?: boolean } = {}): InjectOptions {
  const raw = JSON.stringify(body);
  const ts = over.ts ?? Date.now();
  const sig = over.sig ?? createHmac('sha256', webhookSigning).update(`${ts}.`).update(Buffer.from(raw)).digest('hex');
  return {
    method: 'POST',
    url,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(over.unsigned ? {} : { 'x-swift-timestamp': String(ts), 'x-swift-signature': sig }),
    },
  };
}
const agentPays = (san: string, amount: number, transactionId = `G2AC-${nanoid(10)}`, over: { ts?: number; sig?: string; unsigned?: boolean } = {}) =>
  app.inject(signedRequest('/api/v1/billing/mmg/agent-notification', { transactionId, accountNumber: san, amount, currency: 'GYD' }, over));
const inquiry = (san: string) => app.inject(signedRequest('/api/v1/billing/mmg/inquiry', { accountNumber: san }));
const agentRows = (externalId: string) => sys(() => app.prisma.mmgAgentPayment.findMany({ where: { externalId }, select: { channel: true, status: true, failureCode: true, subscriptionId: true } }));

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** The owner picks the MMG merchant rail on the real route. */
async function chooseMmg(p: Partner, msisdn: string) {
  const res = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'MOBILE_MONEY', mmgPayerMsisdn: msisdn }, { 'x-vendor-id': p.vendorId });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data).toEqual({ billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: msisdn });
}

/** The weekly bill goes out on the MMG rail: one request, pending on the phone.
 *  `firstWeekDueAgoMs` ages the first week's due date (the cycle is catching
 *  up a week that fell due that long ago). */
async function mmgRequestPending(p: Partner, firstWeekDueAgoMs = 0) {
  let period = await trialEnds(p);
  if (firstWeekDueAgoMs > 0) {
    period = new Date(Date.now() - firstWeekDueAgoMs);
    await sys(() => app.prisma.subscription.update({ where: { id: p.subId }, data: { nextBillingDate: period } }));
  }
  await billing.runBillingCycle();
  const [request] = await mmgPayments(p.subId);
  expect(request).toBeDefined();
  expect({ status: request!.status, amount: Number(request!.amount), periodStart: request!.periodStart.getTime() })
    .toEqual({ status: 'PENDING', amount: RATE_CARD_SMALL_VENDOR, periodStart: period.getTime() });
  expect(request!.externalRef).toMatch(/^mmgtx_/);
  // Nothing has been approved on the payer's phone yet.
  sandboxSetTxStatus(request!.externalRef!, 'pending');
  return { period, request: request! };
}

async function ledgerFor(subscriptionId: string) {
  const txns = await sys(() => app.prisma.ledgerTransaction.findMany({
    where: { entries: { some: { subledgerId: subscriptionId } } }, include: { entries: true }, orderBy: { createdAt: 'asc' },
  }));
  return txns.map((t) => ({
    key: t.idempotencyKey,
    entries: t.entries
      .map((e) => ({ account: e.accountCode, debit: Number(e.debit), credit: Number(e.credit) }))
      .sort((a, b) => a.account.localeCompare(b.account)),
  }));
}

async function purgeFixtures() {
  await sys(async () => {
    const byPhone = (await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } })).map((u) => u.id);
    // A closed account's phone is tombstoned; its stores keep this block's phones.
    const vendors = await app.prisma.vendor.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true, owner: { select: { userId: true } } } });
    const ids = [...new Set([...byPhone, ...vendors.map((v) => v.owner.userId)])];
    const vendorIds = vendors.map((v) => v.id);
    if (ids.length === 0 && vendorIds.length === 0) return;
    const subIds = (await app.prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((s) => s.id);
    const sessionIds = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    const imports = await app.prisma.settlementImport.findMany({ where: { source: { startsWith: 'gold2-money-' } }, select: { id: true } });
    await app.prisma.mmgAgentPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { externalId: { startsWith: 'G2AC-' } }] } });
    await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { startsWith: 'G2AC-' } }] } });
    await app.prisma.settlementImport.deleteMany({ where: { id: { in: imports.map((i) => i.id) } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...vendorIds, ...subIds, ...imports.map((i) => i.id)] } }] }, 'GOLD-2 golden journey fixture cleanup (gold-2-money)');
    if (subIds.length > 0) {
      // The final dunning warning pages every platform admin (the seeded one
      // too). The page has no dedupe key, so its tracking row is matched to its
      // own notice: same admin, same page, written in the same instant.
      const pages = await app.prisma.$queryRaw<Array<{ userId: string; createdAt: Date; kind: string }>>`
        SELECT "userId", "createdAt", "data"->>'kind' AS "kind" FROM "notifications"
        WHERE "data"->>'subscriptionId' IN (${Prisma.join(subIds)}) AND "data"->>'kind' = 'billing_dunning_ops_task'`;
      for (const page of pages) {
        await app.prisma.alertDelivery.deleteMany({
          where: { kind: 'ADMIN_OPS', subjectId: page.kind, recipientId: page.userId, sentAt: { gte: new Date(page.createdAt.getTime() - 10_000), lte: new Date(page.createdAt.getTime() + 10_000) } },
        });
      }
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'subscriptionId' IN (${Prisma.join(subIds)})`;
    }
    await app.prisma.alertDelivery.deleteMany({ where: { recipientId: { in: ids } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    // Activation opens an identity cluster per human (the trial law); billing
    // captures the MMG payer. A cluster goes only when nothing else uses it.
    const clusterIds = [...new Set([
      ...(await app.prisma.trialGrant.findMany({ where: { accountId: { in: ids } }, select: { clusterId: true } })).map((g) => g.clusterId),
      ...(await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: ids } }, select: { clusterId: true } })).map((m) => m.clusterId),
    ].filter((c): c is string => !!c))];
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: ids } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: ids } } });
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: ids } } });
    // A crashed earlier run can leave a payer key that a new run's payer then
    // unions with; walk that union history around this file's clusters and
    // remove, leaf first, every node nothing lives in or points at any more.
    const around = new Set(clusterIds);
    for (let hop = 0; hop < 8; hop += 1) {
      const linked = await app.prisma.identityCluster.findMany({ where: { OR: [{ id: { in: [...around] } }, { mergedIntoId: { in: [...around] } }] }, select: { id: true, mergedIntoId: true } });
      const size = around.size;
      for (const c of linked) { around.add(c.id); if (c.mergedIntoId) around.add(c.mergedIntoId); }
      if (around.size === size) break;
    }
    for (let round = 0; round < 8; round += 1) {
      const empty = (await app.prisma.identityCluster.findMany({ where: { id: { in: [...around] }, members: { none: {} }, trialGrants: { none: {} } }, select: { id: true } })).map((c) => c.id);
      const pointedAt = new Set((await app.prisma.identityCluster.findMany({ where: { mergedIntoId: { in: empty } }, select: { mergedIntoId: true } })).map((c) => c.mergedIntoId));
      const leaves = empty.filter((id) => !pointedAt.has(id));
      if (leaves.length === 0) break;
      await app.prisma.identityCluster.deleteMany({ where: { id: { in: leaves } } });
    }
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...sessionIds, ...vendorIds, ...subIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  vi.stubEnv('AGENT_CASH_WEBHOOK_SECRET', webhookSigning);
  sandboxResetMmg();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  // Production's key generator (app.ts): a VERIFIED token buckets per userId,
  // anything else shares the resolved-IP bucket. app.jwt is read lazily, so
  // registering authPlugin below is in time.
  await app.register(rateLimit, { keyGenerator: rateLimitKey((token) => app.jwt.verify(token)), max: 200, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(agentCashRoutes, { prefix: '/api/v1/billing/mmg' });
  await app.ready();
  // Built exactly as the subscription worker builds them (jobs/queue.ts).
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  subscriptions = new SubscriptionService(app.prisma);
  await purgeFixtures();

  admin = await makeUser('Ama', ['ADMIN'], 'ADMIN', { admin: true });
  approver = await makeUser('Ebo', ['SUPER_ADMIN'], 'SUPER_ADMIN', { admin: true });
  outsider = await makeUser('Olu', ['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
  sandboxResetMmg();
  vi.unstubAllEnvs();
});

describe('GOLD-2 · VEND-04 — the weekly fee and agent cash', () => {
  it('the week is priced by the owner’s rate card; unpaid weeks dun to suspension; one agent payment reinstates it with one receipt and balanced books, and its replay changes nothing', async () => {
    const trialStarted = Date.now();
    const p = await makePartner('Vera');
    const born = await subRow(p.subId);
    expect({ status: born.status, type: born.type, weeklyRate: Number(born.weeklyRate), billingMethod: born.billingMethod, customRate: born.customRate })
      .toEqual({ status: 'TRIAL', type: 'RESTAURANT', weeklyRate: RATE_CARD_SMALL_VENDOR, billingMethod: 'CASH', customRate: null });
    expect(born.trialEndDate!.getTime()).toBeGreaterThanOrEqual(trialStarted + 14 * DAY - 5_000);
    expect(born.trialEndDate!.getTime()).toBeLessThanOrEqual(Date.now() + 14 * DAY);

    // The pay screen, read by its owner only.
    const screen = await call('GET', '/api/v1/vendor/subscription', p.owner.token, undefined, { 'x-vendor-id': p.vendorId });
    expect(screen.statusCode).toBe(200);
    expect(screen.json().data).toMatchObject({ id: p.subId, status: 'TRIAL', weeklyRate: RATE_CARD_SMALL_VENDOR, san: p.san, weeklyFeeGyd: RATE_CARD_SMALL_VENDOR, walletBalanceGyd: 0, amountDueGyd: RATE_CARD_SMALL_VENDOR });
    expect((await call('GET', '/api/v1/vendor/subscription', outsider.token)).statusCode).toBe(403);

    // The trial ends; the weekly bill finds an empty wallet three days running.
    const period = await trialEnds(p);
    const expectedLadder: Array<[string, number, string]> = [
      ['PAST_DUE', 1, 'Subscription payment failed'],
      ['PAST_DUE', 2, 'Final warning — payment needed'],
      ['SUSPENDED', 3, 'Subscription suspended'],
    ];
    for (const [i, [status, attempts]] of expectedLadder.entries()) {
      if (i > 0) await retryClockPasses(p.subId);
      await billing.runBillingCycle();
      const row = await subRow(p.subId);
      expect({ status: row.status, failedAttempts: row.failedAttempts, nextBillingDate: row.nextBillingDate.getTime() })
        .toEqual({ status, failedAttempts: attempts, nextBillingDate: period.getTime() });
      expect(await noticesTo(p.owner.userId)).toEqual(expectedLadder.slice(0, i + 1).map(([, , n]) => n));
      if (attempts === 2) {
        // Before access is cut, a person is tasked: every platform admin is paged.
        const paged = await sys(() => app.prisma.notification.findMany({ where: { userId: admin.userId, data: { path: ['subscriptionId'], equals: p.subId } }, select: { title: true } }));
        expect(paged).toEqual([{ title: 'Dunning — final warning issued' }]);
      }
    }
    const periodKey = period.toISOString().slice(0, 10);
    expect(await eventsOf(p.subId)).toEqual([
      ...[0, 1, 2].flatMap((a) => [
        { type: 'CHARGE_ATTEMPT', amount: RATE_CARD_SMALL_VENDOR, key: `charge:${p.subId}:${periodKey}:a${a}` },
        { type: 'CHARGE_FAILED', amount: RATE_CARD_SMALL_VENDOR, key: `failed:${p.subId}:${periodKey}:a${a}` },
      ]),
      { type: 'SUSPENDED', amount: null, key: `suspended:${p.subId}:${periodKey}` },
    ]);
    expect(await vendorRow(p.vendorId)).toEqual({ status: 'SUSPENDED', acceptingOrders: false });

    // Suspended, the owner still reaches the screen they pay on; the agent's
    // lookup shows the masked name and the exact amount before taking cash.
    const suspendedScreen = await call('GET', '/api/v1/vendor/subscription', p.owner.token, undefined, { 'x-vendor-id': p.vendorId });
    expect(suspendedScreen.json().data).toMatchObject({ status: 'SUSPENDED', amountDueGyd: RATE_CARD_SMALL_VENDOR });
    const lookup = await inquiry(p.san);
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({
      valid: true, displayName: expect.stringMatching(/^V•+ \(Georgetown\)$/), accountNumber: `${p.san.slice(0, 3)} ${p.san.slice(3, 6)} ${p.san.slice(6)}`,
      amountDueGyd: '15000.00', weeklyFeeGyd: '15000.00', currency: 'GYD',
    });

    // The partner pays at an MMG agent: one signed notice credits the wallet,
    // and the instant re-bill spends it on the owed week and reinstates.
    const txn = `G2AC-${nanoid(10)}`;
    const paid = await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn);
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({ status: 'accepted' });
    const reinstated = await subRow(p.subId);
    expect({ status: reinstated.status, failedAttempts: reinstated.failedAttempts, suspendedAt: reinstated.suspendedAt, nextBillingDate: reinstated.nextBillingDate.getTime() })
      .toEqual({ status: 'ACTIVE', failedAttempts: 0, suspendedAt: null, nextBillingDate: period.getTime() + WEEK });
    expect(await vendorRow(p.vendorId)).toEqual({ status: 'ACTIVE', acceptingOrders: true });
    expect(await wallet(p.subId)).toBe(0);
    const paidEvents = (await eventsOf(p.subId)).slice(7);
    expect(paidEvents.map((e) => [e.type, e.amount])).toEqual([
      ['PREPAID_TOPUP', RATE_CARD_SMALL_VENDOR], ['CHARGE_ATTEMPT', RATE_CARD_SMALL_VENDOR], ['CHARGE_SUCCESS', RATE_CARD_SMALL_VENDOR], ['REINSTATED', null],
    ]);
    expect(paidEvents.slice(1, 3).map((e) => e.key)).toEqual([`charge:${p.subId}:${periodKey}:a3`, `success:${p.subId}:${periodKey}`]);
    const receipts = await sys(() => app.prisma.feeReceipt.findMany({ where: { subscriptionId: p.subId } }));
    expect(receipts).toHaveLength(1);
    expect({ amount: Number(receipts[0]!.amount), channel: receipts[0]!.channel, mmgRef: receipts[0]!.mmgRef })
      .toEqual({ amount: RATE_CARD_SMALL_VENDOR, channel: 'MMG_AGENT_WEBHOOK', mmgRef: `MMG agent payment ${txn}` });
    expect(receipts[0]!.receiptNumber).toMatch(/^SWF-SWIFT-\d{4}-\d{6}$/);
    // Books: the cash lands as the partner's balance, then becomes fee revenue.
    const books = await ledgerFor(p.subId);
    expect(books).toHaveLength(2);
    expect(books[0]!.entries).toEqual([
      { account: 'CLEARING_MMG', debit: RATE_CARD_SMALL_VENDOR, credit: 0 },
      { account: 'WALLET_LIABILITY', debit: 0, credit: RATE_CARD_SMALL_VENDOR },
    ]);
    expect(books[1]).toEqual({
      key: `ledger:success:${p.subId}:${periodKey}`,
      entries: [
        { account: 'FEE_REVENUE', debit: 0, credit: RATE_CARD_SMALL_VENDOR },
        { account: 'WALLET_LIABILITY', debit: RATE_CARD_SMALL_VENDOR, credit: 0 },
      ],
    });
    expect((await noticesTo(p.owner.userId)).slice(3)).toEqual(['Top-up received', 'Subscription payment received']);

    // The agent's system resends the same notice: nothing moves again.
    const replay = await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'duplicate' });
    expect(await agentRows(txn)).toEqual([{ channel: 'MMG_AGENT_WEBHOOK', status: 'MATCHED', failureCode: null, subscriptionId: p.subId }]);
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(1);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    expect(await sys(() => app.prisma.feeReceipt.count({ where: { subscriptionId: p.subId } }))).toBe(1);
    expect(await ledgerFor(p.subId)).toHaveLength(2);
    // Next week's fee is due again in full.
    expect((await inquiry(p.san)).json()).toMatchObject({ valid: true, amountDueGyd: '15000.00' });
  });

  it('closing the account stops the fee for good — and cash paid to the closed account is recorded, never credited', async () => {
    const p = await makePartner('Wes');
    const period = await trialEnds(p);
    // In good standing: the first week is paid in cash ahead of the bill.
    expect((await agentPays(p.san, RATE_CARD_SMALL_VENDOR)).json()).toEqual({ status: 'accepted' });
    await billing.runBillingCycle();
    expect((await subRow(p.subId)).nextBillingDate.getTime()).toBe(period.getTime() + WEEK);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);

    // Closing the account is the PERMANENT stop (the self-serve pause, E12, is
    // pinned in its own describe below).
    const closed = await call('DELETE', '/api/v1/customer/account', p.owner.token);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().data).toEqual({ deleted: true });
    const cancelled = await subRow(p.subId);
    expect({ status: cancelled.status, autoRenew: cancelled.autoRenew, nextRetryAt: cancelled.nextRetryAt }).toEqual({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    expect(await vendorRow(p.vendorId)).toEqual({ status: 'SUSPENDED', acceptingOrders: false });
    const owner = await sys(() => app.prisma.user.findUniqueOrThrow({ where: { id: p.owner.userId }, select: { status: true, phone: true } }));
    expect(owner).toEqual({ status: 'DEACTIVATED', phone: `deleted:${p.owner.userId}` });
    expect((await call('GET', '/api/v1/vendor/subscription', p.owner.token)).statusCode).toBe(401);

    // The next week comes and goes: the cycle never bills a closed account.
    await sys(() => app.prisma.subscription.update({ where: { id: p.subId }, data: { nextBillingDate: new Date(Date.now() - 60_000) } }));
    const attemptsBefore = await countEvents(p.subId, 'CHARGE_ATTEMPT');
    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'CHARGE_ATTEMPT')).toBe(attemptsBefore);

    // Cash paid at an agent to the closed number is recorded for a person to refund — never credited.
    const txn = `G2AC-${nanoid(10)}`;
    const late = await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn);
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ status: 'received_unmatched' });
    expect(await agentRows(txn)).toEqual([{ channel: 'MMG_AGENT_WEBHOOK', status: 'UNMATCHED', failureCode: 'ACCOUNT_CLOSED', subscriptionId: null }]);
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(1);
    expect((await subRow(p.subId)).status).toBe('CANCELLED');
    expect((await inquiry(p.san)).json()).toEqual({ valid: false, reason: 'ACCOUNT_CLOSED' });
  });
});

describe('GOLD-2 · MONEY-03 — the agent channel credits once', () => {
  it('forged, stale and unsigned notices move nothing; the signed notice credits once; its transport retry and the settlement file (two admins) reconcile without a second credit', async () => {
    const p = await makePartner('Xan');
    const period = await trialEnds(p);
    await billing.runBillingCycle();
    expect((await subRow(p.subId)).status).toBe('PAST_DUE');
    expect((await inquiry(p.san)).json()).toMatchObject({ valid: true, amountDueGyd: '15000.00' });

    // Only a genuine signature moves money; 401 is the only refusal, and it writes nothing.
    const forged = `G2AC-${nanoid(10)}`;
    const refusals = [
      [await agentPays(p.san, RATE_CARD_SMALL_VENDOR, forged, { sig: 'f'.repeat(64) }), 'BAD_SIGNATURE'],
      [await agentPays(p.san, RATE_CARD_SMALL_VENDOR, forged, { ts: Date.now() - 6 * 60_000 }), 'STALE_TIMESTAMP'],
      [await agentPays(p.san, RATE_CARD_SMALL_VENDOR, forged, { unsigned: true }), 'SIGNATURE_MISSING'],
    ] as const;
    for (const [res, code] of refusals) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ status: 'unauthorized', code });
    }
    expect(await agentRows(forged)).toEqual([]);
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(0);
    expect((await subRow(p.subId)).status).toBe('PAST_DUE');

    const txn = `G2AC-${nanoid(10)}`;
    expect((await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn)).json()).toEqual({ status: 'accepted' });
    const settled = await subRow(p.subId);
    expect({ status: settled.status, nextBillingDate: settled.nextBillingDate.getTime() }).toEqual({ status: 'ACTIVE', nextBillingDate: period.getTime() + WEEK });

    // The same notice again (a transport retry): answered, never re-credited.
    expect((await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn)).json()).toEqual({ status: 'duplicate' });

    // The day's settlement file carries the same transaction. Uploading it is a
    // money action: one admin asks, a second approves, then it runs.
    const csv = ['transaction_id,account_number,amount,paid_at', `${txn},${p.san},${RATE_CARD_SMALL_VENDOR},${new Date().toISOString()}`].join('\n');
    const upload = { csv, source: `gold2-money-${nanoid(8)}` };
    const ask = await call('POST', '/api/v1/admin/billing/settlement-import', admin.token, upload, REASON);
    expect(ask.statusCode, ask.body).toBe(202);
    expect(ask.json().error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = ask.json().error.details.approvalId as string;
    const selfApprove = await call('POST', `/api/v1/admin/approvals/${approvalId}/decide`, admin.token, { approve: true }, REASON);
    expect(selfApprove.statusCode).toBe(403);
    const approved = await call('POST', `/api/v1/admin/approvals/${approvalId}/decide`, approver.token, { approve: true, note: 'Matches the MMG statement' }, REASON);
    expect(approved.statusCode, approved.body).toBe(200);
    const run = await call('POST', '/api/v1/admin/billing/settlement-import', admin.token, upload, { ...REASON, 'x-swift-approval': approvalId });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().data).toMatchObject({ status: 'PUBLISHED', fileRows: 1, credited: 0, reconciled: 1, unmatched: 0, rejectedRows: [], replayed: false });

    // One transaction, two observations, one credit.
    expect((await agentRows(txn)).map((r) => [r.channel, r.status]).sort()).toEqual([['MMG_AGENT_WEBHOOK', 'MATCHED'], ['MMG_SETTLEMENT_FILE', 'RECONCILED']]);
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(1);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    expect(await wallet(p.subId)).toBe(0);
  });

  it('ships dark: without its signing secret the notice and the lookup answer 503 and record nothing', async () => {
    const p = await makePartner('Yul');
    const txn = `G2AC-${nanoid(10)}`;
    try {
      for (const secret of ['', 'too-short-15chr']) {
        vi.stubEnv('AGENT_CASH_WEBHOOK_SECRET', secret);
        const notice = await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn);
        expect(notice.statusCode).toBe(503);
        expect(notice.json()).toEqual({ status: 'channel_disabled' });
        const lookup = await inquiry(p.san);
        expect(lookup.statusCode).toBe(503);
        expect(lookup.json()).toEqual({ status: 'channel_disabled' });
      }
    } finally {
      vi.stubEnv('AGENT_CASH_WEBHOOK_SECRET', webhookSigning);
    }
    expect(await agentRows(txn)).toEqual([]);
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(0);
    // Signed again, the same channel answers.
    expect((await inquiry(p.san)).json()).toMatchObject({ valid: true });
  });
});

describe('GOLD-2 · MONEY-03 — the MMG merchant request', () => {
  it('the owner picks MMG; the weekly bill is a request on their phone; nothing advances until MMG says approved, which settles the week exactly once with its ledger', async () => {
    const p = await makePartner('Zed');
    const refused = await call('PUT', '/api/v1/vendor/subscription/billing-method', outsider.token, { method: 'MOBILE_MONEY', mmgPayerMsisdn: `${PHONE_PREFIX}801` });
    expect(refused.statusCode).toBe(403);
    await chooseMmg(p, `${PHONE_PREFIX}801`);
    const { period, request } = await mmgRequestPending(p);
    const periodKey = period.toISOString().slice(0, 10);
    expect(request.expiresAt!.getTime()).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect(request.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + DAY);
    const asked = await subRow(p.subId);
    expect({ status: asked.status, nextBillingDate: asked.nextBillingDate.getTime() }).toEqual({ status: 'ACTIVE', nextBillingDate: period.getTime() });
    expect(asked.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect(asked.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + DAY);
    expect(await noticesTo(p.owner.userId)).toEqual(['Approve your weekly fee in MMG']);

    // Still pending on the phone: the poller settles nothing.
    await billing.pollPendingMmgCharges();
    expect((await mmgPayments(p.subId)).map((r) => r.status)).toEqual(['PENDING']);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(0);

    // The payer approves; the next poll settles THAT request, in place, once.
    sandboxSetTxStatus(request.externalRef!, 'approved');
    await pollBackoffPasses(request.id);
    const settledFrom = Date.now();
    await billing.pollPendingMmgCharges();
    const [captured] = await mmgPayments(p.subId);
    expect({ id: captured!.id, status: captured!.status }).toEqual({ id: request.id, status: 'CAPTURED' });
    expect(captured!.paidAt!.getTime()).toBeGreaterThanOrEqual(settledFrom - 1000);
    expect(captured!.paidAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const advanced = await subRow(p.subId);
    expect({ status: advanced.status, nextBillingDate: advanced.nextBillingDate.getTime() }).toEqual({ status: 'ACTIVE', nextBillingDate: period.getTime() + WEEK });
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    expect(await ledgerFor(p.subId)).toEqual([]);
    const book = await sys(() => app.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `ledger:success:${p.subId}:${periodKey}` }, include: { entries: true } }));
    expect(book.entries.map((e) => ({ account: e.accountCode, debit: Number(e.debit), credit: Number(e.credit) })).sort((a, b) => a.account.localeCompare(b.account)))
      .toEqual([{ account: 'CLEARING_MMG', debit: RATE_CARD_SMALL_VENDOR, credit: 0 }, { account: 'FEE_REVENUE', debit: 0, credit: RATE_CARD_SMALL_VENDOR }]);

    // The poller and the cycle run again: never a second advance or request.
    await pollBackoffPasses(request.id);
    await billing.pollPendingMmgCharges();
    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    expect(await mmgPayments(p.subId)).toHaveLength(1);
    expect((await subRow(p.subId)).nextBillingDate.getTime()).toBe(period.getTime() + WEEK);
  });

  it('a declined request duns: the payment fails, the week does not advance, and the ladder moves', async () => {
    const p = await makePartner('Ada');
    await chooseMmg(p, `${PHONE_PREFIX}802`);
    const { period, request } = await mmgRequestPending(p);
    sandboxSetTxStatus(request.externalRef!, 'declined');
    await pollBackoffPasses(request.id);
    await billing.pollPendingMmgCharges();
    expect((await mmgPayments(p.subId)).map((r) => r.status)).toEqual(['FAILED']);
    const dunned = await subRow(p.subId);
    expect({ status: dunned.status, failedAttempts: dunned.failedAttempts, nextBillingDate: dunned.nextBillingDate.getTime() })
      .toEqual({ status: 'PAST_DUE', failedAttempts: 1, nextBillingDate: period.getTime() });
    expect(await countEvents(p.subId, 'CHARGE_FAILED')).toBe(1);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(0);
  });

  it('cash paid while a request is pending is never a double charge: the approval pays this week and the cash pays the next', async () => {
    const p = await makePartner('Bea');
    await chooseMmg(p, `${PHONE_PREFIX}803`);
    // The first week fell due a week ago; its request goes out now and waits.
    const { period, request } = await mmgRequestPending(p, WEEK + 60 * 60_000);

    expect((await agentPays(p.san, RATE_CARD_SMALL_VENDOR)).json()).toEqual({ status: 'accepted' });
    expect(await wallet(p.subId)).toBe(RATE_CARD_SMALL_VENDOR);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(0); // the pending request still owns this week

    sandboxSetTxStatus(request.externalRef!, 'approved');
    await pollBackoffPasses(request.id);
    await billing.pollPendingMmgCharges();
    expect((await subRow(p.subId)).nextBillingDate.getTime()).toBe(period.getTime() + WEEK);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    expect(await wallet(p.subId)).toBe(RATE_CARD_SMALL_VENDOR); // the cash waits for the next week

    // By the time the approval landed, the next week had also fallen due: the
    // cash already held pays it, with no new MMG request.
    const weekTwo = (await subRow(p.subId)).nextBillingDate;
    expect(weekTwo.getTime()).toBeLessThan(Date.now());
    await billing.runBillingCycle();
    expect((await subRow(p.subId)).nextBillingDate.getTime()).toBe(weekTwo.getTime() + WEEK);
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(2);
    expect(await wallet(p.subId)).toBe(0);
    // Week one: the approved request; week two: the held cash. Never a second request.
    expect((await mmgPayments(p.subId)).map((r) => ({ id: r.id, status: r.status, ref: r.externalRef, periodStart: r.periodStart.getTime() }))).toEqual([
      { id: request.id, status: 'CAPTURED', ref: request.externalRef, periodStart: period.getTime() },
      { id: expect.any(String), status: 'CAPTURED', ref: 'prepaid', periodStart: weekTwo.getTime() },
    ]);
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(1);
  });

  it('an approval that arrives after the owner closed the account banks the money once and never reopens billing (E13, fixed by #1280)', async () => {
    const p = await makePartner('Cyd');
    await chooseMmg(p, `${PHONE_PREFIX}804`);
    const { request } = await mmgRequestPending(p);

    const closed = await call('DELETE', '/api/v1/customer/account', p.owner.token);
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await subRow(p.subId)).status).toBe('CANCELLED');
    const titlesBefore = await noticesTo(p.owner.userId);

    // The payer approves the old request on their phone after leaving.
    sandboxSetTxStatus(request.externalRef!, 'approved');
    await pollBackoffPasses(request.id);
    await billing.pollPendingMmgCharges();
    expect((await mmgPayments(p.subId)).map((r) => r.status)).toEqual(['CAPTURED']);
    const after = await subRow(p.subId);
    expect({ status: after.status, autoRenew: after.autoRenew }).toEqual({ status: 'CANCELLED', autoRenew: false });
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(0);
    // Banked exactly once, keyed to that payment, as the payer's balance.
    const banked = (await eventsOf(p.subId)).filter((e) => e.type === 'PREPAID_TOPUP');
    expect(banked).toEqual([{ type: 'PREPAID_TOPUP', amount: RATE_CARD_SMALL_VENDOR, key: `bank:${request.id}` }]);
    expect(await wallet(p.subId)).toBe(RATE_CARD_SMALL_VENDOR);
    // A deleted account is not messaged about it.
    expect(await noticesTo(p.owner.userId)).toEqual(titlesBefore);

    await pollBackoffPasses(request.id);
    await billing.pollPendingMmgCharges();
    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'PREPAID_TOPUP')).toBe(1);
    expect(await countEvents(p.subId, 'CHARGE_ATTEMPT')).toBe(1);
    expect((await subRow(p.subId)).status).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// GOLD-2 · VEND-04 — E12: the owner stops and resumes the weekly fee self-serve
// (method NONE on the billing-method route). Stop is idempotent and audit-logged,
// the rail survives, the paid period still runs out, and a late MMG approval or
// a resume of a lapsed store can never silently reopen service.
// ---------------------------------------------------------------------------
describe('GOLD-2 · VEND-04 — E12 the owner stops and resumes weekly billing', () => {
  it('stop sets autoRenew=false keeping the rail, writes exactly one stop event + audit row, and a double-stop adds none', async () => {
    const p = await makePartner('E12a');
    await chooseMmg(p, `${PHONE_PREFIX}807`);

    const stop = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'NONE' }, { 'x-vendor-id': p.vendorId });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().data).toEqual({ billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: `${PHONE_PREFIX}807` });

    const row = await subRow(p.subId);
    expect({
      autoRenew: row.autoRenew,
      nextRetryAt: row.nextRetryAt,
      billingMethod: row.billingMethod,
      mmgPayerMsisdn: row.mmgPayerMsisdn,
    }).toEqual({ autoRenew: false, nextRetryAt: null, billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: `${PHONE_PREFIX}807` });

    // The GET exposes autoRenew for the app's stop/resume state.
    const get = await call('GET', '/api/v1/vendor/subscription', p.owner.token, undefined, { 'x-vendor-id': p.vendorId });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.autoRenew).toBe(false);

    const again = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'NONE' }, { 'x-vendor-id': p.vendorId });
    expect(again.statusCode, again.body).toBe(200);

    const stops = (await eventsOf(p.subId)).filter((e) => e.key.startsWith(`stop:${p.subId}:`));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ type: 'TIER_CHANGE', amount: null });
    const note = await sys(() => app.prisma.billingEvent.findFirstOrThrow({
      where: { subscriptionId: p.subId, idempotencyKey: { startsWith: `stop:${p.subId}:` } },
    }));
    expect(note.note).toBe('Weekly billing stopped by the partner');
    const audit = await sys(() => app.prisma.auditLog.findFirstOrThrow({
      where: { entityId: p.subId, action: 'BILLING_STOPPED' },
    }));
    expect(audit.userId).toBe(p.owner.userId);
  });

  it('only the owner may stop — a manager, a customer and another store’s owner cannot touch this subscription', async () => {
    const p = await makePartner('E12b');
    const q = await makePartner('E12c');
    const manager = await makeUser('E12mgr', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    await sys(() => app.prisma.vendorStaff.create({
      data: { vendorId: p.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: p.owner.userId },
    }));

    const managerStop = await call('PUT', '/api/v1/vendor/subscription/billing-method', manager.token, { method: 'NONE' }, { 'x-vendor-id': p.vendorId });
    expect(managerStop.statusCode).toBe(403);
    expect(managerStop.json().error.code).toBe('STAFF_FORBIDDEN');

    const customerStop = await call('PUT', '/api/v1/vendor/subscription/billing-method', outsider.token, { method: 'NONE' }, { 'x-vendor-id': p.vendorId });
    expect(customerStop.statusCode).toBe(403);

    // Another store's owner resolves THEIR OWN store — this subscription is
    // unreachable by the route's shape (no subscription id in the URL).
    const theirs = await call('PUT', '/api/v1/vendor/subscription/billing-method', q.owner.token, { method: 'NONE' }, { 'x-vendor-id': q.vendorId });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect((await subRow(p.subId)).autoRenew).toBe(true);
    expect((await subRow(q.subId)).autoRenew).toBe(false);
  });

  it('resume re-arms billing and the next cycle bills the week off the prepaid balance', async () => {
    const p = await makePartner('E12d');
    await trialEnds(p); // ACTIVE and immediately due — the stopped week must not bill
    // [DS198 D3] the wallet is in the subscription's own currency (GYD since G2-F1)
    const { currencyCode } = await subRow(p.subId);
    await sys(() => app.prisma.prepaidBalance.create({
      data: { subscriptionId: p.subId, balance: RATE_CARD_SMALL_VENDOR, currencyCode },
    }));

    const stop = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'NONE' }, { 'x-vendor-id': p.vendorId });
    expect(stop.statusCode, stop.body).toBe(200);
    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(0);

    const resume = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'CASH' }, { 'x-vendor-id': p.vendorId });
    expect(resume.statusCode, resume.body).toBe(200);
    expect((await subRow(p.subId)).autoRenew).toBe(true);

    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    expect((await subRow(p.subId)).status).toBe('ACTIVE');
    expect(await wallet(p.subId)).toBe(0);
  });

  it('a stopped store pauses at its period end, and the owner resumes it self-serve — billed like any renewal', async () => {
    const p = await makePartner('E12e');
    await trialEnds(p); // [DS198 D1] ACTIVE (the sweep only pauses ACTIVE rows)
    // trialEnds ages only trialEndDate; in production currentPeriodEnd IS the
    // trial end, so the period is over too.
    await sys(() => app.prisma.subscription.update({ where: { id: p.subId }, data: { currentPeriodEnd: new Date(Date.now() - 60_000) } }));
    const stop = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'NONE' }, { 'x-vendor-id': p.vendorId });
    expect(stop.statusCode, stop.body).toBe(200);

    await billing.lapseStoppedSubscriptions(); // may also sweep another file's stopped row; the row-state assertions below are the proof
    const lapsed = await subRow(p.subId);
    expect({ status: lapsed.status, autoRenew: lapsed.autoRenew, nextRetryAt: lapsed.nextRetryAt })
      .toEqual({ status: 'PAUSED', autoRenew: false, nextRetryAt: null });
    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(0);

    await sys(() => app.prisma.prepaidBalance.create({
      data: { subscriptionId: p.subId, balance: RATE_CARD_SMALL_VENDOR, currencyCode: lapsed.currencyCode },
    }));
    const resumedAt = Date.now();
    const resume = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'CASH' }, { 'x-vendor-id': p.vendorId });
    expect(resume.statusCode, resume.body).toBe(200);
    const resumed = await subRow(p.subId);
    expect({ status: resumed.status, autoRenew: resumed.autoRenew }).toEqual({ status: 'ACTIVE', autoRenew: true });
    expect(resumed.nextBillingDate.getTime()).toBeGreaterThanOrEqual(resumedAt - 1000);

    await billing.runBillingCycle();
    expect(await countEvents(p.subId, 'CHARGE_SUCCESS')).toBe(1);
    const billed = await subRow(p.subId);
    expect({ status: billed.status, nextBillingDate: billed.nextBillingDate.getTime() })
      .toEqual({ status: 'ACTIVE', nextBillingDate: resumed.nextBillingDate.getTime() + WEEK });
    expect(await wallet(p.subId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G2-F1 (S1, fixed by G2-F1): every subscription born through activation carried
// the owner's COUNTRY code as its currency. subscription.service.ts passes
// `activation.countryCode` into `create(entity, type, weeklyRate, currencyCode)`
// (:146, :152, :158 → :179-183) — the same call shape since 444bce77. So a
// Guyana store's subscription, every charge event, its wallet and the partner's
// notices say "GY", not "GYD" (the schema default and every seeded row say
// GYD), and the MMG merchant request goes out with currency "GY": the live
// provider receives it as `currency` (providers/mmg/mmg-provider.ts:315), and
// settlement compares the provider's currency with the attempt's
// (billing.service.ts:1799), so an ISO answer would be held for manual
// reconciliation. This pins the correct contract on the rows the system itself
// writes. The activation, the MMG rail and the weekly bill run in beforeAll,
// so this can only fail on the currency. The activation resolvers now read the
// CountryConfig currency, and a data migration corrects rows already written.
// ---------------------------------------------------------------------------
describe('GOLD-2 · VEND-04 / MONEY-03 — [G2-F1] the weekly fee is billed in Guyana dollars', () => {
  let p: Partner;
  let externalRef: string;

  beforeAll(async () => {
    p = await makePartner('Gia');
    await chooseMmg(p, `${PHONE_PREFIX}805`);
    externalRef = (await mmgRequestPending(p)).request.externalRef!;
  });

  it('[G2-F1] the subscription, its charge and the MMG request are all in GYD', async () => {
    expect((await subRow(p.subId)).currencyCode).toBe('GYD');
    const attempts = await sys(() => app.prisma.billingEvent.findMany({ where: { subscriptionId: p.subId, type: 'CHARGE_ATTEMPT' }, select: { currencyCode: true } }));
    expect(attempts).toEqual([{ currencyCode: 'GYD' }]);
    expect((await getMmgProvider().transactionLookup({ transactionId: externalRef })).currencyCode).toBe('GYD');
  });

  it('[G2-F1] a request sent before the fix ("GY" on the wire) and approved after the migration settles once — it is not held', async () => {
    // [DS191 F1] The deploy window: the request went out as "GY", the data
    // migration then corrected this subscription's rows to "GYD", and the
    // payer approves afterwards with the provider still echoing "GY".
    const legacy = await makePartner('Gus');
    await chooseMmg(legacy, `${PHONE_PREFIX}806`);
    await sys(() => app.prisma.subscription.update({ where: { id: legacy.subId }, data: { currencyCode: 'GY' } }));
    const { period, request } = await mmgRequestPending(legacy);
    const pinned = await sys(() => app.prisma.billingEvent.findMany({ where: { subscriptionId: legacy.subId, type: 'CHARGE_ATTEMPT' }, select: { currencyCode: true } }));
    expect(pinned).toEqual([{ currencyCode: 'GY' }]);
    expect((await getMmgProvider().transactionLookup({ transactionId: request.externalRef! })).currencyCode).toBe('GY');
    // exactly what 20260924150000_g2f1_subscription_currency does to this subscription's rows
    await sys(async () => {
      await app.prisma.subscription.update({ where: { id: legacy.subId }, data: { currencyCode: 'GYD' } });
      await app.prisma.billingEvent.updateMany({ where: { subscriptionId: legacy.subId, currencyCode: 'GY' }, data: { currencyCode: 'GYD' } });
      await app.prisma.prepaidBalance.updateMany({ where: { subscriptionId: legacy.subId, currencyCode: 'GY' }, data: { currencyCode: 'GYD' } });
    });

    sandboxSetTxStatus(request.externalRef!, 'approved');
    await pollBackoffPasses(request.id);
    await billing.pollPendingMmgCharges();
    const [settled] = await mmgPayments(legacy.subId);
    expect({ id: settled!.id, status: settled!.status }).toEqual({ id: request.id, status: 'CAPTURED' });
    const advanced = await subRow(legacy.subId);
    expect({ status: advanced.status, nextBillingDate: advanced.nextBillingDate.getTime() }).toEqual({ status: 'ACTIVE', nextBillingDate: period.getTime() + WEEK });
    expect(await countEvents(legacy.subId, 'CHARGE_SUCCESS')).toBe(1);
  });
});
