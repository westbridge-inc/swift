import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { buildExpectedBatches, confirmDeposit, adjustDeposit } from '../modules/billing/bank-recon';
import { bankReconRefusalsCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [M-22 · S0] Tenant financial data is isolated; a bank confirmation is
// immutable, unique, state-CASed, and corrected only by a separate adjustment.
//
// Before: the batch grid aggregated every tenant's payments under a hardcoded
// default tenant, the list and confirm paths were not scoped, and a second
// confirmation silently overwrote the first's amount, reference and status.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const CONFIG_KEYS = ['billing.mmg_agent.settlement_cadence_days', 'billing.mmg_agent.provider_fee_pct', 'billing.mmg_agent.settlement_tolerance_gyd'];
const DAY = 86_400_000;
let otherTenantId: string;
const paymentIds: string[] = [];
const batchIds: string[] = [];
const actor = (tenantId: string, userId = `recon-${tenantId}`) => ({ userId, tenantId, ipAddress: '127.0.0.1', userAgent: 'vitest' });
const refuse = async (reason: string) => (await bankReconRefusalsCounter.get()).values.find((v) => v.labels['reason'] === reason)?.value ?? 0;

/** A matched agent payment of one tenant, dated inside a completed week. */
async function seedPayment(tenantId: string, amount: number, paidAt: Date) {
  const p = await prisma.mmgAgentPayment.create({
    data: {
      tenantId, channel: 'MANUAL_ADMIN', externalId: `MANUAL:RECON-${nanoid(8)}`, sanRaw: '4729058836', amount, currencyCode: 'GYD',
      paidAt, status: 'MATCHED', raw: {},
    },
  });
  paymentIds.push(p.id);
  return p;
}
async function batchFor(tenantId: string) {
  const created = await buildExpectedBatches(prisma, new Date(), tenantId);
  expect(created).toBeGreaterThanOrEqual(0);
  const batch = await prisma.settlementBatch.findFirst({ where: { tenantId, provider: 'MMG', status: 'EXPECTED' }, orderBy: { periodStart: 'desc' } });
  expect(batch).toBeTruthy();
  batchIds.push(batch!.id);
  return batch!;
}

beforeAll(async () => {
  await prisma.$connect();
  for (const [key, value] of [[CONFIG_KEYS[0]!, 7], [CONFIG_KEYS[1]!, 0], [CONFIG_KEYS[2]!, 0]] as const) {
    await prisma.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  const other = await prisma.tenant.create({ data: { name: `Recon Operator ${nanoid(4)}`, slug: `recon-${nanoid(8).toLowerCase()}`, isActive: false } });
  otherTenantId = other.id;
  // Two operators, each with payments in the same completed week — one batch each, never one shared.
  const start = new Date(Date.now() - 28 * DAY);
  await seedPayment('swift-default', 5000, new Date(start.getTime() + DAY));
  await seedPayment(otherTenantId, 7000, new Date(start.getTime() + DAY));
});

afterEach(() => { delete process.env['BANK_RECON_READONLY']; });

afterAll(async () => {
  delete process.env['BANK_RECON_READONLY'];
  await prisma.depositConfirmation.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.auditLog.deleteMany({ where: { entity: 'SettlementBatch', entityId: { in: batchIds } } });
  await prisma.settlementBatch.deleteMany({ where: { OR: [{ id: { in: batchIds } }, { tenantId: otherTenantId }] } });
  await prisma.mmgAgentPayment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.tenant.delete({ where: { id: otherTenantId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[M-22] the batch authority is one tenant’s', () => {
  it('the register’s red test, part one: each tenant’s batches are built from its own payments, and a batch id from another tenant cannot be confirmed', async () => {
    const mine = await batchFor('swift-default');
    const theirs = await batchFor(otherTenantId);
    expect(mine.id).not.toBe(theirs.id);
    expect(Number(theirs.grossGyd)).toBe(7000); // the other operator's money, never mixed with ours
    expect(await prisma.settlementBatch.count({ where: { tenantId: otherTenantId } })).toBe(1);
    const before = await refuse('foreign_batch');
    // A tenant admin lists or guesses the other operator's batch id.
    await expect(confirmDeposit(prisma, theirs.id, { depositedGyd: 7000, depositedAt: new Date(), bankRef: `X-${nanoid(6)}` }, actor('swift-default'))).rejects.toMatchObject({ statusCode: 404 });
    expect(await refuse('foreign_batch')).toBe(before + 1);
    const untouched = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: theirs.id } });
    expect({ status: untouched.status, deposited: untouched.depositedGyd, ref: untouched.bankRef }).toEqual({ status: 'EXPECTED', deposited: null, ref: null });
  });
});

describe('[M-22] a confirmation is immutable', () => {
  it('the register’s red test, part two: a repeat confirmation with a changed amount or reference conflicts and the original is preserved; the audit row committed with it', async () => {
    const batch = await batchFor(otherTenantId);
    const ref = `GBTI-${nanoid(8)}`;
    const first = await confirmDeposit(prisma, batch.id, { depositedGyd: 7000, depositedAt: new Date(), bankRef: ref }, actor(otherTenantId));
    expect(first.status).toBe('DEPOSITED');
    expect(await prisma.auditLog.count({ where: { entity: 'SettlementBatch', entityId: batch.id, action: 'CONFIRM_DEPOSIT' } })).toBe(1);
    const before = await refuse('reconfirmation');
    await expect(confirmDeposit(prisma, batch.id, { depositedGyd: 6500, depositedAt: new Date(), bankRef: `GBTI-${nanoid(8)}` }, actor(otherTenantId))).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_CONFIRMED' });
    expect(await refuse('reconfirmation')).toBe(before + 1);
    const stored = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect({ status: stored.status, deposited: Number(stored.depositedGyd), ref: stored.bankRef }).toEqual({ status: 'DEPOSITED', deposited: 7000, ref });
    const rows = await prisma.depositConfirmation.findMany({ where: { batchId: batch.id } });
    expect(rows).toHaveLength(1);
    expect({ kind: rows[0]!.kind, amount: Number(rows[0]!.depositedGyd), ref: rows[0]!.bankRef, by: rows[0]!.confirmedBy }).toEqual({ kind: 'CONFIRMATION', amount: 7000, ref, by: `recon-${otherTenantId}` });
  });

  it('a correction is a separate adjustment that names what it supersedes — the original row never changes', async () => {
    await seedPayment('swift-default', 3000, new Date(Date.now() - 42 * DAY + DAY));
    const batch = await batchFor('swift-default');
    const ref = `GBTI-${nanoid(8)}`;
    const first = await confirmDeposit(prisma, batch.id, { depositedGyd: Number(batch.expectedNetGyd) - 100, depositedAt: new Date(), bankRef: ref }, actor('swift-default'));
    expect(first.status).toBe('MISMATCH');
    const fixRef = `GBTI-${nanoid(8)}`;
    const fixed = await adjustDeposit(prisma, batch.id, { depositedGyd: Number(batch.expectedNetGyd), depositedAt: new Date(), bankRef: fixRef, reason: 'second transfer found on the statement' }, actor('swift-default'));
    expect(fixed).toMatchObject({ status: 'DEPOSITED', deltaGyd: 0, supersedesId: first.confirmationId });
    const rows = await prisma.depositConfirmation.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.kind, Number(r.depositedGyd), r.bankRef, r.supersedesId])).toEqual([
      ['CONFIRMATION', Number(batch.expectedNetGyd) - 100, ref, null],
      ['ADJUSTMENT', Number(batch.expectedNetGyd), fixRef, first.confirmationId],
    ]);
    const stored = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect({ status: stored.status, ref: stored.bankRef }).toEqual({ status: 'DEPOSITED', ref: fixRef });
    expect(await prisma.auditLog.count({ where: { entity: 'SettlementBatch', entityId: batch.id, action: 'ADJUST_DEPOSIT' } })).toBe(1);
  });

  it('a bank reference is mandatory and one deposit’s: reuse is refused and counted', async () => {
    await seedPayment(otherTenantId, 4000, new Date(Date.now() - 42 * DAY + DAY));
    const batch = await batchFor(otherTenantId);
    const used = (await prisma.depositConfirmation.findFirst({ where: { tenantId: otherTenantId } }))!.bankRef;
    const before = await refuse('bank_ref_reused');
    await expect(confirmDeposit(prisma, batch.id, { depositedGyd: 4000, depositedAt: new Date(), bankRef: used }, actor(otherTenantId))).rejects.toMatchObject({ code: 'BANK_REF_REUSED' });
    expect(await refuse('bank_ref_reused')).toBe(before + 1);
    await expect(confirmDeposit(prisma, batch.id, { depositedGyd: 4000, depositedAt: new Date(), bankRef: '  ' }, actor(otherTenantId))).rejects.toMatchObject({ code: 'BANK_REF_REQUIRED' });
    expect((await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('EXPECTED'); // the refused confirmation rolled back with its CAS
    expect(await prisma.depositConfirmation.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it('rollback makes confirmation read-only: nothing is recorded, and it is counted', async () => {
    await seedPayment('swift-default', 2000, new Date(Date.now() - 56 * DAY + DAY));
    const batch = await batchFor('swift-default');
    process.env['BANK_RECON_READONLY'] = '1';
    const before = await refuse('readonly');
    await expect(confirmDeposit(prisma, batch.id, { depositedGyd: 2000, depositedAt: new Date(), bankRef: `GBTI-${nanoid(8)}` }, actor('swift-default'))).rejects.toMatchObject({ code: 'BANK_RECON_READONLY' });
    expect(await refuse('readonly')).toBe(before + 1);
    expect((await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('EXPECTED');
  });
});
