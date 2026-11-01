/**
 * [TENANT-WALL · 1 Nov 2026] The MMG agent-cash callbacks work under
 * production's CONTRACT tenant posture (for the day the channel is switched on:
 * it answers 503 until its secret is configured).
 *
 * POST /api/v1/billing/mmg/agent-notification and /inquiry are called by MMG,
 * signed with a shared secret, without a session, so nothing binds a tenant.
 * Under the posture (the app's own client on a least-privilege login that does
 * not bypass row security, system work on its own bypass-member login,
 * TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny) every read and write of
 * the channel was refused (TENANT_CONTEXT_REQUIRED): a notification answered
 * 500 and the money an agent had already taken was not recorded.
 *
 * Measured here (coordinator ruling #7, 1 Nov 2026), through the app's own
 * client on a per-suite walled login, with production's credit hold on:
 *  (a) a notification for a known account is recorded in the operator that
 *      OWNS the account (a released number: the operator it was retired in);
 *  (b) an unknown or malformed account number is STILL recorded, as
 *      unmatched, in the operator that owns the biller channel (the public
 *      operator, never a fixed id) and answered 200 received_unmatched; when
 *      no single operator can be named the raw row is still written and
 *      operations are paged;
 *  (c) an inquiry answers in the owning operator, and an unknown number is
 *      valid:false; inquiries write nothing;
 *  and, unchanged: a replay is a duplicate, a bad signature is 401, a channel
 *  with no secret is 503, and the wall still binds the app.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'AGENT_CASH_WEBHOOK_SECRET', 'BILLING_TOPUP_HOLD', 'PUBLIC_TENANT_ID'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
const SECRET = `tenant-wall-agent-cash-${RUN}`;
/** The store's operator, and the operator that owns the biller channel (the public operator). */
const STORE_OPERATOR = `acwall-s-${RUN}`;
const BILLER_OPERATOR = `acwall-b-${RUN}`;
const DAY = 86_400_000;

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let routesModule: typeof import('../modules/billing/agent-cash.routes');

const userIds: string[] = [];
const subIds: string[] = [];
const externalIds: string[] = [];
const ids = { vendorOwner: '', vendor: '', retiredVendor: '' };
let san = '';
let retiredSan = '';
let unknownSan = '';

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['AGENT_CASH_WEBHOOK_SECRET'] = SECRET;
  // Production's posture: no fee is credited by agent; the money is recorded and held for a person.
  process.env['BILLING_TOPUP_HOLD'] = '1';
  process.env['PUBLIC_TENANT_ID'] = BILLER_OPERATOR;
  const { ensureSan, releaseSan } = await import('../modules/billing/san.service');
  const { generateSan } = await import('../modules/billing/san');

  for (const id of [STORE_OPERATOR, BILLER_OPERATOR]) await owner.tenant.create({ data: { id, name: 'Agent cash wall tenant', slug: id, isActive: true } });
  const storeOwner = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Shanta', lastName: `Wall${RUN}`, tenantId: STORE_OPERATOR, isPhoneVerified: true,
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
  } });
  userIds.push(storeOwner.id);
  ids.vendorOwner = (await owner.vendorOwner.create({ data: { userId: storeOwner.id } })).id;
  const store = async (name: string) => (await owner.vendor.create({ data: {
    tenantId: STORE_OPERATOR, ownerId: ids.vendorOwner, name, slug: `acwall-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: testPhone(), addressLine1: '9 Inquiry St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', isVerified: true,
  } })).id;
  const subscription = async (vendorId: string) => {
    const sub = await owner.subscription.create({ data: {
      vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
    } });
    subIds.push(sub.id);
    return { id: sub.id, san: await ensureSan(owner, sub.id) };
  };
  ids.vendor = await store(`Shanta Kitchen ${RUN}`);
  san = (await subscription(ids.vendor)).san;
  ids.retiredVendor = await store(`Retired Kitchen ${RUN}`);
  const retired = await subscription(ids.retiredVendor);
  retiredSan = retired.san;
  await releaseSan(owner, retired.id, 'test-tenant-wall');
  do { unknownSan = generateSan(); } while (await owner.subscription.findUnique({ where: { san: unknownSan } }) || await owner.sanTombstone.findUnique({ where: { san: unknownSan } }));

  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  routesModule = await import('../modules/billing/agent-cash.routes');
  const { redisPlugin } = await import('../plugins/redis');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(routesModule.agentCashRoutes, { prefix: '/api/v1/billing/mmg' });
  await app.ready();
  await app.redis.del('ops_page:agent-cash-unattributed');
}, 120_000);

afterAll(async () => {
  try {
    await app?.redis.del('ops_page:agent-cash-unattributed').catch(() => {});
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    const payments = await owner.mmgAgentPayment.findMany({ where: { externalId: { in: externalIds } }, select: { id: true, providerPaymentId: true } });
    await owner.mmgAgentPayment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
    await owner.providerPayment.deleteMany({ where: { id: { in: payments.map((p) => p.providerPaymentId).filter((x): x is string => !!x) } } }).catch(() => {});
    const pages = await owner.opsAlert.findMany({ where: { kind: 'PLATFORM', title: routesModule?.AGENT_CASH_UNATTRIBUTED_PAGE_TITLE ?? '-' }, select: { id: true } });
    await owner.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: pages.map((p) => p.id) } } });
    await owner.opsAlert.deleteMany({ where: { id: { in: pages.map((p) => p.id) } } });
    await owner.sanTombstone.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await owner.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await owner.subscription.deleteMany({ where: { id: { in: subIds } } });
    await owner.vendor.deleteMany({ where: { id: { in: [ids.vendor, ids.retiredVendor].filter(Boolean) } } });
    if (ids.vendorOwner) await owner.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: { in: [STORE_OPERATOR, BILLER_OPERATOR] } } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

function signed(body: unknown, sig?: string) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  return {
    method: 'POST' as const,
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-swift-timestamp': String(ts), 'x-swift-signature': sig ?? createHmac('sha256', SECRET).update(`${ts}.`).update(Buffer.from(raw)).digest('hex') },
  };
}
const notification = (accountNumber: string, transactionId = `ACW-${RUN}-${nanoid(8)}`) => {
  externalIds.push(transactionId);
  return { transactionId, accountNumber, amount: 2100, currency: 'GYD' };
};
const notify = (body: unknown, sig?: string) => app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(body, sig) });
const inquire = (accountNumber: string) => app.inject({ url: '/api/v1/billing/mmg/inquiry', ...signed({ accountNumber }) });
const recorded = (transactionId: string) => owner.mmgAgentPayment.findMany({
  where: { channel: 'MMG_AGENT_WEBHOOK', externalId: transactionId }, select: { tenantId: true, status: true, failureCode: true },
});

/** System reads by model and capability, from the wall's own counter. */
async function systemReads(): Promise<Map<string, number>> {
  const { tenantUnscopedAccessCounter } = await import('../plugins/observability');
  const out = new Map<string, number>();
  for (const v of (await tenantUnscopedAccessCounter.get()).values) {
    if (v.labels['mode'] !== 'system') continue;
    const key = `${v.labels['capability']}|${v.labels['model']}.${v.labels['operation']}`;
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}
const grewBy = (before: Map<string, number>, after: Map<string, number>) => [...after].filter(([key, n]) => n !== (before.get(key) ?? 0)).map(([key]) => key);

describe('[TENANT-WALL] the MMG agent-cash callbacks under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('(a) a payment for a known account is recorded in the operator that owns the account (held for a person, as production holds it)', async () => {
    const body = notification(san);
    const before = await systemReads();
    const res = await notify(body);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.json()).toEqual({ status: 'received_unmatched' });
    expect(await recorded(body.transactionId)).toEqual([{ tenantId: STORE_OPERATOR, status: 'UNMATCHED', failureCode: 'TOPUP_ON_HOLD' }]);
    // the only system work is the owner lookup under its own capability (it reads no tenant table as system work)
    expect(grewBy(before, await systemReads()).filter((key) => !key.startsWith(`${routesModule.AGENT_CASH_CALLBACK_CAPABILITY}|`))).toEqual([]);
  });

  it('(a) a payment for a released number is recorded in the operator it was retired in', async () => {
    const body = notification(retiredSan);
    const res = await notify(body);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.json()).toEqual({ status: 'received_unmatched' });
    expect(await recorded(body.transactionId)).toEqual([{ tenantId: STORE_OPERATOR, status: 'UNMATCHED', failureCode: 'TOMBSTONED' }]);
  });

  it('(b) an unknown or a malformed account number is STILL recorded, as unmatched, in the biller channel’s operator', async () => {
    for (const [accountNumber, code] of [[unknownSan, 'SAN_UNKNOWN'], ['12-34', null]] as const) {
      const body = notification(accountNumber);
      const res = await notify(body);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.json()).toEqual({ status: 'received_unmatched' });
      const rows = await recorded(body.transactionId);
      expect(rows.map((r) => [r.tenantId, r.status]), accountNumber).toEqual([[BILLER_OPERATOR, 'UNMATCHED']]);
      if (code) expect(rows[0]!.failureCode).toBe(code); else expect(rows[0]!.failureCode).toBeTruthy();
    }
  });

  it('(b) when no single operator can be named, the raw row is still written and operations are paged', async () => {
    process.env['PUBLIC_TENANT_ID'] = `missing-${RUN}`;
    try {
      const body = notification(unknownSan);
      const res = await notify(body);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.json()).toEqual({ status: 'received_unmatched' });
      const rows = await recorded(body.transactionId);
      expect(rows.map((r) => [r.status, r.failureCode])).toEqual([['UNMATCHED', 'SAN_UNKNOWN']]);
      const pages = await owner.opsAlert.findMany({ where: { kind: 'PLATFORM', title: routesModule.AGENT_CASH_UNATTRIBUTED_PAGE_TITLE, closedAt: null }, select: { tenantId: true, body: true } });
      expect(pages).toHaveLength(1);
      expect(pages[0]!.tenantId).toBeNull();
      expect(pages[0]!.body).not.toContain(unknownSan);
    } finally {
      process.env['PUBLIC_TENANT_ID'] = BILLER_OPERATOR;
    }
  });

  it('a replay is a duplicate and records nothing twice; a bad signature is 401 and records nothing; no secret is 503', async () => {
    const body = notification(san);
    expect((await notify(body)).json()).toEqual({ status: 'received_unmatched' });
    expect((await notify(body)).json()).toEqual({ status: 'duplicate' });
    expect(await recorded(body.transactionId)).toHaveLength(1);
    const forged = notification(san);
    expect((await notify(forged, '0'.repeat(64))).statusCode).toBe(401);
    expect(await recorded(forged.transactionId)).toHaveLength(0);
    process.env['AGENT_CASH_WEBHOOK_SECRET'] = '';
    try {
      expect((await notify(notification(san))).statusCode).toBe(503);
    } finally {
      process.env['AGENT_CASH_WEBHOOK_SECRET'] = SECRET;
    }
  });

  it('(c) an inquiry answers in the owning operator; an unknown, released or malformed number is not valid; inquiries write nothing', async () => {
    const before = await owner.mmgAgentPayment.count();
    const known = await inquire(san);
    expect(known.statusCode, known.body.slice(0, 300)).toBe(200);
    expect(known.json()).toMatchObject({ valid: true, amountDueGyd: '2100.00', weeklyFeeGyd: '2100.00', currency: 'GYD' });
    expect(known.json().displayName).not.toBe(`Shanta Kitchen ${RUN}`);
    expect((await inquire(unknownSan)).json()).toEqual({ valid: false, reason: 'SAN_UNKNOWN' });
    expect((await inquire(retiredSan)).json()).toEqual({ valid: false, reason: 'TOMBSTONED' });
    expect((await inquire('12-34')).json()).toMatchObject({ valid: false });
    expect(await owner.mmgAgentPayment.count()).toBe(before);
  });
});
