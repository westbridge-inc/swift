import { grantStepUp } from '../helpers/step-up';
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
import { SubscriptionService } from '../../modules/subscription/subscription.service';
import { purgeAuditLogs } from '../../lib/audit-immutability';
import { startGoldenWorker } from './gold-7-worker';
import { cleanupBillingClocks } from '../helpers/billing-clock-cleanup';


// ---------------------------------------------------------------------------
// GOLD-7 · VEND-04 — bill → dun → suspend → agent cash → reinstate → stop.
//
// The REAL production subscription Worker from jobs/queue.ts consumes BullMQ
// jobs on the assigned test Redis DB. No BillingService method is called by
// this test. The owner reads/stops the plan and the agent pays through mounted
// production routes; all assertions inspect real PostgreSQL evidence.
//
// Only Date is controlled (Vitest's existing clock); sockets/timers stay real.
// The clock starts before foreign billing deadlines; their snapshots must stay
// unchanged. No production sweep is filtered or mocked. Preflight refuses any
// foreign subscription that could become eligible during this journey.
// Device/staging-only: physical agent cash collection, live MMG acceptance,
// and real SMS/push delivery. The signed notice is the in-app boundary.
// ---------------------------------------------------------------------------

// +5920977nnn was checked against source literals and generated fixture ranges;
// GOLD-7a owns +5920971..0976, and this file alone owns +5920977.
const PHONE_PREFIX = '+5920977';
const FIXTURE = 'gold7-vend04-fixture';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const RATE_CARD_SMALL_VENDOR = 15_000;
const webhookSigning = randomBytes(24).toString('hex');
let app: FastifyInstance;
let subscriptions: SubscriptionService;
let worker: Awaited<ReturnType<typeof startGoldenWorker>> | undefined;
let seq = 0;
let clockStart = 0;
let foreignBefore = '';
let foreignIds: string[] = [];
let alertsBefore = new Set<string>();
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Partner = { owner: Actor; vendorId: string; subId: string; san: string };
let admin: Actor;

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
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) }, { expiresIn: '40d' });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `g7f-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + 40 * DAY) },
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
      ownerId: ownerRow.id, name: `${firstName} Kitchen`, slug: `gold7-fee-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
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
const noticesTo = async (userId: string) => (await sys(() => app.prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { title: true } }))).map((n) => n.title);

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
const agentPays = (san: string, amount: number, transactionId = `G7AC-${nanoid(10)}`, over: { ts?: number; sig?: string; unsigned?: boolean } = {}) =>
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
    // The synthetic stores own their clock evidence (RESTRICT in production): remove it first.
    await cleanupBillingClocks(app.prisma, subIds);
    const sessionIds = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    const imports = await app.prisma.settlementImport.findMany({ where: { source: { startsWith: 'gold7-vend04-' } }, select: { id: true } });
    await app.prisma.mmgAgentPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { externalId: { startsWith: 'G7AC-' } }] } });
    await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { startsWith: 'G7AC-' } }] } });
    await app.prisma.settlementImport.deleteMany({ where: { id: { in: imports.map((i) => i.id) } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...vendorIds, ...subIds, ...imports.map((i) => i.id)] } }] }, 'GOLD-7 golden journey fixture cleanup (gold-7-vend-04)');
    if (subIds.length > 0) {
      // A real dunning page reaches seeded admins too. Compare row IDs, so
      // no pre-existing alert is removed by timestamp proximity.
      const pages = await app.prisma.$queryRaw<Array<{ userId: string }>>`
        SELECT "userId" FROM "notifications"
        WHERE "data"->>'subscriptionId' IN (${Prisma.join(subIds)}) AND "data"->>'kind' = 'billing_dunning_ops_task'`;
      const alerts = await app.prisma.alertDelivery.findMany({
        where: { kind: 'ADMIN_OPS', subjectId: 'billing_dunning_ops_task', recipientId: { in: pages.map((p) => p.userId) } }, select: { id: true },
      });
      await app.prisma.alertDelivery.deleteMany({ where: { id: { in: alerts.filter((a) => !alertsBefore.has(a.id)).map((a) => a.id) } } });
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

function advanceTo(at: number) {
  expect(at).toBeGreaterThanOrEqual(clockStart);
  expect(at).toBeLessThanOrEqual(clockStart + 32 * DAY);
  vi.setSystemTime(at);
}

const tick = (name: 'convert-trials' | 'process-billing') => worker!.tick(name);

async function moneySnapshot(id: string) {
  return {
    balance: await wallet(id),
    events: (await eventsOf(id)).filter((e) => ['CHARGE_ATTEMPT', 'CHARGE_FAILED', 'CHARGE_SUCCESS', 'PREPAID_TOPUP', 'REINSTATED'].includes(e.type)).sort((a, b) => a.key.localeCompare(b.key)),
    payments: (await sys(() => app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: id }, select: { id: true, status: true, paymentMethod: true, amount: true }, orderBy: { id: 'asc' } })))
      .map((p) => ({ ...p, amount: Number(p.amount) })),
    receipts: (await sys(() => app.prisma.feeReceipt.findMany({ where: { subscriptionId: id }, select: { id: true, amount: true, channel: true, mmgRef: true }, orderBy: { id: 'asc' } })))
      .map((r) => ({ ...r, amount: Number(r.amount) })),
    books: (await ledgerFor(id)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

async function foreignSnapshot() {
  return JSON.stringify(await sys(async () => ({
    subscriptions: await foreignSubscriptions(),
    events: await app.prisma.billingEvent.findMany({ where: { subscriptionId: { in: foreignIds } }, orderBy: { id: 'asc' } }),
    wallets: await app.prisma.prepaidBalance.findMany({ where: { subscriptionId: { in: foreignIds } }, orderBy: { id: 'asc' } }),
    payments: await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: foreignIds } }, orderBy: { id: 'asc' } }),
    receipts: await app.prisma.feeReceipt.findMany({ where: { subscriptionId: { in: foreignIds } }, orderBy: { id: 'asc' } }),
  })));
}

const foreignSubscriptions = () => sys(() => app.prisma.subscription.findMany({
  where: { OR: [{ vendorId: null }, { vendor: { phone: { not: { startsWith: PHONE_PREFIX } } } }] }, orderBy: { id: 'asc' },
}));

beforeAll(async () => {
  vi.stubEnv('AGENT_CASH_WEBHOOK_SECRET', webhookSigning);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
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
  subscriptions = new SubscriptionService(app.prisma);
  // Preserve existing admin tracking even during crash-recovery cleanup.
  alertsBefore = new Set((await sys(() => app.prisma.alertDelivery.findMany({ where: { kind: 'ADMIN_OPS', subjectId: 'billing_dunning_ops_task' }, select: { id: true } }))).map((a) => a.id));
  await purgeFixtures();

  // Other suites can leave ownerless ACTIVE/PAST_DUE subscriptions when their
  // drivers are deleted. Preserve those rows too: put the whole story before
  // every foreign sweep deadline, including reminder/education lead times.
  // SUSPENDED is never safe: its nudge sweep has no lower date bound.
  const foreign = await foreignSubscriptions();
  expect(foreign.filter((s) => s.status === 'SUSPENDED').map((s) => s.status), 'foreign suspended rows would be nudged').toEqual([]);
  const foreignDeadlines = foreign.flatMap((s) => {
    if (s.status === 'TRIAL' && s.trialEndDate) return [s.trialEndDate.getTime() - 4 * DAY];
    if (s.status === 'ACTIVE') return [s.autoRenew ? s.nextBillingDate.getTime() - DAY : s.currentPeriodEnd.getTime()];
    if (s.status === 'PAST_DUE' && s.autoRenew && s.nextRetryAt) return [s.nextRetryAt.getTime()];
    // PAUSED/CANCELLED/CHURNED and undated trials/retries are ineligible.
    return [];
  });
  const earliest = Math.min(Date.now(), ...foreignDeadlines);
  clockStart = earliest - 60 * DAY;
  expect(foreignDeadlines.every((at) => at > clockStart + 32 * DAY)).toBe(true);
  foreignIds = foreign.map((s) => s.id);
  foreignBefore = await foreignSnapshot();
  const currency = await sys(() => app.prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } }));
  expect(currency?.usdPricingEnabled ?? false).toBe(false);
  expect(await sys(() => app.prisma.billingEvent.count({ where: { deliveredAt: null, note: { startsWith: '{"noticeVersion":1' } } }))).toBe(0);
  vi.useFakeTimers({ toFake: ['Date'] });
  advanceTo(clockStart);
  admin = await makeUser('Ama', ['ADMIN'], 'ADMIN', { admin: true });
  worker = await startGoldenWorker(app, 'subscription', 'gold7-vend04');
});

afterAll(async () => {
  const errors: unknown[] = [];
  const finish = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { errors.push(error); } };
  if (worker) await finish(() => worker!.close());
  if (app && foreignBefore) await finish(async () => { expect(await foreignSnapshot() === foreignBefore).toBe(true); });
  vi.useRealTimers();
  if (app) {
    await finish(() => purgeFixtures());
    await finish(() => app.close());
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, 'GOLD-7 worker fixture cleanup failed');
});

describe('GOLD-7 · VEND-04 — production worker billing journey', () => {
  it('bills the week, duns to suspension, accepts one agent receipt, reinstates, then stops at the paid period end without another charge', async () => {
    const p = await makePartner('Vera');
    const born = await subRow(p.subId);
    expect({ status: born.status, type: born.type, weeklyRate: Number(born.weeklyRate), billingMethod: born.billingMethod, currencyCode: born.currencyCode })
      .toEqual({ status: 'TRIAL', type: 'RESTAURANT', weeklyRate: RATE_CARD_SMALL_VENDOR, billingMethod: 'CASH', currencyCode: 'GYD' });
    expect(born.trialEndDate!.getTime()).toBe(clockStart + 14 * DAY);
    const headers = { 'x-vendor-id': p.vendorId };
    const screen = await call('GET', '/api/v1/vendor/subscription', p.owner.token, undefined, headers);
    expect(screen.statusCode, screen.body).toBe(200);
    expect(screen.json().data).toMatchObject({ status: 'TRIAL', san: p.san, amountDueGyd: RATE_CARD_SMALL_VENDOR });

    // The trial's own end and every retry clock pass; no lifecycle row is aged
    // by the fixture. The real worker composes conversion, billing and notices.
    advanceTo(born.trialEndDate!.getTime() + 1);
    await tick('convert-trials');
    const converted = await subRow(p.subId);
    // [#1393] The first fee is due at the trial's own end, not whenever the
    // conversion job happened to run.
    expect({ status: converted.status, isTrialActive: converted.isTrialActive, due: converted.nextBillingDate.getTime() })
      .toEqual({ status: 'ACTIVE', isTrialActive: false, due: born.trialEndDate!.getTime() });
    const period = converted.nextBillingDate;
    const periodKey = period.toISOString().slice(0, 10);
    const ladder = ['PAST_DUE', 'PAST_DUE', 'SUSPENDED'];
    for (const [i, status] of ladder.entries()) {
      if (i > 0) {
        const retry = (await subRow(p.subId)).nextRetryAt!.getTime();
        const before = await moneySnapshot(p.subId);
        advanceTo(retry - 1);
        await tick('process-billing');
        expect(await moneySnapshot(p.subId)).toEqual(before);
        advanceTo(retry);
      }
      await tick('process-billing');
      const row = await subRow(p.subId);
      expect({ status: row.status, failedAttempts: row.failedAttempts, due: row.nextBillingDate.getTime() })
        .toEqual({ status, failedAttempts: i + 1, due: period.getTime() });
      expect(row.nextRetryAt!.getTime()).toBe(Date.now() + DAY);
    }
    const notices = await noticesTo(p.owner.userId);
    for (const title of ['Subscription payment failed', 'Final warning — payment needed', 'Subscription suspended']) {
      expect(notices.filter((n) => n === title)).toHaveLength(1);
    }
    expect(await countEvents(p.subId, 'CHARGE_ATTEMPT')).toBe(3);
    expect(await countEvents(p.subId, 'CHARGE_FAILED')).toBe(3);
    expect(await countEvents(p.subId, 'SUSPENDED')).toBe(1);
    // [#1393] The reinstatement nudges run on the shared clock's active time:
    // the first comes one day after the suspension notice, never with it.
    const nudges = async () => (await eventsOf(p.subId)).filter((e) => e.key.startsWith(`nudge:${p.subId}:`));
    expect(await nudges()).toHaveLength(0);
    expect(notices.filter((n) => n === 'Subscription billing history')).toHaveLength(0);
    expect(await sys(() => app.prisma.notification.count({ where: { userId: admin.userId, title: 'Dunning — final warning issued', data: { path: ['subscriptionId'], equals: p.subId } } }))).toBe(1);
    expect(await vendorRow(p.vendorId)).toEqual({ status: 'SUSPENDED', acceptingOrders: false });
    const suspended = await moneySnapshot(p.subId);
    await tick('process-billing');
    expect(await moneySnapshot(p.subId)).toEqual(suspended);
    expect(await noticesTo(p.owner.userId)).toEqual(notices);
    expect(await nudges()).toHaveLength(0); // (the nudge cadence itself: billing-dunning-depth.test.ts)

    // The owner can still reach the payment screen. The agent's real signed
    // inquiry and receipt are the boundary; physical collection is excluded.
    const dueScreen = await call('GET', '/api/v1/vendor/subscription', p.owner.token, undefined, headers);
    expect(dueScreen.statusCode).toBe(200);
    expect(dueScreen.json().data).toMatchObject({ status: 'SUSPENDED', amountDueGyd: RATE_CARD_SMALL_VENDOR });
    const lookup = await inquiry(p.san);
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ valid: true, amountDueGyd: '15000.00', weeklyFeeGyd: '15000.00', currency: 'GYD' });
    const txn = `G7AC-${nanoid(10)}`;
    const paid = await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toEqual({ status: 'accepted' });
    const reinstated = await subRow(p.subId);
    const periodEnd = period.getTime() + WEEK;
    expect({ status: reinstated.status, attempts: reinstated.failedAttempts, suspendedAt: reinstated.suspendedAt, retry: reinstated.nextRetryAt, start: reinstated.currentPeriodStart.getTime(), end: reinstated.currentPeriodEnd.getTime(), due: reinstated.nextBillingDate.getTime() })
      .toEqual({ status: 'ACTIVE', attempts: 0, suspendedAt: null, retry: null, start: period.getTime(), end: periodEnd, due: periodEnd });
    expect(await vendorRow(p.vendorId)).toEqual({ status: 'ACTIVE', acceptingOrders: true });
    expect(await wallet(p.subId)).toBe(0);
    for (const [type, count] of [['CHARGE_ATTEMPT', 4], ['CHARGE_SUCCESS', 1], ['PREPAID_TOPUP', 1], ['REINSTATED', 1]] as const) {
      expect(await countEvents(p.subId, type)).toBe(count);
    }
    const posted = await moneySnapshot(p.subId);
    expect(posted.payments).toEqual([{ id: expect.any(String), status: 'CAPTURED', paymentMethod: 'CASH', amount: RATE_CARD_SMALL_VENDOR }]);
    expect(posted.receipts).toEqual([{ id: expect.any(String), amount: RATE_CARD_SMALL_VENDOR, channel: 'MMG_AGENT_WEBHOOK', mmgRef: `MMG agent payment ${txn}` }]);
    expect(posted.books).toHaveLength(2);
    expect(posted.books.find((b) => b.key === `ledger:success:${p.subId}:${periodKey}`)?.entries).toEqual([
      { account: 'FEE_REVENUE', debit: 0, credit: RATE_CARD_SMALL_VENDOR },
      { account: 'WALLET_LIABILITY', debit: RATE_CARD_SMALL_VENDOR, credit: 0 },
    ]);
    expect(posted.books.find((b) => b.key !== `ledger:success:${p.subId}:${periodKey}`)?.entries).toEqual([
      { account: 'CLEARING_MMG', debit: RATE_CARD_SMALL_VENDOR, credit: 0 },
      { account: 'WALLET_LIABILITY', debit: 0, credit: RATE_CARD_SMALL_VENDOR },
    ]);
    expect((await agentPays(p.san, RATE_CARD_SMALL_VENDOR, txn)).json()).toEqual({ status: 'duplicate' });
    expect(await agentRows(txn)).toEqual([{ channel: 'MMG_AGENT_WEBHOOK', status: 'MATCHED', failureCode: null, subscriptionId: p.subId }]);
    await tick('process-billing');
    expect(await moneySnapshot(p.subId)).toEqual(posted);

    // Stopping is idempotent and preserves the paid week. Only the production
    // process-billing composition can lapse it; a direct cycle call cannot.
    await grantStepUp(app, p.owner.token);
    for (let i = 0; i < 2; i += 1) {
      const stopped = await call('PUT', '/api/v1/vendor/subscription/billing-method', p.owner.token, { method: 'NONE' }, headers);
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(stopped.json().data).toEqual({ billingMethod: 'CASH', mmgPayerMsisdn: null });
    }
    expect((await subRow(p.subId)).autoRenew).toBe(false);
    expect((await eventsOf(p.subId)).filter((e) => e.key.startsWith(`stop:${p.subId}:`))).toHaveLength(1);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: p.subId, action: 'BILLING_STOPPED' } }))).toBe(1);
    advanceTo(periodEnd - 1);
    await tick('process-billing');
    expect((await subRow(p.subId)).status).toBe('ACTIVE');
    expect(await moneySnapshot(p.subId)).toEqual(posted);
    advanceTo(periodEnd + 1);
    await tick('process-billing');
    const paused = await subRow(p.subId);
    expect({ status: paused.status, autoRenew: paused.autoRenew, retry: paused.nextRetryAt }).toEqual({ status: 'PAUSED', autoRenew: false, retry: null });
    advanceTo(periodEnd + WEEK + 1);
    await tick('process-billing');
    expect((await subRow(p.subId)).status).toBe('PAUSED');
    expect((await eventsOf(p.subId)).filter((e) => e.key.startsWith(`pause:${p.subId}:`))).toHaveLength(1);
    expect(await moneySnapshot(p.subId)).toEqual(posted);
    expect(await foreignSnapshot() === foreignBefore).toBe(true);
  }, 120_000);
});
