import type { OrderStatus, Prisma } from '@prisma/client';

/** [O-2 · owner 22 Oct 2026] The status-log note of the store's one-tap "Handed to rider". The row
 *  carries the order's status at the tap (READY_FOR_PICKUP or a rider pre-custody status): it is
 *  evidence, not a transition. */
export const HANDED_TO_RIDER_NOTE = 'Handed to the rider by the store';

/**
 * The status-log rows that COUNT a mover's assignment episodes (the dispatch journal compares this
 * count before and after an assignment). The store's "Handed to rider" row can be written while the
 * order sits at RIDER_ASSIGNED; it is not an assignment, so it is left out. Every counter of
 * assignment episodes uses this ONE predicate, so they always agree. (`note` is nullable: a bare
 * `not` would also drop rows with no note.)
 */
export function assignmentLogWhere(orderId: string, status: OrderStatus): Prisma.OrderStatusLogWhereInput {
  return { orderId, status, OR: [{ note: null }, { note: { not: HANDED_TO_RIDER_NOTE } }] };
}
