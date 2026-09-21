import { describe, expect, it } from 'vitest';
import { searchPresentation } from './search-presentation';

describe('search vertical presentation', () => {
  it.each([
    ['RESTAURANT', 'Dishes', 'food'],
    ['SUPERMARKET', 'Groceries', 'groceries'],
    ['STORE', 'Products', 'shops'],
    ['SERVICE', 'Services', 'services'],
  ] as const)('does not disguise %s results as food', (type, itemSection, itemGlyph) => {
    expect(searchPresentation(type)).toMatchObject({ itemSection, itemGlyph });
  });

  it('names every marketplace vertical when no filter is selected', () => {
    expect(searchPresentation().placeholder).toBe('Restaurants, groceries, shops, services…');
  });
});
