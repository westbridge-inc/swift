/**
 * [TAXI-FLOW 22 Oct 2026] Where "Track" goes for an order.
 *
 * The owner booked a taxi, tapped Track on Home's live card and landed on the
 * STORE tracking screen: a shopping-bag pin, "Sent to the store", "Preparing",
 * "have $800 ready for the seller or rider". A ride is not a store order; its
 * screen is Taxi, which reads the active ride itself and takes no params.
 *
 * The server's persisted `orderType` decides — never a guess from the words on
 * the card. Every other order keeps its tracking screen, exactly as before.
 */
export type OrderTrackRoute =
  | { screen: 'Taxi'; params: undefined }
  | { screen: 'Delivery'; params: { orderId: string } };

export function isTaxiOrder(order: { orderType?: string | null } | null | undefined): boolean {
  return order?.orderType === 'TAXI';
}

export function trackRouteFor(order: { id: string; orderType?: string | null }): OrderTrackRoute {
  return isTaxiOrder(order)
    ? { screen: 'Taxi', params: undefined }
    : { screen: 'Delivery', params: { orderId: order.id } };
}
