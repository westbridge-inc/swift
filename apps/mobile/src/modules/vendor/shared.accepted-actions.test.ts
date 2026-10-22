import { describe, expect, it } from 'vitest';
import { mmgAwaitingMoney, orderActions } from './shared';

// [O-3 · REVIEW-F S4-1 on #2024] Accept now starts preparation, so an order still ACCEPTED is an MMG
// order waiting for its money (or a pre-order for later). For the unpaid MMG one the server refuses
// "Start preparing" on every tap: the store's next step is "Paid by MMG" on the order's card.

const accepted = { status: 'ACCEPTED', fulfillment: 'DELIVERY', orderType: 'FOOD_DELIVERY', mmgClaimMismatchAt: null };
const labels = (order: object) => orderActions(order).map((a) => a.label);

describe('the actions of an accepted store order', () => {
  it('an MMG order still waiting for its money has no forward button', () => {
    expect(labels({ ...accepted, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })).toEqual([]);
    expect(mmgAwaitingMoney({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'AUTHORIZED' })).toBe(true);
  });

  it('once the money moved (Paid by MMG), or on cash, "Start preparing" is offered', () => {
    expect(labels({ ...accepted, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' })).toEqual(['Start preparing']);
    expect(labels({ ...accepted, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' })).toEqual(['Start preparing']);
    expect(labels({ ...accepted, paymentMethod: 'CASH', paymentStatus: 'PENDING' })).toEqual(['Start preparing']);
  });

  it('a booking keeps its own step', () => {
    expect(labels({ ...accepted, fulfillment: 'APPOINTMENT', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })).toEqual(['Mark complete']);
  });
});
