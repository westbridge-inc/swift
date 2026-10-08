import { describe, expect, it } from 'vitest';
import { reorderNotice } from './reorderNotice';

describe('[L09 · reorder] the phone says what a reorder left out', () => {
  it('a line to choose again, or an unavailable one, is named with the server’s message', () => {
    expect(reorderNotice({ unavailableItems: 0, needsOptions: ['Roti'], message: '1 items added to cart. Choose your options for Roti again from the menu.' }))
      .toEqual({ title: 'Some items were not added', description: '1 items added to cart. Choose your options for Roti again from the menu.' });
    expect(reorderNotice({ unavailableItems: 2, message: '1 items added to cart. 2 item(s) were unavailable.' }))
      .toEqual({ title: 'Some items were not added', description: '1 items added to cart. 2 item(s) were unavailable.' });
    expect(reorderNotice({ unavailableItems: 1 })?.description).toBe('Some items from this order could not be added. Check your cart.');
  });

  it('a full reorder needs no notice', () => {
    expect(reorderNotice({ unavailableItems: 0, needsOptions: [], message: '2 items added to cart. Ready to checkout!' })).toBeNull();
    expect(reorderNotice(undefined)).toBeNull();
  });
});
