import { describe, expect, it } from 'vitest';
import { beforeVatNote, editablePrice, itemPricePayload } from './vat-price-edit';

// [VAT-DOCS · owner 30 Oct 2026] An item Swift adds VAT to ("my prices do not include VAT", approved) is edited by the price
// the store typed BEFORE VAT; the server adds the VAT. Every other item, and every new one, by its price as typed.
describe('[VAT-DOCS] editing the price of an item Swift adds VAT to', () => {
  const added = { basePrice: 228, vatListedPrice: 200 };
  const plain = { basePrice: 600, vatListedPrice: null };

  it('the field starts at the price before VAT; every other item at its price', () => {
    expect(editablePrice(added)).toBe(200);
    expect(editablePrice(plain)).toBe(600);
    expect(editablePrice({ basePrice: '450.00' })).toBe(450);
    expect(editablePrice(null)).toBeNull();
  });

  it('a save sends vatListedPrice for such an item, basePrice otherwise (and for a new item)', () => {
    expect(itemPricePayload(added, 250)).toEqual({ vatListedPrice: 250 });
    expect(itemPricePayload(plain, 650)).toEqual({ basePrice: 650 });
    expect(itemPricePayload(null, 50)).toEqual({ basePrice: 50 });
  });

  it('says what customers pay, only for such an item', () => {
    const money = (n: number) => `GY$${n}`;
    expect(beforeVatNote(added, money)).toBe('Before VAT. Customers pay GY$228 incl. VAT.');
    expect(beforeVatNote(plain, money)).toBeNull();
  });
});
