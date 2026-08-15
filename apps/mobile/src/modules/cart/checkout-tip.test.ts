import { describe, expect, it } from 'vitest';
import { checkoutTipAmount } from './checkout-tip';

describe('checkoutTipAmount', () => {
  it('uses an explicit No tip intent instead of the persisted tip', () => {
    expect(checkoutTipAmount({ pickupOrApptOnly: false, selectedTip: 0, cartTip: 500 })).toBe(0);
  });

  it('inherits the persisted tip when the customer has not made a local choice', () => {
    expect(checkoutTipAmount({ pickupOrApptOnly: false, selectedTip: null, cartTip: 500 })).toBe(500);
  });

  it('uses a local tip when the cart has no persisted tip', () => {
    expect(checkoutTipAmount({ pickupOrApptOnly: false, selectedTip: 1000, cartTip: null })).toBe(1000);
  });

  it('forces pickup and appointment-only baskets to zero because there is no rider', () => {
    expect(checkoutTipAmount({ pickupOrApptOnly: true, selectedTip: 500, cartTip: 500 })).toBe(0);
  });

  it('defaults an absent persisted tip to zero', () => {
    expect(checkoutTipAmount({ pickupOrApptOnly: false, selectedTip: null, cartTip: undefined })).toBe(0);
  });
});
