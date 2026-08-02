import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// Bank-truth reconciliation [san spec PART 25] — the last mile of money.
// Everything upstream trusts what MMG SAYS happened; this closes the loop
// against what LANDED in the bank. INERT until the founder sets the cadence
// config (PlatformConfig 'billing.mmg_agent.settlement_cadence_days' +
// 'billing.mmg_agent.provider_fee_pct' — MMG question 10); built now so the
// day MMG answers, one config write activates it.

export interface CadenceConfig {
  cadenceDays: number;
  providerFeePct: number; // e.g. 1.5 → fee = gross * 0.015
  toleranceGyd: number;
}

export async function reconConfig(prisma: PrismaClient): Promise<CadenceConfig | null> {
  const [cadence, fee, tol] = await Promise.all([
    prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.settlement_cadence_days' } }),
    prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.provider_fee_pct' } }),
    prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.settlement_tolerance_gyd' } }),
  ]);
  const cadenceDays = Number(cadence?.value);
  if (!Number.isFinite(cadenceDays) || cadenceDays < 1) return null; // unset → inert
  return {
    cadenceDays,
    providerFeePct: Number.isFinite(Number(fee?.value)) ? Number(fee?.value) : 0,
    toleranceGyd: Number.isFinite(Number(tol?.value)) ? Number(tol?.value) : 0,
  };
}

/** Build EXPECTED batches for completed periods that have none yet. Gross is
 *  computed from the payment rows (provable); expected net applies the
 *  configured MMG fee. Idempotent via the (tenant, provider, periodStart)
 *  unique. Returns how many were created. */
export async function buildExpectedBatches(prisma: PrismaClient, now = new Date()): Promise<number> {
  const cfg = await reconConfig(prisma);
  if (!cfg) return 0; // inert until MMG answers Q10
  const periodMs = cfg.cadenceDays * 86_400_000;

  const first = await prisma.mmgAgentPayment.findFirst({
    where: { status: { in: ['MATCHED', 'RESOLVED'] } },
    orderBy: { paidAt: 'asc' },
    select: { paidAt: true },
  });
  if (!first) return 0;

  // Period grid anchored at the first payment's UTC midnight.
  const anchor = new Date(first.paidAt);
  anchor.setUTCHours(0, 0, 0, 0);
  let created = 0;
  for (let start = anchor.getTime(); start + periodMs <= now.getTime(); start += periodMs) {
    const periodStart = new Date(start);
    const periodEnd = new Date(start + periodMs);
    const existing = await prisma.settlementBatch.findUnique({
      where: { tenantId_provider_periodStart: { tenantId: 'swift-default', provider: 'MMG', periodStart } },
    });
    if (existing) continue;
    const gross = await prisma.mmgAgentPayment.aggregate({
      where: { status: { in: ['MATCHED', 'RESOLVED'] }, paidAt: { gte: periodStart, lt: periodEnd } },
      _sum: { amount: true },
    });
    const grossGyd = Number(gross._sum.amount ?? 0);
    if (grossGyd === 0) continue; // nothing collected → nothing to expect
    const fee = Math.round(grossGyd * (cfg.providerFeePct / 100) * 100) / 100;
    await prisma.settlementBatch.create({
      data: {
        periodStart,
        periodEnd,
        grossGyd,
        providerFeeGyd: fee,
        expectedNetGyd: grossGyd - fee,
        status: 'EXPECTED',
      },
    });
    created += 1;
  }
  return created;
}

/** The founder confirms a deposit (amount + bank ref); deviation beyond
 *  tolerance ⇒ MISMATCH (caller pages). */
export async function confirmDeposit(
  prisma: PrismaClient,
  batchId: string,
  deposit: { depositedGyd: number; depositedAt: Date; bankRef?: string },
): Promise<{ status: string; deltaGyd: number }> {
  const batch = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batchId } });
  const cfg = await reconConfig(prisma);
  const tolerance = cfg?.toleranceGyd ?? 0;
  const expected = Number(batch.expectedNetGyd ?? batch.grossGyd);
  const delta = Math.round((deposit.depositedGyd - expected) * 100) / 100;
  const status = Math.abs(delta) <= tolerance ? 'DEPOSITED' : 'MISMATCH';
  await prisma.settlementBatch.update({
    where: { id: batchId },
    data: {
      depositedGyd: deposit.depositedGyd,
      depositedAt: deposit.depositedAt,
      bankRef: deposit.bankRef ?? null,
      status,
      notes: status === 'MISMATCH' ? `deposit off expected net by GY$${delta}` : null,
    },
  });
  if (status === 'MISMATCH') {
    log().error({ batchId, expected, deposited: deposit.depositedGyd, delta }, 'settlement deposit MISMATCH');
  }
  return { status, deltaGyd: delta };
}
