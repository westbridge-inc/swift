import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerErrorHandler } from '../../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { ensureSan } from '../../modules/billing/san.service';
import { AgentCashService } from '../../modules/billing/agent-cash.service';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';

// ---------------------------------------------------------------------------
// GOLD-5 · ADMIN-04 — the MMG settlement file, through the REAL mounted admin
// routes as real sessions, asserted on the money it moves:
//
//   · STAGED, then PROCESSED: the file is validated whole and staged; staging
//     it is a C4 money action — a stated reason and a SECOND admin (the
//     requester's own approval refused, another tenant's admin cannot decide
//     it); the approved re-issue publishes once, crediting every row exactly:
//     wallet, billing events, receipts, balanced ledger, provider identities
//   · DUPLICATE: the same file is the same import and moves nothing; a new
//     file that repeats a credited transaction credits only its new row
//   · ROLLBACK: a file whose control total disagrees is rejected WHOLE — zero
//     credits — and ops is paged; the corrected file recovers every row once
//   · HOLD and RELEASE: with publication held the file is staged and
//     validated but credits nothing; lifted, the same file publishes once
//   · the wrong parties — a non-admin, a reasonless call — change nothing
//   · G5-F6 [it.fails] a publication that dies mid-file is stuck PUBLISHING
//     for ever: a retry answers "replayed, every row a duplicate" while a row
//     was never credited, and the nightly scan does not see it
//
// The subscription and its Swift Account Number are fixtures (ensureSan is the
// production minting function); activation is its own journey. Credits leave
// double-entry ledger rows, which the database refuses to delete by design
// (deny_ledger_mutation) — reported, like audit_chain.
//
// Fixture range: +5920356nnn (this file only; audited range-aware).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920356';
const FIXTURE = 'gold5-admin-finance-fixture';
const TENANT_SLUG_PREFIX = 'gold5-finance-';
const TENANT_B = `${TENANT_SLUG_PREFIX}${nanoid(6).toLowerCase()}`;
const SOURCE_PREFIX = `gold5-finance-${nanoid(6).toLowerCase()}`;
const REASON = { 'x-swift-reason': 'GOLD-5 golden journey: importing the MMG settlement file' };
const HEADER = 'transaction_id,account_number,amount,paid_at';

let app: FastifyInstance;
let seq = 0;
let windowStart: Date | null = null;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const sources: string[] = [];
const txnIds: string[] = [];

type Actor = { userId: string; token: string; phone: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; admin?: boolean; firstName?: string } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone, firstName: opts.firstName ?? 'Gold5', lastName: `Fin${seq}`, roles, activeRole,
      tenantId: opts.tenantId ?? 'swift-default',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `gold5-fin-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, phone };
}

/** A partner store on an active weekly plan with its Swift Account Number. */
async function makeSubscriber(name: string) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `gold5-fin-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: owner.phone, addressLine1: '1 Golden Ledger Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.80131, longitude: -58.15512, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  }));
  const sub = await sys(() => app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
    },
  }));
  const san = await sys(() => ensureSan(app.prisma, sub.id));
  return { owner, vendorId: vendor.id, subscriptionId: sub.id, san };
}

const txn = () => {
  const id = `G5TXN-${nanoid(10).replace(/[^A-Za-z0-9]/g, 'Q').toUpperCase()}`;
  txnIds.push(id);
  return id;
};
const source = (label: string) => {
  const s = `${SOURCE_PREFIX}-${label}`;
  sources.push(s);
  return s;
};
const csvOf = (rows: Array<[string, string, number]>, trailer?: { total?: number; count?: number }) => [
  HEADER,
  ...rows.map(([id, san, amount], i) => `${id},${san},${amount},2026-09-01T1${i}:00:00Z`),
  ...(trailer?.total !== undefined ? [`TOTAL,${trailer.total}`] : []),
  ...(trailer?.count !== undefined ? [`ROWCOUNT,${trailer.count}`] : []),
].join('\n');

function admin(options: InjectOptions & { token: string }) {
  const { token, headers, ...rest } = options;
  return app.inject({ ...rest, headers: { ...(headers as Record<string, string> | undefined), ...REASON, authorization: `Bearer ${token}` } });
}

/** Ask, approve as a DIFFERENT admin (the requester's own attempt refused),
 *  and re-issue carrying the approval. */
async function withApproval(requester: Actor, approver: Actor, options: InjectOptions): Promise<{ res: LightMyRequestResponse; approvalId: string }> {
  const ask = await admin({ ...options, token: requester.token });
  expect(ask.statusCode, ask.body).toBe(202);
  expect(ask.json().error.code).toBe('APPROVAL_REQUIRED');
  const approvalId = ask.json().error.details.approvalId as string;
  const self = await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: requester.token, payload: { approve: true } });
  expect(self.statusCode).toBe(403);
  const decided = await admin({ method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`, token: approver.token, payload: { approve: true, note: 'Totals checked against the MMG statement' } });
  expect(decided.statusCode, decided.body).toBe(200);
  const done = await admin({ ...options, token: requester.token, headers: { ...(options.headers as Record<string, string> | undefined), 'x-swift-approval': approvalId } });
  return { res: done, approvalId };
}

const importFile = (csv: string, src: string) => ({ method: 'POST' as const, url: '/api/v1/admin/billing/settlement-import', payload: { csv, source: src } });

/** Every trace of money on one subscription, as the books hold it. */
async function money(subscriptionId: string) {
  return sys(async () => {
    const wallet = await app.prisma.prepaidBalance.findUnique({ where: { subscriptionId } });
    const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, orderBy: { amount: 'asc' } });
    const ledger = await app.prisma.ledgerTransaction.findMany({ where: { idempotencyKey: { in: events.map((e) => `ledger:${e.idempotencyKey}`) } }, include: { entries: true } });
    const receipts = await app.prisma.feeReceipt.count({ where: { subscriptionId } });
    const observations = await app.prisma.mmgAgentPayment.findMany({ where: { subscriptionId, channel: 'MMG_SETTLEMENT_FILE' }, select: { externalId: true, status: true } });
    return {
      balance: Number(wallet?.balance ?? 0),
      topups: events.map((e) => Number(e.amount)),
      receipts,
      ledger: ledger.length,
      ledgerBalanced: ledger.every((t) => {
        const debit = t.entries.reduce((s, e) => s + Number(e.debit), 0);
        const credit = t.entries.reduce((s, e) => s + Number(e.credit), 0);
        return Math.abs(debit - credit) < 0.001;
      }),
      credited: observations.filter((o) => o.status === 'MATCHED').map((o) => o.externalId).sort(),
    };
  });
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
    const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
    const subIds = (await app.prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((s) => s.id);
    const imports = await app.prisma.settlementImport.findMany({ where: { source: { startsWith: 'gold5-finance-' } }, select: { id: true } });
    if (ids.length > 0) {
      await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
      await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...imports.map((i) => i.id)] } }] }, 'test-cleanup:gold-5-admin-finance fixtures');
      await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: ids } }, 'test-cleanup:gold-5-admin-finance fixture reads');
    }
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.mmgAgentPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { externalId: { startsWith: 'G5TXN-' } }] } });
    await app.prisma.providerPayment.deleteMany({ where: { providerTxnId: { startsWith: 'G5TXN-' } } });
    await app.prisma.settlementImport.deleteMany({ where: { id: { in: imports.map((i) => i.id) } } });
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'source' LIKE 'gold5-finance-%'`;
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }); // wallet and billing events cascade
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.tenant.deleteMany({ where: { slug: { startsWith: TENANT_SLUG_PREFIX } } });
  });
}

/** Admin audit and sensitive-read rows are written in onResponse hooks, which
 *  can land just after a response resolves: sweep them once more by the ids
 *  this file created, after a moment, so the last request cannot outrun the
 *  purge. */
async function sweepLateAuditRows(ids: string[], reason: string) {
  if (ids.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sys(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] }, reason);
    await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: ids } }, { subjectId: { in: ids } }] }, reason);
  });
}

let redisKeysBefore = new Set<string>();
async function allRedisKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const k of batch) keys.add(k);
  } while (cursor !== '0');
  return keys;
}

async function fixtureIds(): Promise<string[]> {
  return sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const imports = await app.prisma.settlementImport.findMany({ where: { source: { startsWith: 'gold5-finance-' } }, select: { id: true } });
    return [...users.map((u) => u.id), ...imports.map((i) => i.id)];
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purgeFixtures();
  const dbNow = (await app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0]!.now;
  windowStart = new Date(Math.min(dbNow.getTime(), Date.now()) - 2_000);
  redisKeysBefore = await allRedisKeys();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Gold5 Finance Tenant B', slug: TENANT_B } }));
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  const owned = await fixtureIds();
  await purgeFixtures();
  await sweepLateAuditRows(owned, 'test-cleanup:gold-5-finance late audit rows');
  if (windowStart) {
    await sys(() => app.prisma.alertDelivery.deleteMany({ where: { kind: 'ADMIN_OPS', subjectId: 'settlement_trailer_mismatch', sentAt: { gte: windowStart! } } }));
  }
  const now = await allRedisKeys();
  const added = [...now].filter((k) => !redisKeysBefore.has(k));
  if (added.length > 0) await app.redis.del(...added);
  await app.close();
}, 60_000);

describe('GOLD-5 · ADMIN-04 — the settlement file: staged, processed, duplicate, rollback', () => {
  let ops: Actor;
  let approver: Actor;
  let opsB: Actor;
  let clerk: Actor;
  let store: Awaited<ReturnType<typeof makeSubscriber>>;
  let good = '';
  let goodSource = '';
  let t1 = '';
  let t2 = '';
  let t3 = '';
  let t4 = '';
  let t5 = '';
  let importId = '';

  beforeAll(async () => {
    ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Odessa' });
    approver = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Aldo' });
    opsB = await makeUser(['ADMIN'], 'ADMIN', { admin: true, tenantId: TENANT_B, firstName: 'Bina' });
    clerk = await makeUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Kemal' });
    store = await makeSubscriber('Gold5 Ledger Kitchen');
    t1 = txn();
    t2 = txn();
    good = csvOf([[t1, store.san, 2100], [t2, store.san, 1000]], { total: 3100, count: 2 });
    goodSource = source('good');
  }, 60_000);

  it('STAGED then PROCESSED: two people, then every row credited exactly once — wallet, events, receipts, balanced ledger', async () => {
    // Staging is a money action: it waits for a second admin and moves nothing meanwhile.
    const ask = await admin({ ...importFile(good, goodSource), token: ops.token });
    expect(ask.statusCode).toBe(202);
    const pendingId = ask.json().error.details.approvalId as string;
    expect(await sys(() => app.prisma.settlementImport.count({ where: { source: goodSource } }))).toBe(0);
    expect(await money(store.subscriptionId)).toEqual({ balance: 0, topups: [], receipts: 0, ledger: 0, ledgerBalanced: true, credited: [] });
    // Another tenant's admin cannot be the second person; the requester cannot either.
    expect((await admin({ method: 'POST', url: `/api/v1/admin/approvals/${pendingId}/decide`, token: opsB.token, payload: { approve: true } })).statusCode).toBe(404);
    expect((await admin({ method: 'POST', url: `/api/v1/admin/approvals/${pendingId}/decide`, token: ops.token, payload: { approve: true } })).statusCode).toBe(403);
    const approval = await sys(() => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: pendingId } }));
    expect({ status: approval.status, action: approval.action, cls: approval.cls, capability: approval.capability, by: approval.requestedBy })
      .toEqual({ status: 'PENDING', action: 'POST /billing/settlement-import', cls: 'C4', capability: 'billing.settlement.import', by: ops.userId });
    await admin({ method: 'POST', url: `/api/v1/admin/approvals/${pendingId}/decide`, token: approver.token, payload: { approve: false, note: 'Resubmit after the statement arrives' } });

    const publishAt = Date.now();
    const published = await withApproval(ops, approver, importFile(good, goodSource));
    expect(published.res.statusCode, published.res.body).toBe(200);
    const report = published.res.json().data;
    importId = report.importId;
    expect(report).toEqual({
      importId, status: 'PUBLISHED', fileHash: report.fileHash, fileRows: 2, credited: 2, reconciled: 0, duplicates: 0, unmatched: 0,
      rejectedRows: [], totalGyd: 3100, trailerTotalGyd: 3100, trailerMismatch: false, replayed: false,
    });
    const staged = await sys(() => app.prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } }));
    expect({ status: staged.status, rows: staged.rowCount, computed: Number(staged.computedTotal), control: Number(staged.controlTotal), credited: staged.credited, source: staged.source })
      .toEqual({ status: 'PUBLISHED', rows: 2, computed: 3100, control: 3100, credited: 2, source: goodSource });
    expect(staged.publishedAt!.getTime()).toBeGreaterThanOrEqual(publishAt - 1_000);
    expect(staged.publishedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect((staged.results as Array<{ txnId: string; status: string }>).map((r) => [r.txnId, r.status])).toEqual([[t1, 'accepted'], [t2, 'accepted']]);

    expect(await money(store.subscriptionId)).toEqual({ balance: 3100, topups: [1000, 2100], receipts: 2, ledger: 2, ledgerBalanced: true, credited: [t1, t2].sort() });
    const identities = await sys(() => app.prisma.providerPayment.findMany({ where: { providerTxnId: { in: [t1, t2] } }, select: { providerTxnId: true, status: true, subscriptionId: true } }));
    expect(identities.map((p) => ({ id: p.providerTxnId, status: p.status, sub: p.subscriptionId })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([t1, t2].sort().map((id) => ({ id, status: 'CREDITED', sub: store.subscriptionId })));
    // The act and its reason are on the record, once.
    const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: importId } }));
    expect(trail.map((t) => ({ by: t.userId, reason: (t.changes as Record<string, unknown>)['reason'], status: (t.changes as Record<string, unknown>)['status'] })))
      .toEqual([{ by: ops.userId, reason: REASON['x-swift-reason'], status: 'STAGED' }]);
    expect((await sys(() => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: published.approvalId } }))).status).toBe('APPLIED');
    // The partner is told the money arrived — once per row.
    expect((await sys(() => app.prisma.notification.findMany({ where: { userId: store.owner.userId, title: 'Top-up received' } }))).map((n) => n.body).sort())
      .toEqual(['$1,000 GYD added to your subscription balance.', '$2,100 GYD added to your subscription balance.']);
  });

  it('DUPLICATE: the same file is the same import and moves nothing; a new file repeating a credited transaction credits only its new row', async () => {
    expect(importId, 'the staged file was published').not.toBe('');
    const replay = await withApproval(ops, approver, importFile(good, source('good-again')));
    expect(replay.res.statusCode).toBe(200);
    expect(replay.res.json().data).toMatchObject({ importId, status: 'PUBLISHED', replayed: true, credited: 0, duplicates: 2 });
    expect(await sys(() => app.prisma.settlementImport.count({ where: { source: { startsWith: SOURCE_PREFIX } } }))).toBe(1);
    expect(await money(store.subscriptionId)).toEqual({ balance: 3100, topups: [1000, 2100], receipts: 2, ledger: 2, ledgerBalanced: true, credited: [t1, t2].sort() });

    t3 = txn();
    const mixed = await withApproval(ops, approver, importFile(csvOf([[t2, store.san, 1000], [t3, store.san, 700]], { total: 1700, count: 2 }), source('mixed')));
    expect(mixed.res.statusCode, mixed.res.body).toBe(200);
    expect(mixed.res.json().data).toMatchObject({ status: 'PUBLISHED', fileRows: 2, credited: 1, duplicates: 1, replayed: false });
    expect(await money(store.subscriptionId)).toEqual({ balance: 3800, topups: [700, 1000, 2100], receipts: 3, ledger: 3, ledgerBalanced: true, credited: [t1, t2, t3].sort() });
  });

  it('ROLLBACK: a file whose control total disagrees is rejected WHOLE with zero credits and ops paged; the corrected file recovers every row once', async () => {
    t4 = txn();
    t5 = txn();
    const badSource = source('bad');
    const bad = csvOf([[t4, store.san, 1500], [t5, store.san, 900]], { total: 9999 });
    const rejected = await withApproval(ops, approver, importFile(bad, badSource));
    expect(rejected.res.statusCode).toBe(200);
    const report = rejected.res.json().data;
    expect({ status: report.status, credited: report.credited, trailerMismatch: report.trailerMismatch, reasons: report.rejectedRows.map((r: { reason: string }) => r.reason) })
      .toEqual({ status: 'REJECTED', credited: 0, trailerMismatch: true, reasons: ['CONTROL_TOTAL_MISMATCH: file claims 9999, rows sum to 2400'] });
    expect((await sys(() => app.prisma.settlementImport.findUniqueOrThrow({ where: { id: report.importId } }))).status).toBe('REJECTED');
    expect(await money(store.subscriptionId)).toEqual({ balance: 3800, topups: [700, 1000, 2100], receipts: 3, ledger: 3, ledgerBalanced: true, credited: [t1, t2, t3].sort() });
    expect(await sys(() => app.prisma.mmgAgentPayment.count({ where: { externalId: { in: [t4, t5] } } }))).toBe(0);
    // Ops is told, with the file named — not left to find it.
    const paged = await sys(() => app.prisma.notification.findMany({ where: { userId: ops.userId, title: 'Settlement file trailer mismatch' } }));
    expect(paged.map((p) => (p.data as Record<string, unknown>)['source'])).toEqual([badSource]);
    // The same bad file again is the same rejection, not a second chance to credit.
    const again = await withApproval(ops, approver, importFile(bad, source('bad-again')));
    expect(again.res.json().data).toMatchObject({ importId: report.importId, status: 'REJECTED', replayed: true, credited: 0 });

    const fixed = await withApproval(ops, approver, importFile(csvOf([[t4, store.san, 1500], [t5, store.san, 900]], { total: 2400, count: 2 }), source('fixed')));
    expect(fixed.res.statusCode, fixed.res.body).toBe(200);
    expect(fixed.res.json().data).toMatchObject({ status: 'PUBLISHED', credited: 2, duplicates: 0 });
    expect(await money(store.subscriptionId)).toEqual({ balance: 6200, topups: [700, 900, 1000, 1500, 2100], receipts: 5, ledger: 5, ledgerBalanced: true, credited: [t1, t2, t3, t4, t5].sort() });
    // The rejected import itself stays what it was: rejected, having credited nothing.
    const stillRejected = await sys(() => app.prisma.settlementImport.findUniqueOrThrow({ where: { id: report.importId } }));
    expect({ status: stillRejected.status, credited: stillRejected.credited, publishedAt: stillRejected.publishedAt }).toEqual({ status: 'REJECTED', credited: 0, publishedAt: null });
  });

  it('HOLD and RELEASE: held, the file is staged and validated but credits nothing; lifted, the same file publishes once', async () => {
    const t6 = txn();
    const heldCsv = csvOf([[t6, store.san, 1200]], { total: 1200, count: 1 });
    vi.stubEnv('SETTLEMENT_PUBLISH_KILL', '1');
    let held: LightMyRequestResponse;
    try {
      held = (await withApproval(ops, approver, importFile(heldCsv, source('held')))).res;
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env['SETTLEMENT_PUBLISH_KILL']).toBeUndefined();
    expect(held.statusCode).toBe(200);
    expect(held.json().data).toMatchObject({ status: 'HELD', credited: 0 });
    const heldRow = await sys(() => app.prisma.settlementImport.findUniqueOrThrow({ where: { id: held.json().data.importId } }));
    expect({ status: heldRow.status, rows: heldRow.rowCount, total: Number(heldRow.computedTotal) }).toEqual({ status: 'STAGED', rows: 1, total: 1200 });
    expect(await money(store.subscriptionId)).toEqual({ balance: 6200, topups: [700, 900, 1000, 1500, 2100], receipts: 5, ledger: 5, ledgerBalanced: true, credited: [t1, t2, t3, t4, t5].sort() });

    const released = await withApproval(ops, approver, importFile(heldCsv, source('released')));
    expect(released.res.statusCode, released.res.body).toBe(200);
    expect(released.res.json().data).toMatchObject({ importId: heldRow.id, status: 'PUBLISHED', credited: 1, replayed: false });
    expect(await money(store.subscriptionId)).toEqual({ balance: 7400, topups: [700, 900, 1000, 1200, 1500, 2100], receipts: 6, ledger: 6, ledgerBalanced: true, credited: [t1, t2, t3, t4, t5, t6].sort() });
  });

  it('the wrong parties change nothing: a non-admin, and a call with no stated reason', async () => {
    const t7 = txn();
    const csv = csvOf([[t7, store.san, 800]], { total: 800, count: 1 });
    const before = await money(store.subscriptionId);
    const stranger = await app.inject({ method: 'POST', url: '/api/v1/admin/billing/settlement-import', payload: { csv, source: source('stranger') }, headers: { authorization: `Bearer ${clerk.token}`, 'content-type': 'application/json', ...REASON } });
    expect(stranger.statusCode).toBe(403);
    const reasonless = await app.inject({ method: 'POST', url: '/api/v1/admin/billing/settlement-import', payload: { csv, source: source('reasonless') }, headers: { authorization: `Bearer ${ops.token}`, 'content-type': 'application/json' } });
    expect(reasonless.statusCode).toBe(400);
    expect(await sys(() => app.prisma.privilegedApproval.count({ where: { requestedBy: { in: [clerk.userId] } } }))).toBe(0);
    expect(await sys(() => app.prisma.settlementImport.count({ where: { source: { in: [`${SOURCE_PREFIX}-stranger`, `${SOURCE_PREFIX}-reasonless`] } } }))).toBe(0);
    expect(await money(store.subscriptionId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// G5-F6 — a publication that dies mid-file can never be recovered
// ---------------------------------------------------------------------------
//
// settlement-import.ts publishSettlementImport claims the import
// (STAGED → PUBLISHING) and credits row by row with no recovery: when a row's
// ingest throws — a dropped database connection, a restart mid-file — the
// import stays PUBLISHING for ever. A retry of the same file (a fresh
// approval) then answers 200 "replayed: true, credited: 0, duplicates: 2"
// while row 2 was never credited, publishSettlementImport has no other
// caller, and scanSettlementImports only reads PUBLISHED and REJECTED
// imports. The fault is one thrown ingest on row 2 of a real publication; the
// interrupted attempt and the retry both run in beforeAll, so this can only
// fail on the recovered state.
describe('GOLD-5 · ADMIN-04 — G5-F6', () => {
  let store: Awaited<ReturnType<typeof makeSubscriber>>;
  let t1 = '';
  let t2 = '';
  let stuckImport = '';
  let firstStatus = 0;

  beforeAll(async () => {
    const ops = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Olga' });
    const approver = await makeUser(['ADMIN'], 'ADMIN', { admin: true, firstName: 'Abel' });
    store = await makeSubscriber('Gold5 Stuck Kitchen');
    t1 = txn();
    t2 = txn();
    const csv = csvOf([[t1, store.san, 2100], [t2, store.san, 1000]], { total: 3100, count: 2 });
    const real = AgentCashService.prototype.ingest;
    let calls = 0;
    const outage = vi.spyOn(AgentCashService.prototype, 'ingest').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['ingest']>) {
      calls += 1;
      if (calls === 2) throw new Error('Connection terminated unexpectedly');
      return real.apply(this, args);
    });
    try {
      firstStatus = (await withApproval(ops, approver, importFile(csv, source('stuck')))).res.statusCode;
    } finally {
      outage.mockRestore();
    }
    expect(firstStatus).toBe(500);
    const row = await sys(() => app.prisma.settlementImport.findFirstOrThrow({ where: { source: `${SOURCE_PREFIX}-stuck` } }));
    stuckImport = row.id;
    expect(row.status).toBe('PUBLISHING');
    expect(await money(store.subscriptionId)).toMatchObject({ balance: 2100, credited: [t1] });
    // The operator does what the screen allows: import the same file again.
    await withApproval(ops, approver, importFile(csv, source('stuck-retry')));
  }, 60_000);

  it.fails('[G5-F6] after a publication dies mid-file, importing the file again credits the missing row once and closes the import', async () => {
    const row = await sys(() => app.prisma.settlementImport.findUniqueOrThrow({ where: { id: stuckImport } }));
    expect(row.status).toBe('PUBLISHED');
    expect(await money(store.subscriptionId)).toMatchObject({ balance: 3100, credited: [t1, t2].sort() });
  });
});
