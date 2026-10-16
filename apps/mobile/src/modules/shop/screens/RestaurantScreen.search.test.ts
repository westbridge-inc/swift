import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The in-store search box of a shop or supermarket (mart mode). It filtered
// the shelf with `name.toLowerCase().includes(q)` — exact spelling, one piece,
// name only — so "brocoli", a plural or two words in another order found
// nothing (owner, 13 Oct). The rules live in lib/forgivingSearch (tested
// there); this pins that the shelf actually goes through them.

const SRC = readFileSync(new URL('./RestaurantScreen.tsx', import.meta.url), 'utf8');
const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function martItemsBlock(): string {
  const start = STRIPPED.indexOf('const martItems = useMemo(');
  expect(start, 'the mart shelf must exist').toBeGreaterThan(-1);
  const end = STRIPPED.indexOf('}, [aisleId, storeQuery', start);
  expect(end).toBeGreaterThan(start);
  return STRIPPED.slice(start, end);
}

describe('the in-store search forgives', () => {
  it('filters the shelf through the forgiving matcher, with the typed query', () => {
    expect(martItemsBlock()).toMatch(/forgivingFilter\(base, storeQuery,/);
  });

  it('no exact-substring filter remains on the shelf', () => {
    expect(martItemsBlock()).not.toMatch(/\.includes\(/);
  });
});
