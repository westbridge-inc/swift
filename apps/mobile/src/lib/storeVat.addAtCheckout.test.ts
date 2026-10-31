import { describe, expect, it } from 'vitest';
import {
  VAT_DOCUMENT_ROW, VAT_MODE_CHOICES, beforeVatNote, editablePrice, itemPricePayload, storeVatStatusLine, vatModeHelp,
} from './storeVat';

// ---------------------------------------------------------------------------
// [VAT-DOCS · owner 30 Oct 2026] "Add VAT at checkout" on the phone: the store picks how its prices relate to VAT; an
// item Swift adds VAT to is edited by the price the store typed BEFORE VAT (the server adds the VAT and sends both); the
// Documents list carries the optional VAT certificate row. The rate always comes from the API.
// ---------------------------------------------------------------------------

describe('[VAT-DOCS] the two price choices', () => {
  it('in the owner’s words, the same as the web dashboard', () => {
    expect(VAT_MODE_CHOICES).toEqual([
      { value: 'PRICES_INCLUDE_VAT', label: 'My prices already include VAT' },
      { value: 'ADD_VAT_AT_CHECKOUT', label: 'My prices do not include VAT' },
    ]);
    expect(vatModeHelp('PRICES_INCLUDE_VAT', 14)).toBe('Customers pay the prices you type; receipts show the VAT inside them.');
    expect(vatModeHelp('ADD_VAT_AT_CHECKOUT', 14)).toBe('Once a person at Swift approves your certificate, Swift adds 14% VAT to the price you type for each '
      + 'standard-rated item, so customers see and pay the full price, VAT included, before they order. Zero-rated and exempt items stay as you type them.');
  });

  it('the approved line names what happens to the prices in each mode', () => {
    const approved = { status: 'APPROVED' as const, effective: true, ratePercent: 14, reviewNote: null, certificate: null,
      approved: { number: '012345678', registeredName: 'Shop Ltd', effectiveFrom: '2026-01-01T00:00:00.000Z' } };
    expect(storeVatStatusLine({ ...approved, mode: 'ADD_VAT_AT_CHECKOUT' })).toBe('Approved from 1 Jan 2026. Swift adds VAT at 14% to the prices you type for '
      + 'standard-rated items, and receipts say “VAT charged by Shop Ltd · VAT reg. no. 012345678”.');
    expect(storeVatStatusLine({ ...approved, mode: 'PRICES_INCLUDE_VAT' })).toBe(storeVatStatusLine(approved));
  });
});

describe('[VAT-DOCS] editing the price of an item Swift adds VAT to', () => {
  const added = { basePrice: 228, vatListedPrice: 200 };
  const plain = { basePrice: 600, vatListedPrice: null };

  it('the field starts at the price the store typed before VAT; every other item at its price', () => {
    expect(editablePrice(added)).toBe('200');
    expect(editablePrice(plain)).toBe('600');
    expect(editablePrice({ basePrice: '450.00' })).toBe('450'); // an older server, a Decimal string
    expect(editablePrice(null)).toBe('');
  });

  it('a save sends the price before VAT for such an item (the server adds the VAT), basePrice otherwise', () => {
    expect(itemPricePayload(added, 250)).toEqual({ vatListedPrice: 250 });
    expect(itemPricePayload(plain, 650)).toEqual({ basePrice: 650 });
    expect(itemPricePayload(undefined, 50)).toEqual({ basePrice: 50 }); // a new item: the price as typed
  });

  it('says what customers pay under the field, only for such an item', () => {
    expect(beforeVatNote(added)).toBe('Before VAT. Customers pay $228 incl. VAT.');
    expect(beforeVatNote(plain)).toBeNull();
    expect(beforeVatNote(undefined)).toBeNull();
  });
});

describe('[VAT-DOCS] the Documents list row', () => {
  it('is optional and says so', () => {
    expect(VAT_DOCUMENT_ROW.title).toBe('VAT certificate (only if VAT-registered)');
    expect(VAT_DOCUMENT_ROW.body).toBe('Only if your business is registered for VAT with the GRA. You do not need it to go live.');
  });
});
