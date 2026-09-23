import type { OrderVertical } from '@swift/types';

// ---------------------------------------------------------------------------
// THE DECLARED VERTICAL OF AN ORDER — ONE discriminator, owned by the API.
//
// The persisted `OrderType` enum has no SERVICE member: a barbershop's
// appointment is stored on the FOOD_DELIVERY spine (schema.prisma `OrderType`
// = FOOD_DELIVERY | GROCERY_DELIVERY | COURIER | TAXI), distinguished only by
// its APPOINTMENT fulfillment. Every customer projection exposed that enum as
// the vertical, so the phone described a haircut with a kitchen's words and
// the marketplace hold/cancellation presentation (owner-observed, 2026-09-22).
//
// The mobile label authority recorded the two honest resolutions: add the
// enum member (a migration whose rollback PostgreSQL cannot express, touching
// dispatch, load, RLP, stacking and raw SQL consumers of orderType), or DECLARE
// the discriminator here and send it beside `orderType`. This is the second.
// The persisted spine is untouched — food, grocery, retail, taxi and courier
// read exactly what they read before — and no client re-derives it. Adding
// SERVICE to the enum itself remains the recorded taxonomy follow-up.
//
// What decides is the FULFILLMENT, not the business type. A service business
// also sells goods — shampoo from the barbershop, by delivery or pickup — and
// those are deliveries: the first cut declared every order at a SERVICE
// business SERVICE, so a shampoo delivery read "Booking confirmed" and lost its
// delivery stages on Home and the activity list (review F02). An appointment is
// a booking whichever business takes it; everything else keeps its own words.
//
// The type is the SHARED contract (`@swift/types`): the phone's vocabulary is
// asserted equal to it at compile time, so the declaration cannot be misspelt
// or widened on one side without the other noticing.
// ---------------------------------------------------------------------------

export type { OrderVertical };

/** The structural minimum: the persisted type and the customer's fulfillment
 *  choice. A full row may ride along (`vendor` and the rest); the business
 *  type is deliberately NOT read — see above. */
export interface OrderVerticalInput {
  orderType: string;
  fulfillment?: string | null;
  vendor?: { vendorType?: string | null } | null;
}

/**
 * An appointment is SERVICE. A taxi is a taxi and a parcel is a parcel.
 * Everything else — including a service business's goods — keeps its
 * persisted words.
 */
export function orderVertical(order: OrderVerticalInput): OrderVertical {
  if (order.orderType === 'TAXI') return 'TAXI';
  if (order.orderType === 'COURIER') return 'COURIER';
  if (order.fulfillment === 'APPOINTMENT') return 'SERVICE';
  return order.orderType === 'GROCERY_DELIVERY' ? 'GROCERY_DELIVERY' : 'FOOD_DELIVERY';
}
