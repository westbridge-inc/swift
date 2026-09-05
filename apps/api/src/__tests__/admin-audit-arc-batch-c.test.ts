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
import { ensureSan } from '../modules/billing/san.service';
import { settlementFileHash } from '../modules/billing/settlement-import';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { refusalName, refuseAuditWhere, allowAuditAgain, dropAuditRefusal } from './helpers/audit-refusal';

// ---------------------------------------------------------------------------
// [ADM-002] ARC BATCH C — agent cash (record, attach), the manual refund
// settlement, and the settlement-file import take the audit into their
// transactions. With these, every C4/C5 route either audits inline or is a
// named fleet-wide exception (admin-audit-inline-census.test.ts).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REFUSAL = refusalName('arcc');
const userIds: string[] = []; const vendorIds: string[] = []; const ownerIds: string[] = []; const subIds: string[] = [];
const receipts: string[] = []; const fileHashes: string[] = [];
let token = '';
const REASON = 'MMG counter receipts reconciled for week 36, ticket GY-7200';
const HEADER = 'transaction_id,account_number,amount,paid_at';

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });
const rowsFor = (entityId: string) => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { userId: userIds[0]!, entityId }, orderBy: { createdAt: 'asc' } }), 'read');
const changesOf = (row: { changes: unknown }) => row.changes as Record<string, unknown>;
const changedOf = (row: { changes: unknown }) => (changesOf(row)['changed'] ?? {}) as Record<string, { from: unknown; to: unknown }>;

async function person(role: 'VENDOR_OWNER', tag: string) {
  const u = await app.prisma.user.create({ data: {
    phone: `+5926${String(500000 + Math.floor(Math.random() * 99999))}`, firstName: 'C', lastName: `${tag}${RUN}${nanoid(3)}`,
    roles: [role], activeRole: role, status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(u.id); return u;
}
async function sanSubscription() {
  const ownerUser = await person('VENDOR_OWNER', 'Own');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } }); ownerIds.push(owner.id);
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `C Kitchen ${RUN} ${nanoid(3)}`, slug: `arcc-${RUN}-${nanoid(5).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+59270${String(Math.floor(Math.random() * 90000) + 10000)}`, addressLine1: '3 Audit Row', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000) } });
  subIds.push(sub.id);
  const san = await ensureSan(app.prisma, sub.id);
  return { sub, san };
}
const receipt = () => { const r = `ARCC${RUN}${nanoid(6).replace(/[^a-zA-Z0-9]/g, '0')}`.toUpperCase(); receipts.push(`MANUAL:${r}`); return r; };
const record = (san: string, r: string, amount = 2100) => call('POST', '/api/v1/admin/billing/agent-payments', {
  san, amount, paidAt: new Date().toISOString(), receiptNumber: r, verifiedInPortal: true });
async function manualIntent() {
  const a = await app.prisma.advertiser.create({ data: { companyName: `ArcC ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000001', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  const p = await app.prisma.adPlacement.create({ data: { key: `arcc-${nanoid(6)}`, name: `P ${nanoid(4)}`, tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  const week = new Date('2026-11-09T00:00:00Z');
  const c = await app.prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: `Camp ${nanoid(4)}`, cities: ['*'], startWeek: week, endWeek: week, status: 'CANCELLED', totalAmount: 5000 } });
  const inv = await app.prisma.adInvoice.create({ data: { advertiserId: a.id, campaignId: c.id, number: `ADS-ARCC-${nanoid(8)}`, amount: 5000, status: 'PAID', provider: 'MOCK', providerRef: nanoid(8), paidAt: new Date(), refundedAmount: 5000 } });
  return app.prisma.adRefundIntent.create({ data: {
    tenantId: 'swift-default', invoiceId: inv.id, campaignId: c.id, idempotencyKey: `arcc:${nanoid(10)}`, reason: 'ADVERTISER_CANCEL',
    status: 'MANUAL_REQUIRED', amountMinor: BigInt(500000), currency: 'GYD', correlationId: nanoid(12) } });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59269${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'ArcC', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'arcc', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await dropAuditRefusal(app, REFUSAL);
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    // Refund intents are immutable at the database (AD_REFUND_INTENT_IMMUTABLE),
    // and the invoice/campaign/placement/advertiser behind them are held by FK —
    // the ads fixtures stay, as in every other refund suite.
    await app.prisma.settlementImport.deleteMany({ where: { fileHash: { in: fileHashes } } }).catch(() => {});
    const payments = await app.prisma.mmgAgentPayment.findMany({ where: { OR: [{ externalId: { in: receipts } }, { subscriptionId: { in: subIds } }] }, select: { id: true, providerPaymentId: true } });
    await app.prisma.mmgAgentPayment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } }).catch(() => {});
    await app.prisma.providerPayment.deleteMany({ where: { id: { in: payments.map((p) => p.providerPaymentId).filter((x): x is string => !!x) } } }).catch(() => {});
    const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId: { in: subIds } }, select: { idempotencyKey: true } });
    await app.prisma.ledgerTransaction.deleteMany({ where: { idempotencyKey: { in: events.map((e) => `ledger:${e.idempotencyKey}`) } } }).catch(() => {});
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.sanTombstone.deleteMany({ where: { subscriptionId: { in: subIds } } }).catch(() => {});
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'arcc').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'arcc').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'arcc');
  await app.close();
});

describe('[ADM-002] agent cash: recording a counter payment', () => {
  it('the credit transaction writes the audit row and names the payment it credited', async () => {
    const { sub, san } = await sanSubscription();
    const res = await record(san, receipt());
    expect(res.statusCode, res.body).toBe(200);
    const data = (JSON.parse(res.body) as { data: { status: string; paymentId: string } }).data;
    expect(data.status).toBe('accepted');
    const rows = await rowsFor(data.paymentId);
    expect(rows.length).toBe(1);
    expect(changesOf(rows[0]!)['credited']).toBe(true);
    expect(changesOf(rows[0]!)['subscriptionId']).toBe(sub.id);
  });
  it('a refused audit rolls the CREDIT back — the observation stays RECEIVED, nothing credited', async () => {
    const { sub, san } = await sanSubscription();
    const r = receipt();
    await refuseAuditWhere(app, REFUSAL, { actionLike: '%/billing/agent-payments' });
    try {
      const res = await record(san, r);
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    const payment = await app.prisma.mmgAgentPayment.findFirst({ where: { externalId: `MANUAL:${r}` } });
    expect(payment?.status, 'received, never credited').toBe('RECEIVED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(0);
  });
});

describe('[ADM-002] agent cash: attaching an unmatched payment', () => {
  async function unmatched() {
    const res = await record('SW0000000000', receipt());
    expect(res.statusCode, res.body).toBe(200);
    const data = (JSON.parse(res.body) as { data: { status: string; paymentId: string } }).data;
    expect(data.status).toBe('received_unmatched');
    return data.paymentId;
  }
  it('the diff carries UNMATCHED → RESOLVED and the fact names the subscription', async () => {
    const { sub } = await sanSubscription(); const paymentId = await unmatched();
    const res = await call('POST', `/api/v1/admin/billing/agent-payments/${paymentId}/attach`, { subscriptionId: sub.id });
    expect(res.statusCode, res.body).toBe(200);
    const rows = (await rowsFor(paymentId)).filter((r) => r.action.endsWith('/attach'));
    expect(rows.length).toBe(1);
    expect(changedOf(rows[0]!)['status']?.to).toBe('RESOLVED');
    expect(changesOf(rows[0]!)['subscriptionId']).toBe(sub.id);
  });
  it('a refused audit leaves the payment UNMATCHED', async () => {
    const { sub } = await sanSubscription(); const paymentId = await unmatched();
    await refuseAuditWhere(app, REFUSAL, { entityId: paymentId });
    try {
      const res = await call('POST', `/api/v1/admin/billing/agent-payments/${paymentId}/attach`, { subscriptionId: sub.id });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect((await app.prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('UNMATCHED');
  });
});

describe('[ADM-002] manual refund settlement', () => {
  it('the diff carries the payout reference; the legacy row is gone', async () => {
    const intent = await manualIntent();
    const res = await call('POST', `/api/v1/admin/ads/refund-intents/${intent.id}/settle`, { manualPayoutRef: `BANK-${RUN}-R1` });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(intent.id);
    expect(rows.length).toBe(1);
    expect(changedOf(rows[0]!)['status']?.to, JSON.stringify(rows[0]!.changes)).toBe('SUCCEEDED');
    expect(changedOf(rows[0]!)['manualPayoutRef']?.to).toBe(`BANK-${RUN}-R1`);
    expect(rows.some((r) => r.action === 'SETTLE_AD_REFUND')).toBe(false);
  });
  it('a refused audit leaves the intent MANUAL_REQUIRED', async () => {
    const intent = await manualIntent();
    await refuseAuditWhere(app, REFUSAL, { entityId: intent.id });
    try {
      const res = await call('POST', `/api/v1/admin/ads/refund-intents/${intent.id}/settle`, { manualPayoutRef: `BANK-${RUN}-R2` });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect((await app.prisma.adRefundIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('MANUAL_REQUIRED');
  });
});

describe('[ADM-002] the settlement-file import', () => {
  const csvFor = (san: string) => {
    const a = `ARCC-${RUN}-${nanoid(6)}`; const b = `ARCC-${RUN}-${nanoid(6)}`;
    receipts.push(a, b);
    const csv = [HEADER, `${a},${san},2100,2026-08-01T10:00:00Z`, `${b},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,3100', 'ROWCOUNT,2'].join('\n');
    fileHashes.push(settlementFileHash(csv)); return csv;
  };
  it('staging the file writes the audit row with the import it created', async () => {
    const { san } = await sanSubscription(); const csv = csvFor(san);
    const res = await call('POST', '/api/v1/admin/billing/settlement-import', { csv, source: `arcc-${RUN}` });
    expect(res.statusCode, res.body).toBe(200);
    const imported = await app.prisma.settlementImport.findFirst({ where: { fileHash: settlementFileHash(csv) } });
    expect(imported).not.toBeNull();
    const rows = await rowsFor(imported!.id);
    expect(rows.length).toBe(1);
    expect(changesOf(rows[0]!)['rowCount']).toBe(2);
    expect(changesOf(rows[0]!)['computedTotal']).toBe('3100');
  });
  it('a refused audit stages nothing and credits nothing', async () => {
    const { sub, san } = await sanSubscription(); const csv = csvFor(san);
    await refuseAuditWhere(app, REFUSAL, { actionLike: '%/billing/settlement-import' });
    try {
      const res = await call('POST', '/api/v1/admin/billing/settlement-import', { csv, source: `arcc-${RUN}-refused` });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect(await app.prisma.settlementImport.count({ where: { fileHash: settlementFileHash(csv) } })).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(0);
  });
});
