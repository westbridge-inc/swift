import type { PrismaClient } from '@prisma/client';
import { resolveVerificationObject, verificationObjectUnavailable } from '../modules/verification/object-authority';

/**
 * [F-026-02] The durable census of storage objects the platform still owes a
 * deletion for. A log line is not a deletion barrier: once the only DB
 * pointer (users.avatar) is nulled or replaced, no sweep can rediscover the
 * object. Every failed delete — and every replaced-pointer purge failure —
 * lands here as one open row per key; purgedAt closes it.
 *
 * Consumers: retryStorageOrphans() runs opportunistically at account-deletion
 * time (no new worker); IDV-1 Phase 2's deletion-sink sweeper is the standing
 * owner and absorbs this table into its register.
 */

type StorageLike = { delete: (key: string) => Promise<unknown> };
type Logger = { error: (obj: Record<string, unknown>, msg: string) => void };

export async function recordStorageOrphan(
  db: PrismaClient,
  log: Logger,
  input: { key: string; reason: string; userId?: string; tenantId?: string },
): Promise<void> {
  try {
    await db.storageOrphan.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        reason: input.reason,
        userId: input.userId,
        tenantId: input.tenantId ?? 'swift-default',
      },
      // A re-orphaned key re-opens its row — the census tracks the OBJECT.
      update: { reason: input.reason, userId: input.userId, purgedAt: null },
    });
  } catch (err) {
    // The census write must never mask the original failure path — but its
    // own failure is the one case where the log line is all that's left.
    log.error({ err, key: input.key, reason: input.reason }, '[F-026-02] storage-orphan census write failed');
  }
}

/** Retry up to limit deletions, scanning the open census in bounded pages.
 * Failures retain their original rows but cannot starve eligible later rows.
 * createdAt + id gives a deterministic cursor even when timestamps tie. */
export async function retryStorageOrphans(
  db: PrismaClient,
  storage: StorageLike,
  log: Logger,
  limit = 5,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
  const pageSize = Math.min(limit, 100);
  const through = new Date();
  let after: { id: string; createdAt: Date } | undefined;
  let purged = 0;
  while (purged < limit) {
    const rows = await db.storageOrphan.findMany({
      where: {
        purgedAt: null, createdAt: { lte: through },
        ...(after && { OR: [
          { createdAt: { gt: after.createdAt } },
          { createdAt: after.createdAt, id: { gt: after.id } },
        ] }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
    });
    for (const row of rows) {
      try {
        // Historical census rows are not deletion capabilities. Re-prove the
        // subject and metadata, and refuse anything claimed by a submission.
        // Public/legacy or already shredded rows stay open for reconciliation.
        if (!row.userId) throw verificationObjectUnavailable();
        await resolveVerificationObject(db, { fileKey: row.key, userId: row.userId });
        await storage.delete(row.key);
        await db.storageOrphan.update({ where: { id: row.id }, data: { purgedAt: new Date() } });
        purged += 1;
        if (purged === limit) return purged;
      } catch (err) {
        log.error({ err, key: row.key }, '[F-026-02] storage-orphan retry failed — stays open');
      }
    }
    if (rows.length < pageSize) break;
    const next = rows[rows.length - 1]!;
    if (next.id === after?.id) throw new Error('Storage orphan census cursor did not advance');
    after = { id: next.id, createdAt: next.createdAt };
  }
  return purged;
}
