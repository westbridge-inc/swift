/**
 * [AUD-G7-043] Suite teardown for the append-only admin trails a suite's own
 * users wrote (audit_logs, sensitive_read_logs).
 *
 * The purge functions refuse a reason shorter than eight characters, and
 * that refusal used to be swallowed (`'b2').catch(() => 0)`): the teardown
 * looked complete while every row stayed. This helper always names the
 * suite in the reason, lets a refusal or failure fail the teardown, and then
 * checks that nothing the suite's users wrote is left behind.
 */
import type { PrismaClient } from '@prisma/client';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';

export async function purgeFixtureAuditTrail(prisma: PrismaClient, userIds: string[], suite: string): Promise<void> {
  if (!userIds.length) return;
  const reason = `test-cleanup:${suite}`;
  await purgeSensitiveReadLogs(prisma, { actorUserId: { in: userIds } }, reason);
  await purgeAuditLogs(prisma, { userId: { in: userIds } }, reason);
  const audits = await prisma.auditLog.count({ where: { userId: { in: userIds } } });
  const reads = await prisma.sensitiveReadLog.count({ where: { actorUserId: { in: userIds } } });
  if (audits || reads) {
    throw new Error(`[AUD-G7-043] ${suite} teardown left ${audits} audit and ${reads} sensitive-read rows written by its own users`);
  }
}
