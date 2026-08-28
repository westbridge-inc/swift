import { describe, it, expect } from 'vitest';
import { cashMathForOffer } from '../modules/dispatch/dispatch.service';

/**
 * [WS-6.0] THE CASH-MATH TRIPLE ON THE OFFER CARD.
 *
 * A mover accepting a CASH job is committing their own float: they collect the
 * whole order total at the door and hand the store its share. The offer card
 * showed only what they EARN, so the accept/decline decision was made without
 * the exposure beside it — on a $12,875 order, the difference between "you get
 * $500" and "collect $12,875, hand over $12,375, keep $500".
 *
 * ── WHY THIS IS SAFE TO COMPUTE, AND WHERE IT STOPS ────────────────────────
 *
 * Every number is a STORED COLUMN, not invented arithmetic:
 *
 *   collectFromCustomer  order.totalAmount
 *   payToVendor          order.subtotalCustomer — safe as the store's cut only
 *                        because `subtotalMarkup` is law-bound to zero ("V1
 *                        dormant — zero-commission model: markup must stay 0",
 *                        schema.prisma), so subtotalCustomer === subtotalBase.
 *   youKeep              deliveryFee + tipAmount — the SAME expression
 *                        `createEarnings` uses for the earnings rows and the
 *                        MMG settlement debt. Not a second definition of pay.
 *
 * And it REFUSES rather than guesses. `serviceFee`, `taxAmount` and `discount`
 * sit between the subtotal and the total. They are zero today and a
 * zero-commission cash-direct model defines no recipient for them, so the
 * moment one is non-zero the three numbers stop describing the money and the
 * function returns null — the card renders nothing rather than a split that
 * does not add up.
 *
 * These tests exist because the refusal is the load-bearing half. A version
 * that returned a plausible-looking breakdown for an order it could not
 * reconcile would be worse than the gap it closes.
 */

const base = {
  paymentMethod: 'CASH',
  totalAmount: 900,
  subtotalCustomer: 400,
  deliveryFee: 500,
  serviceFee: 0,
  taxAmount: 0,
  tipAmount: 0,
  discount: 0,
};

describe('the triple, on a real reconciling order', () => {
  it('computes collect / pay / keep from stored columns', () => {
    // The exact order used in the live offer run: SW-260716-0032DB.
    expect(cashMathForOffer(base)).toEqual({
      collectFromCustomer: 900,
      payToVendor: 400,
      youKeep: 500,
    });
  });

  it('a tip is the mover’s, on top of the fee', () => {
    const withTip = { ...base, tipAmount: 300, totalAmount: 1200 };
    expect(cashMathForOffer(withTip)).toEqual({
      collectFromCustomer: 1200,
      payToVendor: 400,
      youKeep: 800, // 500 fee + 300 tip — createEarnings' own expression
    });
  });

  it('collect minus pay always equals keep', () => {
    for (const tip of [0, 250, 1000]) {
      const o = { ...base, tipAmount: tip, totalAmount: 900 + tip };
      const m = cashMathForOffer(o)!;
      expect(m).not.toBeNull();
      expect(m.collectFromCustomer - m.payToVendor).toBe(m.youKeep);
    }
  });

  it('handles Decimal-shaped values (Prisma returns objects, not numbers)', () => {
    // The real call site passes Prisma Decimals. `Number()` on a Decimal works;
    // this pins that the function does not assume primitives.
    const asDecimals = Object.fromEntries(
      Object.entries(base).map(([k, v]) => [k, k === 'paymentMethod' ? v : { toString: () => String(v) }]),
    ) as any;
    expect(cashMathForOffer(asDecimals)).toEqual({
      collectFromCustomer: 900,
      payToVendor: 400,
      youKeep: 500,
    });
  });
});

describe('it refuses rather than showing a split it cannot prove', () => {
  it('returns null when a service fee has no defined recipient', () => {
    // 400 + 500 + 50 !== 900 — someone is owed 50 and the model does not say
    // who. Showing "collect 900, pay 400, keep 500" would be a lie by 50.
    expect(cashMathForOffer({ ...base, serviceFee: 50 })).toBeNull();
  });

  it('returns null when tax sits unexplained between subtotal and total', () => {
    expect(cashMathForOffer({ ...base, taxAmount: 25 })).toBeNull();
  });

  it('returns null when a discount breaks the identity', () => {
    expect(cashMathForOffer({ ...base, discount: 100 })).toBeNull();
  });

  it('returns null when the totals simply do not add up', () => {
    expect(cashMathForOffer({ ...base, totalAmount: 950 })).toBeNull();
  });

  it('returns null on a non-finite value rather than rendering NaN', () => {
    expect(cashMathForOffer({ ...base, totalAmount: 'not a number' })).toBeNull();
    expect(cashMathForOffer({ ...base, deliveryFee: null })).toBeNull();
  });

  it('reconciles in MINOR units so decimal representation cannot decide it', () => {
    // 0.1 + 0.2 !== 0.3 in float. A naive check would reject this real order.
    const penny = {
      ...base,
      subtotalCustomer: 0.1,
      deliveryFee: 0.2,
      tipAmount: 0,
      totalAmount: 0.3,
    };
    expect(cashMathForOffer(penny)).toEqual({
      collectFromCustomer: 0.3,
      payToVendor: 0.1,
      youKeep: 0.2,
    });
  });
});

describe('it is a CASH-only concept', () => {
  it('returns null on MMG — the customer already paid the store', () => {
    // On MMG the money went to the vendor's wallet and the STORE owes the
    // MOVER (DeliveryCashSettlement). Showing "collect from the customer"
    // there would instruct the mover to take money twice.
    expect(cashMathForOffer({ ...base, paymentMethod: 'MOBILE_MONEY' })).toBeNull();
  });

  it('returns null for any other method', () => {
    expect(cashMathForOffer({ ...base, paymentMethod: 'CARD' })).toBeNull();
  });
});
