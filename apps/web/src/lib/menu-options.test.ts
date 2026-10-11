import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as server from '../../../api/src/modules/order/options';
import { fromPrice, needsChoices, requiredChoiceSoldOut, selectionComplete, selectionPrice, validateSelectedOptions, OptionSelectionError } from './menu-options';

// [W6] The website judges and prices an item's choices with the API's own
// module — the same functions, not a copy — so the store page can never accept
// or price a selection differently from cart add, cart update and checkout.

const group = (id: string, isRequired: boolean, minSelect: number, maxSelect: number, prices: Array<[string, string, boolean?]>) => ({
  id, name: id, isRequired, minSelect, maxSelect,
  options: prices.map(([optionId, additionalPrice, isAvailable = true]) => ({ id: optionId, name: optionId, additionalPrice, isAvailable, isDefault: false })),
});

describe('[W6] the store page uses the server’s option rules', () => {
  it('is the API’s validator and resolver themselves, never a second copy', () => {
    expect(validateSelectedOptions).toBe(server.validateSelectedOptions);
    expect(OptionSelectionError).toBe(server.OptionSelectionError);
    const storePage = readFileSync(join(process.cwd(), 'src/components/storefront/storefront-experience.tsx'), 'utf8');
    expect(storePage).toMatch(/validateSelectedOptions,\n\} from '@\/lib\/menu-options'/);
  });

  it('accepts exactly what the server accepts', () => {
    const item = { optionGroups: [group('size', true, 1, 1, [['s', '0'], ['l', '400']]), group('extras', false, 2, 3, [['a', '100'], ['b', '100'], ['c', '50']])] };
    expect(selectionComplete(item, { size: ['s'] })).toBe(true);
    expect(selectionComplete(item, { size: [] })).toBe(false);
    expect(selectionComplete(item, { size: ['s'], extras: ['a'] })).toBe(false);
    expect(selectionComplete(item, { size: ['s'], extras: ['a', 'b'] })).toBe(true);
    const selections: Array<Record<string, string[]>> = [{ size: ['s'] }, { size: [] }, { size: ['s'], extras: ['a'] }, { size: ['s', 's'] }, { other: ['x'] }];
    for (const selected of selections) {
      let serverAccepts = true;
      try { server.validateSelectedOptions(item, selected); } catch { serverAccepts = false; }
      expect(selectionComplete(item, selected), JSON.stringify(selected)).toBe(serverAccepts);
    }
  });
});

describe('[W6] "From" and the sheet’s price', () => {
  it('From is the item plus the cheapest choices each required group needs, counting only choices on sale', () => {
    const item = { basePrice: 1000, optionGroups: [
      group('size', true, 1, 1, [['l', '400'], ['m', '200'], ['s', '0', false]]),
      group('sides', true, 2, 3, [['a', '300'], ['b', '100'], ['c', '150']]),
      group('extras', false, 0, 3, [['x', '50']]),
    ] };
    expect(fromPrice(item)).toBe(1000 + 200 + 100 + 150);
    expect(needsChoices(item)).toBe(true);
  });

  it('an item with no required group has no From: its price is the one-tap price', () => {
    const item = { basePrice: 800, optionGroups: [group('extras', false, 2, 3, [['x', '50']])] };
    expect(needsChoices(item)).toBe(false);
    expect(fromPrice(item)).toBe(800);
  });

  it('a figure the server sent that cannot be read is never priced as zero', () => {
    expect(fromPrice({ basePrice: Number.NaN })).toBeNull();
    expect(fromPrice({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['l', 'abc']])] })).toBeNull();
    expect(selectionPrice({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['l', 'abc']])] }, { size: ['l'] })).toBeNull();
  });

  it('an item a required choice is sold out for has no From price: nobody can order it at any price right now', () => {
    // Every size sold out.
    expect(fromPrice({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['s', '0', false], ['l', '400', false]])] })).toBeNull();
    // Two sides needed, one left on sale.
    expect(fromPrice({ basePrice: 800, optionGroups: [group('sides', true, 2, 3, [['a', '100'], ['b', '100', false]])] })).toBeNull();
    expect(requiredChoiceSoldOut({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['s', '0', false]])] })).toBe(true);
    // A sold-out OPTIONAL group never blocks the item.
    const optional = { basePrice: 800, optionGroups: [group('extras', false, 0, 2, [['x', '50', false]])] };
    expect(fromPrice(optional)).toBe(800);
    expect(requiredChoiceSoldOut(optional)).toBe(false);
    // Exactly enough on sale still has a From price.
    expect(fromPrice({ basePrice: 800, optionGroups: [group('sides', true, 2, 3, [['a', '100'], ['b', '150'], ['c', '50', false]])] })).toBe(1050);
  });

  it('the sheet’s price is the item plus each chosen choice of the item’s own groups', () => {
    const item = { basePrice: 1200, optionGroups: [group('size', true, 1, 1, [['l', '400']]), group('roti', true, 1, 1, [['d', '200']])] };
    expect(selectionPrice(item, { size: ['l'], roti: ['d'] })).toBe(1800);
    // An id that belongs to no group of this item is never priced.
    expect(selectionPrice(item, { size: ['l'], roti: ['not-this-item'] })).toBe(1600);
  });
});
