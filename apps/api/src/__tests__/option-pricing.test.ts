import { describe, it, expect } from 'vitest';
import { resolveSelectedOptions, optionsUnitPrice } from '../modules/order/options';

// Money path: a customized item must be priced from its OWN options only, and
// cart + checkout share this so they never disagree.
const item = {
  optionGroups: [
    {
      name: 'Size',
      options: [
        { id: 'reg', name: 'Regular', additionalPrice: 0 },
        { id: 'lg', name: 'Large', additionalPrice: 500 },
      ],
    },
    {
      name: 'Add-ons',
      options: [
        { id: 'cheese', name: 'Extra cheese', additionalPrice: 200 },
        { id: 'bacon', name: 'Bacon', additionalPrice: 300 },
      ],
    },
  ],
};

describe('option pricing', () => {
  it('prices a single selected option (array form)', () => {
    const r = resolveSelectedOptions(item, { sizeGroup: ['lg'] });
    expect(optionsUnitPrice(r)).toBe(500);
    expect(r.map((o) => o.optionName)).toEqual(['Large']);
  });

  it('prices multiple groups incl. multi-select', () => {
    const r = resolveSelectedOptions(item, { sizeGroup: 'lg', addonGroup: ['cheese', 'bacon'] });
    expect(optionsUnitPrice(r)).toBe(1000);
    expect(r.map((o) => o.optionName).sort()).toEqual(['Bacon', 'Extra cheese', 'Large']);
  });

  it('ignores ids that do not belong to the item (no price injection)', () => {
    const r = resolveSelectedOptions(item, { sizeGroup: ['lg'], evil: ['not-a-real-id', 'reg'] });
    // Only 'lg' (500) + 'reg' (0) count; the foreign id is dropped.
    expect(optionsUnitPrice(r)).toBe(500);
  });

  it('carries the group name for the order record + UI', () => {
    const r = resolveSelectedOptions(item, { sizeGroup: ['lg'] });
    expect(r[0]).toMatchObject({ optionGroupName: 'Size', optionName: 'Large', additionalPrice: 500 });
  });

  it('empty / missing / malformed selection → no options, no price', () => {
    expect(optionsUnitPrice(resolveSelectedOptions(item, {}))).toBe(0);
    expect(optionsUnitPrice(resolveSelectedOptions(item, undefined))).toBe(0);
    expect(optionsUnitPrice(resolveSelectedOptions(item, 'garbage'))).toBe(0);
    expect(optionsUnitPrice(resolveSelectedOptions({ optionGroups: null }, { g: ['x'] }))).toBe(0);
  });
});
