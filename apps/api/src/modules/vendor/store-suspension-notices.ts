import type { Prisma, PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import { LIVE_ORDER_STATUSES, MOVER_HOLDING_STATUSES } from '../order/order-status';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G07] Swift suspends a store. The suspension touched no order: a customer with a live order heard nothing, and one
// who walked to the store for a ready pickup found it could not hand it over. Each is told once, in words true for their
// order. The reason Swift suspended the store is never in these words: it is about the store, not the customer.
// ---------------------------------------------------------------------------

const LIVE_AT_STORE: Prisma.OrderWhereInput = {
  status: { in: LIVE_ORDER_STATUSES.filter((status) => !MOVER_HOLDING_STATUSES.includes(status)) },
};

/** The customer's words for one order. */
export function storeSuspendedCustomerNotice(order: { orderNumber: string; status: string; fulfillment: string; paymentMethod: string | null }, storeName: string): { title: string; body: string } {
  const readyPickup = order.fulfillment === 'PICKUP' && order.status === 'READY_FOR_PICKUP';
  const title = `About your order at ${storeName}`;
  if (readyPickup) {
    return {
      title,
      body: order.paymentMethod === 'CASH'
        ? `Swift paused ${storeName}, so it cannot hand over your order ${order.orderNumber}. You can cancel it for free.`
        : `Swift paused ${storeName}, so it cannot hand over your order ${order.orderNumber}. Swift support closes it and records the refund the store owes you. Contact Swift support if you have a question.`,
    };
  }
  return { title, body: `Swift paused ${storeName}, so your order ${order.orderNumber} may not be finished. If you can't reach the store, contact Swift support.` };
}

/** One notice per live order, once, however often the store is suspended. Answers how many orders it found. */
export async function tellCustomersOfStoreSuspension(prisma: PrismaClient, notifications: NotificationService, vendorId: string, storeName: string): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { vendorId, ...LIVE_AT_STORE },
    select: { id: true, orderNumber: true, customerId: true, status: true, fulfillment: true, paymentMethod: true },
  });
  for (const order of orders) {
    await notifications.send({
      userId: order.customerId, type: 'ORDER_UPDATE', audience: 'customer', ...storeSuspendedCustomerNotice(order, storeName),
      data: { orderId: order.id, status: order.status }, dedupeKey: `store-suspended:${order.id}`,
    }).catch(() => undefined);
  }
  return orders.length;
}
