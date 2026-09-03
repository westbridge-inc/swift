import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { buildExpectedBatches, confirmDeposit, reconConfig } from '../modules/billing/bank-recon';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { purgeAuditLogs } from '../lib/audit-immutability';

// [R048-001] This suite states the destructive capability it needs; without it the test-mode guard refuses.
grantSuiteCapability('unscoped-mutation');

// PART 25 — bank truth (scenario U): inert without config; with a cadence set,
// EXPECTED batches derive gross from payment rows; a short deposit goes
// MISMATCH with the delta named.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const paymentIds: string[] = [];
const batchIds: string[] = [];
const CONFIG_KEYS = [
  'billing.mmg_agent.settlement_cadence_days',
  'billing.mmg_agent.provider_fee_pct',
  'billing.mmg_agent.settlement_tolerance_gyd',
];

async function seedPayment(amount: number, paidAt: Date) {
  const p = await prisma.mmgAgentPayment.create({
    data: {
      channel: 'MANUAL_ADMIN',
      externalId: `RECON-${nanoid(10)}`,
      sanRaw: '4729058836',
      amount,
      currencyCode: 'GYD',
      paidAt,
      status: 'MATCHED',
      raw: { recon: true } as never,
    },
  });
  paymentIds.push(p.id);
  return p;
}

beforeAll(async () => {
  await prisma.$connect();
  // This suite owns the batch table (nothing else writes it); clearing up
  // front makes re-runs deterministic against prior-run residue.
  await prisma.settlementBatch.deleteMany({});
  await prisma.mmgAgentPayment.deleteMany({ where: { externalId: { startsWith: 'RECON-' } } });
});

afterAll(async () => {
  await prisma.depositConfirmation.deleteMany({ where: { batchId: { in: batchIds } } });
  await purgeAuditLogs(prisma, { entity: 'SettlementBatch', entityId: { in: batchIds } }, 'test-cleanup:bank-recon');
  await prisma.settlementBatch.deleteMany({ where: { id: { in: batchIds } } });
  await prisma.mmgAgentPayment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.platformConfig.deleteMany({ where: { key: { in: CONFIG_KEYS } } });
  await prisma.$disconnect();
});

describe('bank-truth reconciliation (scenario U)', () => {
  it('is inert until the cadence config exists (built now, activated by an MMG answer)', async () => {
    await prisma.platformConfig.deleteMany({ where: { key: { in: CONFIG_KEYS } } });
    expect(await reconConfig(prisma)).toBeNull();
    expect(await buildExpectedBatches(prisma)).toBe(0);
  });

  it('with a cadence: EXPECTED batches carry ledger-derived gross and fee-adjusted net; a short deposit goes MISMATCH', async () => {
    for (const [key, value] of [
      ['billing.mmg_agent.settlement_cadence_days', 7],
      ['billing.mmg_agent.provider_fee_pct', 2],
      ['billing.mmg_agent.settlement_tolerance_gyd', 0],
    ] as const) {
      await prisma.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
    // Two payments in a completed week well in the past.
    const start = new Date(Date.now() - 21 * 86_400_000);
    await seedPayment(2100, new Date(start.getTime() + 3_600_000));
    await seedPayment(4200, new Date(start.getTime() + 2 * 86_400_000));

    const created = await buildExpectedBatches(prisma);
    expect(created).toBeGreaterThanOrEqual(1);
    const batch = await prisma.settlementBatch.findFirst({
      where: { status: 'EXPECTED', grossGyd: { gte: 6300 } },
      orderBy: { createdAt: 'desc' },
    });
    expect(batch).toBeTruthy();
    batchIds.push(batch!.id);
    const gross = Number(batch!.grossGyd);
    expect(Number(batch!.expectedNetGyd)).toBeCloseTo(gross * 0.98, 1); // 2% MMG fee

    // Idempotent: re-running creates nothing for the same periods.
    const again = await buildExpectedBatches(prisma);
    const dupes = await prisma.settlementBatch.count({
      where: { tenantId: 'swift-default', provider: 'MMG', periodStart: batch!.periodStart },
    });
    expect(dupes).toBe(1);
    expect(again).toBeGreaterThanOrEqual(0);

    // The founder confirms a SHORT deposit → MISMATCH with the delta named.
    // [M-22] A confirmation carries the actor and a bank reference that is
    // unique per provider; it is immutable (bank-recon-immutable.test.ts).
    const res = await confirmDeposit(prisma, batch!.id, {
      depositedGyd: Number(batch!.expectedNetGyd) - 500,
      depositedAt: new Date(),
      bankRef: `GBTI-TEST-${nanoid(8)}`,
    }, { userId: 'bank-recon-test', tenantId: 'swift-default' });
    expect(res.status).toBe('MISMATCH');
    expect(res.deltaGyd).toBe(-500);
    const after = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch!.id } });
    expect(after.status).toBe('MISMATCH');
    expect(after.notes).toContain('-500');
  });
});
