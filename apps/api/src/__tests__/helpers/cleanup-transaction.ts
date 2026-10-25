import type { Prisma, PrismaClient } from '@prisma/client';

/** The production audit purge helpers open their own transaction: today an
 * interactive one (a callback, lib/audit-immutability), earlier a query batch.
 * In fixture cleanup either must join the already-open locked transaction:
 * the callback runs on that tx, the batch's lazy queries execute on it in
 * order, and nothing commits early. No nested transaction is ever opened. */
export function auditClientInCleanup(tx: Prisma.TransactionClient): PrismaClient {
  return new Proxy(tx, {
    get(target, key, receiver) {
      if (key === '$transaction') return async (queries: unknown) => {
        if (typeof queries === 'function') return (queries as (client: Prisma.TransactionClient) => unknown)(target);
        if (!Array.isArray(queries)) throw new Error('Fixture audit cleanup requires a query batch or a callback');
        const results: unknown[] = [];
        for (const query of queries) results.push(await query);
        return results;
      };
      return Reflect.get(target, key, receiver);
    },
  }) as PrismaClient;
}
