import type { FastifyInstance } from 'fastify';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { AccountService } from './account.service';

/** The deletion marker commits before cleanup. It is a durable retry census,
 * including accounts cut off by earlier releases. Scan with a keyset so a
 * failing early account never starves later accounts. Re-sweeps are idempotent;
 * no client session or successful queue enqueue is needed after cutoff. */
export async function retryAccountErasures(app: Pick<FastifyInstance, 'prisma' | 'io' | 'log'>) {
  let cursor: string | undefined;
  let retried = 0;
  let failed = 0;
  for (;;) {
    const users = await runAsSystem('account-erasure-retry-census', () => app.prisma.user.findMany({
      where: { phone: { startsWith: 'deleted:' }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' }, take: 100, select: { id: true, tenantId: true, phone: true },
    }));
    if (!users.length) break;
    for (const user of users) {
      // A prefix alone is not erasure authority.
      if (user.phone !== `deleted:${user.id}`) continue;
      try {
        await runWithTenant(user.tenantId, () => new AccountService(app).deleteAccount(user.id));
        retried += 1;
      } catch (error) {
        failed += 1;
        app.log.error({ err: error, userId: user.id }, 'Account erasure retry failed; marker retained');
      }
    }
    cursor = users[users.length - 1]!.id;
  }
  if (failed) throw new Error(`Account erasure sweep: ${failed} failed, ${retried} retried; obligations retained`);
  return { retried };
}
