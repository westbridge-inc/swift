import type { OrderStatus, Prisma } from '@prisma/client';

/**
 * Durable evidence that a taxi passenger has crossed the handoff boundary.
 *
 * `DRIVER_ARRIVED` plus a verified PIN is already passenger custody even
 * before the driver's subsequent `/start` request advances the status.  Both
 * persisted PIN fields are accepted independently so a partially-written
 * legacy row fails safe instead of making an occupied vehicle dispatchable.
 */
export interface TaxiPassengerCustodySnapshot {
  status: OrderStatus;
  ridePinVerified: boolean;
  ridePinVerifiedAt: Date | null;
}

export function hasTaxiPassengerCustody(order: TaxiPassengerCustodySnapshot): boolean {
  return order.status === 'RIDE_IN_PROGRESS'
    || order.ridePinVerified
    || order.ridePinVerifiedAt !== null;
}

/** All custody decisions serialize on the order row before re-reading it. */
export async function lockTaxiOrderForCustodyDecision(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
}
