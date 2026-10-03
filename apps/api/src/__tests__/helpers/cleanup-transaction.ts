import type { Prisma, PrismaClient } from '@prisma/client';

/** The production audit purge helper accepts a client with batch transactions.
 * In fixture cleanup its batch must join the already-open locked transaction:
 * sequentially execute its lazy queries on that tx, without committing early.
 * Interactive/nested transactions are deliberately unsupported here. */
export function auditClientInCleanup(tx: Prisma.TransactionClient): PrismaClient {
  return new Proxy(tx, {
    get(target, key, receiver) {
      if (key === '$transaction') return async (queries: unknown) => {
        if (!Array.isArray(queries)) throw new Error('Fixture audit cleanup requires a query batch');
        const results: unknown[] = [];
        for (const query of queries) results.push(await query);
        return results;
      };
      return Reflect.get(target, key, receiver);
    },
  }) as PrismaClient;
}
