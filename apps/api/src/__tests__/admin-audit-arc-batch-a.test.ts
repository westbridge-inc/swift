import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { enableModeB } from '../modules/billing/usd-migration';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { refusalName, refuseAuditWhere, allowAuditAgain, dropAuditRefusal } from './helpers/audit-refusal';

// ---------------------------------------------------------------------------
// [ADM-002] ARC BATCH A — the transaction-owning helpers take the audit in.
//
// promo terms (update, rollback) · bank reconciliation (confirm, adjust) ·
// the USD migration's mode flip (enable, rollback). Each helper already owned
// a `$transaction`; each now invokes `onAudit` as its last statement, and the
// route supplies `auditWithin`. The bank-reconciliation helpers used to write
// a hand-rolled audit row of their own INSIDE the transaction — and the hook
// then wrote a second one after the response. One row now, the canonical one.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REFUSAL = refusalName('arca');
const userIds: string[] = [];
const batchIds: string[] = [];
let promoId = '';
let token = '';
let billingCurrencyBefore: { usdMigrationMode: string | null; usdSunsetAt: Date | null } | null | undefined;
const REASON = 'Quarter-end terms review, finance ticket GY-7001';
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

const rowsFor = (entityId: string) => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { userId: userIds[0]!, entityId }, orderBy: { createdAt: 'asc' } }), 'read');
const changesOf = (row: { changes: unknown }) => row.changes as Record<string, unknown>;
const changedOf = (row: { changes: unknown }) => (changesOf(row)['changed'] ?? {}) as Record<string, { from: unknown; to: unknown }>;

async function newBatch() {
  const b = await app.prisma.settlementBatch.create({ data: {
    tenantId: 'swift-default', provider: 'MMG', periodStart: new Date(Date.now() - 7 * 86_400_000), periodEnd: new Date(),
    grossGyd: 10000, expectedNetGyd: 10000, status: 'EXPECTED' } });
  batchIds.push(b.id);
  return b;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59273${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'ArcA', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'arca', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const created = await call('POST', '/api/v1/admin/promos', {
    code: `ARCA${RUN}`.toUpperCase(), description: 'arc batch a promo', discountType: 'PERCENTAGE', discountValue: 15,
    validFrom: iso(-1), validUntil: iso(30), maxUsesPerUser: 5 });
  if (created.statusCode !== 200) throw new Error(`promo fixture: ${created.statusCode} ${created.body}`);
  promoId = (JSON.parse(created.body) as { data: { id: string } }).data.id;
  const bc = await runWithoutTenant(() => app.prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' }, select: { usdMigrationMode: true, usdSunsetAt: true } }), 'arca');
  billingCurrencyBefore = bc ?? null;
});

afterAll(async () => {
  await dropAuditRefusal(app, REFUSAL);
  await runWithoutTenant(async () => {
    if (billingCurrencyBefore) {
      await app.prisma.tenantBillingCurrency.updateMany({ where: { tenantId: 'swift-default' }, data: billingCurrencyBefore }).catch(() => {});
    }
    await app.prisma.tenantBillingCurrency.deleteMany({ where: { tenantId: `t_${RUN}` } }).catch(() => {});
  }, 'arca');
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.depositConfirmation.deleteMany({ where: { batchId: { in: batchIds } } }).catch(() => {});
    await app.prisma.settlementBatch.deleteMany({ where: { id: { in: batchIds } } }).catch(() => {});
    if (promoId) {
      await app.prisma.promoTerms.deleteMany({ where: { promoCodeId: promoId } }).catch(() => {});
      await app.prisma.promoCode.deleteMany({ where: { id: promoId } }).catch(() => {});
    }
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'arca').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'arca').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'arca');
  await app.close();
});

describe('[ADM-002] promo terms take the audit into their transaction', () => {
  it('an update records the new terms as a diff and the version as a fact; the body-spreading legacy row is gone', async () => {
    const res = await call('PUT', `/api/v1/admin/promos/${promoId}`, { discountValue: 20 });
    expect(res.statusCode, res.body).toBe(200);
    const rows = (await rowsFor(promoId)).filter((r) => r.action.startsWith('ADMIN PUT'));
    expect(rows.length).toBe(1);
    expect(changesOf(rows[0]!)['termsVersion']).toBe(2);
    expect(String(changedOf(rows[0]!)['discountValue']?.to)).toMatch(/^20(\.0+)?$/);
    expect((await rowsFor(promoId)).some((r) => r.action === 'UPDATE_PROMO'), 'legacy row retired').toBe(false);
  });

  it("a refused audit rolls the helper's write back — terms and version", async () => {
    const versions = await app.prisma.promoTerms.count({ where: { promoCodeId: promoId } });
    await refuseAuditWhere(app, REFUSAL, { entityId: promoId });
    try {
      const res = await call('PUT', `/api/v1/admin/promos/${promoId}`, { discountValue: 25 });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    const promo = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promoId } });
    expect(Number(promo.discountValue)).toBe(20);
    expect(await app.prisma.promoTerms.count({ where: { promoCodeId: promoId } })).toBe(versions);
  });

  it('a rollback records what it restored from', async () => {
    const res = await call('POST', `/api/v1/admin/promos/${promoId}/rollback`, {});
    expect(res.statusCode, res.body).toBe(200);
    const rows = (await rowsFor(promoId)).filter((r) => r.action.startsWith('ADMIN POST') && r.action.endsWith('/rollback'));
    expect(rows.length).toBe(1);
    expect(changesOf(rows[0]!)['rollback']).toBe(true);
    expect(changesOf(rows[0]!)['restoredFrom']).toBe(1);
    expect(changesOf(rows[0]!)['termsVersion']).toBe(3);
  });
});

describe('[ADM-002] bank reconciliation: one canonical row, in the transaction', () => {
  it('confirming a deposit writes exactly ONE audit row — the diff carries the deposit, the fact carries the confirmation id', async () => {
    const batch = await newBatch();
    const res = await call('POST', `/api/v1/admin/billing/settlement-batches/${batch.id}/confirm-deposit`, {
      depositedGyd: 10000, depositedAt: iso(0), bankRef: `GBTI-${RUN}-1` });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(batch.id);
    expect(rows.length, 'no hand-rolled CONFIRM_DEPOSIT duplicate, no backstop double').toBe(1);
    expect(rows[0]!.action).toMatch(/^ADMIN POST /);
    expect(changedOf(rows[0]!)['status']?.to).toBe('DEPOSITED');
    expect(changedOf(rows[0]!)['bankRef']?.to).toBe(`GBTI-${RUN}-1`);
    expect(typeof changesOf(rows[0]!)['confirmationId']).toBe('string');
    expect(changesOf(rows[0]!)['reason']).toBe(REASON);
  });

  it('a refused audit leaves the batch EXPECTED with no confirmation row', async () => {
    const batch = await newBatch();
    await refuseAuditWhere(app, REFUSAL, { entityId: batch.id });
    try {
      const res = await call('POST', `/api/v1/admin/billing/settlement-batches/${batch.id}/confirm-deposit`, {
        depositedGyd: 10000, depositedAt: iso(0), bankRef: `GBTI-${RUN}-2` });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect((await app.prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('EXPECTED');
    expect(await app.prisma.depositConfirmation.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it('an adjustment names the confirmation it supersedes, in one row', async () => {
    const batch = await newBatch();
    expect((await call('POST', `/api/v1/admin/billing/settlement-batches/${batch.id}/confirm-deposit`, {
      depositedGyd: 10000, depositedAt: iso(0), bankRef: `GBTI-${RUN}-3` })).statusCode).toBe(200);
    const res = await call('POST', `/api/v1/admin/billing/settlement-batches/${batch.id}/adjust-deposit`, {
      depositedGyd: 9990, depositedAt: iso(0), bankRef: `GBTI-${RUN}-3A`, reason: 'bank fee netted by the branch' });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(batch.id);
    expect(rows.length, 'one row per action, none hand-rolled').toBe(2);
    const adj = changesOf(rows[1]!);
    expect(typeof adj['adjustmentId']).toBe('string');
    expect(typeof adj['supersedesId']).toBe('string');
  });
});

describe('[ADM-002] the USD migration mode flip commits with its audit', () => {
  it('enableModeB: a refused audit rolls the mode flip back (helper level, throwaway tenant)', async () => {
    // `tenantBillingCurrency` is tenant-scoped: outside a request the extension
    // pins reads and writes to the default tenant, so a throwaway tenant id is
    // only honoured in system mode. Without this, the test would have flipped
    // swift-default's migration mode under every other suite.
    await runWithoutTenant(async () => {
      const tenantId = `t_${RUN}`;
      await expect(enableModeB(app.prisma, new Date(Date.now() + 45 * 86_400_000), tenantId, async () => { throw new Error('injected'); }))
        .rejects.toThrow('injected');
      expect(await app.prisma.tenantBillingCurrency.findUnique({ where: { tenantId } }), 'the upsert did not commit').toBeNull();
      await enableModeB(app.prisma, new Date(Date.now() + 45 * 86_400_000), tenantId, async () => undefined);
      expect((await app.prisma.tenantBillingCurrency.findUniqueOrThrow({ where: { tenantId } })).usdMigrationMode).toBe('B');
    }, 'arca');
  });

  it('the rollback route records the tenant and what it restored', async () => {
    const res = await call('POST', '/api/v1/admin/billing/usd-migration/mode-b/rollback', {});
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor('swift-default');
    expect(rows.length).toBe(1);
    expect(changesOf(rows[0]!)['rollback']).toBe(true);
    expect(typeof changesOf(rows[0]!)['restored']).toBe('number');
    expect(rows.some((r) => r.action === 'USD_MIGRATION_ROLLBACK'), 'legacy row retired').toBe(false);
  });
});
