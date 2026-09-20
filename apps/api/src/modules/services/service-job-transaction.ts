import type { Prisma } from '@prisma/client';
import { bindTenantTransaction } from '../../plugins/prisma';

/**
 * Every interactive service-job transaction enters through the database's
 * canonical tenant binder before it can lock or query a row. This wrapper is
 * deliberately tiny: it preserves the request's AsyncLocalStorage tenant and
 * gives the ordering contract one executable seam.
 */
export async function runTenantBoundServiceJobTransaction<T>(
  tx: Prisma.TransactionClient,
  operation: (boundTx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  await bindTenantTransaction(tx);
  return operation(tx);
}
