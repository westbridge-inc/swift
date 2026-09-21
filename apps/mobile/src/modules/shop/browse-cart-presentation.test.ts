import { describe, expect, it } from 'vitest';
import { browseCartSummary } from './browse-cart-presentation';

describe('browse cart presentation', () => {
  it('shows the authoritative server count and subtotal', () => {
    expect(browseCartSummary({ itemCount: 3, subtotalCustomer: 12_450 })).toEqual({
      itemCount: 3,
      subtotalCustomer: 12_450,
    });
  });

  it.each([
    [null],
    [{}],
    [{ itemCount: 0, subtotalCustomer: 0 }],
    [{ itemCount: 2, subtotalCustomer: undefined }],
    [{ itemCount: 2, subtotalCustomer: -1 }],
    [{ itemCount: Number.NaN, subtotalCustomer: 100 }],
  ])('hides rather than inventing a cart summary for %o', (cart) => {
    expect(browseCartSummary(cart)).toBeNull();
  });
});
