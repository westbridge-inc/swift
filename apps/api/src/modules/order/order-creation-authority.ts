import type { Prisma, UserStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';

export interface LockedOrderCustomer {
  id: string;
  tenantId: string;
}

/**
 * Serialize every customer Order insert with account deletion.
 *
 * This must be the first row lock taken by an order-creation transaction. The
 * deletion path takes the same User lock before it checks for active orders, so
 * either the order commits first and blocks deletion, or deletion commits first
 * and this live authority check rejects the stale authenticated request.
 */
export async function lockActiveOrderCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
  expectedTenantId: string,
): Promise<LockedOrderCustomer> {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    tenantId: string;
    status: UserStatus;
  }>>`
    SELECT "id", "tenantId", "status"
    FROM "users"
    WHERE "id" = ${customerId}
    FOR UPDATE /* customer-order-creation-authority */
  `;
  const customer = rows[0];
  if (!customer) {
    throw new AppError(404, 'NOT_FOUND', 'Account not found');
  }
  if (customer.status !== 'ACTIVE') {
    throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active and cannot place orders.');
  }
  if (customer.tenantId !== expectedTenantId) {
    throw new AppError(
      409,
      'CUSTOMER_TENANT_CHANGED',
      'Your account operator changed while this order was being placed. Please try again.',
    );
  }
  return { id: customer.id, tenantId: customer.tenantId };
}
