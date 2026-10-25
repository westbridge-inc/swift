import { describe, expect, it } from 'vitest';
import { calendarDay, cartVat, cartVatLine, itemVatNote, orderVatLine, storefrontVat, storefrontVatLine, storeVatStatusLine, vatClassChoices } from './storeVat';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The phone's VAT words. VAT shows only where the server says a person-approved store's VAT is
// in effect; the price itself never changes (VAT Act s.90(2): the price includes VAT and says so); the rate and every
// amount come from the API; an older server (no `vat` field) shows nothing at all.
// ---------------------------------------------------------------------------

const vat = storefrontVat({ pricesIncludeVat: true, ratePercent: 14 });

describe('[O-5] storefront', () => {
  it('reads only the server’s exact shape; anything else (older server, null) is no VAT', () => {
    expect(vat).toEqual({ pricesIncludeVat: true, ratePercent: 14 });
    expect(storefrontVat(undefined)).toBeNull();
    expect(storefrontVat(null)).toBeNull();
    expect(storefrontVat({ pricesIncludeVat: 'yes', ratePercent: 14 })).toBeNull();
    expect(storefrontVat({ pricesIncludeVat: true })).toBeNull();
  });

  it('"incl. VAT" only beside a standard-rated item of an approved store', () => {
    expect(itemVatNote(vat, { vatClass: 'STANDARD' })).toBe('incl. VAT');
    expect(itemVatNote(vat, {})).toBe('incl. VAT'); // the server's default class
    expect(itemVatNote(vat, { vatClass: 'ZERO_RATED' })).toBeNull();
    expect(itemVatNote(vat, { vatClass: 'EXEMPT' })).toBeNull();
    expect(itemVatNote(null, { vatClass: 'STANDARD' })).toBeNull();
  });

  it('the store line carries the server’s rate', () => {
    expect(storefrontVatLine(vat)).toBe('Prices include VAT at 14% where it applies. Zero-rated and exempt items carry none.');
    expect(storefrontVatLine(storefrontVat({ pricesIncludeVat: true, ratePercent: 12.5 }))).toMatch(/^Prices include VAT at 12.5%/);
    expect(storefrontVatLine(null)).toBeNull();
  });
});

describe('[O-5] cart and order', () => {
  it('the cart says the VAT is INCLUDED in the store’s goods (never added)', () => {
    const v = cartVat({ included: 123, ratePercent: 14, standardGoods: 1000, zeroRatedGoods: 600, exemptGoods: 0 });
    expect(cartVatLine(v)).toBe('Includes VAT of $123 (14%) on this store\'s goods');
    expect(cartVat(null)).toBeNull();
    expect(cartVatLine(cartVat({ ratePercent: 14 }))).toBeNull();
  });

  it('a placed order shows the VAT it froze, from Decimal strings, with the seller', () => {
    expect(orderVatLine({ vatRateBps: 1400, vatAmount: '123.00', vatSellerName: 'Sample Shop Ltd' })).toBe('Includes VAT of $123 (14%), charged by Sample Shop Ltd');
    expect(orderVatLine({ vatRateBps: 1250, vatAmount: 111 })).toBe('Includes VAT of $111 (12.5%)');
    expect(orderVatLine({ vatRateBps: null, vatAmount: null })).toBeNull();
    expect(orderVatLine({})).toBeNull();
  });

  it('no line ever calls anything a tax invoice', () => {
    for (const line of [storefrontVatLine(vat), cartVatLine(cartVat({ included: 1, ratePercent: 14 })), orderVatLine({ vatRateBps: 1400, vatAmount: 1, vatSellerName: 'X' })]) {
      expect(String(line).toLowerCase()).not.toContain('invoice');
    }
  });
});

describe('[O-5 · REVIEW-F #2087 S4] item classes before and after approval', () => {
  it('never says VAT is inside the price before a person approved the store; the rate from the API after', () => {
    expect(vatClassChoices(14, false)[0]!.label).toBe('Standard (VAT once your VAT is approved)');
    expect(vatClassChoices(14, true)[0]!.label).toBe('Standard (14% VAT inside the price)');
  });
});

describe('[O-5 · REVIEW-F #2103 S4] the store’s approved line reads the date as a day', () => {
  it('"Approved from 1 Jan 2026", the calendar day itself (never the evening before), the same words as the web and the notice', () => {
    expect(calendarDay('2026-09-01T00:00:00.000Z')).toBe('1 Sep 2026');
    expect(storeVatStatusLine({
      status: 'APPROVED', effective: true, ratePercent: 14, reviewNote: null, certificate: null,
      approved: { number: '012345678', registeredName: 'Sample Shop Ltd', effectiveFrom: '2026-01-01T00:00:00.000Z' },
    })).toBe('Approved from 1 Jan 2026. Your prices include VAT at 14%, and receipts say “VAT charged by Sample Shop Ltd · VAT reg. no. 012345678”.');
  });
});
