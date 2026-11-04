/**
 * [BUG-HUNT F17] What the customer is told when an order is ready and when it is delivered. The words follow the order:
 * a pickup customer has to go and collect it, and no rider ever comes; a store that delivers itself is bringing it; a
 * hardware or clothes order is not food.
 */
export interface OrderReadyFacts {
  fulfillment?: string | null;
  fulfillmentMode?: string | null;
  vendor?: { name?: string | null; vendorType?: string | null } | null;
}

export function orderReadyWords(orderNumber: string, order: OrderReadyFacts): { title: string; body: string } {
  const store = order.vendor?.name || 'the store';
  if (order.fulfillment === 'PICKUP') {
    return { title: 'Ready for pickup', body: `Your order ${orderNumber} is ready. Go to ${store} to collect it.` };
  }
  if (order.fulfillmentMode === 'VENDOR_DELIVERY') {
    return { title: 'Order ready', body: `Your order ${orderNumber} is ready. ${order.vendor?.name || 'The store'} is bringing it to you.` };
  }
  return {
    title: order.vendor?.vendorType === 'RESTAURANT' ? 'Food Ready!' : 'Order ready',
    body: `Your order ${orderNumber} is ready and waiting for a rider.`,
  };
}

/** "Enjoy your meal!" belongs to a meal. A parcel, a shop or a grocery order is just delivered. */
export function orderDeliveredWords(orderNumber: string, vendorType?: string | null): string {
  return `Your order ${orderNumber} has been delivered.${vendorType === 'RESTAURANT' ? ' Enjoy your meal!' : ''}`;
}
