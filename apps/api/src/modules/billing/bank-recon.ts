import type { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { bankReconRefusalsCounter } from '../../plugins/observability';
import { log } from '../../utils/logger';

// Bank-truth reconciliation [san spec PART 25] — the last mile of money.
// Everything upstream trusts what MMG SAYS happened; this closes the loop
// against what LANDED in the bank. INERT until the founder sets the cadence
// config (PlatformConfig 'billing.mmg_agent.settlement_cadence_days' +
// 'billing.mmg_agent.provider_fee_pct' — MMG question 10); built now so the
// day MMG answers, one config write activates it.
//
// [M-22] Tenant financial data is isolated and a bank confirmation is
// immutable. Before, the batch grid aggregated EVERY tenant's payments under
// a hardcoded default tenant, the list and confirm routes were not scoped,
// and a second confirmation silently overwrote the first's amount, reference
// and status. Now every read and write carries the tenant; the confirmation
// is a compare-and-set on the batch (EXPECTED → DEPOSITED | MISMATCH, once)
// that writes an immutable DepositConfirmation with a mandatory, unique bank
// reference and the audit row in the same transaction; a correction is a
// separate ADJUSTMENT record naming what it supersedes; and
// BANK_RECON_READONLY=1 makes confirmation read-only.

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

const PROVIDER = 'MMG';

/** Build EXPECTED batches for completed periods that have none yet — for ONE
 *  tenant. Gross is computed from that tenant's payment rows (provable);
 *  expected net applies the configured MMG fee. Idempotent via the
 *  (tenant, provider, periodStart) unique. Returns how many were created. */
export async function buildExpectedBatches(prisma: PrismaClient, now = new Date(), tenantId = 'swift-default'): Promise<number> {
  const cfg = await reconConfig(prisma);
  if (!cfg) return 0; // inert until MMG answers Q10
  const periodMs = cfg.cadenceDays * 86_400_000;
  const first = await prisma.mmgAgentPayment.findFirst({
    where: { tenantId, status: { in: ['MATCHED', 'RESOLVED'] } },
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
      where: { tenantId_provider_periodStart: { tenantId, provider: PROVIDER, periodStart } },
    });
    if (existing) continue;
    const gross = await prisma.mmgAgentPayment.aggregate({
      where: { tenantId, status: { in: ['MATCHED', 'RESOLVED'] }, paidAt: { gte: periodStart, lt: periodEnd } },
      _sum: { amount: true },
    });
    const grossGyd = Number(gross._sum.amount ?? 0);
    if (grossGyd === 0) continue; // nothing collected → nothing to expect
    const fee = Math.round(grossGyd * (cfg.providerFeePct / 100) * 100) / 100;
    await prisma.settlementBatch.create({
      data: {
        tenantId,
        provider: PROVIDER,
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

export interface DepositActor {
  userId: string;
  tenantId: string;
  ipAddress?: string;
  userAgent?: string;
}

function refuse(reason: 'foreign_batch' | 'reconfirmation' | 'bank_ref_reused' | 'readonly', error: AppError): never {
  bankReconRefusalsCounter.labels(reason).inc();
  throw error;
}

function assertWritable(): void {
  if (process.env['BANK_RECON_READONLY'] === '1') {
    refuse('readonly', new AppError(503, 'BANK_RECON_READONLY', 'Bank reconciliation is read-only by operations — nothing was recorded.'));
  }
}

/** The founder confirms a deposit (amount + bank ref) for a batch OF THEIR
 *  TENANT — once. Deviation beyond tolerance ⇒ MISMATCH (caller pages). The
 *  batch's compare-and-set, the immutable confirmation row and the audit row
 *  commit together; a second confirmation is refused and the first stands. */
export async function confirmDeposit(
  prisma: PrismaClient,
  batchId: string,
  deposit: { depositedGyd: number; depositedAt: Date; bankRef: string },
  actor: DepositActor,
): Promise<{ status: string; deltaGyd: number; confirmationId: string }> {
  assertWritable();
  const bankRef = deposit.bankRef.trim();
  if (bankRef.length < 3) throw new AppError(400, 'BANK_REF_REQUIRED', 'A bank reference is required to confirm a deposit — it is the evidence.');
  const batch = await prisma.settlementBatch.findFirst({ where: { id: batchId, tenantId: actor.tenantId } });
  if (!batch) {
    // Not this tenant's batch (or no batch at all): the same answer either
    // way, and a page — a guessed id is a cross-tenant probe.
    refuse('foreign_batch', new NotFoundError('SettlementBatch', batchId));
  }
  const cfg = await reconConfig(prisma);
  const tolerance = cfg?.toleranceGyd ?? 0;
  const expected = Number(batch.expectedNetGyd ?? batch.grossGyd);
  const delta = Math.round((deposit.depositedGyd - expected) * 100) / 100;
  const status = Math.abs(delta) <= tolerance ? 'DEPOSITED' : 'MISMATCH';
  const confirmation = await prisma.$transaction(async (tx) => {
    const claimed = await tx.settlementBatch.updateMany({
      where: { id: batchId, tenantId: actor.tenantId, status: 'EXPECTED' },
      data: { depositedGyd: deposit.depositedGyd, depositedAt: deposit.depositedAt, bankRef, status, notes: status === 'MISMATCH' ? `deposit off expected net by GY$${delta}` : null },
    });
    if (claimed.count !== 1) {
      refuse('reconfirmation', new AppError(409, 'DEPOSIT_ALREADY_CONFIRMED', 'This batch already has a confirmed deposit. The original stands — record a correction as an adjustment.'));
    }
    let row;
    try {
      row = await tx.depositConfirmation.create({
        data: {
          tenantId: actor.tenantId, batchId, provider: batch.provider, kind: 'CONFIRMATION',
          depositedGyd: deposit.depositedGyd, depositedAt: deposit.depositedAt, bankRef, status, deltaGyd: delta, confirmedBy: actor.userId,
        },
        select: { id: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        refuse('bank_ref_reused', new AppError(409, 'BANK_REF_REUSED', `Bank reference ${bankRef} was already used for another deposit — one reference, one deposit.`));
      }
      throw err;
    }
    await tx.auditLog.create({
      data: {
        userId: actor.userId, action: 'CONFIRM_DEPOSIT', entity: 'SettlementBatch', entityId: batchId,
        changes: { confirmationId: row.id, depositedGyd: deposit.depositedGyd, bankRef, status, deltaGyd: delta } as never,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      },
    });
    return row;
  });
  if (status === 'MISMATCH') {
    log().error({ batchId, expected, deposited: deposit.depositedGyd, delta, tenantId: actor.tenantId }, 'settlement deposit MISMATCH');
  }
  return { status, deltaGyd: delta, confirmationId: confirmation.id };
}

/** A correction is never an edit: the original confirmation stands, an
 *  ADJUSTMENT record names it, carries its own (unique) bank reference and
 *  reason, and the batch's derived figures follow the adjustment. */
export async function adjustDeposit(
  prisma: PrismaClient,
  batchId: string,
  adjustment: { depositedGyd: number; depositedAt: Date; bankRef: string; reason: string },
  actor: DepositActor,
): Promise<{ status: string; deltaGyd: number; adjustmentId: string; supersedesId: string }> {
  assertWritable();
  const bankRef = adjustment.bankRef.trim();
  if (bankRef.length < 3) throw new AppError(400, 'BANK_REF_REQUIRED', 'A bank reference is required for an adjustment — it is the evidence.');
  if (!adjustment.reason?.trim()) throw new AppError(400, 'REASON_REQUIRED', 'An adjustment needs a written reason.');
  const batch = await prisma.settlementBatch.findFirst({ where: { id: batchId, tenantId: actor.tenantId } });
  if (!batch) refuse('foreign_batch', new NotFoundError('SettlementBatch', batchId));
  const latest = await prisma.depositConfirmation.findFirst({ where: { batchId, tenantId: actor.tenantId }, orderBy: { createdAt: 'desc' } });
  if (!latest) throw new AppError(409, 'DEPOSIT_NOT_CONFIRMED', 'Nothing to adjust — this batch has no confirmed deposit yet.');
  const cfg = await reconConfig(prisma);
  const tolerance = cfg?.toleranceGyd ?? 0;
  const expected = Number(batch.expectedNetGyd ?? batch.grossGyd);
  const delta = Math.round((adjustment.depositedGyd - expected) * 100) / 100;
  const status = Math.abs(delta) <= tolerance ? 'DEPOSITED' : 'MISMATCH';
  const row = await prisma.$transaction(async (tx) => {
    let created;
    try {
      created = await tx.depositConfirmation.create({
        data: {
          tenantId: actor.tenantId, batchId, provider: batch.provider, kind: 'ADJUSTMENT', supersedesId: latest.id,
          depositedGyd: adjustment.depositedGyd, depositedAt: adjustment.depositedAt, bankRef, status, deltaGyd: delta,
          reason: adjustment.reason.trim(), confirmedBy: actor.userId,
        },
        select: { id: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        refuse('bank_ref_reused', new AppError(409, 'BANK_REF_REUSED', `Bank reference ${bankRef} was already used for another deposit — one reference, one deposit.`));
      }
      throw err;
    }
    await tx.settlementBatch.updateMany({
      where: { id: batchId, tenantId: actor.tenantId },
      data: { depositedGyd: adjustment.depositedGyd, depositedAt: adjustment.depositedAt, bankRef, status, notes: status === 'MISMATCH' ? `deposit off expected net by GY$${delta} (adjusted)` : `adjusted: ${adjustment.reason.trim()}` },
    });
    await tx.auditLog.create({
      data: {
        userId: actor.userId, action: 'ADJUST_DEPOSIT', entity: 'SettlementBatch', entityId: batchId,
        changes: { adjustmentId: created.id, supersedesId: latest.id, depositedGyd: adjustment.depositedGyd, bankRef, status, deltaGyd: delta, reason: adjustment.reason.trim() } as never,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      },
    });
    return created;
  });
  if (status === 'MISMATCH') log().error({ batchId, expected, deposited: adjustment.depositedGyd, delta, tenantId: actor.tenantId }, 'settlement deposit MISMATCH (adjusted)');
  return { status, deltaGyd: delta, adjustmentId: row.id, supersedesId: latest.id };
}
