import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * [ADM-003] The audit trail is append-only AT THE DATABASE.
 *
 * `audit_logs` carries a BEFORE UPDATE OR DELETE trigger (and a BEFORE
 * TRUNCATE one) that refuses outright — see the migration for why. UPDATE has
 * no exception at all: a correction to an audit row is a new audit row.
 *
 * DELETE has exactly one: a transaction that names itself a retention purge.
 * Everything else — a stray `deleteMany`, a cleanup someone adds in a service,
 * a compromised code path — fails with `restrict_violation`. This module is
 * the only place in the tree that may set the setting, and
 * `audit-append-only.test.ts` asserts that by census, so the exception cannot
 * quietly spread from here into the application.
 */
export const AUDIT_PURGE_SETTING = 'swift.audit_purge';

/** A purge must state a reason, because the row it removes stated one. */
const MIN_REASON = 8;

/**
 * [ADM-007] The same licence, for the access trail. Who looked at whose data
 * is the same kind of record as what an admin did to it, so it lives under the
 * same rule rather than a second one that could drift.
 */
export async function purgeSensitiveReadLogs(
  prisma: PrismaClient,
  where: Prisma.SensitiveReadLogWhereInput,
  reason: string,
): Promise<number> {
  if (!reason || reason.trim().length < MIN_REASON) {
    throw new Error(`[ADM-003] an audit purge must name its reason (>= ${MIN_REASON} chars)`);
  }
  const [, deleted] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, ${reason}, true)`,
    prisma.sensitiveReadLog.deleteMany({ where }),
  ]);
  return deleted.count;
}

/**
 * Remove audit rows under a named retention reason. The `set_config` is
 * transaction-local (`is_local = true`), so the licence exists for exactly the
 * statements batched with it and for no other connection or query.
 */
export async function purgeAuditLogs(
  prisma: PrismaClient,
  where: Prisma.AuditLogWhereInput,
  reason: string,
): Promise<number> {
  if (!reason || reason.trim().length < MIN_REASON) {
    throw new Error(`[ADM-003] an audit purge must name its reason (>= ${MIN_REASON} chars)`);
  }
  const [, deleted] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, ${reason}, true)`,
    prisma.auditLog.deleteMany({ where }),
  ]);
  return deleted.count;
}
