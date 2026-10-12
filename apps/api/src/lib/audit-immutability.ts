import type { PrismaClient, Prisma } from '@prisma/client';

/** Kept only for hostile tests proving that a caller-selected setting grants nothing. */
export const AUDIT_PURGE_SETTING = 'swift.audit_purge';
const MIN_REASON = 8;

function validateReason(reason: string): void {
  if (!reason || reason.trim().length < MIN_REASON) {
    throw new Error(`[ADM-003] an audit purge must name its reason (>= ${MIN_REASON} chars)`);
  }
}

/** Requires a separately provisioned purge executor client. Ordinary app logins
 * cannot call the SECURITY DEFINER function. No application membership is granted
 * by the migration; retained evidence has no automatic expiry policy. */
export async function purgeSensitiveReadLogs(
  prisma: PrismaClient,
  where: Prisma.SensitiveReadLogWhereInput,
  reason: string,
): Promise<number> {
  validateReason(reason);
  let total = 0;
  for (;;) {
    const removed = await prisma.$transaction(async (tx) => {
      const rows = await tx.sensitiveReadLog.findMany({ where, select: { id: true }, take: 1000 });
      if (!rows.length) return 0;
      const [result] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT public.swift_purge_sensitive_read_logs(${rows.map(row => row.id)}::text[], ${reason}::text) AS count`;
      return result!.count;
    });
    total += removed;
    if (!removed) return total;
  }
}

/** Same explicit-id authority for the admin audit trail. */
export async function purgeAuditLogs(
  prisma: PrismaClient,
  where: Prisma.AuditLogWhereInput,
  reason: string,
): Promise<number> {
  validateReason(reason);
  let total = 0;
  for (;;) {
    const removed = await prisma.$transaction(async (tx) => {
      const rows = await tx.auditLog.findMany({ where, select: { id: true }, take: 1000 });
      if (!rows.length) return 0;
      const [result] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT public.swift_purge_audit_logs(${rows.map(row => row.id)}::text[], ${reason}::text) AS count`;
      return result!.count;
    });
    total += removed;
    if (!removed) return total;
  }
}
