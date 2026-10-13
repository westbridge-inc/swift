import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  MAX_TERMS, MIN_TYPO_LENGTH, everyWordWhere, literalForms, nameMatcher, searchTerms, searchTiers, typoForms,
} from '../modules/search/forgiving-text';
import { SearchService, TYPO_TOLERANCE, type SearchClientLike, type SearchIndexLike } from '../modules/search/search.service';
import { ITEM_INDEX, VENDOR_INDEX } from '../modules/search/search-scope';

// The pure half of forgiving search (owner, 13 Oct). The database half and the
// HTTP doors are proved in search-forgiving.test.ts / search-engine-fill.test.ts.

/** Every `contains` / `startsWith` value a predicate holds, walked out of the tree. */
function likeValues(where: unknown, out: string[] = []): string[] {
  if (Array.isArray(where)) { for (const w of where) likeValues(w, out); return out; }
  if (where && typeof where === 'object') {
    for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
      if ((k === 'contains' || k === 'startsWith') && typeof v === 'string') out.push(v);
      else likeValues(v, out);
    }
  }
  return out;
}

describe('what a customer types never becomes a wildcard', () => {
  it('a query of LIKE metacharacters has no searchable word at all', () => {
    expect(searchTerms('%%')).toEqual([]);
    expect(searchTerms('__')).toEqual([]);
    expect(searchTiers('%_\\', { text: ['name'], typoText: ['name'] })).toEqual([]);
    expect(everyWordWhere('%%', { text: ['name'] }, true)).toBeNull();
  });

  it('metacharacters inside a query split it into plain words', () => {
    expect(searchTerms('chi%cken_curry\\roti')).toEqual(['chi', 'cken', 'curry', 'roti']);
  });

  it('the only wildcard in any pattern is the one-letter slip, and only in a slip form', () => {
    const tiers = searchTiers('Chicken 100% curry_roti', { text: ['name', 'description'], typoText: ['name'], lists: ['tags'] });
    const values = tiers.flatMap((t) => likeValues(t.where));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^ ?[\p{L}\p{N}_]+$/u);
    for (const v of likeValues(tiers[0]!.where)) expect(v).not.toContain('_'); // the exact tier has none
  });
});

describe('words and forms', () => {
  it('splits, lower-cases, de-duplicates and bounds the words', () => {
    expect(searchTerms('  Curry   CHICKEN curry ')).toEqual(['curry', 'chicken']);
    expect(searchTerms('a b c d e f g h')).toEqual([]);
    expect(searchTerms('one two three four five six seven')).toHaveLength(MAX_TERMS);
  });

  it('undoes the plural the customer typed', () => {
    expect(literalForms('burgers')).toContain('burger');
    expect(literalForms('patties')).toContain('patty');
    expect(literalForms('tomatoes')).toContain('tomato');
    expect(literalForms('pies')).toContain('pie');
    expect(literalForms('glass')).toEqual(['glass']);
    expect(literalForms('bus')).toEqual(['bus']);
  });

  it('forgives one slip from MIN_TYPO_LENGTH letters, never below', () => {
    expect(typoForms('a'.repeat(MIN_TYPO_LENGTH - 1))).toEqual([]);
    const forms = typoForms('chiken');
    expect(forms).toContain('chi_ken'); // the missing letter
    expect(forms).toContain('chken'); // an extra letter typed
    expect(forms).toContain('chi_en'); // a wrong letter
    expect(forms).toContain('chikne'); // two letters swapped
    expect(forms).not.toContain('chiken');
  });

  it('the in-memory twin agrees: literal anywhere, a slip only at a word start', () => {
    expect(nameMatcher('doori', false)('Tandoori Chicken')).toBe(true);
    expect(nameMatcher('chiken', false)('Chicken Curry')).toBe(false);
    expect(nameMatcher('chiken', true)('Chicken Curry')).toBe(true);
    expect(nameMatcher('chiken', true)('Curry Chicken')).toBe(true);
    // "bread" with a slip ("read") may find a word that STARTS so, never one that hides it
    expect(nameMatcher('bread', true)('Ready Meal')).toBe(true);
    expect(nameMatcher('bread', true)('Thread Count')).toBe(false);
  });

  it('tiers run strictest first and skip what cannot add anything', () => {
    const cols = { text: ['name'], typoText: ['name'] } as const;
    expect(searchTiers('chicken', cols).map((t) => t.tier)).toEqual([{ every: true, typos: false }, { every: true, typos: true }]);
    expect(searchTiers('roti', cols).map((t) => t.tier)).toEqual([{ every: true, typos: false }]);
    expect(searchTiers('curry chicken', cols).map((t) => t.tier)).toEqual([
      { every: true, typos: false }, { every: true, typos: true }, { every: false, typos: false }, { every: false, typos: true },
    ]);
    // no column forgives a slip: no slip tier
    expect(searchTiers('chicken', { text: ['description'] }).map((t) => t.tier)).toEqual([{ every: true, typos: false }]);
  });
});

describe('the index is told to forgive, on every start', () => {
  it('initialize() writes the pinned typo tolerance to BOTH indexes', async () => {
    const settings = new Map<string, Record<string, unknown>>();
    const index = (uid: string): SearchIndexLike => ({
      addDocuments: async () => ({}), deleteDocument: async () => ({}), deleteDocuments: async () => ({}),
      getDocuments: async () => ({ results: [] }), search: async () => ({ hits: [], processingTimeMs: 0 }),
      updateSettings: async (s) => { settings.set(uid, s); return {}; },
    });
    const client: SearchClientLike = { createIndex: async () => ({}), index };
    await new SearchService({} as PrismaClient, undefined, undefined, client).initialize();
    expect(TYPO_TOLERANCE).toEqual({ enabled: true, minWordSizeForTypos: { oneTypo: MIN_TYPO_LENGTH, twoTypos: 9 } });
    expect(settings.get(VENDOR_INDEX)?.['typoTolerance']).toEqual(TYPO_TOLERANCE);
    expect(settings.get(ITEM_INDEX)?.['typoTolerance']).toEqual(TYPO_TOLERANCE);
  });
});
