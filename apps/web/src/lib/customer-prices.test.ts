import { describe, expect, it } from 'vitest';
import { pricesAsSeen, type Cart } from './customer';

// [L09 · price lock] The store page (and its QR arrival) sends the prices the
// server quote showed, read exactly: a Decimal that crosses the wire as a
// string is the same amount, and a quote with no readable total sends nothing
// rather than a guessed figure.
const line = (id: string, customerPrice: unknown) => ({ id, itemId: `item-${id}`, name: id, quantity: 1, customerPrice }) as Cart['items'][number];

describe('[L09 · price lock] web pricesAsSeen', () => {
  it('sends the quote total and every line price, numbers or decimal strings', () => {
    expect(pricesAsSeen({ totalAmount: '2150.50' as unknown as number, items: [line('l1', 1800), line('l2', '350.50')] }))
      .toEqual({ expectedTotal: 2150.5, expectedLines: [{ lineId: 'l1', unitPrice: 1800 }, { lineId: 'l2', unitPrice: 350.5 }] });
  });

  it('sends nothing without a readable total, and skips a line whose price is unreadable', () => {
    expect(pricesAsSeen(null)).toEqual({});
    expect(pricesAsSeen({ items: [line('l1', 1800)] })).toEqual({});
    expect(pricesAsSeen({ totalAmount: 'GY$ 900' as unknown as number, items: [line('l1', 900)] })).toEqual({});
    expect(pricesAsSeen({ totalAmount: 900, items: [line('l1', 900), line('l2', 'n/a')] }))
      .toEqual({ expectedTotal: 900, expectedLines: [{ lineId: 'l1', unitPrice: 900 }] });
  });
});
