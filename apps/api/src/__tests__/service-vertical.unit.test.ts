import { describe, expect, it } from 'vitest';
import { orderVertical } from '../modules/order/order-vertical';

// ---------------------------------------------------------------------------
// THE DECLARED VERTICAL OF AN ORDER.
//
// The database has no SERVICE order type: a barbershop appointment is stored
// on the legacy FOOD_DELIVERY spine (`OrderType` = FOOD_DELIVERY |
// GROCERY_DELIVERY | COURIER | TAXI), distinguished only by its APPOINTMENT
// fulfillment and its SERVICE business. Every customer projection exposed that
// enum as the vertical, so the phone described a haircut with a kitchen's
// words and the marketplace hold/cancellation presentation.
//
// The API now DECLARES the discriminator here — the business type and the
// appointment fulfillment, per the mobile label test's recorded second option
// — and projects it as `vertical`. The persisted spine is untouched: food,
// grocery, retail, taxi and courier read exactly what they read before.
// ---------------------------------------------------------------------------

describe('orderVertical — SERVICE is declared from the business type and the appointment, not the persisted enum', () => {
  it('a SERVICE business appointment persisted as FOOD_DELIVERY is SERVICE', () => {
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vendor: { vendorType: 'SERVICE' } })).toBe('SERVICE');
  });

  it('the business type alone does NOT decide: a service business’s goods sold by delivery or pickup keep their delivery words [R2 F02]', () => {
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'SERVICE' } })).toBe('FOOD_DELIVERY');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', vendor: { vendorType: 'SERVICE' } })).toBe('FOOD_DELIVERY');
  });

  it('the appointment alone decides when the vendor relation was not loaded', () => {
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT' })).toBe('SERVICE');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vendor: null })).toBe('SERVICE');
  });

  it('food, grocery and retail keep their persisted words (preserved, not re-expressed)', () => {
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'RESTAURANT' } })).toBe('FOOD_DELIVERY');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', vendor: { vendorType: 'RESTAURANT' } })).toBe('FOOD_DELIVERY');
    expect(orderVertical({ orderType: 'GROCERY_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'SUPERMARKET' } })).toBe('GROCERY_DELIVERY');
    // Retail rides the FOOD_DELIVERY spine today; separating it is a recorded
    // follow-up, not something this discriminator invents.
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'STORE' } })).toBe('FOOD_DELIVERY');
  });

  it('taxi and courier pass through untouched, with or without a vendor', () => {
    expect(orderVertical({ orderType: 'TAXI', fulfillment: 'DELIVERY', vendor: null })).toBe('TAXI');
    expect(orderVertical({ orderType: 'COURIER', fulfillment: 'DELIVERY', vendor: null })).toBe('COURIER');
    expect(orderVertical({ orderType: 'COURIER' })).toBe('COURIER');
  });

  it('with nothing but the persisted type, the persisted type is the answer', () => {
    expect(orderVertical({ orderType: 'FOOD_DELIVERY' })).toBe('FOOD_DELIVERY');
    expect(orderVertical({ orderType: 'GROCERY_DELIVERY', fulfillment: null, vendor: { vendorType: null } })).toBe('GROCERY_DELIVERY');
  });
});
