import { describe, expect, it } from 'vitest';
import { forgivingFilter, searchWords } from './forgivingSearch';

// The in-store search of a shop or supermarket (RestaurantScreen, mart mode).
// Owner, 13 Oct: search must find "similar words or words that are part of the
// item". Every name here is invented.

const SHELF = [
  { id: 'broccoli', name: 'Broccoli Crown', description: '' },
  { id: 'tomato', name: 'Tomato (1 lb)', description: '' },
  { id: 'rice', name: 'White Rice 5 lb', description: '' },
  { id: 'patty', name: 'Cheese Patty', description: '' },
  { id: 'cola', name: 'Coca-Cola 2L', description: '' },
  { id: 'spread', name: 'Spread Toast', description: '' },
  { id: 'chikenTypo', name: 'Chiken Gravy Mix', description: '' },
  { id: 'fantastic', name: 'Fantastic Fries', description: '' },
  { id: 'chicken', name: 'Chicken Wings', description: 'Fresh, local' },
  { id: 'soap', name: 'Bath Soap', description: 'Lavender scented bar' },
];
const find = (q: string) => forgivingFilter(SHELF, q, (r) => r).map((r) => r.id);

describe('in-store search forgives the way the Search tab does', () => {
  it.each([
    ['brocoli', 'broccoli', 'a missing letter'],
    ['broccolli', 'broccoli', 'an extra letter'],
    ['tomatoes', 'tomato', 'a plural of a singular name'],
    ['patties', 'patty', 'an -ies plural'],
    ['rice white', 'rice', 'the words in another order'],
    ['chikcen', 'chicken', 'two letters swapped'],
    ['cola', 'cola', 'a part of a hyphenated name'],
    ['lavender', 'soap', 'a word from the description'],
  ])('"%s" finds %s (%s)', (q, id) => {
    expect(find(q)).toContain(id);
  });

  it('a correctly typed word comes before a one-slip match, whatever the shelf order', () => {
    expect(find('chicken')).toEqual(['chicken', 'chikenTypo']);
  });

  it('a slip is forgiven at the start of a word only, and never in the first letter', () => {
    expect(find('toast')).toEqual(['spread']); // never the "tast" inside "Fantastic"
    expect(find('zhicken')).toEqual([]);
  });

  it('a long word matches as typed only, without building a huge pattern', () => {
    // 25 letters: inside the per-query slip budget, past the per-word length cap
    const shelf = [{ name: `${'x'.repeat(24)}y`, description: '' }];
    expect(forgivingFilter(shelf, `${'x'.repeat(24)}z`, (r) => r)).toEqual([]);
    expect(forgivingFilter(shelf, `${'x'.repeat(24)}y`, (r) => r)).toEqual(shelf);
    // a pasted run of 200 letters: past the budget too
    const pasted = [{ name: `${'x'.repeat(199)}y`, description: '' }];
    expect(forgivingFilter(pasted, `${'x'.repeat(199)}z`, (r) => r)).toEqual([]);
  });

  it('an empty query leaves the shelf as it is; a query of symbols matches nothing', () => {
    expect(find('')).toEqual(SHELF.map((r) => r.id));
    expect(find('%%')).toEqual([]);
    expect(searchWords('chi%cken_curry')).toEqual(['chi', 'cken', 'curry']);
  });

  it('nothing typed can act as a regex', () => {
    expect(() => find('(.*')).not.toThrow();
    expect(find('(.*')).toEqual([]);
  });
});
