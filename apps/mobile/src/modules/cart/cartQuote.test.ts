import { describe, expect, it } from 'vitest';
import {
  cartPricingChoices, deliveryFeeRows, isBookingsOnly, pickupStoreNames, pricedTip,
  quoteStoreIds, quotedRiderTip, shortStores, type CartQuote,
} from './cartQuote';
import { checkoutTipAmount } from './checkout-tip';

// ---------------------------------------------------------------------------
// [E01 · E09] The cart screen asks the server to price exactly what the order
// button submits, submits the tip that quote was priced with, and renders the
// server's per-store rows. These are the pure rules behind that.
// ---------------------------------------------------------------------------

const lines = (...stores: Array<[string, string?]>) => stores.map(([vendorId, fulfillment]) => ({ vendorId, fulfillment: fulfillment ?? 'DELIVERY' }));

describe('the stores a quote prices', () => {
  it('come from the quote’s own lines — every store, once, sorted — not the one `cart.vendor` tracks', () => {
    expect(quoteStoreIds(lines(['far'], ['near'], ['far']))).toEqual(['far', 'near']);
    expect(quoteStoreIds([{ vendorId: undefined }, { vendorId: '' }, { vendorId: 3 }])).toEqual([]);
    expect(quoteStoreIds(undefined)).toEqual([]);
  });
  it('a cart of bookings only has no rider and no pickup counter', () => {
    expect(isBookingsOnly(lines(['salon', 'APPOINTMENT']))).toBe(true);
    expect(isBookingsOnly(lines(['salon', 'APPOINTMENT'], ['near']))).toBe(false);
    expect(isBookingsOnly([])).toBe(false);
  });
});

describe('ONE set of choices for the quote and the order', () => {
  const base = { mode: 'DELIVERY' as const, express: false, storeIds: ['far', 'near'], bookingsOnly: false, selectedTip: null };

  it('delivery with no choices made asks for checkout’s defaults — nothing to send', () => {
    expect(cartPricingChoices(base)).toEqual({});
  });
  it('the one pickup toggle collects from EVERY store, carries no tip, and drops express', () => {
    expect(cartPricingChoices({ ...base, mode: 'PICKUP', express: true, selectedTip: 500 })).toEqual({
      fulfillmentSelections: { far: 'PICKUP', near: 'PICKUP' },
      tipAmount: 0,
    });
  });
  it('express is asked for only on a delivery', () => {
    expect(cartPricingChoices({ ...base, express: true })).toEqual({ express: true });
  });
  it('[F-013-01] the customer’s own tip — including an explicit "No tip" — is sent; none chosen is left to the cart’s', () => {
    expect(cartPricingChoices({ ...base, selectedTip: 500 })).toEqual({ tipAmount: 500 });
    expect(cartPricingChoices({ ...base, selectedTip: 0 })).toEqual({ tipAmount: 0 });
    expect(cartPricingChoices({ ...base, selectedTip: null })).not.toHaveProperty('tipAmount');
  });
  it('bookings only: no pickup selection and no tip, whatever the toggle says', () => {
    expect(cartPricingChoices({ ...base, mode: 'PICKUP', bookingsOnly: true, selectedTip: 500 })).toEqual({ tipAmount: 0 });
  });
});

describe('the tip submitted is the tip the quote was priced with', () => {
  it('the chosen tip; else the cart tip the server priced and echoed', () => {
    expect(pricedTip({ tipAmount: 500 }, { tipAmount: 300 })).toBe(500);
    expect(pricedTip({ tipAmount: 0 }, { tipAmount: 300 })).toBe(0);
    expect(pricedTip({}, { tipAmount: '300.00' })).toBe(300);
    expect(pricedTip({}, null)).toBe(0);
  });

  it('is F-013-01’s checkout tip in every state — local intent outranks the persisted tip, no rider means no tip', () => {
    for (const mode of ['DELIVERY', 'PICKUP'] as const) {
      for (const bookingsOnly of [false, true]) {
        for (const selectedTip of [null, 0, 200, 1000]) {
          for (const persisted of [null, 0, 500]) {
            const choices = cartPricingChoices({ mode, express: false, storeIds: ['a'], bookingsOnly, selectedTip });
            // The server echoes the tip it priced: the sent one, else the cart's.
            const quote: CartQuote = { tipAmount: choices.tipAmount ?? persisted };
            const pickup = !bookingsOnly && mode === 'PICKUP';
            expect(pricedTip(choices, quote), JSON.stringify({ mode, bookingsOnly, selectedTip, persisted }))
              .toBe(checkoutTipAmount({ pickupOrApptOnly: pickup || bookingsOnly, selectedTip, cartTip: persisted }));
          }
        }
      }
    }
  });
});

describe('the summary rows are the server’s per-store rows', () => {
  const store = (vendorId: string, fulfillment: string, fee: number, extra: Partial<NonNullable<CartQuote['vendors']>[number]> = {}) => ({
    vendorId, name: `Store ${vendorId}`, fulfillment, subtotal: 1000, deliveryFee: fee, standardDeliveryFee: fee,
    tipAmount: 0, minOrderAmount: 0, meetsMinimum: true, amountToMinimum: 0, ...extra,
  });

  it('two delivered stores → one fee row each, before the express premium', () => {
    const quote: CartQuote = { vendors: [store('near', 'DELIVERY', 858, { standardDeliveryFee: 572 }), store('far', 'DELIVERY', 1230, { standardDeliveryFee: 820 })] };
    expect(deliveryFeeRows(quote)).toEqual({ kind: 'perStore', rows: [
      { vendorId: 'near', name: 'Store near', fee: 572 },
      { vendorId: 'far', name: 'Store far', fee: 820 },
    ] });
  });
  it('one delivered store (beside a pickup or a booking) → the one "Delivery fee" row; none delivered → no row', () => {
    expect(deliveryFeeRows({ vendors: [store('near', 'PICKUP', 0), store('far', 'DELIVERY', 820)] })).toEqual({ kind: 'single', fee: 820 });
    expect(deliveryFeeRows({ vendors: [store('salon', 'APPOINTMENT', 0), store('far', 'DELIVERY', 820)] })).toEqual({ kind: 'single', fee: 820 });
    expect(deliveryFeeRows({ vendors: [store('near', 'PICKUP', 0), store('far', 'PICKUP', 0)] })).toBeNull();
    expect(deliveryFeeRows(null)).toBeNull();
  });
  it('an older API (no per-store rows) keeps its one fee row', () => {
    expect(deliveryFeeRows({ deliveryFee: 700 })).toEqual({ kind: 'single', fee: 700 });
  });
  it('the rider tip shown is the tip inside the quoted total', () => {
    expect(quotedRiderTip({ vendors: [store('near', 'PICKUP', 0), store('far', 'DELIVERY', 820, { tipAmount: 500 })] }, 999)).toBe(500);
    expect(quotedRiderTip({ vendors: [store('near', 'PICKUP', 0)] }, 999)).toBe(0);
    expect(quotedRiderTip({}, 300)).toBe(300);
  });
  it('a pickup quote names every store to collect from', () => {
    expect(pickupStoreNames({ vendors: [store('near', 'PICKUP', 0), store('far', 'PICKUP', 0), store('salon', 'APPOINTMENT', 0)] })).toEqual(['Store near', 'Store far']);
  });
});

describe('[E09] each short store is named with the amount still to add', () => {
  it('only the stores below their own minimum, with the server’s shortfall', () => {
    const quote: CartQuote = {
      vendors: [
        { vendorId: 'near', name: 'Near', fulfillment: 'DELIVERY', subtotal: 1200, deliveryFee: 572, minOrderAmount: 1000, meetsMinimum: true, amountToMinimum: 0 },
        { vendorId: 'big', name: 'Big', fulfillment: 'DELIVERY', subtotal: 3000, deliveryFee: 820, minOrderAmount: 5000, meetsMinimum: false, amountToMinimum: 2000 },
      ],
    };
    expect(shortStores(quote)).toEqual([{ vendorId: 'big', name: 'Big', minOrderAmount: 5000, amountToAdd: 2000 }]);
    expect(shortStores({})).toEqual([]);
  });
});
