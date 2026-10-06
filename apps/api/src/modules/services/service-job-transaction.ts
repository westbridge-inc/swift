import type { Prisma } from '@prisma/client';
import { bindTenantTransaction } from '../../plugins/prisma';

export interface ServiceJobTransactionHost {
  $transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

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

/**
 * Keep tenant binding and every lifecycle side effect inside the same
 * interactive-transaction callback. The service-free tests can inject a
 * deterministic rollback model at this seam; real PostgreSQL rollback/RLS
 * proof remains mandatory before merge.
 */
export async function executeTenantBoundServiceJobTransaction<T>(
  host: ServiceJobTransactionHost,
  operation: (boundTx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return host.$transaction((tx) => runTenantBoundServiceJobTransaction(tx, operation));
}
