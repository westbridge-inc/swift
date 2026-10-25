/**
 * [R14 · legal research D12 · owner 15 Oct 2026] When a store delivers an order with its OWN rider (its per-order
 * "We'll deliver" choice, `fulfillmentMode = VENDOR_DELIVERY`), the customer's order screen says so, verbatim:
 * the rider is the store's, not Swift's. Licensing and insurance duties for that rider sit with the store; Swift
 * keeps the duty for what it says — so it never lets a store's rider pass as one of its own.
 *
 * Read from THAT order's current fulfilment mode on every order read, never guessed by a client: it appears the
 * moment the store chooses to deliver and goes if the order is handed back to a Swift rider. A pickup, a courier
 * parcel or a taxi ride is never a store's own delivery.
 */
export const OWN_RIDER_NOTICE = "This order is delivered by the store's own rider, not a Swift rider.";

export function ownRiderNotice(order: { fulfillment: string | null; fulfillmentMode: string | null; orderType: string | null }): string | null {
  return order.fulfillment === 'DELIVERY'
    && order.fulfillmentMode === 'VENDOR_DELIVERY'
    && order.orderType !== 'COURIER'
    && order.orderType !== 'TAXI'
    ? OWN_RIDER_NOTICE
    : null;
}
