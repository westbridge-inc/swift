// ---------------------------------------------------------------------------
// THE DECLARED VERTICAL OF AN ORDER — ONE discriminator, owned by the API.
//
// The persisted `OrderType` enum has no SERVICE member: a barbershop's
// appointment is stored on the FOOD_DELIVERY spine (schema.prisma `OrderType`
// = FOOD_DELIVERY | GROCERY_DELIVERY | COURIER | TAXI), distinguished only by
// its APPOINTMENT fulfillment and its SERVICE business. Every customer
// projection exposed that enum as the vertical, so the phone described a
// haircut with a kitchen's words and the marketplace hold/cancellation
// presentation (owner-observed, 2026-09-22).
//
// The mobile label authority recorded the two honest resolutions: add the
// enum member (a migration whose rollback PostgreSQL cannot express, touching
// dispatch, load, RLP, stacking and raw SQL consumers of orderType), or make
// the business type the DECLARED discriminator. This is the second. The
// persisted spine is untouched — food, grocery, retail, taxi and courier read
// exactly what they read before — and the server sends `vertical` beside
// `orderType` so no client re-derives it. Adding SERVICE to the enum itself
// remains the recorded taxonomy follow-up.
// ---------------------------------------------------------------------------

/** SERVICE is declared; every other value mirrors the persisted `OrderType`. */
export type OrderVertical = 'SERVICE' | 'FOOD_DELIVERY' | 'GROCERY_DELIVERY' | 'COURIER' | 'TAXI';

/** The structural minimum: the persisted type, the customer's fulfillment
 *  choice, and the business type when the vendor relation was loaded. */
export interface OrderVerticalInput {
  orderType: string;
  fulfillment?: string | null;
  vendor?: { vendorType?: string | null } | null;
}

/**
 * A SERVICE business's order, or any appointment, is SERVICE. A taxi is a
 * taxi and a parcel is a parcel. Everything else keeps its persisted words.
 */
export function orderVertical(order: OrderVerticalInput): OrderVertical {
  if (order.orderType === 'TAXI') return 'TAXI';
  if (order.orderType === 'COURIER') return 'COURIER';
  if (order.fulfillment === 'APPOINTMENT' || order.vendor?.vendorType === 'SERVICE') return 'SERVICE';
  return order.orderType === 'GROCERY_DELIVERY' ? 'GROCERY_DELIVERY' : 'FOOD_DELIVERY';
}
