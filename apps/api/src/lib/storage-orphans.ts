import type { PrismaClient } from '@prisma/client';

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

/** Retry the oldest open orphans; purged rows close, failures stay open for
 *  the next pass. Returns how many objects were actually deleted. */
export async function retryStorageOrphans(
  db: PrismaClient,
  storage: StorageLike,
  log: Logger,
  limit = 5,
): Promise<number> {
  const rows = await db.storageOrphan.findMany({
    where: { purgedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let purged = 0;
  for (const row of rows) {
    try {
      await storage.delete(row.key);
      await db.storageOrphan.update({ where: { id: row.id }, data: { purgedAt: new Date() } });
      purged += 1;
    } catch (err) {
      log.error({ err, key: row.key }, '[F-026-02] storage-orphan retry failed — stays open');
    }
  }
  return purged;
}
