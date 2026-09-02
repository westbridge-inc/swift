import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { log } from '../../utils/logger';
import { legalHoldCounter, legalHoldGauge } from '../../plugins/observability';

/**
 * [S-09] Police legal hold and evidence hold are split.
 *
 * Stop-ship register S-09: escalating a case to the police set the case's
 * hold, and THEN, best-effort, the linked bundle's hold and its custody log
 * entry — three writes, three chances to die in between. A case could claim
 * "held" while its evidence stayed deletable, or evidence could be held with
 * no audit proof of who held it and why.
 *
 * Now a legal hold is ONE transactional authority: under the case's row
 * lock, the case, every linked bundle (by case, or by the SOS the case was
 * born from), the chain-of-custody entry and the `LegalHold` row commit
 * together or not at all. Retention FAILS CLOSED: while any hold is partial
 * — a held case whose evidence is not held, a held bundle whose case is not,
 * a held case with no hold row — nothing is deleted anywhere, and a human is
 * paged. Deletion itself is conditional on the row's live state, so a hold
 * that commits while the sweep runs still wins. The vault operation — the
 * immutable manifest of exactly what was held — is performed by a leased
 * worker from the hold row: the outbox.
 */
export function legalHoldDeletionFrozenByEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env['LEGAL_HOLD_DELETION_FREEZE'] === '1';
}

/** Test seams: run INSIDE the hold transaction, after the named write. A throw is the process dying there. Never set in routes. */
export interface LegalHoldObserver {
  afterCaseHeld?: (caseId: string) => Promise<void>;
  afterBundleHeld?: (caseId: string, bundleId: string) => Promise<void>;
  beforeCommit?: (caseId: string) => Promise<void>;
}

/** Every bundle the case's hold must cover: linked by case, or by the SOS the case came from. */
async function linkedBundleIds(tx: Prisma.TransactionClient, kase: { id: string; sosAlertId: string | null }): Promise<string[]> {
  const rows = await tx.evidenceBundle.findMany({
    where: { OR: [{ caseId: kase.id }, ...(kase.sosAlertId ? [{ sosAlertId: kase.sosAlertId }] : [])] },
    select: { id: true },
  });
  return [...new Set(rows.map((r) => r.id))];
}

/** Place (or extend) the hold INSIDE the caller's transaction. Idempotent:
 *  an already-held aggregate is confirmed, never re-logged. */
export async function placeLegalHold(
  tx: Prisma.TransactionClient,
  input: { caseId: string; placedBy: string; reason: string; observer?: LegalHoldObserver },
): Promise<{ holdId: string; bundleIds: string[]; alreadyComplete: boolean }> {
  await tx.$queryRaw`SELECT "id" FROM "IncidentCase" WHERE "id" = ${input.caseId} FOR UPDATE`;
  const kase = await tx.incidentCase.findUniqueOrThrow({ where: { id: input.caseId }, select: { id: true, tenantId: true, sosAlertId: true, legalHold: true, caseNumber: true } });
  const bundleIds = await linkedBundleIds(tx, kase);
  if (bundleIds.length > 0) await tx.$queryRaw`SELECT "id" FROM "EvidenceBundle" WHERE "id" IN (${Prisma.join(bundleIds)}) FOR UPDATE`;
  const bundles = bundleIds.length > 0 ? await tx.evidenceBundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, legalHold: true } }) : [];
  const existing = await tx.legalHold.findUnique({ where: { caseId: kase.id }, select: { id: true } });
  const alreadyComplete = kase.legalHold && bundles.every((b) => b.legalHold) && existing !== null;
  if (alreadyComplete) return { holdId: existing!.id, bundleIds, alreadyComplete: true };

  if (!kase.legalHold) await tx.incidentCase.update({ where: { id: kase.id }, data: { legalHold: true } });
  await input.observer?.afterCaseHeld?.(kase.id);
  for (const b of bundles) {
    if (!b.legalHold) {
      await tx.evidenceBundle.update({ where: { id: b.id }, data: { legalHold: true } });
      // The chain of custody: who held this evidence, and why — in the same commit.
      await tx.safetyAccessLog.create({ data: { tenantId: kase.tenantId, bundleId: b.id, accessorUserId: input.placedBy, action: 'LEGAL_HOLD', reason: input.reason } });
    }
    await input.observer?.afterBundleHeld?.(kase.id, b.id);
  }
  const hold = existing
    ? await tx.legalHold.update({ where: { id: existing.id }, data: { bundleId: bundleIds[0] ?? null } })
    : await tx.legalHold.create({ data: { tenantId: kase.tenantId, caseId: kase.id, bundleId: bundleIds[0] ?? null, placedBy: input.placedBy, reason: input.reason } });
  await input.observer?.beforeCommit?.(kase.id);
  legalHoldCounter.labels(existing ? 'extended' : 'placed').inc();
  return { holdId: hold.id, bundleIds, alreadyComplete: false };
}

type Claimed = { id: string; caseId: string; vaultAttempts: number };

/** The vault operation from the outbox: a leased worker writes the immutable
 *  manifest of what was held (every linked bundle and item with its hash). */
export async function drainLegalHoldVault(prisma: PrismaClient, options: { limit?: number; leaseMs?: number; caseIds?: string[] } = {}): Promise<{ vaulted: number; failed: number }> {
  const limit = Math.max(1, options.limit ?? 50);
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  let vaulted = 0; let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const filter = options.caseIds?.length ? Prisma.sql`AND "caseId" IN (${Prisma.join(options.caseIds)})` : Prisma.empty;
    const [row] = await prisma.$queryRaw<Claimed[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id" FROM "legal_holds"
        WHERE "vaultStatus" = 'PENDING' AND ("vaultAttempts" = 0 OR "vaultAvailableAt" <= CURRENT_TIMESTAMP) ${filter}
        ORDER BY "placedAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE "legal_holds" AS h
      SET "vaultAttempts" = h."vaultAttempts" + 1, "vaultAvailableAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'), "updatedAt" = CURRENT_TIMESTAMP
      FROM candidate WHERE h."id" = candidate."id"
      RETURNING h."id", h."caseId", h."vaultAttempts"`);
    if (!row) break;
    try {
      const kase = await prisma.incidentCase.findUniqueOrThrow({ where: { id: row.caseId }, select: { id: true, caseNumber: true, sosAlertId: true, legalHold: true } });
      if (!kase.legalHold) throw new Error('case is not held — the aggregate is partial');
      const bundles = await prisma.evidenceBundle.findMany({
        where: { OR: [{ caseId: kase.id }, ...(kase.sosAlertId ? [{ sosAlertId: kase.sosAlertId }] : [])] },
        select: { id: true, bundleNumber: true, legalHold: true, sealedAt: true, sealHash: true, items: { select: { id: true, kind: true, contentHash: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
      });
      if (bundles.some((b) => !b.legalHold)) throw new Error('a linked bundle is not held — the aggregate is partial');
      const manifest = {
        caseNumber: kase.caseNumber,
        vaultedAt: new Date().toISOString(),
        bundles: bundles.map((b) => ({ id: b.id, bundleNumber: b.bundleNumber, sealedAt: b.sealedAt?.toISOString() ?? null, sealHash: b.sealHash, items: b.items.map((it) => ({ id: it.id, kind: it.kind, contentHash: it.contentHash, at: it.createdAt.toISOString() })) })),
      };
      await prisma.legalHold.update({ where: { id: row.id }, data: { vaultStatus: 'DONE', vaultedAt: new Date(), manifest: manifest as Prisma.InputJsonValue, vaultLastError: null } });
      vaulted += 1; legalHoldCounter.labels('vaulted').inc();
    } catch (err) {
      failed += 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
      const exhausted = row.vaultAttempts >= 20;
      const backoffMs = Math.min(3_600_000, 10_000 * 2 ** Math.min(row.vaultAttempts, 8));
      await prisma.$executeRaw(Prisma.sql`UPDATE "legal_holds" SET "vaultLastError" = ${message}, "vaultAvailableAt" = CURRENT_TIMESTAMP + (${backoffMs} * INTERVAL '1 millisecond'), "vaultStatus" = ${exhausted ? 'FAILED' : 'PENDING'}::"LegalHoldVaultStatus", "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${row.id}`).catch(() => {});
      legalHoldCounter.labels(exhausted ? 'vault_dead_letter' : 'vault_failed').inc();
      log().error({ err, holdId: row.id, caseId: row.caseId, attempts: row.vaultAttempts }, '[S-09] legal hold vault operation failed — will retry');
    }
  }
  return { vaulted, failed };
}

export interface LegalHoldScan {
  /** Held cases whose evidence is not (fully) held, held evidence whose case is not, held cases without a hold row. */
  partial: Array<{ caseId: string; bundleId: string | null; kind: 'BUNDLE_NOT_HELD' | 'CASE_NOT_HELD' | 'NO_HOLD_ROW' }>;
  pendingVault: number;
  failedVault: number;
  /** Deletion is frozen while any hold is partial, or by the rollback switch. */
  deletionFrozen: boolean;
}

/** [S-09 · operations] Held cases versus their evidence. */
export async function scanLegalHolds(prisma: PrismaClient): Promise<LegalHoldScan> {
  const partial: LegalHoldScan['partial'] = [];
  const heldCases = await prisma.incidentCase.findMany({ where: { legalHold: true }, select: { id: true, sosAlertId: true, legalHoldRecord: { select: { id: true } } }, take: 2000 });
  for (const c of heldCases) {
    const bundles = await prisma.evidenceBundle.findMany({ where: { OR: [{ caseId: c.id }, ...(c.sosAlertId ? [{ sosAlertId: c.sosAlertId }] : [])] }, select: { id: true, legalHold: true } });
    for (const b of bundles) if (!b.legalHold) partial.push({ caseId: c.id, bundleId: b.id, kind: 'BUNDLE_NOT_HELD' });
    if (!c.legalHoldRecord) partial.push({ caseId: c.id, bundleId: null, kind: 'NO_HOLD_ROW' });
  }
  // Both links count — a case owns its evidence by caseId OR by the SOS alert
  // it was opened from (the orphan SOS bundle is linked only by sosAlertId).
  const heldBundlesWithColdCase = await prisma.$queryRaw<Array<{ id: string; caseId: string }>>`
    SELECT b."id", c."id" AS "caseId" FROM "EvidenceBundle" b
    JOIN "IncidentCase" c ON (c."id" = b."caseId" OR (b."sosAlertId" IS NOT NULL AND c."sosAlertId" = b."sosAlertId"))
    WHERE b."legalHold" = true AND c."legalHold" = false LIMIT 500`;
  for (const b of heldBundlesWithColdCase) partial.push({ caseId: b.caseId, bundleId: b.id, kind: 'CASE_NOT_HELD' });
  const [counts] = await prisma.$queryRaw<Array<{ pending: bigint; failed: bigint }>>`SELECT count(*) FILTER (WHERE "vaultStatus" = 'PENDING')::bigint AS pending, count(*) FILTER (WHERE "vaultStatus" = 'FAILED')::bigint AS failed FROM "legal_holds"`;
  const scan: LegalHoldScan = { partial, pendingVault: Number(counts?.pending ?? 0), failedVault: Number(counts?.failed ?? 0), deletionFrozen: partial.length > 0 || legalHoldDeletionFrozenByEnv() };
  legalHoldGauge.labels('partial').set(partial.length);
  legalHoldGauge.labels('pending_vault').set(scan.pendingVault);
  legalHoldGauge.labels('failed_vault').set(scan.failedVault);
  legalHoldGauge.labels('deletion_frozen').set(scan.deletionFrozen ? 1 : 0);
  return scan;
}

/** [S-09 · operations] Repair only ever EXTENDS a hold to what it must cover
 *  — a held case's evidence, a held bundle's case — never releases one. */
export async function repairLegalHolds(prisma: PrismaClient, actor = 'system:legal-hold-repair'): Promise<{ repaired: string[] }> {
  const scan = await scanLegalHolds(prisma);
  const repaired: string[] = [];
  for (const caseId of [...new Set(scan.partial.map((p) => p.caseId))]) {
    try {
      await prisma.$transaction((tx) => placeLegalHold(tx, { caseId, placedBy: actor, reason: 'Legal hold repaired: extended to every linked evidence object (S-09 scan)' }));
      repaired.push(caseId); legalHoldCounter.labels('repaired').inc();
    } catch (err) {
      log().error({ err, caseId }, '[S-09] legal hold repair failed — deletion stays frozen');
    }
  }
  if (repaired.length > 0) log().warn({ repaired }, '[S-09] partial legal holds repaired — extended to their evidence');
  return { repaired };
}
