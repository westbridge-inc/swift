import { describe, expect, it } from 'vitest';
import { MAX_CART_QTY, clampQty, isBooking, maxQtyFor, nextSend } from './cartSteppers';

// ---------------------------------------------------------------------------
// [BOOK-POLISH · #2205] A booking (APPOINTMENT) line is ONE appointment: the
// server refuses any other number (APPOINTMENT_QUANTITY), so the app never
// offers or sends one. Goods keep 1..99.
// ---------------------------------------------------------------------------

describe('[BOOK-POLISH] the most a line may be tapped to', () => {
  it('a booking line or listing is a booking; anything else (or nothing) is not', () => {
    expect(isBooking({ fulfillment: 'APPOINTMENT' })).toBe(true);
    for (const f of ['DELIVERY', 'PICKUP', undefined, null, 'appointment']) expect(isBooking({ fulfillment: f }), String(f)).toBe(false);
    expect(isBooking(null)).toBe(false);
    expect(isBooking(undefined)).toBe(false);
  });

  it('a booking line is at most 1; goods (and a line not known yet) at most 99', () => {
    expect(maxQtyFor({ fulfillment: 'APPOINTMENT' })).toBe(1);
    expect(maxQtyFor({ fulfillment: 'DELIVERY' })).toBe(MAX_CART_QTY);
    expect(maxQtyFor(null)).toBe(MAX_CART_QTY);
  });

  it('clamp: a booking tapped to 2 is 1, to 0 is 0; goods clamp at 99 as before', () => {
    const booking = maxQtyFor({ fulfillment: 'APPOINTMENT' });
    expect(clampQty(2, booking)).toBe(1);
    expect(clampQty(0, booking)).toBe(0);
    expect(clampQty(-3, booking)).toBe(0);
    expect(clampQty(150)).toBe(99);
    expect(clampQty(7)).toBe(7);
    expect(clampQty(Number.NaN)).toBe(0);
  });

  it('a booking line held at 1, tapped to 2, has nothing to send', () => {
    const line = { id: 'l1', quantity: 1, fulfillment: 'APPOINTMENT' };
    expect(nextSend(clampQty(2, maxQtyFor(line)), line)).toBeNull();
  });
});
