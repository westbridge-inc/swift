import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Owner ruling, 13 Oct: search SHOWS closed stores and their dishes, marked
// closed (they can be opened; checkout refuses until the store opens). The
// server marks a closed store `isCurrentlyOpen: false` (already drawn greyed,
// "Closed right now") and a closed store's dish `vendorIsCurrentlyOpen: false`.
// These pin that the dish rows draw that mark too, keep the store's name, and
// that "Open now" narrows dishes the way it narrows places.

const SRC = readFileSync(new URL('./SearchScreen.tsx', import.meta.url), 'utf8');
const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function block(from: string, to: string): string {
  const start = STRIPPED.indexOf(from);
  expect(start, `${from} must exist`).toBeGreaterThan(-1);
  const end = STRIPPED.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return STRIPPED.slice(start, end);
}

describe('closed stores in the Search tab', () => {
  it('a dish row of the search results is drawn closed when its store is closed', () => {
    const dishes = block('<SectionHeader title="Dishes"', '</ScrollView>');
    expect(dishes).toMatch(/closed=\{it\.vendorIsCurrentlyOpen === false\}/);
  });

  it('a closed row keeps its sub line (the store\'s name) and adds "Closed right now"', () => {
    const row = block('function ResultRow(', '\n}\n');
    // the sub line no longer sits in the else branch of `closed`
    expect(row).not.toMatch(/\) : sub \? \(/);
    expect(row).toMatch(/\{sub \? \(/);
    expect(row).toMatch(/Closed right now/);
  });

  it('"Open now" narrows dishes by their store\'s state, as it narrows places', () => {
    expect(STRIPPED).toMatch(/openNow \? engineDishes\.filter\(\(d\) => d\.vendorIsCurrentlyOpen !== false\) : engineDishes/);
  });
});
