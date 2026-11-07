import { describe, expect, it } from 'vitest';
import { cartVatRows, type CartQuote } from './cartQuote';

// [STORE-VAT · owner O-5] The cart names the VAT a person-approved VAT store's goods already include, from the server's
// quote, and adds nothing to the total. Other stores, and an older server (no `vat`), show no VAT line.

const store = (vendorId: string, name: string, vat: unknown) =>
  ({ vendorId, name, fulfillment: 'DELIVERY', subtotal: 1600, deliveryFee: 800, minOrderAmount: 0, meetsMinimum: true, vat });
const inc = { included: 123, ratePercent: 14, standardGoods: 1000, zeroRatedGoods: 600, exemptGoods: 0 };

describe('[O-5] cart VAT notes', () => {
  it('one VAT store: the plain line', () => {
    expect(cartVatRows({ vendors: [store('v1', 'Sample Shop', inc)] } as CartQuote)).toEqual([
      { vendorId: 'v1', text: "Includes VAT of $123 (14%) on this store's goods" },
    ]);
  });

  it('several stores: only the VAT store, named', () => {
    expect(cartVatRows({ vendors: [store('v1', 'Sample Shop', inc), store('v2', 'Other Kitchen', null)] } as CartQuote)).toEqual([
      { vendorId: 'v1', text: "Sample Shop: includes VAT of $123 (14%) on this store's goods" },
    ]);
  });

  it('no VAT store, or an older server: nothing', () => {
    expect(cartVatRows({ vendors: [store('v2', 'Other Kitchen', null)] } as CartQuote)).toEqual([]);
    expect(cartVatRows({ vendors: [{ ...store('v3', 'Old', undefined) }] } as CartQuote)).toEqual([]);
    expect(cartVatRows(null)).toEqual([]);
  });
});
