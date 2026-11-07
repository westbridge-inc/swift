import type { OrderStatus } from '@prisma/client';

/**
 * [BUG-HUNT F12] Where an order is, in the words a person reads. A refusal used to print the status code itself
 * ("Cannot accept order in PREPARING status"); on a weak signal that was the normal answer to a second tap, and the
 * first tap had worked. Every refusal about an order's stage is built here. A new status does not compile until it has
 * its words.
 */
const STAGE_WORDS: Record<OrderStatus, string> = {
  PENDING: 'waiting for the store',
  ACCEPTED: 'accepted',
  PREPARING: 'being prepared',
  READY_FOR_PICKUP: 'ready',
  RIDER_ASSIGNED: 'with a rider',
  RIDER_EN_ROUTE_PICKUP: 'with a rider',
  RIDER_ARRIVED_PICKUP: 'with a rider',
  PICKED_UP: 'on its way',
  EN_ROUTE_DELIVERY: 'on its way',
  ARRIVED: 'at the door',
  DRIVER_ASSIGNED: 'with a driver',
  DRIVER_EN_ROUTE: 'with a driver',
  DRIVER_ARRIVED: 'with a driver',
  RIDE_IN_PROGRESS: 'under way',
  DELIVERED: 'delivered',
  COMPLETED: 'finished',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  FAILED: 'closed',
  RETURNING: 'on its way back',
  RETURNED: 'back with the store',
};

/** "This order is cancelled, so it cannot be accepted." `outcome` says what that means for this tap. */
export function orderStageRefusal(status: string, outcome: string, noun: 'order' | 'ride' = 'order'): string {
  const stage = STAGE_WORDS[status as OrderStatus];
  return stage ? `This ${noun} is ${stage}, so ${outcome}.` : `This ${noun} has moved on, so ${outcome}.`;
}

/** The refusal for a step the order has moved past: the tap asked for nothing that can happen now. */
export const STEP_GONE = 'this step no longer applies';
