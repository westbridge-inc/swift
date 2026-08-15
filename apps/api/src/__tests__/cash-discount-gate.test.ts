import { describe, it, expect } from 'vitest';
import { assertCashDiscountSponsored } from '../modules/order/order.service';

// ---------------------------------------------------------------------------
// [SPS-F-0022] The CASH-discount sponsor law. Traced 2026-08-11: a platform
// rider fronts the vendor subtotalBase (promo-blind: rider.routes float gate,
// dispatch claim commit, float.service doctrine) and collects the DISCOUNTED
// total (checkout: subtotalCustomer + fee + tip − discount) — so on CASH
// platform-delivery the RIDER finances the promo out of their fee. That
// combination fails closed until the vendor-funded fronting rail exists and
// the founder approves it. Every other combination is naturally vendor-funded
// and stays open.
// ---------------------------------------------------------------------------

describe('the CASH-discount sponsor gate', () => {
  it('refuses a discounted CASH platform-delivery checkout — the rider must never finance a promo', () => {
    expect(() =>
      assertCashDiscountSponsored({ paymentMethod: 'CASH', discount: 500, fulfillments: ['DELIVERY'] }),
    ).toThrowError(expect.objectContaining({ code: 'PROMO_UNAVAILABLE_CASH_DELIVERY' }));
  });

  it('refuses when ANY plan in a multi-vendor basket is a delivery', () => {
    expect(() =>
      assertCashDiscountSponsored({ paymentMethod: 'CASH', discount: 100, fulfillments: ['PICKUP', 'DELIVERY'] }),
    ).toThrowError(expect.objectContaining({ code: 'PROMO_UNAVAILABLE_CASH_DELIVERY' }));
  });

  it('CASH pickup keeps its promos — the store collects its own discounted amount', () => {
    expect(() =>
      assertCashDiscountSponsored({ paymentMethod: 'CASH', discount: 500, fulfillments: ['PICKUP'] }),
    ).not.toThrow();
  });

  it('MMG delivery keeps its promos — the store receives the discounted total directly', () => {
    expect(() =>
      assertCashDiscountSponsored({ paymentMethod: 'MOBILE_MONEY', discount: 500, fulfillments: ['DELIVERY'] }),
    ).not.toThrow();
  });

  it('no discount, no gate', () => {
    expect(() =>
      assertCashDiscountSponsored({ paymentMethod: 'CASH', discount: 0, fulfillments: ['DELIVERY'] }),
    ).not.toThrow();
  });
});
